/** Runtime-only group observation. NapCat remains an unmodified transport. */
import { z } from 'zod'
import { createHash } from 'node:crypto'
import type { AmphoreusRuntime } from './runtime.ts'
import type { GatewayEvent } from './model.ts'
import type { QQSettings } from './qq.ts'

export const ParticipationSettings = z.object({
  mode: z.enum(['hybrid','heart']).default('hybrid'), enabled: z.boolean().default(false),
  probability: z.number().min(0).max(1).default(.05), windowMs: z.number().int().min(0).max(120000).default(60000),
  maxMessages: z.number().int().min(1).max(20).default(20), maxChars: z.number().int().min(100).max(32000).default(12000),
  cooldownMs: z.number().int().min(0).max(86400000).default(720000), inertiaMs: z.number().int().min(0).max(600000).default(120000),
  shareHigh: z.number().min(.2).max(.5).default(.35), shareStop: z.number().min(.35).max(1).default(.5),
  fatigue: z.boolean().default(true), sleep: z.boolean().default(true), botIds: z.array(z.string()).default([]),
}).strict()
export const ParticipationPatch = ParticipationSettings.partial()
type Settings = z.infer<typeof ParticipationSettings>
type Batch = { id: string; ids: string[]; direct: boolean; reason: string; origin?:string }
interface GroupState {
  group: string; name: string; pending: string[]; firstAt: number; queued?: Batch; lastBatch?: Batch;
  cooldownUntil: number; lastSpoke?: number; lastReceipt?: string; topic?: string; awaitingActor?: string;
  engagedUntil: number; logs: { at: string; reason: string; count?: number; probability?: number; factors?: Factors }[]
}
type Factors = { batch: number; fatigue: number; share: number; time: number; engagement: number }
export interface Vitality { used?: number; capacity?: number; reserve?: number; sleeping?: boolean; phase?: 'awake'|'drowsy'|'resting' }
const digest = (s:string) => createHash('sha256').update(s).digest('hex').slice(0,24)
export function participationProbability(p:number,n:number,share:number,usage:number,night:boolean,engaged:boolean,settings:Settings) {
  const factors:Factors={batch:Math.min(.25,1-(1-p)**Math.min(n,5)),
    fatigue:!settings.fatigue?1:usage>=.8?0:usage>=.65?.2:usage>=.4?.6:1,
    share:share>=settings.shareStop?0:share>=settings.shareHigh?.15:share>=.2?.5:1,
    time:night?.3:1,engagement:engaged?1.5:1}
  return {factors,probability:Math.min(1,Object.values(factors).reduce((a,b)=>a*b,1))}
}

