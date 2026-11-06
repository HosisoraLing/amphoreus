import { expect, it } from 'vitest'
import { projectFooter, nativeFooterReader } from '../src/amphoreus/usage.ts'
it('passes through only native numeric footer projections with no prompt or secret fields',()=>{
 const view=projectFooter({contextPressure:{projectedTokens:200,pressureTokens:180,contextWindow:1000,secret:'hidden'},tokenUsage:{uncachedInputTokens:40,outputTokens:20,cacheReadTokens:140,cacheWriteTokens:0},sessionStats:{decodeTokens:20,decodeMs:1000,turns:1,steps:2},request:{prompt:'never return'}},5)
 expect(view.contextPressure).toEqual({pressureTokens:180,projectedTokens:200,contextWindow:1000})
 expect(view.tokenUsage?.cacheReadTokens).toBe(140);expect(view.as_of_seq).toBe(5)
 expect(JSON.stringify(view)).not.toMatch(/hidden|prompt|request/)
 expect(projectFooter({contextPressure:{contextWindow:NaN},tokenUsage:{outputTokens:-1}}).available).toBe(false)
})
it('uses native observation projections and always releases the read lease',async()=>{
 let disposed=0,requested=''
 const read=nativeFooterReader({get:()=>({observeSession:async(id:string)=>{requested=id;return{projections:{asOfSeq:9,values:{contextPressure:{projectedTokens:321,contextWindow:1000},tokenUsage:{uncachedInputTokens:20,cacheReadTokens:80,cacheWriteTokens:0,outputTokens:7}}},[Symbol.dispose](){disposed++}}}})} as never)
 const result=await read('trusted-main')
 expect(requested).toBe('trusted-main');expect(disposed).toBe(1);expect(result.contextPressure?.projectedTokens).toBe(321)
 expect((await nativeFooterReader({get:()=>undefined} as never)('main')).available).toBe(false)
})
