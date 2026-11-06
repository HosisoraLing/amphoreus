import { expect, it, vi } from 'vitest'

it('registers the native Main blacklist tool with the same validated service used by the UI',async()=>{
 const tools=new Map<string,any>(),configure=vi.fn(()=>({items:[]}))
 const driver=new DshAgentDriver({on:vi.fn()} as never,()=>({agent_id:'role',name:'fish',persona:'persona'}),'/unused',{main:null,worker:null},8)
 driver.blocklist={configure} as never
 const agent={id:'main',ctx:{tools:{register:(tool:any)=>{tools.set(tool.name,tool);return()=>{}}}}}
 ;(driver as any).blacklistTools(agent)
 const tool=tools.get('user_blacklist'),execution={signal:new AbortController().signal,callId:'block'}
 await tool.execute({action:'block',user_id:'456',reason:'spam'},execution)
 expect(configure).toHaveBeenCalledWith({action:'block',user_id:'456',reason:'spam'})
 expect(()=>tool.execute({action:'block'},execution)).toThrow()
 expect(tool.output.schema.type).toBe('object')
})

it('enforces the assigned topic at the native tool boundary before changing memory',async()=>{
  const tools=new Map<string,any>(),memory={get:vi.fn(),now:()=>new Date().toISOString()}
  const archive={memory,binding:()=>({session_id:'topic-agent',branch:'topic'})}
  const driver=new DshAgentDriver({on:vi.fn()} as never,()=>({agent_id:'role',name:'fish',persona:'persona'}),'/unused',{main:null,worker:null},8,archive as never)
  const agent={id:'topic-agent',ctx:{tools:{register:(tool:any)=>{tools.set(tool.name,tool);return()=>{}}}}}
  ;(driver as any).memoryTools(agent,'topic','assigned-topic')
  const execute=tools.get('memorize').execute,execution={signal:new AbortController().signal,callId:'reject'}
  expect(()=>execute({kind:'topic',topic_id:'other',title:'x',content:'x'},execution)).toThrow('assigned')
  expect(()=>execute({kind:'self_draft',title:'x',content:'x'},execution)).toThrow('assigned')
  expect(memory.get).not.toHaveBeenCalled()
  expect(tools.has('memory_confirm')).toBe(false)
  expect(tools.has('memory_decide')).toBe(false)
})
import { DshAgentDriver } from '../src/amphoreus/dsh.ts'

it('returns global memory and topic lists under the native object output contract', async () => {
  const registered = new Map<string, any>(), items = [{ id: 'memory', source: { branch: 'main' }, excerpt: '历史原文' }]
  const ctx = { on: vi.fn() }, memory = { summaries: vi.fn(() => items),find:vi.fn(()=>items.map(item=>({...item,text:item.excerpt,data:{topic_id:'canonical-topic'}}))),get:vi.fn(()=>undefined), now: () => '2026-11-03T13:00:00Z' }
  const archive = { memory, binding: () => ({ session_id: 'main', branch: 'main' }) }
  const agent = { id: 'main', ctx: { tools: { register: (tool: any) => { registered.set(tool.name, tool); return () => {} } } } }
  const driver = new DshAgentDriver(ctx as never, () => ({ agent_id: 'role', name: '角色', persona: '完整人设' }), '/unused', { main: null, worker: null }, 8, archive as never)
  ;(driver as any).memoryTools(agent, 'main')
  for (const name of ['memory_find','list_topics']) {
    const tool = registered.get(name), result = await tool.execute({}, { signal: new AbortController().signal, callId: name })
    expect(tool.output.schema.type).toBe('object')
    expect(result).toMatchObject({ items, next_offset: null })
    expect(JSON.parse(tool.output.render({}, result)[0].text).items[0].source.branch).toBe('main')
  }
  const first = await registered.get('memory_find').execute({ limit: 1 }, { signal: new AbortController().signal, callId: 'page' })
  expect(first).toMatchObject({ next_offset: 1, snapshot_at: memory.now() })
  await registered.get('memory_find').execute({ limit: 1, offset: 1, until: first.snapshot_at }, { signal: new AbortController().signal, callId: 'next' })
  expect(memory.summaries).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 1, until: memory.now() }))
})

it('gives nightly dispatch and draft review the current Beijing diary day without adding meme encouragement',async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-11-05T17:05:00Z'))
 try{
  const ctx={on:vi.fn(()=>()=>{})},driver=new DshAgentDriver(ctx as never,()=>({agent_id:'role',name:'fish',persona:'persona'}),'/unused',{main:null,worker:null},8)
  ;(driver as any).ensure=async()=>({id:'main',session:{}})
  const run=vi.fn(async(..._args:unknown[])=>{});(driver as any).run=run
  driver.memes={guidance:vi.fn(()=>'meme encouragement')} as never
  const base={event_id:'review',source_kind:'internal',platform:'internal',conversation_id:'memory-review',event_type:'memory.review',metadata:{},actor_id:'scheduler',account_id:'role',timestamp:new Date().toISOString(),content:[{type:'text',text:'review job'}]}
  for(const event_type of ['memory.review','task.completed']){
   const event={...base,event_type}
   await driver.main({sessionId:'main',event,origin:event,runId:'review'} as never,new AbortController().signal)
   const prompt=run.mock.calls.at(-1)![3] as string
   expect(prompt).toContain('今天是2026-11-06（北京时间）');expect(prompt).toContain('正式日记用今天日期');expect(prompt).not.toContain('meme encouragement')
  }
 }finally{vi.useRealTimers()}
})
