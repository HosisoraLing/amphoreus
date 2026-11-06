import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach,expect,it} from 'vitest'
import {Store} from '../src/app/store.ts'
import {AmphoreusStore} from '../src/amphoreus/store.ts'
import {normalizeEvent} from '../src/amphoreus/model.ts'
import {SocialContext,resolveSocialContextPolicy,ROLE_COMPACT_INSTRUCTION} from '../src/amphoreus/role-context.ts'
import {MemoryStore,MemorySettings} from '../src/amphoreus/memory.ts'
const stops:(()=>void)[]=[]
afterEach(()=>{for(const stop of stops.splice(0))stop()})
function fixture(budget=1000){
 const dir=mkdtempSync(join(tmpdir(),'role-context-')),host=new Store(join(dir,'db.sqlite')),store=new AmphoreusStore(host)
 stops.push(()=>{host.close();rmSync(dir,{recursive:true,force:true})})
 const memory=new MemoryStore(host,'role',MemorySettings.parse({socialContext:{hybridBudgetTokens:budget}})),context=new SocialContext(store,memory,text=>Array.from(text).length)
 let n=0
 const event=(text:string,conversation='group:44',account='a')=>{
  const e=normalizeEvent({agent_id:'role',source_kind:'napcat',platform:'qq',account_id:account,conversation_id:conversation,actor_id:'sender',event_type:'message',correlation_id:null,content:[{type:'text',text}],metadata:{message_type:'group'},visibility:'public',timestamp:new Date(1700000000000+n*1000).toISOString(),idempotency_key:`event-${n++}`});store.insertEvent(e);return e
 }
 return{host,store,memory,context,event}
}
it('Heart carries neither channel history nor automatic people/memory summaries',()=>{
 const f=fixture();f.event('old secret');f.event('other channel','group:99');const wake=f.event('current')
 expect(f.context.prepare(wake,'heart')).toBe('')
 expect(resolveSocialContextPolicy('heart')).toMatchObject({injectRecentMessages:false,injectPeopleSummary:false,attachMissedSummary:false,autoRecallMemory:false})
 expect(ROLE_COMPACT_INSTRUCTION).not.toContain('最新10条将由程序提供')
 expect(f.memory.find()).toEqual([])
})
it('Hybrid fills only unseen gaps of the exact source and acknowledges only actual admission',()=>{
 const f=fixture(),old=f.event('missed'),hidden=f.event('private other','group:99'),other=f.event('other account','group:44','b'),seen=f.event('already delivered'),current=f.event('current body')
 f.store.setRecord('main-inbox-seen',seen.event_id,true)
 const text=f.context.prepare(current,'hybrid')
 expect(text).toContain('missed');for(const phrase of ['private other','other account','already delivered','current body'])expect(text).not.toContain(phrase)
 expect(f.store.record('social-context-seen',old.event_id)).toBeUndefined()
 expect(f.context.prepare(current,'hybrid')).toBe(text)
 f.context.admit(current)
 expect(f.store.record('social-context-seen',old.event_id)).toBeUndefined()
 f.context.presented(current)
 expect(f.store.record('social-context-seen',old.event_id)).toBe(true)
 expect(f.store.record('social-context-seen',hidden.event_id)).toBeUndefined();expect(f.store.record('social-context-seen',other.event_id)).toBeUndefined()
 const next=f.event('next');expect(f.context.prepare(next,'hybrid')).not.toContain('missed')
})
it('retains unshown gaps under budget and excludes the currently delivered debounce batch',()=>{
 const f=fixture(500),first=f.event('one '.repeat(40)),second=f.event('two '.repeat(40)),third=f.event('three '.repeat(40)),wake=f.event('wake')
 f.store.setRecord('main-inbox-plan',wake.event_id,[third.event_id,wake.event_id])
 const text=f.context.prepare(wake,'hybrid');expect(Array.from(text).length).toBeLessThanOrEqual(500);expect(text).not.toContain('three three')
 f.context.admit(wake);f.context.presented(wake)
 expect(f.store.record('social-context-seen',first.event_id)).toBe(true)
 expect(f.store.record('social-context-seen',second.event_id)).toBeUndefined()
 const next=f.event('next');expect(f.context.prepare(next,'hybrid')).toContain('two two')
})
it('Heart admissions and later steering survive restart and a switch back to Hybrid',()=>{
 const f=fixture(),heart=f.event('heart message');f.context.prepare(heart,'heart');f.context.admit(heart)
 const steered=f.event('steered');f.context.prepare(steered,'heart');f.context.admit(steered)
 const restored=new SocialContext(f.store,f.memory),wake=f.event('hybrid now')
 expect(restored.prepare(wake,'hybrid')).toBe('')
})
it('uses only existing source-linked TIDs and does not apply QQ policy to internal reports',()=>{
 const f=fixture(),wake=f.event('current');wake.metadata.topic_id='invented'
 expect(f.context.prepare(wake,'heart')).toBe('')
 f.memory.put({id:'topic-version',kind:'topic',title:'topic',text:'summary',created_at:f.memory.now(),source:{},status:'active',data:{topic_id:'tid'}})
 f.memory.put({id:'entry',kind:'topic_entry',title:'link',text:'current',created_at:f.memory.now(),source:{event_id:wake.event_id},data:{topic_id:'tid'}})
 f.store.deleteRecord('social-context-plan',wake.event_id)
 expect(f.context.prepare(wake,'heart')).toBe('TID:tid')
 const report={...wake,event_id:'report',platform:'internal',source_kind:'internal'}
 expect(f.context.prepare(report,'hybrid')).toBe('')
})
