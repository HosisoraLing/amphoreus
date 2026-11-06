/** Private, repeatable fish-tank migration. Raw files remain byte-for-byte archives; only indexes are adapted. */
import {createHash} from 'node:crypto'
import {createReadStream,constants} from 'node:fs'
import {mkdir,readdir,lstat,readFile,writeFile,copyFile,link,readlink,symlink,utimes,chmod,rename,open,mkdtemp,rm} from 'node:fs/promises'
import {join,relative,resolve,basename,dirname,extname,isAbsolute} from 'node:path'
import {fileURLToPath} from 'node:url'
import {DatabaseSync,backup} from 'node:sqlite'
import {spawn} from 'node:child_process'
import {createInterface} from 'node:readline'
import {Store} from '../src/app/store.ts'
import {MemoryStore,MemorySettings,memoryId} from '../src/amphoreus/memory.ts'

const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
async function digest(path){const h=createHash('sha256');for await(const chunk of createReadStream(path))h.update(chunk);return h.digest('hex')}
const exists=async path=>lstat(path).then(()=>true,()=>false)
const posix=path=>path.split('\\').join('/')
const textExtensions=new Set(['.md','.txt','.json','.jsonl','.js','.mjs','.cjs','.ts','.tsx','.jsx','.py','.html','.css','.yaml','.yml','.svg','.sh','.toml','.ini'])
const mediaType=name=>/\.(png|jpe?g|gif|webp)$/i.test(name)?'image':/\.(mp3|wav|ogg|m4a|silk|amr)$/i.test(name)?'audio':/\.(mp4|webm|mkv|mov)$/i.test(name)?'video':'file'
const historical=path=>/(?:^|\/)(?:backup|[^/]*\.bak[^/]*|[^/]*\.history)(?:\/|$)/.test(path)
function excluded(name,source){return(source.exclude??[]).some(prefix=>name===prefix||name.startsWith(prefix+'/'))||(source.excludeComponents??[]).some(part=>name.split('/').includes(part))}
function safeChild(root,path){const value=relative(resolve(root),resolve(path));if(value==='..'||value.startsWith('../')||value.startsWith('..\\')||isAbsolute(value))throw new Error('Destination is outside the migration root')}
const scrub=(text,secrets=[])=>secrets.filter(secret=>typeof secret==='string'&&secret.length>=8).reduce((value,secret)=>value.split(secret).join('[credential redacted]'),text)
const scrubValue=(value,secrets)=>typeof value==='string'?scrub(value,secrets):Array.isArray(value)?value.map(item=>scrubValue(item,secrets)):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([key,item])=>[key,scrubValue(item,secrets)])):value

