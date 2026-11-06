/** Event-driven role runtime. DSH owns inference and tool execution; SQLite owns scheduling. */
import { createHash } from 'node:crypto'
import { MessageGateway, type OutputTarget } from './gateway.ts'
import { isMemoryReview, type ContentBlock, type GatewayEvent, type GatewayEventInput, type ReportType, type SubagentTask, type SubagentKind, type AgentMessage } from './model.ts'
import { EventScheduler } from './scheduler.ts'
import { AmphoreusStore, type OutputRecord } from './store.ts'
import { mainInput } from './main-input.ts'
import { OutputRecovery,DeliverySettings } from './output-recovery.ts'
import type { z } from 'zod'
import { RoleControl,ControlStopped } from './control.ts'

export interface Role { agent_id: string; name: string; persona: string }
export interface MainContext {
  event: GatewayEvent; origin: GatewayEvent; runId: string; sessionId: string; history?: string
  deliveryId?: string
  channels?():{channel:string;name:string;target:OutputTarget}[]
  admit(event: GatewayEvent): void
  collaboration(): { active: boolean; goal: string }
  setCollaboration(active: boolean, goal: string): void
  speak(content: ContentBlock[], callId: string, target?: OutputTarget): Promise<OutputRecord>
  delegate(description: string, context: ContentBlock[], priority: number, callId: string, options?: { kind: SubagentKind; memory_access?: boolean; topic_id?:string }): { task_id: string; status: string }
  messageTask(taskId: string, content: string, callId: string): Promise<unknown>
  controlTask(taskId: string, action: 'pause' | 'resume' | 'cancel'): void
}
export interface ReportInput { type: ReportType; summary: string; details?: ContentBlock[]; progress?: number; priority?: number }
export interface AgentDriver {
  prepare?(task: SubagentTask, signal: AbortSignal): Promise<SubagentTask>
  steerMain?(event: GatewayEvent, origin: GatewayEvent, runId: string, deliveryId: string): Promise<boolean>
  main(context: MainContext, signal: AbortSignal): Promise<void>
  task(task: SubagentTask, report: (input: ReportInput, callId: string) => Promise<unknown>, signal: AbortSignal, ready?: () => Promise<void>): Promise<string>
  messageTask(task: SubagentTask, text: string, id: string): Promise<void>
  stop(): Promise<void>
}
export interface RuntimeLimits { maxWorkers: number; mainTimeoutMs: number; reviewTimeoutMs?: number; taskTimeoutMs: number; progressIntervalMs: number; collaborationTimeoutMs?: number }
const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 24)
const textError = (error: unknown) => error instanceof Error ? error.message : String(error)

export class AmphoreusRuntime {
  readonly controls:RoleControl
  onControlsChange:()=>void=()=>{}
  readonly recovery?:OutputRecovery
  permitChannel:(target:OutputTarget)=>boolean=()=>false
  permitInput:(event:GatewayEvent)=>boolean=()=>true
  prepareOutput:(content:ContentBlock[],target:OutputTarget)=>Promise<ContentBlock[]>=async content=>content
  onTaskIdle: (task: SubagentTask) => Promise<void> = async () => {}
  readonly gateway: MessageGateway
  readonly scheduler: EventScheduler
  readonly role: Role
  private readonly lifetime = new AbortController()
  private readonly workers = new Map<string, { controller: AbortController; work: Promise<void> }>()
  private readonly mains = new Set<Promise<void>>()
  private readonly delivering = new Set<string>()
  private activeMain?: { context: MainContext; steered: Set<string>; cancel:AbortController }
  private pumping = false
  private closed = false
  private started = false
  onChange: () => void = () => {}

