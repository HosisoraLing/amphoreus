import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { agentEvents, installModelSelection, type Agent, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
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
  stops.push(async () => { await ctx.fiber.dispose(); host.close(); rmSync(dir, { recursive: true }) })
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