export async function captureLegacy(plan){
  const destination=resolve(plan.destination);await mkdir(destination,{recursive:true,mode:0o700})
  const manifest={version:1,captured_at:new Date().toISOString(),files:[],directories:[],excluded:[],sqlite:[],deduplicated_bytes:0}
  const identical=new Map()
  for(const source of plan.sources){
    if(!/^[a-z][a-z0-9-]*$/.test(source.name))throw new Error('Invalid source label')
    const root=resolve(source.path)
    if(destination===root||destination.startsWith(root+'/'))throw new Error('Migration destination must not be inside a source')
    const walk=async(dir,part='')=>{
      for(const entry of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
        const name=posix(join(part,entry.name)),from=join(dir,entry.name),local=posix(join(source.name,name)),to=join(destination,local)
        if(excluded(name,source)){manifest.excluded.push(local);continue}
        const info=await lstat(from)
        if(info.isDirectory()){
          await mkdir(to,{recursive:true,mode:0o700});manifest.directories.push(local);await walk(from,name);continue
        }
        await mkdir(dirname(to),{recursive:true,mode:0o700})
        if(info.isSymbolicLink()){
          const target=await readlink(from)
          if(await exists(to)){if(!(await lstat(to)).isSymbolicLink()||await readlink(to)!==target)throw new Error(`Existing symlink differs: ${local}`)}else await symlink(target,to)
          manifest.files.push({path:local,type:'symlink',target});continue
        }
        if(!info.isFile())throw new Error(`Unsupported source object: ${local}`)
        let sha256=await digest(from)
        if(await exists(to)){
          const prior=await digest(to)
          if(prior!==sha256){
            const old=join(destination,'.versions',prior,local);await mkdir(dirname(old),{recursive:true,mode:0o700})
            if(await exists(old))throw new Error(`Existing changed snapshot needs review: ${local}`)
            await rename(to,old)
          }
        }
        const key=`${sha256}:${info.mode}:${info.mtimeMs}`,same=identical.get(key)
        if(!await exists(to)){
          if(same){await link(same,to);manifest.deduplicated_bytes+=info.size}
          else{await copyFile(from,to,constants.COPYFILE_FICLONE);await chmod(to,info.mode&0o777);await utimes(to,info.atime,info.mtime)}
        }
        if(await digest(to)!==sha256)throw new Error(`File changed during copy or failed verification: ${local}`)
        identical.set(key,to)
        manifest.files.push({path:local,type:'file',bytes:info.size,sha256,mtime:info.mtime.toISOString()})
      }
    }
    await mkdir(join(destination,source.name),{recursive:true,mode:0o700});await walk(root)
  }
  // SQLite's backup API includes committed WAL pages and yields valid portable databases.
  for(const file of manifest.files.filter(file=>file.type==='file'&&/\.(sqlite|db)(?:$|\.)/i.test(file.path))){
    const path=join(destination,file.path),header=Buffer.alloc(16)
    const handle=await open(path,'r');try{await handle.read(header,0,16,0)}finally{await handle.close()}
    if(header.toString()!=='SQLite format 3\0')continue
    const copy=join(destination,'.consistent',file.path);await mkdir(dirname(copy),{recursive:true,mode:0o700})
    if(await exists(copy)){manifest.sqlite.push({source:file.path,path:posix(relative(destination,copy)),sha256:await digest(copy)});continue}
    const temporary=await mkdtemp(join(destination,'.sqlite-copy-')),input=join(temporary,'source.sqlite')
    await copyFile(path,input,constants.COPYFILE_FICLONE)
    const match=/^(.*\.(?:sqlite|db))(.*)$/i.exec(file.path),wal=join(destination,match[1]+'-wal'+match[2])
    if(await exists(wal))await copyFile(wal,input+'-wal',constants.COPYFILE_FICLONE)
    const db=new DatabaseSync(input,{readOnly:true})
    try{await backup(db,copy);manifest.sqlite.push({source:file.path,path:posix(relative(destination,copy)),sha256:await digest(copy)})}
    finally{db.close();await rm(temporary,{recursive:true,force:true})}
  }
  await writeFile(join(destination,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{mode:0o600})
  return manifest
}

async function *nativeEvents(path){
  if(path.endsWith('.zstd')||path.endsWith('.zst')){
    const child=spawn('zstd',['-dc',path],{stdio:['ignore','pipe','pipe']});let error='';child.stderr.on('data',data=>{error+=data})
    const finished=new Promise((yes,no)=>{child.on('error',no);child.on('close',code=>code===0?yes():no(new Error(`Native log decoding failed (${code})`)))})
    for await(const line of createInterface({input:child.stdout,crlfDelay:Infinity})){if(line.trim())yield JSON.parse(line)}
    await finished
  }else for await(const line of createInterface({input:createReadStream(path),crlfDelay:Infinity})){if(line.trim())yield JSON.parse(line)}
}
const blocksText=blocks=>Array.isArray(blocks)?blocks.filter(block=>block.type==='text').map(block=>String(block.text??'')).join('\n'):typeof blocks==='string'?blocks:''

export async function importLegacy(plan,manifest){
  const destination=resolve(plan.destination),host=new Store(plan.database)
  host.db.exec('PRAGMA busy_timeout=5000')
  const memory=new MemoryStore(host,plan.agentId,MemorySettings.parse(plan.memory??{})),now=memory.now(),counts={files:0,native_events:0,world_records:0,people:0,memes:0,conflicts:0}
  const files=manifest.files.filter(file=>file.type==='file'),byPath=new Map(files.map(file=>[file.path,file]))
  const nativeSessions=new Map()
  const pending=new Map(),updates=new Map()
  const flush=()=>{
    if(!pending.size&&!updates.size)return
    host.atomic(()=>{for(const record of pending.values())memory.put(record);for(const record of updates.values())memory.update(record.id,{data:record.data})})
    pending.clear();updates.clear()
  }
  const lookup=id=>pending.get(id)??updates.get(id)??memory.get(id)
  const put=record=>{if(!lookup(record.id))pending.set(record.id,record);if(pending.size+updates.size>=100)flush()}
  const nativeSignature=record=>JSON.stringify([record.kind,record.text,record.data.blocks])
  const putNative=record=>{
    const prior=lookup(record.id)
    if(prior&&nativeSignature(prior)!==nativeSignature(record))record={...record,id:memoryId(record.id,'version',nativeSignature(record)),data:{...record.data,native_version_of:record.id}}
    put(record)
  }
  const update=record=>{if(pending.has(record.id))pending.set(record.id,record);else updates.set(record.id,record);if(pending.size+updates.size>=100)flush()}
  const logical=path=>{
    const parts=path.split('/'),at=parts.indexOf('QQ_msg')
    return at>=0?parts.slice(at+1).filter((part,index)=>!(index===0&&part==='backup')).join('/'):path
  }
  const putFile=async file=>{
    const path=join(destination,file.path),name=basename(file.path),isHistory=historical(file.path)
    const id=memoryId('legacy-file',plan.agentId,name,file.sha256),prior=lookup(id)
    if(prior){
      const origins=new Set(prior.data.origins??[]);origins.add(file.path)
      if(origins.size!==(prior.data.origins??[]).length)update({...prior,data:{...prior.data,origins:[...origins]}});return
    }
    const indexable=!file.path.startsWith('home/profiles/')&&!file.path.startsWith('home/bundles/')&&!file.path.startsWith('home/llm-deepseek/')&&!file.path.startsWith('home/storages/')
    let body=''
    if(indexable&&textExtensions.has(extname(name).toLowerCase())&&file.bytes<=4*1024*1024){
      try{body=new TextDecoder('utf-8',{fatal:true}).decode(await readFile(path))}catch{}
    }
    const fileInfo={path:posix(join(plan.containerDestination,file.path)),sha256:file.sha256,name,type:mediaType(name)}
    put({id,kind:body?'legacy_document':'attachment',title:`鱼缸 · ${logical(file.path)}`,text:body?scrub(body,plan.secrets):`旧鱼缸原始附件：${name}。需要看时用 read_media(memory_id)。`,
      created_at:file.mtime,source:{platform:'legacy',actor_id:'legacy-import'},status:isHistory?'legacy_history':'complete',importance:isHistory?.15:body?.45:.3,
      data:{legacy_import:true,legacy_file:fileInfo,origins:[file.path]}});counts.files++
  }
  try{
    // Prefer current files over identical backup copies while retaining every original path.
    for(const file of [...files].sort((a,b)=>Number(historical(a.path))-Number(historical(b.path))))await putFile(file)
    for(const file of files.filter(file=>/\/sessions(?:-archive)?\/.*session[^/]*\.(?:jsonl|jsonl\.zstd|jsonl\.zst)$/.test(file.path))){
      let header={},provider
      for await(const event of nativeEvents(join(destination,file.path))){
        if(event.type==='session'){
          header=event
          if(header.id)nativeSessions.set(header.id,{agent_id:plan.agentId,session_id:header.id,cwd:header.cwd,source_file:file.path})
          continue
        }
        if(event.type==='request/header'){provider=event.data?.header?.config?.provider;continue}
        const data=event.data??{},source={session_id:header.id??basename(dirname(file.path)),seq:event.seq,branch:Number(header.delegationDepth)>0?'worker':'main',platform:'legacy',
          ...(provider?{provider}:{}),...(data.turn===undefined?{}:{turn:data.turn}),...(data.step===undefined?{}:{step:data.step})}
        const created_at=Number.isFinite(event.time)?new Date(event.time).toISOString():file.mtime
        const blocks=data.content??data.message?.content,hasMedia=Array.isArray(blocks)&&blocks.some(block=>['image','file'].includes(block.type))
        const common={created_at,source,data:{legacy_import:true,native_file:file.path,native_type:event.type,legacy_source:scrubValue(data.source??data.message?.source,plan.secrets),
          ...(hasMedia?{blocks:scrubValue(blocks,plan.secrets)}:{})}}
        const id=memoryId('legacy-native',plan.agentId,source.session_id,event.seq,event.type)
        if(event.type==='user/message')putNative({...common,id,kind:'input',title:'旧鱼缸 · 原生来信',text:scrub(blocksText(data.content??data.message?.content),plan.secrets)})
        else if(event.type==='assistant/message'){
          putNative({...common,id,kind:'assistant',title:'旧鱼缸 · 原始助手文本（原投递状态未推定）',text:scrub(blocksText(data.message?.content),plan.secrets)})
          const reasoning=(data.message?.content??[]).filter(block=>block.type==='reasoning').map(block=>block.text??'').join('\n')
          if(reasoning&&memory.settings.reasoning.allowedProviders.includes(provider))putNative({...common,id:memoryId(id,'reasoning'),kind:'reasoning',title:'旧鱼缸 · 接口原始推理',text:scrub(reasoning,plan.secrets),
            expires_at:new Date(Date.parse(created_at)+memory.settings.reasoning.retentionDays*86400000).toISOString()})
        }else if(event.type==='tool/call')putNative({...common,id,kind:'tool',title:`旧鱼缸 · 调用 ${data.name??'工具'}`,text:scrub(JSON.stringify(data),plan.secrets),status:'requested'})
        else if(event.type==='tool/result')putNative({...common,id,kind:'tool',title:'旧鱼缸 · 工具结果',text:scrub(blocksText(data.message?.content),plan.secrets),status:data.message?.isError?'failed':'completed'})
        else continue
        counts.native_events++
      }
    }
    for(const file of [...manifest.sqlite].sort((a,b)=>Number(!a.source.endsWith('/worlds/default/archive.sqlite'))-Number(!b.source.endsWith('/worlds/default/archive.sqlite')))){
      const db=new DatabaseSync(join(destination,file.path),{readOnly:true})
      try{
        const tables=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row=>row.name))
        if(tables.has('records'))for(const row of db.prepare('SELECT body FROM records ORDER BY sequence').iterate()){
          const original=JSON.parse(String(row.body)),text=typeof original.content==='string'?original.content:JSON.stringify(original.content),key=original.recordId??hash(row.body)
          const id=memoryId('legacy-world',plan.agentId,key,hash(text)),{content:_body,...metadata}=original
          if(lookup(id))continue
          put({id,kind:original.role==='user'?'input':original.role==='assistant'?'assistant':'legacy_experience',title:`旧鱼缸档案 · ${original.role}`,text:scrub(text,plan.secrets),
            created_at:original.occurredAt??byPath.get(file.source)?.mtime??now,source:{session_id:original.sourceSessionId,seq:original.sourceSeq,platform:original.channel??'legacy',
              account_id:original.accountId,conversation_id:original.conversationId,actor_id:original.speakerId??(original.role==='assistant'?plan.agentId:'legacy-user')},
            status:file.source.endsWith('/worlds/default/archive.sqlite')?'complete':'legacy_history',importance:file.source.endsWith('/worlds/default/archive.sqlite')?.4:.15,
            data:{legacy_import:true,raw_database:file.source,legacy_metadata:metadata}});counts.world_records++
        }
        for(const table of file.source.includes('/people/')?['people','identities','impressions','contacts','audit']:file.source.includes('/meme-packs/')?['memes']:[]){
          if(!tables.has(table))continue
          for(const row of db.prepare(`SELECT * FROM "${table}"`).iterate()){
            const body=JSON.stringify(row),id=memoryId('legacy-person',plan.agentId,table,hash(body))
            const rawTime=row.created_at??row.updated_at,parsed=rawTime===undefined?NaN:Date.parse(String(rawTime))
            put({id,kind:table==='memes'?'legacy_meme':'legacy_person',title:`旧鱼缸${table==='memes'?'表情':'人物'} · ${row.name??row.display_name??row.ref??row.subject_ref??row.label??table}`,text:scrub(body,plan.secrets),created_at:Number.isFinite(parsed)?new Date(parsed).toISOString():byPath.get(file.source)?.mtime??now,
              source:{platform:'legacy',actor_id:'legacy-import'},data:{legacy_import:true,raw_database:file.source,table}});if(table==='memes')counts.memes++;else counts.people++
          }
        }
      }finally{db.close()}
    }
    flush()
    host.atomic(()=>{for(const [id,record] of nativeSessions)host.db.prepare('INSERT OR IGNORE INTO amphoreus_record VALUES(?,?,?)').run('legacy-native-session',id,JSON.stringify(record))})
    // The creator explicitly chose old fish-tank Self/diaries over conflicting NEO versions.
    const formal=async(path,kind,day)=>{
      const file=byPath.get(path);if(!file)throw new Error(`Required formal memory is absent: ${path}`)
      const text=(await readFile(join(destination,path))).toString('utf8'),id=memoryId('legacy-formal',plan.agentId,kind,path,file.sha256)
      host.atomic(()=>{
        const previous=memory.recent(100000,0,kind).filter(record=>record.status==='confirmed'&&(kind==='self'||record.data.day===day)&&record.id!==id)
        const record=memory.put({id,kind,title:kind==='self'?'我是谁':day,text,created_at:file.mtime,status:'confirmed',importance:.95,
          source:{branch:'main',platform:'legacy',actor_id:plan.agentId},data:{legacy_import:true,legacy_file:{path:posix(join(plan.containerDestination,path)),sha256:file.sha256,name:basename(path),type:'file'},
            day,previous_id:previous[0]?.id??null,version:Number(previous[0]?.data.version??0)+1,import_authority:'user-request:legacy-wins'}})
        for(const old of previous){memory.update(old.id,{status:'superseded',data:{...old.data,superseded_by:record.id,legacy_conflict_preserved:true}});counts.conflicts++}
      })
    }
    if(plan.currentSelf)await formal(plan.currentSelf,'self')
    if(plan.diaries)for(const file of files.filter(file=>file.path.startsWith(plan.diaries+'/')&&/^\d{4}-\d{2}-\d{2}\.md$/.test(basename(file.path))))await formal(file.path,'diary',basename(file.path,'.md'))
    host.db.prepare('INSERT INTO amphoreus_record VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET value=excluded.value')
      .run('legacy-import',plan.agentId,JSON.stringify({completed_at:memory.now(),manifest:posix(join(plan.containerDestination,'manifest.json')),counts,policy:'legacy-wins'}))
    return counts
  }finally{host.close()}
}

