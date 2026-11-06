import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Store } from '../app/store.ts'

export const MemorySettings = z.object({
  reasoning: z.object({ allowedProviders: z.array(z.string()).default([]), retentionDays: z.number().int().min(1).max(365).default(7),
    importantRetentionDays: z.number().int().min(1).max(3650).default(30), retainImportantRaw: z.boolean().default(false) }).prefault({}),
  timeZone: z.string().refine(value => { try { new Intl.DateTimeFormat('en', { timeZone: value }); return true } catch { return false } }, 'Invalid IANA time zone').default('Asia/Shanghai'),
  dreaming: z.object({ enabled: z.boolean().default(true), at: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default('01:00') }).prefault({}),
}).prefault({})
export type MemorySettings = z.infer<typeof MemorySettings>
export type MemoryBranch = 'main' | 'worker' | 'continuation' | 'topic'
export interface MemorySource {
  event_id?: string; session_id?: string; seq?: number; turn?: number; step?: number; run_id?: string; task_id?: string;
  branch?: MemoryBranch; parent_session_id?: string; actor_id?: string; platform?: string; account_id?: string;
  conversation_id?: string; provider?: string; model?: string
}
export interface MemoryRecord {
  id: string; agent_id: string; kind: string; title: string; text: string; created_at: string; updated_at: string;
  importance: number; status: string; source: MemorySource; data: Record<string, unknown>; expires_at?: string
}
export type MemoryInput = Omit<MemoryRecord, 'id' | 'agent_id' | 'updated_at' | 'importance' | 'status' | 'data'> &
  Partial<Pick<MemoryRecord, 'id' | 'updated_at' | 'importance' | 'status' | 'data'>>
export interface MemoryQuery { query?: string; kind?: string; branch?: string; status?: string; since?: string; until?: string; historical?: boolean; limit?: number; offset?: number; order?: 'recent' }
export const memoryId = (...parts: unknown[]): string => createHash('sha256').update(JSON.stringify(parts)).digest('hex')

