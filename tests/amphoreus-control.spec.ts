import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach,expect,it} from 'vitest'
import {Store} from '../src/app/store.ts'
import {AmphoreusStore} from '../src/amphoreus/store.ts'
import {AmphoreusRuntime,type MainContext,type AgentDriver} from '../src/amphoreus/runtime.ts'
import {QQControl} from '../src/amphoreus/qq-control.ts'
import {RoleControl,ControlInput} from '../src/amphoreus/control.ts'
const stops:(()=>Promise<void>)[]=[]
afterEach(async()=>{for(const stop of stops.splice(0).reverse())await stop()})
const wait=async(condition:()=>boolean)=>{for(let i=0;i<100;i++){if(condition())return;await new Promise(r=>setTimeout(r,5))}throw Error('condition not reached')}
function open(main:AgentDriver['main']=async()=>{},task:AgentDriver['task']=async()=> ''){
 const dir=mkdtempSync(join(tmpdir(),'role-control-')),host=new Store(join(dir,'state.sqlite')),store=new AmphoreusStore(host)
 const runtime=new AmphoreusRuntime(store,{main,task,messageTask:async()=>{},stop:async()=>{}},{agent_id:'role',name:'角色',persona:'persona'},{maxWorkers:2,mainTimeoutMs:10000,taskTimeoutMs:10000,progressIntervalMs:60000})
 stops.push(async()=>{await runtime.stop();host.close();rmSync(dir,{recursive:true,force:true})})
 return{runtime,store}
}
it('persists master/channel/conversation hierarchy, reuses QQ overrides and rejects mismatched account scope',()=>{
 const {runtime,store}=open(),control=runtime.controls,qq=new QQControl(runtime,'12345')
 stops.push(()=>qq.stop());control.qqAccount='12345';control.qqEnabled=id=>qq.settings(id).receiveEnabled;control.qqOverride=id=>qq.override(id)
 control.setQQ=(id,value)=>qq.setReceiving(id,value)
 const target={platform:'qq' as const,account_id:'12345',conversation_id:'group:77777'}
 control.configure({...target,enabled:false});expect(qq.enabled(target.conversation_id)).toBe(false)
 control.configure({...target,enabled:true});control.configure({platform:'qq',enabled:false});expect(control.scopeEnabled(target)).toBe(false)
 control.configure({enabled:false});control.configure({platform:'qq',enabled:true});expect(control.scopeEnabled(target)).toBe(false)
 control.configure({enabled:true});expect(control.scopeEnabled(target)).toBe(true)
 qq.configure({conversation_id:target.conversation_id,patch:{debounceEnabled:true,waitMs:1500}})
 control.configure({...target,reset:true});expect(qq.override(target.conversation_id)).toBeUndefined();expect(qq.settings(target.conversation_id)).toMatchObject({debounceEnabled:true,waitMs:1500})
 expect(()=>control.configure({...target,account_id:'another',enabled:false})).toThrow('不匹配')
 expect(()=>ControlInput.parse({platform:'web',account_id:'alice',conversation_id:'web:bob:chat',enabled:false})).toThrow()
 control.configure({enabled:false});expect(new RoleControl(store,'role').enabled).toBe(false)
 expect(new RoleControl(store,'other-role').enabled).toBe(true)
})
it('archives while disabled without Main or output, and reenabling accepts only new messages',async()=>{
 const seen:string[]=[],{runtime,store}=open(async ctx=>{if(ctx.event.platform==='web')seen.push(String(ctx.event.content[0]?.text))})
 runtime.controls.configure({enabled:false});await runtime.start();await runtime.scheduler.idle()
 const old=await runtime.receiveWeb('owner','chat',[{type:'text',text:'关闭期间'}],'off')
 expect(store.event(old.event.event_id)?.event.metadata.control_suppressed).toBe(true);expect(seen).toEqual([])
 await expect(runtime.gateway.speak({agentId:'role',runId:'test',callId:'closed',target:{platform:'web',account_id:'owner',conversation_id:'web:owner:chat'},content:[{type:'text',text:'不应发送'}]},()=>true)).rejects.toThrow('关闭')
 expect(store.outputs()).toEqual([])
 runtime.controls.configure({enabled:true});await runtime.scheduler.idle();expect(seen).toEqual([])
 await runtime.receiveWeb('owner','chat',[{type:'text',text:'新消息'}],'on');await runtime.scheduler.idle();expect(seen).toEqual(['新消息'])
 expect(runtime.controls.allows(old.event)).toBe(false)
})
it('cancels an active Main gracefully, holds queues and safely resumes persistent branches but never reruns a tool worker',async()=>{
 let started=false,reportsToMain=0;const activations:{kind:string;id:string}[]=[]
 const {runtime,store}=open(async(ctx,signal)=>{
  if(ctx.event.event_type==='task.completed')reportsToMain++
  if(ctx.event.content[0]?.text!=='start')return
  ctx.delegate('构思',[],0,'fork',{kind:'continuation'});ctx.delegate('执行',[],0,'worker',{kind:'worker'});started=true
  await new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}))
 },async(task,report,signal)=>{
  activations.push({kind:task.kind??'worker',id:task.subagent_id})
  if(task.activation){await report({type:'completed',summary:'同一分支完成'},'done');return ''}
  await new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}));return ''
 })
 await runtime.start();await runtime.scheduler.idle();const request=await runtime.receiveWeb('owner','chat',[{type:'text',text:'start'}],'start')
 await wait(()=>started&&activations.length===2)
 runtime.controls.configure({enabled:false});await runtime.scheduler.idle();await wait(()=>runtime.status().running_subagents===0)
 expect(store.runs().find(run=>run.event_id===request.event.event_id)?.state).toBe('interrupted')
 expect(store.tasks().find(t=>t.kind==='continuation')?.state).toBe('paused');expect(store.tasks().find(t=>t.kind==='worker')?.state).toBe('cancelled')
 runtime.controls.configure({enabled:true});await wait(()=>activations.length===3&&runtime.status().running_subagents===0)
 expect(activations.filter(t=>t.kind==='worker')).toHaveLength(1)
 expect(new Set(activations.filter(t=>t.kind==='continuation').map(t=>t.id)).size).toBe(1)
 await runtime.scheduler.idle();expect(reportsToMain).toBe(1)
})
it('isolates conversation and channel switches and blocks pre-existing queued input instead of replaying it',async()=>{
 const contexts:MainContext[]=[],{runtime,store}=open(async ctx=>{contexts.push(ctx)})
 const old=await runtime.receiveWeb('alice','chat',[{type:'text',text:'queued'}],'queued')
 runtime.controls.configure({platform:'web',account_id:'alice',conversation_id:'web:alice:chat',enabled:false})
 expect(store.event(old.event.event_id)?.state).toBe('processed')
 await runtime.start();await runtime.scheduler.idle();contexts.length=0
 await runtime.receiveWeb('alice','chat',[{type:'text',text:'off'}],'off');await runtime.receiveWeb('bob','chat',[{type:'text',text:'on'}],'on');await runtime.scheduler.idle()
 expect(contexts.map(c=>c.origin.account_id)).toEqual(['bob'])
 runtime.controls.configure({platform:'web',enabled:false});await runtime.receiveWeb('bob','chat',[{type:'text',text:'channel off'}],'off2');await runtime.scheduler.idle();expect(contexts).toHaveLength(1)
 runtime.controls.configure({platform:'web',enabled:true});await runtime.scheduler.idle();expect(contexts).toHaveLength(1)
})
