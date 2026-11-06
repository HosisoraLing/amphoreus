import { createRequire } from 'node:module'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { createScope } from '@deepseek-ai/dsh-scope'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { DshAgentDriver } from '../src/amphoreus/dsh.ts'
import { AmphoreusConfig } from '../src/amphoreus/config.ts'
import type { MainContext } from '../src/amphoreus/runtime.ts'

// Reuse the host's command registry without adding a second dependency/version.
const native = createRequire(import.meta.resolve('@deepseek-ai/dsh-agent'))
const { CommandRuntime } = await import(native.resolve('@deepseek-ai/dsh-commands'))
const roots: Context[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => root.fiber.dispose())) })

async function setup(tokens = 153000, outcome: 'shrink' | 'noop' | 'error' | 'missing' = 'shrink') {
  const root = new Context(); roots.push(root)
  await root.plugin(SystemPrompt); await root.plugin(CommandRuntime)
  root.provide('tokenMeter', { measure: () => ({ totalTokens: tokens }) })
  const ctx = await new Promise<Context>(resolve => { root.inject(['commands', 'systemPrompt', 'tokenMeter'], child => { resolve(child) }) })
  const session = Session.create(SessionId('main-compaction')), agent = { id: session.id, session } as Agent
  Object.assign(agent, { ctx: createScope(ctx, agent).ctx })
  const isolated = agent.ctx.isolate('compaction')
  const compact = vi.fn(async (_agent: Agent, _signal: AbortSignal) => {
    if (outcome === 'error') return { kind: 'error' as const, text: 'Summary unavailable' }
    if (outcome === 'shrink') {
      Object.defineProperty(session.surface, 'replaceGeneration', { value: 1, configurable: true })
      tokens = 4000
    }
    return { kind: 'success' as const }
  })
  isolated.provide('compaction', { compactNow: compact })
  // Same capture as dsh-command-compact: the handler owns the isolated service.
  const commands = isolated.get('commands') as InstanceType<typeof CommandRuntime>
  if (outcome !== 'missing') commands.register({ name: 'compact', description: 'compact',
    handler: async (invocation: { agent: Agent; signal: AbortSignal }) => compact(invocation.agent, invocation.signal) })
  expect(agent.ctx.get('compaction')).toBeUndefined()
  const checkpoint = vi.fn(), archive = { bind: vi.fn(), store: { setRecord: checkpoint }, memory: {} }
  const driver = new DshAgentDriver(ctx, () => ({ agent_id: 'role', name: '角色', persona: '人设' }), '/unused', { main: null, worker: null }, 8, archive as never)
  ;(driver as any).ensure = async () => agent
  const run = vi.fn(async () => { expect(tokens).toBeLessThanOrEqual(outcome === 'noop' ? 153000 : 32768) })
  ;(driver as any).run = run
  const event = { event_id: 'incoming', source_kind: 'web', platform: 'web', account_id: 'owner', conversation_id: 'web:owner:chat',
    actor_id: 'owner', event_type: 'message', content: [{ type: 'text', text: 'hello' }], metadata: {}, received_at: new Date().toISOString() }
  const context = { sessionId: agent.id, runId: 'wake', event, origin: event } as unknown as MainContext
  const signal = new AbortController().signal
  return { agent, compact, checkpoint, run, wake: () => driver.main(context, signal) }
}

it('reaches isolated compaction through the native command registry before admitting a wake', async () => {
  const f = await setup()
  await f.wake()
  expect(f.compact).toHaveBeenCalledOnce(); expect(f.run).toHaveBeenCalledOnce()
  expect(f.compact.mock.invocationCallOrder[0]).toBeLessThan(f.run.mock.invocationCallOrder[0]!)
  expect(f.checkpoint).toHaveBeenCalledWith('role-compact-checkpoint', f.agent.id, expect.objectContaining({ generation: 1 }))
  expect(f.agent.session.snapshotEvents().filter(event => event.type === 'user/message')).toHaveLength(0)
})

it('does not call the model or record compaction when pressure is within 32k', async () => {
  const f = await setup(32768)
  await f.wake()
  expect(f.compact).not.toHaveBeenCalled(); expect(f.checkpoint).not.toHaveBeenCalled()
  expect(f.run).toHaveBeenCalledOnce()
})

it('does not invent a checkpoint when the native command has no safe range', async () => {
  const f = await setup(153000, 'noop')
  await f.wake()
  expect(f.compact).toHaveBeenCalledOnce(); expect(f.checkpoint).not.toHaveBeenCalled()
})

it.each(['error', 'missing'] as const)('reports %s compaction instead of silently sending the oversized request', async outcome => {
  const f = await setup(153000, outcome)
  await expect(f.wake()).rejects.toThrow(/compaction/i)
  expect(f.run).not.toHaveBeenCalled(); expect(f.checkpoint).not.toHaveBeenCalled()
})

it('defaults to a bounded five-minute Main budget and preserves explicit limits', () => {
  const limits = AmphoreusConfig.shape.limits
  expect(limits.parse(undefined).mainTimeoutMs).toBe(300000)
  expect(limits.parse({ mainTimeoutMs: 90000 }).mainTimeoutMs).toBe(90000)
  expect(limits.safeParse({ mainTimeoutMs: 0 }).success).toBe(false)
  expect(limits.safeParse({ mainTimeoutMs: 300001 }).success).toBe(false)
})
