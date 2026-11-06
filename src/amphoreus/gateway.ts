import { normalizeEvent, type ContentBlock, type GatewayEvent, type GatewayEventInput } from './model.ts'
import { AmphoreusStore, type OutputRecord } from './store.ts'

export interface InputAdapter {
  readonly kind: string
  readonly platform: string
  normalize(raw: unknown): GatewayEventInput | Promise<GatewayEventInput>
}

export interface OutputTarget {
  platform: string
  account_id: string
  conversation_id: string
  reply_to?: string
}

export interface OutputAdapter {
  readonly platform: string
  send(input: { target: OutputTarget; content: ContentBlock[]; idempotency_key: string }): Promise<'sent' | 'failed' | 'unknown' | { status: 'sent' | 'failed' | 'unknown'; receipt?: Record<string, unknown> }>
  inspect?(output:OutputRecord):Promise<{status:'sent'|'failed'|'unknown';receipt?:Record<string,unknown>}>
}

/** Adapter registry and durable platform-independent message ingress and egress. */
export class MessageGateway {
  canReceive:(event:GatewayEvent)=>boolean=()=>true
  canSend:(target:OutputTarget)=>boolean=()=>true
  onOutput:(output:OutputRecord)=>void=()=>{}
  prepareOutput:(content:ContentBlock[],target:OutputTarget)=>Promise<ContentBlock[]>=async content=>content
  private readonly inputs = new Map<string, InputAdapter>()
  private readonly outputs = new Map<string, OutputAdapter>()

  constructor(private readonly store: AmphoreusStore, private readonly now = () => new Date(),
    private readonly onEvent: (event: GatewayEvent) => void = () => {}) {}

  registerInput(adapter: InputAdapter): () => void {
    if (this.inputs.has(adapter.kind)) throw new Error(`Input adapter already registered: ${adapter.kind}`)
    this.inputs.set(adapter.kind, adapter)
    return () => { if (this.inputs.get(adapter.kind) === adapter) this.inputs.delete(adapter.kind) }
  }

  registerOutput(adapter: OutputAdapter): () => void {
    if (this.outputs.has(adapter.platform)) throw new Error(`Output adapter already registered: ${adapter.platform}`)
    this.outputs.set(adapter.platform, adapter)
    return () => { if (this.outputs.get(adapter.platform) === adapter) this.outputs.delete(adapter.platform) }
  }

  /** Normalizes and persists one adapter event; source identity must match the registered adapter. */
  async ingest(kind: string, raw: unknown, persist: (event: GatewayEvent, inserted: boolean) => void = () => {}): Promise<{ event: GatewayEvent; inserted: boolean }> {
    const adapter = this.inputs.get(kind)
    if (!adapter) throw new Error(`Input adapter not registered: ${kind}`)
    const input = await adapter.normalize(raw)
    if (input.source_kind !== adapter.kind || input.platform !== adapter.platform) throw new Error('Adapter returned a mismatched source identity')
    const event = normalizeEvent({ ...input, idempotency_key: JSON.stringify([input.agent_id, kind, input.platform, input.account_id, input.conversation_id, input.idempotency_key]) }, this.now())
    if(!this.canReceive(event))event.metadata={...event.metadata,schedule:false,control_suppressed:true}
    const inserted = this.store.atomic(() => {
      const inserted = this.store.insertEvent(event)
      if (inserted && event.metadata.schedule === false) this.store.setEventState(event.event_id, 'processed')
      persist(event, inserted)
      return inserted
    })
    if (inserted && event.metadata.schedule !== false) this.onEvent(event)
    return { event, inserted }
  }

