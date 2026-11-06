/** Role-specific summary hook; native DSH owns locking, replay, balanced cuts and durable replacement. */
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { BlockAssembler, type ContentBlock, type Message } from '@deepseek-ai/dsh-llm'
import { ROLE_COMPACT_INSTRUCTION } from './role-context.ts'
/** Only the required summary hook is replaced, not the native transaction implementation. */
export default class RoleCompaction extends BasicCompactionEngine {
  protected override async summarize(input: {messages:readonly Message[];tools?:readonly import('@deepseek-ai/dsh-llm').ToolSchema[]}, agent:Agent, signal?:AbortSignal) {
    const route=agent.session.requestHeader()?.config
    const provider=this.config.summarizationProvider||route?.provider||agent.options.provider
    const model=this.config.summarizationModel||route?.model||agent.options.model
    if(!provider||!model)throw new Error('Role compaction requires a model route')
    const assembler=new BlockAssembler()
    const messages=[...input.messages,{role:'user' as const,content:[{type:'text' as const,text:ROLE_COMPACT_INSTRUCTION}]}]
    for await(const chunk of this.ctx.llm.stream({provider,model,messages,toolHistory:agent.session.toolHistory(),...(input.tools?{tools:[...input.tools]}:{}),
      maxTokens:this.config.maxTokens,sessionId:agent.session.id,purpose:'compaction',...(signal?{signal}:{})}))assembler.push(chunk)
    if(assembler.finish.kind==='error'||assembler.finish.kind==='aborted')throw new Error(assembler.finish.failure.message)
    if(assembler.finish.kind==='max-tokens')throw new Error('Role compaction summary truncated; original history retained')
    const rawOutput=assembler.blocks(),summary:ContentBlock[]=rawOutput.filter(block=>block.type==='text')
    if(!summary.some(block=>block.type==='text'&&block.text.trim()))throw new Error('Role compaction returned no facts; original history retained')
    if(summary.some(block=>block.type==='text'&&/data:(?:image|video)\/[^;]+;base64,/i.test(block.text)))throw new Error('Role summary must reference media, not embed it')
    return{summary,rawOutput,llmStreamCall:true as const,provider,model,maxTokens:this.config.maxTokens,...(assembler.usage?{usage:assembler.usage}:{})}
  }
}
