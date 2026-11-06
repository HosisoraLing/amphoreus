import { expect, it } from 'vitest'
import { mainInput } from '../src/amphoreus/main-input.ts'
import { normalizeEvent } from '../src/amphoreus/model.ts'

const event = () => normalizeEvent({ agent_id: 'role', source_kind: 'web', platform: 'web', account_id: 'alice',
  conversation_id: 'web:alice:chat', actor_id: 'alice', event_type: 'message', timestamp: '2026-11-03T04:00:00.000Z',
  correlation_id: null, content: [{ type: 'text', text: '你好\n今天过得怎么样？' }], metadata: { nickname: 'alice' },
  visibility: 'private', idempotency_key: 'request' })

it('sends ordinary chat as plain text with minimal attribution, without mutating the stored event', () => {
  const input = event(), original = JSON.stringify(input), text = mainInput(input)
  expect(text).toBe('网页 · alice · 2026-11-03T04:00:00.000Z · web:alice:chat\n\n你好\n今天过得怎么样？')
  expect(text.length).toBeLessThan(original.length / 4)
  expect(JSON.stringify(input)).toBe(original)
  const greeting = { ...input, platform: 'internal', source_kind: 'genesis', actor_id: 'creator', metadata: {} }
  expect(mainInput(greeting)).toContain('创世问候 · creator')
})

it('retains QQ sender/group identity while omitting message IDs from ordinary input', () => {
  const input = { ...event(), source_kind: 'napcat', platform: 'qq', account_id: '123', actor_id: '456', conversation_id: 'group:789',
    metadata: { nickname: '小鱼', message_type: 'group', group_name: '鱼缸', message_id: '42', avatar: 'unused-avatar', schedule: true },
    content: [{ type: 'text', text: '看看这个' }, { type: 'mention', actor_id: '123', platform: 'qq' },
      { type: 'quote', message_id: '41', platform: 'qq' },
      { type: 'image', url: 'https://example.com/image.png', original: { file: 'image.png' } },
      { type: 'text', text: '带扩展的正文', language: 'zh' }] }
  const text = mainInput(input)
  expect(text).toContain('QQ 群聊 · 小鱼 (456)')
  expect(text).toContain('鱼缸 (group:789)')
  expect(text).not.toContain('消息 42')
  expect(text).not.toContain('"message_id"')
  expect(input.metadata.message_id).toBe('42')
  expect(text).not.toContain('unused-avatar')
  expect(text).not.toContain('schedule')
  expect(text).toContain('@123（QQ:123，叫你）')
  expect(text).toContain('[图片]')
  expect(text).toContain('[引用消息]')
  expect(text).toContain(JSON.stringify(input.content.at(-1)))
  const other = mainInput({ ...input, content: [{ type: 'mention', platform: 'qq', actor_id: '999', display_name: '测试群友' }] })
  expect(other).toContain('@测试群友（QQ:999，叫的是别人）')
})

it('keeps actionable task ID, report status, zero progress and all details without repeated report envelopes', () => {
  const input = { ...event(), source_kind: 'internal', platform: 'internal', task_id: 'task-123', event_type: 'task.question',
    content: [{ type: 'report', report_id: 'duplicate-id', task_id: 'task-123', agent_id: 'role', summary: '需要选择方案', progress: 0,
      details: [{ type: 'text', text: 'A 或 B？' }, { type: 'file', name: 'notes.txt', url: 'https://example.com/notes.txt' }] }] }
  const text = mainInput(input)
  expect(text).toBe('后台任务 task-123 · question · 2026-11-03T04:00:00.000Z\n\n需要选择方案\n进度 0%\nA 或 B？\n[文件：notes.txt]')
  expect(text).not.toContain('duplicate-id')
  expect(mainInput(input, event())).toContain('来源 web/web:alice:chat')
})

it('preserves routing and platform-specific metadata for other event sources', () => {
  const input = { ...event(), platform: 'bilibili', content: [{ type: 'comment', id: 'comment-id', text: '你好' }], metadata: { work_id: 'work-id' } }
  const text = mainInput(input)
  expect(text).toContain('"conversation_id":"web:alice:chat"')
  expect(text).toContain('"work_id":"work-id"')
  expect(text).toContain(JSON.stringify(input.content[0]))
})
