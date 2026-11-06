import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Store } from '../app/store.ts'
import {installSearchIndex,rebuildSearchIndex,searchIndexStatus,selectiveMatch} from './memory-search.ts'

export const MemorySettings = z.object({
  reasoning: z.object({ allowedProviders: z.array(z.string()).default([]), retentionDays: z.number().int().min(1).max(365).default(7),
    importantRetentionDays: z.number().int().min(1).max(3650).default(30), retainImportantRaw: z.boolean().default(false) }).prefault({}),
  timeZone: z.string().refine(value => { try { new Intl.DateTimeFormat('en', { timeZone: value }); return true } catch { return false } }, 'Invalid IANA time zone').default('Asia/Shanghai'),
  dreaming: z.object({ consolidation:z.boolean().default(false), enabled: z.boolean().default(true), at: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default('01:00') }).prefault({}),
  search:z.object({enabled:z.boolean().default(true)}).prefault({}),
  socialContext: z.object({enabled:z.boolean().default(true),hybridBudgetTokens:z.number().int().min(200).max(8000).default(1000)}).prefault({}),
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
export interface MemoryQuery { query?: string; kind?: string; branch?: string; status?: string; since?: string; until?: string; historical?: boolean; limit?: number; offset?: number; order?: 'recent'; as_of?:string; current_facts?:boolean; entity_ref?:string; platform?:string; actor_id?:string }
export const memoryId = (...parts: unknown[]): string => createHash('sha256').update(JSON.stringify(parts)).digest('hex')

/** One role-wide archive; provenance is independent of the source conversation's access rules. */
export class MemoryStore {
  entityRefs:(ref:string)=>string[]=()=>[]
  constructor(readonly host: Pick<Store, 'db' | 'atomic'>, readonly agentId: string, readonly settings = MemorySettings.parse({}), private readonly clock = () => new Date()) {
    host.atomic(() => {
      const version = host.db.prepare("SELECT value FROM amphoreus_meta WHERE key='memory_schema_version'").get()?.value
      if (version !== undefined && Number(version) > 2) throw new Error('Unsupported memory schema version')
      host.db.exec(`CREATE TABLE IF NOT EXISTS amphoreus_memory (
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, text TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, importance REAL NOT NULL, status TEXT NOT NULL,
        source TEXT NOT NULL, data TEXT NOT NULL, expires_at TEXT
      );
      CREATE INDEX IF NOT EXISTS amphoreus_memory_role ON amphoreus_memory(agent_id,kind,created_at);
      CREATE INDEX IF NOT EXISTS amphoreus_memory_expiry ON amphoreus_memory(expires_at) WHERE expires_at IS NOT NULL;`)
      const indexed=!!host.db.prepare("SELECT 1 FROM sqlite_master WHERE name='amphoreus_memory_fts'").get()
      installSearchIndex(host,!indexed||Number(version??0)<2)
      host.db.prepare("INSERT OR REPLACE INTO amphoreus_meta VALUES ('memory_schema_version','2')").run()
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
    if (!input.historical && !input.status && !input.as_of) where.push("status NOT IN ('expired','superseded','archived')")
    for(const [column,value] of [["source ->> '$.platform'",input.platform],["source ->> '$.actor_id'",input.actor_id]] as const)if(value){where.push(`${column}=?`);values.push(value)}
    if(input.current_facts){where.push("kind IN ('candidate','insight') AND status='adopted'")}
    if(input.as_of)where.push("kind IN ('candidate','insight') AND status IN ('adopted','superseded')")
    if(input.as_of||input.current_facts){
      const at=input.as_of?new Date(input.as_of).toISOString():this.now()
      where.push("(data ->> '$.valid_from' IS NULL OR data ->> '$.valid_from'<=?) AND (data ->> '$.valid_to' IS NULL OR data ->> '$.valid_to'>?)");values.push(at,at)
    }
    if(input.entity_ref){
      const refs=this.entityRefs(input.entity_ref)
      where.push(refs.length?`EXISTS(SELECT 1 FROM json_each(amphoreus_memory.data,'$.entity_refs') WHERE value IN (${refs.map(()=>'?').join(',')}))`:'0')
      values.push(...refs)
    }
    if (input.since) { where.push('created_at>=?'); values.push(input.since) }
    if (input.until) { where.push('created_at<=?'); values.push(input.until) }
    const terms=[...new Set([query,...query.split(/\s+/)])].filter(Boolean).slice(0,12)
    const predicate=(terms:string[])=>`(${terms.map(()=>"(instr(lower(text),lower(?))>0 OR instr(lower(title),lower(?))>0 OR instr(lower(source),lower(?))>0 OR instr(lower(COALESCE(data ->> '$.origins','')),lower(?))>0)").join(' OR ')})`
    const filter=(exact:boolean,excludeExact=false)=>{
      const clauses=[...where],params=[...values]
      if(query){
        const match=this.settings.search.enabled?selectiveMatch(this.host,query,!exact):undefined
        if(match){clauses.push('rowid IN (SELECT rowid FROM amphoreus_memory_fts WHERE amphoreus_memory_fts MATCH ?)');params.push(match)}
        const chosen=exact?[query]:terms
        clauses.push(predicate(chosen));for(const term of chosen)params.push(term,term,term,term)
        if(excludeExact){clauses.push(`NOT ${predicate([query])}`);params.push(query,query,query,query)}
      }
      return{clauses,params}
    }
    const select=(scope:ReturnType<typeof filter>,limit:number,offset:number)=>{
      const params=[...scope.params]
      if(input.order!=='recent')params.push(query,query)
      params.push(limit,offset)
      const rows=this.host.db.prepare(`SELECT rowid AS memory_rowid FROM amphoreus_memory WHERE ${scope.clauses.join(' AND ')}
        ORDER BY ${input.order==='recent'?'':`(CASE WHEN instr(lower(title),lower(?))>0 THEN 2 ELSE 0 END + CASE WHEN instr(lower(text),lower(?))>0 THEN 4 ELSE 0 END) DESC,importance DESC,`} created_at DESC,rowid DESC LIMIT ? OFFSET ?`)
        .all(...params)
      if(!rows.length)return []
      const records=this.host.db.prepare(`SELECT rowid AS memory_rowid,* FROM amphoreus_memory WHERE rowid IN (${rows.map(()=>'?').join(',')})`).all(...rows.map(row=>Number(row.memory_rowid)))
      const byPosition=new Map(records.map(row=>[Number(row.memory_rowid),row]))
      return rows.map(row=>this.decode(byPosition.get(Number(row.memory_rowid))!))
    }
    const limit=Math.min(100,Math.max(1,input.limit??8)),offset=Math.max(0,input.offset??0)
    if(terms.length<=1||input.order==='recent')return select(filter(false),limit,offset)
    // Full phrases win. Do not sort a broad OR over 100k rows just to return
    // the first page when the exact indexed phrase already fills it.
    const exact=filter(true),records=select(exact,limit,offset)
    if(records.length===limit)return records
    const count=offset===0?records.length:Number(this.host.db.prepare(`SELECT count(*) AS n FROM amphoreus_memory WHERE ${exact.clauses.join(' AND ')}`).get(...exact.params)!.n)
    return [...records,...select(filter(false,true),limit-records.length,Math.max(0,offset-count))]
  }

  searchStatus(){return searchIndexStatus(this.host)}
  rebuildSearch(){this.expire();return rebuildSearchIndex(this.host)}
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
    return this.find(input).map(({ text, data, ...meta }) => ({ ...meta, excerpt: text.slice(0, 200), total_chars: text.length,...(data.category?{semantic:{category:data.category,evidence_type:data.evidence_type,entity_refs:data.entity_refs,observed_at:data.observed_at,valid_from:data.valid_from,valid_to:data.valid_to,replaces:data.replaces}}:{}) }))
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
  rangeAfter(from:number,to:number,limit=8){
    this.expire()
    return this.host.db.prepare("SELECT rowid AS position,* FROM amphoreus_memory WHERE agent_id=? AND rowid>? AND rowid<=? AND kind IN ('input','speak','assistant','reasoning','report','tool') ORDER BY rowid LIMIT ?")
      .all(this.agentId,from,to,Math.min(21,Math.max(1,limit))).map(row=>({...this.decode(row),position:Number(row.position)}))
  }
  jobRecords(id: string): MemoryRecord[] {
    return this.host.db.prepare("SELECT * FROM amphoreus_memory WHERE agent_id=? AND data ->> '$.job_id'=? ORDER BY rowid").all(this.agentId, id).map(row => this.decode(row))
  }
}
