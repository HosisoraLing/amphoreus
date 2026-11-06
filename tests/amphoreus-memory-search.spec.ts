import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach,expect,it} from 'vitest'
import {Store} from '../src/app/store.ts'
import {AmphoreusStore} from '../src/amphoreus/store.ts'
import {MemoryStore,MemorySettings} from '../src/amphoreus/memory.ts'
import {Recollection,Memorize} from '../src/amphoreus/recollection.ts'
const close:(()=>void)[]=[]
afterEach(()=>close.splice(0).forEach(fn=>fn()))
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'memory-search-')),host=new Store(join(dir,'db.sqlite'));new AmphoreusStore(host)
 close.push(()=>{host.close();rmSync(dir,{recursive:true,force:true})})
 let now=new Date('2026-11-03T08:00:00Z')
 const memory=new MemoryStore(host,'role',MemorySettings.parse({}),()=>now)
 const put=(text:string,title='')=>memory.put({kind:'input',title,text,created_at:memory.now(),source:{platform:'qq',actor_id:'1'}})
 return{host,memory,put,advance:()=>{now=new Date('2027-11-03T08:00:00Z')}}
}
it('filters indexed candidates through real phrases and preserves short, English, mixed and historical queries',()=>{
 const f=fixture(),good=f.put('北京大学的 SketchPad_alpha'),bad=f.put('北京、京大、大学分别出现'),short=f.put('茶'),partial=f.put('preference')
 expect(f.memory.find({query:'北京大学'}).map(r=>r.id)).toEqual([good.id])
 expect(f.memory.find({query:'北京'}).map(r=>r.id)).toContain(bad.id)
 expect(f.memory.find({query:'茶'}).map(r=>r.id)).toEqual([short.id])
 expect(f.memory.find({query:'ference'}).map(r=>r.id)).toEqual([partial.id])
 expect(f.memory.find({query:'SketchPad_alpha'}).map(r=>r.id)).toEqual([good.id])
 expect(()=>f.memory.find({query:'" OR * NEAR(北京)'})).not.toThrow()
 f.memory.update(good.id,{status:'archived'})
 expect(f.memory.find({query:'北京大学'})).toHaveLength(0)
 expect(f.memory.find({query:'北京大学',historical:true})[0]?.id).toBe(good.id)
 expect(f.memory.searchStatus().consistent).toBe(true)
})
it('removes expired reasoning from both the authoritative text and every FTS lookup',()=>{
 const f=fixture(),record=f.memory.put({kind:'reasoning',title:'private',text:'过期推理秘密',created_at:f.memory.now(),expires_at:'2026-11-04T00:00:00Z',source:{}})
 expect(f.memory.find({query:'推理秘密'})).toHaveLength(1)
 f.advance();expect(f.memory.get(record.id)?.text).toBe('')
 expect(f.memory.find({query:'推理秘密',historical:true})).toHaveLength(0)
 expect(f.host.db.prepare("SELECT count(*) AS n FROM amphoreus_memory_fts WHERE amphoreus_memory_fts MATCH ?").get('"g63a8x7406"')?.n).toBe(0)
 f.memory.rebuildSearch();expect(f.memory.searchStatus()).toMatchObject({consistent:true,missing:0})
})
it('rebuilds an old schema without changing original IDs/text/source and rejects future schemas',()=>{
 const f=fixture(),record=f.put('旧版中文历史')
 f.host.db.exec("DROP TABLE amphoreus_memory_fts; UPDATE amphoreus_meta SET value='1' WHERE key='memory_schema_version'")
 const upgraded=new MemoryStore(f.host,'role');expect(upgraded.get(record.id)).toEqual(record)
 expect(upgraded.find({query:'中文历史'})[0]?.id).toBe(record.id)
 f.host.db.exec("UPDATE amphoreus_meta SET value='99' WHERE key='memory_schema_version'")
 expect(()=>new MemoryStore(f.host,'role')).toThrow('Unsupported memory schema')
})
it('keeps fact history, closes evidenced validity and expands only verified entity identities',()=>{
 const f=fixture(),r=new Recollection(f.memory),source=f.put('改为喝茶'),main={branch:'main' as const,source:{session_id:'main',run_id:'run'},call_id:'a'}
 f.memory.entityRefs=ref=>['qq:1','web:owner:one'].includes(ref)?['qq:1','web:owner:one']:[]
 const old=r.memorize(Memorize.parse({kind:'candidate',title:'preference',content:'coffee',category:'preference',evidence_type:'explicit',source_ids:[source.id],valid_from:'2026-11-01T00:00:00Z',entity_refs:['qq:1']}),main)
 r.decide(old.id,'adopt','confirmed',main)
 const next=r.memorize(Memorize.parse({kind:'candidate',title:'preference',content:'tea',category:'preference',evidence_type:'explicit',source_ids:[source.id],valid_from:'2026-11-03T08:00:00+08:00',entity_refs:['qq:1'],replaces:old.id}),{...main,call_id:'b'})
 r.decide(next.id,'adopt','new preference',{...main,call_id:'adopt-new'})
 expect(f.memory.get(old.id)?.text).toBe('coffee')
 expect(f.memory.find({as_of:'2026-11-02T00:00:00Z'}).map(r=>r.id)).toEqual([old.id])
 expect(f.memory.find({current_facts:true,entity_ref:'web:owner:one'}).map(r=>r.id)).toEqual([next.id])
 f.memory.entityRefs=ref=>[ref]
 expect(f.memory.find({current_facts:true,entity_ref:'web:owner:one'})).toHaveLength(0)
 f.memory.entityRefs=()=>[]
 expect(()=>r.memorize(Memorize.parse({kind:'candidate',title:'unknown',content:'x',category:'fact',source_ids:[source.id],entity_refs:['same nickname']}),{...main,call_id:'bad'})).toThrow('verified stable identities')
})

it('pages exact phrases before compatible individual-term matches without duplicates',()=>{
 const f=fixture(),exact=f.put('alpha beta'),partial=f.put('alpha separated beta')
 expect(f.memory.find({query:'alpha beta',limit:1}).map(row=>row.id)).toEqual([exact.id])
 expect(f.memory.find({query:'alpha beta',limit:1,offset:1}).map(row=>row.id)).toEqual([partial.id])
 expect(f.memory.find({query:'alpha beta',limit:1,offset:2})).toHaveLength(0)
})
