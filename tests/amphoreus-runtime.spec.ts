import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import { AmphoreusStore } from '../src/amphoreus/store.ts'
import { AmphoreusRuntime, type AgentDriver, type MainContext, type ReportInput } from '../src/amphoreus/runtime.ts'
import type { SubagentTask } from '../src/amphoreus/model.ts'
import { normalizeEvent, isMemoryReview } from '../src/amphoreus/model.ts'
import { MemoryStore, MemorySettings } from '../src/amphoreus/memory.ts'
import { Dreaming } from '../src/amphoreus/dreaming.ts'

const dirs: string[] = []
afterEach(() => { dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })) })
const role = { agent_id: 'role', name: '翁法罗斯', persona: 'Persona' }
const limits = { maxWorkers: 3, mainTimeoutMs: 10000, taskTimeoutMs: 10000, progressIntervalMs: 60000 }
const open = (driver: AgentDriver, overrides: Partial<typeof limits> & {reviewTimeoutMs?:number;collaborationTimeoutMs?:number} = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'amphoreus-runtime-')); dirs.push(dir)
  const host = new Store(join(dir, 'test.sqlite'))
  const store = new AmphoreusStore(host)
  return { host, store, runtime: new AmphoreusRuntime(store, driver, role, {...limits,...overrides}), dir }
}
const tick = () => new Promise(resolve => setTimeout(resolve, 5))
const eventually = async (predicate: () => boolean) => { for (let n = 0; n < 100; n++) { if (predicate()) return; await tick() }; throw new Error('condition did not settle') }
const driver = (main: AgentDriver['main'], task: AgentDriver['task'] = async () => 'done'): AgentDriver => ({ main, task, messageTask: async () => {}, stop: async () => {} })

it('uses the current source by default and allows an explicit configured channel without changing the next default reply',async()=>{
  const destination={platform:'qq',account_id:'123',conversation_id:'private:456'}
  const {runtime,store,host}=open(driver(async context=>{
    if(context.event.platform!=='web')return
    await context.speak([{type:'text',text:'指定QQ渠道'}],'explicit',destination)
    await context.speak([{type:'text',text:'仍回网页'}],'default')
    await expect(context.speak([{type:'text',text:'非法目标'}],'denied',{...destination,conversation_id:'private:999'})).rejects.toThrow('not authorized')
  }))
  runtime.permitChannel=target=>target.platform===destination.platform&&target.account_id===destination.account_id&&target.conversation_id===destination.conversation_id
  runtime.gateway.registerOutput({platform:'qq',send:async()=>({status:'sent',receipt:{message_id:'qq-sent'}})})
  await runtime.start();await runtime.scheduler.idle()
  await runtime.receiveWeb('owner','chat',[{type:'text',text:'向QQ发消息，再原路回复'}],'route')
  await runtime.scheduler.idle()
  const outputs=store.outputs()
  expect(outputs.map(output=>output.platform).sort()).toEqual(['qq','web'])
  expect(outputs.find(output=>output.platform==='qq')?.target).toMatchObject({account_id:destination.account_id,conversation_id:destination.conversation_id})
  expect(outputs.find(output=>output.platform==='web')?.target.conversation_id).toBe('web:owner:chat')
  await runtime.stop();host.close()
})

