import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import { AmphoreusStore } from '../src/amphoreus/store.ts'
import { MemorySettings, MemoryStore } from '../src/amphoreus/memory.ts'
import { Dreaming } from '../src/amphoreus/dreaming.ts'
import type { AmphoreusRuntime } from '../src/amphoreus/runtime.ts'

it('defaults to Beijing 01:00 and waits for the next occurrence when rescheduled during the day',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'amphoreus-dream-time-')),host=new Store(join(dir,'state.sqlite'))
 try{
  const settings=MemorySettings.parse({});expect(settings.timeZone).toBe('Asia/Shanghai');expect(settings.dreaming.at).toBe('01:00')
  let now=new Date('2026-11-04T08:45:00Z')
  const store=new AmphoreusStore(host),memory=new MemoryStore(host,'role',settings,()=>now),events:unknown[]=[]
  const runtime={store,startReview:vi.fn(),controls:{enabled:true},gateway:{ingest:async(_source:string,event:unknown)=>{events.push(event)}},onChange(){}} as unknown as AmphoreusRuntime
  const dreaming=new Dreaming(memory,runtime)
  memory.put({kind:'input',title:'经历',text:'今天的真实经历',created_at:memory.now(),source:{branch:'main'}})
  store.setRecord('dreaming-not-before','role','2026-11-04T17:00:00.000Z')
  expect(await dreaming.schedule(false)).toBeUndefined();expect(events).toHaveLength(0)
  now=new Date('2026-11-04T16:59:59Z');expect(await dreaming.schedule(false)).toBeUndefined()
  now=new Date('2026-11-04T17:00:00Z');expect((await dreaming.schedule(false))?.status).toBe('scheduled');expect(events).toHaveLength(1)
 }finally{host.close();rmSync(dir,{recursive:true})}
})

it('schedules incremental review intents idempotently and leaves personal drafts under Main control', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'amphoreus-dream-')), host = new Store(join(dir, 'test.sqlite'))
  try {
    const store = new AmphoreusStore(host), memory = new MemoryStore(host, 'role', MemorySettings.parse({}), () => new Date('2026-11-03T15:30:00Z'))
    const emitted: unknown[] = []
    const runtime = { store,startReview:vi.fn(),controls:{enabled:true}, gateway: { ingest: async (_: string, event: unknown) => { emitted.push(event) } }, onChange() {} } as unknown as AmphoreusRuntime
    const dreaming = new Dreaming(memory, runtime)
    expect(await dreaming.schedule(true, 'empty')).toBeUndefined()
    const raw = memory.put({ kind: 'assistant', title: '想法', text: '今天想试试温柔的设计。', created_at: memory.now(), source: { branch: 'main' } })
    const job = (await dreaming.schedule(false))!
    expect(job.status).toBe('scheduled'); expect(emitted).toHaveLength(1)
    expect((emitted[0] as any).metadata.schedule).toBe(false)
    expect(runtime.startReview).toHaveBeenCalledWith(job.data.event_id,expect.stringContaining('job_id='+job.id))
    expect((await dreaming.schedule(false))?.id).toBe(job.id)
    expect(dreaming.read(job.id).records.map(r => r.id)).toEqual([raw.id])
    const draft = memory.put({ kind: 'diary_draft', title: '待审', text: '不是正式日记', status: 'candidate', created_at: memory.now(), source: { branch: 'continuation' }, data: { job_id: job.id } })
    const main = { branch: 'main' as const, source: { run_id: 'review-run' }, call_id: 'close' }
    expect(() => dreaming.finish(job.id, '关闭', { ...main, branch: 'continuation' }, false)).toThrow('Only Main')
    expect(() => dreaming.finish(job.id, '关闭', main, false)).toThrow('pending personal drafts')
    memory.update(draft.id, { status: 'archived' })
    expect(dreaming.finish(job.id, '今天无需日记', main, true).status).toBe('skipped')
    expect(dreaming.status().cursor).toBe(job.data.to)
    expect(await dreaming.schedule(true, 'next')).toBeUndefined()
    memory.put({ kind: 'input', title: '新消息', text: '新的经历', created_at: memory.now(), source: { branch: 'main' } })
    const next = (await dreaming.schedule(true, 'next'))!
    expect(dreaming.read(next.id).records).toHaveLength(1)
    expect(next.data.from).toBe(job.data.to)
    runtime.store.event = (() => ({ state: 'failed', error: 'Main interrupted before delegating' })) as unknown as typeof runtime.store.event
    dreaming.reconcile()
    expect(memory.get(next.id)?.status).toBe('failed')
    expect((await dreaming.schedule(true, 'retry-after-interruption'))?.id).not.toBe(next.id)
  } finally { host.close(); rmSync(dir, { recursive: true, force: true }) }
})


it('explicitly resumes saved candidates without rerunning a continuation or reopening a finished review',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'amphoreus-review-resume-')),host=new Store(join(dir,'db.sqlite'))
 try{
  const store=new AmphoreusStore(host),memory=new MemoryStore(host,'role'),ingest=vi.fn(async()=>({})),startReview=vi.fn()
  const dreaming=new Dreaming(memory,{store,startReview,gateway:{ingest},onChange(){}} as never)
  const job=memory.put({kind:'consolidation',title:'回顾',text:'',created_at:memory.now(),source:{branch:'main'},status:'failed',data:{from:0,to:1}})
  memory.put({kind:'diary_draft',title:'待审',text:'已写好的候选',created_at:memory.now(),source:{branch:'continuation'},status:'candidate',data:{job_id:job.id}})
  await dreaming.reviewReady(job.id,'resume');expect(startReview).not.toHaveBeenCalled()
  expect(ingest).toHaveBeenCalledWith('internal',expect.objectContaining({conversation_id:'memory-review',event_type:'memory.review.ready',metadata:{job_id:job.id}}))
  memory.update(job.id,{status:'reviewed'});await dreaming.reviewReady(job.id,'again');expect(ingest).toHaveBeenCalledOnce()
 }finally{host.close();rmSync(dir,{recursive:true,force:true})}
})
