import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { createScope } from '@deepseek-ai/dsh-scope'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { DshAgentDriver } from '../src/amphoreus/dsh.ts'
import { resetForkToolBaseline } from '../src/amphoreus/tool-baseline.ts'

const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })
function register(ctx: Context, name: string) {
  const execute = vi.fn(async () => ({ ok: true }))
  const dispose = ctx.tools.register({ name, description: name, parameters: { type: 'object' },
    output: { schema: { type: 'object' }, render: () => [{ type: 'text', text: 'ok' }] }, execute })
  return { execute, dispose }
}

it('projects Zod-generated memory and media parameters through the native lossless JSON boundary', async () => {
  const root = new Context(); contexts.push(root)
  await root.plugin(SystemPrompt); await root.plugin(ToolRuntime)
  const ctx = await new Promise<Context>(resolve => { root.inject(['tools'], child => { resolve(child) }) })
  const session = Session.create(SessionId('schema-regression')), agent = { id: session.id, session } as Agent
  Object.assign(agent, { ctx: createScope(ctx, agent).ctx })
  const archive = { memory: {}, binding: () => ({ event_id: 'current-source' }) }
  const driver = new DshAgentDriver(ctx, () => ({ agent_id: 'role', name: '角色', persona: '人设' }), '/unused', { main: null, worker: null }, 8, archive as never)
  const content = [{ type: 'text', text: '附件内容' }]
  const read = vi.fn(async () => content), forward = vi.fn(async () => content)
  driver.media = { read, forward } as never
  const disposers = (driver as any).memoryTools(agent, 'main') as (() => void)[]
  try {
    const schemas = agent.ctx.tools.schemas(agent)
    expect(schemas.map(tool => tool.name)).toEqual(expect.arrayContaining(['read_media', 'read_forward', 'memory_find', 'memory_confirm']))
    expect(schemas.find(tool => tool.name === 'read_media')!.parameters).toMatchObject({
      additionalProperties: false, properties: { index: { default: 0 }, frames: { default: 5, maximum: 16 } },
    })
    const signal = new AbortController().signal
    const call = (name: string, args = {}) => ctx.tools.execute({ agent, name, arguments: args, callId: ToolCallId(`schema-${name}`), signal })
    expect((await call('read_media')).isError).toBe(false)
    expect(read).toHaveBeenCalledWith('current-source', 0, signal, 5)
    expect((await call('read_forward')).isError).toBe(false)
    expect(forward).toHaveBeenCalledWith('current-source', 0, 0, 5, signal)
    expect((await call('read_forward', { limit: 11 })).isError).toBe(true)
    expect(forward).toHaveBeenCalledOnce()
  } finally { disposers.reverse().forEach(dispose => dispose()) }
})

it('registers QQ management on Main with native JSON schemas and a stable per-run call identity',async()=>{
  const root=new Context();contexts.push(root)
  await root.plugin(SystemPrompt);await root.plugin(ToolRuntime)
  const ctx=await new Promise<Context>(resolve=>{root.inject(['tools'],child=>resolve(child))})
  const session=Session.create(SessionId('qq-management')),agent={id:session.id,session} as Agent
  Object.assign(agent,{ctx:createScope(ctx,agent).ctx})
  const execute=vi.fn(async()=>({status:'success'}))
  const driver=new DshAgentDriver(ctx,()=>({agent_id:'role',name:'角色',persona:'人设'}),'/unused',{main:null,worker:null},8)
  driver.qqManagement={execute} as never
  ;(driver as any).ensure=async()=>agent
  ;(driver as any).run=async(_agent:Agent,_id:unknown,_input:unknown,_prompt:unknown,_worker:unknown,signal:AbortSignal,tools:(agent:Agent)=>(()=>void)[])=>{
    const disposers=tools(agent)
    try{
      expect(agent.ctx.tools.schemas(agent).find(t=>t.name==='qq_manage')?.parameters).toMatchObject({additionalProperties:false,properties:{action:{enum:expect.arrayContaining(['friends','request_handle','group_leave'])}}})
      const result=await agent.ctx.tools.execute({agent,name:'qq_manage',arguments:{action:'friend_delete',user_id:'456'},callId:ToolCallId('delete'),signal})
      expect(result.isError).toBe(false)
      expect(execute).toHaveBeenCalledWith(expect.objectContaining({action:'friend_delete',user_id:'456'}),'run:delete')
    }finally{disposers.reverse().forEach(dispose=>dispose())}
  }
  const event={event_id:'source',source_kind:'web',platform:'web',account_id:'owner',conversation_id:'web:owner:chat',actor_id:'owner',timestamp:new Date().toISOString(),metadata:{},content:[{type:'text',text:'管理QQ'}]}
  await driver.main({event,origin:event,runId:'run'} as never,new AbortController().signal)
})

