import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { agentEvents, installModelSelection, type Agent, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import {DshAgentDriver} from '../src/amphoreus/dsh.ts'
import {createUserMessage} from '@deepseek-ai/dsh-llm'
import { Store } from '../src/app/store.ts'
import { AmphoreusStore } from '../src/amphoreus/store.ts'
import { installRoleRouting, ModelSettings } from '../src/amphoreus/models.ts'
import type { SubagentTask } from '../src/amphoreus/model.ts'

const stops: (() => Promise<void>)[] = []
afterEach(async () => { for (const stop of stops.splice(0)) await stop() })
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'amphoreus-models-')), host = new Store(join(dir, 'state.sqlite')), store = new AmphoreusStore(host)
  const ctx = new Context(); await ctx.plugin(SystemPrompt)
  const globalDefault = { provider: 'host', model: 'default' }, saveSelection = vi.fn()
  ctx.reflect.provide('agentDefaultModel', { currentSelection: () => globalDefault, saveSelection })
  const resolve = vi.fn(async (selection: any) => {
    if (selection.model === 'bad' || selection.reasoningEffort === 'bad') throw new Error('secret-token-in-provider-error')
    return selection
  })
  ctx.reflect.provide('llm', { listProviders: () => [{ id: 'host' }, { id: 'api' }], resolveCallConfig: resolve })
  ctx.reflect.provide('sessionController', { modelCatalog: async () => ({ default: globalDefault, groups: [], failures: [{ id: 'bad', name: 'Bad', message: 'secret-token-in-provider-error' }] }) })
  const settings = new ModelSettings(ctx, store, 'role', { main: { provider: 'api', model: 'main-old' }, worker: null })
  stops.push(async () => { await settings.stop(); await ctx.fiber.dispose(); host.close(); rmSync(dir, { recursive: true }) })
  const task = (id: string, kind: SubagentTask['kind'], role = 'role') => store.enqueueTask({ task_id: id, kind, agent_id: role, subagent_id: `session-${id}`, state: 'queued', description: 'task', context: [], priority: 0, created_at: new Date().toISOString(), updated_at: new Date().toISOString() })
  return { ctx, store, settings, resolve, saveSelection, task }
}

it('persists independent defaults and task overrides, validates scope, and resets to inheritance', async () => {
  const { ctx, store, settings, task, saveSelection } = await setup()
  task('branch', 'continuation'); task('tool', 'worker'); task('other', 'worker', 'other-role')
  expect(await settings.resolve('continuation', 'branch')).toMatchObject({ model: 'main-old' })
  expect(await settings.resolve('worker', 'tool')).toMatchObject({ model: 'default' })
  await settings.configure({ scope: 'main', selection: { provider: 'api', model: 'new-main' } })
  await settings.configure({ scope: 'worker', selection: { provider: 'api', model: 'coding' } })
  await settings.configure({ scope: 'continuation', selection: { provider: 'api', model: 'dream' } })
  await settings.configure({ scope: 'continuation', task_id: 'branch', selection: { provider: 'api', model: 'one-task' } })
  expect(await settings.resolve('continuation', 'branch')).toMatchObject({ model: 'one-task' })
  await settings.configure({ scope: 'continuation', task_id: 'branch', selection: null })
  expect(await settings.resolve('continuation', 'branch')).toMatchObject({ model: 'dream' })
  await settings.configure({ scope: 'continuation', selection: null })
  expect(await settings.resolve('continuation', 'branch')).toMatchObject({ model: 'new-main' })
  expect(await settings.resolve('topic')).toMatchObject({ model: 'new-main' })
  await settings.configure({ scope: 'main', selection: null })
  expect(await settings.resolve('main')).toMatchObject({ model: 'default' })
  expect(await new ModelSettings(ctx, store, 'role', { main: { provider: 'api', model: 'main-old' }, worker: null }).resolve('main')).toMatchObject({ model: 'default' })
  expect(await settings.resolve('worker', 'tool')).toMatchObject({ model: 'coding' })
  await expect(settings.configure({ scope: 'main', task_id: 'branch', selection: null })).rejects.toThrow('作用域')
  await expect(settings.configure({ scope: 'worker', task_id: 'other', selection: null })).rejects.toThrow('作用域')
  await expect(settings.configure({ scope: 'worker', selection: { provider: 'missing', model: 'x' } })).rejects.toThrow('提供方')
  await expect(settings.configure({ scope: 'worker', selection: { provider: 'api', model: 'bad' } })).rejects.toThrow('模型')
  expect(await settings.resolve('worker')).toMatchObject({ model: 'coding' })
  expect(JSON.stringify(await settings.catalog())).not.toContain('secret-token')
  expect(saveSelection).not.toHaveBeenCalled()
})

