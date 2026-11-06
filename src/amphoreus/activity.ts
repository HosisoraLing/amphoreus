/** A read-only presentation of DSH worker history. Request headers, system prompts and hidden reasoning are never projected. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { SubagentTask } from './model.ts'

export interface TaskActivity { id: string; timestamp: string; kind: 'message' | 'tool_call' | 'tool_result' | 'status';
  text?: string; role?: 'input' | 'assistant'; tool?: string; call_id?: string; arguments?: unknown; is_error?: boolean; truncated?: boolean }
export interface ActivityPage { items: TaskActivity[]; end_offset: number; has_more: boolean; available: boolean }
export type ActivityReader = (task: SubagentTask, offset: number, limit: number) => Promise<ActivityPage>
const textOf = (blocks: readonly { type: string; text?: string }[]) => blocks.filter(block => block.type === 'text').map(block => String(block.text ?? '')).join('\n')
function argumentsOf(text: string): unknown { try { return JSON.parse(text) } catch { return text.slice(0, 16000) } }
export function redact(value: unknown, secrets: string[], key = ''): unknown {
  if (/(?:token|secret|password|authorization|cookie|api.?key)/i.test(key)) return '[已隐藏]'
  if (Array.isArray(value)) return value.map(item => redact(item, secrets))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, secrets, k)]))
  if (typeof value === 'string') {
    if (key === 'text') {
      try { const parsed = JSON.parse(value); if (parsed && typeof parsed === 'object') return JSON.stringify(redact(parsed, secrets)) } catch { /* Plain-text tool output is handled below. */ }
    }
    let text = value.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [已隐藏]')
    for (const secret of secrets.filter(Boolean)) text = text.replaceAll(secret, '[已隐藏]')
    return text
  }
  return value
}
export function projectTaskActivity(events: readonly SessionEvent[], secrets: string[] = []): TaskActivity[] {
  return events.flatMap(event => {
    const base = { id: String(event.seq), timestamp: new Date(event.time).toISOString() }
    let item: TaskActivity | undefined
    if (event.type === 'assistant/message') {
      const text = textOf(event.data.message.content)
      if (text) item = { ...base, kind: 'message', role: 'assistant', text }
    } else if (event.type === 'user/message') {
      if (!['dsh-amphoreus', 'dsh-superagent', 'user'].includes(event.data.source.kind)) return []
      const text = textOf(event.data.content)
      const structured = argumentsOf(text)
      if (structured && typeof structured === 'object') {
        const task = (structured as { task?: { description?: string } }).task
        item = { ...base, kind: 'message', role: 'input', text: task?.description || '收到任务消息', ...(task ? {} : { arguments: structured }) }
      } else if (text) item = { ...base, kind: 'message', role: 'input', text }
    } else if (event.type === 'tool/call') {
      item = { ...base, kind: 'tool_call', tool: event.data.name, call_id: event.data.callId, arguments: argumentsOf(event.data.arguments) }
    } else if (event.type === 'tool/result') {
      item = { ...base, kind: 'tool_result', call_id: event.data.message.toolCallId, text: textOf(event.data.message.content), is_error: !!event.data.message.isError }
    } else if (event.type === 'turn/start' || event.type === 'turn/end') {
      item = { ...base, kind: 'status', text: event.type === 'turn/start' ? '开始执行' : '本轮执行结束' }
    }
    if (item?.text && item.text.length > 32000) item = { ...item, text: item.text.slice(0, 32000), truncated: true }
    return item ? [redact(item, secrets) as TaskActivity] : []
  })
}
export async function readTaskActivity(ctx: Context, task: SubagentTask, offset: number, limit: number, secrets: string[] = []): Promise<ActivityPage> {
  // Open only the trusted task's stored Session; viewing history never resolves/starts an Agent.
  const id = task.subagent_id as SessionId
  if (!await ctx.sessionPersistence.stat(id)) return { items: [], end_offset: offset, has_more: false, available: false }
  if (task.state === 'running') await ctx.sessionPersistence.flush()
  await using handle = await ctx.sessionPersistence.open(id, 'read')
  const { events } = await handle.read(offset, limit)
  return { items: projectTaskActivity(events, secrets), end_offset: offset + events.length, has_more: events.length === limit, available: true }
}
