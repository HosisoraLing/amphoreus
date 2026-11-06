import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach,expect,it,vi} from 'vitest'
import {Store} from '../src/app/store.ts'
import {AmphoreusStore} from '../src/amphoreus/store.ts'
import {MemoryStore} from '../src/amphoreus/memory.ts'
import {Recollection} from '../src/amphoreus/recollection.ts'
import {TopicThreads} from '../src/amphoreus/topic-threads.ts'
import {TopicOrganizer,type OrganizerClassify} from '../src/amphoreus/topic-organizer.ts'
const stops:(()=>Promise<void>|void)[]=[]
afterEach(async()=>{for(const stop of stops.splice(0).reverse())await stop()})
function open(classify:OrganizerClassify=async()=>({groups:[]})){
 const dir=mkdtempSync(join(tmpdir(),'topic-threads-')),host=new Store(join(dir,'db.sqlite')),store=new AmphoreusStore(host),memory=new MemoryStore(host,'role'),threads=new TopicThreads(memory),organizer=new TopicOrganizer(memory,store,classify)
 stops.push(async()=>{await organizer.stop();host.close();rmSync(dir,{recursive:true,force:true})})
 const add=(text:string,kind='input')=>memory.put({kind,title:'original',text,created_at:memory.now(),source:{branch:'main',platform:'qq',actor_id:kind==='assistant'?'fish':'123'},status:kind==='speak'?'sent':'complete',data:{visibility:'public',source_kind:'napcat',blocks:[{type:'text',text},{type:'image',url:'https://media.test/img',original:{base64:'must-not-copy'}}]}})
 return{host,store,memory,threads,organizer,add}
}
it('stores ordered conversation originals and thoughts separately, summary only by default, explicit paged text recall',()=>{
 const f=open(),message=f.add('original message'),thought=f.add('private thought','assistant'),speech=f.add('sent words','speak')
 const topic=new Recollection(f.memory).memorize({kind:'topic',title:'旅行',content:'brief summary',source_ids:[message.id,thought.id,speech.id],importance:.4},{branch:'main',source:{session_id:'main'},call_id:'thread'})
 const id=String(topic.data.topic_id),summary=f.threads.recall({id})
 expect(summary.originals).toEqual([]);expect(summary.total_entries).toBe(3);expect(JSON.stringify(summary)).not.toContain('private thought')
 const first=f.threads.recall({id,include_original:true,limit:2})
 expect(first.originals.map(r=>r.type)).toEqual(['message','thought']);expect(first.originals[0]!.text).toBe('original message');expect(first.next_offset).toBe(2)
 expect(f.threads.recall({id,include_original:true,offset:2}).originals[0]?.type).toBe('speech')
 expect(JSON.stringify(first.originals)).not.toContain('must-not-copy');expect(first.originals[0]!.blocks).toEqual([{type:'image',url:'https://media.test/img'}])
 f.threads.attach(id,[message.id],'retry');expect(f.threads.recall({id}).total_entries).toBe(3)
})
it('does not call models while disabled; opt-in batches classify to existing/new threads and are idempotent',async()=>{
 const classify=vi.fn<OrganizerClassify>(async input=>({groups:input.records.map((r,i)=>({new_key:`thread-${i}`,title:`topic ${i}`,summary:'summary',source_ids:[r.id]}))}))
 const f=open(classify);f.add('before enabling');await f.organizer.tick();expect(classify).not.toHaveBeenCalled()
 f.organizer.configure({enabled:true});const a=f.add('message about rice'),b=f.add('thought about swimming','assistant')
 await Promise.all([f.organizer.tick(),f.organizer.tick()]);expect(classify).toHaveBeenCalledTimes(1)
 expect(f.memory.find({kind:'topic',status:'active'})).toHaveLength(2)
 expect(f.memory.find({kind:'topic_entry'}).map(r=>r.data.memory_id).sort()).toEqual([a.id,b.id].sort())
 await f.organizer.tick();expect(classify).toHaveBeenCalledTimes(1)
 f.organizer.configure({enabled:false});f.add('disabled period');f.organizer.configure({enabled:true});await f.organizer.tick();expect(classify).toHaveBeenCalledTimes(1)
})
it('extends an existing thread, stores immutable thoughts and retries the same durable batch after process restoration',async()=>{
 let attempts=0
 const classify:OrganizerClassify=async input=>{if(++attempts===1)throw Error('temporary failure');return{groups:[{topic_id:input.topics[0]!.topic_id,title:'旅行',summary:'updated summary',source_ids:input.records.map(r=>r.id)}]}}
 const f=open(classify),first=f.add('first conversation')
 const topic=new Recollection(f.memory).memorize({kind:'topic',title:'旅行',content:'original summary',source_ids:[first.id],importance:.4},{branch:'main',source:{session_id:'main'},call_id:'existing'})
 f.organizer.configure({enabled:true});const thought=f.add('new thought','assistant')
 await f.organizer.tick();expect(f.organizer.status().last_job?.status).toBe('pending')
 const restored=new TopicOrganizer(f.memory,f.store,classify);await restored.tick()
 const recalled=f.threads.recall({id:String(topic.data.topic_id),include_original:true})
 expect(recalled.originals.map(r=>r.memory_id)).toEqual([first.id,thought.id]);expect(recalled.text).toBe('updated summary')
 expect(f.memory.get(topic.id)?.text).toBe('original summary');expect(restored.status().last_job?.status).toBe('complete')
 await restored.tick();expect(attempts).toBe(2);await restored.stop()
})

