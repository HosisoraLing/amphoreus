import { expect, it, vi } from 'vitest'
import { DshAgentDriver } from '../src/amphoreus/dsh.ts'
import { normalizeEvent, type SubagentTask } from '../src/amphoreus/model.ts'

it('uses native Fork at a completed boundary, preserves current-turn handoff, and never reforks an established branch', async () => {
  const parent = { id: 'main', session: { snapshotEvents: () => [
    { type: 'turn/end', seq: 10, data: { reason: { kind: 'completed' } } },
    { type: 'user/message', seq: 11, data: { content: [{ type: 'text', text: '当前未完成Turn' }] } },
  ] }, whenIdle: vi.fn() }
  const fork = vi.fn(async () => ({ sessionId: 'native-child' })), create = vi.fn()
  const ctx = { on: vi.fn(), sessionController: { resolveAgent: vi.fn(async () => ({ agent: parent })), fork, create },
    sessionPersistence: { flush: vi.fn(async () => {}), stat: vi.fn(async () => ({ header: { parentSession: 'main', isSeeded: true } })) }, permissionPresets: { set: vi.fn() } }
  const driver = new DshAgentDriver(ctx as never, () => ({ agent_id: 'role', name: '角色', persona: '完整人设' }), '/unused', { main: null, worker: null }, 8)
  const origin = normalizeEvent({ agent_id: 'role', source_kind: 'web', platform: 'web', account_id: 'owner', conversation_id: 'chat', actor_id: 'owner', event_type: 'message',
    timestamp: new Date().toISOString(), correlation_id: null, visibility: 'private', idempotency_key: 'one', metadata: {}, content: [{ type: 'text', text: '当前输入' }] })
  const task: SubagentTask = { task_id: 'task', agent_id: 'role', subagent_id: 'placeholder', description: '构思星光故事', context: [{ type: 'text', text: '当前决定' }], priority: 0,
    state: 'running', created_at: origin.timestamp, updated_at: origin.timestamp, kind: 'continuation', parent_session_id: 'main', parent_run_id: 'run', origin }
  const prepared = await driver.prepare(task, new AbortController().signal)
  expect(fork).toHaveBeenCalledWith({ sessionId: 'main', atSeq: 10 })
  expect(create).not.toHaveBeenCalled()
  expect(prepared).toMatchObject({ subagent_id: 'native-child', fork: { parent_session_id: 'main', fork_event_seq: 10, handoff: { trigger: origin, task: task.description, decisions: task.context } } })
  await driver.prepare(prepared, new AbortController().signal)
  expect(fork).toHaveBeenCalledTimes(1)
  expect(await driver.prepare({ ...task, kind: 'worker' }, new AbortController().signal)).toMatchObject({ subagent_id: 'placeholder' })
})
