import { afterEach, expect, it } from 'vitest'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/app/store.ts'
import { AmphoreusStore } from '../src/amphoreus/store.ts'
import { MemoryStore } from '../src/amphoreus/memory.ts'
import { Telemetry } from '../src/amphoreus/telemetry.ts'
import { price, StatisticsSettings } from '../src/amphoreus/pricing.ts'
const stores: Store[] = [], dirs: string[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close(); for(const dir of dirs.splice(0)) rmSync(dir,{recursive:true,force:true}) })
const at = '2026-11-05T08:00:00.000Z'
function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'amphoreus-stats-'));dirs.push(dir);const host = new Store(join(dir,'data.sqlite')); stores.push(host)
  const store = new AmphoreusStore(host), memory = new MemoryStore(host, 'role')
  const telemetry = new Telemetry(memory, store, ['super-private-credential'], () => new Date(at))
  telemetry.configure({ goPlan: 'go' })
  let seq = 0
  const event = (type: string, data: unknown, time = at, session = 'main', branch: 'main' | 'worker' = 'main') => {
    const e = { seq: SessionSeq(seq++), type, time: Date.parse(time), data } as never
    telemetry.observe({ id: session, isOwnSeq: () => true } as never, { session_id: session, branch }, e)
    return e
  }
  const usage = (branch: 'main' | 'worker' = 'main', time = at) => event('assistant/message', { turn: 0, step: 0, message: { source: { provider: 'opencode-go', model: 'kimi-k3' } },
    usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 900 }, stream: [] }, time, branch, branch)
  return { host, store, telemetry, event, usage }
}
it('counts own usage once, keeps roles separate, excludes inherited fork events and includes compaction bills', () => {
  const f = fixture(), e = f.usage()
  f.telemetry.observe({ id: 'main', isOwnSeq: () => true } as never, { session_id: 'main', branch: 'main' }, e)
  f.telemetry.observe({ id: 'fork', isOwnSeq: () => false } as never, { session_id: 'fork', branch: 'continuation' }, e)
  f.usage('worker')
  f.event('compaction/summary', { provider: 'deepseek', model: 'deepseek-flash', usage: { inputTokens: 20, outputTokens: 10 }, compactionId: 'c' })
  const result = f.telemetry.statistics()
  expect(result.total.total).toBe(2130); expect(result.subagents.total).toBe(1050)
  expect(result.total.requests).toBe(2); expect(result.total.read).toBe(1800)
  expect(result.roles.find(row => row.scope === 'main')?.total).toBe(1080)
  expect(result.total.cache_hit_rate).toBeCloseTo(1800 / 2020)
  expect(result.total.unpriced).toBe(0)
})
it('reports absent usage and unknown prices, bounds filters, counts searches and measures full context cycles in minutes', () => {
  const f = fixture()
  f.event('turn/start', { turn: 0 }, '2026-11-05T06:00:00.000Z')
  f.event('tool/call', { name: 'web_search', callId: 'x', arguments: '{"token":"never-store"}' })
  f.event('assistant/message', { message: { source: { provider: 'other', model: 'unknown' } }, usage: { inputTokens: 42, outputTokens: 1 }, stream: [] })
  f.event('assistant/message', { message: { source: { provider: 'other', model: 'unknown' } }, stream: [] })
  f.event('compaction/summary', { provider: 'deepseek', model: 'deepseek-flash', compactionId: 'a' })
  const result = f.telemetry.statistics()
  expect(result.context_fill).toEqual({ samples: 1, average_minutes: 120 })
  expect(result.reliability.web_searches).toBe(1); expect(result.total.unpriced).toBe(1)
  expect(result.total.missing_usage).toBe(2)
  expect(JSON.stringify(f.telemetry.logs({}))).not.toContain('never-store')
  expect(f.telemetry.statistics({ scope: 'worker' }).total.total).toBe(0)
})
it('prices disjoint cache tokens using provider-specific rates, long context and known peak hours', () => {
  const settings = StatisticsSettings.parse({ goPlan: 'go', holidays: ['2026-11-05'] })
  const u = { input: 1000000, read: 1000000, output: 1000000, write: 0 }
  expect(price('deepseek', 'deepseek-flash', u, at, settings).amount).toBeCloseTo(5.02)
  expect(price('opencode-go', 'deepseek-v4.1-flash', u, at, settings).amount).toBeCloseTo(1.506)
  expect(price('opencode-go', 'kimi-k3', u, at, settings).allowance).toBeCloseTo(18.3 / 15)
  expect(price('opencode-go', 'gpt-6-luna', u, at, settings).amount).toBeCloseTo(.97)
  expect(price('unrelated', 'deepseek-flash', u, at, settings).amount).toBeNull()
})
it('paginates private logs, redacts credentials and keeps accounting when retention removes old logs', () => {
  const f = fixture()
  f.telemetry.operation('output','o1','failed','Bearer super-private-credential token=another-secret https://x.example/?api_key=secret')
  f.telemetry.operation('output','o2','sent')
  const first = f.telemetry.logs({ limit: 1 });expect(first.has_more).toBe(true)
  const second = f.telemetry.logs({ before: first.next_cursor!, limit: 1 });expect(second.items).toHaveLength(1)
  expect(JSON.stringify(second)).not.toMatch(/super-private|another-secret|api_key=secret/)
  expect(f.telemetry.logs({ level: 'error' }).items).toHaveLength(1)
  f.usage('main','2026-01-01T00:00:00.000Z')
  expect(f.telemetry.statistics().total.total).toBe(1050)
  expect(f.telemetry.logs({ search: '模型' }).items).toHaveLength(0)
})