it('rejects missing/duplicate/fabricated assignments atomically and retains originals for retry',async()=>{
 const classify=vi.fn<OrganizerClassify>(async()=>({groups:[{new_key:'x',title:'x',summary:'x',source_ids:['fake']}]})),f=open(classify)
 f.organizer.configure({enabled:true});const source=f.add('do not lose')
 await f.organizer.tick();expect(f.memory.find({kind:'topic'})).toHaveLength(0);expect(f.memory.get(source.id)?.text).toBe('do not lose')
 expect(f.organizer.status().last_job?.status).toBe('pending')
 await f.organizer.tick();await f.organizer.tick();expect(f.organizer.settings().enabled).toBe(false)
})
it('paginates long originals without leaking text blocks and refuses stale topic-summary overwrite',async()=>{
 let release!:(value:unknown)=>void
 const f=open(async()=>new Promise(resolve=>{release=resolve})),text='x'.repeat(9000),source=f.add(text),recollection=new Recollection(f.memory)
 const author={branch:'main' as const,source:{session_id:'main'},call_id:'initial'}
 const topic=recollection.memorize({kind:'topic',title:'long',content:'old summary',source_ids:[source.id],importance:.4},author)
 const page=f.threads.recall({id:String(topic.data.topic_id),include_original:true,size:200})
 expect(page.originals[0]!.text).toHaveLength(200);expect(page.originals[0]!.next_text_offset).toBe(200)
 expect(JSON.stringify(page.originals[0]!.blocks)).not.toContain('xxx')
 f.organizer.configure({enabled:true});const newer=f.add('new message');const run=f.organizer.tick()
 const latest=recollection.memorize({kind:'topic',topic_id:String(topic.data.topic_id),title:'long',content:'newer decision',source_ids:[],importance:.4},{...author,call_id:'concurrent'})
 release({groups:[{topic_id:topic.data.topic_id,title:'long',summary:'stale summary',source_ids:[newer.id]}]});await run
 expect(f.memory.topicVersions(String(topic.data.topic_id))[0]!.id).toBe(latest.id)
 expect(f.organizer.status().last_job?.error).toContain('Topic changed')
})

it('honors role shutdown and source policy changes without publishing stale classifications',async()=>{
 let release!:(value:unknown)=>void
 const classify=vi.fn<OrganizerClassify>(async()=>new Promise(resolve=>{release=resolve})),f=open(classify)
 f.organizer.configure({enabled:true});const source=f.add('queued')
 f.organizer.canRun=()=>false;await f.organizer.tick();expect(classify).not.toHaveBeenCalled()
 f.organizer.canRun=()=>true;const running=f.organizer.tick();f.organizer.canRun=()=>false;f.organizer.reconcile()
 release({groups:[{new_key:'x',title:'x',summary:'x',source_ids:[source.id]}]});await running
 expect(f.memory.find({kind:'topic'})).toHaveLength(0)
 f.organizer.canRun=()=>true;const next=f.organizer.tick();f.organizer.canInclude=()=>false
 release({groups:[{new_key:'x',title:'x',summary:'x',source_ids:[source.id]}]});await next
 expect(f.memory.find({kind:'topic'})).toHaveLength(0)
})

it('disabling aborts an in-flight batch without committing a topic or original assignment',async()=>{
 let release!:(value:unknown)=>void
 const classify:OrganizerClassify=async()=>new Promise(resolve=>{release=resolve}),f=open(classify)
 f.organizer.configure({enabled:true});f.add('pending');const run=f.organizer.tick()
 f.organizer.configure({enabled:false});release({groups:[{new_key:'x',title:'x',summary:'x',source_ids:[]}]});await run
 expect(f.memory.find({kind:'topic'})).toHaveLength(0);expect(f.memory.find({kind:'topic_entry'})).toHaveLength(0)
})
