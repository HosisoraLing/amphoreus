import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,utimesSync,statSync,copyFileSync,existsSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {DatabaseSync} from 'node:sqlite'
import {expect,it} from 'vitest'
import {captureLegacy,importLegacy,materializeLegacy} from '../scripts/amphoreus-import-legacy.mjs'
import {Store} from '../src/app/store.ts'
import {AmphoreusStore} from '../src/amphoreus/store.ts'
import {MemoryStore,MemorySettings} from '../src/amphoreus/memory.ts'

it('copies every original byte and database memory, preserves conflicting NEO versions, and reimports without duplication',async()=>{
  const root=mkdtempSync(join(tmpdir(),'amphoreus-legacy-')),home=join(root,'old-home'),docs=join(root,'old-documents'),destination=join(root,'snapshot'),database=join(root,'neo.sqlite')
  const put=(base:string,path:string,bytes:string|Buffer)=>{const file=join(base,path);mkdirSync(join(file,'..'),{recursive:true});writeFileSync(file,bytes);return file}
  const self='我是谁\r\n我叫角色，旧的全部原文。\r\n',diary='旧日记，一字不落。\n',secret='legacy-test-secret'
  put(docs,'QQ_msg/soul/我是谁.md',self);put(docs,'QQ_msg/soul/diary/2026-11-03.md',diary)
  const png=Buffer.from('89504e470d0a1a0a00000000','hex'),first=put(docs,'QQ_msg/drawings/画.png',png),same=put(docs,'QQ_msg/backup/old/drawings/画.png',png)
  const date=new Date('2026-11-03T00:00:00Z');utimesSync(first,date,date);utimesSync(same,date,date)
  put(home,'.credentials.yaml',`password: ${secret}`)
  put(home,'sessions/cwd/main/session.v4.jsonl',[
    {type:'session',id:'old-main',delegationDepth:0},
    {type:'request/header',data:{header:{config:{provider:'provider'}}}},
    {type:'user/message',seq:1,time:Date.now(),data:{content:[{type:'text',text:'旧会话里的山谷'}],source:{kind:'user'}}},
    {type:'assistant/message',seq:2,time:Date.now(),data:{message:{content:[{type:'text',text:'旧时的回答'},{type:'reasoning',text:'接口原本提供的构思'}]}}},
    {type:'tool/call',seq:3,time:Date.now(),data:{name:'test',arguments:{token:secret}}},
  ].map(value=>JSON.stringify(value)).join('\n')+'\n')
  put(home,'sessions-archive/old-main.bak.stamp/session.v4.jsonl',[
    {type:'session',id:'old-main',delegationDepth:0},
    {type:'user/message',seq:1,time:Date.now(),data:{content:[{type:'text',text:'只在备份里留下的星灯'}]}},
  ].map(value=>JSON.stringify(value)).join('\n')+'\n')
  const world=join(home,'worlds/default/archive.sqlite');mkdirSync(join(world,'..'),{recursive:true})
  const old=new DatabaseSync(world);old.exec('PRAGMA journal_mode=WAL; CREATE TABLE records(sequence INTEGER PRIMARY KEY,body TEXT)')
  old.prepare('INSERT INTO records VALUES(?,?)').run(1,JSON.stringify({recordId:'original-record',role:'user',content:'原记忆数据库里的潮汐',occurredAt:new Date().toISOString(),channel:'qq',speakerId:'person-one'}))
  copyFileSync(world,world+'.bak.stamp');copyFileSync(world+'-wal',world+'-wal.bak.stamp');old.close()
  const peoplePath=join(home,'people/people.sqlite');mkdirSync(join(peoplePath,'..'),{recursive:true})
  const people=new DatabaseSync(peoplePath);people.exec("CREATE TABLE people(name TEXT); INSERT INTO people VALUES('老朋友流岚'); CREATE TABLE impressions(note TEXT); INSERT INTO impressions VALUES('以前约好去海边'); CREATE TABLE contacts(address TEXT); INSERT INTO contacts VALUES('person@example.test')");people.close()
  const initial=new Store(database);new AmphoreusStore(initial);const neo=new MemoryStore(initial,'role')
  const previous=neo.put({kind:'self',title:'NEO Self',text:'NEO的冲突版本也应保留',status:'confirmed',created_at:neo.now(),source:{branch:'main'}})
  const neoDiary=neo.put({kind:'diary',title:'今天',text:'NEO日记',status:'confirmed',created_at:neo.now(),source:{branch:'main'},data:{day:'2026-11-03'}});initial.close()
  const plan={agentId:'role',database,destination,containerDestination:destination,nativeHome:join(root,'native-home'),projects:[{source:'documents/QQ_msg',destination:join(root,'working-project'),references:['backup']}],secrets:[secret],memory:{reasoning:{allowedProviders:['provider']}},
    sources:[{name:'home',path:home,exclude:['.credentials.yaml']},{name:'documents',path:docs}],currentSelf:'documents/QQ_msg/soul/我是谁.md',diaries:'documents/QQ_msg/soul/diary'}
  try{
    const manifest=await captureLegacy(plan);expect(manifest.sqlite).toHaveLength(3)
    expect(manifest.excluded).toContain('home/.credentials.yaml')
    for(const file of manifest.files.filter((file:any)=>file.type==='file'))expect(createHash('sha256').update(readFileSync(join(destination,file.path))).digest('hex')).toBe(file.sha256)
    expect(statSync(join(destination,'documents/QQ_msg/drawings/画.png')).ino).toBe(statSync(join(destination,'documents/QQ_msg/backup/old/drawings/画.png')).ino)
    await materializeLegacy(plan,manifest)
    expect(readFileSync(join(plan.nativeHome,'sessions/cwd/main/session.v4.jsonl'))).toEqual(readFileSync(join(home,'sessions/cwd/main/session.v4.jsonl')))
    expect(existsSync(join(plan.nativeHome,'sessions/--legacy-archive--'))).toBe(false)
    expect(readFileSync(join(destination,'home/sessions-archive/old-main.bak.stamp/session.v4.jsonl'))).toEqual(readFileSync(join(home,'sessions-archive/old-main.bak.stamp/session.v4.jsonl')))
    expect(readFileSync(join(root,'working-project/backup/old/drawings/画.png'))).toEqual(png)
    await importLegacy(plan,manifest)
    const inspect=new Store(database),memory=new MemoryStore(inspect,'role',MemorySettings.parse({reasoning:{allowedProviders:['provider']}}))
    expect(memory.find({kind:'self',status:'confirmed'})[0]?.text).toBe(self)
    expect(memory.find({kind:'diary',status:'confirmed'})[0]?.text).toBe(diary)
    expect(memory.get(previous.id)).toMatchObject({text:'NEO的冲突版本也应保留',status:'superseded'})
    expect(memory.get(neoDiary.id)?.status).toBe('superseded')
    expect(memory.find({query:'潮汐'})[0]?.source.actor_id).toBe('person-one')
    expect(memory.find({query:'person-one'}).some(record=>record.text==='原记忆数据库里的潮汐')).toBe(true)
    expect(memory.find({query:'老朋友流岚'}).some(record=>record.kind==='legacy_person')).toBe(true)
    expect(memory.find({query:'person@example.test'}).some(record=>record.kind==='legacy_person')).toBe(true)
    expect(memory.find({query:'山谷'})).toHaveLength(2) // Original native file and its searchable input record.
    expect(memory.find({query:'只在备份里留下的星灯'}).some(record=>record.kind==='input')).toBe(true)
    expect(memory.find({query:'legacy-test-secret'})).toHaveLength(0)
    const count=inspect.db.prepare('SELECT COUNT(*) AS n FROM amphoreus_memory').get()!.n;inspect.close()
    await importLegacy(plan,await captureLegacy(plan))
    const again=new Store(database);expect(again.db.prepare('SELECT COUNT(*) AS n FROM amphoreus_memory').get()!.n).toBe(count);again.close()
    writeFileSync(join(root,'working-project/soul/我是谁.md'),'工作副本的修改')
    expect(readFileSync(join(destination,'documents/QQ_msg/soul/我是谁.md'),'utf8')).toBe(self)
  }finally{rmSync(root,{recursive:true,force:true})}
})