/** Add searchable native history without registering old workspaces; working projects are separate from the archive. */
export async function materializeLegacy(plan,manifest){
  const result={native_files:0,project_files:0},root=resolve(plan.destination)
  const copy=async(file,to,immutable=false)=>{
    await mkdir(dirname(to),{recursive:true,mode:0o700})
    if(await exists(to)){
      if(await digest(to)!==file.sha256)throw new Error(`Existing destination differs; original retained: ${file.path}`)
      return
    }
    if(immutable)await link(join(root,file.path),to)
    else await copyFile(join(root,file.path),to,constants.COPYFILE_FICLONE)
    if(await digest(to)!==file.sha256)throw new Error(`Materialized file failed verification: ${file.path}`)
  }
  if(plan.nativeHome)for(const file of manifest.files.filter(file=>file.type==='file')){
    let local
    if(file.path.startsWith('home/sessions/')&&!file.path.endsWith('/session.lock'))local=file.path.slice('home/'.length)
    // Backup logs retain their original bytes in the archive and global memory.
    // Native discovery requires the exact header-derived directory, which backups do not use.
    else if(file.path.startsWith('home/attachments/'))local=file.path.slice('home/'.length)
    if(!local)continue
    const to=join(plan.nativeHome,local);safeChild(plan.nativeHome,to)
    await copy(file,to,local.startsWith('attachments/v1/objects/')||local.startsWith('attachments/v1/file-objects/'));result.native_files++
  }
  for(const project of plan.projects??[]){
    const prefix=project.source.replace(/\/$/,'')+'/',references=new Set()
    await mkdir(project.destination,{recursive:true,mode:0o700})
    for(const file of manifest.files.filter(file=>file.path.startsWith(prefix))){
      const local=file.path.slice(prefix.length),parts=local.split('/'),to=join(project.destination,local);safeChild(project.destination,to)
      if((project.references??[]).includes(parts[0])&&parts.length>1){
        const ref=parts.slice(0,2).join('/');if(references.has(ref))continue;references.add(ref)
        const linkPath=join(project.destination,ref),target=posix(join(plan.containerDestination,project.source,ref))
        await mkdir(dirname(linkPath),{recursive:true,mode:0o700})
        if(!await exists(linkPath))await symlink(target,linkPath);continue
      }
      if(file.type==='file'){await copy(file,to);result.project_files++}
      else if(file.type==='symlink'){
        await mkdir(dirname(to),{recursive:true,mode:0o700})
        const target=file.target.startsWith('/root/.dsh/')?posix(join(plan.containerDestination,'home',file.target.slice('/root/.dsh/'.length))):file.target
        if(!await exists(to))await symlink(target,to)
      }
    }
  }
  return result
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const plan=JSON.parse(await readFile(process.argv[2],'utf8'))
  const manifest=await captureLegacy(plan),materialized=await materializeLegacy(plan,manifest),counts=await importLegacy(plan,manifest)
  process.stdout.write(JSON.stringify({files:manifest.files.length,verified_bytes:manifest.files.reduce((n,file)=>n+(file.bytes??0),0),deduplicated_bytes:manifest.deduplicated_bytes,materialized,counts})+'\n')
}
