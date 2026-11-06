import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { Store } from '../src/app/store.ts'
import { AmphoreusStore } from '../src/amphoreus/store.ts'
import { MemorySettings, MemoryStore, memoryId } from '../src/amphoreus/memory.ts'
import { MemoryArchive } from '../src/amphoreus/archive.ts'
import { Recollection, Memorize } from '../src/amphoreus/recollection.ts'
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
const closes: (() => void)[] = []
afterEach(() => closes.splice(0).forEach(close => close()))
function setup(allowed = ['provider']) {
  const dir = mkdtempSync(join(tmpdir(), 'amphoreus-memory-')), host = new Store(join(dir, 'test.sqlite')), store = new AmphoreusStore(host)
  const memory = new MemoryStore(host, 'role', MemorySettings.parse({ reasoning: { allowedProviders: allowed } }), () => new Date('2026-11-03T08:00:00Z'))
  closes.push(() => { host.close(); rmSync(dir, { recursive: true, force: true }) })
  return { host, store, memory }
}
it('keeps branch insights as candidates until an evidenced Main adoption and retains revision history', () => {
  const { memory } = setup(), recollection = new Recollection(memory)
  const source = memory.put({ kind: 'reasoning', title: 'provided', text: '可回顾的接口构思', created_at: memory.now(), source: { branch: 'continuation' } })
  const author = { branch: 'continuation' as const, source: { session_id: 'fork', task_id: 'task' }, call_id: 'candidate' }
  const idea = recollection.memorize(Memorize.parse({ kind: 'insight', title: '星火构思', content: '保留故事中的一闪灵光', importance: 1, source_ids: [source.id] }), author)
  expect(idea.status).toBe('candidate'); expect(idea.importance).toBeLessThan(.7)
  expect(() => recollection.decide(idea.id, 'adopt', '我采用它', author)).toThrow('Only Main')
  const main = { branch: 'main' as const, source: { session_id: 'main', run_id: 'run' }, call_id: 'adopt' }
  const adopted = recollection.decide(idea.id, 'adopt', '将这一构思用于创作', main)
  expect(adopted).toMatchObject({ status: 'adopted', importance: .95, source: { branch: 'continuation' } })
  recollection.decide(idea.id, 'adopt', '同一调用重试', main)
  expect(memory.find({ kind: 'decision' })).toHaveLength(1)
  expect(adopted.data.revisions).toHaveLength(1)
})
it('links topic versions to original cross-platform records without merging their speaker identities', () => {
  const { memory } = setup(), recollection = new Recollection(memory)
  const first = memory.put({ kind: 'input', title: '同名用户', text: '第一段设计', created_at: memory.now(), source: { platform: 'qq', actor_id: 'qq:one' } })
  const second = memory.put({ kind: 'input', title: '同名用户', text: '第二段设计', created_at: memory.now(), source: { platform: 'web', actor_id: 'web:two' } })
  const author = { branch: 'worker' as const, source: { task_id: 'maintain' }, call_id: 'topic-1' }
  const old = recollection.memorize(Memorize.parse({ kind: 'topic', title: '设计风格', content: '初稿', source_ids: [first.id] }), author)
  const next = recollection.memorize(Memorize.parse({ kind: 'topic', topic_id: String(old.data.topic_id), title: '设计风格', content: '补充两个来源', source_ids: [first.id, second.id] }), { ...author, call_id: 'topic-2' })
  expect(memory.get(old.id)?.status).toBe('superseded')
  expect(memory.related(next.id).map(ref => ref.id)).toEqual(expect.arrayContaining([first.id, second.id]))
  expect(memory.related(first.id).map(ref => ref.id)).toContain(next.id)
  expect(recollection.topic(next.id,0,true).originals.map(ref => ref.source.actor_id)).toEqual(['qq:one','web:two'])
  expect(() => recollection.memorize(Memorize.parse({ kind: 'insight', title: '伪造', content: '不存在的事实', source_ids: ['fake'] }), author)).toThrow('Source memory')
})
it('does not supersede the latest topic when an earlier successful tool call is replayed', () => {
  const { memory } = setup(), recollection = new Recollection(memory)
  const author = { branch: 'worker' as const, source: { session_id: 'maintainer', task_id: 'maintain' }, call_id: 'first' }
  const input = Memorize.parse({ kind: 'topic', title: '增量话题', content: '旧版本' })
  const first = recollection.memorize(input, author)
  const latest = recollection.memorize({ ...input, content: '新版本', topic_id: String(first.data.topic_id) }, { ...author, call_id: 'second' })
  expect(recollection.memorize(input, author).id).toBe(first.id)
  expect(recollection.topics().map(topic => topic.id)).toEqual([latest.id])
  expect(memory.get(latest.id)?.status).toBe('active')
  expect(memory.get(first.id)?.data.superseded_by).toBe(latest.id)
  expect(memory.find({ kind: 'topic', historical: true })).toHaveLength(2)
})
it('accepts a topic version as a reference, exposes its canonical ID, and preserves incremental source history',()=>{
  const {memory}=setup(),recollection=new Recollection(memory),author={branch:'worker' as const,source:{session_id:'worker'},call_id:'first'}
  const source=memory.put({kind:'input',title:'原始来源',text:'第一段',created_at:memory.now(),source:{platform:'qq'}})
  const extra=memory.put({kind:'input',title:'新增来源',text:'第二段',created_at:memory.now(),source:{platform:'web'}})
  const first=recollection.memorize(Memorize.parse({kind:'topic',title:'版本',content:'第一版',source_ids:[source.id]}),author)
  const next=recollection.memorize(Memorize.parse({kind:'topic',topic_id:first.id,replaces:first.id,title:'版本',content:'第二版',source_ids:[extra.id]}),{...author,call_id:'next'})
  expect(next.data.topic_id).toBe(first.data.topic_id)
  expect(recollection.topics()).toMatchObject([{id:next.id,topic_id:first.data.topic_id}])
  expect(recollection.topic(String(first.data.topic_id),0,true).originals.map(ref=>ref.memory_id)).toEqual([source.id,extra.id])
  expect(recollection.topic(first.id).text).toBe('第一版')
  expect(()=>recollection.memorize(Memorize.parse({kind:'topic',topic_id:source.id,title:'非法',content:'不能把消息当话题ID'}),{...author,call_id:'bad'})).toThrow('another memory kind')
  expect(recollection.topics()).toHaveLength(1)
})
it('repairs legacy topic chains and duplicate active versions without deleting original text, and is replay safe',()=>{
  const {memory}=setup(),recollection=new Recollection(memory)
  const first=memory.put({kind:'topic',title:'分支归档',text:'旧版本原文',created_at:'2026-11-03T01:00:00Z',source:{branch:'worker'},status:'active',data:{topic_id:'canonical',source_ids:[]}})
  const latest=memory.put({kind:'topic',title:'分支归档',text:'增量版本原文',created_at:'2026-11-03T02:00:00Z',source:{branch:'worker'},status:'active',data:{topic_id:first.id,source_ids:[]}})
  expect(recollection.repairTopics()).toContain(latest.id)
  expect(recollection.topics()).toMatchObject([{id:latest.id,topic_id:'canonical'}])
  expect(memory.get(first.id)).toMatchObject({status:'superseded',text:'旧版本原文'})
  expect(memory.get(latest.id)?.text).toBe('增量版本原文')
  expect(recollection.repairTopics()).toEqual([])
})
it('reserves formal Self and diary confirmation for Main, preserves versions and rejects stale or closed drafts', () => {
  const { memory } = setup(), recollection = new Recollection(memory)
  const branch = { branch: 'continuation' as const, source: { session_id: 'fork', task_id: 'task' }, call_id: 'self-draft' }
  const self = recollection.memorize(Memorize.parse({ kind: 'self_draft', title: '我是谁', content: '我想把故事写得温柔。' }), branch)
  expect(recollection.currentSelf()).toBeUndefined()
  expect(() => recollection.confirm(self.id, undefined, '确认', branch)).toThrow('Only Main')
  expect(() => recollection.memorize(Memorize.parse({ kind: 'self_draft', title: '越权', content: '不应写入' }), { ...branch, branch: 'worker' })).toThrow('Technical workers')
  const main = { branch: 'main' as const, source: { session_id: 'main', run_id: 'run' }, call_id: 'confirm' }
  const formal = recollection.confirm(self.id, '我珍惜温柔，也愿意保持好奇。', '我审阅后改成自己的表述', main)
  expect(formal).toMatchObject({ kind: 'self', source: { branch: 'main' }, data: { version: 1, draft_source: { branch: 'continuation' } } })
  expect(recollection.confirm(self.id, '重复确认', '重试', main).id).toBe(formal.id)
  const next = recollection.memorize(Memorize.parse({ kind: 'self_draft', title: '新理解', content: '我也愿意学习。' }), { ...branch, call_id: 'next' })
  const stale = recollection.memorize(Memorize.parse({ kind: 'self_draft', title: '稍后的建议', content: '旧视图草稿。' }), { ...branch, call_id: 'stale' })
  const second = recollection.confirm(next.id, undefined, '接受新理解', { ...main, call_id: 'confirm-next' })
  expect(second.data.version).toBe(2); expect(memory.get(formal.id)?.status).toBe('superseded')
  expect(() => recollection.confirm(stale.id, undefined, '旧草稿', main)).toThrow('Self changed')
  const diary = recollection.memorize(Memorize.parse({ kind: 'diary_draft', title: '昨天', content: '昨天的日记', diary_date: '2026-11-02' }), { ...branch, call_id: 'diary' })
  expect(() => recollection.confirm(diary.id, undefined, '确认过去', main)).toThrow('historical diaries')
})
it('confirms a legacy Self draft with no base version only while no formal Self exists', () => {
  const { memory } = setup(), recollection = new Recollection(memory)
  const main = { branch: 'main' as const, source: { session_id: 'main', run_id: 'review' }, call_id: 'confirm-legacy' }
  const draft = (title: string, data: Record<string, unknown> = {}) => memory.put({
    kind: 'self_draft', title, text: 'Synthetic legacy Self.', created_at: memory.now(), source: { branch: 'continuation' }, data,
  })
  const first = draft('first'), stale = draft('stale'), explicitNull = draft('null', { base_version: null })
  const formal = recollection.confirm(first.id, undefined, 'reviewed first Self', main)
  expect(formal).toMatchObject({ kind: 'self', status: 'confirmed', data: { version: 1, previous_id: null } })
  for (const pending of [stale, explicitNull]) {
    expect(() => recollection.confirm(pending.id, undefined, 'stale draft', main)).toThrow('Self changed')
    expect(() => recollection.confirm(pending.id, undefined, 'explicit empty version', main, null)).toThrow('Self changed')
    expect(memory.get(pending.id)?.data.formal_id).toBeUndefined()
  }
  const reviewed = recollection.confirm(stale.id, undefined, 'reviewed against current Self', main, formal.id)
  expect(reviewed.data).toMatchObject({ version: 2, previous_id: formal.id })
  expect(memory.get(formal.id)?.status).toBe('superseded')
})
it('retains exact global text, scopes roles, paginates reads and ranks lasting importance without losing history', () => {
  const { memory, host } = setup()
  const old = memory.put({ kind: 'input', title: '重要约定', text: '青竹731'.repeat(1000), created_at: '2020-01-01T00:00:00Z', source: { platform: 'qq', conversation_id: 'group:1' }, importance: 1 })
  memory.put({ kind: 'input', title: '小事', text: '青竹731', created_at: memory.now(), source: { platform: 'web' }, importance: .1 })
  expect(memory.find({ query: '青竹731' })[0]?.id).toBe(old.id)
  const first = memory.read(old.id, 0, 500), next = memory.read(old.id, first.next_offset!, 12000)
  expect(first.text + next.text).toBe(old.text)
  expect(new MemoryStore(host, 'other').get(old.id)).toBeUndefined()
  memory.update(old.id, { status: 'superseded' })
  expect(memory.find({ query: '青竹731' })).toHaveLength(1)
  expect(memory.find({ query: '青竹731', historical: true })).toHaveLength(2)
})
it('archives committed assistant text and provided reasoning separately, idempotently, with provenance and expiry', async () => {
  const { memory, store } = setup(), archive = new MemoryArchive(memory, store, {} as Context)
  archive.bind({ session_id: 'main', branch: 'main', event_id: 'origin', run_id: 'run', provider: 'provider', model: 'model' })
  let thoughts = 0; archive.onThought = async () => { thoughts++ }
  const session = { id: 'main', isOwnSeq: () => true } as unknown as Session
  const event = { type: 'assistant/message', seq: 1, time: Date.parse(memory.now()), data: { turn: 1, step: 2, interrupted: true,
    message: { id: 'msg', content: [{ type: 'text', text: '想把星光写进故事。' }, { type: 'reasoning', text: 'provided creative idea' }] }, stream: [{ private: 'never copy deltas' }] } } as unknown as SessionEvent
  await archive.observe(session, event); await archive.observe(session, event)
  expect(thoughts).toBe(1)
  expect(memory.find({ kind: 'assistant' })[0]).toMatchObject({ text: '想把星光写进故事。', status: 'interrupted', source: { event_id: 'origin', run_id: 'run', step: 2, branch: 'main' } })
  expect(memory.find({ kind: 'reasoning' })[0]).toMatchObject({ text: 'provided creative idea', status: 'interrupted' })
  const old = { ...event, seq: 2, time: Date.parse('2026-10-01T00:00:00Z') } as SessionEvent
  await archive.observe(session, old)
  expect(memory.get(memoryId('main', 2, 'reasoning'))).toMatchObject({ text: '', status: 'expired' })
  expect(memory.get(memoryId('main', 2, 'assistant'))?.text).toBe('想把星光写进故事。')
  await archive.observe(session, { type: 'tool/call', seq: 3, time: Date.parse(memory.now()), data: { name: 'bash', callId: 'call', arguments: '{"api_key":"private-value","command":"pwd"}' } } as unknown as SessionEvent)
  expect(memory.find({ kind: 'tool' })[0]?.text).not.toContain('private-value')
})
it('does not copy inherited Fork history or invent unavailable/disallowed reasoning', async () => {
  const { memory, store } = setup([]), archive = new MemoryArchive(memory, store, {} as Context)
  archive.bind({ session_id: 'child', branch: 'continuation', parent_session_id: 'main', task_id: 'task', provider: 'provider' })
  const session = { id: 'child', isOwnSeq: (seq: number) => seq >= 10 } as unknown as Session
  const make = (seq: number, content: unknown[]) => ({ type: 'assistant/message', seq, time: Date.parse(memory.now()), data: { turn: 1, step: 1, message: { id: 'msg', content } } }) as unknown as SessionEvent
  await archive.observe(session, make(1, [{ type: 'text', text: 'inherited' }]))
  await archive.observe(session, make(10, [{ type: 'text', text: 'child thought' }]))
  await archive.observe(session, make(11, [{ type: 'reasoning', text: 'not permitted' }]))
  expect(memory.find({ kind: 'assistant' }).map(r => r.text)).toEqual(['child thought'])
  expect(memory.get(memoryId('child', 10, 'reasoning'))?.status).toBe('unavailable')
  expect(memory.get(memoryId('child', 11, 'reasoning'))).toMatchObject({ text: '', status: 'disabled' })
})

