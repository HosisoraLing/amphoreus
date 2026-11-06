/** Private backup files use content-addressed sidecars, never links to mutable source files. */
import {createHash} from 'node:crypto'
import {createReadStream,constants} from 'node:fs'
import {mkdir,readdir,lstat,readlink,symlink,copyFile,link,chmod} from 'node:fs/promises'
import {resolve,relative,dirname,join,isAbsolute} from 'node:path'
const digest=async path=>{const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);return hash.digest('hex')}
const within=(root,path)=>{const part=relative(resolve(root),resolve(path));return part===''||!part.startsWith('..'+(process.platform==='win32'?'\\':'/'))&&part!=='..'&&!isAbsolute(part)}
const safe=path=>typeof path==='string'&&path.length>0&&!path.includes('\\')&&!isAbsolute(path)&&!path.split('/').some(part=>!part||part==='.'||part==='..')
export async function exportAssets(directory,roots,includes,extra=[]){
 await mkdir(directory,{mode:0o700})
 const entries=[],blobs=new Set()
 const locate=path=>{
  for(const [root,base] of Object.entries(roots))if(base&&within(base,path))return {root,path:relative(base,path).split('\\').join('/')}
  for(const [root,prefix] of [['home','/root/.dsh/'],['workspace','/workspace/']])if(roots[root]&&path.startsWith(prefix))return {root,path:path.slice(prefix.length),container:true}
  throw Error('Asset link leaves the archived home/workspace')
 }
 const add=async(root,path,from)=>{
  const info=await lstat(from),entry={root,path,mode:info.mode&0o777}
  if(info.isDirectory()){
   entries.push({...entry,type:'directory'})
   for(const child of await readdir(from))await add(root,path?`${path}/${child}`:child,join(from,child))
  }else if(info.isSymbolicLink()){
   const target=await readlink(from),destination=locate(resolve(dirname(from),target))
   entries.push({...entry,type:'symlink',target,destination})
  }else if(info.isFile()){
   const sha256=await digest(from)
   if(!blobs.has(sha256)){const target=join(directory,sha256);await copyFile(from,target,constants.COPYFILE_FICLONE|constants.COPYFILE_EXCL);await chmod(target,0o600);if(await digest(target)!==sha256)throw Error('Asset changed during backup');blobs.add(sha256)}
   entries.push({...entry,type:'file',bytes:info.size,sha256})
  }else throw Error('Unsupported backup asset')
 }
 for(const [root,paths] of Object.entries(includes))for(const path of paths){
  const from=join(roots[root],path)
  try{await lstat(from)}catch(error){if(error.code==='ENOENT')continue;throw error}
  if(path==='.')for(const child of await readdir(from))await add(root,child,join(from,child))
  else await add(root,path,from)
 }
 for(const entry of extra)await add(entry.root,entry.path,entry.source)
 return entries
}
export async function validateAssets(directory,entries,roots){
 const sidecar=await lstat(directory)
 if(!sidecar.isDirectory()||sidecar.isSymbolicLink())throw Error('Invalid asset directory')
 const paths=new Set(),links=new Set(),checked=new Map()
 for(const entry of entries){
  if(!['home','workspace','state'].includes(entry.root)||!roots[entry.root]||!safe(entry.path))throw Error('Unsafe asset destination or missing restore root')
  if(entry.root==='home'&&!['attachments','amphoreus/legacy-fishtank'].some(prefix=>entry.path===prefix||entry.path.startsWith(prefix+'/')))throw Error('Unsupported home asset')
  if(entry.root==='state'&&entry.path!=='people.sqlite')throw Error('Unsupported state asset')
  const key=`${entry.root}/${entry.path}`
  if(paths.has(key))throw Error('Duplicate asset path');paths.add(key)
  if(!['file','directory','symlink'].includes(entry.type))throw Error('Unsupported asset type')
  if(!Number.isInteger(entry.mode)||entry.mode<0||entry.mode>0o777)throw Error('Invalid asset mode')
  if(entry.type==='symlink'){
   links.add(key)
   const target=entry.destination
   if(!target||!['home','workspace','state'].includes(target.root)||!roots[target.root]||!safe(target.path)||typeof entry.target!=='string')throw Error('Unsafe asset link')
   if(target.container&&!['home','workspace'].includes(target.root))throw Error('Unsafe container link root')
   if(target.container&&entry.target!==`${target.root==='home'?'/root/.dsh/':'/workspace/'}${target.path}`)throw Error('Unsafe container asset link')
  }
  if(entry.type==='file'){
   links.add(key)
   if(!Number.isSafeInteger(entry.bytes)||entry.bytes<0)throw Error('Invalid asset size')
   if(!/^[a-f0-9]{64}$/.test(entry.sha256))throw Error('Invalid asset checksum')
   if(!checked.has(entry.sha256)){
    const blob=join(directory,entry.sha256),stat=await lstat(blob)
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==entry.bytes||await digest(blob)!==entry.sha256)throw Error('Backup asset checksum mismatch')
    checked.set(entry.sha256,entry.bytes)
   }
   if(checked.get(entry.sha256)!==entry.bytes)throw Error('Inconsistent asset size')
  }
 }
 for(const path of paths){const parts=path.split('/');while(parts.length>1){parts.pop();if(links.has(parts.join('/')))throw Error('Asset path traverses a symlink')}}
}
export async function restoreAssets(directory,entries,roots){
 const immutable=new Map()
 for(const entry of entries.filter(entry=>entry.type!=='symlink')){
  const target=join(roots[entry.root],entry.path)
  if(entry.type==='directory'){await mkdir(target,{recursive:true,mode:0o700});continue}
  await mkdir(dirname(target),{recursive:true,mode:0o700})
  const key=`${entry.sha256}:${entry.mode}`,shared=entry.root==='home'&&entry.path.startsWith('amphoreus/legacy-fishtank/')
  if(shared&&immutable.has(key))await link(immutable.get(key),target)
  else {await copyFile(join(directory,entry.sha256),target,constants.COPYFILE_FICLONE|constants.COPYFILE_EXCL);await chmod(target,entry.mode&0o777);if(shared)immutable.set(key,target)}
 }
 for(const entry of entries.filter(entry=>entry.type==='symlink')){
  const target=join(roots[entry.root],entry.path),destination=join(roots[entry.destination.root],entry.destination.path)
  await mkdir(dirname(target),{recursive:true,mode:0o700})
  await symlink(entry.destination.container?entry.target:relative(dirname(target),destination),target)
 }
}
