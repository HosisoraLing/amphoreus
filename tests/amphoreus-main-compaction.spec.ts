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

it.each([153000, 900000])('preserves %i tokens on wake and leaves model-window pressure policy to the preset', async tokens => {
  const root = new Context(); roots.push(root)
  await root.plugin(SystemPrompt); await root.plugin(CommandRuntime)
  root.provide('tokenMeter', { measure: () => ({ totalTokens: tokens }) })
  const ctx = await new Promise<Context>(resolve => { root.inject(['commands', 'systemPrompt', 'tokenMeter'], child => { resolve(child) }) })
  const session = Session.create(SessionId('main-compaction')), agent = { id: session.id, session } as Agent
  Object.assign(agent, { ctx: createScope(ctx, agent).ctx })
  const compact = vi.fn(async () => ({ kind: 'success' as const }))
  const commands = agent.ctx.get('commands') as InstanceType<typeof CommandRuntime>
  commands.register({ name: 'compact', description: 'compact', handler: compact })
  const checkpoint = vi.fn(), archive = { bind: vi.fn(), store: { setRecord: checkpoint }, memory: {} }
  const driver = new DshAgentDriver(ctx, () => ({ agent_id: 'role', name: '角色', persona: '人设' }), '/unused', { main: null, worker: null }, 8, archive as never)
  ;(driver as any).ensure = async () => agent
  const run = vi.fn(async () => {})
  ;(driver as any).run = run
  const event = { event_id: 'incoming', source_kind: 'web', platform: 'web', account_id: 'owner', conversation_id: 'web:owner:chat',
    actor_id: 'owner', event_type: 'message', content: [{ type: 'text', text: 'hello' }], metadata: {}, received_at: new Date().toISOString() }
  await driver.main({ sessionId: agent.id, runId: 'wake', event, origin: event } as unknown as MainContext, new AbortController().signal)
  expect(run).toHaveBeenCalledOnce(); expect(compact).not.toHaveBeenCalled()
  expect(checkpoint).not.toHaveBeenCalled()
})

it('defaults all Main time budgets to unlimited and preserves explicit limits', () => {
  const limits = AmphoreusConfig.shape.limits
  expect(limits.parse(undefined)).toMatchObject({ mainTimeoutMs: 0, reviewTimeoutMs: 0, collaborationTimeoutMs: 0 })
  expect(limits.parse({ mainTimeoutMs: 90000 }).mainTimeoutMs).toBe(90000)
  expect(limits.safeParse({ mainTimeoutMs: 0 }).success).toBe(true)
  expect(limits.safeParse({ mainTimeoutMs: -1 }).success).toBe(false)
  expect(limits.safeParse({ mainTimeoutMs: 300001 }).success).toBe(false)
})
