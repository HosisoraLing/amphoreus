import type { Store } from '../app/store.ts'
import { createHash } from 'node:crypto'
import type { GatewayEvent, EventState, SubagentTask, TaskReport } from './model.ts'

const SCHEMA_VERSION = 2
type HostStore = Pick<Store, 'db' | 'atomic'>

/** Durable Amphoreus events, tasks, reports, and Main Agent run records in the existing SQLite database. */
export class AmphoreusStore {
  onOperation?: (kind: string, id: string, status: string, error?: string, at?: string) => void
  constructor(private readonly host: HostStore) {
    const { db } = host
    host.atomic(() => {
      db.exec('CREATE TABLE IF NOT EXISTS amphoreus_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
      const version = db.prepare('SELECT value FROM amphoreus_meta WHERE key = ?').get('schema_version')?.value
      if (version !== undefined && Number(version) > SCHEMA_VERSION) throw new Error(`Unsupported Amphoreus schema version ${version}`)
      if (version !== undefined && Number(version) < 1) throw new Error(`Unsupported Amphoreus schema version ${version}`)
      db.exec(`
        CREATE TABLE IF NOT EXISTS amphoreus_record (kind TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (kind, id));
        CREATE TABLE IF NOT EXISTS amphoreus_event (
          event_id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, agent_id TEXT NOT NULL,
          source_kind TEXT NOT NULL, platform TEXT NOT NULL, conversation_id TEXT NOT NULL, event_type TEXT NOT NULL,
          timestamp TEXT NOT NULL, received_at TEXT NOT NULL, state TEXT NOT NULL, error TEXT NOT NULL DEFAULT '', value TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS amphoreus_event_queue ON amphoreus_event(state, received_at);
        CREATE INDEX IF NOT EXISTS amphoreus_event_conversation ON amphoreus_event(agent_id, conversation_id, received_at);
        CREATE TABLE IF NOT EXISTS amphoreus_task (
          task_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, state TEXT NOT NULL, priority INTEGER NOT NULL,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL, value TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS amphoreus_task_queue ON amphoreus_task(state, priority DESC, created_at);
        CREATE TABLE IF NOT EXISTS amphoreus_report (
          report_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, event_id TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, value TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS amphoreus_report_task ON amphoreus_report(task_id, created_at);
        CREATE TABLE IF NOT EXISTS amphoreus_output (
          output_id TEXT PRIMARY KEY, event_id TEXT NOT NULL UNIQUE, platform TEXT NOT NULL, status TEXT NOT NULL,
          updated_at TEXT NOT NULL, error TEXT NOT NULL DEFAULT '', value TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS amphoreus_output_status ON amphoreus_output(status, updated_at);
        CREATE TABLE IF NOT EXISTS amphoreus_run (
          run_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, event_id TEXT NOT NULL, state TEXT NOT NULL,
          started_at TEXT NOT NULL, finished_at TEXT, error TEXT NOT NULL DEFAULT '', value TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS amphoreus_run_agent ON amphoreus_run(agent_id, started_at);
      `)
      db.prepare('INSERT INTO amphoreus_meta VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('schema_version', String(SCHEMA_VERSION))
      for(const row of db.prepare("SELECT run_id,agent_id,event_id FROM amphoreus_run WHERE state='running'").all())
        this.setRecord('main-restart',String(row.run_id),row)
      db.prepare("UPDATE amphoreus_run SET state = 'interrupted', finished_at = ?, error = 'Runtime interrupted' WHERE state = 'running'").run(new Date().toISOString())
      // Recover a committed completion; ambiguous in-flight inference needs review rather than silent loss or duplicated effects.
      db.exec(`UPDATE amphoreus_event SET state='processed' WHERE state='processing' AND EXISTS
        (SELECT 1 FROM amphoreus_run r WHERE r.event_id=amphoreus_event.event_id AND r.state='completed');
        UPDATE amphoreus_event SET state='failed', error='Main Run interrupted; review before retry' WHERE state='processing' AND EXISTS
        (SELECT 1 FROM amphoreus_run r WHERE r.event_id=amphoreus_event.event_id);
        UPDATE amphoreus_event SET state='queued' WHERE state='processing';`)
      // An interrupted network send has an unknowable outcome. Never retry it blindly and risk a duplicate public message.
      db.prepare("UPDATE amphoreus_output SET status = 'unknown', error = 'Runtime stopped while sending' WHERE status = 'sending'").run()
    })
  }

  record<T>(kind: string, id: string): T | undefined {
    const row = this.host.db.prepare('SELECT value FROM amphoreus_record WHERE kind = ? AND id = ?').get(kind, id)
    return row ? JSON.parse(String(row.value)) as T : undefined
  }
  setRecord(kind: string, id: string, value: unknown): void {
    this.host.db.prepare('INSERT INTO amphoreus_record VALUES (?, ?, ?) ON CONFLICT(kind, id) DO UPDATE SET value=excluded.value')
      .run(kind, id, JSON.stringify(value))
  }
  deleteRecord(kind: string, id: string): void { this.host.db.prepare('DELETE FROM amphoreus_record WHERE kind=? AND id=?').run(kind, id) }
  records<T>(kind: string): T[] {
    return this.host.db.prepare('SELECT value FROM amphoreus_record WHERE kind = ? ORDER BY rowid').all(kind).map(row => JSON.parse(String(row.value)) as T)
  }
  startRun(run: MainRun): void {
    this.host.db.prepare(`INSERT INTO amphoreus_run VALUES (?, ?, ?, 'running', ?, NULL, '', ?)
      ON CONFLICT(run_id) DO UPDATE SET state='running', finished_at=NULL, error=''`)
      .run(run.run_id, run.agent_id, run.event_id, run.started_at, JSON.stringify(run))
    this.onOperation?.('run', run.run_id, 'running', '', run.started_at)
  }
  run(id: string): MainRun | undefined {
    const row = this.host.db.prepare('SELECT value, state, finished_at, error FROM amphoreus_run WHERE run_id = ?').get(id)
    return row ? { ...JSON.parse(String(row.value)), state: row.state, finished_at: row.finished_at, error: row.error } as MainRun : undefined
  }
  finishRun(id: string, state: string, error = ''): void {
    this.host.db.prepare('UPDATE amphoreus_run SET state = ?, finished_at = ?, error = ? WHERE run_id = ?')
      .run(state, new Date().toISOString(), error, id)
    this.onOperation?.('run', id, state, error)
  }
  runs(limit = 50, offset = 0): MainRun[] {
    return this.host.db.prepare('SELECT value, state, finished_at, error FROM amphoreus_run ORDER BY rowid DESC LIMIT ? OFFSET ?')
      .all(limit, offset).map(row => ({ ...JSON.parse(String(row.value)), state: String(row.state), finished_at: row.finished_at, error: row.error }) as MainRun)
  }
  conversations() {
    return this.host.db.prepare(`SELECT c.*,
      (SELECT e.value FROM amphoreus_event e WHERE e.agent_id=c.agent_id AND e.platform=c.platform AND e.conversation_id=c.conversation_id
        AND e.source_kind != 'output-gateway' ORDER BY e.received_at, e.rowid LIMIT 1) AS first_message,
      (SELECT e.value FROM amphoreus_event e WHERE e.agent_id=c.agent_id AND e.platform=c.platform AND e.conversation_id=c.conversation_id
        ORDER BY e.received_at DESC, e.rowid DESC LIMIT 1) AS last_message
      FROM (SELECT agent_id, platform, conversation_id, MAX(received_at) AS updated_at, COUNT(*) AS messages
        FROM amphoreus_event WHERE value ->> '$.visibility' != 'internal' GROUP BY agent_id, platform, conversation_id) c
      ORDER BY updated_at DESC`).all().map(({ first_message, last_message, ...row }) => {
        const first = JSON.parse(String(first_message ?? last_message)) as GatewayEvent
        const last = JSON.parse(String(last_message)) as GatewayEvent
        const text = (event: GatewayEvent) => event.content.filter(block => block.type === 'text').map(block => String(block.text ?? '')).join(' ').replace(/\s+/g, ' ').trim()
        return { agent_id: String(row.agent_id), platform: String(row.platform), conversation_id: String(row.conversation_id),
          updated_at: String(row.updated_at), messages: Number(row.messages), account_id: first.account_id,
          title: first.platform === 'qq' ? String(first.metadata.group_name || first.metadata.nickname || first.conversation_id) : text(first).slice(0, 40) || '新对话',
          preview: text(last).slice(0, 100) || '图片或附件' }
      })
  }
  /** Latest ten real messages per platform/account/conversation at a fixed wake cutoff, without a global scan cap. */
  recentChannelMessages(agentId:string,cutoff:string,exclude:string):GatewayEvent[][] {
    const rows=this.host.db.prepare(`SELECT value FROM (
      SELECT e.value,received_at,e.rowid AS position,
        ROW_NUMBER() OVER(PARTITION BY platform,value ->> '$.account_id',conversation_id ORDER BY received_at DESC,e.rowid DESC) AS rn
      FROM amphoreus_event e WHERE agent_id=? AND event_id!=? AND received_at<=?
        AND value ->> '$.visibility'!='internal' AND source_kind NOT IN ('qq-observation','qq-debounce')
        AND COALESCE(value ->> '$.metadata.qq_receive_enabled',1)!=0
        AND NOT EXISTS(SELECT 1 FROM amphoreus_record r WHERE r.kind IN ('qq-control-suppressed','user-blocked-message') AND r.id=e.event_id)
        AND COALESCE(value ->> '$.metadata.user_blocked',0)!=1
        AND NOT EXISTS(SELECT 1 FROM amphoreus_record r WHERE r.kind='user-blocklist'
          AND r.value ->> '$.agent_id'=e.agent_id AND r.value ->> '$.platform'=e.platform
          AND r.value ->> '$.account_id'=e.value ->> '$.account_id' AND r.value ->> '$.user_id'=e.value ->> '$.actor_id')
        AND (event_type='message' OR source_kind='output-gateway')
        AND (source_kind!='output-gateway' OR EXISTS(SELECT 1 FROM amphoreus_output o WHERE o.event_id=e.event_id AND o.status='sent'))
      ) WHERE rn<=10 ORDER BY received_at,position`).all(agentId,exclude,cutoff)
    const groups=new Map<string,GatewayEvent[]>()
    for(const row of rows){const event=JSON.parse(String(row.value)) as GatewayEvent,key=JSON.stringify([event.platform,event.account_id,event.conversation_id]);groups.set(key,[...(groups.get(key)??[]),event])}
    return [...groups.values()]
  }
  counts(): Record<string, number> {
    const rows = this.host.db.prepare('SELECT state, COUNT(*) AS count FROM amphoreus_event GROUP BY state').all()
    return Object.fromEntries(rows.map(row => [String(row.state), Number(row.count)]))
  }

  atomic<T>(work: () => T): T { return this.host.atomic(work) }

  /** Stores an event once by both its stable ID and its source idempotency key. */
  insertEvent(event: GatewayEvent): boolean {
    const result = this.host.db.prepare(`INSERT OR IGNORE INTO amphoreus_event
      (event_id, idempotency_key, agent_id, source_kind, platform, conversation_id, event_type, timestamp, received_at, state, value)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`)
      .run(event.event_id, event.idempotency_key, event.agent_id, event.source_kind, event.platform, event.conversation_id,
        event.event_type, event.timestamp, event.received_at, JSON.stringify(event))
    if (Number(result.changes) === 1 && event.event_type !== 'assistant.thought') this.onOperation?.('message', event.event_id, 'received', '', event.received_at)
    return Number(result.changes) === 1
  }

  event(id: string): { event: GatewayEvent; state: EventState; error: string } | undefined {
    const row = this.host.db.prepare('SELECT value, state, error FROM amphoreus_event WHERE event_id = ?').get(id)
    return row ? { event: JSON.parse(String(row.value)) as GatewayEvent, state: String(row.state) as EventState, error: String(row.error) } : undefined
  }

  qqMessage(scope: Pick<GatewayEvent,'agent_id'|'account_id'|'conversation_id'>, id: string): GatewayEvent | undefined {
    const row=this.host.db.prepare(`SELECT e.value FROM amphoreus_event e WHERE e.agent_id=? AND e.platform='qq' AND e.conversation_id=?
      AND e.value ->> '$.account_id'=? AND e.source_kind IN ('napcat','output-gateway') AND
      (e.value ->> '$.metadata.message_id'=? OR EXISTS(SELECT 1 FROM amphoreus_record r WHERE r.kind='receipt' AND r.id=e.event_id AND r.value ->> '$.message_id'=?))
      ORDER BY e.received_at DESC LIMIT 1`).get(scope.agent_id,scope.conversation_id,scope.account_id,id,id)
    return row?JSON.parse(String(row.value)) as GatewayEvent:undefined
  }

  /** Actual Main admission, including members of QQ batches. Arrival time alone cannot identify a wake. */
  eventWake(event: GatewayEvent, cache = new Map<string, MainRun | null>(), seen = new Set<string>()): MainRun | null {
    if (cache.has(event.event_id)) return cache.get(event.event_id)!
    if (seen.has(event.event_id) || seen.size >= 6) return null
    seen.add(event.event_id)
    const own = this.host.db.prepare('SELECT run_id FROM amphoreus_run WHERE agent_id=? AND event_id=? ORDER BY rowid DESC LIMIT 1').get(event.agent_id, event.event_id)
    const steer = this.record<{ admitted: boolean; run_id: string }>('main-steer', event.event_id)
    const direct = own ? this.run(String(own.run_id)) : steer?.admitted ? this.run(steer.run_id)
      : event.correlation_id ? this.run(event.correlation_id) : undefined
    let run = direct?.agent_id === event.agent_id ? direct : null
    if (!run && event.platform === 'qq' && ['napcat', 'qq-debounce'].includes(event.source_kind)) {
      const parents = this.host.db.prepare(`SELECT value FROM amphoreus_event WHERE agent_id=? AND platform='qq' AND conversation_id=?
        AND source_kind IN ('qq-debounce','qq-observation') AND value ->> '$.account_id'=?
        AND EXISTS(SELECT 1 FROM json_each(amphoreus_event.value,'$.metadata.source_event_ids') WHERE value=?) ORDER BY received_at DESC LIMIT 20`)
        .all(event.agent_id, event.conversation_id, event.account_id, event.event_id)
      for (const parent of parents) {
        run = this.eventWake(JSON.parse(String(parent.value)), cache, new Set(seen))
        if (run) break
      }
    }
    cache.set(event.event_id, run)
    return run
  }

  events(input: { agentId?: string; conversationId?: string; sourceKind?: string; platform?: string; accountId?: string; state?: EventState; offset?: number; limit?: number } = {}) {
    const clauses: string[] = [], params: (string | number)[] = []
    for (const [column, value] of [['agent_id', input.agentId], ['conversation_id', input.conversationId], ['source_kind', input.sourceKind], ['platform', input.platform], ["value ->> '$.account_id'", input.accountId], ['state', input.state]] as const) {
      if (value !== undefined) { clauses.push(`${column} = ?`); params.push(value) }
    }
    params.push(input.limit ?? 50, input.offset ?? 0)
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    return this.host.db.prepare(`SELECT value, state, error FROM amphoreus_event ${where} ORDER BY received_at DESC, rowid DESC LIMIT ? OFFSET ?`)
      .all(...params).map(row => ({ event: JSON.parse(String(row.value)) as GatewayEvent, state: String(row.state) as EventState, error: String(row.error) }))
  }

  eventsAfter(agentId: string, cursor: number, limit = 250) {
    return this.host.db.prepare('SELECT rowid AS position,value,state FROM amphoreus_event WHERE agent_id=? AND rowid>? ORDER BY rowid LIMIT ?')
      .all(agentId, cursor, limit).map(row => ({ position: Number(row.position), event: JSON.parse(String(row.value)) as GatewayEvent, state: String(row.state) }))
  }

  /** Claims the oldest queued event using a conditional update, so a duplicate scheduler tick cannot claim it twice. */
  claimEvent(agentId?: string): GatewayEvent | undefined {
    return this.host.atomic(() => {
      const row = agentId
        ? this.host.db.prepare("SELECT event_id, value FROM amphoreus_event WHERE state = 'queued' AND agent_id = ? ORDER BY (event_type = 'genesis.greeting') DESC, COALESCE(value ->> '$.metadata.priority', 0) DESC, received_at, rowid LIMIT 1").get(agentId)
        : this.host.db.prepare("SELECT event_id, value FROM amphoreus_event WHERE state = 'queued' ORDER BY (event_type = 'genesis.greeting') DESC, COALESCE(value ->> '$.metadata.priority', 0) DESC, received_at, rowid LIMIT 1").get()
      if (!row) return undefined
      const claimed = this.host.db.prepare("UPDATE amphoreus_event SET state = 'processing', error = '' WHERE event_id = ? AND state = 'queued'").run(String(row.event_id))
      if (Number(claimed.changes) === 1) this.onOperation?.('message',String(row.event_id),'processing')
      return Number(claimed.changes) === 1 ? JSON.parse(String(row.value)) as GatewayEvent : undefined
    })
  }

  setEventState(id: string, state: EventState, error = ''): void {
    this.host.db.prepare('UPDATE amphoreus_event SET state = ?, error = ? WHERE event_id = ?').run(state, error, id)
    this.onOperation?.('message', id, state, error)
  }

  failure(id: string) {
    const row = this.event(id)
    if (row?.state !== 'failed') return
    const ownRun = this.host.db.prepare('SELECT run_id,started_at,finished_at,error FROM amphoreus_run WHERE event_id=? ORDER BY rowid DESC LIMIT 1').get(id)
    const steer = this.record<{ run_id: string }>('main-steer', id)
    const run = ownRun ?? (steer ? this.run(steer.run_id) : undefined)
    const fingerprint = createHash('sha256').update(JSON.stringify([row.error, this.record('run-attempt', id) ?? 0, run?.run_id ?? null, run?.started_at ?? null, run?.finished_at ?? null, run?.error ?? null])).digest('hex')
    const saved = this.record<{ fingerprint: string; note: string; reviewer: string; at: string }>('event-resolution', id)
    return { event_id: id, error: row.error, at: row.event.received_at, fingerprint, ...(saved?.fingerprint === fingerprint ? { resolution: saved } : {}) }
  }

  unresolvedFailures(agentId: string, limit = 10) {
    const failures: NonNullable<ReturnType<AmphoreusStore['failure']>>[] = []
    for (let offset = 0; failures.length < limit; offset += 50) {
      const rows = this.events({ agentId, state: 'failed', limit: 50, offset })
      for (const row of rows) { const failure = this.failure(row.event.event_id); if (failure && !failure.resolution) failures.push(failure) }
      if (rows.length < 50) break
    }
    return failures.slice(0, limit)
  }

  resolveFailure(id: string, fingerprint: string, note: string, reviewer: string): boolean {
    return this.host.atomic(() => {
      const current = this.failure(id)
      if (!current || current.fingerprint !== fingerprint) return false
      if (!current.resolution) this.setRecord('event-resolution', id, { fingerprint, note, reviewer, at: new Date().toISOString() })
      return true
    })
  }

  pendingEventAgents(): string[] {
    return this.host.db.prepare("SELECT DISTINCT agent_id FROM amphoreus_event WHERE state = 'queued' ORDER BY agent_id")
      .all().map(row => String(row.agent_id))
  }

  enqueueTask(task: SubagentTask): void {
    this.host.db.prepare('INSERT INTO amphoreus_task VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(task.task_id, task.agent_id, task.state, task.priority, task.created_at, task.updated_at, JSON.stringify(task))
    this.onOperation?.('task', task.task_id, task.state, '', task.created_at)
  }

  task(id: string): SubagentTask | undefined {
    const row = this.host.db.prepare('SELECT value FROM amphoreus_task WHERE task_id = ?').get(id)
    return row ? JSON.parse(String(row.value)) as SubagentTask : undefined
  }

  tasks(input: { agentId?: string; conversationId?: string; accountId?: string; state?: SubagentTask['state']; offset?: number; limit?: number } = {}): SubagentTask[] {
    const clauses: string[] = [], params: (string | number)[] = []
    if (input.agentId !== undefined) { clauses.push('agent_id = ?'); params.push(input.agentId) }
    if (input.accountId !== undefined) { clauses.push("value ->> '$.origin.platform' = 'web' AND value ->> '$.origin.account_id' = ?"); params.push(input.accountId) }
    if (input.state !== undefined) { clauses.push('state = ?'); params.push(input.state) }
    if (input.conversationId !== undefined) { clauses.push("value ->> '$.origin.conversation_id' = ?"); params.push(input.conversationId) }
    params.push(input.limit ?? 50, input.offset ?? 0)
    return this.host.db.prepare(`SELECT value FROM amphoreus_task ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
      ORDER BY created_at DESC, task_id DESC LIMIT ? OFFSET ?`).all(...params).map(row => JSON.parse(String(row.value)) as SubagentTask)
  }

  claimTask(exclude: string[] = []): SubagentTask | undefined {
    return this.host.atomic(() => {
      const row = this.host.db.prepare(`SELECT task_id,value FROM amphoreus_task WHERE state='queued' ${exclude.length ? `AND task_id NOT IN (${exclude.map(() => '?').join(',')})` : ''} ORDER BY priority DESC,created_at,task_id LIMIT 1`).get(...exclude)
      if (!row) return undefined
      const task = JSON.parse(String(row.value)) as SubagentTask
      const running = { ...task, state: 'running' as const, updated_at: new Date().toISOString() }
      const result = this.host.db.prepare("UPDATE amphoreus_task SET state = 'running', updated_at = ?, value = ? WHERE task_id = ? AND state = 'queued'")
        .run(running.updated_at, JSON.stringify(running), String(row.task_id))
      if (Number(result.changes) === 1) this.onOperation?.('task',task.task_id,'running','',running.updated_at)
      return Number(result.changes) === 1 ? running : undefined
    })
  }

  updateTask(task: SubagentTask): void {
    this.host.db.prepare('UPDATE amphoreus_task SET state = ?, updated_at = ?, value = ? WHERE task_id = ?')
      .run(task.state, task.updated_at, JSON.stringify(task), task.task_id)
    this.onOperation?.('task', task.task_id, task.state, '', task.updated_at)
  }

  insertReport(report: TaskReport): boolean {
    const result = this.host.db.prepare('INSERT OR IGNORE INTO amphoreus_report VALUES (?, ?, ?, ?, ?)')
      .run(report.report_id, report.task_id, report.event_id, report.created_at, JSON.stringify(report))
    return Number(result.changes) === 1
  }

  report(id: string): TaskReport | undefined {
    const row = this.host.db.prepare('SELECT value FROM amphoreus_report WHERE report_id = ?').get(id)
    return row ? JSON.parse(String(row.value)) as TaskReport : undefined
  }

  reports(taskId?: string, limit = 100, offset = 0): TaskReport[] {
    return this.host.db.prepare(`SELECT value FROM amphoreus_report ${taskId === undefined ? '' : 'WHERE task_id = ?'}
      ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`).all(...taskId === undefined ? [limit, offset] : [taskId, limit, offset])
      .map(row => JSON.parse(String(row.value)) as TaskReport)
  }

  insertOutput(output: OutputRecord): boolean {
    const result = this.host.db.prepare('INSERT OR IGNORE INTO amphoreus_output VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(output.output_id, output.event_id, output.platform, output.status, output.updated_at, output.error,
        JSON.stringify({ output_id: output.output_id, event_id: output.event_id, platform: output.platform, target: output.target, content: output.content }))
    return Number(result.changes) === 1
  }

  output(id: string): OutputRecord | undefined {
    const row = this.host.db.prepare('SELECT value, status, updated_at, error FROM amphoreus_output WHERE output_id = ?').get(id)
    return row ? { ...(JSON.parse(String(row.value)) as Omit<OutputRecord, 'status' | 'updated_at' | 'error'>),
      status: String(row.status) as OutputStatus, updated_at: String(row.updated_at), error: String(row.error) } : undefined
  }

  setOutput(id: string, status: OutputStatus, updatedAt: string, error = ''): void {
    this.host.db.prepare('UPDATE amphoreus_output SET status = ?, updated_at = ?, error = ? WHERE output_id = ?')
      .run(status, updatedAt, error, id)
    this.onOperation?.('output', id, status, error, updatedAt)
  }
  setOutputContent(id:string,content:GatewayEvent['content']):void{
    this.host.atomic(()=>{
      const output=this.output(id),event=output&&this.event(output.event_id)?.event
      if(!output||!event)throw new Error('Output not found')
      if(JSON.stringify(output.content)===JSON.stringify(content))return
      const {status:_status,updated_at:_at,error:_error,...value}=output
      this.host.db.prepare('UPDATE amphoreus_output SET value=? WHERE output_id=?').run(JSON.stringify({...value,content}),id)
      this.host.db.prepare('UPDATE amphoreus_event SET value=? WHERE event_id=?').run(JSON.stringify({...event,content}),event.event_id)
    })
  }

  outputs(limit = 100, offset = 0): OutputRecord[] {
    return this.host.db.prepare('SELECT value, status, updated_at, error FROM amphoreus_output ORDER BY updated_at DESC, rowid DESC LIMIT ? OFFSET ?').all(limit, offset)
      .map(row => ({ ...(JSON.parse(String(row.value)) as Omit<OutputRecord, 'status' | 'updated_at' | 'error'>),
        status: String(row.status) as OutputStatus, updated_at: String(row.updated_at), error: String(row.error) }))
  }
}

export type OutputStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'unknown'
export interface OutputRecord { output_id: string; event_id: string; platform: string; target: { account_id: string; conversation_id: string; reply_to?: string };
  content: GatewayEvent['content']; status: OutputStatus; updated_at: string; error: string }

export interface MainRun { run_id: string; agent_id: string; event_id: string; session_id: string; state: string; started_at: string; finished_at?: string; error?: string }