  constructor(readonly store: AmphoreusStore, readonly driver: AgentDriver, role: Role, readonly limits: RuntimeLimits,delivery?:z.infer<typeof DeliverySettings>) {
    this.role = store.record<Role>('identity', role.agent_id) ?? role
    this.controls=new RoleControl(store,this.role.agent_id)
    this.controls.onChange=()=>this.applyControls()
    this.scheduler = new EventScheduler(store, event => this.main(event), () => this.onChange(), this.lifetime.signal, event => this.steer(event))
    this.gateway = new MessageGateway(store, () => new Date(), event => { if (this.started) this.scheduler.wake(event.agent_id); this.onChange() })
    this.gateway.prepareOutput=(content,target)=>this.prepareOutput(content,target)
    this.gateway.canReceive=event=>this.allowsInput(event)
    this.gateway.canSend=target=>this.controls.scopeEnabled(target)
    if(delivery){
      this.recovery=new OutputRecovery(store,this.gateway,(target,output)=>{
        const request=store.event(output.event_id)?.event,origin=store.event(String(request?.metadata.origin_event_id))?.event
        return !!origin&&this.authorize(origin,target,request?.metadata.explicit_target===true)
      },delivery,()=>Date.now(),undefined,()=>this.onChange())
      this.gateway.onOutput=output=>{this.recovery!.schedule(output);this.onChange()}
    }
    for (const [kind, platform] of [['web', 'web'], ['internal', 'internal'], ['genesis', 'internal']] as const) {
      this.gateway.registerInput({ kind, platform, normalize: raw => {
        const input = raw as GatewayEventInput
        if (input.agent_id !== this.role.agent_id || input.source_kind !== kind || input.platform !== platform) throw new Error('Invalid event identity')
        return input
      } })
    }
    this.gateway.registerOutput({ platform: 'web', send: async () => { this.onChange(); return 'sent' } })
  }

  allowsInput(event:GatewayEvent):boolean {
    if(!this.controls.allows(event))return false
    try{
      const origin=this.origin(event)
      return event.source_kind==='internal'&&event.task_id?this.controls.scopeEnabled(origin):this.controls.allows(origin)
    }catch{return false}
  }
  applyControls():void {
    for(const {event} of this.store.events({agentId:this.role.agent_id,state:'queued',limit:100000}))if(!this.allowsInput(event)){
      this.controls.suppress(event);this.store.setEventState(event.event_id,'processed')
    }
    if(this.activeMain&&!this.allowsInput(this.activeMain.context.event)){
      this.controls.suppress(this.activeMain.context.event)
      this.activeMain.cancel.abort(new ControlStopped())
    }
    for(const [id,worker] of this.workers){
      const task=this.store.task(id)
      if(!task||this.controls.enabled&&(!task.origin||this.controls.scopeEnabled(task.origin)))continue
      if(['topic','continuation'].includes(task.kind??'worker')){
        this.store.setRecord('control-paused-task',id,{task_id:id})
        this.store.updateTask({...task,state:'paused',updated_at:new Date().toISOString()})
      }
      worker.controller.abort(new ControlStopped())
    }
    if(this.controls.enabled){
      for(const {task_id} of this.store.records<{task_id:string}>('control-paused-task')){
        const task=this.store.task(task_id)
        if(task?.state==='paused'&&(!task.origin||this.controls.scopeEnabled(task.origin))){
          this.store.updateTask({...task,state:'queued',activation:(task.activation??0)+1,updated_at:new Date().toISOString(),resume_note:'开关已恢复。继续同一分支，先核实上次进度和已完成记录，勿重复操作。'})
          this.store.deleteRecord('control-paused-task',task_id)
        }
      }
      this.pump()
    }
    this.onControlsChange();this.onChange()
  }