it('quotes QQ replies only when the incoming message explicitly mentions this account', async () => {
  const { runtime, host } = open(driver(async context => {
    if (context.event.platform !== 'qq') return
    await context.speak([{ type: 'text', text: '参与一下' }, { type: 'quote', message_id: context.event.metadata.message_id }], 'reply',
      { platform: 'qq', account_id: '123', conversation_id: context.origin.conversation_id, reply_to: String(context.event.metadata.message_id) })
  }))
  const sent: any[] = []
  runtime.gateway.registerInput({ kind: 'napcat', platform: 'qq', normalize: raw => raw as any })
  runtime.gateway.registerOutput({ platform: 'qq', send: async input => { sent.push(input); return 'sent' } })
  await runtime.start(); await runtime.scheduler.idle()
  for (const [id, mentions] of [['plain', []], ['other', [{ type: 'mention', platform: 'qq', actor_id: '999' }]],
    ['at', [{ type: 'mention', platform: 'qq', actor_id: '123' }]]] as const) {
    await runtime.gateway.ingest('napcat', { agent_id: 'role', source_kind: 'napcat', platform: 'qq', account_id: '123', conversation_id: 'group:456',
      actor_id: '789', event_type: 'message', timestamp: new Date().toISOString(), correlation_id: null,
      content: [{ type: 'text', text: id }, ...mentions], metadata: { message_id: id }, visibility: 'public', idempotency_key: id })
    await runtime.scheduler.idle()
  }
  expect(sent.map(input => input.target.reply_to)).toEqual([undefined, undefined, 'at'])
  expect(sent.map(input => input.content.some((block: any) => block.type === 'quote'))).toEqual([false, false, true])
  await runtime.stop(); host.close()
})

it('steers an external message into a collaborating Main without cancelling it or opening a second Run', async () => {
  let active: MainContext | undefined, resume!: () => void, calls = 0
  const barrier = new Promise<void>(resolve => { resume = resolve })
  const implementation = driver(async (context, signal) => {
    if (context.event.source_kind === 'genesis') return
    calls++; active = context
    context.setCollaboration(true, '持续创作故事')
    await barrier; expect(signal.aborted).toBe(false)
    expect(context.collaboration().goal).toBe('持续创作故事')
    await context.speak([{ type: 'text', text: '继续原创作' }], 'creative', { platform: 'web', account_id: 'alice', conversation_id: 'web:alice:chat' })
  })
  implementation.steerMain = async (event, origin, runId) => {
    expect(runId).toBe(active!.runId); expect(origin.account_id).toBe('bob')
    active!.admit(event)
    await active!.speak([{ type: 'text', text: '已回复新消息' }], 'reply')
    resume(); return true
  }
  const { runtime, store, host } = open(implementation)
  await runtime.start(); await runtime.scheduler.idle()
  await runtime.receiveWeb('alice', 'chat', [{ type: 'text', text: '创作' }], 'creative')
  await eventually(() => !!active)
  const next = await runtime.receiveWeb('bob', 'chat', [{ type: 'text', text: '新的消息' }], 'steer')
  await runtime.scheduler.idle()
  expect(calls).toBe(1)
  expect(store.event(next.event.event_id)?.state).toBe('processed')
  expect(store.outputs().map(o => o.target.account_id).sort()).toEqual(['alice','bob'])
  expect(store.events({ sourceKind: 'output-gateway' }).find(row => row.event.account_id === 'bob')?.event.metadata.origin_event_id).toBe(next.event.event_id)
  await runtime.stop(); host.close()
})