/** One role-wide archive; provenance is independent of the source conversation's access rules. */
export class MemoryStore {
  constructor(readonly host: Pick<Store, 'db' | 'atomic'>, readonly agentId: string, readonly settings = MemorySettings.parse({}), private readonly clock = () => new Date()) {
    host.atomic(() => {
      const version = host.db.prepare("SELECT value FROM amphoreus_meta WHERE key='memory_schema_version'").get()?.value
      if (version !== undefined && Number(version) > 1) throw new Error('Unsupported memory schema version')
      host.db.exec(`CREATE TABLE IF NOT EXISTS amphoreus_memory (
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, text TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, importance REAL NOT NULL, status TEXT NOT NULL,
        source TEXT NOT NULL, data TEXT NOT NULL, expires_at TEXT
      );
      CREATE INDEX IF NOT EXISTS amphoreus_memory_role ON amphoreus_memory(agent_id,kind,created_at);
      CREATE INDEX IF NOT EXISTS amphoreus_memory_expiry ON amphoreus_memory(expires_at) WHERE expires_at IS NOT NULL;`)
      host.db.prepare("INSERT OR REPLACE INTO amphoreus_meta VALUES ('memory_schema_version','1')").run()
    })
    this.expire()
  }
  now(): string { return this.clock().toISOString() }
  today(): string { return new Intl.DateTimeFormat('en-CA', { timeZone: this.settings.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(this.clock()) }
  private decode(row: Record<string, unknown>): MemoryRecord {
    return { id: String(row.id), agent_id: String(row.agent_id), kind: String(row.kind), title: String(row.title), text: String(row.text),
      created_at: String(row.created_at), updated_at: String(row.updated_at), importance: Number(row.importance), status: String(row.status),
      source: JSON.parse(String(row.source)), data: JSON.parse(String(row.data)), ...(row.expires_at ? { expires_at: String(row.expires_at) } : {}) }
  }
  get(id: string): MemoryRecord | undefined {
    this.expire()
    const row = this.host.db.prepare('SELECT * FROM amphoreus_memory WHERE id=? AND agent_id=?').get(id, this.agentId)
    return row ? this.decode(row) : undefined
  }
  put(input: MemoryInput): MemoryRecord {
    const now = this.now(), record: MemoryRecord = { ...input, id: input.id ?? randomUUID(), agent_id: this.agentId,
      updated_at: input.updated_at ?? now, importance: Math.min(1, Math.max(0, input.importance ?? .3)), status: input.status ?? 'complete', data: input.data ?? {} }
    if (record.expires_at && record.expires_at <= now) { record.text = ''; record.status = 'expired' }
    this.host.db.prepare(`INSERT OR IGNORE INTO amphoreus_memory VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(record.id, this.agentId, record.kind,
      record.title, record.text, record.created_at, record.updated_at, record.importance, record.status, JSON.stringify(record.source), JSON.stringify(record.data), record.expires_at ?? null)
    return this.get(record.id)!
  }
  update(id: string, patch: Partial<Pick<MemoryRecord, 'status' | 'importance' | 'data' | 'expires_at'>>): MemoryRecord {
    const record = this.get(id)
    if (!record) throw new Error('Memory not found')
    const next = { ...record, ...patch, updated_at: this.now() }
    this.host.db.prepare('UPDATE amphoreus_memory SET status=?,importance=?,data=?,expires_at=?,updated_at=? WHERE id=? AND agent_id=?')
      .run(next.status, next.importance, JSON.stringify(next.data), next.expires_at ?? null, next.updated_at, id, this.agentId)
    return next
  }
  expire(): void {
    this.host.db.prepare("UPDATE amphoreus_memory SET text='',status='expired',updated_at=? WHERE agent_id=? AND kind='reasoning' AND expires_at<=? AND status!='expired'")
      .run(this.now(), this.agentId, this.now())
  }
  find(input: MemoryQuery = {}): MemoryRecord[] {
    this.expire()
    const where = ['agent_id=?'], values: (string | number)[] = [this.agentId], query = (input.query ?? '').trim().slice(0, 500)
    for (const [column, value] of [['kind', input.kind], ["source ->> '$.branch'", input.branch], ['status', input.status]] as const) {
      if (value) { where.push(`${column}=?`); values.push(value) }
    }
    if (!input.historical && !input.status) where.push("status NOT IN ('expired','superseded','archived')")
    if (input.since) { where.push('created_at>=?'); values.push(input.since) }
    if (input.until) { where.push('created_at<=?'); values.push(input.until) }
    if (query) {
      const terms = [...new Set([query, ...query.split(/\s+/)])].slice(0, 12)
      where.push(`(${terms.map(() => "(instr(lower(text),lower(?))>0 OR instr(lower(title),lower(?))>0 OR instr(lower(source),lower(?))>0 OR instr(lower(COALESCE(data ->> '$.origins','')),lower(?))>0)").join(' OR ')})`)
      for (const term of terms) values.push(term, term,term,term)
    }
    if (input.order !== 'recent') values.push(query, query, this.now())
    values.push(Math.min(100, Math.max(1, input.limit ?? 8)), Math.max(0, input.offset ?? 0))
    return this.host.db.prepare(`SELECT * FROM amphoreus_memory WHERE ${where.join(' AND ')}
      ORDER BY ${input.order === 'recent' ? '' : `(CASE WHEN instr(lower(title),lower(?))>0 THEN 2 ELSE 0 END + CASE WHEN instr(lower(text),lower(?))>0 THEN 4 ELSE 0 END
        + importance*1.8 + .4/(1+MAX(0,julianday(?)-julianday(created_at))/30)) DESC,`} created_at DESC, rowid DESC LIMIT ? OFFSET ?`)
      .all(...values).map(row => this.decode(row))
  }
  recent(limit = 50, offset = 0, kind?: string): MemoryRecord[] {
    this.expire()
    return this.host.db.prepare(`SELECT * FROM amphoreus_memory WHERE agent_id=? ${kind ? 'AND kind=?' : ''} ORDER BY created_at DESC,rowid DESC LIMIT ? OFFSET ?`)
      .all(this.agentId, ...kind ? [kind] : [], limit, offset).map(row => this.decode(row))
  }
  topicVersions(topicId:string):MemoryRecord[]{
    return this.host.db.prepare("SELECT * FROM amphoreus_memory WHERE agent_id=? AND kind='topic' AND data ->> '$.topic_id'=? ORDER BY (status='active') DESC,created_at DESC,rowid DESC")
      .all(this.agentId,topicId).map(row=>this.decode(row))
  }
  read(id: string, offset = 0, size = 4000) {
    const record = this.get(id)
    if (!record) throw new Error('Memory not found')
    const length = Math.min(12000, Math.max(200, size)), { text, ...meta } = record
    return { ...meta, text: text.slice(offset, offset + length), total_chars: text.length, offset, next_offset: offset + length < text.length ? offset + length : null }
  }
  summaries(input: MemoryQuery = {}) {
    return this.find(input).map(({ text, data: _data, ...meta }) => ({ ...meta, excerpt: text.slice(0, 200), total_chars: text.length }))
  }
  counts() {
    this.expire()
    return this.host.db.prepare('SELECT kind,status,COUNT(*) AS count,AVG(importance) AS importance,MIN(created_at) AS first_at,MAX(created_at) AS last_at FROM amphoreus_memory WHERE agent_id=? GROUP BY kind,status').all(this.agentId)
  }
  distribution() { return this.host.db.prepare("SELECT substr(created_at,1,10) AS day,COUNT(*) AS count,AVG(importance) AS importance FROM amphoreus_memory WHERE agent_id=? GROUP BY day ORDER BY day DESC LIMIT 30").all(this.agentId) }
  related(id: string) {
    const data = this.get(id)?.data ?? {}
    const references = [...new Set([...(data.source_ids as string[] ?? []), ...(data.revisions as string[] ?? []), ...(data.adopted_ids as string[] ?? []),
      ...['memory_id','related_id','draft_id','previous_id','formal_id','assistant_id','job_id'].map(key => data[key])].filter((value): value is string => typeof value === 'string'))]
    return this.host.db.prepare(`SELECT * FROM amphoreus_memory WHERE agent_id=? AND id!=? AND (
      data ->> '$.memory_id'=? OR data ->> '$.draft_id'=? OR data ->> '$.previous_id'=? OR data ->> '$.related_id'=? OR
      EXISTS (SELECT 1 FROM json_each(amphoreus_memory.data, '$.source_ids') WHERE value=?) ${references.length ? `OR id IN (${references.map(() => '?').join(',')})` : ''}) ORDER BY created_at DESC LIMIT 30`)
      .all(this.agentId, id, id, id, id, id, id, ...references).map(row => { const record = this.decode(row); return { id: record.id, title: record.title, kind: record.kind, status: record.status, source: record.source } })
  }
  position(): number { return Number(this.host.db.prepare('SELECT MAX(rowid) AS cursor FROM amphoreus_memory WHERE agent_id=?').get(this.agentId)?.cursor ?? 0) }
  range(from: number, to: number, limit = 8, offset = 0) {
    this.expire()
    return this.host.db.prepare("SELECT * FROM amphoreus_memory WHERE agent_id=? AND rowid>? AND rowid<=? AND kind IN ('input','speak','assistant','reasoning','report','tool') ORDER BY rowid LIMIT ? OFFSET ?")
      .all(this.agentId, from, to, Math.min(20, limit), offset).map(row => this.decode(row)).map(({ text, ...record }) => ({ ...record, excerpt: text.slice(0, 200), total_chars: text.length }))
  }
  jobRecords(id: string): MemoryRecord[] {
    return this.host.db.prepare("SELECT * FROM amphoreus_memory WHERE agent_id=? AND data ->> '$.job_id'=? ORDER BY rowid").all(this.agentId, id).map(row => this.decode(row))
  }
}