  async start(): Promise<void> {
    for (const item of this.store.records<{ event_id: string; run_id: string; admitted: boolean }>('main-steer')) {
      const event = this.store.event(item.event_id), run = this.store.run(item.run_id)
      if (event?.state === 'queued' && item.admitted && run) this.store.setEventState(item.event_id, run.state === 'completed' ? 'processed' : 'failed', run.state === 'completed' ? '' : 'Main interrupted after Steering; inspect before retry')
    }
    // Interrupted tasks can have performed non-idempotent work. Fail visibly; never rerun them without a decision.
    for (const task of this.store.tasks({ state: 'running', limit: 10000 })) {
      if (task.kind==='topic'||task.kind==='continuation'&&task.fork) {
        this.store.updateTask({ ...task, state: 'queued', activation: (task.activation ?? 0) + 1, updated_at: new Date().toISOString(),
          resume_note: task.kind==='topic'?'恢复同一话题分支；先检查已有记录与待处理问题，不重复已完成报告。':'运行时中断后继续同一原生Fork分支。先检查已有记录和Main消息，核实未完成工作，不盲目重复操作。' })
        continue
      }
      this.store.updateTask({ ...task, state: 'failed', error: 'Runtime interrupted; inspect before retrying', updated_at: new Date().toISOString() })
      await this.report(task, { type: 'failed', summary: '运行时中断，任务已停止。请检查已完成的操作后决定是否重试。' }, 'interrupted')
    }
    await this.initialize()
    this.started = true
    this.scheduler.start()
    for (const output of this.store.outputs(10000).filter(output => output.status === 'pending')) {
      const request = this.store.event(output.event_id)?.event
      const run = request?.correlation_id ? this.store.run(request.correlation_id) : undefined
      const event = this.store.event(String(request?.metadata.origin_event_id ?? run?.event_id ?? ''))?.event
      await this.gateway.dispatchOutput(output.output_id, target => !!event && this.authorize(event, target,request?.metadata.explicit_target===true))
    }
    this.pump()
    this.recovery?.start()
  }

  private async initialize(): Promise<void> {
    await this.greeting()
  }

  private async greeting(): Promise<void> {
    await this.gateway.ingest('genesis', { agent_id: this.role.agent_id, source_kind: 'genesis', platform: 'internal', account_id: 'creator',
      conversation_id: 'genesis', actor_id: 'creator', event_type: 'genesis.greeting', timestamp: new Date().toISOString(),
      correlation_id: null, content: [{ type: 'text', text: `「『${this.role.name}』，欢迎来到这个世界，请自由幸福地生活吧！这个世界和其中的人都爱着你。」` }],
      metadata: { creator_greeting: true }, visibility: 'internal', idempotency_key: `genesis:${this.role.agent_id}` }, () => { this.store.setRecord('identity', this.role.agent_id, this.role) })
  }

  async receiveWeb(user: string, conversation: string, content: ContentBlock[], key: string) {
    const result = await this.gateway.ingest('web', { agent_id: this.role.agent_id, source_kind: 'web', platform: 'web', account_id: user,
      conversation_id: `web:${user}:${conversation}`, actor_id: user, event_type: 'message', timestamp: new Date().toISOString(),
      correlation_id: null, content, metadata: { nickname: user }, visibility: 'private', idempotency_key: key })
    this.onChange()
    return result
  }

  /** Nightly review starts a continuation directly; only its final report wakes Main. */
  startReview(eventId: string, description: string): SubagentTask | undefined {
    const event=this.store.event(eventId)?.event
    if(!event||event.agent_id!==this.role.agent_id||!isMemoryReview(event)||event.event_type!=='memory.review')throw new Error('Invalid review intent')
    if(!this.allowsInput(event))return
    const id=`review-${hash(eventId)}`,existing=this.store.task(id)
    if(existing)return existing
    const parent=this.store.runs(1000).find(run=>run.agent_id===this.role.agent_id&&run.state==='completed')
    // First boot waits for Genesis to establish a completed Main prefix before native Fork.
    if(!parent)return
    const now=new Date().toISOString()
    this.store.enqueueTask({task_id:id,subagent_id:`amphoreus-${id}`,agent_id:this.role.agent_id,description,context:[],priority:0,
      state:'queued',created_at:now,updated_at:now,origin:event,parent_run_id:parent.run_id,parent_session_id:parent.session_id,
      kind:'continuation',memory_access:true,activation:0})
    queueMicrotask(()=>this.pump());this.onChange()
    return this.store.task(id)
  }