it('continues one Fork after feedback, keeps both message directions in Gateway and releases idle branch slots', async () => {
  const contexts: MainContext[] = [], activations: SubagentTask[] = []
  let id = '', forks = 0
  const implementation = driver(async context => {
    contexts.push(context)
    if (context.event.content[0]?.text === 'start') id = context.delegate('构思故事', [], 0, 'fork', { kind: 'continuation' }).task_id
    if (context.event.content[0]?.text === 'continue') await context.messageTask(id, '采用第二个构思，继续完成', 'feedback')
  }, async (task, report, _signal, ready) => {
    activations.push(task); await ready?.()
    if (!(task.activation ?? 0)) { await report({ type: 'question', summary: '采用哪个构思？' }, 'question'); return '等待反馈' }
    expect(task.pending_messages?.[0]?.content).toBe('采用第二个构思，继续完成')
    await report({ type: 'completed', summary: '第二个构思已完成' }, 'completed'); return 'finished'
  })
  implementation.prepare = async task => task.fork ? task : (forks++, { ...task, subagent_id: 'native-fork', fork: { parent_agent_id: role.agent_id,
    parent_session_id: task.parent_session_id!, child_session_id: 'native-fork', fork_event_seq: 10, persona_version: 'persona', self_version: null,
    memory_view_at: task.created_at, created_at: task.created_at, handoff: { run_id: task.parent_run_id!, trigger: task.origin!, task: task.description, decisions: task.context } } })
  const { runtime, store, host } = open(implementation)
  await runtime.start(); await runtime.scheduler.idle()
  await runtime.receiveWeb('alice', 'chat', [{ type: 'text', text: 'start' }], 'fork-start')
  await eventually(() => !!id && store.task(id)?.state === 'waiting'); await runtime.scheduler.idle()
  expect(runtime.status().running_subagents).toBe(0)
  await runtime.receiveWeb('alice', 'chat', [{ type: 'text', text: 'continue' }], 'fork-feedback')
  await eventually(() => store.task(id)?.state === 'completed'); await runtime.scheduler.idle()
  expect(forks).toBe(1)
  expect(activations.map(task => task.subagent_id)).toEqual(['native-fork','native-fork'])
  expect(store.records<{ status: string }>('agent-message')[0]?.status).toBe('accepted')
  expect(store.events().find(row => row.event.event_type === 'agent.message')?.event.metadata.schedule).toBe(false)
  expect(contexts.some(c => c.event.event_type === 'agent.message')).toBe(false)
  expect(store.reports(id).map(report => report.activation).sort()).toEqual([0,1])
  await runtime.stop(); host.close()
})

it('reuses one non-forked topic Session across source conversations and releases idle worker slots',async()=>{
  const tasks:SubagentTask[]=[];let first='',second=''
  const implementation=driver(async context=>{
    const question=context.event.content[0]?.text
    if(question!=='first-topic'&&question!=='next-topic')return
    const task=context.delegate(String(question),[{type:'text',text:'bounded-topic-summary'}],0,'ask',{kind:'topic',topic_id:'canonical-topic'})
    if(question==='first-topic')first=task.task_id;else second=task.task_id
    await context.messageTask(task.task_id,String(question),`question:${question}`)
  },async(task,report,_signal,ready)=>{
    tasks.push(task);await ready?.();expect(task.fork).toBeUndefined();expect(task.topic_id).toBe('canonical-topic')
    await report({type:'completed',summary:'话题答复，来源 memory-1'},'answer');return 'answer'
  })
  const {runtime,store,host}=open(implementation)
  await runtime.start();await runtime.scheduler.idle()
  await runtime.receiveWeb('alice','chat',[{type:'text',text:'first-topic'}],'topic-1')
  await eventually(()=>!!first&&store.task(first)?.state==='completed');await runtime.scheduler.idle()
  expect(runtime.status().running_subagents).toBe(0)
  await runtime.receiveWeb('bob','other',[{type:'text',text:'next-topic'}],'topic-2')
  await eventually(()=>tasks.length>=2&&store.task(first)?.state==='completed');await runtime.scheduler.idle()
  expect(first).toBe(second);expect(new Set(tasks.map(t=>t.subagent_id)).size).toBe(1)
  expect(tasks[1]?.pending_messages?.some(m=>m.content==='next-topic')).toBe(true)
  expect(store.tasks().filter(t=>t.kind==='topic')).toHaveLength(1)
  await runtime.stop();host.close()
})

