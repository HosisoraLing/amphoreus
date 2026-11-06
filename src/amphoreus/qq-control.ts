/** Durable per-conversation receive policy and trailing-edge QQ debounce. Raw messages never disappear. */
import { z } from 'zod'
import { createHash } from 'node:crypto'
import type { AmphoreusRuntime } from './runtime.ts'
import type { GatewayEvent } from './model.ts'
export const QQControlSettings=z.object({receiveEnabled:z.boolean().default(true),debounceEnabled:z.boolean().default(false),
  waitMs:z.number().int().min(100).max(120000).default(3000),maxWaitMs:z.number().int().min(100).max(300000).default(30000)}).strict()
export const QQControlPatch=z.object({receiveEnabled:z.boolean().optional(),debounceEnabled:z.boolean().optional(),
  waitMs:z.number().int().min(100).max(120000).optional(),maxWaitMs:z.number().int().min(100).max(300000).optional()}).strict().refine(v=>Object.keys(v).length>0,'At least one setting is required')
export const QQControlInput=z.object({conversation_id:z.string().regex(/^(group|private):[1-9]\d{0,19}$/).optional(),patch:QQControlPatch.optional(),reset:z.boolean().optional()}).strict()
type Settings=z.infer<typeof QQControlSettings>
type State={conversation:string;ids:string[];firstAt:number;lastAt:number;ready?:{id:string;ids:string[]};}
export class QQControl {
  routeGroupsThroughParticipation=false
  canReceive:(conversation:string)=>boolean=()=>true
  onPolicyChange:()=>void=()=>{}
  canAdmit:(event:GatewayEvent)=>boolean=()=>true
  private timer?:ReturnType<typeof setInterval>
  private scanning?:Promise<void>
  private stopped=false
  private requested=false
  private readonly off:()=>void
  private get key(){return JSON.stringify([this.runtime.role.agent_id,this.account])}
  private scope(conversation?:string){return JSON.stringify([this.runtime.role.agent_id,this.account,conversation??'*'])}
  constructor(private readonly runtime:AmphoreusRuntime,readonly account:string,private readonly now=()=>Date.now()){
    this.off=runtime.gateway.registerInput({kind:'qq-debounce',platform:'qq',normalize:raw=>{
      const event=raw as GatewayEvent,origin=runtime.store.event(String(event.metadata.origin_event_id))?.event
      if(!origin||origin.source_kind!=='napcat'||origin.agent_id!==runtime.role.agent_id||origin.account_id!==account||origin.conversation_id!==event.conversation_id)throw Error('Invalid debounce origin')
      return event
    }})
    if(runtime.store.record('qq-control-cursor',this.key)===undefined){
      const position=runtime.store.eventsAfter(runtime.role.agent_id,0,1000000).at(-1)?.position??0
      runtime.store.setRecord('qq-control-cursor',this.key,position)
    }
  }
  settings(conversation?:string):Settings{return QQControlSettings.parse({...this.runtime.store.record<object>('qq-control-config',this.scope()),...(conversation?this.runtime.store.record<object>('qq-control-config',this.scope(conversation)):{} )})}
  enabled(conversation:string){return this.settings(conversation).receiveEnabled&&this.canReceive(conversation)}
  override(conversation:string){return this.runtime.store.record<{receiveEnabled?:boolean}>('qq-control-config',this.scope(conversation))?.receiveEnabled}
  setReceiving(conversation:string,enabled:boolean|undefined){
    if(enabled!==undefined){this.configure({conversation_id:conversation,patch:{receiveEnabled:enabled}});return}
    const patch={...this.runtime.store.record<Record<string,unknown>>('qq-control-config',this.scope(conversation))};delete patch.receiveEnabled
    if(Object.keys(patch).length)this.runtime.store.setRecord('qq-control-config',this.scope(conversation),patch)
    else this.runtime.store.deleteRecord('qq-control-config',this.scope(conversation))
    this.clearDisabled();this.onPolicyChange();this.wake();this.runtime.onChange()
  }
  configure(input:z.infer<typeof QQControlInput>){
    const args=QQControlInput.parse(input),{store}=this.runtime
    if(args.reset){if(!args.conversation_id||args.patch)throw Error('Reset requires only a conversation');store.deleteRecord('qq-control-config',this.scope(args.conversation_id))}
    else if(args.patch){
      const patch=Object.fromEntries(Object.entries(args.patch).filter(([k])=>Object.hasOwn(input.patch??{},k)))
      store.setRecord('qq-control-config',this.scope(args.conversation_id),{...store.record<object>('qq-control-config',this.scope(args.conversation_id)),...patch})
    }
    this.clearDisabled()
    this.onPolicyChange();this.wake();this.runtime.onChange();return this.status()
  }
  clearDisabled(){
    const {store}=this.runtime
    // Closing receive also cancels any durable pending batch; reopening never resurrects it.
    for(const state of this.states())if(!this.enabled(state.conversation))this.discard(state)
    for(const {event} of store.events({agentId:this.runtime.role.agent_id,platform:'qq',accountId:this.account,state:'queued',limit:100000})){
      if(!this.enabled(event.conversation_id)){
        store.setEventState(event.event_id,'processed');store.setRecord('qq-control-suppressed',event.event_id,true)
        for(const id of Array.isArray(event.metadata.source_event_ids)?event.metadata.source_event_ids:[])if(typeof id==='string'){
          store.setRecord('main-inbox-seen',id,true);store.setRecord('qq-control-suppressed',id,true)
        }
      }
    }
  }
  private states(){return this.runtime.store.records<State & {scope:string}>('qq-control-state').filter(s=>s.scope===this.key)}
  private state(conversation:string):State{return this.runtime.store.record<State>('qq-control-state',this.scope(conversation))??{conversation,ids:[],firstAt:0,lastAt:0}}
  private save(state:State){this.runtime.store.setRecord('qq-control-state',this.scope(state.conversation),{...state,scope:this.key})}
  private discard(state:State){
    const {store}=this.runtime
    for(const id of [...state.ids,...state.ready?.ids??[]]){store.setRecord('main-inbox-seen',id,true);store.setRecord('qq-control-suppressed',id,true)}
    if(state.ready&&store.event(state.ready.id)?.state==='queued')store.setEventState(state.ready.id,'processed')
    state.ids=[];state.ready=undefined;state.firstAt=state.lastAt=0;this.save(state)
  }
  start(){this.stopped=false;this.wake();this.timer=setInterval(()=>this.wake(),250);this.timer.unref()}
  async stop(){this.stopped=true;clearInterval(this.timer);await this.scanning;this.off()}
  wake(){if(this.stopped)return;this.requested=true;if(this.scanning)return
    this.scanning=Promise.resolve().then(async()=>{do{this.requested=false;await this.tick()}while(this.requested&&!this.stopped)})
      .catch(()=>this.runtime.store.setRecord('error','qq-control',{error:'QQ消抖待重试；原始消息保留。'})).finally(()=>{this.scanning=undefined})}
  async idle(){await this.scanning}
  private async emit(state:State){
    if(!state.ready)return
    if(!this.enabled(state.conversation)){this.discard(state);return}
    const ids=state.ready.ids.filter(id=>{const source=this.runtime.store.event(id)?.event;return !!source&&this.canAdmit(source)})
    if(!ids.length){state.ready=undefined;this.save(state);return}
    const origin=this.runtime.store.event(ids.at(-1)!)?.event;if(!origin)throw Error('Missing durable source')
    const participation=this.routeGroupsThroughParticipation&&origin.metadata.message_type==='group'
    await this.runtime.gateway.ingest('qq-debounce',{...origin,event_id:state.ready.id,source_kind:'qq-debounce',event_type:'message.batch',
      content:[],metadata:{...origin.metadata,schedule:!participation,participation,origin_event_id:origin.event_id,source_event_ids:ids,debounce_batch:true,
        priority:origin.content.some(b=>b.type==='mention'&&String(b.actor_id)===this.account)?10:0},visibility:'internal',idempotency_key:state.ready.id})
    state.ready=undefined;this.save(state);this.runtime.onChange()
  }
  private async flush(state:State){
    if(state.ready)await this.emit(state)
    while(state.ids.length){
      const ids=[...state.ids],id='debounce-'+createHash('sha256').update(JSON.stringify([this.key,state.conversation,ids])).digest('hex').slice(0,32)
      this.runtime.store.atomic(()=>{state.ids=[];state.ready={id,ids};this.save(state);for(const source of ids)this.runtime.store.setRecord('qq-control-batched',source,id)})
      await this.emit(state)
    }
    state.firstAt=state.lastAt=0;this.save(state)
  }
  async tick(){
    const {store,role}=this.runtime
    for(const state of this.states())if(state.ready)await this.emit(state)
    for(;;){const rows=store.eventsAfter(role.agent_id,store.record<number>('qq-control-cursor',this.key)??0,250);if(!rows.length)break
      for(const row of rows){const e=row.event
        if(e.source_kind==='napcat'&&e.account_id===this.account&&e.metadata.qq_debounce===true&&e.metadata.qq_receive_enabled!==false&&this.canAdmit(e)){
          const state=this.state(e.conversation_id)
          if(!this.enabled(e.conversation_id)){store.setRecord('main-inbox-seen',e.event_id,true);this.discard(state)}
          else if(!store.record('main-inbox-seen',e.event_id)&&!store.record('qq-control-batched',e.event_id)&&!state.ids.includes(e.event_id)){
            state.ids.push(e.event_id);if(!state.firstAt)state.firstAt=Date.parse(e.received_at);state.lastAt=Date.parse(e.received_at);this.save(state)
            if(e.content.some(b=>b.type==='mention'&&String(b.actor_id)===this.account))await this.flush(state)
          }
        }
        store.setRecord('qq-control-cursor',this.key,row.position)
      }
    }
    for(const state of this.states()){
      const settings=this.settings(state.conversation)
      if(!settings.receiveEnabled){this.discard(state);continue}
      if(state.ids.length&&(!settings.debounceEnabled||this.now()-state.lastAt>=settings.waitMs||this.now()-state.firstAt>=settings.maxWaitMs))await this.flush(state)
    }
  }
  status(){const conversations=this.runtime.store.conversations().filter(c=>c.agent_id===this.runtime.role.agent_id&&c.platform==='qq'&&c.account_id===this.account)
    return{account_id:this.account,settings:this.settings(),conversations:conversations.map(c=>({conversation_id:c.conversation_id,title:c.title,settings:this.settings(c.conversation_id),override:this.runtime.store.record<object>('qq-control-config',this.scope(c.conversation_id))??{},pending:this.state(c.conversation_id).ids.length}))}}
}