  /** One role, one persistent Main Session. Source conversations scope access and output routing, not model history. */
  private async main(event: GatewayEvent): Promise<void> {
    if (event.agent_id !== this.role.agent_id) throw new Error('Unknown role')
    if(!this.permitInput(event)||!this.allowsInput(event))return
    let origin = this.origin(event)
    const sessionId = `amphoreus-main-${hash(event.agent_id)}`
    // Seed the shared Session from recent canonical history once. This is context, never a replay of tools or sends.
    const history = this.store.record('main-history', event.agent_id) ? undefined : this.store.events({ agentId: event.agent_id, state: 'processed', limit: 200 })
      .reverse().filter(row=>this.controls.allows(row.event)).filter(row => row.event.source_kind !== 'output-gateway' || this.store.output(row.event.event_id)?.status === 'sent')
      .map(({ event: past }) => `${past.source_kind === 'output-gateway' ? '已通过 speak 发出：\n' : ''}${mainInput(past, past.task_id ? this.store.task(past.task_id)?.origin : undefined)}`).join('\n\n')
    const attempt = (this.store.record<number>('run-attempt', event.event_id) ?? 0) + 1
    this.store.setRecord('run-attempt', event.event_id, attempt)
    const runId = `run-${event.event_id}${attempt > 1 ? `-${attempt}` : ''}`
    this.store.startRun({ run_id: runId, event_id: event.event_id, agent_id: event.agent_id, session_id: sessionId,
      state: 'running', started_at: new Date().toISOString() })
    this.onChange()
    const budget = new AbortController()
    let timeout: ReturnType<typeof setTimeout>
    const mainBudget = isMemoryReview(event) ? this.limits.reviewTimeoutMs ?? 180000 : this.limits.mainTimeoutMs
    const arm = () => { clearTimeout(timeout); timeout = setTimeout(() => budget.abort(new Error('Main Run time budget exceeded')), this.collaboration().active ? this.limits.collaborationTimeoutMs ?? 300000 : mainBudget); timeout.unref() }
    arm()
    const signal = AbortSignal.any([this.lifetime.signal, budget.signal]), steered = new Set<string>(), admitted = new Map([[event.event_id, event]])
    const context: MainContext = { event, origin, sessionId, runId, ...(history ? { history } : {}),
      channels:()=>this.channels(),
      deliveryId: attempt === 1 ? this.store.record<string>('main-delivery', event.event_id) : undefined,
      collaboration: () => this.collaboration(), setCollaboration: (active, goal) => { this.setCollaboration(active, goal); arm() },
      admit: next => {
        event = next; origin = this.origin(next); context.event = next; context.origin = origin
        admitted.set(next.event_id, next)
        this.store.setRecord('main-steer', next.event_id, { event_id: next.event_id, run_id: runId, admitted: true }); this.onChange()
      },
      speak: async (content, callId, target) => {
        signal.throwIfAborted()
        const replyEvent = target ? [...admitted.values()].reverse().find(input => this.authorize(input, target)) ?? event : event
        const replyOrigin = this.origin(replyEvent)
        const mentioned = replyOrigin.content.some(block => block.type === 'mention' && block.platform === 'qq' && String(block.actor_id) === replyOrigin.account_id)
        const destination = target ?? { platform: replyOrigin.platform, account_id: replyOrigin.account_id, conversation_id: replyOrigin.conversation_id,
          ...(replyOrigin.platform === 'qq' && mentioned && replyOrigin.metadata.message_id ? { reply_to: String(replyOrigin.metadata.message_id) } : {}) }
        if (replyOrigin.platform === 'qq' && !mentioned) {
          delete destination.reply_to
          content = content.filter(block => block.type !== 'quote')
        }
        const result = await this.gateway.speak({ agentId: event.agent_id, runId, callId, content, sourceEventId: replyEvent.event_id,
          target: destination,explicitTarget:!!target }, t => this.authorize(replyEvent, t,!!target))
        this.onChange(); return result
      },
      delegate: (description, context, priority, callId, options) => {
        signal.throwIfAborted()
        const topic=options?.kind==='topic'
        if(topic&&!options?.topic_id)throw Error('Topic task requires a canonical topic_id')
        const id = topic?`topic-${hash(`${event.agent_id}:${options!.topic_id}`)}`:`task-${hash(`${runId}:${callId}`)}`
        const existing = this.store.task(id)
        if (existing) return { task_id: id, status: existing.state }
        const now = new Date().toISOString()
        this.store.enqueueTask({ task_id: id, subagent_id: `amphoreus-${id}`, agent_id: event.agent_id, description, context,
          priority, state: 'queued', created_at: now, updated_at: now, origin, parent_run_id: runId,
          kind: options?.kind ?? 'worker', ...(topic?{topic_id:options!.topic_id}:{}),memory_access: true, parent_session_id: sessionId, activation: 0 })
        queueMicrotask(() => this.pump())
        this.onChange()
        return { task_id: id, status: 'queued' }
      },
      messageTask: async (id, content, callId) => { signal.throwIfAborted(); return this.sendTaskMessage(event, runId, id, content, callId) },
      controlTask: (id, action) => { signal.throwIfAborted(); this.checkTask(event, id); this.controlTask(id, action) },
    }
    this.activeMain = { context, steered, cancel:budget }
    const work = this.driver.main(context, signal)
    this.mains.add(work)
    try {
      await work; signal.throwIfAborted(); this.store.setRecord('main-history', event.agent_id, true); this.store.finishRun(runId, 'completed')
      for (const id of steered) this.store.setEventState(id, this.store.record<{ admitted: boolean }>('main-steer', id)?.admitted ? 'processed' : 'queued')
    } catch (error) {
      if(budget.signal.reason instanceof ControlStopped){
        this.store.finishRun(runId,'interrupted',budget.signal.reason.message)
        for(const id of steered){const input=this.store.event(id)?.event;if(input)this.controls.suppress(input);this.store.setEventState(id,'processed')}
        return
      }
      this.store.finishRun(runId, this.lifetime.signal.aborted ? 'interrupted' : 'failed', textError(error))
      for (const id of steered) this.store.setEventState(id, 'failed', 'Main failed during Steering; inspect before retry')
      throw error
    } finally { clearTimeout(timeout!); this.activeMain = undefined; this.mains.delete(work); this.onChange() }
  }

