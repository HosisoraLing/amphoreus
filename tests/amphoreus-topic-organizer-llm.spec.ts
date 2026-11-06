import {expect,it,vi} from 'vitest'
import {organizerClassifier} from '../src/amphoreus/topic-organizer-llm.ts'
import type {OrganizerInput} from '../src/amphoreus/topic-organizer.ts'
const input:OrganizerInput={job_id:'job',topics:[],records:[{id:'a',type:'thought',text:'a thought',at:'2026-11-04T00:00:00Z',source:{branch:'main'}}]}
it('calls an isolated model once, with no tools or Main history, and parses only bounded text output',async()=>{
 const block={type:'text' as const,text:'```json\n{"groups":[{"new_key":"a","title":"t","summary":"s","source_ids":["a"]}]}\n```'}
 const stream=vi.fn(async function*(_options:unknown){yield{type:'block-start',blockType:'text',index:0};yield{type:'block-end',index:0,block};yield{type:'finish',finish:{kind:'stop'}}})
 const classify=organizerClassifier({llm:{stream}} as never,()=>({provider:'mock',model:'mock'}))
 expect(await classify(input,new AbortController().signal)).toMatchObject({groups:[{new_key:'a',source_ids:['a']}]})
 const call=stream.mock.calls[0]![0] as any
 expect(call.maxTokens).toBe(4096);expect(call.tools).toBeUndefined();expect(call.messages).toHaveLength(2)
 expect(call.messages[0].role).toBe('system');expect(JSON.stringify(call.messages[1])).toContain('a thought')
})
it('does not silently use a global model route and rejects cancelled work before publication',async()=>{
 const stream=vi.fn(async function*(){yield{type:'finish',finish:{kind:'stop'}}})
 await expect(organizerClassifier({llm:{stream}} as never,()=>null)(input,new AbortController().signal)).rejects.toThrow('Configure')
 expect(stream).not.toHaveBeenCalled()
 const controller=new AbortController();controller.abort(Error('cancelled'))
 await expect(organizerClassifier({llm:{stream}} as never,()=>({provider:'mock',model:'mock'}))(input,controller.signal)).rejects.toThrow('cancelled')
})
