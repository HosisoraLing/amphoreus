import {mkdtempSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {afterEach,expect,it} from 'vitest'
import {Store} from '../src/app/store.ts'
import {MemoryStore} from '../src/amphoreus/memory.ts'
import {AmphoreusStore} from '../src/amphoreus/store.ts'
import {Recollection} from '../src/amphoreus/recollection.ts'
import {resolveTopic,assertTopicWrite,TopicRequest} from '../src/amphoreus/topics.ts'
const stops:(()=>void)[]=[]
afterEach(()=>{for(const stop of stops.splice(0))stop()})
it('loads only the current topic summary and source IDs, never every source or Main history',()=>{
 const dir=mkdtempSync(join(tmpdir(),'topic-agent-')),host=new Store(join(dir,'state.sqlite')),store=new AmphoreusStore(host),memory=new MemoryStore(host,'role'),r=new Recollection(memory)
 stops.push(()=>{host.close();rmSync(dir,{recursive:true,force:true})})
 const source=memory.put({kind:'input',title:'source',text:'original source body is not hydrated',created_at:memory.now(),source:{platform:'qq'}})
 const old=r.memorize({kind:'topic',title:'海边',content:'旧摘要',source_ids:[source.id],importance:.4},{branch:'main',source:{session_id:'main'},call_id:'topic-1'})
 const latest=r.memorize({kind:'topic',topic_id:String(old.data.topic_id),title:'海边',content:'最新摘要',source_ids:[],importance:.4},{branch:'main',source:{session_id:'main'},call_id:'topic-2'})
 const result=resolveTopic(memory,old.id)
 expect(result.topic_id).toBe(old.data.topic_id);expect(result.version).toBe(latest.id);expect(result.summary).toBe('最新摘要')
 expect(result.source_ids).toEqual([source.id]);expect(JSON.stringify(result)).not.toContain(source.text)
 expect(()=>resolveTopic(memory,source.id)).toThrow('Topic not found')
 expect(()=>assertTopicWrite(result.topic_id,{kind:'self_draft',topic_id:result.topic_id})).toThrow()
 expect(()=>assertTopicWrite(result.topic_id,{kind:'topic',topic_id:'other-topic'})).toThrow()
 expect(()=>assertTopicWrite(result.topic_id,{kind:'topic',topic_id:result.topic_id})).not.toThrow()
 expect(()=>TopicRequest.parse({topic_id:result.topic_id,question:'查询',extra:'not allowed'})).toThrow()
})