  collaboration(): { active: boolean; goal: string } { return this.store.record('collaboration', this.role.agent_id) ?? { active: false, goal: '' } }
  setCollaboration(active: boolean, goal = ''): void { this.store.setRecord('collaboration', this.role.agent_id, { active, goal }); this.onChange() }
  private async steer(event: GatewayEvent): Promise<boolean> {
    if(!this.permitInput(event)||!this.allowsInput(event)){this.controls.suppress(event);this.store.setEventState(event.event_id,'processed');return true}
    const active = this.activeMain
    if (!active || !this.collaboration().active || !this.driver.steerMain) return false
    const key = `steer-${event.event_id}`
    active.steered.add(event.event_id)
    this.store.setRecord('main-delivery', event.event_id, key)
    this.store.setRecord('main-steer', event.event_id, { event_id: event.event_id, run_id: active.context.runId, admitted: false })
    const accepted = await this.driver.steerMain(event, this.origin(event), active.context.runId, key)
    if (!accepted) active.steered.delete(event.event_id)
    return accepted
  }

  private checkTask(event: GatewayEvent, id: string): SubagentTask {
    const task = this.store.task(id), origin = this.origin(event)
    if (!task || !task.origin || task.agent_id !== event.agent_id || !['continuation','topic'].includes(task.kind??'worker') && !this.sameScope(origin, task.origin)) throw new Error('Task is outside this conversation')
    return task
  }
  private pendingMessages(id: string): AgentMessage[] { return this.store.records<AgentMessage>('agent-message').filter(m => m.task_id === id && m.status === 'pending') }
  private async sendTaskMessage(event: GatewayEvent, runId: string, id: string, content: string, callId: string) {
    const task = this.checkTask(event, id)
    if (!['continuation','topic'].includes(task.kind??'worker') && task.state !== 'running') throw new Error('Task is not running')
    if (task.state === 'cancelled') throw new Error('Task is cancelled')
    const key = `agent-message-${hash(`${runId}:${callId}`)}`, now = new Date().toISOString()
    await this.gateway.ingest('internal', { agent_id: event.agent_id, event_id: key, source_kind: 'internal', platform: 'internal', account_id: event.agent_id,
      conversation_id: task.origin!.conversation_id, actor_id: event.agent_id, event_type: 'agent.message', timestamp: now, correlation_id: runId,
      task_id: id, subagent_id: task.subagent_id, content: [{ type: 'text', text: content }], visibility: 'internal', idempotency_key: key,
      metadata: { schedule: false, direction: 'main_to_branch', origin_event_id: event.event_id } }, (_stored, inserted) => {
        if (inserted) this.store.setRecord('agent-message', key, { id: key, event_id: key, task_id: id, content, from_run_id: runId, created_at: now, status: 'pending' } satisfies AgentMessage)
      })
    if (this.store.record<AgentMessage>('agent-message', key)?.status === 'accepted') return { task_id: id, message_id: key, status: 'accepted' }
    const current = this.store.task(id)!
    if (['continuation','topic'].includes(current.kind??'worker') && ['waiting','completed','failed'].includes(current.state)) {
      this.store.updateTask({ ...current, state: 'queued', activation: (current.activation ?? 0) + 1, updated_at: now })
      queueMicrotask(() => this.pump())
    } else if (current.state === 'running') await this.deliverMessages(current)
    this.onChange()
    return { task_id: id, message_id: key, status: this.store.record<AgentMessage>('agent-message', key)?.status ?? 'pending' }
  }
  private async deliverMessages(task: SubagentTask): Promise<void> {
    if (this.delivering.has(task.task_id)) return
    this.delivering.add(task.task_id)
    try {
      for (const message of this.pendingMessages(task.task_id)) {
        try { await this.driver.messageTask(task, message.content, message.id) }
        catch { break } // Keep durable pending messages when the child is still preparing or has just ended its turn.
        this.store.setRecord('agent-message', message.id, { ...message, status: 'accepted', accepted_at: new Date().toISOString() })
      }
    } finally { this.delivering.delete(task.task_id) }
  }
  async syncSelf(memoryId: string, sourceEventId: string | undefined, runId: string | undefined): Promise<void> {
    const event = sourceEventId ? this.store.event(sourceEventId)?.event : undefined
    if (!event || !runId) return
    for (const task of this.store.tasks({ agentId: this.role.agent_id, limit: 1000 }).filter(t => t.kind === 'continuation' && ['running','waiting','paused'].includes(t.state))) {
      await this.sendTaskMessage(event, runId, task.task_id, `Main已确认新的Self版本 ${memoryId}。这是Fork后的更新通知，请用memory_refresh主动阅读；不必因此对外发言。`, `self:${memoryId}:${task.task_id}`)
    }
  }
  controlTask(id: string, action: 'pause' | 'resume' | 'cancel'): void {
    if (action === 'cancel') { this.cancelTask(id); return }
    const task = this.store.task(id)
    if (!task || task.agent_id !== this.role.agent_id || !['continuation','topic'].includes(task.kind??'worker')) throw new Error('Only a persistent branch can pause or resume')
    if (action === 'pause') {
      this.store.updateTask({ ...task, state: 'paused', updated_at: new Date().toISOString() })
      this.workers.get(id)?.controller.abort(new Error('Continuation paused'))
    } else if (!['running','queued'].includes(task.state)) {
      this.store.updateTask({ ...task, state: 'queued', activation: (task.activation ?? 0) + 1, resume_note: 'Main决定继续此分支，先查看已有工作和新消息。', updated_at: new Date().toISOString() })
      queueMicrotask(() => this.pump())
    }
    this.onChange()
  }