it('ends main after durable delegation; three workers report while new messages run serially', async () => {
  let active = 0, maximum = 0
  const contexts: MainContext[] = [], workers: SubagentTask[] = [], reports: ((input: ReportInput, id: string) => Promise<unknown>)[] = []
  let finish!: () => void
  const barrier = new Promise<void>(resolve => { finish = resolve })
  const { host, store, runtime } = open(driver(async context => {
    active++; maximum = Math.max(maximum, active); contexts.push(context)
    if (context.event.source_kind === 'web' && context.event.content[0]?.text === 'delegate') {
      for (let n = 0; n < 3; n++) expect(context.delegate(`work ${n}`, [], n, `call-${n}`).status).toBe('queued')
    }
    await tick(); active--
  }, async (task, report) => { workers.push(task); reports.push(report); await barrier; return 'finished' }))
  await runtime.start(); await runtime.scheduler.idle()
  await runtime.receiveWeb('alice', 'chat', [{ type: 'text', text: 'delegate' }], 'request1')
  await runtime.scheduler.idle(); await eventually(() => workers.length === 3)
  expect(runtime.status().current_run).toBeNull()
  expect(runtime.status().running_subagents).toBe(3)
  await runtime.receiveWeb('alice', 'chat', [{ type: 'text', text: 'new message' }], 'request2')
  await reports[0]!({ type: 'discovery', summary: 'Found something' }, 'midway')
  await runtime.scheduler.idle()
  expect(contexts.some(c => c.event.event_type === 'task.discovery')).toBe(true)
  expect(contexts.some(c => c.event.content[0]?.text === 'new message')).toBe(true)
  expect(store.reports(workers[0]!.task_id)).toHaveLength(1)
  expect(maximum).toBe(1)
  expect(new Set(contexts.map(context => context.sessionId)).size).toBe(1)
  finish(); await eventually(() => runtime.status().running_subagents === 0)
  await runtime.scheduler.idle()
  expect(store.tasks().every(task => task.state === 'completed')).toBe(true)
  await runtime.stop(); host.close()
})

it('seeds the unified Session with legacy source history once, retaining only confirmed spoken outputs', async () => {
  const contexts: MainContext[] = []
  const { runtime, store, host } = open(driver(async context => { contexts.push(context) }))
  const base = { agent_id: role.agent_id, source_kind: 'web', platform: 'web', account_id: 'alice', conversation_id: 'web:alice:old',
    actor_id: 'alice', event_type: 'message', timestamp: new Date().toISOString(), correlation_id: null, visibility: 'private' as const }
  for (const [platform, text] of [['web', '旧网页消息'], ['qq', '旧QQ消息']]) {
    const event = normalizeEvent({ ...base, platform: platform!, content: [{ type: 'text', text }], metadata: {}, idempotency_key: text! })
    store.insertEvent(event); store.setEventState(event.event_id, 'processed')
  }
  await runtime.gateway.speak({ agentId: role.agent_id, runId: 'legacy', callId: 'sent', target: { platform: 'web', account_id: 'alice', conversation_id: base.conversation_id }, content: [{ type: 'text', text: '以前已说出口' }] }, () => true)
  await runtime.gateway.speak({ agentId: role.agent_id, runId: 'legacy', callId: 'pending', target: { platform: 'qq', account_id: 'bot', conversation_id: 'group:1' }, content: [{ type: 'text', text: '未确认发出的内容' }] }, () => true)
  await runtime.start(); await runtime.scheduler.idle()
  expect(contexts[0]?.history).toContain('旧网页消息')
  expect(contexts[0]?.history).toContain('旧QQ消息')
  expect(contexts[0]?.history).toContain('已通过 speak 发出：')
  expect(contexts[0]?.history).not.toContain('未确认发出的内容')
  await runtime.receiveWeb('alice', 'chat', [{ type: 'text', text: '新的消息' }], 'new-shared')
  await runtime.scheduler.idle()
  expect(contexts.at(-1)?.history).toBeUndefined()
  expect(new Set(contexts.map(context => context.sessionId)).size).toBe(1)
  await runtime.stop(); host.close()
})

