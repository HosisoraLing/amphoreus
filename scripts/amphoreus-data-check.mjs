import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { Store } from '../lib/amphoreus-data.js'
import { AmphoreusStore, normalizeEvent } from '../lib/index.js'
const dir = mkdtempSync(join(tmpdir(), 'amphoreus-export-'))
try {
  const host = new Store(join(dir, 'original.sqlite')), store = new AmphoreusStore(host)
  store.setRecord('identity','role',{ agent_id:'role',name:'role',persona:'Persona', token:'private-token' })
  store.insertEvent(normalizeEvent({agent_id:'role',source_kind:'web',platform:'web',account_id:'alice',conversation_id:'chat',actor_id:'alice',event_type:'message',timestamp:new Date().toISOString(),correlation_id:null,content:[{type:'text',text:'hello'}],metadata:{secret:'secret-value'},visibility:'private',idempotency_key:'hello'}))
  host.close()
  for (const args of [['export',join(dir,'original.sqlite'),join(dir,'archive.json')],['restore',join(dir,'restored','orchestrator.sqlite'),join(dir,'archive.json')]]) {
    const result = spawnSync(process.execPath,['scripts/amphoreus-data.mjs',...args],{encoding:'utf8'})
    assert.equal(result.status,0,result.stderr); console.log(result.stdout.trim())
  }
  const archive = readFileSync(join(dir,'archive.json'),'utf8'); assert(!archive.includes('private-token')); assert(!archive.includes('secret-value'))
  const restored = new Store(join(dir,'restored','orchestrator.sqlite')), data = new AmphoreusStore(restored)
  assert.equal(data.events().length,1); assert.equal(data.record('identity','role').agent_id,'role'); restored.close()
  const overwrite = spawnSync(process.execPath,['scripts/amphoreus-data.mjs','restore',join(dir,'original.sqlite'),join(dir,'archive.json')],{encoding:'utf8'})
  assert.notEqual(overwrite.status,0)
  console.log('export/restore/secret redaction/overwrite protection passed')
} finally { rmSync(dir,{recursive:true,force:true}) }