  /** Queues and delivers one public message. Authorization is checked before persistence and before platform I/O. */
  async speak(input: { agentId: string; runId: string; callId: string; target: OutputTarget; content: ContentBlock[]; sourceEventId?: string;explicitTarget?:boolean },
    authorize: (target: OutputTarget) => boolean): Promise<OutputRecord> {
    if (!authorize(input.target)) throw new Error('Output target is not authorized for this event. To reply to the current message, omit target; do not guess it from history.')
    if(!this.canSend(input.target))throw new Error('角色或此消息渠道已关闭，未发送。')
    const idempotencyKey = `speak:${input.agentId}:${input.runId}:${input.callId}`
    const event = normalizeEvent({
      agent_id: input.agentId,
      source_kind: 'output-gateway',
      platform: input.target.platform,
      account_id: input.target.account_id,
      conversation_id: input.target.conversation_id,
      actor_id: input.agentId,
      event_type: 'output.requested',
      timestamp: this.now().toISOString(),
      correlation_id: input.runId,
      content: input.content,
      metadata: { ...(input.target.reply_to ? { reply_to: input.target.reply_to } : {}), ...(input.sourceEventId ? { origin_event_id: input.sourceEventId } : {}),...(input.explicitTarget?{explicit_target:true}:{}) },
      visibility: input.target.conversation_id.startsWith('group:') || input.target.platform === 'bilibili' ? 'public' : 'private',
      idempotency_key: idempotencyKey,
    }, this.now())
    const { platform: _platform, ...target } = input.target
    const output = { output_id: event.event_id, event_id: event.event_id, platform: input.target.platform,
      target, content: event.content, status: 'pending' as const, updated_at: this.now().toISOString(), error: '' }
    this.store.atomic(() => {
      this.store.insertEvent(event)
      this.store.setEventState(event.event_id, 'processed')
      this.store.insertOutput(output)
    })
    return this.dispatchOutput(output.output_id, authorize)
  }

  /** Dispatches pending outputs only. A sending record left by a crash is marked unknown during startup, never resent. */
  async dispatchOutput(id: string, authorize: (target: OutputTarget) => boolean): Promise<OutputRecord> {
    const output = this.store.output(id)
    if (!output) throw new Error(`Output not found: ${id}`)
    if (output.status !== 'pending') return output
    const target = { ...output.target, platform: output.platform }
    if(!this.canSend(target))return output
    if (!authorize(target)) {
      this.store.setOutput(id, 'failed', this.now().toISOString(), 'Output target is no longer authorized')
      const result=this.store.output(id)!;this.onOutput(result);return result
    }
    const adapter = this.outputs.get(output.platform)
    if (!adapter) {this.onOutput(output);return output}
    this.store.setOutput(id, 'sending', this.now().toISOString())
    let content:ContentBlock[]
    try{content=await this.prepareOutput(output.content,target);this.store.setOutputContent(id,content)}
    catch{this.store.setOutput(id,'failed',this.now().toISOString(),'输出附件准备失败');const failed=this.store.output(id)!;this.onOutput(failed);return failed}
    try {
      if(!this.canSend(target)){this.store.setOutput(id,'pending',this.now().toISOString());return this.store.output(id)!}
      const result = await adapter.send({ target, content, idempotency_key: output.output_id })
      const status = typeof result === 'string' ? result : result.status
      if (typeof result === 'object' && result.receipt) this.store.setRecord('receipt', id, result.receipt)
      this.store.setOutput(id, status, this.now().toISOString(), status === 'failed' ? 'Platform rejected the message' : '')
    } catch (error) {
      this.store.setOutput(id, 'unknown', this.now().toISOString(), error instanceof Error ? error.message : String(error))
    }
    const result=this.store.output(id)!
    this.onOutput(result)
    return result
  }
  async retryOutput(id:string,authorize:(target:OutputTarget)=>boolean):Promise<OutputRecord>{
    this.store.atomic(()=>{
      const output=this.store.output(id)
      if(output?.status==='failed')this.store.setOutput(id,'pending',this.now().toISOString())
    })
    return this.dispatchOutput(id,authorize)
  }
  async verifyOutput(id:string):Promise<OutputRecord>{
    const output=this.store.output(id)
    if(!output)throw new Error('Output not found')
    if(output.status!=='unknown')return output
    try{
      const result=await this.outputs.get(output.platform)?.inspect?.(output)
      if(result?.receipt)this.store.setRecord('receipt',id,result.receipt)
      if(result&&result.status!=='unknown')this.store.setOutput(id,result.status,this.now().toISOString(),result.status==='failed'?'平台确认未发送':'')
    }catch{/* Preserve uncertainty; escalation owns the diagnostic path. */}
    return this.store.output(id)!
  }
}