it('shares one Main Session while keeping explicit output targets authorized and allowing silence', async () => {
  const contexts: MainContext[] = []
  const { runtime, host, store } = open(driver(async context => {
    contexts.push(context)
    if (context.event.content[0]?.text === 'say') {
      await context.speak([{ type: 'text', text: 'said' }], 'one')
      await context.speak([{ type: 'text', text: 'said twice' }], 'two')
      await context.speak([{ type: 'text', text: 'duplicate' }], 'two')
      await expect(context.speak([{ type: 'text', text: 'private' }], 'wrong',
        { platform: 'web', account_id: 'bob', conversation_id: 'web:bob:chat' })).rejects.toThrow('not authorized')
    }
  }))
  await runtime.start(); await runtime.scheduler.idle()
  await runtime.receiveWeb('alice', 'chat', [{ type: 'text', text: 'say' }], 'say')
  await runtime.receiveWeb('bob', 'chat', [{ type: 'text', text: 'silent' }], 'silent')
  await runtime.scheduler.idle()
  expect(store.outputs()).toHaveLength(2)
  expect(store.outputs().every(o => o.status === 'sent')).toBe(true)
  const alice = contexts.find(c => c.event.account_id === 'alice')!, bob = contexts.find(c => c.event.account_id === 'bob')!
  expect(alice.sessionId).toBe(bob.sessionId)
  expect(new Set(contexts.map(context => context.sessionId)).size).toBe(1)
  await runtime.stop(); host.close()
})

it('keeps greeting, reports, queues and interrupted tasks safe across restart', async () => {
  const first = open(driver(async () => {}))
  await first.runtime.start(); await first.runtime.scheduler.idle()
  const event = first.store.events().find(row => row.event.event_type === 'genesis.greeting')!.event
  first.store.enqueueTask({ task_id: 'interrupted', agent_id: role.agent_id, subagent_id: 'worker', description: 'task', context: [], priority: 0,
    state: 'running', created_at: event.timestamp, updated_at: event.timestamp })
  await first.runtime.stop(); first.host.close()
  const host = new Store(join(first.dir, 'test.sqlite')), store = new AmphoreusStore(host)
  const runtime = new AmphoreusRuntime(store, driver(async () => {}), role, limits)
  await runtime.start(); await runtime.scheduler.idle()
  expect(store.events().filter(row => row.event.event_type === 'genesis.greeting')).toHaveLength(1)
  expect(store.task('interrupted')?.state).toBe('failed')
  expect(store.reports('interrupted')[0]?.type).toBe('failed')
  await runtime.stop(); host.close()
})

it('persists all ordinary reports but limits wakeups; important reports bypass throttling and deduplicate', async () => {
  const { runtime, host, store } = open(driver(async () => {}))
  await runtime.start(); await runtime.scheduler.idle()
  const origin = (await runtime.receiveWeb('alice', 'chat', [{ type: 'text', text: 'hello' }], 'hello')).event
  await runtime.scheduler.idle()
  const task: SubagentTask = { task_id: 'task', agent_id: role.agent_id, subagent_id: 'worker', description: 'task', context: [], priority: 0,
    state: 'running', created_at: origin.timestamp, updated_at: origin.timestamp, origin }
  store.enqueueTask(task)
  await runtime.report(task, { type: 'progress', summary: 'one' }, '1')
  await runtime.report(task, { type: 'progress', summary: 'two' }, '2')
  await runtime.report(task, { type: 'question', summary: 'important' }, '3')
  await runtime.report(task, { type: 'question', summary: 'duplicate' }, '3')
  await runtime.scheduler.idle()
  expect(store.reports('task')).toHaveLength(3)
  expect(store.runs().filter(run => store.event(run.event_id)?.event.source_kind === 'internal')).toHaveLength(2)
  await runtime.stop(); host.close()
})

