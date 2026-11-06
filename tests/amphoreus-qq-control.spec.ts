import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach,expect,it} from 'vitest'
import {Store} from '../src/app/store.ts'
import {AmphoreusStore} from '../src/amphoreus/store.ts'
import {AmphoreusRuntime} from '../src/amphoreus/runtime.ts'
import {QQControl} from '../src/amphoreus/qq-control.ts'
const cleanup:(()=>Promise<void>)[]=[]
afterEach(async()=>{for(const stop of cleanup.splice(0).reverse())await stop()})
function open(){
 const dir=mkdtempSync(join(tmpdir(),'qq-control-')),host=new Store(join(dir,'db.sqlite')),store=new AmphoreusStore(host)
 const runtime=new AmphoreusRuntime(store,{main:async()=>{},task:async()=>'',messageTask:async()=>{},stop:async()=>{}},{agent_id:'role',name:'fish',persona:'fish'},{maxWorkers:1,mainTimeoutMs:1000,taskTimeoutMs:1000,progressIntervalMs:60000})
 runtime.gateway.registerInput({kind:'napcat',platform:'qq',normalize:x=>x as never})
 let now=Date.now(),seq=0,control=new QQControl(runtime,'123',()=>now)
 cleanup.push(async()=>{await control.stop();await runtime.stop();host.close();rmSync(dir,{recursive:true,force:true})})
 const receive=async(conversation='group:44',mention=false,account='123')=>{
  const policy=control.settings(conversation)
  const result=await runtime.gateway.ingest('napcat',{agent_id:'role',source_kind:'napcat',platform:'qq',account_id:account,conversation_id:conversation,actor_id:'456',event_type:'message',timestamp:new Date(now).toISOString(),received_at:new Date(now).toISOString(),correlation_id:null,
   content:mention?[{type:'mention',actor_id:'123'}]:[{type:'text',text:'hello'}],metadata:{schedule:false,qq_debounce:policy.debounceEnabled,qq_receive_enabled:policy.receiveEnabled},visibility:'public',idempotency_key:String(++seq)})
  await control.tick();return result.event
 }
 const batches=()=>store.events({sourceKind:'qq-debounce',limit:100}).map(x=>x.event)
 return {runtime,store,get control(){return control},receive,batches,advance:(ms:number)=>{now+=ms},restart:async()=>{await control.stop();control=new QQControl(runtime,'123',()=>now)}}
}
it('filters a newly blocked member out of a durable debounce batch without losing other messages',async()=>{
 const f=open();f.control.configure({patch:{debounceEnabled:true}});await f.control.idle()
 const blocked=await f.receive(),allowed=await f.receive()
 f.control.canAdmit=event=>event.event_id!==blocked.event_id
 f.advance(4000);await f.control.tick()
 expect(f.batches()).toHaveLength(1)
 expect(f.batches()[0]!.metadata.source_event_ids).toEqual([allowed.event_id])
 expect(f.store.event(blocked.event_id)).toBeDefined()
})

it('defaults off, stores independent group/private overrides and resets to inherited defaults',async()=>{
 const f=open();expect(f.control.settings().debounceEnabled).toBe(false)
 f.control.configure({patch:{debounceEnabled:true,waitMs:1200}});await f.control.idle()
 f.control.configure({conversation_id:'private:44',patch:{receiveEnabled:false}});await f.control.idle()
 expect(f.control.settings('group:44').receiveEnabled).toBe(true)
 expect(f.control.settings('private:44')).toMatchObject({receiveEnabled:false,debounceEnabled:true,waitMs:1200})
 f.control.configure({conversation_id:'private:44',reset:true});await f.control.idle();expect(f.control.settings('private:44').receiveEnabled).toBe(true)
})
it('trailing-edge debounce survives restart, is account scoped, and self mention flushes every pending message once',async()=>{
 const f=open();f.control.configure({patch:{debounceEnabled:true,waitMs:2000,maxWaitMs:10000}});await f.control.idle()
 const a=await f.receive();f.advance(1000);const b=await f.receive();f.advance(1500);await f.control.tick();expect(f.batches()).toHaveLength(0)
 await f.restart();f.advance(600);await f.control.tick();expect(f.batches()).toHaveLength(1)
 expect(f.batches()[0]!.metadata.source_event_ids).toEqual([a.event_id,b.event_id])
 await f.control.tick();expect(f.batches()).toHaveLength(1)
 const c=await f.receive('private:44');const d=await f.receive('private:44',true)
 expect(f.batches()).toHaveLength(2);expect(f.batches()[0]!.metadata.source_event_ids).toEqual([c.event_id,d.event_id])
 await f.receive('group:55',false,'999');f.advance(10000);await f.control.tick();expect(f.batches()).toHaveLength(2)
})
it('receive switch defeats mentions, drops pending without deleting raw history, and never replays after reopening',async()=>{
 const f=open();f.control.configure({patch:{debounceEnabled:true}});await f.control.idle()
 await f.receive();f.control.configure({conversation_id:'group:44',patch:{receiveEnabled:false}});await f.control.idle()
 await f.receive('group:44',true);f.advance(60000);await f.control.tick();expect(f.batches()).toHaveLength(0)
 expect(f.store.events({sourceKind:'napcat'})).toHaveLength(2)
 f.control.configure({conversation_id:'group:44',patch:{receiveEnabled:true}});await f.control.idle();await f.control.tick();expect(f.batches()).toHaveLength(0)
})
it('maxWait bounds a continuous stream and safe retry does not duplicate a committed batch',async()=>{
 const f=open();f.control.configure({patch:{debounceEnabled:true,waitMs:5000,maxWaitMs:6000}});await f.control.idle()
 await f.receive();f.advance(4000);await f.receive();f.advance(2500);await f.control.tick();expect(f.batches()).toHaveLength(1)
 await f.restart();await f.control.tick();expect(f.batches()).toHaveLength(1)
})