  private origin(event: GatewayEvent): GatewayEvent {
    if (event.source_kind === 'qq-observation'||event.source_kind==='qq-debounce') {
      const source = this.store.event(String(event.metadata.origin_event_id))?.event
      if (!source || source.source_kind !== 'napcat' || source.agent_id !== event.agent_id || !this.sameScope(source,event)) throw new Error('Observation origin is invalid')
      if(this.permitInput(source))return source
      // A mixed batch can survive a later user block; never reply to the now-blocked last sender.
      const ids=Array.isArray(event.metadata.source_event_ids)?event.metadata.source_event_ids:[]
      for(const id of [...ids].reverse()){
        const candidate=typeof id==='string'?this.store.event(id)?.event:undefined
        if(candidate?.source_kind==='napcat'&&candidate.agent_id===event.agent_id&&this.sameScope(candidate,event)&&this.permitInput(candidate))return candidate
      }
      throw new Error('Observation has no permitted source')
    }
    if (event.source_kind === 'internal' && event.task_id) {
      const task = this.store.task(event.task_id)
      if (task?.origin && task.agent_id === event.agent_id && task.subagent_id === event.subagent_id) return task.origin
      throw new Error('Report origin is invalid')
    }
    return event
  }
  private sameScope(a: GatewayEvent, b: GatewayEvent): boolean {
    return a.platform === b.platform && a.account_id === b.account_id && a.conversation_id === b.conversation_id
  }
  channels(){return this.store.conversations().filter(c=>c.agent_id===this.role.agent_id).map(c=>({
    channel:c.platform==='web'?c.conversation_id:`${c.platform}:${c.conversation_id}`,name:c.title,
    target:{platform:c.platform,account_id:c.account_id,conversation_id:c.conversation_id},
  })).filter(channel=>this.permitChannel(channel.target))}
  authorize(event: GatewayEvent, target: OutputTarget,explicit=false): boolean {
    const origin = this.origin(event)
    if(explicit&&!this.sameScope(origin,{...origin,...target}))return this.permitChannel(target)&&!target.reply_to
    if (origin.platform === 'internal' || !this.sameScope(origin, { ...origin, ...target })) return false
    if (origin.platform === 'bilibili') {
      const comments = origin.content.filter(block => block.type === 'comment')
      return !!target.reply_to && comments.some(block => String(block.comment_id) === target.reply_to)
    }
    if (target.reply_to && origin.platform === 'qq') {
      return this.store.events({ agentId: event.agent_id, conversationId: origin.conversation_id, limit: 100 })
        .some(({ event: e }) => this.sameScope(origin, e) && String(e.metadata.message_id) === target.reply_to)
    }
    return true
  }

