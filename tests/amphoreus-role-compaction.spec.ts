import {afterEach,expect,it,vi} from 'vitest'
import {Context} from '@deepseek-ai/cordis'
import {Session,SessionId} from '@deepseek-ai/dsh-session'
import type {Agent} from '@deepseek-ai/dsh-agent'
import {BasicCompactionEngine} from '@deepseek-ai/dsh-compaction-basic'
import RoleCompaction from '../src/amphoreus/role-compaction.ts'
import {ROLE_COMPACT_INSTRUCTION} from '../src/amphoreus/role-context.ts'

const roots:Context[]=[]
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>root.fiber.dispose()))})
it.each([
 {window:1000000,reserve:8192},
 {window:128000,reserve:8192},
 {window:1000000,reserve:200000},
])('inherits native pressure and retention defaults for $window/$reserve',async policy=>{
 const root=new Context();roots.push(root)
 const session=Session.create(SessionId('window-pressure'))
 session.append('request/header',{header:{config:{provider:'test',model:'model',maxTokens:policy.reserve}},reason:'initial'})
 for(let i=0;i<20;i++)session.append('user/message',{role:'user',id:`history-${i}`,source:{kind:'human'},content:[{type:'text',text:`message ${i}`}]} as never,{surfaceOp:'append'})
 let pressure=0
 root.provide('llm',{resolveModelInfo:async()=>({context:{contextWindow:policy.window},defaultMaxTokens:policy.reserve})})
 root.provide('sessions',{flush:vi.fn()})
 root.provide('tokenMeter',{measure:()=>({totalTokens:pressure,nodes:session.surface.nodes.map(seq=>({seq,tokens:pressure/20}))})})
 const isolated=root.isolate('compaction')
 await isolated.plugin(RoleCompaction,{maxTokens:4096})
 const engine=isolated.get('compaction') as RoleCompaction
 expect(engine).toBeDefined();expect(root.get('compaction')).toBeUndefined()
 const baselineScope=root.isolate('compaction')
 await baselineScope.plugin(BasicCompactionEngine,{maxTokens:4096})
 const baseline=baselineScope.get('compaction') as BasicCompactionEngine
 expect(engine.config).toEqual(baseline.config)
 const threshold=Math.floor(Math.min(policy.window*baseline.config.thresholdRatio,policy.window-policy.reserve-baseline.config.headroomTokens))
 pressure=threshold-1
 let kept=0
 const compact=vi.spyOn(engine,'compactRegion').mockImplementation(async(_start,end)=>{
  const nodes=session.surface.nodes,keepAt=nodes.indexOf(end)+1
  kept=(nodes.length-keepAt)*pressure/20
  pressure=Math.floor(threshold*.5)
  return {} as never
 })
 const agent={session,options:{}} as Agent,signal=new AbortController().signal
 expect(await engine.compactIfNeeded(agent,'pressure',signal)).toBeNull()
 expect(compact).not.toHaveBeenCalled()
 pressure=threshold
 await engine.compactIfNeeded(agent,'pressure',signal)
 expect(compact).toHaveBeenCalledOnce()
 expect(kept).toBeGreaterThanOrEqual(Math.floor((policy.window-policy.reserve)*baseline.config.retainRatio!))
})
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