it('publishes each model-selection event exactly once for a real attached session',async()=>{
  const {ctx,settings}=await setup()
  await ctx.plugin(SessionStore)
  const session=ctx.sessions.create(SessionId('attached-routing'),{meta:{cwd:'/tmp/attached-routing'}})
  const published:number[]=[]
  const off=ctx.on('session/event',(observed,event)=>{if(observed===session)published.push(Number(event.seq))})
  const dispose=installRoleRouting(ctx,{ctx,session} as Agent,settings,'main')
  try{
    await ctx.systemPrompt.assemble()
    await settings.configure({scope:'main',selection:{provider:'api',model:'switched'}})
    await ctx.systemPrompt.assemble()
    const selections=session.snapshotEvents().filter(event=>event.type==='model/selection')
    expect(selections).toHaveLength(2)
    expect(published).toEqual(selections.map(event=>Number(event.seq)))
    await ctx.systemPrompt.assemble()
    expect(published).toHaveLength(2)
  }finally{dispose();off()}
})

it('changes a resumed or forked session on the next assembled step, keeps retries stable and never changes global defaults', async () => {
  const { ctx, settings, saveSelection, task } = await setup()
  task('branch', 'continuation')
  const session = Session.create(SessionId('existing-branch'))
  session.append('model/selection', { provider: 'parent', model: 'inherited-parent' })
  session.append('request/header', { header: { config: { provider: 'parent', model: 'old-header' } }, reason: 'initial' } as never)
  const agent = { ctx, session } as Agent
  const native: ModelSelectionRef = { current: { provider: 'parent', model: 'inherited-parent' }, assembled: undefined }
  const disposeNative = installModelSelection(ctx, native)
  const dispose = installRoleRouting(ctx, agent, settings, 'continuation', 'branch')
  const request = () => agentEvents(ctx, agent).waterfall('agent/request', { turn: 1, step: 1, signal: new AbortController().signal }, async () => ({ provider: 'seed', model: 'seed', reasoningEffort: 'high' } as never))
  try {
    expect((await ctx.systemPrompt.assemble()).variables).toMatchObject({ model: 'main-old' })
    expect(await request()).toEqual({ provider: 'api', model: 'main-old' })
    await settings.configure({ scope: 'continuation', selection: { provider: 'api', model: 'dream-new' } })
    expect(await request()).toEqual({ provider: 'api', model: 'main-old' })
    expect((await ctx.systemPrompt.assemble()).variables).toMatchObject({ model: 'dream-new' })
    expect(await request()).toEqual({ provider: 'api', model: 'dream-new' })
    expect(session.snapshotEvents().filter(event => event.type === 'model/selection').at(-1)?.data).toMatchObject({ model: 'dream-new' })
    expect(saveSelection).not.toHaveBeenCalled()
    expect(session.requestHeader()?.config.model).toBe('old-header')
  } finally { dispose(); disposeNative() }
})

