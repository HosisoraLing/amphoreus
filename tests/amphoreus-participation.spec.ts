import { mkdtempSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach,expect,it,vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import { AmphoreusStore } from '../src/amphoreus/store.ts'
import { AmphoreusRuntime,type MainContext } from '../src/amphoreus/runtime.ts'
import { QQAdapter,QQConfig } from '../src/amphoreus/qq.ts'
import { GroupParticipation,ParticipationSettings,participationProbability } from '../src/amphoreus/participation.ts'
import { normalizeEvent,type GatewayEventInput } from '../src/amphoreus/model.ts'
import { QQControl } from '../src/amphoreus/qq-control.ts'

const cleanup:(()=>Promise<void>)[]=[]
afterEach(async()=>{for(const stop of cleanup.splice(0).reverse())await stop()})
async function open(main?:(context:MainContext)=>Promise<void>,seed?:(store:AmphoreusStore)=>void){
  const dir=mkdtempSync(join(tmpdir(),'amphoreus-presence-')),host=new Store(join(dir,'db.sqlite')),store=new AmphoreusStore(host)
  const contexts:MainContext[]=[],random=vi.fn(()=>0);let now=Date.now(),serial=0
  const runtime=new AmphoreusRuntime(store,{main:async context=>{contexts.push(context);await main?.(context)},task:async()=>'',messageTask:async()=>{},stop:async()=>{}},
    {agent_id:'role',name:'角色',persona:'Persona'},{maxWorkers:1,mainTimeoutMs:10000,taskTimeoutMs:10000,progressIntervalMs:60000})
  const config=QQConfig.parse({token:'test-token-1234567890',accountId:'123',allowedGroups:['*'],groupTrigger:'all',activeReply:{probability:.02}})
  const qq=new QQAdapter(runtime,config),rpc=vi.fn(async()=>({} as Record<string,unknown>))
  seed?.(store)
  let presence=new GroupParticipation(runtime,config,rpc,()=>now,random);qq.presence=presence
  presence.configure({enabled:true},'group:456')
  vi.spyOn(qq,'send').mockImplementation(async()=>({status:'sent',receipt:{message_id:`sent-${++serial}`,account_id:'123'}}))
  await runtime.start();await runtime.scheduler.idle();contexts.length=0
  cleanup.push(async()=>{await presence.stop();await qq.stop();await runtime.stop();host.close();rmSync(dir,{recursive:true,force:true})})
  const ingest=async(content=[{type:'text',data:{text:'普通聊天'}}] as {type:string;data:Record<string,unknown>}[],group='456')=>{
    const result=await runtime.gateway.ingest('napcat',{post_type:'message',message_type:'group',self_id:'123',user_id:'789',group_id:group,
      message_id:`incoming-${++serial}`,time:now/1000,message:content,sender:{nickname:'群友'}})
    await presence.tick();return result.event
  }
  const settle=async()=>{await runtime.scheduler.idle();await presence.tick()}
  return {store,runtime,qq,config,rpc,contexts,random,ingest,settle,now:()=>now,get presence(){return presence},advance:(ms:number)=>{now+=ms},
    restart:async()=>{await presence.stop();presence=new GroupParticipation(runtime,config,rpc,()=>now,random);qq.presence=presence;await presence.tick()}}
}

async function withDebounce(main?:(context:MainContext)=>Promise<void>){
 const f=await open(main),control=new QQControl(f.runtime,f.config.accountId,f.now)
 const adapter=f.qq as unknown as {normalize(raw:unknown):GatewayEventInput},normalize=adapter.normalize.bind(f.qq)
 vi.spyOn(adapter,'normalize').mockImplementation(raw=>({...normalize(raw),received_at:new Date(f.now()).toISOString()}))
 control.routeGroupsThroughParticipation=true;f.qq.control=control
 control.configure({patch:{debounceEnabled:true,waitMs:10000,maxWaitMs:30000}});await control.idle()
 cleanup.push(()=>control.stop())
 return {...f,get presence(){return f.presence},control,flush:async()=>{await control.tick();await f.presence.tick();await f.settle()}}
}

it('routes debounced groups through hybrid probability once and preserves canonical source order across restart',async()=>{
 const f=await withDebounce();f.presence.configure({mode:'hybrid',probability:0,windowMs:0});await f.presence.idle()
 const sources=[]
 for(let i=0;i<3;i++)sources.push(await f.ingest([{type:'image',data:{url:`https://media.test/${i}`}}]))
 f.advance(10001);await f.flush()
 expect(f.contexts).toHaveLength(0);expect(f.random).toHaveBeenCalledTimes(1)
 const merged=f.store.events({sourceKind:'qq-debounce'})[0]!.event
 expect(merged.metadata).toMatchObject({schedule:false,participation:true,source_event_ids:sources.map(e=>e.event_id)})
 expect(f.store.events({sourceKind:'napcat'})).toHaveLength(3)
 await f.restart();await f.flush();expect(f.random).toHaveBeenCalledTimes(1);expect(f.contexts).toHaveLength(0)
 f.presence.configure({probability:1});await f.presence.idle()
 const next=await f.ingest();f.advance(10001);await f.flush()
 expect(f.contexts).toHaveLength(1);expect(f.contexts[0]!.origin.event_id).toBe(next.event_id)
 expect(f.contexts[0]!.event.source_kind).toBe('qq-observation')
})

it('keeps debounce batching in heart mode, applies switching back to hybrid, and exempts genuine direct interactions',async()=>{
 const f=await withDebounce();f.presence.configure({mode:'heart',probability:0,windowMs:0});await f.presence.idle()
 for(let i=0;i<3;i++)await f.ingest()
 f.advance(10001);await f.flush();expect(f.contexts).toHaveLength(1);expect(f.random).not.toHaveBeenCalled()
 expect(f.contexts[0]!.event.metadata.source_event_ids).toHaveLength(3)
 f.presence.configure({mode:'hybrid'});await f.presence.idle()
 await f.ingest();f.advance(10001);await f.flush();expect(f.contexts).toHaveLength(1)
 const mention=await f.ingest([{type:'at',data:{qq:'123'}}]);await f.flush()
 expect(f.contexts).toHaveLength(2);expect(f.contexts[1]!.origin.event_id).toBe(mention.event_id)
 expect(f.contexts[1]!.event.metadata.participation_reason).toBe('direct-mention')
 f.rpc.mockResolvedValue({group_id:'456',sender:{user_id:'123'}})
 const reply=await f.ingest([{type:'reply',data:{id:'42'}}]);await f.ingest()
 f.advance(10001);await f.flush()
 expect(f.contexts).toHaveLength(3);expect(f.contexts[2]!.origin.event_id).toBe(reply.event_id)
 expect(f.contexts[2]!.event.metadata.participation_reason).toBe('direct-reply')
})

it('leaves private debounce on the direct Main path while group participation is installed',async()=>{
 const f=await withDebounce();f.presence.configure({mode:'hybrid',probability:0});f.config.allowedUsers=['*']
 await f.runtime.gateway.ingest('napcat',{post_type:'message',message_type:'private',self_id:'123',user_id:'789',message_id:'private-1',time:f.now()/1000,message:[{type:'text',data:{text:'私聊'}}],sender:{nickname:'群友'}})
 f.advance(10001);await f.flush()
 expect(f.contexts).toHaveLength(1);expect(f.contexts[0]!.event.source_kind).toBe('qq-debounce')
 expect(f.contexts[0]!.origin.conversation_id).toBe('private:789');expect(f.random).not.toHaveBeenCalled()
})

it('applies cooldown and fatigue after group debounce while a direct mention still bypasses ordinary suppression',async()=>{
 const f=await withDebounce(async context=>{if(context.event.platform==='qq')await context.speak([{type:'text',text:'回答'}],'speak')})
 f.presence.configure({mode:'hybrid',probability:1,windowMs:0});await f.presence.idle()
 await f.ingest();f.advance(10001);await f.flush();expect(f.contexts).toHaveLength(1)
 expect(f.presence.status().groups[0]!.cooldownUntil).toBeGreaterThan(f.now())
 await f.ingest();f.advance(10001);await f.flush();expect(f.contexts).toHaveLength(1)
 expect(f.presence.status().groups[0]!.logs.some(log=>log.reason==='cooldown')).toBe(true)
 f.advance(720000);f.store.setRecord('main-vitality','role',{used:800,capacity:1000,reserve:0})
 await f.ingest();f.advance(10001);await f.flush();expect(f.contexts).toHaveLength(1)
 expect(f.presence.status().groups[0]!.logs.some(log=>log.reason==='fatigue')).toBe(true)
 await f.ingest([{type:'at',data:{qq:'123'}}]);await f.flush();expect(f.contexts).toHaveLength(2)
})

it('preserves the existing base probability and caps the batch chance independently of group activity',()=>{
  const settings=ParticipationSettings.parse({})
  expect(participationProbability(.02,100,0,0,false,false,settings).factors.batch).toBeCloseTo(1-.98**5)
  expect(participationProbability(1,100,0,0,false,false,settings).probability).toBe(.25)
  expect(participationProbability(.02,1,.5,0,false,false,settings).probability).toBe(0)
  expect(participationProbability(.02,1,0,.8,false,false,settings).probability).toBe(0)
})

it('does not migrate or display groups from another QQ account or old simulated fixtures',async()=>{
  const f=await open(undefined,store=>store.insertEvent(normalizeEvent({agent_id:'role',source_kind:'napcat',platform:'qq',account_id:'999',conversation_id:'group:888',
    actor_id:'777',event_type:'message',timestamp:new Date().toISOString(),correlation_id:null,content:[{type:'image'}],metadata:{message_type:'group'},visibility:'public',idempotency_key:'foreign-account'})))
  expect(f.presence.settings('group:888').enabled).toBe(false)
  expect(f.presence.status().groups.some(group=>group.group==='group:888')).toBe(false)
})

it('archives 100 ordinary messages while forming at most five model observations; silence starts no cooldown',async()=>{
  const f=await open()
  expect(f.presence.settings().probability).toBe(.02)
  for(let i=0;i<100;i++)await f.ingest()
  await f.settle()
  expect(f.store.events({sourceKind:'napcat',limit:200})).toHaveLength(100)
  expect(f.contexts.length).toBeGreaterThan(0);expect(f.contexts.length).toBeLessThanOrEqual(5)
  expect(f.store.outputs()).toHaveLength(0)
  expect(f.presence.status().groups[0]?.cooldownUntil).toBe(0)
  expect(f.presence.status().groups[0]?.logs.some(log=>log.reason==='main-silent')).toBe(true)
})

it('treats a standalone image as a batch message and keeps its QQ origin on speak',async()=>{
  const f=await open(async context=>{if(context.event.platform==='qq')await context.speak([{type:'text',text:'看到了'}],'speak')})
  await f.ingest([{type:'image',data:{url:'https://media.test/image',file:'only-image.gif'}}])
  expect(f.contexts).toHaveLength(0)
  expect(f.presence.status().groups[0]?.pending).toHaveLength(1)
  f.advance(60000);await f.presence.tick();await f.settle()
  expect(f.contexts).toHaveLength(1)
  expect(f.contexts[0]?.origin.content[0]?.type).toBe('image')
  expect(f.contexts[0]?.origin.platform).toBe('qq')
  expect(f.store.outputs()[0]?.target.conversation_id).toBe('group:456')
  expect(f.store.outputs()[0]?.platform).toBe('qq')
  expect(f.presence.status().groups[0]!.cooldownUntil).toBeGreaterThan(0)
})

it('heart mode bypasses chance and cooldown for every modality, persists across restart, and leaves new groups disabled',async()=>{
  const f=await open();f.presence.configure({mode:'heart'})
  for(const type of ['image','record','video','file','forward'])await f.ingest([{type,data:{url:`https://media.test/${type}`,file:type,id:type}}])
  await f.settle()
  expect(f.contexts).toHaveLength(5);expect(f.random).not.toHaveBeenCalled()
  await f.restart();await f.settle();expect(f.contexts).toHaveLength(5);expect(f.presence.settings().mode).toBe('heart')
  await f.ingest(undefined,'999');await f.settle();expect(f.contexts).toHaveLength(5)
})

it('allows genuine mentions and replies during cooldown, but does not treat names or unrelated chatter as direct',async()=>{
  const f=await open(async context=>{if(context.event.platform==='qq')await context.speak([{type:'text',text:'回答'}],'speak')})
  f.presence.configure({windowMs:0})
  await f.ingest();await f.settle();const count=f.contexts.length
  await f.ingest([{type:'text',data:{text:'角色这个名字很好听'}}]);await f.settle();expect(f.contexts).toHaveLength(count)
  await f.ingest([{type:'at',data:{qq:'123'}}]);await f.settle();expect(f.contexts).toHaveLength(count+1)
  const output=f.store.outputs().find(o=>o.status==='sent')!,receipt=f.store.record<{message_id:string}>('receipt',output.output_id)!
  await f.ingest([{type:'reply',data:{id:receipt.message_id}},{type:'text',data:{text:'继续回答'}}]);await f.settle()
  expect(f.contexts).toHaveLength(count+2)
})

it('pauses ordinary wakes for sleep and fatigue, keeps the archive, and never gives unrelated topics an engagement bonus',async()=>{
  const f=await open();f.presence.configure({windowMs:0})
  f.store.setRecord('main-vitality','role',{used:800,capacity:1000,reserve:0})
  await f.ingest();await f.settle();expect(f.contexts).toHaveLength(0)
  f.store.setRecord('main-vitality','role',{used:0,capacity:1000,reserve:0,sleeping:true})
  await f.ingest();await f.settle();expect(f.contexts).toHaveLength(0)
  await f.ingest([{type:'at',data:{qq:'123'}}]);await f.settle();expect(f.contexts).toHaveLength(1)
  f.presence.engage('group:456','topic-a')
  expect(f.presence.status().groups[0]?.factors.engagement).toBe(1)
  expect(f.store.events({sourceKind:'napcat'})).toHaveLength(3)
})

it('does not reroll a declined batch after restart and preserves pending multimodal observations',async()=>{
  const f=await open();f.random.mockReturnValue(.99)
  await f.ingest([{type:'image',data:{url:'https://media.test/one'}}])
  await f.restart();expect(f.presence.status().groups[0]?.pending).toHaveLength(1)
  f.advance(60000);await f.presence.tick();await f.settle()
  expect(f.random).toHaveBeenCalledTimes(1);await f.restart();expect(f.random).toHaveBeenCalledTimes(1)
  expect(f.contexts).toHaveLength(0);expect(f.store.events({sourceKind:'napcat'})).toHaveLength(1)
})

it('bounds ordinary queues while Main is busy and lets direct interaction overtake them without a second Main',async()=>{
  let release!:()=>void,active=0,maximum=0
  const barrier=new Promise<void>(resolve=>{release=resolve})
  const f=await open(async context=>{active++;maximum=Math.max(active,maximum);try{if(context.event.platform==='web')await barrier}finally{active--}})
  await f.runtime.receiveWeb('owner','chat',[{type:'text',text:'忙碌中的任务'}],'busy')
  f.presence.configure({enabled:true},'group:999')
  for(let i=0;i<100;i++)await f.ingest()
  expect(f.store.events({sourceKind:'qq-observation'}).filter(row=>row.state==='queued')).toHaveLength(1)
  await f.ingest([{type:'at',data:{qq:'123'}}])
  for(let i=0;i<20;i++)await f.ingest(undefined,'999')
  release();await f.settle()
  expect(maximum).toBe(1)
  expect(f.contexts.filter(context=>context.event.platform==='qq')[0]?.event.metadata.direct).toBe(true)
  expect(f.store.events({sourceKind:'napcat',limit:200})).toHaveLength(121)
  expect(f.store.events({sourceKind:'qq-observation'}).length).toBeLessThanOrEqual(3)
})

it('uses actual successful output counts to pause at fifty percent, while genuine mentions remain available',async()=>{
  const f=await open(async context=>{if(context.event.platform==='qq')await context.speak([{type:'text',text:'回答'}],'speak')})
  f.presence.configure({windowMs:0})
  for(let i=0;i<10;i++){await f.ingest([{type:'at',data:{qq:'123'}}]);await f.settle()}
  expect(f.presence.status().groups[0]?.stats.share).toBe(.5)
  await f.ingest();await f.settle();expect(f.contexts).toHaveLength(10)
  await f.ingest([{type:'at',data:{qq:'123'}}]);await f.settle();expect(f.contexts).toHaveLength(11)
})

it('recovers a committed batch if the source cursor was not advanced, without rerolling or duplicating Main',async()=>{
  const f=await open();f.presence.configure({windowMs:0})
  const source=await f.ingest();await f.settle()
  const position=f.store.eventsAfter('role',0,100).find(row=>row.event.event_id===source.event_id)!.position
  f.store.setRecord('participation-cursor','role',position-1)
  await f.restart();await f.settle()
  expect(f.random).toHaveBeenCalledTimes(1);expect(f.contexts).toHaveLength(1)
})
