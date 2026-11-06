#!/usr/bin/env node
/** Offline private archive of domain data and selected native session logs; excludes credential/config files. */
import { DatabaseSync,backup } from 'node:sqlite'
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync,rmSync } from 'node:fs'
import { dirname, join, resolve, relative } from 'node:path'
import { lockSync } from 'proper-lockfile'
import {exportAssets,validateAssets,restoreAssets} from './amphoreus-assets.mjs'
const [operation, database, file, sessionHome,workspaceRoot] = process.argv.slice(2)
if (!['export', 'restore'].includes(operation) || !database || !file) {
  console.error('Usage: node scripts/amphoreus-data.mjs export|restore DATABASE JSON_FILE [DSH_HOME] [WORKSPACE_ROOT] (Runtime must be stopped)'); process.exit(2)
}
const tables = ['amphoreus_meta', 'amphoreus_event', 'amphoreus_task', 'amphoreus_report', 'amphoreus_output', 'amphoreus_run', 'amphoreus_record', 'amphoreus_memory', 'amphoreus_metric', 'amphoreus_log']
if(operation==='restore'){
 if(sessionHome&&existsSync(sessionHome)&&readdirSync(sessionHome).length)throw Error('Native log restore requires an empty DSH_HOME destination')
 if(workspaceRoot&&existsSync(workspaceRoot)&&readdirSync(workspaceRoot).length)throw Error('Project restore requires an empty WORKSPACE_ROOT destination')
}
function scrub(value, key = '') {
  if (/(?:token|secret|password|authorization|cookie|api.?key)/i.test(key)) return '[REDACTED]'
  if (Array.isArray(value)) return value.map(item => scrub(item))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v, k)]))
  if (typeof value === 'string') {
    try { if (key === 'value') return JSON.stringify(scrub(JSON.parse(value))) } catch {}
    return value.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
  }
  return value
}
mkdirSync(dirname(database), { recursive: true, mode: 0o700 })
const unlock = lockSync(dirname(database), { realpath: false })
let db
try {
  if (operation === 'export') {
    if (existsSync(file)) throw new Error('Export target already exists; choose a new filename')
    if(existsSync(file+'.assets'))throw new Error('Asset destination already exists')
    db = new DatabaseSync(database, { readOnly: true }); db.exec('BEGIN')
    const data = Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(table) ? db.prepare(`SELECT rowid AS _archive_rowid,* FROM ${table} ORDER BY rowid`).all() : []]))
    const ids = new Set()
    for (const table of ['amphoreus_run', 'amphoreus_task']) for (const row of data[table]) {
      const value = JSON.parse(row.value)
      for (const id of [value.session_id, value.subagent_id, value.parent_session_id, value.fork?.parent_session_id]) if (id) ids.add(id)
    }
    for(const row of data.amphoreus_record)if(row.kind==='legacy-native-session'){const value=JSON.parse(row.value);if(value.session_id)ids.add(value.session_id)}
    const native = []
    if (sessionHome && existsSync(join(sessionHome, 'sessions'))) for (const group of readdirSync(join(sessionHome, 'sessions'), { withFileTypes: true })) {
      if (!group.isDirectory()) continue
      for (const entry of readdirSync(join(sessionHome, 'sessions', group.name), { withFileTypes: true })) {
        if (!entry.isDirectory() || !ids.has(entry.name)) continue
        for (const name of readdirSync(join(sessionHome, 'sessions', group.name, entry.name))) {
          if (!/^session\.v\d+\.jsonl(?:\.zstd)?$/.test(name)) continue
          const path = join('sessions', group.name, entry.name, name)
          native.push({ path, base64: readFileSync(join(sessionHome, path)).toString('base64') })
        }
      }
    }
    let workspace
    const workspaceFile = sessionHome && join(sessionHome, 'storages/workspace.json')
    if (workspaceFile && existsSync(workspaceFile)) {
      const original = JSON.parse(readFileSync(workspaceFile, 'utf8'))
      const workspaces = Object.fromEntries(Object.entries(original.tables.workspaces).filter(([, value]) => value.sessionIds.some(id => ids.has(id))))
      workspace = { ...original, global: { ...original.global, workspaceIds: Object.keys(workspaces), archivedSessionIds: (original.global.archivedSessionIds ?? []).filter(id => ids.has(id)), pinnedSessionIds: (original.global.pinnedSessionIds ?? []).filter(id => ids.has(id)) }, tables: { ...original.tables, workspaces } }
    }
    db.exec('COMMIT')
    const roots={home:sessionHome,workspace:workspaceRoot,state:dirname(database)},includes={...(sessionHome?{home:['attachments','amphoreus/legacy-fishtank','amphoreus/memes']}:{}),...(workspaceRoot?{workspace:['.']}:{})},extra=[]
    mkdirSync(dirname(file),{recursive:true,mode:0o700})
    const peopleFile=join(dirname(database),'people.sqlite'),peopleSnapshot=file+'.people-tmp.sqlite'
    let ownedPeopleSnapshot=false
    try{
      if(existsSync(peopleFile)){
        if(existsSync(peopleSnapshot))throw Error('People snapshot target already exists')
        writeFileSync(peopleSnapshot,'',{mode:0o600,flag:'wx'});ownedPeopleSnapshot=true
        const people=new DatabaseSync(peopleFile,{readOnly:true});try{await backup(people,peopleSnapshot)}finally{people.close()}
        extra.push({root:'state',path:'people.sqlite',source:peopleSnapshot})
      }
      const assets=await exportAssets(file+'.assets',roots,includes,extra),privateData=scrub(data)
      // These fields are password hashes and encrypted TOTP material, not plaintext configuration.
      privateData.amphoreus_record=data.amphoreus_record.map(row=>row.kind==='console-auth'?row:scrub(row))
      writeFileSync(file, JSON.stringify({ format: 'amphoreus-genesis', version: 4, data: privateData, native, workspace,assets }, null, 2), { mode: 0o600, flag: 'wx' })
      console.log(`Private archive exported: ${native.length} native logs; ${assets.filter(entry=>entry.type==='file').length} assets. Preserve the JSON and .assets directory together. Configuration files excluded; private transcripts and legacy archives remain private.${workspaceRoot?'':' Working projects omitted: provide WORKSPACE_ROOT for a complete backup.'}`)
    }finally{if(ownedPeopleSnapshot)rmSync(peopleSnapshot,{force:true})}
  } else {
    if (existsSync(database)) throw new Error('Restore requires a new database path; never overwrite live data')
    const archive = JSON.parse(readFileSync(file, 'utf8'))
    if (archive.format !== 'amphoreus-genesis' || ![2, 3,4].includes(archive.version) || !archive.data) throw new Error('Unsupported archive')
    if (archive.native?.length && !sessionHome) throw new Error('Native log restore requires an empty DSH_HOME destination')
    const roots={home:sessionHome,workspace:workspaceRoot,state:dirname(database)}
    if(archive.version===4){
      if(!Array.isArray(archive.assets))throw Error('Missing asset manifest')
      await validateAssets(file+'.assets',archive.assets,roots)
      for(const entry of archive.assets)if(entry.root==='state'&&(existsSync(join(roots.state,entry.path))||resolve(database)===resolve(roots.state,entry.path)))throw Error('Restore would overwrite existing state')
    }
    for (const entry of archive.native??[]) {
      const target=resolve(sessionHome,entry.path),path=relative(resolve(sessionHome),target)
      if(path.startsWith('..')||!/^sessions\/[^/]+\/[^/]+\/session\.v\d+\.jsonl(?:\.zstd)?$/.test(path))throw Error('Unsafe native log path')
    }
    // Open through the built bundle to reuse the real SQLite schema and migrations.
    const { Store, Telemetry } = await import('../lib/amphoreus-data.js')
    const { AmphoreusStore, MemoryStore } = await import('../lib/index.js')
    const host = new Store(database); db = host.db; const domain=new AmphoreusStore(host),memory=new MemoryStore(host, '__restore__');new Telemetry(memory,domain)
    host.atomic(() => {
      for (const table of tables) {
        const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(row => String(row.name))
        if (archive.version >= 3) columns.unshift('rowid')
        const rows = archive.data[table] ?? (['amphoreus_metric','amphoreus_log'].includes(table) ? [] : undefined) ?? (table === 'amphoreus_memory' && archive.version === 2 ? [] : undefined)
        if (!Array.isArray(rows)) throw new Error(`Missing table ${table}`)
        const insert = db.prepare(`INSERT OR REPLACE INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`)
        for (const row of rows) insert.run(...columns.map(column => row[column === 'rowid' ? '_archive_rowid' : column] ?? null))
      }
      // Queued work can recover; interrupted work/sends need explicit review, never replay public side effects.
      db.exec("UPDATE amphoreus_output SET status='unknown' WHERE status IN ('pending','sending'); UPDATE amphoreus_run SET state='interrupted' WHERE state='running'")
    })
    if(archive.version===4)await restoreAssets(file+'.assets',archive.assets,roots)
    if (sessionHome) {
      for (const entry of archive.native ?? []) {
        const target = resolve(sessionHome, entry.path), path = relative(resolve(sessionHome), target)
        if (path.startsWith('..') || !/^sessions\/[^/]+\/[^/]+\/session\.v\d+\.jsonl(?:\.zstd)?$/.test(path)) throw new Error('Unsafe native log path')
        mkdirSync(dirname(target), { recursive: true, mode: 0o700 }); writeFileSync(target, Buffer.from(entry.base64, 'base64'), { mode: 0o600, flag: 'wx' })
      }
      if (archive.workspace) { mkdirSync(join(sessionHome, 'storages'), { recursive: true, mode: 0o700 }); writeFileSync(join(sessionHome, 'storages/workspace.json'), JSON.stringify(archive.workspace), { mode: 0o600, flag: 'wx' }) }
    }
    console.log('Restored to a new database. Start with separate private configuration; review interrupted tasks before retrying.')
  }
} finally { db?.close(); unlock() }
