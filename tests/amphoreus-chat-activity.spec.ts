import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { Store } from '../src/app/store.ts'
import { AmphoreusStore } from '../src/amphoreus/store.ts'
import { MemoryStore, MemorySettings } from '../src/amphoreus/memory.ts'
import { readChatActivity } from '../src/amphoreus/chat-activity.ts'
const cleanup: (() => void)[] = []
afterEach(() => { for (const close of cleanup.splice(0)) close() })
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'chat-activity-')), host = new Store(join(dir, 'db.sqlite'))
  new AmphoreusStore(host)
  const memory = new MemoryStore(host, 'role', MemorySettings.parse({ reasoning: { allowedProviders: ['approved'] } }))
  cleanup.push(() => { host.close(); rmSync(dir, { recursive: true }) })
  const put = (id: string, kind: string, text: string, extra = {}) => memory.put({ id, kind, title: kind, text, created_at: new Date().toISOString(), source: { branch: 'main', event_id: 'e', session_id: 'main', provider: 'approved' }, data: {}, ...extra })
  return { memory, put }
}
it('projects only allowed, non-expired archived thinking and pairs redacted tool records', () => {
  const { memory, put } = setup()
  put('ok', 'reasoning', '允许展示', { data: { permitted: true } })
  put('disabled', 'reasoning', '不应展示', { status: 'disabled', data: { permitted: false } })
  put('expired', 'reasoning', '过期', { expires_at: '2000-01-01T00:00:00Z', data: { permitted: true } })
  put('worker', 'reasoning', '分支内容', { source: { branch: 'worker', event_id: 'e' }, data: { permitted: true } })
  put('other', 'reasoning', '别的事件', { source: { branch: 'main', event_id: 'other' }, data: { permitted: true } })
  put('call', 'tool', JSON.stringify({ tool: 'read', call_id: 'c', arguments: { token: 'sensitive', query: 'secret-value' } }), { data: { direction: 'call' } })
  put('result', 'tool', JSON.stringify({ call_id: 'c', content: [{ type: 'text', text: 'Bearer abcdefgh secret-value' }], is_error: false }), { data: { direction: 'result' } })
  put('revoked', 'reasoning', '已撤销的供应商', { source: { branch: 'main', event_id: 'e', provider: 'revoked' }, data: { permitted: true } })
  put('broken', 'tool', 'not json')
  const page = readChatActivity(memory, ['e'], undefined, ['secret-value'])
  expect(page.items.map(item => item.id).sort()).toEqual(['call','ok','result'])
  expect(JSON.stringify(page)).not.toMatch(/sensitive|secret-value|abcdefgh|不应展示|分支内容|别的事件/)
  expect(page.items.find(item => item.id === 'call')?.call_id).toBe('main:c')
  expect(page.has_more).toBe(false)
})
it('uses stable cursors for bounded older history without losing records', () => {
  const { memory, put } = setup()
  for (let n = 0; n < 103; n++) put(`r${n}`, 'reasoning', String(n), { data: { permitted: true } })
  const first = readChatActivity(memory, ['e']), next = readChatActivity(memory, ['e'], first.next_cursor!)
  expect(first.items).toHaveLength(100); expect(first.has_more).toBe(true)
  expect(next.items).toHaveLength(3); expect(next.has_more).toBe(false)
  expect(new Set([...first.items, ...next.items].map(item => item.id)).size).toBe(103)
  expect(readChatActivity(memory, []).items).toEqual([])
})