const probeChunks=async function*(_options:unknown){
 yield{type:'block-start',blockType:'text',index:0}
 yield{type:'block-end',index:0,block:{type:'text',text:'OK'}}
 yield{type:'finish',finish:{kind:'stop'}}
}
it('probes a short isolated API call before committing a role or task route and preserves the global default',async()=>{
 const {ctx,settings,task,saveSelection}=await setup(),stream=vi.fn(probeChunks),settled=vi.fn()
 Object.assign(ctx.llm,{stream});settings.onProbe=settled
 task('worker-task','worker')
 for(const input of [{scope:'main' as const,selection:{provider:'api',model:'tested',reasoningEffort:'high'}},{scope:'worker' as const,task_id:'worker-task',selection:{provider:'api',model:'coding'}}])
  expect(await settings.configureTested(input)).toEqual({status:'updated'})
 const request=stream.mock.calls[0]![0] as any
 expect(request).toMatchObject({provider:'api',model:'tested',reasoningEffort:'high',maxTokens:64,messages:[{role:'user',content:[{type:'text',text:'Reply OK.'}]}]})
 expect(request.tools).toBeUndefined();expect(request.messages).toHaveLength(1)
 expect(await settings.resolve('main')).toMatchObject({model:'tested'})
 expect(await settings.resolve('worker','worker-task')).toMatchObject({model:'coding'})
 expect(settled).toHaveBeenCalledTimes(2);expect(settled.mock.calls[0]?.[3]).toBe(true)
 expect(saveSelection).not.toHaveBeenCalled()
})
it('returns rolled back on validation, transport, empty or failed completion without creating or overwriting an override',async()=>{
 const {ctx,settings,store}=await setup(),stream=vi.fn(probeChunks);Object.assign(ctx.llm,{stream})
 expect((await settings.configureTested({scope:'main',selection:{provider:'api',model:'bad'}})).status).toBe('rolled_back')
 expect(stream).not.toHaveBeenCalled()
 expect(settings.configured('main')).toMatchObject({model:'main-old'})
 expect(store.record('model-route',JSON.stringify(['role','main',null]))).toBeUndefined()
 await settings.configure({scope:'worker',selection:null})
 for(const impl of [async function*(){throw Error('secret-token-in-provider-error');yield{}},async function*(){yield{type:'finish',finish:{kind:'stop'}}},async function*(){yield{type:'finish',finish:{kind:'error',error:'private-key'}}}]){
  stream.mockImplementationOnce(impl as never)
  const result=await settings.configureTested({scope:'worker',selection:{provider:'api',model:'broken-api'}})
  expect(result).toMatchObject({status:'rolled_back',message:expect.stringContaining('已回退')})
  expect(JSON.stringify(result)).not.toMatch(/secret-token|private-key/)
  expect(store.record('model-route',JSON.stringify(['role','worker',null]))).toEqual({selection:null})
 }
})
it('tests the effective inherited route when resetting a task override',async()=>{
 const {ctx,settings,task}=await setup(),stream=vi.fn(probeChunks);Object.assign(ctx.llm,{stream})
 task('branch','continuation')
 await settings.configure({scope:'continuation',task_id:'branch',selection:{provider:'api',model:'task-old'}})
 expect(await settings.configureTested({scope:'continuation',task_id:'branch',selection:null})).toEqual({status:'updated'})
 expect(stream.mock.calls[0]?.[0]).toMatchObject({model:'main-old'})
 expect(settings.configured('continuation','branch')).toBeNull()
})
it('times out an unavailable API without replacing the active route and does not overwrite a newer administrator choice',async()=>{
 const {ctx,settings}=await setup(),controller=new AbortController()
 const timeout=vi.spyOn(AbortSignal,'timeout').mockReturnValue(controller.signal)
 let entered!:()=>void;const ready=new Promise<void>(resolve=>{entered=resolve})
 Object.assign(ctx.llm,{stream:async function*(options:any){entered();await new Promise<void>((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));yield{type:'finish',finish:{kind:'stop'}}}})
 try{
  const pending=settings.configureTested({scope:'main',selection:{provider:'api',model:'unavailable'}})
  await ready;expect(settings.configured('main')).toMatchObject({model:'main-old'})
  controller.abort(Error('timeout'));expect(await pending).toMatchObject({status:'rolled_back',message:expect.stringContaining('已回退')})
  expect(timeout).toHaveBeenCalledWith(30000)
 }finally{timeout.mockRestore()}
 let finish!:()=>void;const released=new Promise<void>(resolve=>{finish=resolve});let started!:()=>void;const probeStarted=new Promise<void>(resolve=>{started=resolve})
 Object.assign(ctx.llm,{stream:async function*(options:unknown){started();await released;yield*probeChunks(options)}})
 const pending=settings.configureTested({scope:'main',selection:{provider:'api',model:'agent-proposal'}})
 await probeStarted;await settings.configure({scope:'main',selection:{provider:'api',model:'admin-new'}});finish()
 expect(await pending).toMatchObject({status:'rolled_back'})
 expect(settings.configured('main')).toMatchObject({model:'admin-new'})
})

it('tests an explicit route without requiring an initialized global default model',async()=>{
 const {ctx,settings}=await setup(),stream=vi.fn(probeChunks);Object.assign(ctx.llm,{stream})
 const readDefault=vi.fn(()=>{throw Error('No global selection')})
 Object.assign(ctx.get('agentDefaultModel') as object,{currentSelection:readDefault})
 expect(await settings.configureTested({scope:'main',selection:{provider:'api',model:'standalone'}})).toEqual({status:'updated'})
 expect(readDefault).not.toHaveBeenCalled();expect(stream).toHaveBeenCalledOnce()
})

