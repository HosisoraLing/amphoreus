import {expect,it} from 'vitest'
import RoleCompaction from '../src/amphoreus/role-compaction.ts'
import {ROLE_COMPACT_INSTRUCTION} from '../src/amphoreus/role-context.ts'
// Exercise the summary hook without mounting an engine or mutating real history.
const summarize=RoleCompaction.prototype as unknown as {summarize(input:unknown,agent:unknown,signal?:AbortSignal):Promise<any>}
it('changes only the compaction instruction, preserves prefix/tools and rejects incomplete summaries',async()=>{
 let seen:any
 const host={config:{summarizationProvider:'',summarizationModel:'',maxTokens:4096},ctx:{llm:{async *stream(options:unknown){seen=options;yield{type:'block-start',index:0,blockType:'text'};yield{type:'text-delta',index:0,text:'事实：用户请我记住海边旅行。来源 event-1。'};yield{type:'block-end',index:0,block:{type:'text',text:'事实：用户请我记住海边旅行。来源 event-1。'}};yield{type:'finish',reason:{kind:'stop'}}}}}}
 const messages=[{role:'user',id:'event-1',source:{kind:'human'},content:[{type:'text',text:'remember'}]}],tools=[{name:'read_topic',description:'read',parameters:{type:'object'}}]
 const agent={session:{id:'role-main',requestHeader:()=>({config:{provider:'p',model:'m'}}),toolHistory:()=>({})},options:{}}
 const result=await summarize.summarize.call(host,{messages,tools},agent)
 expect(seen.messages.slice(0,-1)).toEqual(messages);expect(seen.messages.at(-1).content[0].text).toBe(ROLE_COMPACT_INSTRUCTION)
 expect(seen.tools).toEqual(tools);expect(seen.purpose).toBe('compaction');expect(result.llmStreamCall).toBe(true)
 host.ctx.llm.stream=async function*(options:unknown){seen=options;yield{type:'finish',reason:{kind:'max-tokens'}} as never}
 await expect(summarize.summarize.call(host,{messages,tools},agent)).rejects.toThrow('truncated')
})
