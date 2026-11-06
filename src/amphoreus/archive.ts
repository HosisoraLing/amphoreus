import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { AmphoreusStore } from './store.ts'
import { MemoryStore, memoryId, type MemoryRecord, type MemorySource } from './memory.ts'
import { redact } from './activity.ts'
import type { Dreaming } from './dreaming.ts'
import { captureVitality } from './vitality.ts'

export interface ArchiveBinding extends MemorySource { session_id: string; branch: 'main' | 'worker' | 'continuation' | 'topic'; self_version?: string | null; memory_view_at?: string }
type NativeCursor = { offset: number; binding: ArchiveBinding }
const blockText = (blocks: readonly { type: string; text?: unknown }[]) => blocks.filter(b => b.type === 'text' && typeof b.text === 'string').map(b => String(b.text)).join('\n')
const parsedArguments = (value: unknown): unknown => { if (typeof value !== 'string') return value; try { return JSON.parse(value) } catch { return value } }

/** Archive committed native messages, not stream deltas or a Fork's inherited prefix. */
export class MemoryArchive {
  private readonly cursors = new Map<string, NativeCursor>()
  onThought: (record: MemoryRecord) => Promise<void> = async () => {}
  onSelfConfirmed: (record: MemoryRecord) => Promise<void> = async () => {}
  dreaming?: Dreaming
  constructor(readonly memory: MemoryStore, readonly store: AmphoreusStore, private readonly ctx: Context, private readonly secrets: string[] = []) {}
  bind(binding: ArchiveBinding): void {
    const old = this.cursors.get(binding.session_id) ?? this.store.record<NativeCursor>('memory-native', binding.session_id)
    const state = { offset: old?.offset ?? 0, binding: { ...old?.binding, ...binding } }
    this.cursors.set(binding.session_id, state); this.store.setRecord('memory-native', binding.session_id, state)
  }
  binding(id: string): ArchiveBinding | undefined { return this.cursors.get(id)?.binding ?? this.store.record<NativeCursor>('memory-native', id)?.binding }
  captureGateway(): void {
    let cursor = this.store.record<number>('memory-gateway', this.memory.agentId) ?? 0
    for (;;) {
      const rows = this.store.eventsAfter(this.memory.agentId, cursor)
      if (!rows.length) break
      this.memory.host.atomic(() => {
        for (const { position, event } of rows) {
          if (event.event_type !== 'assistant.thought' && !['qq-observation','qq-debounce'].includes(event.source_kind)) {
            const outgoing = event.source_kind === 'output-gateway', output = outgoing ? this.store.output(event.event_id) : undefined
            const archived = this.memory.put({ id: memoryId('gateway', event.event_id), kind: outgoing ? 'speak' : event.source_kind === 'internal' ? 'report' : 'input',
              title: event.event_type, text: blockText(event.content), created_at: event.timestamp,
              source: { event_id: event.event_id, actor_id: event.actor_id, platform: event.platform, account_id: event.account_id,
                conversation_id: event.conversation_id, ...(event.task_id ? { task_id: event.task_id } : {}) },
              status: output?.status ?? 'complete', importance: /completed|failed/.test(event.event_type) ? .6 : outgoing ? .4 : .3,
              data: { blocks: event.content, source_kind: event.source_kind, visibility: event.visibility, direction: event.metadata.direction,
                ...(event.report_id ? { report_id: event.report_id } : {}) } })
            if (archived.kind === 'input') {
              const segmentId = memoryId('segment', event.agent_id, event.platform, event.account_id, event.conversation_id, Math.floor(Date.parse(event.timestamp) / 1800000))
              const segment = this.memory.get(segmentId), refs = new Set(segment?.data.source_ids as string[] ?? []); refs.add(archived.id)
              if (segment) this.memory.update(segmentId, { data: { ...segment.data, source_ids: [...refs], last_at: event.timestamp } })
              else this.memory.put({ id: segmentId, kind: 'segment', title: `${event.platform} · ${event.conversation_id}`, text: '来源活动片段，原文按引用读取。', created_at: event.timestamp,
                source: archived.source, data: { source_ids: [archived.id], last_at: event.timestamp } })
            }
          }
          cursor = position
        }
        this.store.setRecord('memory-gateway', this.memory.agentId, cursor)
      })
    }
    for (const record of ['pending', 'sending'].flatMap(status => this.memory.find({ kind: 'speak', status, limit: 100 }))) {
      const output = record.source.event_id && this.store.output(record.source.event_id)
      if (output && output.status !== record.status) this.memory.update(record.id, { status: output.status })
    }
  }
  async observe(session: Session, event: SessionEvent): Promise<void> {
    if (!session.isOwnSeq(event.seq)) return
    const thought = this.consume(session.id, event)
    if (thought) await this.onThought(thought)
  }
  private consume(id: string, event: SessionEvent): MemoryRecord | undefined {
    const state = this.cursors.get(id) ?? this.store.record<NativeCursor>('memory-native', id)
    if (!state || event.seq < state.offset) return
    const binding = state.binding
    if(binding.branch==='main')captureVitality(this.store,this.memory.agentId,event)
    if (event.type === 'user/message' && ['dsh-amphoreus'].includes(event.data.source.kind)) {
      const run = this.store.run(String(event.data.id).replace(/^dsh-amphoreus:/, ''))
      if (run && binding.branch === 'main') { binding.run_id = run.run_id; binding.event_id = run.event_id }
    }
    if (event.type === 'request/header') { binding.provider = event.data.header.config.provider; binding.model = event.data.header.config.model }
    let thought: MemoryRecord | undefined
    const source = { ...binding, seq: Number(event.seq) }, created_at = new Date(event.time).toISOString()
    if (event.type === 'assistant/message') {
      source.turn = event.data.turn; source.step = event.data.step
      const text = blockText(event.data.message.content), status = event.data.interrupted ? 'interrupted' : 'complete'
      if (text) thought = this.memory.put({ source, created_at, id: memoryId(id, event.seq, 'assistant'), kind: 'assistant', title: binding.branch === 'main' ? '想法 / 自言自语' : '分支工作文本', text, status,
        data: { message_id: event.data.message.id, interrupted: !!event.data.interrupted } })
      const reasoning = event.data.message.content.filter(b => b.type === 'reasoning').map(b => b.text).join('\n')
      const permitted = !!binding.provider && this.memory.settings.reasoning.allowedProviders.includes(binding.provider)
      this.memory.put({ source, created_at, id: memoryId(id, event.seq, 'reasoning'), kind: 'reasoning', title: '接口提供的推理记录',
        text: permitted ? reasoning : '', status: !reasoning ? 'unavailable' : !permitted ? 'disabled' : status,
        ...(permitted && reasoning ? { expires_at: new Date(event.time + this.memory.settings.reasoning.retentionDays * 86400000).toISOString() } : {}),
        data: { available: !!reasoning, permitted, assistant_id: thought?.id, interrupted: !!event.data.interrupted } })
    } else if (event.type === 'compaction/summary') {
      this.memory.put({id:memoryId(id,event.seq,'role-compact'),kind:'segment',title:'角色经历压缩摘要',
        text:blockText(event.data.summary),created_at,source,status:'complete',
        data:{compaction_id:String(event.data.compactionId),shadowed_seqs:event.data.shadowedSeqs.map(Number),
          note:'摘要是可追溯记忆索引，不是新发言或新行动；原始历史仍保留。'}})
    } else if (event.type === 'tool/call') {
      this.memory.put({ source, created_at, id: memoryId(id, event.seq), kind: 'tool', title: `调用 ${event.data.name}`,
        text: JSON.stringify(redact({ tool: event.data.name, call_id: event.data.callId, arguments: parsedArguments(event.data.arguments) }, this.secrets)), status: 'requested', data: { direction: 'call' } })
    } else if (event.type === 'tool/result') {
      this.memory.put({ source, created_at, id: memoryId(id, event.seq), kind: 'tool', title: '工具执行结果',
        text: JSON.stringify(redact({ call_id: event.data.message.toolCallId, content: event.data.message.content, is_error: !!event.data.message.isError }, this.secrets)),
        status: event.data.message.isError ? 'failed' : 'completed', data: { direction: 'result' } })
    }
    state.offset = Number(event.seq) + 1
    this.cursors.set(id, state); this.store.setRecord('memory-native', id, state)
    return thought?.source.branch === 'main' ? thought : undefined
  }
  async backfill(bindings: ArchiveBinding[]): Promise<void> {
    this.captureGateway()
    for (const binding of bindings) {
      this.bind(binding)
      if (!await this.ctx.sessionPersistence.stat(binding.session_id as SessionId)) continue
      await using handle = await this.ctx.sessionPersistence.open(binding.session_id as SessionId, 'read')
      let offset = Math.max(handle.inheritedEventCount, this.cursors.get(binding.session_id)!.offset)
      for (;;) {
        const { events } = await handle.read(offset, 250)
        if (!events.length) break
        for (const event of events) { const thought = this.consume(binding.session_id, event); if (thought) await this.onThought(thought) }
        offset += events.length
      }
    }
    this.captureGateway()
  }
}
