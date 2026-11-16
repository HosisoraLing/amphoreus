/** Role-owned QQ administration. NapCat only supplies transport and action receipts. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { AmphoreusRuntime } from './runtime.ts'
import { OneBotRejected, type QQAdapter } from './qq.ts'

const ID = z.string().regex(/^[1-9]\d{0,19}$/)
const WireID = z.union([ID, z.number().int().positive().safe()]).transform(String)
const Request = z.object({ post_type: z.literal('request'), self_id: WireID, user_id: WireID,
  time: z.number().finite().nonnegative(), request_type: z.enum(['friend','group']),
  group_id: WireID.optional(), sub_type: z.enum(['add','invite']).optional(),
  comment: z.string().max(4000).default(''), flag: z.string().min(1).max(4000),
}).refine(v => v.request_type === 'friend' || !!v.group_id && !!v.sub_type)

export const QQManagementInput = z.object({
  action: z.enum(['friends','friend','friend_remark','friend_delete','requests','request_handle',
    'groups','group','members','member','group_name','group_card','group_title','group_admin',
    'group_mute','member_mute','member_kick','group_leave']),
  user_id: ID.optional(), group_id: ID.optional(), request_id: z.string().regex(/^[a-f0-9]{24}$/).optional(),
  text: z.string().max(500).optional(), approve: z.boolean().optional(), enable: z.boolean().optional(),
  duration: z.number().int().min(0).max(2592000).optional(), dismiss: z.boolean().optional(),
  reject_add_request: z.boolean().optional(), query: z.string().max(100).default(''),
  offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(50).default(10),
  state: z.enum(['pending','handled','unknown','all']).default('pending'),
}).strict()
type Input = z.infer<typeof QQManagementInput>
type Pending = z.infer<typeof Request> & { id: string; role: string; state: 'pending'|'handling'|'handled'|'unknown'; approve?: boolean }
type Result = {status: 'success'|'failed'|'unknown'; message?: string}
const fields = (row: Record<string,unknown>, keys: string[]) => Object.fromEntries(keys.filter(k => row[k] !== undefined).map(k => [k,row[k]]))
const friendFields = ['user_id','nickname','remark']
const groupFields = ['group_id','group_name','member_count','max_member_count']
const memberFields = ['user_id','nickname','card','role','title','join_time','last_sent_time','shut_up_timestamp']
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0,24)

export class QQManagement {
  private off: () => void
  constructor(private readonly runtime: AmphoreusRuntime, private readonly qq: QQAdapter) {
    this.off = runtime.gateway.registerInput({kind:'napcat-request',platform:'qq',normalize: raw => {
      const request = this.parseRequest(raw), id = this.requestId(request)
      const group = request.request_type === 'group', conversation = `${group?'group':'private'}:${group?request.group_id:request.user_id}`
      return { agent_id: runtime.role.agent_id, source_kind:'napcat-request', platform:'qq', account_id:request.self_id,
        conversation_id:conversation, actor_id:request.user_id, event_type:`qq.request.${request.request_type}`, timestamp:new Date(request.time*1000).toISOString(),
        correlation_id:null, visibility:'private', idempotency_key:id,
        content:[{type:'text',text:`${group?request.sub_type==='invite'?'群邀请':'入群申请':'好友申请'} ${id}${group?` · 群${request.group_id}`:''}${request.comment?`\n附言：${request.comment.slice(0,500)}`:''}`}],
        metadata:{request_id:id,message_type:group?'group':'private',group_id:request.group_id,
          schedule:qq.config.receiveEnabled&&!qq.config.observeOnly&&qq.control?.enabled(conversation)!==false&&qq.blocklist?.blocked(request.user_id)!==true},
      }
    }})
  }
  stop(){this.off()}
  private requestId(request:z.infer<typeof Request>){return digest([this.runtime.role.agent_id,request.self_id,request.request_type,request.sub_type,request.group_id,request.user_id,request.flag])}
  private allowed(id:string,group=false){const list=group?this.qq.config.allowedGroups:this.qq.config.allowedUsers;return list.includes('*')||list.includes(id)}
  private parseRequest(raw:unknown){
    const value=Request.parse(raw)
    if(value.self_id!==this.qq.config.accountId||!this.allowed(value.group_id??value.user_id,value.request_type==='group'))throw Error('QQ申请账号或范围不匹配')
    return value
  }
  async receive(raw:unknown){
    if(this.qq.status().state!=='connected')return
    const value=this.parseRequest(raw),id=this.requestId(value)
    await this.runtime.gateway.ingest('napcat-request',raw,()=>{
      if(!this.runtime.store.record('qq-contact-request',id))this.runtime.store.setRecord('qq-contact-request',id,{...value,id,role:this.runtime.role.agent_id,state:'pending'})
    })
  }
  private page(rows:Record<string,unknown>[],input:Input){
    const query=input.query.toLocaleLowerCase(), filtered=query?rows.filter(row=>Object.values(row).some(v=>String(v).toLocaleLowerCase().includes(query))):rows
    return {total:filtered.length,items:filtered.slice(input.offset,input.offset+input.limit),
      ...(input.offset+input.limit<filtered.length?{next_offset:input.offset+input.limit}:{})}
  }
  async execute(raw:z.input<typeof QQManagementInput>,callId:string){
    const input=QQManagementInput.parse(raw),{store,role}=this.runtime,{config}=this.qq
    if(!config.enabled)throw Error('QQ未启用')
    const required=<K extends keyof Input>(key:K):NonNullable<Input[K]>=>{if(input[key]===undefined)throw Error(`需要${key}`);return input[key] as NonNullable<Input[K]>}
    let request:Pending|undefined,action='',params:Record<string,unknown>={}
    const groupParams=()=>({group_id:required('group_id')})
    const memberParams=()=>({...groupParams(),user_id:required('user_id')})
    switch(input.action){
      case 'requests':return this.page(store.records<Pending>('qq-contact-request')
        .filter(r=>r.role===role.agent_id&&r.self_id===config.accountId&&this.allowed(r.group_id??r.user_id,r.request_type==='group')&&(input.state==='all'||(input.state==='unknown'?['handling','unknown'].includes(r.state):r.state===input.state)))
        .reverse().map(r=>({id:r.id,type:r.request_type,...(r.sub_type?{sub_type:r.sub_type}:{}),user_id:r.user_id,...(r.group_id?{group_id:r.group_id}:{}),comment:r.comment.slice(0,240),state:r.state==='handling'?'unknown':r.state,...(r.approve!==undefined?{approve:r.approve}:{})})),input)
      case 'friends':action='get_friend_list';params={no_cache:true};break
      case 'friend':required('user_id');action='get_friend_list';params={no_cache:true};break
      case 'groups':action='get_group_list';params={no_cache:true};break
      case 'group':action='get_group_info';params={...groupParams(),no_cache:true};break
      case 'members':action='get_group_member_list';params=groupParams();break
      case 'member':action='get_group_member_info';params={...memberParams(),no_cache:true};break
      case 'friend_remark':action='set_friend_remark';params={user_id:required('user_id'),remark:required('text')};break
      case 'friend_delete':action='delete_friend';params={user_id:required('user_id')};break
      case 'group_name':action='set_group_name';params={...groupParams(),group_name:required('text')};if(!input.text!.trim())throw Error('群名不能为空');break
      case 'group_card':action='set_group_card';params={...groupParams(),user_id:input.user_id??config.accountId,card:required('text')};break
      case 'group_title':action='set_group_special_title';params={...memberParams(),special_title:required('text'),duration:-1};break
      case 'group_admin':action='set_group_admin';params={...memberParams(),enable:required('enable')};break
      case 'group_mute':action='set_group_whole_ban';params={...groupParams(),enable:required('enable')};break
      case 'member_mute':action='set_group_ban';params={...memberParams(),duration:required('duration')};break
      case 'member_kick':action='set_group_kick';params={...memberParams(),reject_add_request:input.reject_add_request??false};break
      case 'group_leave':action='set_group_leave';params={...groupParams(),is_dismiss:input.dismiss??false};break
      case 'request_handle':{
        const id=required('request_id');request=store.record<Pending>('qq-contact-request',id)
        if(!request||request.role!==role.agent_id||request.self_id!==config.accountId)throw Error('申请不存在')
        required('approve')
        if(request.state==='handled')return {status:'success',message:`申请已${request.approve?'同意':'拒绝'}，未重复操作`}
        if(request.state!=='pending')return {status:'unknown',message:'申请处理结果未知，请核查好友/群列表，勿重复提交'}
        action=request.request_type==='friend'?'set_friend_add_request':'set_group_add_request'
        params={flag:request.flag,approve:input.approve,...(request.request_type==='friend'?{remark:input.text??''}:{sub_type:request.sub_type,reason:input.text??''})};break
      }
    }
    const group=request?.request_type==='group'?request.group_id:typeof params.group_id==='string'?params.group_id:undefined
    const user=request?.user_id??(input.action==='friend'?input.user_id:typeof params.user_id==='string'?params.user_id:undefined)
    if(group?!this.allowed(group,true):user&&!this.allowed(user))throw Error('目标不在QQ配置允许范围内')
    const reading=action.startsWith('get_')
    if(reading){
      const data=await this.qq.request(action,params)
      if(input.action==='friend'){
        if(!Array.isArray(data))throw Error('QQ列表响应格式错误')
        const found=(data as Record<string,unknown>[]).find(row=>String(row.user_id)===user)
        return found?{found:true,...fields(found,friendFields)}:{found:false}
      }
      if(['friends','groups','members'].includes(input.action)){
        if(!Array.isArray(data))throw Error('QQ列表响应格式错误')
        const keys=input.action==='friends'?friendFields:input.action==='groups'?groupFields:memberFields
        const rows=(data as Record<string,unknown>[]).filter(row=>input.action==='members'||this.allowed(String(row[input.action==='friends'?'user_id':'group_id']),input.action==='groups'))
        if(input.action==='groups')this.qq.updateGroups(rows)
        return this.page(rows.map(row=>fields(row,keys)),input)
      }
      return fields(data,input.action==='group'?groupFields:memberFields)
    }
    const conversation=`${group?'group':'private'}:${group??user}`
    if(config.observeOnly||!this.runtime.controls.scopeEnabled({platform:'qq',account_id:config.accountId,conversation_id:conversation}))throw Error('QQ管理写操作已关闭')
    if(!group&&user===config.accountId)throw Error('不能对自己执行好友操作')
    const id=digest([role.agent_id,config.accountId,callId]),saved=store.record<Result>('qq-management-operation',id)
    if(saved)return saved
    // Persist uncertainty before external side effects: retries and restarts never repeat a destructive action.
    const unknown:Result={status:'unknown',message:'结果未知，请查询核实，勿重复执行'}
    store.atomic(()=>{store.setRecord('qq-management-operation',id,unknown);if(request)store.setRecord('qq-contact-request',request.id,{...request,state:'handling'})})
    let result:Result
    try{
      await this.qq.request(action,params);result={status:'success'}
      if(input.action==='group_leave')this.qq.removeGroup(group!)
      if(input.action==='group_name')this.qq.updateGroups([{group_id:group,group_name:input.text}])
    }catch(error){result=error instanceof OneBotRejected?{status:'failed',message:error.message}:unknown}
    store.atomic(()=>{
      store.setRecord('qq-management-operation',id,result)
      if(request)store.setRecord('qq-contact-request',request.id,{...request,state:result.status==='success'?'handled':result.status==='failed'?'pending':'unknown',...(result.status==='success'?{approve:input.approve}:{})})
    })
    store.onOperation?.('management',`qq:${input.action}:${id}`,result.status==='success'?'completed':result.status,result.message)
    this.runtime.onChange();return result
  }
}