it('uses the latest terminal report and limits progress from the last scheduled wake', async () => {
  const { runtime, host, store } = open(driver(async context => {
    if (context.event.source_kind === 'web') context.delegate('work', [], 0, 'task')
  }, async (_task, report) => {
    await report({ type: 'completed', summary: 'early result' }, 'early')
    await report({ type: 'failed', summary: 'late failure' }, 'late')
    return 'end'
  }))
  await runtime.start(); await runtime.scheduler.idle()
  await runtime.receiveWeb('alice', 'chat', [{ type: 'text', text: 'start' }], 'start')
  await eventually(() => store.tasks().length === 1 && store.tasks()[0]?.state === 'failed')
  await runtime.scheduler.idle()
  const task = store.tasks()[0]!
  expect(task.error).toBe('late failure')
  const before = store.runs().length
  const base = Date.now(), clock = vi.spyOn(Date, 'now').mockReturnValue(base)
  try {
    await runtime.report(task, { type: 'progress', summary: 'initial wake' }, 'progress-1')
    clock.mockReturnValue(base + 30000)
    await runtime.report(task, { type: 'progress', summary: 'retained without a wake' }, 'progress-2')
    clock.mockReturnValue(base + 61000)
    await runtime.report(task, { type: 'progress', summary: 'periodic update despite frequent reports' }, 'progress-3')
    await runtime.scheduler.idle()
    expect(store.runs()).toHaveLength(before + 2)
  } finally { clock.mockRestore() }
  expect(store.reports(task.task_id, 2, 2)).toHaveLength(2)
  await runtime.stop(); host.close()
})

it('retains interrupted running work until startup publishes a reliable failure report', async () => {
  let started = false
  const first = open(driver(async context => { if (context.event.source_kind === 'web') context.delegate('interrupt me', [], 0, 'delegate') },
    async (_task, _report, signal) => { started = true; await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); return '' }))
  await first.runtime.start(); await first.runtime.scheduler.idle()
  await first.runtime.receiveWeb('alice', 'chat', [{ type: 'text', text: 'start' }], 'interruption')
  await eventually(() => started)
  await first.runtime.stop()
  expect(first.store.tasks()[0]?.state).toBe('running')
  first.host.close()
  const host = new Store(join(first.dir, 'test.sqlite')), store = new AmphoreusStore(host)
  const runtime = new AmphoreusRuntime(store, driver(async () => {}), role, limits)
  await runtime.start(); await runtime.scheduler.idle()
  expect(store.tasks()[0]?.state).toBe('failed')
  expect(store.reports()[0]?.type).toBe('failed')
  expect(store.events({ sourceKind: 'internal' })[0]?.state).toBe('processed')
  await runtime.stop(); host.close()
})

