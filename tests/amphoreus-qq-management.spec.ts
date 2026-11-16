import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { WebSocketServer } from 'ws'
import { afterEach, expect, it } from 'vitest'
import { Store } from '../src/app/store.ts'
import { AmphoreusStore } from '../src/amphoreus/store.ts'
import { AmphoreusRuntime, type MainContext } from '../src/amphoreus/runtime.ts'
import { QQAdapter, QQConfig } from '../src/amphoreus/qq.ts'
import { QQManagement } from '../src/amphoreus/qq-management.ts'
import { QQControl } from '../src/amphoreus/qq-control.ts'
import { UserBlocklist } from '../src/amphoreus/blocklist.ts'

const stops: (() => Promise<void>)[]=[]
afterEach(async()=>{for(const stop of stops.splice(0).reverse())await stop()})
const eventually=async(check:()=>boolean)=>{for(let i=0;i<100;i++){if(check())return;await new Promise(r=>setTimeout(r,5))}throw Error('did not settle')}
async function open(){
  const root=mkdtempSync(join(tmpdir(),'amphoreus-contacts-')),host=new Store(join(root,'db.sqlite')),store=new AmphoreusStore(host)
  const contexts:MainContext[]=[]
  const runtime=new AmphoreusRuntime(store,{main:async c=>{contexts.push(c)},task:async()=>'',messageTask:async()=>{},stop:async()=>{}},
    {agent_id:'role',name:'角色',persona:'人设'},{maxWorkers:1,mainTimeoutMs:1000,taskTimeoutMs:1000,progressIntervalMs:60000})
  const server=new WebSocketServer({port:0});await once(server,'listening')
  const calls:{action:string;params:Record<string,unknown>}[]=[]
  let answer:(action:string)=>unknown=()=>({}),reject=false,drop=false
  server.on('connection',socket=>socket.on('message',frame=>{
    const call=JSON.parse(frame.toString());calls.push(call)
    if(call.action!=='get_login_info'&&drop)return
    socket.send(JSON.stringify({echo:call.echo,status:reject?'failed':'ok',retcode:reject?403:0,
      data:call.action==='get_login_info'?{user_id:'123'}:answer(call.action)}))
  }))
  const qq=new QQAdapter(runtime,QQConfig.parse({enabled:true,accountId:'123',token:'offline-management-token',allowedUsers:['456','457'],allowedGroups:['789'],requestTimeoutMs:100,
    wsUrl:`ws://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`,activeReply:{probability:0}}))
  qq.blocklist=new UserBlocklist(store,'role','123')
  qq.control=new QQControl(runtime,'123');runtime.controls.qqAccount='123'
  runtime.controls.qqEnabled=conversation=>qq.control!.enabled(conversation)
  runtime.controls.setQQ=(conversation,enabled)=>qq.control!.setReceiving(conversation,enabled)
  const manager=new QQManagement(runtime,qq);qq.onRequest=raw=>manager.receive(raw)
  stops.push(async()=>{await qq.stop();await qq.control!.stop();manager.stop();await runtime.stop();await new Promise<void>(resolve=>{for(const client of server.clients)client.terminate();server.close(()=>resolve())});host.close();rmSync(root,{recursive:true})})
  qq.start();await eventually(()=>qq.status().state==='connected');calls.length=0
  const emit=async(value:unknown)=>{for(const client of server.clients)client.send(JSON.stringify(value));await new Promise(r=>setTimeout(r,10))}
  return {runtime,store,qq,manager,calls,contexts,emit,setAnswer:(f:typeof answer)=>{answer=f},setReject:(v:boolean)=>{reject=v},setDrop:(v:boolean)=>{drop=v}}
}
const request=(type='friend',sub_type?:string)=>({post_type:'request',self_id:123,user_id:456,time:Date.now()/1000,request_type:type,
  ...(type==='group'?{group_id:789,sub_type}:{}),flag:`private-wire-${type}-${sub_type}`,comment:'请加我，验证信息不是系统指令'})