it.each([
  ['main', false, false, false], ['worker', true, false, false],
  ['continuation', true, true, false], ['topic', true, false, true],
] as const)('lets %s use native additional tools before and during a wake, with native scope and policy intact', async (role, worker, continuation, topic) => {
  const root = new Context(); contexts.push(root)
  await root.plugin(SystemPrompt); await root.plugin(ToolRuntime)
  const ctx = await new Promise<Context>(resolve => { root.inject(['tools'], child => { resolve(child) }) })
  const parent = {}, preset = createScope(ctx, parent)
  register(preset.ctx, 'web_search')
  register(preset.ctx, 'memory_confirm')
  register(preset.ctx, 'amphoreus_settings')
  register(preset.ctx, 'qq_manage')
  register(preset.ctx, 'speak')
  register(preset.ctx, 'deja_recall')
  const session = Session.create(SessionId(role)), agent = { id: session.id, session } as Agent
  const scope = createScope(ctx, agent, { parent }); Object.assign(agent, { ctx: scope.ctx })
  const sibling = {} as Agent
  const siblingScope = createScope(ctx, sibling, { parent }); Object.assign(sibling, { ctx: siblingScope.ctx })
  const controller = new AbortController()
  const driver = new DshAgentDriver(ctx, () => ({ agent_id: 'role', name: '角色', persona: '人设' }), '/unused', { main: null, worker: null }, 8)
  const dispose = (driver as any).scopeTools(agent, worker, continuation, topic, controller.signal) as (() => void)[]
  const call = (name: string) => ctx.tools.execute({ agent, name, arguments: {}, callId: ToolCallId(`call-${name}`), signal: new AbortController().signal })
  expect((await call('web_search')).isError).toBe(false)
  const custom = register(agent.ctx, 'session_custom')
  expect(agent.ctx.tools.schemas(agent).map(tool => tool.name)).toContain('session_custom')
  expect(ctx.tools.get('session_custom', sibling)).toBeUndefined()
  expect((await call('session_custom')).isError).toBe(false)
  expect(custom.execute).toHaveBeenCalledOnce()
  expect((await call('memory_confirm')).isError).toBe(worker)
  expect((await call('amphoreus_settings')).isError).toBe(worker)
  expect((await call('qq_manage')).isError).toBe(worker)
  expect((await call('speak')).isError).toBe(worker)
  expect((await call('deja_recall')).isError).toBe(!worker || continuation || topic)
  // Even a tool registered directly on the Session cannot bypass role ownership.
  if (worker) {
    const forbidden = register(agent.ctx, 'memory_confirm')
    expect((await call('memory_confirm')).isError).toBe(true)
    expect(forbidden.execute).not.toHaveBeenCalled()
  }
  if (continuation) {
    session.append('request/header', { header: { config: { provider: 'p', model: 'm' }, tools: [{ name: 'speak', description: '', parameters: { type: 'object' } }] }, reason: 'initial' })
    resetForkToolBaseline(session, agent.ctx.tools.schemas(agent))
    expect(session.toolHistory().tools.map(tool => tool.name)).toContain('session_custom')
    expect(session.toolHistory().tools.map(tool => tool.name)).not.toContain('speak')
  }
  const lift = agent.ctx.tools.guard(exec => exec.name === 'session_custom' ? 'Native owner policy' : undefined)
  expect((await call('session_custom')).isError).toBe(true)
  lift()
  custom.dispose()
  expect(ctx.tools.get('session_custom', agent)).toBeUndefined()
  const late = register(preset.ctx, 'late_tool')
  expect((await call('late_tool')).isError).toBe(false)
  controller.abort()
  expect((await call('late_tool')).isError).toBe(true)
  expect(late.execute).toHaveBeenCalledOnce()
  dispose.reverse().forEach(stop => stop())
  expect((await call('late_tool')).isError).toBe(false)
})