it('continues interrupted Main once in the same Session without replaying the original event or an already sent output', async () => {
  const first = open(driver(async () => {}))
  await first.runtime.start(); await first.runtime.scheduler.idle()
  const session=first.store.runs()[0]!.session_id
  first.runtime.scheduler.stop()
  const event = (await first.runtime.receiveWeb('alice', 'chat', [{ type: 'text', text: 'hello' }], 'interrupted-main')).event
  first.store.claimEvent(role.agent_id)
  const oldRun=`run-${event.event_id}`
  first.store.startRun({ run_id: oldRun, agent_id: role.agent_id, event_id: event.event_id, session_id: session, state: 'running', started_at: new Date().toISOString() })
  await first.runtime.gateway.speak({agentId:role.agent_id,runId:oldRun,callId:'already-sent',sourceEventId:event.event_id,content:[{type:'text',text:'already sent'}],target:event},()=>true)
  await first.runtime.stop(); first.host.close()
  const host = new Store(join(first.dir, 'test.sqlite')), store = new AmphoreusStore(host), delivered: MainContext[] = []
  const runtime = new AmphoreusRuntime(store, driver(async context => { delivered.push(context) }), role, limits)
  await runtime.start(); await runtime.scheduler.idle()
  expect(store.event(event.event_id)?.state).toBe('failed')
  expect(delivered).toHaveLength(1)
  expect(delivered[0]).toMatchObject({event:{event_type:'main.resume'},origin:{event_id:event.event_id},sessionId:session,resume:{event:{event_id:event.event_id},deliveryId:oldRun}})
  expect(store.outputs().filter(output=>output.status==='sent')).toHaveLength(1)
  expect(store.run(oldRun)?.state).toBe('interrupted')
  await runtime.stop();host.close()
  const reopened=new Store(join(first.dir,'test.sqlite')),again=new AmphoreusStore(reopened)
  const next=new AmphoreusRuntime(again,driver(async context=>{delivered.push(context)}),role,limits)
  await next.start();await next.scheduler.idle();expect(delivered).toHaveLength(1)
  await next.stop();reopened.close()
})
it('resumes a graceful shutdown from the most recently admitted source and respects disabled recovery',async()=>{
 const first=open(driver(async(context,signal)=>{if(context.event.platform!=='web')return;context.admit(context.event);await new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}))}))
 await first.runtime.start();await first.runtime.scheduler.idle()
 const event=(await first.runtime.receiveWeb('bob','chat',[{type:'text',text:'continue later'}],'graceful')).event
 await eventually(()=>first.runtime.status().current_run!==null);await first.runtime.stop();first.host.close()
 const host=new Store(join(first.dir,'test.sqlite')),store=new AmphoreusStore(host),contexts:MainContext[]=[]
 const runtime=new AmphoreusRuntime(store,driver(async context=>{contexts.push(context)}),role,limits)
 await runtime.start();await runtime.scheduler.idle();expect(contexts[0]?.origin.event_id).toBe(event.event_id)
 await runtime.stop();host.close()
 const paused=open(driver(async()=>{}));await paused.runtime.start();await paused.runtime.scheduler.idle();paused.runtime.scheduler.stop()
 const pending=(await paused.runtime.receiveWeb('alice','chat',[{type:'text',text:'no restart'}],'disabled')).event
 paused.store.claimEvent(role.agent_id);paused.store.startRun({run_id:'interrupted',agent_id:role.agent_id,event_id:pending.event_id,session_id:'main',state:'running',started_at:pending.timestamp})
 paused.store.setRecord('runtime-settings',role.agent_id,{resumeOnRestart:false});await paused.runtime.stop();paused.host.close()
 const disabledHost=new Store(join(paused.dir,'test.sqlite')),disabledStore=new AmphoreusStore(disabledHost),main=vi.fn(async()=>{})
 const disabled=new AmphoreusRuntime(disabledStore,driver(main),role,limits);await disabled.start();await disabled.scheduler.idle();expect(main).not.toHaveBeenCalled()
 await disabled.stop();disabledHost.close()
})


it('bounds internal nightly dispatch and report review separately while ordinary messages retain their deadline',async()=>{
 const seen:string[]=[],f=open(driver(async(context,signal)=>{
  if(context.event.source_kind==='genesis')return
  seen.push(context.event.event_id)
  await new Promise<void>((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))
 }),{mainTimeoutMs:1000,reviewTimeoutMs:3000})
 await f.runtime.start();await f.runtime.scheduler.idle();vi.useFakeTimers()
 try{
  for(const type of ['memory.review','task.completed']){
   const {event}=await f.runtime.gateway.ingest('internal',{agent_id:'role',source_kind:'internal',platform:'internal',account_id:'role',conversation_id:'memory-review',actor_id:'scheduler',event_type:type,timestamp:new Date().toISOString(),correlation_id:null,content:[{type:'text',text:'内部回顾'}],metadata:{},visibility:'internal',idempotency_key:type})
   await vi.advanceTimersByTimeAsync(0);expect(seen).toContain(event.event_id)
   await vi.advanceTimersByTimeAsync(1001);expect(f.store.event(event.event_id)?.state).toBe('processing')
   await vi.advanceTimersByTimeAsync(2000);await f.runtime.scheduler.idle();expect(f.store.event(event.event_id)).toMatchObject({state:'failed',error:'Main Run time budget exceeded'})
  }
  const {event}=await f.runtime.receiveWeb('owner','memory-review',[{type:'text',text:'不应延长普通消息'}],'ordinary')
  expect(isMemoryReview({...event,conversation_id:'memory-review'})).toBe(false)
  await vi.advanceTimersByTimeAsync(1001);await f.runtime.scheduler.idle();expect(f.store.event(event.event_id)?.state).toBe('failed')
 }finally{vi.useRealTimers();await f.runtime.stop();f.host.close()}
})