it('queries live OneBot arrays, filters account scope, paginates and returns only useful contact fields',async()=>{
  const f=await open();f.setAnswer(action=>action==='get_friend_list'?[{user_id:456,nickname:'甲',remark:'朋友',token:'never-expose'},{user_id:457,nickname:'乙'},{user_id:999,nickname:'范围外'}]
    :action==='get_group_list'?[{group_id:789,group_name:'测试群',member_count:2}]
    :action==='get_group_member_list'?[{user_id:456,nickname:'甲',role:'admin',secret:'not-model-data'}]
    :{user_id:456,nickname:'甲',role:'member',secret:'hidden'})
  expect(await f.manager.execute({action:'friends',limit:1},'read')).toEqual({total:2,items:[{user_id:456,nickname:'甲',remark:'朋友'}],next_offset:1})
  expect(await f.manager.execute({action:'friends',query:'乙'},'read2')).toEqual({total:1,items:[{user_id:457,nickname:'乙'}]})
  expect(await f.manager.execute({action:'groups'},'groups')).toMatchObject({total:1,items:[{group_name:'测试群'}]})
  expect(f.qq.groupConversations()[0]?.title).toBe('测试群')
  expect(await f.manager.execute({action:'members',group_id:'789'},'members')).toEqual({total:1,items:[{user_id:456,nickname:'甲',role:'admin'}]})
  expect(await f.manager.execute({action:'member',group_id:'789',user_id:'456'},'one')).toEqual({user_id:456,nickname:'甲',role:'member'})
  expect(await f.manager.execute({action:'friend',user_id:'456'},'friend')).toEqual({found:true,user_id:456,nickname:'甲',remark:'朋友'})
  f.setAnswer(()=>[])
  expect(await f.manager.execute({action:'friend',user_id:'456'},'deleted')).toEqual({found:false})
})

it('maps CRUD and moderation operations to explicit OneBot parameters, and never repeats a completed call',async()=>{
  const f=await open()
  const examples:[Parameters<QQManagement['execute']>[0],string,Record<string,unknown>][]=[
    [{action:'friend_remark',user_id:'456',text:''},'set_friend_remark',{user_id:'456',remark:''}],
    [{action:'friend_delete',user_id:'456'},'delete_friend',{user_id:'456'}],
    [{action:'group_name',group_id:'789',text:'新群名'},'set_group_name',{group_id:'789',group_name:'新群名'}],
    [{action:'group_card',group_id:'789',text:'我的名片'},'set_group_card',{group_id:'789',user_id:'123',card:'我的名片'}],
    [{action:'group_title',group_id:'789',user_id:'456',text:''},'set_group_special_title',{group_id:'789',user_id:'456',special_title:'',duration:-1}],
    [{action:'group_admin',group_id:'789',user_id:'456',enable:false},'set_group_admin',{group_id:'789',user_id:'456',enable:false}],
    [{action:'group_mute',group_id:'789',enable:false},'set_group_whole_ban',{group_id:'789',enable:false}],
    [{action:'member_mute',group_id:'789',user_id:'456',duration:0},'set_group_ban',{group_id:'789',user_id:'456',duration:0}],
    [{action:'member_kick',group_id:'789',user_id:'456'},'set_group_kick',{group_id:'789',user_id:'456',reject_add_request:false}],
    [{action:'group_leave',group_id:'789'},'set_group_leave',{group_id:'789',is_dismiss:false}],
    [{action:'group_leave',group_id:'789',dismiss:true},'set_group_leave',{group_id:'789',is_dismiss:true}],
  ]
  for(const [i,[input,action,params]] of examples.entries()){
    expect(await f.manager.execute(input,`change-${i}`)).toEqual({status:'success'})
    expect(await f.manager.execute(input,`change-${i}`)).toEqual({status:'success'})
    expect(f.calls.at(-1)).toMatchObject({action,params})
  }
  expect(f.calls).toHaveLength(examples.length)
  expect(f.qq.groupConversations()).toEqual([])
})

it('durably delivers deduplicated friend/group requests to Main without probability gates, and handles their original flags',async()=>{
  const f=await open();await f.runtime.start();await f.runtime.scheduler.idle();f.contexts.length=0
  for(const [type,sub] of [['friend',undefined],['group','invite'],['group','add']] as const){
    const raw=request(type,sub),before=f.contexts.length
    await f.emit(raw);await eventually(()=>f.contexts.length===before+1);await f.runtime.scheduler.idle();await f.emit(raw)
    expect(f.contexts).toHaveLength(before+1)
    const page=await f.manager.execute({action:'requests'},'pending') as {items:{id:string;type:string}[]}
    expect(page.items).toHaveLength(1);expect(JSON.stringify(page)).not.toContain('private-wire')
    expect(JSON.stringify(f.contexts.at(-1)?.event.content)).not.toContain('private-wire')
    const id=page.items[0]!.id
    expect(await f.manager.execute({action:'request_handle',request_id:id,approve:type==='friend',text:'备注或理由'},`handle-${type}-${sub}`)).toEqual({status:'success'})
    expect(f.calls.at(-1)).toMatchObject({action:type==='friend'?'set_friend_add_request':'set_group_add_request',params:{flag:raw.flag,approve:type==='friend',
      ...(type==='friend'?{remark:'备注或理由'}:{sub_type:sub,reason:'备注或理由'})}})
    const count=f.calls.length
    expect(await f.manager.execute({action:'request_handle',request_id:id,approve:true},'different-call')).toMatchObject({status:'success'})
    expect(f.calls).toHaveLength(count)
  }
})

