/** Read-only invariant checks; no automatic repair, model calls, or history pruning. */
import type {MemoryStore} from './memory.ts'
import type {AmphoreusStore} from './store.ts'
export function inspectMemory(memory:MemoryStore,store:AmphoreusStore,now:number){
 const db=memory.host.db,cursor=store.record<number>('dreaming-cursor',memory.agentId)??0
 const pending=db.prepare("SELECT count(*) AS n,min(created_at) AS oldest FROM amphoreus_memory WHERE agent_id=? AND rowid>? AND kind IN ('input','speak','assistant','reasoning','report','tool')").get(memory.agentId,cursor)!
 const index=memory.searchStatus(),orphan=db.prepare(`SELECT m.id FROM amphoreus_memory m,json_each(m.data,'$.source_ids') r WHERE m.agent_id=? AND m.kind IN ('candidate','insight') AND NOT EXISTS(SELECT 1 FROM amphoreus_memory s WHERE s.agent_id=m.agent_id AND s.id=r.value) LIMIT 1`).get(memory.agentId)
 const failures=store.runs(3).filter(run=>run.agent_id===memory.agentId&&run.state==='failed'&&/context|compaction|time budget/i.test(run.error??'')).length
 const checks=[
  {key:'fts-mismatch',failed:!index.consistent,message:'记忆检索索引与原文记录不一致',data:index},
  {key:'orphan-evidence',failed:!!orphan,message:'语义候选存在无法回读的来源',data:{memory_id:orphan?.id??null}},
  {key:'dreaming-stalled',failed:!!(memory.settings.dreaming.enabled&&pending.oldest&&now-Date.parse(String(pending.oldest))>memory.settings.observability.dreamingStallHours*3600000),message:'长期历史尚未完成巩固',data:{pending:Number(pending.n),oldest:pending.oldest??null}},
  {key:'main-repeated-failure',failed:failures>=2,message:'主会话连续出现上下文或运行故障',data:{recent_failures:failures}},
 ]
 return{index,dreaming_cursor:cursor,dreaming_cursor_lag:Number(pending.n),oldest_pending_at:pending.oldest??null,
  candidates:db.prepare("SELECT status,count(*) AS count FROM amphoreus_memory WHERE agent_id=? AND kind IN ('candidate','insight') GROUP BY status").all(memory.agentId),checks}
}