it.each(['ordinary', 'review', 'collaboration'] as const)('leaves %s Main without a deadline while role controls can still stop it', async mode => {
  let active: AbortSignal | undefined
  const f = open(driver(async (context, signal) => {
    if (context.event.source_kind === 'genesis') return
    active = signal
    if (mode === 'collaboration') context.setCollaboration(true, 'ongoing')
    await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  }), { mainTimeoutMs: 0 })
  await f.runtime.start(); await f.runtime.scheduler.idle(); vi.useFakeTimers()
  try {
    const { event } = mode === 'review'
      ? await f.runtime.gateway.ingest('internal', { agent_id: 'role', source_kind: 'internal', platform: 'internal', account_id: 'role', conversation_id: 'memory-review', actor_id: 'scheduler', event_type: 'task.completed', timestamp: new Date().toISOString(), correlation_id: null, content: [{ type: 'text', text: 'review' }], metadata: {}, visibility: 'internal', idempotency_key: 'unlimited-review' })
      : await f.runtime.receiveWeb('owner', 'chat', [{ type: 'text', text: 'continue' }], 'unlimited-main')
    await vi.advanceTimersByTimeAsync(3600000)
    expect(active).toBeDefined(); expect(active!.aborted).toBe(false)
    expect(f.store.event(event.event_id)?.state).toBe('processing')
    f.runtime.controls.configure({ enabled: false })
    await f.runtime.scheduler.idle()
    expect(active!.aborted).toBe(true)
    expect(f.store.runs().find(run => run.event_id === event.event_id)?.state).toBe('interrupted')
  } finally { vi.useRealTimers(); await f.runtime.stop(); f.host.close() }
})


it('starts one nightly continuation without a Main wake, suppresses progress and wakes Main only for the final draft report',async()=>{
 const mains:string[]=[],tasks:SubagentTask[]=[];let done!:()=>void
 const f=open(driver(async context=>{mains.push(context.event.event_type)},async(task,report)=>{
  tasks.push(task);await report({type:'progress',summary:'整理中'},'page');await new Promise<void>(resolve=>{done=resolve});await report({type:'completed',summary:'草稿已完成'},'done');return 'done'
 }))
 const memory=new MemoryStore(f.host,'role',MemorySettings.parse({})),dreaming=new Dreaming(memory,f.runtime)
 try{
  await f.runtime.start();await f.runtime.scheduler.idle();mains.length=0
  memory.put({kind:'input',title:'今天的经历',text:'一段真实经历',source:{branch:'main'},created_at:memory.now()})
  const job=(await dreaming.schedule(true,'nightly'))!
  await eventually(()=>tasks.length===1&&!!done);await f.runtime.scheduler.idle()
  expect(tasks[0]).toMatchObject({kind:'continuation',origin:{event_id:job.data.event_id},parent_session_id:expect.stringMatching(/^amphoreus-main-/)})
  expect(tasks[0]!.description).toContain('job_id='+job.id)
  expect(mains).toEqual([]);expect(f.runtime.status().current_run).toBeNull()
  expect(f.store.event(String(job.data.event_id))?.state).toBe('processed')
  await dreaming.schedule(true,'nightly');expect(f.store.tasks({agentId:'role'})).toHaveLength(1)
  done();await eventually(()=>f.store.task(tasks[0]!.task_id)?.state==='completed');await f.runtime.scheduler.idle()
  expect(mains).toEqual(['task.completed']);dreaming.reconcile();expect(memory.get(job.id)?.status).toBe('awaiting_review')
  dreaming.finish(job.id,'今天不强制写日记',{branch:'main',source:{run_id:'review'},call_id:'finish'},true)
  await dreaming.schedule(true,'nightly');expect(f.store.tasks({agentId:'role'})).toHaveLength(1)
 }finally{done?.();await f.runtime.stop();f.host.close()}
})