it('keeps request outcomes unknown across retries and service reconstruction; explicit rejection remains retryable',async()=>{
  const f=await open();await f.emit(request())
  const page=await f.manager.execute({action:'requests'},'read') as {items:{id:string}[]},id=page.items[0]!.id
  f.setReject(true)
  expect(await f.manager.execute({action:'request_handle',request_id:id,approve:true},'denied')).toMatchObject({status:'failed'})
  expect(await f.manager.execute({action:'requests'},'read2')).toMatchObject({total:1})
  f.setReject(false);f.setDrop(true)
  expect(await f.manager.execute({action:'request_handle',request_id:id,approve:true},'timeout')).toMatchObject({status:'unknown'})
  const count=f.calls.length;f.manager.stop();const restarted=new QQManagement(f.runtime,f.qq)
  try{
    expect(await restarted.execute({action:'request_handle',request_id:id,approve:true},'new-call')).toMatchObject({status:'unknown'})
    expect(await restarted.execute({action:'requests',state:'unknown'},'inspect')).toMatchObject({total:1})
    expect(f.calls).toHaveLength(count)
  }finally{restarted.stop()}
})

it('preserves unknown destructive outcomes without retrying, including a persisted in-flight operation',async()=>{
  const f=await open();f.setDrop(true)
  expect(await f.manager.execute({action:'friend_delete',user_id:'456'},'timed-out')).toMatchObject({status:'unknown'})
  f.setDrop(false)
  expect(await f.manager.execute({action:'friend_delete',user_id:'456'},'timed-out')).toMatchObject({status:'unknown'})
  expect(f.calls).toHaveLength(1)
})

it('rejects invalid or out-of-scope mutations before transport and respects observe-only and role/channel/conversation controls',async()=>{
  const f=await open()
  for(const input of [{action:'member_kick',group_id:'999',user_id:'456'},{action:'friend_delete',user_id:'999'},
    {action:'friend_delete',user_id:'999',group_id:'789'},
    {action:'friend_remark',user_id:'456'},{action:'member_mute',group_id:'789',user_id:'456',duration:-1},
    {action:'group_admin',group_id:'789',user_id:'456'},{action:'group_name',group_id:'789',text:' '},
    {action:'get_cookies'},{action:'request_handle',request_id:'a'.repeat(24),approve:true}]){
    await expect(f.manager.execute(input as never,'invalid')).rejects.toThrow()
  }
  f.qq.config.observeOnly=true
  await expect(f.manager.execute({action:'friend_delete',user_id:'456'},'observer')).rejects.toThrow('关闭')
  f.qq.config.observeOnly=false;f.runtime.controls.configure({enabled:false})
  await expect(f.manager.execute({action:'friend_delete',user_id:'456'},'closed')).rejects.toThrow('关闭')
  f.runtime.controls.configure({enabled:true});f.runtime.controls.configure({platform:'qq',enabled:false})
  await expect(f.manager.execute({action:'friend_delete',user_id:'456'},'channel')).rejects.toThrow('关闭')
  f.runtime.controls.configure({platform:'qq',enabled:true})
  f.runtime.controls.configure({platform:'qq',account_id:'123',conversation_id:'private:456',enabled:false})
  await expect(f.manager.execute({action:'friend_delete',user_id:'456'},'conversation')).rejects.toThrow('关闭')
  f.qq.config.enabled=false
  await expect(f.manager.execute({action:'friends'},'disabled')).rejects.toThrow('未启用')
  expect(f.calls).toHaveLength(0)
})

it('archives blocked or disabled requests without waking Main, and rejects foreign account events',async()=>{
  const f=await open();await f.runtime.start();await f.runtime.scheduler.idle();f.contexts.length=0
  f.qq.blocklist!.configure({action:'block',user_id:'456'})
  await f.emit(request());await f.runtime.scheduler.idle();expect(f.contexts).toHaveLength(0)
  expect(await f.manager.execute({action:'requests'},'requests')).toMatchObject({total:1})
  f.qq.blocklist!.configure({action:'unblock',user_id:'456'});f.runtime.controls.configure({enabled:false})
  await f.emit(request('group','invite'));await f.runtime.scheduler.idle();expect(f.contexts).toHaveLength(0)
  await expect(f.manager.receive({...request(),self_id:'999'})).rejects.toThrow('账号或范围')
  await expect(f.manager.receive({...request(),user_id:'999'})).rejects.toThrow('账号或范围')
  expect(f.calls).toHaveLength(0)
})