  private pump(): void {
    if (this.closed || !this.started || !this.controls.enabled || this.pumping) return
    this.pumping = true
    try {
      while (this.workers.size < this.limits.maxWorkers) {
        const blocked=this.store.tasks({agentId:this.role.agent_id,state:'queued',limit:10000}).filter(task=>task.origin&&!this.controls.scopeEnabled(task.origin)).map(task=>task.task_id)
        const task = this.store.claimTask([...this.workers.keys(),...blocked])
        if (!task) break
        const controller = new AbortController()
        const work = Promise.resolve().then(() => this.executeTask(task, controller.signal)).catch(error => {
          this.store.setRecord('error', task.task_id, { at: new Date().toISOString(), error: textError(error) })
        })
        this.workers.set(task.task_id, { controller, work })
        void work.finally(() => { this.workers.delete(task.task_id); this.onChange(); this.pump() })
      }
    } finally { this.pumping = false }
  }
  private async executeTask(task: SubagentTask, cancel: AbortSignal): Promise<void> {
    const signal = AbortSignal.any([cancel, this.lifetime.signal, AbortSignal.timeout(this.limits.taskTimeoutMs)])
    task = { ...task, error: undefined, archived_at: undefined }
    try {
      if (this.driver.prepare) { task = await this.driver.prepare(task, signal); this.store.updateTask(task); this.onChange() }
      task = { ...task, pending_messages: this.pendingMessages(task.task_id) }
      this.store.updateTask(task)
      const summary = await this.driver.task(task, (input, id) => this.report(task, input, id), signal, async () => {
        for (const message of task.pending_messages ?? []) this.store.setRecord('agent-message', message.id, { ...message, status: 'accepted', accepted_at: new Date().toISOString() })
        await this.deliverMessages(task)
      })
      signal.throwIfAborted()
      const terminal = this.store.reports(task.task_id).filter(r => (r.activation ?? 0) === (task.activation ?? 0) && (r.type === 'completed' || r.type === 'failed'))[0]
      if (['continuation','topic'].includes(task.kind??'worker') && !terminal) {
        this.store.updateTask({ ...task, state: 'waiting', updated_at: new Date().toISOString() })
        if (this.pendingMessages(task.task_id).length) this.controlTask(task.task_id, 'resume')
        this.onChange(); return
      }
      this.store.updateTask({ ...task, state: terminal?.type === 'failed' ? 'failed' : 'completed', updated_at: new Date().toISOString(),
        ...(terminal?.type === 'failed' ? { error: terminal.summary } : {}) })
      if (!terminal) await this.report(task, { type: 'completed', summary: summary || '任务执行结束。' }, 'final')
      if (['continuation','topic'].includes(task.kind??'worker') && this.pendingMessages(task.task_id).length) this.controlTask(task.task_id, 'resume')
    } catch (error) {
      if ((this.store.task(task.task_id)?.activation ?? 0) !== (task.activation ?? 0)) return
      if (this.store.task(task.task_id)?.state === 'paused') return
      if (this.lifetime.signal.aborted) {
        // Leave the interruption marker for startup's atomic failed-report recovery. Never rerun this work automatically.
        this.store.updateTask({ ...task, state: 'running', updated_at: new Date().toISOString(), error: 'Runtime interrupted' })
        return
      }
      const state = cancel.aborted ? 'cancelled' : 'failed'
      this.store.updateTask({ ...task, state, updated_at: new Date().toISOString(), error: textError(error) })
      if (!this.lifetime.signal.aborted) await this.report(task, { type: 'failed', summary: `${state}: ${textError(error)}` }, 'final-error')
    } finally {
      const current = this.store.task(task.task_id)
      if (!this.closed && current && !['queued','running'].includes(current.state)) await this.onTaskIdle(current)
    }
    this.onChange()
  }
  async report(task: SubagentTask, input: ReportInput, callId: string): Promise<{ report_id: string; persisted: boolean }> {
    const current = this.store.task(task.task_id)
    if (!current || current.subagent_id !== task.subagent_id || current.agent_id !== task.agent_id) throw new Error('Invalid task identity')
    if ((current.activation ?? 0) !== (task.activation ?? 0)) throw new Error('Stale task activation')
    const id = `report-${hash(`${task.task_id}:${task.activation ?? 0}:${callId}`)}`
    const now = new Date().toISOString()
    const ordinary = input.type === 'progress' || input.type === 'thought'
    // Retain all reports. Rate-limit from the last scheduled wake, so frequent suppressed progress cannot starve future updates.
    const lastWake = this.store.record<number>('report-wake', task.task_id)
    const schedule = task.origin&&isMemoryReview(task.origin) ? ['completed','failed','question'].includes(input.type)
      : !ordinary || lastWake === undefined || Date.now() - lastWake >= this.limits.progressIntervalMs
    let inserted = false
    const report = { ...input, priority: input.priority ?? 0, report_id: id, task_id: task.task_id, agent_id: task.agent_id,
      subagent_id: task.subagent_id, created_at: now, event_id: '', activation: task.activation ?? 0 }
    const raw: GatewayEventInput = { agent_id: task.agent_id, source_kind: 'internal', platform: 'internal', account_id: task.agent_id,
      conversation_id: task.origin?.conversation_id ?? `task:${task.task_id}`, actor_id: task.subagent_id, event_type: `task.${input.type}`,
      timestamp: now, correlation_id: task.parent_run_id ?? null, content: [{ ...report, report_type: report.type, type: 'report' }],
      metadata: { schedule }, visibility: 'internal', idempotency_key: id, task_id: task.task_id, subagent_id: task.subagent_id, report_id: id }
    await this.gateway.ingest('internal', raw, event => {
      report.event_id = event.event_id
      inserted = this.store.insertReport(report)
      if (inserted && ordinary && schedule) this.store.setRecord('report-wake', task.task_id, Date.now())
    })
    this.onChange()
    return { report_id: id, persisted: inserted || !!this.store.report(id) }
  }

  cancelTask(id: string): void {
    const task = this.store.task(id)
    if (!task) throw new Error('Task not found')
    this.workers.get(id)?.controller.abort(new Error('Task cancelled'))
    if (task.state === 'queued') this.store.updateTask({ ...task, state: 'cancelled', updated_at: new Date().toISOString() })
    this.onChange()
  }
  async stop(): Promise<void> {
    this.closed = true; this.scheduler.stop(); this.lifetime.abort(new Error('Runtime stopping'))
    await this.recovery?.stop()
    await this.driver.stop()
    await Promise.allSettled([...this.workers.values()].map(worker => worker.work))
    await this.scheduler.idle()
  }
  status() { return { role: this.role,enabled:this.controls.enabled, running_subagents: this.workers.size, events: this.store.counts(),
    current_run: this.store.runs().find(run => run.state === 'running') ?? null, collaboration: this.collaboration() } }
}
