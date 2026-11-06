import {mkdtempSync,rmSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {expect,it} from 'vitest'
import {Store} from '../src/app/store.ts'
import {AmphoreusStore} from '../src/amphoreus/store.ts'
import {MemoryStore} from '../src/amphoreus/memory.ts'
import {Recollection,Memorize} from '../src/amphoreus/recollection.ts'
import {memoryEvaluationCases} from './fixtures/memory-evaluation.ts'
it('retrieves supported evidence across 40 synthetic memory cases and preserves uncertainty and chronology',()=>{
 const dir=mkdtempSync(join(tmpdir(),'memory-evaluation-')),host=new Store(join(dir,'db.sqlite'))
 try{
  new AmphoreusStore(host);const memory=new MemoryStore(host,'synthetic'),r=new Recollection(memory)
  memory.entityRefs=ref=>ref==='qq:100'||ref==='web:owner:100'?['qq:100','web:owner:100']:[]
  const main={branch:'main' as const,source:{session_id:'main',run_id:'review'},call_id:'seed'}
  for(const item of memoryEvaluationCases){
   if(item.category==='abstain')continue
   const thought=['creative','thought_action'].includes(item.category)
   const source=memory.put({id:item.evidenceIds[0],kind:thought?'assistant':'input',title:item.id,text:`${item.id}: ${item.expectedFacts.join('; ')}`,created_at:memory.now(),source:{branch:'main',actor_id:'100',platform:'qq'}})
   if(['fact','identity','evidence','temporal','creative'].includes(item.category)){
    const candidate=r.memorize(Memorize.parse({kind:thought?'insight':'candidate',title:item.id,content:source.text,category:thought?'creative_insight':'fact',evidence_type:thought?'inferred':'explicit',source_ids:[source.id],...(item.category==='identity'?{entity_refs:['qq:100']}:{}),...(item.category==='temporal'?{valid_from:'2026-10-01T00:00:00Z'}:{})}),{...main,call_id:item.id})
    if(!thought)r.decide(candidate.id,'adopt','supported',{...main,call_id:`adopt-${item.id}`})
    if(item.category==='temporal'){
     const correction=memory.put({kind:'input',title:'new',text:`${item.query}: new preference`,created_at:memory.now(),source:{}})
     const next=r.memorize(Memorize.parse({kind:'candidate',title:item.id,content:correction.text,category:'preference',evidence_type:'explicit',source_ids:[correction.id],replaces:candidate.id,valid_from:'2026-11-01T00:00:00Z'}),{...main,call_id:`new-${item.id}`})
     r.decide(next.id,'adopt','updated',{...main,call_id:`adopt-new-${item.id}`})
    }
   }
  }
  let supported=0,recalled=0,validated=0,abstained=0,calibrated=0
  for(const item of memoryEvaluationCases){
   const rows=memory.find({query:item.query,limit:8,...(item.category==='temporal'?{as_of:'2026-10-15T00:00:00Z'}:{}),...(item.category==='identity'?{entity_ref:'web:owner:100'}:{})})
   if(item.expectedBehavior==='not-found'){expect(rows).toHaveLength(0);abstained++;continue}
   supported++
   const evidence=new Set(rows.flatMap(row=>[row.id,...(row.data.source_ids as string[]??[])]))
   expect(item.evidenceIds.every(id=>evidence.has(id))).toBe(true);recalled++
   for(const id of item.evidenceIds){const source=memory.get(id);expect(source).toBeDefined();for(const fact of item.expectedFacts)expect(source!.text).toContain(fact)}validated++
   if(item.expectedBehavior==='uncertain'){expect(rows.some(row=>row.kind==='insight'&&row.status==='candidate'&&row.data.evidence_type==='inferred')).toBe(true);calibrated++}
   if(item.category==='thought_action')expect(rows.every(row=>row.kind!=='speak')).toBe(true)
   if(item.category==='temporal')expect(rows.some(row=>row.text.includes('new preference'))).toBe(false)
  }
  const report={cases:memoryEvaluationCases.length,recall_at_8:recalled/supported,evidence_correctness:validated/supported,abstention_cases:abstained,uncertainty_cases:calibrated,model_answer_evaluated:false,production_data_used:false,note:'Deterministic retrieval/source regression, not an LLM answer-quality or hallucination-rate evaluation.'}
  if(process.env.AMPHOREUS_EVALUATION_REPORT)writeFileSync(process.env.AMPHOREUS_EVALUATION_REPORT,JSON.stringify(report,null,2)+'\n')
  expect(report.cases).toBe(40)
 }finally{host.close();rmSync(dir,{recursive:true,force:true})}
})
