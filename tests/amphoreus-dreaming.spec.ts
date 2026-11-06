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

it('commits contiguous frozen batches including zero candidates, resumes from durable progress and never skips unread history',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'dream-batches-')),host=new Store(join(dir,'db.sqlite'))
 try{
  const store=new AmphoreusStore(host),memory=new MemoryStore(host,'role',MemorySettings.parse({dreaming:{consolidation:true}}))
  const runtime={store,startReview:vi.fn(),controls:{enabled:true},gateway:{ingest:vi.fn(async()=>{})},onChange(){}} as unknown as AmphoreusRuntime
  const dreaming=new Dreaming(memory,runtime),main={branch:'main' as const,source:{run_id:'review-run'},call_id:'commit'}
  for(let i=0;i<10;i++)memory.put({kind:'input',title:'ordinary',text:`small talk ${i}`,created_at:memory.now(),source:{}})
  const job=(await dreaming.schedule(true,'batch-test'))!,first=dreaming.read(job.id,3) as any
  expect(first.records).toHaveLength(3);expect(first.complete).toBe(false)
  expect(()=>dreaming.finish(job.id,'premature',main,true)).toThrow('unprocessed')
  const future=dreaming.read(job.id,3,0,first.next_position) as any
  expect(()=>dreaming.commit(job.id,future.batch_id,[],'no useful facts',main)).toThrow('next unprocessed')
  dreaming.commit(job.id,first.batch_id,[],'ordinary small talk; zero candidates',main)
  dreaming.commit(job.id,first.batch_id,[],'retry',main)
  const restored=new Dreaming(memory,runtime),next=restored.read(job.id,3) as any
  expect(next.records[0].position).toBeGreaterThan(first.next_position)
  for(let n=0;n<10;n++){
   const batch=restored.read(job.id,3) as any
   restored.commit(job.id,batch.batch_id,[],'zero candidates',main)
   if(batch.complete)break
  }
  expect(memory.find({kind:'candidate'})).toHaveLength(0)
  expect(restored.finish(job.id,'No long-term material',main,true).status).toBe('skipped')
  expect(store.record('dreaming-cursor','role')).toBe(job.data.to)
 }finally{host.close();rmSync(dir,{recursive:true,force:true})}
})

it('does not advance a completed but unread review and isolates historical backfill from the daily cursor',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'dream-incomplete-')),host=new Store(join(dir,'db.sqlite'))
 try{
  const store=new AmphoreusStore(host),memory=new MemoryStore(host,'role'),controlTask=vi.fn()
  for(let n=0;n<6;n++)memory.put({kind:'input',title:'history',text:`message ${n}`,created_at:memory.now(),source:{}})
  store.setRecord('dreaming-cursor','role',1)
  const runtime={store,controlTask,startReview:vi.fn(),controls:{enabled:true},gateway:{ingest:vi.fn(async()=>{})},onChange(){}} as unknown as AmphoreusRuntime
  const dreaming=new Dreaming(memory,runtime),job=(await dreaming.backfill(2,6,'backfill'))!
  const originalTasks=store.tasks.bind(store)
  store.tasks=(()=>[{task_id:'branch',kind:'continuation',state:'completed',origin:{event_id:job.data.event_id}}]) as never
  dreaming.reconcile();expect(memory.get(job.id)?.status).toBe('incomplete')
  expect(store.record('dreaming-cursor','role')).toBe(1)
  dreaming.resume(job.id);expect(controlTask).toHaveBeenCalledWith('branch','resume')
  const batch=dreaming.read(job.id) as any,main={branch:'main' as const,source:{run_id:'review'},call_id:'commit'}
  expect(batch.records).toHaveLength(4)
  dreaming.commit(job.id,batch.batch_id,[],'No facts',main)
  dreaming.finish(job.id,'Reviewed older history',main,true)
  expect(store.record('dreaming-cursor','role')).toBe(1)
  store.tasks=originalTasks
 }finally{host.close();rmSync(dir,{recursive:true,force:true})}
})
