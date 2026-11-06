import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync,symlinkSync,statSync,existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { expect, it } from 'vitest'
import { Store } from '../src/app/store.ts'
import { AmphoreusStore } from '../src/amphoreus/store.ts'
import { MemoryStore } from '../src/amphoreus/memory.ts'
import {PeopleService} from '../src/amphoreus/people.ts'
import {validateAssets} from '../scripts/amphoreus-assets.mjs'

it('round-trips memory IDs/cursors and native Fork logs without overwriting an existing destination', () => {
  const dir = mkdtempSync(join(tmpdir(), 'amphoreus-export-'))
  try {
    const database = join(dir, 'source/data.sqlite'), backup = join(dir, 'archive.json'), destination = join(dir, 'new/data.sqlite'), sourceHome = join(dir, 'home'), restoreHome = join(dir, 'restored'),workspace=join(dir,'projects'),restoredProjects=join(dir,'restored-projects')
    mkdirSync(join(dir, 'source'), { recursive: true }); mkdirSync(join(dir, 'new'))
    const host = new Store(database), store = new AmphoreusStore(host), memory = new MemoryStore(host, 'role')
    memory.put({ id: 'source', kind: 'assistant', title: '星光', text: '原始文本', created_at: new Date().toISOString(), source: { branch: 'continuation', session_id: 'child', parent_session_id: 'parent' } })
    store.setRecord('dreaming-cursor', 'role', memory.position())
    const auth={password:'scrypt-hash-only',secret:'encrypted-totp-material',salt:'salt',lastCounter:42,recovery:['one-way-hash']}
    store.setRecord('console-auth','role-owner',auth)
    store.setRecord('legacy-native-session','legacy',{agent_id:'role',session_id:'legacy'})
    host.db.prepare('INSERT INTO amphoreus_run VALUES (?,?,?,?,?,?,?,?)').run('run', 'role', 'event', 'completed', 'now', 'now', '', JSON.stringify({ session_id: 'parent' }))
    host.db.prepare('INSERT INTO amphoreus_task VALUES (?,?,?,?,?,?,?)').run('task', 'role', 'completed', 0, 'now', 'now', JSON.stringify({ subagent_id: 'child', fork: { parent_session_id: 'parent' } }))
    host.close()
    for (const id of ['parent','child','legacy']) { const path = join(sourceHome, 'sessions', 'workspace', id); mkdirSync(path, { recursive: true }); writeFileSync(join(path, 'session.v4.jsonl.zstd'), `opaque-native-${id}`) }
    const attachment='attachments/v1/objects/图片.png',raw='amphoreus/legacy-fishtank/documents/画.png'
    const bytes=Buffer.from('89504e470d0a1a0a1234','hex')
    for(const path of [attachment,raw]){mkdirSync(join(sourceHome,path,'..'),{recursive:true});writeFileSync(join(sourceHome,path),bytes)}
    mkdirSync(join(workspace,'site'),{recursive:true});writeFileSync(join(workspace,'site/index.html'),'独立迁移的书架')
    symlinkSync(join(sourceHome,raw),join(workspace,'旧画.png'))
    const people=new PeopleService(join(dir,'source/people.sqlite'),'role',[],['admin']);people.admin('people_get',{identity:'qq:55500001'},'admin');people.admin('people_note',{identity:'qq:55500001',key:'偏好',body:'海边',evidence:'原话'},'admin');people.close()
    mkdirSync(join(sourceHome,'storages'))
    writeFileSync(join(sourceHome,'storages/workspace.json'), JSON.stringify({ global: { workspaceIds: ['role-workspace'], archivedSessionIds: ['child','unrelated'], pinnedSessionIds: ['parent','unrelated'] }, tables: { workspaces: { 'role-workspace': { sessionIds: ['parent','child'] } } } }))
    const run = (...args: string[]) => execFileSync(process.execPath, ['scripts/amphoreus-data.mjs', ...args], { cwd: process.cwd(), stdio: 'pipe' })
    run('export', database, backup, sourceHome,workspace)
    const archive=JSON.parse(readFileSync(backup, 'utf8'));expect(archive.version).toBe(4);expect(archive.native).toHaveLength(3)
    run('restore', destination, backup, restoreHome,restoredProjects)
    const restoredHost = new Store(destination), restoredStore = new AmphoreusStore(restoredHost), restored = new MemoryStore(restoredHost, 'role')
    expect(restored.get('source')?.source.parent_session_id).toBe('parent')
    expect(restored.get('source')?.text).toBe('原始文本')
    expect(restoredStore.record('dreaming-cursor', 'role')).toBe(restored.position())
    expect(restoredStore.record('console-auth','role-owner')).toEqual(auth)
    restoredHost.close()
    expect(readFileSync(join(restoreHome, 'sessions/workspace/child/session.v4.jsonl.zstd'), 'utf8')).toBe('opaque-native-child')
    expect(readFileSync(join(restoreHome,attachment))).toEqual(bytes)
    expect(readFileSync(join(restoreHome,raw))).toEqual(bytes)
    expect(readFileSync(join(restoredProjects,'旧画.png'))).toEqual(bytes)
    expect(readFileSync(join(restoredProjects,'site/index.html'),'utf8')).toBe('独立迁移的书架')
    expect(statSync(join(restoreHome,raw)).ino).not.toBe(statSync(join(sourceHome,raw)).ino)
    const restoredPeople=new PeopleService(join(dir,'new/people.sqlite'),'role');expect(restoredPeople.store.profile('qq:55500001',{} as never)!.impressions[0]!.body).toBe('海边');restoredPeople.close()
    const registry = JSON.parse(readFileSync(join(restoreHome, 'storages/workspace.json'), 'utf8'))
    expect(registry.global.archivedSessionIds).toEqual(['child'])
    expect(registry.global.pinnedSessionIds).toEqual(['parent'])
    expect(() => run('restore', destination, backup, restoreHome)).toThrow()
    const legacyFile=join(dir,'legacy-v3.json');writeFileSync(legacyFile,JSON.stringify({...archive,version:3,assets:undefined}))
    run('restore',join(dir,'legacy-db/data.sqlite'),legacyFile,join(dir,'legacy-home'))
    expect(readFileSync(join(dir,'legacy-home/sessions/workspace/parent/session.v4.jsonl.zstd'),'utf8')).toBe('opaque-native-parent')
    writeFileSync(backup,JSON.stringify({...archive,assets:[...archive.assets,{root:'home',path:'../escape',type:'directory',mode:0o700}]}))
    const invalid=join(dir,'invalid/data.sqlite');expect(()=>run('restore',invalid,backup,join(dir,'invalid-home'),join(dir,'invalid-projects'))).toThrow();expect(existsSync(invalid)).toBe(false)
    writeFileSync(backup,JSON.stringify(archive));const blob=archive.assets.find((entry:any)=>entry.type==='file').sha256;writeFileSync(join(backup+'.assets',blob),'tampered')
    expect(()=>run('restore',invalid,backup,join(dir,'invalid-home'),join(dir,'invalid-projects'))).toThrow();expect(existsSync(invalid)).toBe(false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
it('rejects backup assets that would traverse a restored symlink',async()=>{
 const root=mkdtempSync(join(tmpdir(),'amphoreus-asset-check-'))
 try{
  const roots={home:join(root,'home'),workspace:join(root,'work')}
  await expect(validateAssets(root,[{root:'workspace',path:'alias',type:'symlink',mode:0o777,target:'elsewhere',destination:{root:'home',path:'attachments'}},{root:'workspace',path:'alias/child',type:'directory',mode:0o700}],roots)).rejects.toThrow('symlink')
  await expect(validateAssets(root,[{root:'workspace',path:'alias',type:'symlink',mode:0o777,target:'elsewhere',destination:{root:'__proto__',path:'attachments'}}],roots)).rejects.toThrow('Unsafe asset link')
 }
 finally{rmSync(root,{recursive:true,force:true})}
})