it('measures the first successful reply per original source and counts activations independently of model steps', () => {
  const f=fixture()
  f.usage()
  const input={event_id:'incoming',idempotency_key:'in',agent_id:'role',source_kind:'web',platform:'web',conversation_id:'web:u:c',account_id:'u',event_type:'message',timestamp:'2026-11-05T07:59:00.000Z',received_at:'2026-11-05T07:59:00.000Z',visibility:'private',content:[]}
  const outgoing={...input,event_id:'out',idempotency_key:'out',source_kind:'output-gateway',metadata:{origin_event_id:'incoming'}}
  f.store.insertEvent(input as never);f.store.insertEvent(outgoing as never)
  f.store.insertOutput({output_id:'out',event_id:'out',platform:'web',target:{account_id:'u',conversation_id:'web:u:c'},content:[],status:'sent',updated_at:'2026-11-05T07:59:30.000Z',error:''})
  f.store.startRun({run_id:'run',agent_id:'role',event_id:'incoming',session_id:'main',started_at:'2026-11-05T07:59:05.000Z'} as never)
  const stats=f.telemetry.statistics({since:'2026-11-05T00:00:00.000Z'})
  expect(stats.reply_latency).toEqual({samples:1,average_ms:30000,maximum_ms:30000})
  expect(stats.activations.main).toBe(1);expect(stats.activations.total).toBe(1)
  expect(stats.billing.windows[0]?.used).toBeCloseTo((.0003+.00075+.00027)/15/.2)
})

it('records native compaction pressure and alerts for no reduction without hiding numerical token metrics',()=>{
 const f=fixture();let tokens=150000
 f.telemetry.measure=()=>tokens
 f.event('compaction/start',{compactionId:'c',turn:null})
 f.event('compaction/summary',{compactionId:'c',provider:'p',model:'m'})
 tokens=40000;f.event('compaction/end',{compactionId:'c',turn:null})
 f.telemetry.metric('social_context','main',{tokens:750,password:'never-log-this'})
 const data=f.telemetry.statistics(),results=f.telemetry.logs({kind:'compaction_result'}).items
 expect(data.memory_metrics.injected_tokens).toBe(750)
 expect(results[0]?.data).toMatchObject({context_tokens_before:150000,context_tokens_after:40000,reduced:true,status:'completed'})
 f.event('compaction/start',{compactionId:'c2',turn:null});f.event('compaction/end',{compactionId:'c2',turn:null})
 expect(f.telemetry.health().alerts.some(alert=>alert.message.includes('未减少'))).toBe(true)
 expect(JSON.stringify(f.telemetry.logs({}))).not.toContain('never-log-this')
})
it('detects stale derived indices and dangling evidence, deduplicates alerts and resolves repaired invariants',()=>{
 const f=fixture(),memory=f.telemetry.memory
 const candidate=memory.put({kind:'candidate',title:'broken',text:'no evidence',created_at:memory.now(),source:{},data:{source_ids:['missing']}})
 f.host.db.exec('DELETE FROM amphoreus_memory_fts')
 f.telemetry.audit(true);f.telemetry.audit(true)
 expect(f.telemetry.health().alerts.map(alert=>(alert as any).key)).toEqual(expect.arrayContaining(['fts-mismatch','orphan-evidence']))
 expect(f.telemetry.logs({kind:'memory_invariant'}).items).toHaveLength(2)
 memory.update(candidate.id,{data:{source_ids:[]}});memory.rebuildSearch();f.telemetry.audit(true)
 expect(f.telemetry.health().alerts).toHaveLength(0)
})

it('accounts for isolated model API tests under their selected agent scope without counting a new activation',()=>{
 const {telemetry}=fixture()
 telemetry.auxiliary('opencode-go','kimi-k3',{inputTokens:4,outputTokens:2},25,true,'worker','model-test')
 const stats=telemetry.statistics()
 expect(stats.total.total).toBe(6)
 expect(stats.roles.find(role=>role.scope==='worker')?.total).toBe(6)
 expect(stats.activations.total).toBe(0)
 expect(telemetry.logs({}).items[0]).toMatchObject({session:'model-api-test',scope:'worker',summary:'模型API连通测试'})
})
