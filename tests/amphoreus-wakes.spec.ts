import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { Store } from '../src/app/store.ts'
import { AmphoreusStore } from '../src/amphoreus/store.ts'
import { normalizeEvent } from '../src/amphoreus/model.ts'

it('groups actual admitted events, nested QQ batches, thoughts and output by wake without admitting queued steering', () => {
  const dir=mkdtempSync(join(tmpdir(),'amphoreus-wakes-')),host=new Store(join(dir,'state.sqlite')),store=new AmphoreusStore(host)
  try {
    const event=(id:string,extra:any={})=>{const e=normalizeEvent({agent_id:'role',event_id:id,source_kind:'napcat',platform:'qq',account_id:'bot',conversation_id:'group:123',actor_id:'friend',event_type:'message',timestamp:'2026-11-04T08:00:00Z',correlation_id:null,content:[],metadata:{},visibility:'public',idempotency_key:id,...extra});store.insertEvent(e);return e}
    const source=event('source'),batch=event('batch',{source_kind:'qq-debounce',metadata:{source_event_ids:['source']}})
    event('wake',{source_kind:'qq-observation',metadata:{source_event_ids:['batch']}})
    store.startRun({run_id:'run',agent_id:'role',session_id:'main',event_id:'wake',started_at:'2026-11-04T08:00:01Z',state:'running'})
    expect(store.eventWake(source)?.run_id).toBe('run');expect(store.eventWake(batch)?.run_id).toBe('run')
    expect(store.eventWake(event('output',{source_kind:'output-gateway',correlation_id:'run'}))?.run_id).toBe('run')
    expect(store.eventWake(event('thought',{source_kind:'internal',correlation_id:'run'}))?.run_id).toBe('run')
    const next=event('next');store.setRecord('main-steer','next',{admitted:false,run_id:'run'})
    expect(store.eventWake(next)).toBeNull()
    store.setRecord('main-steer','next',{admitted:true,run_id:'run'});expect(store.eventWake(next)?.run_id).toBe('run')
    expect(store.eventWake(event('other',{account_id:'other-bot',metadata:{}}))).toBeNull()
  } finally {host.close();rmSync(dir,{recursive:true})}
})
