/** Role-owned, account-scoped QQ user blocks. Raw messages are retained; blocked admissions never replay. */
import { z } from 'zod'
import type { AmphoreusStore } from './store.ts'
import type { GatewayEvent } from './model.ts'
export const BlocklistInput=z.object({action:z.enum(['list','block','unblock']).default('list'),
  user_id:z.string().regex(/^[1-9]\d{0,19}$/).optional(),reason:z.string().max(500).optional()}).strict().refine(v=>v.action==='list'||!!v.user_id,{message:'user_id is required',path:['user_id']})
interface Entry {platform:'qq';account_id:string;user_id:string;reason:string;blocked_at:string}
export class UserBlocklist {
  onChange:()=>void=()=>{}
  constructor(private readonly store:AmphoreusStore,private readonly agentId:string,readonly accountId:string){}
  private key(user:string){return JSON.stringify([this.agentId,'qq',this.accountId,user])}
  blocked(user:string){return !!this.store.record<Entry>('user-blocklist',this.key(user))}
  list(){return this.store.records<Entry & {agent_id:string}>('user-blocklist').filter(e=>e.agent_id===this.agentId&&e.account_id===this.accountId).map(({agent_id:_agent,...e})=>e)}
  /** A durable per-message decision prevents delayed replay after unblocking. */
  suppress(event:GatewayEvent){this.store.setRecord('user-blocked-message',event.event_id,true);this.store.setRecord('main-inbox-seen',event.event_id,true)}
  allowed(event:GatewayEvent):boolean {
    if(event.agent_id!==this.agentId||event.platform!=='qq'||event.account_id!==this.accountId)return true
    if(event.metadata.user_blocked===true||this.store.record('user-blocked-message',event.event_id))return false
    if(event.source_kind==='qq-observation'||event.source_kind==='qq-debounce'){
      const ids=event.metadata.source_event_ids
      return Array.isArray(ids)&&ids.some(id=>{const source=typeof id==='string'?this.store.event(id)?.event:undefined;return !!source&&source.source_kind==='napcat'&&source.agent_id===this.agentId&&source.account_id===this.accountId&&source.conversation_id===event.conversation_id&&this.allowed(source)})
    }
    return event.source_kind==='output-gateway'||!this.blocked(event.actor_id)
  }
  configure(raw:z.input<typeof BlocklistInput>){
    const input=BlocklistInput.parse(raw)
    if(input.action!=='list'){
      if(!input.user_id)throw Error('user_id is required')
      if(input.user_id===this.accountId)throw Error('Cannot block the bot account itself')
      this.store.atomic(()=>{
        if(input.action==='block'){
          this.store.setRecord('user-blocklist',this.key(input.user_id!),{agent_id:this.agentId,platform:'qq',account_id:this.accountId,user_id:input.user_id,reason:input.reason??'',blocked_at:new Date().toISOString()})
          // Catch raw observations already archived but not admitted, including debounce/participation queues.
          for(let offset=0;;offset+=250){const rows=this.store.events({agentId:this.agentId,platform:'qq',accountId:this.accountId,sourceKind:'napcat',limit:250,offset})
            for(const {event} of rows)if(event.actor_id===input.user_id&&!this.store.record('main-inbox-seen',event.event_id)){
              this.suppress(event);if(this.store.event(event.event_id)?.state==='queued')this.store.setEventState(event.event_id,'processed')
            }
            if(rows.length<250)break
          }
        }else this.store.deleteRecord('user-blocklist',this.key(input.user_id!))
      })
      this.onChange()
    }
    return{platform:'qq',account_id:this.accountId,items:this.list()}
  }
}