it.each(['console','agent-success','agent-failed'] as const)('preserves an in-flight stream and Session history while switching through %s',async mode=>{
 const {ctx,settings,saveSelection}=await setup()
 const session=Session.create(SessionId(`stream-switch-${mode}`)),controller=new AbortController()
 const cancel=vi.fn(()=>controller.abort(Error('unexpected cancellation'))),agent={ctx,session,cancel} as unknown as Agent
 session.append('user/message',createUserMessage({content:[{type:'text',text:'Continue this conversation.'}],source:{kind:'user'}}),{surfaceOp:'append'})
 const native:ModelSelectionRef={current:{provider:'api',model:'main-old'},assembled:undefined}
 const offNative=installModelSelection(ctx,native),offRoute=installRoleRouting(ctx,agent,settings,'main')
 let unblock!:()=>void,entered!:()=>void
 const gate=new Promise<void>(resolve=>{unblock=resolve}),started=new Promise<void>(resolve=>{entered=resolve})
 const fragments:string[]=[],received:unknown[]=[]
 Object.assign(ctx.llm,{stream:async function*(options:any){
  received.push(options)
  if(options.messages[0]?.content[0]?.text==='Reply OK.'){
   if(mode==='agent-failed')throw Error('API unavailable')
   yield*probeChunks(options);return
  }
  yield{type:'block-end',index:0,block:{type:'text',text:'first '}};entered();await gate
  options.signal.throwIfAborted()
  yield{type:'block-end',index:1,block:{type:'text',text:'finished'}}
 }})
 const request=()=>agentEvents(ctx,agent).waterfall('agent/request',{turn:1,step:1,signal:controller.signal},async()=>({provider:'seed',model:'seed'} as never))
 let streaming:Promise<void>|undefined
 try{
  await ctx.systemPrompt.assemble()
  const oldRequest=await request(),before=session.snapshotEvents().map(event=>JSON.stringify(event))
  streaming=(async()=>{for await(const chunk of ctx.llm.stream({...oldRequest,signal:controller.signal,messages:[createUserMessage({content:[{type:'text',text:'Continue this conversation.'}],source:{kind:'user'}})]}))if(chunk.type==='block-end'&&chunk.block.type==='text')fragments.push(chunk.block.text)})()
  await started
  const input={scope:'main' as const,selection:{provider:'api',model:'new-model'}}
  if(mode==='console')await settings.configure(input)
  else expect((await settings.configureTested(input)).status).toBe(mode==='agent-success'?'updated':'rolled_back')
  expect(controller.signal.aborted).toBe(false);expect(cancel).not.toHaveBeenCalled()
  expect(session.snapshotEvents().map(event=>JSON.stringify(event))).toEqual(before)
  expect((await request()).model).toBe('main-old')
  unblock();await streaming
  expect(fragments.join('')).toBe('first finished')
  expect((received[0] as any).model).toBe('main-old')
  await ctx.systemPrompt.assemble()
  expect((await request()).model).toBe(mode==='agent-failed'?'main-old':'new-model')
  expect(session.id).toBe(`stream-switch-${mode}`)
  expect(session.snapshotEvents().find(event=>event.type==='user/message')?.data.content).toEqual([{type:'text',text:'Continue this conversation.'}])
  expect(saveSelection).not.toHaveBeenCalled()
 }finally{unblock();await streaming?.catch(()=>{});offRoute();offNative()}
})

