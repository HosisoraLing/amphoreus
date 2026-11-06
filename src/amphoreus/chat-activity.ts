/** Owner-only, bounded projection of already archived Main activity. Never reads native/private reasoning. */
import { redact } from './activity.ts'
import type { MemoryStore, MemoryRecord } from './memory.ts'

export interface ChatActivity {
  id: string; event_id: string; run_id?: string; timestamp: string; kind: 'reasoning' | 'tool_call' | 'tool_result';
  text?: string; call_id?: string; tool?: string; arguments?: unknown; is_error?: boolean; truncated?: boolean
}
function project(record: MemoryRecord, secrets: string[], allowedProviders: string[]): ChatActivity | undefined {
  const base = { id: record.id, event_id: record.source.event_id!, ...(record.source.run_id ? {run_id:record.source.run_id} : {}), timestamp: record.created_at }
  if (record.kind === 'reasoning') {
    // The archive's provider allow-list and retention policy remain authoritative.
    if (!record.data.permitted || !record.source.provider || !allowedProviders.includes(record.source.provider) || !['complete', 'interrupted'].includes(record.status) || !record.text || record.expires_at && record.expires_at <= new Date().toISOString()) return
    return redact({ ...base, kind: 'reasoning', text: record.text.slice(0, 12000), truncated: record.text.length > 12000 }, secrets) as ChatActivity
  }
  try {
    const value = JSON.parse(record.text)
    if (typeof value.call_id !== 'string') return
    const call_id = `${record.source.session_id || ''}:${value.call_id}`
    if (record.data.direction === 'call') {
      const args = redact(value.arguments, secrets), serialized = JSON.stringify(args) || ''
      return { ...base, kind: 'tool_call', call_id, tool: String(redact(String(value.tool || '工具'), secrets)),
        arguments: serialized.length > 12000 ? serialized.slice(0, 12000) : args, truncated: serialized.length > 12000 }
    }
    if (record.data.direction === 'result') {
      const text = (Array.isArray(value.content) ? value.content : []).filter((b: { type: string; text?: string }) => b.type === 'text').map((b: { text?: string }) => b.text || '').join('\n')
      return redact({ ...base, kind: 'tool_result', call_id, text: text.slice(0, 12000), is_error: !!value.is_error, truncated: text.length > 12000 }, secrets) as ChatActivity
    }
  } catch { /* A damaged historical record must not break the transcript. */ }
}
export function readChatActivity(memory: MemoryStore, eventIds: string[], before?: number, secrets: string[] = []) {
  const ids = [...new Set(eventIds)].slice(0, 100)
  if (!ids.length) return { items: [], has_more: false, next_cursor: null }
  const rows = memory.host.db.prepare(`SELECT rowid AS cursor,id FROM amphoreus_memory WHERE agent_id=?
    AND source ->> '$.branch'='main' AND source ->> '$.event_id' IN (${ids.map(() => '?').join(',')})
    AND kind IN ('reasoning','tool') ${before === undefined ? '' : 'AND rowid<?'} ORDER BY rowid DESC LIMIT 101`)
    .all(memory.agentId, ...ids, ...(before === undefined ? [] : [before]))
  const page = rows.slice(0, 100), items: ChatActivity[] = []
  for (const row of page) { const record = memory.get(String(row.id)); if (record) { const item = project(record, secrets, memory.settings.reasoning.allowedProviders); if (item) items.push(item) } }
  return { items, has_more: rows.length > 100, next_cursor: page.length ? Number(page.at(-1)!.cursor) : null }
}
