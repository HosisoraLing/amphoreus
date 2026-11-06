import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach,expect,it} from 'vitest'
import {Store} from '../src/app/store.ts'
import {AmphoreusStore} from '../src/amphoreus/store.ts'
import {normalizeEvent} from '../src/amphoreus/model.ts'
import {recentChannelContext,ROLE_COMPACT_INSTRUCTION} from '../src/amphoreus/role-context.ts'
const stops:(()=>void)[]=[]
afterEach(()=>{for(const stop of stops.splice(0))stop()})
it('wakes with ten messages per full source tuple, not a global tail, and only media references',()=>{
 const dir=mkdtempSync(join(tmpdir(),'role-context-')),host=new Store(join(dir,'db.sqlite')),store=new AmphoreusStore(host)
 stops.push(()=>{host.close();rmSync(dir,{recursive:true,force:true})})
 const now=Date.now(),base={agent_id:'role',source_kind:'napcat',platform:'qq',actor_id:'sender',event_type:'message',correlation_id:null,visibility:'public' as const}
 for(const account_id of ['a','b'])for(let i=0;i<12;i++){
  const e=normalizeEvent({...base,account_id,conversation_id:'group:44',content:[{type:'text',text:`${account_id}-message-${i}-end`},{type:'image',url:'https://media.test/image.gif'}],metadata:{},timestamp:new Date(now+i*1000).toISOString(),received_at:new Date(now+i*1000).toISOString(),idempotency_key:`${account_id}-${i}`});store.insertEvent(e)
 }
 const hidden=normalizeEvent({...base,account_id:'a',conversation_id:'group:55',content:[{type:'text',text:'disabled-secret'}],metadata:{qq_receive_enabled:false},timestamp:new Date(now).toISOString(),received_at:new Date(now).toISOString(),idempotency_key:'hidden'});store.insertEvent(hidden)
 const wake=normalizeEvent({...base,account_id:'a',conversation_id:'group:44',content:[],metadata:{},timestamp:new Date(now+20000).toISOString(),received_at:new Date(now+20000).toISOString(),idempotency_key:'wake'})
 const context=recentChannelContext(store,wake)
 expect(context).not.toContain('a-message-0-end');expect(context).not.toContain('b-message-1-end')
 expect(context).toContain('a-message-2-end');expect(context).toContain('b-message-11-end')
 expect(context).not.toContain('disabled-secret');expect(context).toContain('https://media.test/image.gif')
 expect(context).not.toMatch(/base64|frame-/);expect(context).toContain('read_topic')
 expect(ROLE_COMPACT_INSTRUCTION).toContain('想法、提议、推理、发言、已完成行动必须区分')
})