it('reserves immediately, tests outside the caller, and delivers durable results only to the next relevant activation',async()=>{
 const {ctx,settings,task}=await setup();task('target','worker')
 let release!:()=>void,entered!:()=>void
 const gate=new Promise<void>(resolve=>{release=resolve}),started=new Promise<void>(resolve=>{entered=resolve})
 const stream=vi.fn(async function*(options:unknown){entered();await gate;yield*probeChunks(options)});Object.assign(ctx.llm,{stream})
 const input={scope:'worker' as const,task_id:'target',selection:{provider:'api',model:'new-worker'}}
 expect(settings.reserve(input,'same-call')).toEqual({status:'reserved',message:'已预订'})
 expect(stream).not.toHaveBeenCalled()
 const work=settings.idle();await started
 expect(settings.configured('worker','target')).toBeNull();expect(settings.notices('main')).toEqual([])
 release();await work
 expect(settings.configured('worker','target')).toMatchObject({model:'new-worker'})
 const notices=settings.notices('main');expect(notices).toHaveLength(1);expect(notices[0]?.text).toContain('成功')
 expect(settings.notices('worker','target')).toHaveLength(1);expect(settings.notices('worker','unrelated')).toEqual([])
 settings.acknowledge(notices[0]!.id,notices[0]!.recipient);expect(settings.notices('main')).toEqual([])
 settings.reserve(input,'same-call');await settings.idle();expect(stream).toHaveBeenCalledOnce()
 expect(settings.notices('worker','target')).toHaveLength(1)
})
it('reports failed background probes later and preserves the previous route',async()=>{
 const {ctx,settings}=await setup();Object.assign(ctx.llm,{stream:async function*(){throw Error('private-provider-error');yield{}}})
 expect(settings.reserve({scope:'main',selection:{provider:'api',model:'bad-api'}},'fail').message).toBe('已预订')
 await settings.idle();expect(settings.configured('main')).toMatchObject({model:'main-old'})
 expect(settings.notices('main')[0]?.text).toContain('已回退')
 expect(JSON.stringify(settings.notices('main'))).not.toContain('private-provider-error')
})
it('resumes an interrupted background probe after restart without losing or repeating a completed result',async()=>{
 const {ctx,settings,store}=await setup();let entered!:()=>void
 const started=new Promise<void>(resolve=>{entered=resolve})
 Object.assign(ctx.llm,{stream:async function*(options:any){entered();await new Promise<void>((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(Error('stopped')),{once:true}));yield{}}})
 settings.reserve({scope:'main',selection:{provider:'api',model:'after-restart'}},'restart')
 const work=settings.idle();await started;await settings.stop();await work
 expect(settings.notices('main')).toEqual([]);expect(store.records<any>('model-change')[0].state).toBe('queued')
 const stream=vi.fn(probeChunks);Object.assign(ctx.llm,{stream})
 const restored=new ModelSettings(ctx,store,'role',{main:{provider:'api',model:'main-old'},worker:null})
 restored.start();await restored.idle();expect(restored.configured('main')).toMatchObject({model:'after-restart'})
 expect(restored.notices('main')).toHaveLength(1);await restored.stop()
 const again=new ModelSettings(ctx,store,'role',{main:null,worker:null});again.start();await again.idle()
 expect(stream).toHaveBeenCalledOnce();expect(again.notices('main')).toHaveLength(1);await again.stop()
})
it('does not commit an obsolete reservation when a newer change is queued during its probe',async()=>{
 const {ctx,settings}=await setup();let release!:()=>void,entered!:()=>void
 const gate=new Promise<void>(resolve=>{release=resolve}),started=new Promise<void>(resolve=>{entered=resolve})
 Object.assign(ctx.llm,{stream:async function*(options:any){if(options.model==='obsolete'){entered();await gate}yield*probeChunks(options)}})
 settings.reserve({scope:'main',selection:{provider:'api',model:'obsolete'}},'old')
 const work=settings.idle();await started
 settings.reserve({scope:'main',selection:{provider:'api',model:'newest'}},'new');release();await work
 expect(settings.configured('main')).toMatchObject({model:'newest'})
 expect(settings.notices('main').map(note=>note.text).join('\n')).toContain('已回退')
 expect(settings.notices('main').map(note=>note.text).join('\n')).toContain('newest')
})

it('injects a completed result without waking the agent, acknowledges only after persistence, and deduplicates retries',async()=>{
 const {ctx,settings}=await setup()
 settings.reserve({scope:'main',selection:{provider:'api',model:'bad'}},'notice')
 await settings.idle();expect(settings.notices('main')).toHaveLength(1)
 const session=Session.create(SessionId('notice-main')),inject=vi.fn((message:any)=>session.append('user/message',message,{surfaceOp:'append'}))
 const agent={id:session.id,session,inbox:{nextTurn:[],nextStep:[]},inject,followup:vi.fn(),steer:vi.fn()} as unknown as Agent
 ctx.reflect.provide('agents',new Map([[agent.id,agent]]))
 const flush=vi.fn(async()=>{}).mockResolvedValueOnce(undefined).mockRejectedValueOnce(Error('flush failed'))
 ctx.reflect.provide('sessionPersistence',{flush,open:async()=>({read:async(offset:number,size:number)=>({events:session.snapshotEvents().slice(offset,offset+size)}),[Symbol.asyncDispose]:async()=>{}})})
 const driver=new DshAgentDriver(ctx,()=>({agent_id:'role',name:'role',persona:'persona'}),'/unused',{main:null,worker:null},8)
 driver.modelSettings=settings
 const deliver=()=> (driver as any).injectModelNotices(agent,'main',undefined,new AbortController().signal)
 expect(inject).not.toHaveBeenCalled()
 await expect(deliver()).rejects.toThrow('flush failed')
 expect(settings.notices('main')).toHaveLength(1)
 await deliver();await deliver()
 expect(inject).toHaveBeenCalledOnce();expect(agent.followup).not.toHaveBeenCalled();expect(agent.steer).not.toHaveBeenCalled()
 expect(settings.notices('main')).toEqual([])
 expect(session.snapshotEvents().filter(event=>event.type==='user/message')).toMatchObject([{data:{source:{form:'notice'},content:[{type:'text',text:expect.stringContaining('已回退')}]}}])
})