export class GroupParticipation {
  canReceive:(group:string)=>boolean=()=>true
  canAdmit:(event:GatewayEvent)=>boolean=()=>true
  clearDisabled(){for(const state of this.runtime.store.records<GroupState>('participation-state'))if(!this.canReceive(state.group)){
    if(state.queued&&this.runtime.store.event(state.queued.id)?.state==='queued')this.runtime.store.setEventState(state.queued.id,'processed')
    for(const id of [...state.pending,...state.queued?.ids??[]])this.runtime.store.setRecord('main-inbox-seen',id,true)
    state.pending=[];state.queued=undefined;state.firstAt=0;this.save(state)
  }}
  private timer?:ReturnType<typeof setInterval>
  private scanning?:Promise<void>
  private requested=false
  private stopped=false
  private readonly unregister:()=>void
  constructor(private readonly runtime:AmphoreusRuntime,private readonly qq:QQSettings,
    private readonly rpc:(action:string,params:Record<string,unknown>)=>Promise<Record<string,unknown>>,
    private readonly now=()=>Date.now(),private readonly random=()=>Math.random()) {
    const {store,role}=runtime
    if(!store.record('participation-config',role.agent_id)) {
      store.setRecord('participation-config',role.agent_id,ParticipationSettings.parse({probability:qq.activeReply.probability,
        ...store.record<object>('participation-initial',role.agent_id)}))
      // Existing explicitly enabled groups retain access. Future groups start in observation-only mode.
      for(const {event} of store.events({agentId:role.agent_id,sourceKind:'napcat',platform:'qq',accountId:qq.accountId,limit:10000})) {
        if(event.metadata.message_type==='group'&&!store.record('participation-group',event.conversation_id))
          store.setRecord('participation-group',event.conversation_id,{enabled:qq.groupTrigger==='all'&&qq.activeReply.enabled})
      }
      const last=store.eventsAfter(role.agent_id,0,100000).at(-1)?.position??0
      store.setRecord('participation-cursor',role.agent_id,last)
    }
    this.unregister=runtime.gateway.registerInput({kind:'qq-observation',platform:'qq',normalize:raw=>{
      const event=raw as GatewayEvent
      const origin=store.event(String(event.metadata.origin_event_id))?.event
      if(!origin||origin.source_kind!=='napcat'||origin.agent_id!==role.agent_id||origin.platform!=='qq'
        ||origin.account_id!==event.account_id||origin.conversation_id!==event.conversation_id)throw new Error('Invalid observation source')
      return event
    }})
  }
  settings(group?:string):Settings {
    const {store,role}=this.runtime
    return ParticipationSettings.parse({...store.record<object>('participation-config',role.agent_id),...(group?store.record<object>('participation-group',group):{})})
  }
  configure(patch:unknown,group?:string) {
    const parsed=ParticipationPatch.parse(patch),value=Object.fromEntries(Object.entries(parsed).filter(([key])=>Object.hasOwn(patch as object,key))),{store,role}=this.runtime
    if(group&&!/^group:\d+$/.test(group))throw new Error('Invalid group')
    store.setRecord(group?'participation-group':'participation-config',group??role.agent_id,
      {...store.record<object>(group?'participation-group':'participation-config',group??role.agent_id),...value})
    this.wake();this.runtime.onChange();return this.settings(group)
  }
  private state(group:string):GroupState {
    return this.runtime.store.record<GroupState>('participation-state',group)??{group,name:group,pending:[],firstAt:0,cooldownUntil:0,engagedUntil:0,logs:[]}
  }
  private save(state:GroupState){this.runtime.store.setRecord('participation-state',state.group,state)}
  private log(state:GroupState,reason:string,count?:number,decision?:ReturnType<typeof participationProbability>){
    state.logs.push({at:new Date(this.now()).toISOString(),reason,...(count===undefined?{}:{count}),...decision})
    state.logs=state.logs.slice(-50);this.save(state)
  }
  start(){this.stopped=false;this.wake();this.timer=setInterval(()=>this.wake(),1000);this.timer.unref()}
  async stop(){this.stopped=true;clearInterval(this.timer);await this.scanning;this.unregister()}
  wake(){
    if(this.stopped)return
    this.requested=true
    if(this.scanning)return
    this.scanning=Promise.resolve().then(async()=>{do{this.requested=false;await this.tick()}while(this.requested&&!this.stopped)})
      .catch(()=>{this.runtime.store.setRecord('error','participation',{error:'群聊调度暂未完成，原始消息保留，稍后自动重试。'})})
      .finally(()=>{this.scanning=undefined})
  }
  async idle(){await this.scanning}
  private async direct(event:GatewayEvent,state:GroupState):Promise<string|undefined>{
    if(event.content.some(b=>b.type==='mention'&&String(b.actor_id)===event.account_id))return 'direct-mention'
    const quote=event.content.find(b=>b.type==='quote')
    if(quote){
      const own=this.runtime.store.outputs(1000).some(o=>o.status==='sent'&&o.platform==='qq'&&o.target.account_id===event.account_id
        &&o.target.conversation_id===event.conversation_id&&String(this.runtime.store.record<{message_id:string}>('receipt',o.output_id)?.message_id)===String(quote.message_id))
      if(own)return 'direct-reply'
      try{const source=await this.rpc('get_msg',{message_id:quote.message_id}),sender=source.sender as Record<string,unknown>|undefined
        if(String(sender?.user_id)===event.account_id&&String(source.group_id)===String(event.metadata.group_id))return 'direct-reply'
      }catch{/* Unresolved quotes remain observations. */}
    }
    if(state.awaitingActor===event.actor_id&&state.engagedUntil>this.now()) {state.awaitingActor=undefined;return 'direct-answer'}
    return undefined
  }
  /** Main may identify a topic or ask for one answer; ordinary traffic never extends this lease. */
  engage(group:string,topic?:string,awaitingActor?:string,active=true){
    const state=this.state(group)
    state.topic=active?topic:undefined;state.awaitingActor=active?awaitingActor:undefined
    state.engagedUntil=active?this.now()+this.settings(group).inertiaMs:0;this.save(state)
  }
  private async emit(state:GroupState,batch:Batch){
    const {store,role}=this.runtime
    const ids=batch.ids.filter(id=>{const source=store.event(id)?.event;return !!source&&this.canAdmit(source)})
    const origin=store.event(batch.origin&&ids.includes(batch.origin)?batch.origin:ids.at(-1)??'')?.event
    if(!origin||!this.canReceive(state.group))return
    await this.runtime.gateway.ingest('qq-observation',{...origin,event_id:batch.id,source_kind:'qq-observation',
      event_type:'group.observation',actor_id:'group-observer',timestamp:new Date(this.now()).toISOString(),received_at:new Date(this.now()).toISOString(),
      content:[],metadata:{...origin.metadata,schedule:true,origin_event_id:origin.event_id,source_event_ids:ids,
        priority:batch.direct?10:-5,direct:batch.direct,proactive:!batch.direct,participation_reason:batch.reason},
      agent_id:role.agent_id,visibility:'internal',idempotency_key:`observation:${batch.id}`})
  }
  private batch(state:GroupState,ids:string[],direct:boolean,reason:string):Batch {
    return {id:`observation-${digest(JSON.stringify([this.runtime.role.agent_id,state.group,ids,direct]))}`,ids,direct,reason}
  }
  private async accept(event:GatewayEvent,sources:GatewayEvent[]=[event]){
    const state=this.state(event.conversation_id),settings=this.settings(state.group)
    if(!this.canReceive(state.group)||!this.canAdmit(event)||event.metadata.qq_receive_enabled===false)return
    state.name=String(event.metadata.group_name??state.name)
    const unseen=sources.filter(source=>!state.pending.includes(source.event_id)&&this.canAdmit(source)&&source.metadata.qq_receive_enabled!==false)
    if(!unseen.length)return
    if(state.lastBatch&&unseen.every(source=>state.lastBatch!.ids.includes(source.event_id))){
      if(state.lastBatch.direct||state.lastBatch.reason==='heart'||state.queued?.id===state.lastBatch.id)await this.emit(state,state.lastBatch)
      return
    }
    const fresh=unseen.filter(source=>!state.lastBatch?.ids.includes(source.event_id))
    let direct:string|undefined,origin=event
    for(const source of [...fresh].reverse())if(direct=await this.direct(source,state)){origin=source;break}
    const ordinary=fresh.filter(source=>source.metadata.bot!==true&&!settings.botIds.includes(source.actor_id))
    const incoming=(direct?fresh:ordinary).map(source=>source.event_id)
    if(direct||settings.mode==='heart'&&settings.enabled&&incoming.length){
      if(state.queued&&this.runtime.store.event(state.queued.id)?.state==='queued'){
        this.runtime.store.setEventState(state.queued.id,'processed');state.pending=[...state.queued.ids,...state.pending];state.queued=undefined
      }
      let ids=[...new Set([...state.pending,...incoming])].slice(-settings.maxMessages)
      if(direct&&!ids.includes(origin.event_id))ids=[origin.event_id,...ids.slice(1)]
      const batch=this.batch(state,ids,!!direct,direct??'heart')
      if(direct)batch.origin=origin.event_id
      state.pending=[];state.firstAt=0;state.lastBatch=batch;this.log(state,batch.reason,ids.length)
      await this.emit(state,batch);return
    }
    if(!settings.enabled||!incoming.length){
      this.log(state,!settings.enabled?'observation-only':'other-bot',1);return
    }
    if(!state.pending.length)state.firstAt=this.now()
    state.pending.push(...incoming)
    // The durable raw archive is unbounded; the pending model observation stays bounded while Main is busy.
    state.pending=state.pending.slice(-settings.maxMessages)
    this.save(state)
    if(state.pending.length>=settings.maxMessages)await this.flush(state)
  }
  private stats(group:string){
    const events=this.runtime.store.events({agentId:this.runtime.role.agent_id,platform:'qq',accountId:this.qq.accountId,conversationId:group,limit:300})
      .filter(({event})=>Date.parse(event.received_at)>=this.now()-600000)
      .filter(({event})=>event.source_kind==='napcat'||event.source_kind==='output-gateway'&&this.runtime.store.output(event.event_id)?.status==='sent')
    const recent=events.slice(0,20),own=recent.filter(({event})=>event.source_kind==='output-gateway').length
    return {share:recent.length?own/recent.length:0,messages:recent.length,sent:own,
      sentInTenMinutes:events.filter(({event})=>event.source_kind==='output-gateway').length,
      consecutive:recent.findIndex(({event})=>event.source_kind!=='output-gateway')<0?own:recent.findIndex(({event})=>event.source_kind!=='output-gateway')}
  }
  private decision(state:GroupState){
    const settings=this.settings(state.group),v=this.runtime.store.record<Vitality>('main-vitality',this.runtime.role.agent_id)??{}
    const capacity=v.capacity?Math.min(750000,Math.max(1,v.capacity-(v.reserve??8192))):750000
    const usage=v.used===undefined?undefined:v.used/capacity,stats=this.stats(state.group)
    const p=participationProbability(settings.probability,state.pending.length,stats.share,usage??0,v.phase==='drowsy',
      !!state.topic&&state.engagedUntil>this.now()&&state.pending.some(id=>this.runtime.store.event(id)?.event.metadata.topic_id===state.topic),settings)
    const reason=settings.sleep&&(v.sleeping||v.phase==='resting')?'sleep':this.now()<state.cooldownUntil?'cooldown':
      settings.fatigue&&(usage??0)>=.8?'fatigue':stats.share>=settings.shareStop?'speech-share':!settings.enabled?'observation-only':undefined
    return {...p,usage,stats,reason,vitality:v}
  }
  private async flush(state:GroupState){
    if(!state.pending.length||state.queued)return
    const settings=this.settings(state.group),decision=this.decision(state)
    let ids=state.pending,chars=0
    ids=ids.filter(id=>{const event=this.runtime.store.event(id)?.event;const length=event?.content.reduce((n,b)=>n+(b.type==='text'?String(b.text).length:80),0)??0;chars+=length;return chars<=settings.maxChars})
    if(!ids.length)ids=state.pending.slice(-1)
    // Save the outcome before any asynchronous delivery: recovery never rerolls this batch.
    const accepted=!decision.reason&&this.random()<decision.probability
    const batch=this.batch(state,ids,false,'observation')
    state.pending=[];state.firstAt=0;state.lastBatch=batch
    if(accepted)state.queued=batch
    this.log(state,decision.reason??(accepted?'scheduled':'probability-miss'),ids.length,decision)
    if(accepted)await this.emit(state,batch)
  }
  private reconcile(){
    const {store}=this.runtime
    for(const output of store.outputs(1000)){
      if(output.platform!=='qq'||!output.target.conversation_id.startsWith('group:')||output.target.account_id!==this.qq.accountId)continue
      const recorded=store.record<string>('participation-output',output.output_id)
      if(recorded===output.status)continue
      const source=store.event(String(store.event(output.event_id)?.event.metadata.origin_event_id))?.event
      const state=this.state(output.target.conversation_id)
      if(output.status==='sent'){
        state.lastSpoke=Date.parse(output.updated_at);state.lastReceipt=store.record<{message_id:string}>('receipt',output.output_id)?.message_id
        if(source?.metadata.proactive===true)state.cooldownUntil=state.lastSpoke+this.settings(state.group).cooldownMs
      }
      this.log(state,`speak-${output.status}`);store.setRecord('participation-output',output.output_id,output.status)
    }
    for(const state of store.records<GroupState>('participation-state')){
      if(!state.queued)continue
      const event=store.event(state.queued.id)
      if(event&&['processed','failed'].includes(event.state)){
        const spoke=store.outputs(1000).some(o=>store.event(o.event_id)?.event.metadata.origin_event_id===state.queued!.id&&o.status==='sent')
        this.log(state,event.state==='failed'?'main-failed':spoke?'main-spoke':'main-silent')
        state.queued=undefined;this.save(state)
      }
    }
  }
  async tick(){
    this.reconcile()
    const {store,role}=this.runtime
    for(;;){
      const rows=store.eventsAfter(role.agent_id,store.record<number>('participation-cursor',role.agent_id)??0,250)
      if(!rows.length)break
      for(const row of rows){
        const event=row.event
        if(event.account_id===this.qq.accountId&&event.metadata.message_type==='group'&&event.metadata.participation===true){
          if(event.source_kind==='napcat')await this.accept(event)
          else if(event.source_kind==='qq-debounce'){
            const ids=Array.isArray(event.metadata.source_event_ids)?event.metadata.source_event_ids:[]
            const sources=ids.flatMap(id=>{
              const source=typeof id==='string'?store.event(id)?.event:undefined
              return source?.source_kind==='napcat'&&source.agent_id===role.agent_id&&source.account_id===event.account_id&&source.conversation_id===event.conversation_id?[source]:[]
            })
            const origin=sources.at(-1);if(origin)await this.accept(origin,sources)
          }
        }
        store.setRecord('participation-cursor',role.agent_id,row.position)
      }
    }
    for(const state of store.records<GroupState>('participation-state')){
      if(!this.canReceive(state.group)){
        if(state.queued&&store.event(state.queued.id)?.state==='queued')store.setEventState(state.queued.id,'processed')
        state.pending=[];state.queued=undefined;state.firstAt=0;this.save(state);continue
      }
      if(state.queued&&!store.event(state.queued.id))await this.emit(state,state.queued)
      const settings=this.settings(state.group)
      if(settings.mode==='heart'&&settings.enabled&&state.pending.length&&!state.queued){
        const batch=this.batch(state,state.pending,false,'heart');state.pending=[];state.firstAt=0;state.queued=batch;state.lastBatch=batch
        this.log(state,'heart',batch.ids.length);await this.emit(state,batch);continue
      }
      if(state.pending.length&&this.now()-state.firstAt>=settings.windowMs)await this.flush(state)
    }
  }
  status(){
    const groups=new Set([...this.runtime.store.records<GroupState>('participation-state').map(s=>s.group),
      ...this.runtime.store.events({sourceKind:'napcat',platform:'qq',accountId:this.qq.accountId,limit:10000}).filter(r=>r.event.metadata.message_type==='group').map(r=>r.event.conversation_id)])
    return {settings:this.settings(),groups:[...groups].map(group=>{
      const state=this.state(group),decision=this.decision(state)
      return {...state,settings:this.settings(group),...decision,state:decision.reason==='sleep'||decision.reason==='fatigue'?'resting':
        state.engagedUntil>this.now()?'engaged':state.cooldownUntil>this.now()?'cooldown':'observing'}
    })}
  }
  delivery(event:GatewayEvent){
    const state=this.state(event.conversation_id)
    if(this.runtime.store.record('main-inbox-seen',event.event_id))return 'admitted'
    if(state.queued?.ids.includes(event.event_id))return 'scheduled'
    if(state.pending.includes(event.event_id))return 'buffering'
    return state.logs.at(-1)?.reason??'archived'
  }
}
