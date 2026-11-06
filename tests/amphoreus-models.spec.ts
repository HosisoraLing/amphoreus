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
