/** Ordered immutable topic members: conversation originals and Main thoughts are distinct from summaries. */
import { z } from 'zod'
import { MemoryStore,memoryId,type MemoryRecord } from './memory.ts'
export const TopicRecall=z.object({id:z.string().min(1),include_original:z.boolean().default(false),offset:z.number().int().min(0).default(0),
  limit:z.number().int().min(1).max(20).default(8),text_offset:z.number().int().min(0).default(0),size:z.number().int().min(200).max(12000).default(4000)}).strict()
/** Keep only references for media, never copy platform base64/transport payloads into topic records. */
export function referenceBlocks(value:unknown):unknown[] {
 if(!Array.isArray(value))return []
 return value.map((item:Record<string,unknown>)=>{
  if(item.type==='text')return{type:'text',text:String(item.text??'')}
  if(['image','video','audio','file'].includes(String(item.type))){const attachment=item.attachment as Record<string,unknown>|undefined
   return{type:item.type,...(typeof item.url==='string'&&/^https?:\/\//i.test(item.url)?{url:item.url}:{}),...(typeof item.name==='string'?{name:item.name}:{}),...(attachment?.attachmentId?{attachment_id:String(attachment.attachmentId)}:{})}
  }
  return{type:item.type,...(item.message_id?{message_id:String(item.message_id)}:{}),...(item.forward_id?{forward_id:String(item.forward_id)}:{})}
 })
}
export class TopicThreads {
 constructor(readonly memory:MemoryStore){}
 canonical(id:string):string {
  let record=this.memory.get(id),seen=new Set<string>()
  if(record&&record.kind!=='topic')throw Error('Topic not found')
  while(record){if(seen.has(record.id))throw Error('Cyclic topic reference');seen.add(record.id)
   const next=String(record.data.topic_id??record.id);if(next===record.id||!this.memory.get(next))return next
   record=this.memory.get(next);if(record?.kind!=='topic')throw Error('Invalid topic reference')
  }
  if(!this.memory.topicVersions(id).length)throw Error('Topic not found');return id
 }
 eligible(record:MemoryRecord):boolean {
  if(record.kind==='assistant')return record.source.branch==='main'&&record.status==='complete'
  if(record.kind==='speak')return record.status==='sent'
  return record.kind==='input'&&record.status==='complete'&&record.data.visibility!=='internal'&&record.data.source_kind!=='internal'
 }
 attach(topicId:string,sourceIds:string[],assignedBy:string):void {
  const canonical=this.canonical(topicId)
  for(const sourceId of [...new Set(sourceIds)]){
   const source=this.memory.get(sourceId)
   if(!source||!this.eligible(source))continue
   this.memory.put({id:memoryId('topic-entry',this.memory.agentId,canonical,source.id),kind:'topic_entry',title:source.title,text:source.text,
    created_at:source.created_at,source:{...source.source},status:'complete',importance:source.importance,
    data:{topic_id:canonical,memory_id:source.id,entry_type:source.kind==='assistant'?'thought':source.kind==='speak'?'speech':'message',
      source_kind:source.kind,source_status:source.status,blocks:referenceBlocks(source.data.blocks),assigned_by:assignedBy}})
  }
 }
 /** Import old topic source links without modifying or deleting any original/version. */
 seed(topicId:string){const canonical=this.canonical(topicId)
  for(const version of this.memory.topicVersions(canonical)){
    if(version.data.thread_seeded===true)continue
    this.attach(canonical,version.data.source_ids as string[]??[],'legacy-topic-reference')
    this.memory.update(version.id,{data:{...version.data,thread_seeded:true}})
  }
 }
 recall(raw:z.input<typeof TopicRecall>){
  const input=TopicRecall.parse(raw),canonical=this.canonical(input.id),record=this.memory.get(input.id)?.kind==='topic'?this.memory.get(input.id)!:this.memory.topicVersions(canonical)[0]!
  this.seed(canonical)
  const params=[this.memory.agentId,canonical] as const
  const total=Number(this.memory.host.db.prepare("SELECT count(*) AS n FROM amphoreus_memory WHERE agent_id=? AND kind='topic_entry' AND data ->> '$.topic_id'=?").get(...params)!.n)
  const summary={id:record.id,topic_id:canonical,title:record.title,text:record.text.slice(0,4000),total_chars:record.text.length,status:record.status,source:record.source,
    total_entries:total,include_original:input.include_original,summary_truncated:record.text.length>4000}
  if(!input.include_original)return {...summary,originals:[],next_offset:null as number|null}
  const rows=this.memory.host.db.prepare("SELECT id FROM amphoreus_memory WHERE agent_id=? AND kind='topic_entry' AND data ->> '$.topic_id'=? ORDER BY created_at,rowid LIMIT ? OFFSET ?")
    .all(...params,input.limit,input.offset)
  const originals=rows.map(row=>{const entry=this.memory.get(String(row.id))!,text=entry.text.slice(input.text_offset,input.text_offset+input.size)
    return{id:entry.id,memory_id:entry.data.memory_id,type:entry.data.entry_type,at:entry.created_at,source:entry.source,text,blocks:(entry.data.blocks as Record<string,unknown>[]??[]).filter(block=>block.type!=='text'),
      total_chars:entry.text.length,text_offset:input.text_offset,next_text_offset:input.text_offset+input.size<entry.text.length?input.text_offset+input.size:null}})
  return {...summary,originals,next_offset:input.offset+rows.length<total?input.offset+rows.length:null}
 }
}