it('validates structured evidence and deduplicates reprocessed claims without reviving rejected candidates',()=>{
 const {memory}=setup(),recall=new Recollection(memory)
 const input=memory.put({kind:'input',title:'preference',text:'I now prefer tea.',created_at:memory.now(),source:{actor_id:'person'}})
 const thought=memory.put({kind:'assistant',title:'idea',text:'Maybe a lantern shaped like waves.',created_at:memory.now(),source:{branch:'main'}})
 const job=memory.put({kind:'consolidation',title:'review',text:'',created_at:memory.now(),source:{},data:{from:0,to:memory.position()}})
 const author={branch:'continuation' as const,source:{session_id:'fork'},call_id:'first'}
 const raw={kind:'candidate',title:'Tea',content:'The user prefers tea.',category:'preference',evidence_type:'explicit',job_id:job.id,source_ids:[input.id]}
 const candidate=recall.memorize(Memorize.parse(raw),author)
 expect(candidate.data).toMatchObject({category:'preference',evidence_type:'explicit',valid_from:null,valid_to:null,review_job_id:job.id})
 expect(()=>recall.memorize(Memorize.parse({...raw,source_ids:[]}),{...author,call_id:'no-source'})).toThrow('real source_ids')
 expect(()=>recall.memorize(Memorize.parse({...raw,source_ids:[thought.id]}),{...author,call_id:'not-explicit'})).toThrow('original input')
 const main={branch:'main' as const,source:{run_id:'review'},call_id:'reject'}
 recall.decide(candidate.id,'archive','not needed',main)
 const replay=recall.memorize(Memorize.parse(raw),{...author,call_id:'different-on-retry'})
 expect(replay.id).toBe(candidate.id);expect(replay.status).toBe('archived')
 const idea=recall.memorize(Memorize.parse({...raw,kind:'insight',category:'creative_insight',evidence_type:'inferred',source_ids:[thought.id],content:'Explore a wave lantern.'}),{...author,call_id:'idea'})
 expect(idea.status).toBe('candidate');expect(idea.data.evidence_type).toBe('inferred')
 expect(memory.find({kind:'self'})).toHaveLength(0)
})
