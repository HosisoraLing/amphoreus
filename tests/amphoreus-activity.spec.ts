import { expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SubagentTask } from '../src/amphoreus/model.ts'
import { projectTaskActivity, readTaskActivity } from '../src/amphoreus/activity.ts'

it('projects visible worker messages/tools, redacts credentials, and omits native hidden reasoning and request headers', () => {
  const events = [
    { type: 'system/message', data: { text: 'private persona' } },
    { type: 'request/header', data: { apiKey: 'private provider key' } },
    { type: 'user/message', data: { source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'private-runtime-context' }] } },
    { type: 'user/message', data: { source: { kind: 'dsh-amphoreus' }, content: [{ type: 'text', text: JSON.stringify({ task: { description: '检查目录' } }) }] } },
    { type: 'assistant/message', data: { stream: ['hidden-stream'], message: { content: [{ type: 'reasoning', text: 'hidden-reasoning' }, { type: 'text', text: '开始检查 known-secret' }] } } },
    { type: 'tool/call', data: { name: 'bash', callId: 'call', arguments: JSON.stringify({ command: 'pwd', api_key: 'private-key' }) } },
    { type: 'tool/result', data: { message: { toolCallId: 'call', content: [{ type: 'text', text: 'result Bearer private-token' }], isError: false } } },
    { type: 'tool/result', data: { message: { toolCallId: 'call-json', content: [{ type: 'text', text: JSON.stringify({ api_key: 'private-json-key', output: 'safe output' }) }], isError: false } } },
  ].map((event, seq) => ({ ...event, seq, time: Date.now() })) as unknown as SessionEvent[]
  const projected = projectTaskActivity(events, ['known-secret'])
  expect(projected.map(e => e.kind)).toEqual(['message', 'message', 'tool_call', 'tool_result', 'tool_result'])
  expect(projected[0]?.text).toBe('检查目录')
  expect(projected[2]?.arguments).toEqual({ command: 'pwd', api_key: '[已隐藏]' })
  const serialized = JSON.stringify(projected)
  for (const secret of ['private persona', 'private-runtime-context', 'private provider key', 'hidden-stream', 'hidden-reasoning', 'private-token', 'private-json-key', 'known-secret']) expect(serialized).not.toContain(secret)
})

it('reads the trusted worker Session without resolving an Agent and advances past non-visible events', async () => {
  const task = { subagent_id: 'trusted-worker', state: 'running' } as SubagentTask
  const disposed = vi.fn(), read = vi.fn(async () => ({ events: [{ type: 'request/header', seq: 7, time: Date.now(), data: {} }] }))
  const open = vi.fn(async () => ({ read, [Symbol.asyncDispose]: disposed }))
  const ctx = { sessionPersistence: { stat: vi.fn(async () => ({})), flush: vi.fn(async () => {}), open } } as unknown as Context
  const page = await readTaskActivity(ctx, task, 7, 1)
  expect(open).toHaveBeenCalledWith('trusted-worker', 'read')
  expect(read).toHaveBeenCalledWith(7, 1)
  expect(page).toMatchObject({ items: [], end_offset: 8, has_more: true, available: true })
  expect(disposed).toHaveBeenCalledOnce()
})
