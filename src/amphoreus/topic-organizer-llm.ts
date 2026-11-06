/** Isolated background Agent inference: no Main wake, tools, external sends or shared conversation context. */
import type { Context } from '@deepseek-ai/cordis'
import { BlockAssembler,createSystemMessage,type TokenUsage } from '@deepseek-ai/dsh-llm'
import type { RoleModel } from '../policy.ts'
import { ORGANIZER_PROMPT,type OrganizerClassify } from './topic-organizer.ts'
export function organizerClassifier(ctx:Context,route:()=>RoleModel|null,settled?:(provider:string,model:string,usage:TokenUsage|undefined,duration:number,ok:boolean)=>void):OrganizerClassify {
 return async(input,signal)=>{
  signal.throwIfAborted()
  const selected=route();if(!selected)throw Error('Configure an organizer/main model before enabling topic organization')
  const assembler=new BlockAssembler()
  const started=Date.now();let ok=false
  try{
  for await(const chunk of ctx.llm.stream({provider:selected.provider,model:selected.model,maxTokens:4096,signal,
    messages:[createSystemMessage(ORGANIZER_PROMPT),{role:'user',content:[{type:'text',text:JSON.stringify(input)}]}]}))assembler.push(chunk)
  signal.throwIfAborted()
  if(assembler.finish.kind==='error'||assembler.finish.kind==='aborted')throw Error('Topic organizer model request failed')
  if(assembler.finish.kind==='max-tokens')throw Error('Topic organizer response truncated')
  const output=assembler.blocks().filter(b=>b.type==='text').map(b=>b.text).join('')
  const result=JSON.parse(output.replace(/^\s*```(?:json)?\s*/,'').replace(/\s*```\s*$/,''));ok=true;return result
  }finally{settled?.(selected.provider,selected.model,assembler.usage,Date.now()-started,ok)}
 }
}
