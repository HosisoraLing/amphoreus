import type { AmphoreusRuntime } from './runtime.ts'
import { MemoryStore, memoryId, type MemoryRecord } from './memory.ts'
import type { MemoryAuthor } from './recollection.ts'

/** Incremental review runs in a continuation; only Main can adopt diaries or Self. */
export class Dreaming {
  private timer?: ReturnType<typeof setInterval>
  constructor(readonly memory: MemoryStore, private readonly runtime: AmphoreusRuntime) {}
  start(): void {
    const tick = () => { this.memory.expire(); void this.schedule(false).catch(() => {
      this.runtime.store.setRecord('error', 'dreaming', { error: '回顾调度未完成，将在下一轮重试；历史记录保留。' })
      this.runtime.onChange()
    }) }
    tick()
    this.timer = setInterval(tick, 60000); this.timer.unref()
  }
  stop(): void { clearInterval(this.timer) }
  status() { return { enabled: this.memory.settings.dreaming.enabled, at: this.memory.settings.dreaming.at, time_zone: this.memory.settings.timeZone,
    not_before: this.runtime.store.record<string>('dreaming-not-before', this.memory.agentId) ?? null,
    cursor: this.runtime.store.record<number>('dreaming-cursor', this.memory.agentId) ?? 0, jobs: this.memory.recent(20, 0, 'consolidation') } }
  async schedule(force: boolean, requestId?: string) {
    if(!this.runtime.controls.enabled)return
    this.reconcile()
    const existing = this.memory.find({ kind: 'consolidation', limit: 100, historical: true }).find(j => ['scheduled','running','waiting','paused'].includes(j.status))
    if (existing) { await this.dispatch(existing); return this.memory.get(existing.id) }
    // A schedule moved to an earlier hour starts at its next occurrence, without a daytime catch-up.
    if (!force && Date.parse(this.memory.now()) < Date.parse(this.runtime.store.record<string>('dreaming-not-before', this.memory.agentId) ?? '')) return
    const clock = new Intl.DateTimeFormat('en-GB', { timeZone: this.memory.settings.timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(this.memory.now()))
    if (!force && (!this.memory.settings.dreaming.enabled || clock < this.memory.settings.dreaming.at)) return
    const id = memoryId('dreaming', this.memory.agentId, force ? requestId ?? this.memory.now() : this.memory.today())
    const saved = this.memory.get(id)
    if (saved) return saved
    const from = this.runtime.store.record<number>('dreaming-cursor', this.memory.agentId) ?? 0, to = this.memory.position()
    if (!this.memory.range(from, to, 1).length) return
    const job = this.memory.put({ id, kind: 'consolidation', title: `${this.memory.today()} · 自主回顾`, text: '潜意识后台回顾，草稿待Main审阅，不是已完成的日记。',
      created_at: this.memory.now(), source: { actor_id: 'memory-review-scheduler', branch: 'main' }, status: 'scheduled', data: { from, to, event_id: memoryId('dream-event', id), task_ids: [], cursor_advanced: false } })
    await this.dispatch(job)
    this.runtime.onChange(); return this.memory.get(id)
  }
  private async dispatch(job: MemoryRecord): Promise<void> {
    const eventId=String(job.data.event_id)
    if(!this.runtime.store.event(eventId))await this.emit(job)
    this.runtime.startReview(eventId,`夜间回顾，job_id=${job.id}。今天是${this.memory.today()}（北京时间）。用memory_review_read分页读增量，跳过回顾自身的工具流水与历史导入件；按需memory_read查原文。可提出灵感、diary_draft和self_draft，均带job_id，日记日期用今天，较早经历标明发生日。只提候选，不确认正式日记或Self，不强制写日记，不把想法当行动。完成后用report_to_main简报候选ID与要点，交Main审阅；无需逐页报进度，不对外发言。`)
  }
  private async emit(job: MemoryRecord): Promise<void> {
    const id = job.id
    await this.runtime.gateway.ingest('internal', { agent_id: this.memory.agentId, event_id: String(job.data.event_id), source_kind: 'internal', platform: 'internal', account_id: this.memory.agentId,
      conversation_id: 'memory-review', actor_id: 'memory-review-scheduler', event_type: 'memory.review', timestamp: this.memory.now(), correlation_id: null,
      content: [{ type: 'text', text: `潜意识夜间回顾 ${id}，草稿完成后交Main审阅。` }],
      metadata: { job_id: id, schedule: false }, visibility: 'internal', idempotency_key: `dreaming:${id}` })
  }
  /** Explicit recovery reuses persisted candidates; it never reruns the continuation. */
  async reviewReady(id: string, requestId: string) {
    const job=this.memory.get(id)
    if(job?.kind!=='consolidation')throw new Error('Review job not found')
    if(['reviewed','skipped'].includes(job.status))return job
    const candidates=this.memory.jobRecords(id).filter(record=>record.status==='candidate')
    if(!candidates.length)throw new Error('No saved candidates; inspect the continuation before retrying')
    if(candidates.some(record=>record.source.task_id&&['running','queued'].includes(this.runtime.store.task(record.source.task_id)?.state??'')))throw new Error('Review branch is still running')
    await this.runtime.gateway.ingest('internal',{agent_id:this.memory.agentId,source_kind:'internal',platform:'internal',account_id:this.memory.agentId,
      conversation_id:'memory-review',actor_id:'memory-review-scheduler',event_type:'memory.review.ready',timestamp:this.memory.now(),correlation_id:null,
      content:[{type:'text',text:`仅恢复回顾${id}的审阅，不重新整理。已有候选：${candidates.map(record=>`${record.kind}:${record.id}`).join('，')}。核对并确认或归档后dreaming_finish；已完成的操作勿重复。`}],
      metadata:{job_id:id},visibility:'internal',idempotency_key:`dream-review:${id}:${requestId}`})
    return this.memory.get(id)
  }
  read(id: string, limit = 8, offset = 0) {
    const job = this.memory.get(id)
    if (job?.kind !== 'consolidation') throw new Error('Review job not found')
    const records = this.memory.range(Number(job.data.from), Number(job.data.to), limit, offset)
    return { job_id: id, records, next_offset: records.length === limit ? offset + records.length : null }
  }
  finish(id: string, note: string, author: MemoryAuthor, skip: boolean) {
    if (author.branch !== 'main' || !author.source.run_id) throw new Error('Only Main may finish a personal review')
    const job = this.memory.get(id)
    if (job?.kind !== 'consolidation') throw new Error('Review job not found')
    const drafts = this.memory.jobRecords(id).filter(r => ['diary_draft','self_draft'].includes(r.kind) && r.status === 'candidate')
    if (drafts.length) throw new Error('Main must confirm or archive pending personal drafts before closing the review')
    const taskIds = this.runtime.store.tasks({ agentId: this.memory.agentId, limit: 1000 }).filter(t => t.origin?.event_id === job.data.event_id && t.kind === 'continuation')
    if (taskIds.some(t => ['running','queued'].includes(t.state))) throw new Error('The review branch is still running; do not synchronously wait for it')
    this.runtime.store.setRecord('dreaming-cursor', this.memory.agentId, Math.max(Number(job.data.to), this.runtime.store.record<number>('dreaming-cursor', this.memory.agentId) ?? 0))
    return this.memory.update(id, { status: skip ? 'skipped' : 'reviewed', data: { ...job.data, cursor_advanced: true, reviewed_by: author.source, review_note: note } })
  }
  reconcile(): void {
    for (const job of this.memory.find({ kind: 'consolidation', limit: 100, historical: true }).filter(j => !['reviewed','skipped'].includes(j.status))) {
      const tasks = this.runtime.store.tasks({ agentId: this.memory.agentId, limit: 1000 }).filter(t => t.origin?.event_id === job.data.event_id && t.kind === 'continuation')
      if (!tasks.length) {
        const event = this.runtime.store.event(String(job.data.event_id))
        if (event?.state === 'failed' && job.status !== 'failed') this.memory.update(job.id, { status: 'failed', data: { ...job.data, main_error: event.error } })
        continue
      }
      const status = tasks.some(t => t.state === 'running' || t.state === 'queued') ? 'running' : tasks.some(t => t.state === 'failed' || t.state === 'cancelled') ? 'failed'
        : tasks.some(t => t.state === 'paused') ? 'paused' : tasks.some(t => t.state === 'waiting') ? 'waiting' : 'awaiting_review'
      const ids = tasks.map(t => t.task_id)
      if (status === 'awaiting_review') this.runtime.store.setRecord('dreaming-cursor', this.memory.agentId, Math.max(Number(job.data.to), this.runtime.store.record<number>('dreaming-cursor', this.memory.agentId) ?? 0))
      if (status !== job.status || JSON.stringify(ids) !== JSON.stringify(job.data.task_ids)) this.memory.update(job.id, { status, data: { ...job.data, task_ids: ids, cursor_advanced: job.data.cursor_advanced || status === 'awaiting_review' } })
    }
  }
}
