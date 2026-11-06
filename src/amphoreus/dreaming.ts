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
    const existing = this.memory.find({ kind: 'consolidation', limit: 100, historical: true }).find(j => !j.data.backfill&&['scheduled','running','waiting','paused','incomplete'].includes(j.status))
    if (existing) { if(existing.status!=='incomplete')await this.dispatch(existing); return this.memory.get(existing.id) }
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
      created_at: this.memory.now(), source: { actor_id: 'memory-review-scheduler', branch: 'main' }, status: 'scheduled', data: { from, to, event_id: memoryId('dream-event', id), task_ids: [], cursor_advanced: false,
        ...(this.memory.settings.dreaming.consolidation?{protocol:2,processed_position:from}:{} ) } })
    await this.dispatch(job)
    this.runtime.onChange(); return this.memory.get(id)
  }
  private async dispatch(job: MemoryRecord): Promise<void> {
    const eventId=String(job.data.event_id)
    if(!this.runtime.store.event(eventId))await this.emit(job)
    this.runtime.startReview(eventId,`夜间回顾，job_id=${job.id}。今天是${this.memory.today()}（北京时间）。用memory_review_read分页读增量，跳过回顾自身的工具流水${job.data.backfill?'':'与历史导入件'}；按需memory_read查原文。可提出灵感、diary_draft和self_draft，均带job_id，日记日期用今天，较早经历标明发生日。只提候选，不确认正式日记或Self，不强制写日记，不把想法当行动。${job.data.protocol===2?'逐批提炼有长期价值的事实、偏好、约定、关系、项目进展、问题和创造性联想，用memorize(candidate/insight)带category/evidence_type/source_ids/job_id保存。只有原始来信才作explicit证据，成功行动需真实回执，内部想法标为inferred；缺少日期不猜有效期。每批用memory_review_commit提交batch_id、候选ID及处理说明；允许candidate_ids=[]，说明本批没有值得提炼内容。按next_position继续，必须提交至complete。中断后读取已提交位置，勿跳过未读记录。':''}完成后用report_to_main简报候选ID与要点，交Main审阅；无需逐页报进度，不对外发言。`)
  }
  async backfill(from:number,to:number,requestId:string){
    if(!Number.isInteger(from)||!Number.isInteger(to)||from<0||to<=from||to>this.memory.position())throw Error('Invalid frozen backfill window')
    const id=memoryId('dreaming-backfill',this.memory.agentId,requestId),saved=this.memory.get(id)
    if(saved)return saved
    const job=this.memory.put({id,kind:'consolidation',title:'历史巩固回填',text:'独立历史窗口，不改变日常回顾游标。',created_at:this.memory.now(),source:{branch:'main'},status:'scheduled',
      data:{from,to,protocol:2,processed_position:from,backfill:true,event_id:memoryId('dream-event',id),task_ids:[],cursor_advanced:false}})
    await this.dispatch(job);return this.memory.get(id)
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
    if(!candidates.length&&!(job.data.protocol===2&&Number(job.data.processed_position)>=Number(job.data.to)))throw new Error('No saved candidates; inspect the continuation before retrying')
    if(candidates.some(record=>record.source.task_id&&['running','queued'].includes(this.runtime.store.task(record.source.task_id)?.state??'')))throw new Error('Review branch is still running')
    await this.runtime.gateway.ingest('internal',{agent_id:this.memory.agentId,source_kind:'internal',platform:'internal',account_id:this.memory.agentId,
      conversation_id:'memory-review',actor_id:'memory-review-scheduler',event_type:'memory.review.ready',timestamp:this.memory.now(),correlation_id:null,
      content:[{type:'text',text:`仅恢复回顾${id}的审阅，不重新整理。已有候选：${candidates.map(record=>`${record.kind}:${record.id}`).join('，')}。核对并确认或归档后dreaming_finish；已完成的操作勿重复。`}],
      metadata:{job_id:id},visibility:'internal',idempotency_key:`dream-review:${id}:${requestId}`})
    return this.memory.get(id)
  }
  read(id: string, limit = 8, offset = 0,after?:number) {
    const job = this.memory.get(id)
    if (job?.kind !== 'consolidation') throw new Error('Review job not found')
    if(job.data.protocol===2){
      const from=after??Number(job.data.processed_position??job.data.from),to=Number(job.data.to)
      if(from<Number(job.data.from)||from>to)throw Error('Review cursor is outside its frozen window')
      const rows=this.memory.rangeAfter(from,to,limit+1),complete=rows.length<=limit,records=rows.slice(0,limit)
      const next=complete?to:records.at(-1)!.position,batchId=memoryId('review-batch',id,from,next,records.map(record=>record.id))
      this.runtime.store.setRecord('dreaming-batch',batchId,{job_id:id,from,to:next,ids:records.map(record=>record.id),complete})
      return{job_id:id,batch_id:batchId,records:records.map(({text,...record})=>({...record,excerpt:text.slice(0,200),total_chars:text.length})),next_position:next,complete,next_offset:null}
    }
    const records = this.memory.range(Number(job.data.from), Number(job.data.to), limit, offset)
    return { job_id: id, records, next_offset: records.length === limit ? offset + records.length : null }
  }
  commit(id:string,batchId:string,candidateIds:string[],note:string,author:MemoryAuthor){
    if(!['main','continuation'].includes(author.branch))throw Error('Only Main or its continuation may commit review progress')
    const job=this.memory.get(id),batch=this.runtime.store.record<{job_id:string;from:number;to:number;ids:string[]}>('dreaming-batch',batchId)
    if(job?.kind!=='consolidation'||job.data.protocol!==2||batch?.job_id!==id)throw Error('Review batch not found')
    if(author.branch==='continuation'){
      const task=author.source.task_id?this.runtime.store.task(author.source.task_id):undefined
      if(!task||task.kind!=='continuation'||task.origin?.event_id!==job.data.event_id)throw Error('Review progress belongs to another continuation')
    }
    if(author.branch==='main'&&!author.source.run_id)throw Error('Main review progress needs an active Run')
    if(this.runtime.store.record('dreaming-batch-commit',batchId))return job
    if(!note.trim())throw Error('A processing note is required, including for zero candidates')
    if(Number(job.data.processed_position)>batch.to)return job
    if(Number(job.data.processed_position)!==batch.from&&Number(job.data.processed_position)!==batch.to)throw Error('Batch is not the next unprocessed range')
    for(const candidateId of candidateIds){
      const candidate=this.memory.get(candidateId)
      if(!candidate||!['candidate','insight'].includes(candidate.kind)||candidate.data.job_id!==id||!(candidate.data.source_ids as string[]??[]).some(ref=>batch.ids.includes(ref)))throw Error('Candidate does not have evidence in this review batch')
    }
    return this.memory.host.atomic(()=>{
      this.runtime.store.setRecord('dreaming-batch-commit',batchId,{at:this.memory.now(),candidate_ids:candidateIds,note,source:author.source})
      return this.memory.update(id,{data:{...job.data,processed_position:Math.max(Number(job.data.processed_position),batch.to)}})
    })
  }
  resume(id:string){
    const job=this.memory.get(id)
    if(job?.kind!=='consolidation'||!['incomplete','failed','paused','waiting'].includes(job.status))throw Error('Review is not resumable')
    const tasks=this.runtime.store.tasks({agentId:this.memory.agentId,limit:1000}).filter(task=>task.origin?.event_id===job.data.event_id&&task.kind==='continuation')
    if(tasks.length!==1)throw Error('Inspect the review branch before resuming')
    this.runtime.controlTask(tasks[0]!.task_id,'resume')
    return this.memory.update(id,{status:'scheduled'})
  }
  finish(id: string, note: string, author: MemoryAuthor, skip: boolean) {
    if (author.branch !== 'main' || !author.source.run_id) throw new Error('Only Main may finish a personal review')
    const job = this.memory.get(id)
    if (job?.kind !== 'consolidation') throw new Error('Review job not found')
    if(job.data.protocol===2&&Number(job.data.processed_position)<Number(job.data.to))throw Error('Review has unprocessed history batches')
    const drafts = this.memory.jobRecords(id).filter(r => ['diary_draft','self_draft'].includes(r.kind) && r.status === 'candidate')
    if (drafts.length) throw new Error('Main must confirm or archive pending personal drafts before closing the review')
    const taskIds = this.runtime.store.tasks({ agentId: this.memory.agentId, limit: 1000 }).filter(t => t.origin?.event_id === job.data.event_id && t.kind === 'continuation')
    if (taskIds.some(t => ['running','queued'].includes(t.state))) throw new Error('The review branch is still running; do not synchronously wait for it')
    if(!job.data.backfill)this.runtime.store.setRecord('dreaming-cursor', this.memory.agentId, Math.max(Number(job.data.to), this.runtime.store.record<number>('dreaming-cursor', this.memory.agentId) ?? 0))
    return this.memory.update(id, { status: skip ? 'skipped' : 'reviewed', data: { ...job.data, cursor_advanced: !job.data.backfill, reviewed_by: author.source, review_note: note } })
  }
  reconcile(): void {
    for (const job of this.memory.find({ kind: 'consolidation', limit: 100, historical: true }).filter(j => !['reviewed','skipped'].includes(j.status))) {
      const tasks = this.runtime.store.tasks({ agentId: this.memory.agentId, limit: 1000 }).filter(t => t.origin?.event_id === job.data.event_id && t.kind === 'continuation')
      if (!tasks.length) {
        const event = this.runtime.store.event(String(job.data.event_id))
        if (event?.state === 'failed' && job.status !== 'failed') this.memory.update(job.id, { status: 'failed', data: { ...job.data, main_error: event.error } })
        continue
      }
      let status = tasks.some(t => t.state === 'running' || t.state === 'queued') ? 'running' : tasks.some(t => t.state === 'failed' || t.state === 'cancelled') ? 'failed'
        : tasks.some(t => t.state === 'paused') ? 'paused' : tasks.some(t => t.state === 'waiting') ? 'waiting' : 'awaiting_review'
      const ids = tasks.map(t => t.task_id)
      if(status==='awaiting_review'&&job.data.protocol===2&&Number(job.data.processed_position)<Number(job.data.to))status='incomplete'
      if (status === 'awaiting_review'&&!job.data.backfill) this.runtime.store.setRecord('dreaming-cursor', this.memory.agentId, Math.max(Number(job.data.to), this.runtime.store.record<number>('dreaming-cursor', this.memory.agentId) ?? 0))
      if (status !== job.status || JSON.stringify(ids) !== JSON.stringify(job.data.task_ids)) this.memory.update(job.id, { status, data: { ...job.data, task_ids: ids, cursor_advanced: job.data.cursor_advanced || status === 'awaiting_review'&&!job.data.backfill } })
    }
  }
}
