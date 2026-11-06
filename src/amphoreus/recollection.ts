import { z } from 'zod'
import { MemoryStore, memoryId, type MemoryBranch, type MemorySource } from './memory.ts'
import { TopicThreads } from './topic-threads.ts'

export interface MemoryAuthor { branch: MemoryBranch; source: MemorySource; call_id: string }
export const Memorize = z.object({ kind: z.enum(['candidate','insight','topic','diary_draft','self_draft']), title: z.string().min(1).max(200),
  content: z.string().min(1).max(32000), source_ids: z.array(z.string()).max(100).default([]), importance: z.number().min(0).max(1).default(.4),
  topic_id: z.string().optional(), related_task: z.string().optional(), replaces: z.string().optional(), job_id: z.string().optional(),
  diary_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).strict()

/** Candidate extraction and documented adoption are separate operations with distinct authorities. */
export class Recollection {
  constructor(readonly memory: MemoryStore) {}
  memorize(input: z.infer<typeof Memorize>, author: MemoryAuthor) {
    return this.memory.host.atomic(()=>this.record(input,author))
  }
  private canonicalTopic(id:string):string{
    const seen=new Set<string>()
    for(;;){
      if(seen.has(id))throw new Error('Cyclic topic reference')
      seen.add(id)
      const record=this.memory.get(id)
      if(!record)return id
      if(record.kind!=='topic')throw new Error('Topic ID belongs to another memory kind')
      const next=record.data.topic_id
      if(typeof next!=='string'||next===id)return id
      id=next
    }
  }
  /** Repair the earlier version-id-as-topic-id bug without rewriting or deleting original memory text. */
  repairTopics(){
    return this.memory.host.atomic(()=>{
      const records=this.memory.recent(100000,0,'topic'),groups=new Map<string,typeof records>(),changed:string[]=[]
      for(const record of records){
        const canonical=this.canonicalTopic(String(record.data.topic_id??record.id))
        if(record.data.topic_id!==canonical){
          const next=this.memory.update(record.id,{data:{...record.data,original_topic_id:record.data.original_topic_id??record.data.topic_id,topic_id:canonical}})
          groups.set(canonical,[...(groups.get(canonical)??[]),next]);changed.push(record.id)
        }else groups.set(canonical,[...(groups.get(canonical)??[]),record])
      }
      for(const versions of groups.values()){
        const active=versions.filter(record=>record.status==='active'),latest=active[0]
        if(!latest||active.length<2)continue
        const refs=[...new Set([...active].reverse().flatMap(record=>Array.isArray(record.data.source_ids)?record.data.source_ids as string[]:[]))]
        this.memory.update(latest.id,{data:{...latest.data,original_source_ids:latest.data.original_source_ids??latest.data.source_ids,source_ids:refs}})
        for(const old of active.slice(1)){
          this.memory.update(old.id,{status:'superseded',data:{...old.data,superseded_by:latest.id}});changed.push(old.id)
        }
      }
      if(changed.length)this.memory.put({id:memoryId('topic-reference-repair',this.memory.agentId,[...new Set(changed)].sort()),kind:'correction',title:'话题版本引用修复',
        text:'修复旧版本ID误作话题ID及重复活动版本；保留全部原始文字和来源引用。',created_at:this.memory.now(),source:{platform:'internal',actor_id:'memory-maintenance'},data:{repaired_ids:[...new Set(changed)]}})
      return [...new Set(changed)]
    })
  }
  private record(input:z.infer<typeof Memorize>,author:MemoryAuthor){
    if (['worker','topic'].includes(author.branch) && ['diary_draft','self_draft'].includes(input.kind)) throw new Error('Technical workers may record objective candidates, not personal diary or Self drafts')
    const id = memoryId('candidate', this.memory.agentId, author.source.session_id, author.call_id, input.kind)
    const existing=this.memory.get(id)
    if(existing)return existing
    const replaced=input.replaces?this.memory.get(input.replaces):undefined
    if(input.replaces&&!replaced)throw new Error('Replaced memory not found')
    if(input.kind==='topic'&&replaced&&replaced.kind!=='topic')throw new Error('A topic can only replace a topic version')
    const topicId=input.kind==='topic'?this.canonicalTopic(input.topic_id??(replaced?String(replaced.data.topic_id):memoryId('topic',this.memory.agentId,input.title))):input.topic_id
    if(input.kind==='topic'&&replaced&&this.canonicalTopic(String(replaced.data.topic_id))!==topicId)throw new Error('Cannot replace a different topic')
    const versions=input.kind==='topic'?this.memory.topicVersions(topicId!):[]
    const base=replaced??versions[0]
    const inherited=input.kind==='topic'&&Array.isArray(base?.data.source_ids)?base.data.source_ids as string[]:[]
    const sourceIds = [...new Set([...inherited,...input.source_ids])]
    const sources = sourceIds.map(id => {
      const record = this.memory.get(id)
      if (!record) throw new Error('Source memory is unavailable or belongs to another role')
      return record
    })
    const evidence = sources.some(r => r.kind === 'tool' && r.status === 'completed') || sources.some(r => r.kind === 'input' && /记住|重要|承诺|长期/.test(r.text))
    const importance = Math.min(.65, Math.min(.5, input.importance) + (evidence ? .15 : 0))
    const record = this.memory.put({ id, kind: input.kind, title: input.title, text: input.content, created_at: this.memory.now(),
      source: { ...author.source, branch: author.branch }, status: input.kind === 'topic' ? 'active' : 'candidate', importance,
      data: { source_ids: sourceIds, ...(topicId ? { topic_id: topicId } : {}), ...(input.related_task ? { related_task: input.related_task } : {}),
        ...(input.replaces ? { replaces: input.replaces } : {}), ...(input.job_id ? { job_id: input.job_id } : {}),
        ...(input.kind === 'diary_draft' ? { day: input.diary_date ?? this.memory.today() } : {}),
        ...(input.kind === 'self_draft' ? { base_version: this.currentSelf()?.id ?? null } : {}), evidence_based: evidence, revisions: [] } })
    if (input.kind === 'topic') for (const old of versions) {
      if (old.id !== id && old.status==='active') this.memory.update(old.id, { status: 'superseded', data: { ...old.data, superseded_by: id } })
    }
    if(input.kind==='topic')new TopicThreads(this.memory).attach(String(record.data.topic_id),sourceIds,author.source.session_id??author.branch)
    return record
  }
  decide(id: string, action: 'interesting' | 'adopt' | 'archive' | 'supersede', note: string, author: MemoryAuthor, relatedId?: string) {
    if (author.branch !== 'main' || !author.source.run_id) throw new Error('Only Main may adopt or revise a personal memory')
    const record = this.memory.get(id)
    if (!record || !['candidate','insight','diary_draft','self_draft'].includes(record.kind)) throw new Error('Not a candidate or insight')
    if (['diary_draft','self_draft'].includes(record.kind) && action !== 'archive') throw new Error('Use memory_confirm to confirm a formal personal draft')
    if (relatedId && !this.memory.get(relatedId)) throw new Error('Related memory not found')
    const decisionId = memoryId('decision', id, author.source.run_id, author.call_id)
    if (this.memory.get(decisionId)) return this.memory.get(id)!
    const status = action === 'adopt' ? 'adopted' : action === 'archive' ? 'archived' : action === 'supersede' ? 'superseded' : 'interesting'
    return this.memory.host.atomic(() => {
      this.memory.put({ id: decisionId, kind: 'decision', title: `Main ${status}：${record.title}`, text: note, created_at: this.memory.now(),
        source: { ...author.source, branch: 'main' }, importance: action === 'adopt' ? .95 : .6, data: { memory_id: id, previous_status: record.status, action, related_id: relatedId } })
      if (action === 'adopt' && this.memory.settings.reasoning.retainImportantRaw) {
        for (const sourceId of record.data.source_ids as string[] ?? []) {
          const raw = this.memory.get(sourceId)
          if (raw?.kind === 'reasoning' && raw.text && raw.status !== 'expired') this.memory.update(raw.id, {
            expires_at: new Date(Date.parse(raw.created_at) + this.memory.settings.reasoning.importantRetentionDays * 86400000).toISOString() })
        }
      }
      return this.memory.update(id, { status, importance: action === 'adopt' ? .95 : Math.max(record.importance, .6),
        data: { ...record.data, revisions: [...(record.data.revisions as string[] ?? []), decisionId], ...(relatedId ? { related_id: relatedId } : {}) } })
    })
  }
  topics(limit = 8, offset = 0) { return this.memory.find({ kind: 'topic', limit, offset }).map(({text,data,...record})=>({...record,topic_id:this.canonicalTopic(String(data.topic_id)),excerpt:text.slice(0,200),total_chars:text.length})) }
  currentSelf() { return this.memory.find({ kind: 'self', status: 'confirmed', limit: 1 })[0] }
  confirm(id: string, content: string | undefined, note: string, author: MemoryAuthor, expectedVersion?: string | null, adoptIds: string[] = []) {
    if (author.branch !== 'main' || !author.source.run_id) throw new Error('Only Main can confirm a formal diary or Self')
    const draft = this.memory.get(id), finalId = memoryId('confirmed', id)
    if (!draft || !['diary_draft','self_draft'].includes(draft.kind)) throw new Error('Not a personal draft')
    const existing = this.memory.get(finalId)
    if (existing) return existing
    const isSelf = draft.kind === 'self_draft', body = content ?? draft.text
    if (!body.trim() || body.length > (isSelf ? 4000 : 32000)) throw new Error('Keep Self concise (up to 4000 characters); diary up to 32000')
    const day = String(draft.data.day ?? this.memory.today())
    if (!isSelf && day !== this.memory.today()) throw new Error('Closed historical diaries are immutable; write the new understanding in today’s diary')
    const previous = isSelf ? this.currentSelf() : this.memory.find({ kind: 'diary', status: 'confirmed', limit: 100 }).find(r => r.data.day === day)
    if (isSelf && ((expectedVersion === undefined ? draft.data.base_version : expectedVersion) ?? null) !== (previous?.id ?? null)) throw new Error('Self changed since this draft; refresh and review before confirming')
    for (const ref of adoptIds) if (!['candidate','insight'].includes(this.memory.get(ref)?.kind ?? '')) throw new Error('Adoption must reference a real candidate or insight')
    return this.memory.host.atomic(() => {
      const record = this.memory.put({ id: finalId, kind: isSelf ? 'self' : 'diary', title: isSelf ? '我是谁' : day, text: body, status: 'confirmed', importance: .95,
        created_at: this.memory.now(), source: { ...author.source, branch: 'main' },
        data: { day: isSelf ? undefined : day, version: Number(previous?.data.version ?? 0) + 1, previous_id: previous?.id ?? null,
          draft_id: id, draft_source: draft.source, source_ids: draft.data.source_ids, confirmed_by_run: author.source.run_id, confirmation_note: note, job_id: draft.data.job_id } })
      if (previous) this.memory.update(previous.id, { status: 'superseded', data: { ...previous.data, superseded_by: finalId } })
      this.memory.update(id, { status: 'confirmed', data: { ...draft.data, formal_id: finalId, confirmed_by_run: author.source.run_id } })
      for (const ref of adoptIds) this.decide(ref, 'adopt', note, { ...author, call_id: `${author.call_id}:${ref}` }, finalId)
      return record
    })
  }
  topic(id: string, offset = 0, includeOriginal=false,limit=8,textOffset=0,size=4000) {
    return new TopicThreads(this.memory).recall({id,offset,include_original:includeOriginal,limit,text_offset:textOffset,size})
  }
}
