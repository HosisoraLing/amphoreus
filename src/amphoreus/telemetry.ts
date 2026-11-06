/** Compact, idempotent accounting facts and private operational logs; never store prompt bodies. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { lastAssistantStreamChunk, type TokenUsage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { MemoryStore } from './memory.ts'
import type { AmphoreusStore } from './store.ts'
import type { ArchiveBinding } from './archive.ts'
import { redact } from './activity.ts'
import {inspectMemory} from './memory-health.ts'
import { StatisticsSettings, beijingDay, price, pricingSnapshot, type Usage } from './pricing.ts'

type Scope = ArchiveBinding['branch'] | 'organizer' | 'meme'
type Cursor = { offset: number; provider?: string; model?: string; cycle?: number; stepAt?: number; run?: string; event?: string; compaction?:{id:string;at:number;before:number|null;summary?:number} }
type Fact = { id: string; at: string; session: string; scope: Scope; task?: string; run?: string; event?: string; kind: string; level: string;
  provider?: string; model?: string; summary: string; data: Record<string, unknown> }
export type StatisticsQuery = { since?: string; until?: string; scope?: string; session?: string }
const n = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
const usageOf = (u: TokenUsage): Usage => ({ input: n(u.inputTokens), output: n(u.outputTokens), read: n(u.cacheReadTokens), write: n(u.cacheWriteTokens) })
const mean = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null

/** Statistics belong to the current role and exclude a fork's inherited prefix. */
export class Telemetry {
  measure?:(session:Pick<Session,'id'|'isOwnSeq'>)=>number|null
  private nextAudit=0
  metric(kind:string,session:string,data:Record<string,unknown>,binding?:ArchiveBinding){
    if(!this.memory.settings.observability.enabled)return
    this.write({id:randomUUID(),at:this.now().toISOString(),session,scope:binding?.branch??'main',run:binding?.run_id,event:binding?.event_id,task:binding?.task_id,
      kind,level:'info',summary:({memory_find:'记忆检索',social_context:'社交附加上下文',context_before_wake:'唤醒前上下文'} as Record<string,string>)[kind]??kind,data},true)
  }
  alert(key:string,message:string,data:Record<string,unknown>={}){
    const id=`${this.memory.agentId}:${key}`,old=this.store.record<{active:boolean}>('memory-alert',id)
    const safe=JSON.parse(JSON.stringify(redact(data,this.secrets)).replace(/\b(?:oc_sk_|npm_|sk-)[A-Za-z0-9_-]{10,}/g,'[密钥已隐藏]'))
    this.store.setRecord('memory-alert',id,{key,agent_id:this.memory.agentId,active:true,message,at:this.now().toISOString(),data:safe})
    if(!old?.active)this.write({id:randomUUID(),at:this.now().toISOString(),session:'memory-health',scope:'main',kind:'memory_invariant',level:'error',summary:message,data:{key,...safe}},true)
  }
  private resolved(key:string){
    const id=`${this.memory.agentId}:${key}`,old=this.store.record<Record<string,unknown>>('memory-alert',id)
    if(old?.active)this.store.setRecord('memory-alert',id,{...old,active:false,resolved_at:this.now().toISOString()})
  }
  health(){return{...inspectMemory(this.memory,this.store,this.now().getTime()),alerts:this.store.records<{agent_id:string;active:boolean;message:string}>('memory-alert').filter(row=>row.agent_id===this.memory.agentId&&row.active)}}
  audit(force=false){
    if(!this.memory.settings.observability.enabled||!force&&this.now().getTime()<this.nextAudit)return
    this.nextAudit=this.now().getTime()+this.memory.settings.observability.intervalMs
    for(const check of this.health().checks)if(check.failed)this.alert(check.key,check.message,check.data);else this.resolved(check.key)
  }
  private settingsValue?: StatisticsSettings
  private nextPrune = 0
  constructor(readonly memory: MemoryStore, readonly store: AmphoreusStore, private readonly secrets: string[] = [], private readonly now = () => new Date()) {
    memory.host.db.exec(`CREATE TABLE IF NOT EXISTS amphoreus_metric (
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, at TEXT NOT NULL, session TEXT NOT NULL, scope TEXT NOT NULL,
      task TEXT, run TEXT, event TEXT, kind TEXT NOT NULL, level TEXT NOT NULL, provider TEXT, model TEXT, summary TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS amphoreus_metric_range ON amphoreus_metric(agent_id,at);
      CREATE INDEX IF NOT EXISTS amphoreus_metric_session ON amphoreus_metric(agent_id,session,at);
      CREATE TABLE IF NOT EXISTS amphoreus_log (
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, at TEXT NOT NULL, session TEXT NOT NULL, scope TEXT NOT NULL,
      task TEXT, run TEXT, event TEXT, kind TEXT NOT NULL, level TEXT NOT NULL, provider TEXT, model TEXT, summary TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS amphoreus_log_range ON amphoreus_log(agent_id,at);`)
    this.prune()
  }
  settings() { return this.settingsValue ??= StatisticsSettings.parse(this.store.record('statistics-settings', this.memory.agentId) ?? {}) }
  configure(value: unknown) { const settings = StatisticsSettings.parse(value); this.store.setRecord('statistics-settings', this.memory.agentId, settings); this.settingsValue = settings; this.prune(); return settings }
  private prune() { this.nextPrune = this.now().getTime() + 86400000; this.memory.host.db.prepare('DELETE FROM amphoreus_log WHERE agent_id=? AND at<?').run(this.memory.agentId, new Date(this.now().getTime() - this.settings().logRetentionDays * 86400000).toISOString()) }
  private write(fact: Fact, metric = false) {
    if (this.now().getTime() >= this.nextPrune) this.prune()
    const safe = redact(fact.data, this.secrets) as Record<string,unknown>
    for(const key of ['tokens','context_tokens_before','context_tokens_after'])if(fact.data[key]===null||typeof fact.data[key]==='number'&&Number.isFinite(fact.data[key]))safe[key]=fact.data[key]
    const values = [fact.id, this.memory.agentId, fact.at, fact.session, fact.scope, fact.task ?? null, fact.run ?? null, fact.event ?? null,
      fact.kind, fact.level, fact.provider ?? null, fact.model ?? null, fact.summary, JSON.stringify(safe)]
    if (metric) this.memory.host.db.prepare('INSERT OR IGNORE INTO amphoreus_metric VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(...values)
    if (Date.parse(fact.at) >= this.now().getTime() - this.settings().logRetentionDays * 86400000)
      this.memory.host.db.prepare('INSERT OR IGNORE INTO amphoreus_log VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(...values)
  }
  operation(kind: string, id: string, status: string, error = '', at = this.now().toISOString(), historical = false) {
    // IDs/status are system-owned. No message, tool arguments, output content or account credentials enter this log.
    const task = kind === 'task' ? this.store.task(id) : undefined
    const run = kind === 'run' ? this.store.run(id) : undefined
    const output = kind === 'output' ? this.store.output(id) : undefined
    const origin = kind === 'message' ? this.store.event(id)?.event : output ? this.store.event(output.event_id)?.event : undefined
    const level = /failed|unknown|interrupted|mail-failed/.test(status) ? 'error' : /cancelled|paused/.test(status) ? 'warn' : 'info'
    const cleanError = String(redact(error, this.secrets)).replace(/sk-[a-zA-Z0-9_-]{12,}/g, '[密钥已隐藏]').replace(/(?:api[_-]?key|token|password|secret)\s*[:=]\s*[^\s,;]+/gi, '[凭证已隐藏]').replace(/https?:\/\/\S+/g, '[地址已隐藏]').slice(0, 1200)
    const kinds:Record<string,string>={message:'消息',output:'发送',run:'主会话',task:'后台任务',management:'管理操作',runtime:'系统'}
    const states:Record<string,string>={received:'已收到',queued:'排队中',processing:'处理中',processed:'已处理',running:'运行中',completed:'已完成',failed:'失败',sent:'已发送',sending:'发送中',pending:'待发送',unknown:'结果未知',interrupted:'已中断',cancelled:'已取消',paused:'已暂停',waiting:'等待中',requested:'已请求'}
    this.write({ id: historical ? `snapshot:${kind}:${id}:${status}` : randomUUID(), at, session: task?.subagent_id ?? run?.session_id ?? '', scope: task?.kind ?? 'main', kind, level,
      ...(kind === 'message' || kind === 'output' ? { event: output?.event_id ?? id } : kind === 'run' ? { run: id, event: run?.event_id } : kind === 'task' ? { task: id } : {}),
      summary: `${kinds[kind]??kind} · ${states[status]??status}`, data: { status, reference: id, ...(origin ? {platform:origin.platform,conversation:origin.conversation_id} : {}),
        ...(cleanError ? { error: cleanError } : {}), ...(historical ? { historical: true } : {}) } })
  }
  observe(session: Pick<Session, 'id' | 'isOwnSeq'>, binding: ArchiveBinding, event: SessionEvent) {
    if (session.isOwnSeq(event.seq)) this.consume(String(session.id), binding, event,session)
  }
  private consume(id: string, binding: ArchiveBinding, event: SessionEvent,session?:Pick<Session,'id'|'isOwnSeq'>) {
    const state = this.store.record<Cursor>('statistics-native', id) ?? { offset: 0 }
    if (event.seq < state.offset) return
    const at = new Date(event.time).toISOString(), base = { id: `native:${id}:${event.seq}`, at, session: id, scope: binding.branch,
      task: binding.task_id, run: state.run ?? binding.run_id, event: state.event ?? binding.event_id, provider: state.provider, model: state.model, level: 'info' }
    if (event.type === 'request/header') {
      const next=event.data.header.config.provider,allowed=this.memory.settings.reasoning.allowedProviders
      if(state.provider&&state.provider!==next&&allowed.includes(state.provider)!==allowed.includes(next))this.alert('reasoning-provider-change','模型提供方切换改变了推理归档可用性',{previous:state.provider,next,allowed:allowed.includes(next)})
      state.provider = next; state.model = event.data.header.config.model
    }
    if(event.type==='compaction/start'){
      state.compaction={id:String(event.data.compactionId),at:event.time,before:session&&this.measure?this.measure(session):null}
      this.write({...base,kind:'compaction_attempt',summary:'原生上下文压缩开始',data:{compaction_id:state.compaction.id,context_tokens_before:state.compaction.before}},true)
    }else if(event.type==='compaction/end'){
      const checkpoint=state.compaction,after=session&&this.measure?this.measure(session):null,error=event.data.error
      this.write({...base,kind:'compaction_result',level:error?'error':'info',summary:error?'原生压缩失败':'原生压缩结束',data:{compaction_id:String(event.data.compactionId),status:error?'failed':'completed',
        context_tokens_before:checkpoint?.before??null,context_tokens_after:after,reduced:checkpoint?.before!=null&&after!=null?after<checkpoint.before:null,duration_ms:checkpoint?event.time-checkpoint.at:null,summary_event_seq:checkpoint?.summary??null,...(error?{error}: {})}},true)
      if(error)this.alert(`compaction:${id}`,'原生上下文压缩失败',{session:id,error})
      else if(checkpoint?.before!=null&&after!=null&&after>=checkpoint.before)this.alert(`compaction:${id}`,'原生压缩结束后上下文未减少',{session:id,before:checkpoint.before,after})
      else this.resolved(`compaction:${id}`)
      state.compaction=undefined
    }
    if (event.type === 'step/start') state.stepAt = event.time
    if (event.type === 'turn/start' && state.cycle === undefined) state.cycle = event.time
    if (event.type === 'user/message' && ['dsh-amphoreus'].includes(event.data.source.kind)) {
      const run = this.store.run(String(event.data.id).replace(/^dsh-amphoreus:/, ''))
      if (run) { state.run = run.run_id; state.event = run.event_id; base.run = run.run_id; base.event = run.event_id }
    }
    if (event.type === 'assistant/message' || event.type === 'assistant/attempt') {
      const u = event.type === 'assistant/message' ? event.data.usage : lastAssistantStreamChunk(event.data.stream, 'usage')?.usage
      const source = event.type === 'assistant/message' ? event.data.message.source : undefined
      const failure = lastAssistantStreamChunk(event.data.stream, 'finish')?.reason
      this.write({ ...base, provider: source?.provider ?? state.provider, model: source?.model ?? state.model, kind: 'usage',
        level: event.type === 'assistant/attempt' || ('interrupted' in event.data && event.data.interrupted) ? 'warn' : 'info', summary: u ? '模型请求结算' : '模型请求未返回用量',
        data: { ...(u ? usageOf(u) : {}), usage_available: !!u, attempt: event.type === 'assistant/attempt', interrupted: 'interrupted' in event.data && !!event.data.interrupted,
          duration_ms: state.stepAt === undefined ? null : Math.max(0, event.time - state.stepAt), finish: failure?.kind ?? 'unknown' } }, true)
    } else if (event.type === 'tool/call') {
      this.write({ ...base, kind: 'tool', summary: `调用 ${event.data.name}`, data: { tool: event.data.name, call_id: event.data.callId } }, true)
    } else if (event.type === 'tool/result') {
      this.write({ ...base, kind: 'tool-result', level: event.data.message.isError ? 'error' : 'info', summary: event.data.message.isError ? '工具执行失败' : '工具执行完成',
        data: { call_id: event.data.message.toolCallId, is_error: !!event.data.message.isError } })
    } else if (event.type === 'compaction/summary') {
      if(state.compaction)state.compaction.summary=Number(event.seq)
      this.write({ ...base, provider: event.data.provider, model: event.data.model, kind: 'compaction', summary: '上下文压缩完成',
        data: { ...(event.data.usage ? usageOf(event.data.usage) : {}), usage_available: !!event.data.usage,
          cycle_ms: state.cycle === undefined ? null : Math.max(0, event.time - state.cycle), compaction_id: String(event.data.compactionId) } }, true)
      state.cycle = event.time
    } else if (event.type === 'turn/start' || event.type === 'turn/end') {
      this.write({ ...base, kind: event.type, summary: event.type === 'turn/start' ? 'Agent 激活' : 'Agent 本轮结束', data: {} }, true)
    }
    state.offset = Number(event.seq) + 1; this.store.setRecord('statistics-native', id, state)
  }
  auxiliary(provider: string, model: string, usage: TokenUsage | undefined, duration: number, ok: boolean, scope: Scope = 'organizer') {
    this.write({ id: randomUUID(), at: this.now().toISOString(), session: scope==='meme'?'meme-learning':'topic-organizer', scope, provider, model, kind: 'usage',
      level: ok ? 'info' : 'warn', summary: scope==='meme'?'表情图片识别请求':'后台话题整理请求', data: { ...(usage ? usageOf(usage) : {}), usage_available: !!usage, duration_ms: duration, attempt: !ok } }, true)
  }
  async backfill(ctx: Context, bindings: ArchiveBinding[]) {
    for (const binding of bindings) {
      if (!await ctx.sessionPersistence.stat(binding.session_id as SessionId)) continue
      await using handle = await ctx.sessionPersistence.open(binding.session_id as SessionId, 'read')
      let offset = Math.max(handle.inheritedEventCount, this.store.record<Cursor>('statistics-native', binding.session_id)?.offset ?? 0)
      for (;;) {
        const { events } = await handle.read(offset, 250)
        if (!events.length) break
        this.memory.host.atomic(() => { for (const event of events) this.consume(binding.session_id, binding, event) })
        offset += events.length
      }
    }
    if (!this.store.record('statistics-snapshots', this.memory.agentId)) this.memory.host.atomic(() => {
      for (const row of this.memory.host.db.prepare('SELECT event_id,state,error,received_at FROM amphoreus_event WHERE agent_id=?').all(this.memory.agentId))
        this.operation('message', String(row.event_id), String(row.state), String(row.error), String(row.received_at), true)
      for (const run of this.store.runs(100000)) if (run.agent_id === this.memory.agentId) this.operation('run', run.run_id, run.state, run.error, run.finished_at ?? run.started_at, true)
      for (const task of this.store.tasks({ agentId: this.memory.agentId, limit: 100000 })) this.operation('task', task.task_id, task.state, '', task.updated_at, true)
      for (const output of this.store.outputs(100000)) this.operation('output', output.event_id, output.status, output.error, output.updated_at, true)
      this.store.setRecord('statistics-snapshots', this.memory.agentId, true)
    })
  }
  private where(query: StatisticsQuery) {
    const clauses = ['agent_id=?'], values: (string | number)[] = [this.memory.agentId]
    if (query.since) { clauses.push('at>=?'); values.push(query.since) }
    if (query.until) { clauses.push('at<?'); values.push(query.until) }
    if (query.scope === 'subagents') clauses.push("scope!='main'")
    else if (query.scope && query.scope !== 'all') { clauses.push('scope=?'); values.push(query.scope) }
    if (query.session) { clauses.push('session=?'); values.push(query.session) }
    return { clauses, values }
  }
  logs(query: StatisticsQuery & { level?: string; kind?: string; search?: string; before?: number; limit?: number }) {
    const { clauses, values } = this.where(query), limit = Math.min(200, Math.max(1, query.limit ?? 50))
    if (query.level) { clauses.push('level=?'); values.push(query.level) }
    if (query.kind) { clauses.push('kind=?'); values.push(query.kind) }
    if (query.search) { clauses.push('(instr(lower(summary),lower(?))>0 OR instr(lower(data),lower(?))>0 OR instr(session,?)>0 OR instr(COALESCE(event,run,task,\'\'),?)>0)'); values.push(query.search, query.search, query.search, query.search) }
    if (query.before) { const cursor=this.memory.host.db.prepare('SELECT at FROM amphoreus_log WHERE agent_id=? AND rowid=?').get(this.memory.agentId,query.before); clauses.push('(at<? OR (at=? AND rowid<?))'); values.push(String(cursor?.at ?? ''),String(cursor?.at ?? ''),query.before) }
    const rows = this.memory.host.db.prepare(`SELECT rowid AS cursor,* FROM amphoreus_log WHERE ${clauses.join(' AND ')} ORDER BY at DESC,rowid DESC LIMIT ?`).all(...values, limit + 1)
    return { items: rows.slice(0, limit).map(row => ({ ...row, data: JSON.parse(String(row.data)) })), has_more: rows.length > limit,
      next_cursor: rows.length ? Number(rows[Math.min(limit, rows.length) - 1]!.cursor) : null, retention_days: this.settings().logRetentionDays }
  }
  statistics(query: StatisticsQuery = {}) {
    const db = this.memory.host.db, settings = this.settings(), { clauses, values } = this.where(query), now = this.now().getTime()
    const rows = db.prepare(`SELECT * FROM amphoreus_metric WHERE ${clauses.join(' AND ')} ORDER BY at,id`).all(...values).map(row => ({ ...row, data: JSON.parse(String(row.data)) as Record<string, unknown> })) as Fact[]
    const ledger = rows.filter(row => ['usage', 'compaction'].includes(String(row.kind)))
    const first = query.since ?? (db.prepare('SELECT MIN(at) AS at FROM amphoreus_metric WHERE agent_id=?').get(this.memory.agentId)?.at as string | null) ?? this.now().toISOString()
    const end = Math.min(now, query.until ? Date.parse(query.until) - 1 : now)
    const days = Math.max(1, Math.floor((Date.parse(beijingDay(end)) - Date.parse(beijingDay(first))) / 86400000) + 1)
    const summarize = (group: typeof ledger) => {
      const result = { requests: group.filter(row => row.kind === 'usage').length, missing_usage: 0, input: 0, output: 0, read: 0, write: 0, total: 0, cny: 0, usd: 0, unpriced: 0, cache_hit_rate: null as number | null, average_cache_hit_rate: null as number | null }
      const ratios: number[] = []
      for (const row of group) {
        const d = row.data
        if (!d.usage_available) { result.missing_usage++; continue }
        const u = { input: n(d.input), output: n(d.output), read: n(d.read), write: n(d.write) }, cost = price(String(row.provider ?? ''), String(row.model ?? ''), u, String(row.at), settings)
        for (const field of ['input', 'output', 'read', 'write'] as const) result[field] += u[field]
        const denominator = u.input + u.read + u.write
        if (denominator) ratios.push(u.read / denominator)
        if (cost.amount === null) result.unpriced++; else result[cost.currency === 'CNY' ? 'cny' : 'usd'] += cost.amount
      }
      result.total = result.input + result.output + result.read + result.write
      const denominator = result.input + result.read + result.write
      result.cache_hit_rate = denominator ? result.read / denominator : null; result.average_cache_hit_rate = mean(ratios)
      return result
    }
    const scopes = ['main','worker','continuation','topic','organizer','meme'], sessions = [...new Set(ledger.map(row => String(row.session)))]
    const total = summarize(ledger), allScopes = query.scope === undefined || query.scope === 'all' || query.scope === 'main'
    const runs = db.prepare('SELECT * FROM amphoreus_run WHERE agent_id=? AND started_at>=? AND started_at<=? ORDER BY started_at').all(this.memory.agentId, first, new Date(end).toISOString())
    const latencies: number[] = [], seen = new Set<string>()
    for (const row of db.prepare(`SELECT o.updated_at,o.value AS output,e.received_at,e.value AS origin FROM amphoreus_output o
      JOIN amphoreus_event oe ON oe.event_id=o.event_id JOIN amphoreus_event e ON e.event_id=oe.value ->> '$.metadata.origin_event_id'
      WHERE e.agent_id=? AND o.status='sent' AND e.received_at>=? AND e.received_at<=? ORDER BY o.updated_at`).all(this.memory.agentId, first, new Date(end).toISOString())) {
      const output = JSON.parse(String(row.output)), origin = JSON.parse(String(row.origin))
      if (origin.visibility === 'internal' || origin.source_kind === 'internal' || output.platform !== origin.platform || output.target.conversation_id !== origin.conversation_id || output.target.account_id !== origin.account_id || seen.has(origin.event_id)) continue
      seen.add(origin.event_id); latencies.push(Math.max(0, Date.parse(String(row.updated_at)) - Date.parse(String(row.received_at))))
    }
    const cycles = rows.filter(row => row.scope === 'main' && row.kind === 'compaction' && typeof row.data.cycle_ms === 'number').map(row => n(row.data.cycle_ms))
    // Window rates cover this application's observed usage; they are not account-wide remaining quotas.
    const goRows = db.prepare("SELECT * FROM amphoreus_metric WHERE agent_id=? AND kind IN ('usage','compaction') ORDER BY at").all(this.memory.agentId)
    const go = goRows.flatMap(row => { const d = JSON.parse(String(row.data)); if (!d.usage_available) return []; const cost = price(String(row.provider ?? ''), String(row.model ?? ''), d, String(row.at), settings); return cost.kind === 'opencode-go' ? [{ at: Date.parse(String(row.at)), ...cost }] : [] })
    const windows = [5 * 3600000, 7 * 86400000, 30 * 86400000].map((duration, i) => {
      const fraction = [.2, .5, 1][i]!, valid = go.filter(row => row.allowance !== null), start = Math.min(now, valid[0]?.at ?? now), current = valid.filter(row => row.at >= now - duration)
      const windowCount = Math.max(1, Math.ceil((now - start) / duration)), used = current.reduce((sum, row) => sum + row.allowance!, 0) / fraction
      return { hours: duration / 3600000, used: settings.goPlan === 'unknown' ? null : used,
        average: settings.goPlan === 'unknown' || !valid.length ? null : valid.reduce((sum, row) => sum + row.allowance!, 0) / fraction / windowCount,
        observed_windows: windowCount, unpriced_requests: go.filter(row => row.amount === null).length, estimated: true }
    })
    const daily = new Map<string, typeof ledger>()
    for (const row of ledger) { const day = beijingDay(String(row.at)); daily.set(day, [...daily.get(day) ?? [], row]) }
    return { memory_health:this.health(), memory_metrics:{
      searches:rows.filter(row=>row.kind==='memory_find').length,search_average_ms:mean(rows.filter(row=>row.kind==='memory_find').map(row=>n(row.data.duration_ms))),
      injected_tokens:rows.filter(row=>row.kind==='social_context').reduce((sum,row)=>sum+n(row.data.tokens),0),
      compaction_attempts:rows.filter(row=>row.kind==='compaction_attempt').length,compaction_failures:rows.filter(row=>row.kind==='compaction_result'&&row.data.status==='failed').length,
      main_run_duration_average_ms:mean(runs.filter(run=>run.finished_at).map(run=>Math.max(0,Date.parse(String(run.finished_at))-Date.parse(String(run.started_at)))))}, as_of: this.now().toISOString(), time_zone: 'Asia/Shanghai', since: first, days, total, subagents: summarize(ledger.filter(row => row.scope !== 'main')),
      roles: scopes.map(scope => ({ scope, ...summarize(ledger.filter(row => row.scope === scope)) })),
      sessions: sessions.map(session => ({ session, scope: ledger.find(row => row.session === session)!.scope, task_id: ledger.find(row => row.session === session)?.task,
        ...summarize(ledger.filter(row => row.session === session)) })).sort((a, b) => b.total - a.total),
      models: [...new Set(ledger.map(row => `${row.provider}/${row.model}`))].map(model => ({ model, provider: ledger.find(row => `${row.provider}/${row.model}` === model)!.provider ?? '', ...summarize(ledger.filter(row => `${row.provider}/${row.model}` === model)) })),
      daily: [...daily].map(([day, items]) => ({ day, ...summarize(items) })), daily_average: { tokens: total.total / days, cny: total.cny / days, usd: total.usd / days },
      activations: { total: (allScopes ? runs.length : 0) + rows.filter(row => row.scope !== 'main' && row.kind === 'turn/start').length,
        daily: ((allScopes ? runs.length : 0) + rows.filter(row => row.scope !== 'main' && row.kind === 'turn/start').length) / days,
        main: allScopes ? runs.length : null, main_daily: allScopes ? runs.length / days : null, by_scope: scopes.map(scope => ({ scope, turns: rows.filter(row => row.scope === scope && row.kind === 'turn/start').length })) },
      reliability: { completed_runs: runs.filter(row => row.state === 'completed').length, failed_runs: runs.filter(row => ['failed', 'interrupted'].includes(String(row.state))).length,
        tool_calls: rows.filter(row => row.kind === 'tool').length, web_searches: rows.filter(row => row.kind === 'tool' && ['web_search', 'search', 'internet_search'].includes(String(row.data.tool))).length,
        model_failures: ledger.filter(row => row.data.attempt || row.data.interrupted).length },
      reply_latency: { samples: latencies.length, average_ms: mean(latencies), maximum_ms: latencies.length ? Math.max(...latencies) : null },
      context_fill: { samples: cycles.length, average_minutes: cycles.length ? Math.round(mean(cycles)! / 60000) : null },
      billing: { windows, settings, pricing: { as_of: pricingSnapshot.as_of, sources: pricingSnapshot.sources },
        go_subscription_monthly_usd: settings.goPlan === 'unknown' ? null : { go: 10, 'go-plus': 40, 'go-teams': 20 }[settings.goPlan],
        go_subscription_daily_usd: settings.goPlan === 'unknown' ? null : { go: 10, 'go-plus': 40, 'go-teams': 20 }[settings.goPlan] / new Date(Date.UTC(new Date(now + 8 * 3600000).getUTCFullYear(), new Date(now + 8 * 3600000).getUTCMonth() + 1, 0)).getUTCDate() },
      coverage: { native_sessions: this.store.records('statistics-native').length, missing_usage: total.missing_usage, unpriced: total.unpriced, inherited_fork_usage_excluded: true,
        notes: ['统计仅覆盖本角色已记录的请求，不含同账号在其他应用的用量。', '日均按选定范围的北京时间自然日计算，包含无用量日。', 'DeepSeek 账号登录渠道按官方 API 单价显示人民币等值用量，不代表官网账号的实际扣款。', 'Go 为按官方单价估算的额度消耗，与订阅费分开；窗口是滚动 5 小时／7 天／30 天估算，非供应商账期或实时余量。', '费用按页面标注日期的价格快照回算；未知模型和缺失用量不按零费用处理。'] } }
  }
}
