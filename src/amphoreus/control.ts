/** Persisted role/channel controls. Transport archives stay available while inference is disabled. */
import { z } from 'zod'
import type { AmphoreusStore } from './store.ts'
import type { GatewayEvent } from './model.ts'
import type { OutputTarget } from './gateway.ts'
export const ControlInput=z.object({enabled:z.boolean().optional(),platform:z.enum(['web','qq','bilibili']).optional(),account_id:z.string().min(1).max(100).optional(),conversation_id:z.string().min(1).max(300).optional(),reset:z.boolean().optional()}).strict().superRefine((value,ctx)=>{
 if(value.enabled===undefined&&!value.reset)ctx.addIssue({code:'custom',message:'需要开关值或恢复继承'})
 if(value.reset&&(!value.conversation_id||value.enabled!==undefined))ctx.addIssue({code:'custom',message:'恢复继承只能指定会话'})
 if(!!value.account_id!==!!value.conversation_id||value.conversation_id&&!value.platform)ctx.addIssue({code:'custom',message:'会话需要渠道和账号'})
 if(value.platform==='qq'&&value.conversation_id&&!/^(group|private):[1-9]\d{0,19}$/.test(value.conversation_id))ctx.addIssue({code:'custom',message:'需要准确群聊或私聊账号'})
 if(value.platform==='web'&&value.conversation_id&&!value.conversation_id.startsWith(`web:${value.account_id}:`))ctx.addIssue({code:'custom',message:'网页会话与账号不匹配'})
})
export class RoleControl {
 onChange:()=>void=()=>{}
 qqEnabled:(conversation:string)=>boolean=()=>true
 qqOverride:(conversation:string)=>boolean|undefined=()=>undefined
 setQQ:((conversation:string,enabled:boolean|undefined)=>void)|undefined
 qqAccount:string|undefined
 extraConversations:()=>{platform:string;account_id:string;conversation_id:string;title:string}[]=()=>[]
 constructor(private readonly store:AmphoreusStore,readonly role:string){}
 get enabled(){return this.store.record<{enabled:boolean}>('runtime-control',this.role)?.enabled??true}
 private key(target:OutputTarget){return JSON.stringify([this.role,target.platform,target.account_id,target.conversation_id])}
 channelEnabled(platform:string){return this.store.record<{enabled:boolean}>('channel-control',JSON.stringify([this.role,platform]))?.enabled??platform!=='bilibili'}
 override(target:OutputTarget):boolean|undefined{return target.platform==='qq'?this.qqOverride(target.conversation_id):this.store.record<{enabled:boolean}>('conversation-control',this.key(target))?.enabled}
 conversationEnabled(target:OutputTarget){return target.platform==='qq'?this.qqEnabled(target.conversation_id):this.override(target)??true}
 scopeEnabled(target:OutputTarget){return this.enabled&&(target.platform==='internal'||(target.platform!=='qq'||!this.qqAccount||target.account_id===this.qqAccount)&&this.channelEnabled(target.platform)&&this.conversationEnabled(target))}
 allows(event:GatewayEvent){return event.agent_id===this.role&&!event.metadata.control_suppressed&&!this.store.record('control-suppressed',event.event_id)&&this.scopeEnabled(event)}
 suppress(event:GatewayEvent){
  this.store.setRecord('control-suppressed',event.event_id,true)
  const ids=[event.event_id,...Array.isArray(event.metadata.source_event_ids)?event.metadata.source_event_ids:[]]
  for(const id of ids)if(typeof id==='string'){this.store.setRecord('control-suppressed',id,true);this.store.setRecord('main-inbox-seen',id,true)}
 }
 configure(input:z.infer<typeof ControlInput>){
  const value=ControlInput.parse(input)
  if(value.platform==='bilibili'&&value.enabled)throw Error('B站尚未接入，暂不能开启')
  if(value.platform==='qq'&&value.enabled&&!this.qqAccount)throw Error('QQ 尚未配置')
  if(value.conversation_id){
   const target={platform:value.platform!,account_id:value.account_id!,conversation_id:value.conversation_id}
   if(value.platform==='qq'){
    if(!this.setQQ||value.account_id!==this.qqAccount)throw Error('QQ 账号尚未配置或不匹配')
    this.setQQ(value.conversation_id,value.reset?undefined:value.enabled)
   }else if(value.reset)this.store.deleteRecord('conversation-control',this.key(target))
   else this.store.setRecord('conversation-control',this.key(target),{enabled:value.enabled})
   this.store.setRecord('control-target',this.key(target),{...target,agent_id:this.role,title:target.conversation_id})
  }else if(value.platform)this.store.setRecord('channel-control',JSON.stringify([this.role,value.platform]),{enabled:value.enabled})
  else this.store.setRecord('runtime-control',this.role,{enabled:value.enabled})
  this.onChange()
 }
 status(){
  const targets=[...this.store.records<OutputTarget&{agent_id:string;title:string}>('control-target').filter(row=>row.agent_id===this.role),...this.extraConversations(),...this.store.conversations().filter(row=>row.agent_id===this.role)]
  const known=[...new Map(targets.filter(row=>['web','qq','bilibili'].includes(row.platform)&&(row.platform!=='qq'||row.account_id===this.qqAccount)).map(row=>[this.key(row),row])).values()]
  return {enabled:this.enabled,channels:['web','qq','bilibili'].map(platform=>({platform,account_id:platform==='qq'?this.qqAccount:undefined,enabled:this.channelEnabled(platform),effective:this.enabled&&this.channelEnabled(platform)&&(platform==='web'||platform==='qq'&&!!this.qqAccount),available:platform==='web'||platform==='qq'&&!!this.qqAccount,conversations:known.filter(row=>row.platform===platform).map(row=>({platform,account_id:row.account_id,conversation_id:row.conversation_id,title:row.title,enabled:this.conversationEnabled(row),effective:this.scopeEnabled(row),override:this.override(row)??null}))}))}
 }
}
export class ControlStopped extends Error {constructor(){super('角色或此消息渠道已关闭；当前运行已停止，记录保留。')}}
