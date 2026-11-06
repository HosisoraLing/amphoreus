/** NapCat OneBot v11 forward/reverse WS, with correlated receipts and bounded reconnects. */
import WebSocket, { WebSocketServer } from 'ws'
import type { IncomingMessage, Server } from 'node:http'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import type { AmphoreusRuntime } from './runtime.ts'
import type { ContentBlock, GatewayEventInput } from './model.ts'
import type { OutputAdapter, OutputTarget } from './gateway.ts'
import { cardPreview } from './forward-preview.ts'
import type { GroupParticipation } from './participation.ts'
import type { QQControl } from './qq-control.ts'
import type { UserBlocklist } from './blocklist.ts'
import type { OutputRecord } from './store.ts'
import { realpath,readFile,stat } from 'node:fs/promises'
import { basename,isAbsolute,relative,resolve } from 'node:path'

export const QQConfig = z.object({ enabled: z.boolean().default(false), accountId: z.string().default(''),
  direction: z.enum(['forward', 'reverse']).default('forward'), wsUrl: z.string().default('ws://napcat:3001'),
  token: z.string().min(16), allowedUsers: z.array(z.string()).default([]), allowedGroups: z.array(z.string()).default([]),
  groupTrigger: z.enum(['mention', 'all', 'keywords', 'off']).default('mention'), keywords: z.array(z.string().min(1)).default([]),
  activeReply: z.object({ enabled: z.boolean().default(true), probability: z.number().min(0).max(1).default(.02),
    cooldownMs: z.number().int().min(0).max(86400000).default(120000) }).strict().prefault({}),
  receiveEnabled: z.boolean().default(true), observeOnly: z.boolean().default(false), requestTimeoutMs: z.number().int().min(100).max(60000).default(10000),
  reconnectMs: z.number().int().min(50).max(60000).default(1000), heartbeatMs: z.number().int().min(100).max(120000).default(30000),
}).strict()
export type QQSettings = z.infer<typeof QQConfig>
const ID = z.union([z.string().min(1), z.number().int().safe()]).transform(String)
const Segment = z.object({ type: z.string(), data: z.record(z.string(), z.unknown()) }).passthrough()
const Message = z.object({ post_type: z.literal('message'), self_id: ID, user_id: ID, message_id: ID, time: z.number(),
  message_type: z.enum(['private', 'group']), group_id: ID.optional(), message: z.union([z.array(Segment), z.string()]),
  sender: z.object({ nickname: z.string().optional(), card: z.string().optional(), user_id: ID.optional() }).passthrough().optional(),
}).passthrough()
export const equalToken = (a: string, b: string): boolean => {
  const left = Buffer.from(a), right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}
export function safeMedia(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return undefined
    // Media is displayed by the user's browser or fetched by NapCat; never accept local file/data/javascript schemes.
    return url.href
  } catch { return undefined }
}
const decode = (s: string) => s.replace(/&#91;/g, '[').replace(/&#93;/g, ']').replace(/&#44;/g, ',').replace(/&amp;/g, '&')
function segments(message: z.infer<typeof Message>['message']): z.infer<typeof Segment>[] {
  if (typeof message !== 'string') return message
  const result: z.infer<typeof Segment>[] = []; let end = 0
  for (const match of message.matchAll(/\[CQ:([a-zA-Z_]+)((?:,[^\]]*)?)\]/g)) {
    if (match.index! > end) result.push({ type: 'text', data: { text: decode(message.slice(end, match.index)) } })
    const data = Object.fromEntries((match[2] ?? '').split(',').filter(Boolean).map(field => { const at = field.indexOf('='); return [field.slice(0, at), decode(field.slice(at + 1))] }))
    result.push({ type: match[1]!, data }); end = match.index! + match[0].length
  }
  if (end < message.length) result.push({ type: 'text', data: { text: decode(message.slice(end)) } })
  return result
}
export function qqBlocks(message: z.infer<typeof Message>['message']): ContentBlock[] {
  return segments(message).map(({ type, data }) => {
    if (type === 'text') return { type: 'text', text: String(data.text ?? '') }
    if (type === 'at') return { type: 'mention', actor_id: String(data.qq ?? ''), platform: 'qq', ...(typeof data.name === 'string' ? { display_name: data.name } : {}) }
    if (type === 'reply') return { type: 'quote', message_id: String(data.id ?? ''), platform: 'qq' }
    if (type === 'forward') {
      const fields = data.native_preview && typeof data.native_preview === 'object' && !Array.isArray(data.native_preview) ? data.native_preview as Record<string, unknown> : {}
      const native = cardPreview([{ multiForwardMsgElement: fields, arkElement: { bytesData: data.native_card } }])
      return { type: 'forward', platform: 'qq', forward_id: String(data.id ?? ''), title: native?.title ?? data.source ?? data.title,
        preview: native?.preview ?? data.news ?? data.preview, summary: native?.summary ?? data.summary, count: native?.count ?? data.count, original: data }
    }
    if (type === 'json') {
      try {
        const card = JSON.parse(String(data.data ?? '')), detail = card.meta?.detail
        if (card.app === 'com.tencent.multimsg' && detail) return { type: 'forward', platform: 'qq', forward_id: String(detail.resid ?? ''),
          title: detail.source, preview: detail.news, summary: detail.summary, count: card.extra?.tsum, original: data }
        return { type: 'platform', platform: 'qq', platform_type: type, title: String(card.prompt || card.desc || '卡片'), data }
      } catch { return { type: 'platform', platform: 'qq', platform_type: type, title: '卡片', data } }
    }
    if (type === 'face') return { type: 'emoji', emoji_id: String(data.id ?? ''), platform: 'qq' }
    if (['image', 'record', 'video', 'file'].includes(type)) return { type: type === 'record' ? 'audio' : type,
      url: safeMedia(data.url), name: data.name ?? data.file, size: data.file_size, platform: 'qq', original: data }
    return { type: 'platform', platform: 'qq', platform_type: type, data }
  })
}
function outbound(content: ContentBlock[], reply?: string) {
  const result: { type: string; data: Record<string, unknown> }[] = []
  if (reply) result.push({ type: 'reply', data: { id: reply } })
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') result.push({ type: 'text', data: { text: block.text } })
    else if (block.type === 'mention' && /^\d+$/.test(String(block.actor_id))) result.push({ type: 'at', data: { qq: String(block.actor_id) } })
    else if (block.type === 'emoji' && /^\d+$/.test(String(block.emoji_id))) result.push({ type: 'face', data: { id: String(block.emoji_id) } })
    else if (['image', 'audio', 'video','file'].includes(block.type) && (safeMedia(block.url)||typeof block.transport_file==='string')) result.push({ type: block.type === 'audio' ? 'record' : block.type,
      data: { file: block.transport_file??safeMedia(block.url),...(block.name?{name:block.name}:{}) } })
    else if (block.type === 'quote' && /^-?\d+$/.test(String(block.message_id))) result.push({ type: 'reply', data: { id: String(block.message_id) } })
    else throw new OneBotRejected(`不支持的发送内容：${block.type}`)
  }
  return result
}
class OneBotRejected extends Error {}
export class QQAdapter implements OutputAdapter {
  groupConversations(){return [...this.groups].map(([id,title])=>({platform:'qq',account_id:this.config.accountId,conversation_id:`group:${id}`,title}))}
  presence?: GroupParticipation
  control?: QQControl
  blocklist?:UserBlocklist
  readonly platform = 'qq'
  private socket?: WebSocket
  private reconnect?: ReturnType<typeof setTimeout>
  private heartbeat?: ReturnType<typeof setInterval>
  private stopped = false
  private attempts = 0
  private lastPong = Date.now()
  private reverse?: WebSocketServer
  private pending = new Map<string, { resolve: (data: Record<string, unknown>) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private release: (() => void)[] = []
  private groups = new Map<string, string>()
  private state = 'disconnected'
  private lastError = ''
  private lastEvent?: string
  constructor(private readonly runtime: AmphoreusRuntime, readonly config: QQSettings,private readonly mediaRoots:string[]=[],
    private readonly attachmentPath?:(block:ContentBlock)=>string|undefined) {
    if (config.enabled && !config.accountId) throw new Error('QQ accountId is required')
    this.release.push(runtime.gateway.registerInput({ kind: 'napcat', platform: 'qq', normalize: raw => this.normalize(raw) }), runtime.gateway.registerOutput(this))
  }
  status() { return { platform: this.platform, enabled: this.config.enabled, direction: this.config.direction, state: this.state,
    account_id: this.config.accountId, receive_enabled: this.config.receiveEnabled, observe_only: this.config.observeOnly, last_event: this.lastEvent, error: this.lastError } }
  private changed(state: string, error = '') { this.state = state; this.lastError = error; this.runtime.onChange() }
  start(server?: Server): void {
    if (!this.config.enabled) { this.changed('disabled'); return }
    if (this.config.direction === 'forward') { this.connect(); return }
    if (!server) throw new Error('Reverse WS requires the API HTTP server')
    this.reverse = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 })
    const upgrade = (req: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const token = req.headers.authorization?.replace(/^Bearer /i, '') ?? url.searchParams.get('access_token') ?? ''
      if (url.pathname !== '/onebot' || !equalToken(token, this.config.token) || String(req.headers['x-self-id'] ?? '') !== this.config.accountId) {
        socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return
      }
      this.reverse!.handleUpgrade(req, socket, head, ws => {
        if (this.socket) this.socket.terminate()
        this.attach(ws)
      })
    }
    server.on('upgrade', upgrade); this.release.push(() => server.off('upgrade', upgrade))
    this.changed('listening')
  }
  private connect(): void {
    if (this.stopped) return
    this.changed('connecting')
    const url = new URL(this.config.wsUrl)
    if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid OneBot WS URL')
    const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${this.config.token}` }, handshakeTimeout: this.config.requestTimeoutMs,
      maxPayload: 2 * 1024 * 1024 })
    socket.once('open', () => this.attach(socket))
    socket.on('error', () => this.changed('error', 'OneBot connection failed'))
    socket.once('close', () => { if (this.socket !== socket) this.retry() })
  }
  private retry(): void {
    if (this.stopped || this.config.direction !== 'forward' || this.reconnect) return
    this.reconnect = setTimeout(() => { this.reconnect = undefined; this.connect() }, Math.min(30000, this.config.reconnectMs * 2 ** Math.min(this.attempts++, 5)))
    this.reconnect.unref()
  }
  private attach(socket: WebSocket): void {
    this.socket = socket; this.attempts = 0; this.lastPong = Date.now()
    this.changed('authenticating')
    socket.on('pong', () => { this.lastPong = Date.now() })
    socket.on('message', data => {
      let raw: Record<string, unknown>
      try { raw = JSON.parse(data.toString()) as Record<string, unknown>; if (!raw || typeof raw !== 'object') return }
      catch { this.changed('error', 'Malformed OneBot frame'); return }
      if (raw.echo) {
        const pending = this.pending.get(String(raw.echo))
        if (!pending) return
        clearTimeout(pending.timer); this.pending.delete(String(raw.echo))
        if (raw.status === 'ok' && Number(raw.retcode) === 0) pending.resolve((raw.data ?? {}) as Record<string, unknown>)
        else pending.reject(new OneBotRejected(`OneBot rejected action (${Number(raw.retcode) || 'error'})`))
      } else if (raw.post_type === 'meta_event') this.lastPong = Date.now()
      else if (raw.post_type === 'message') void this.receive(raw).catch(() => this.changed('error', 'OneBot event rejected'))
    })
    socket.once('close', () => {
      if (this.socket !== socket) return
      clearInterval(this.heartbeat); this.socket = undefined
      for (const call of this.pending.values()) { clearTimeout(call.timer); call.reject(new Error('OneBot disconnected; outcome unknown')) }
      this.pending.clear(); this.changed('disconnected'); this.retry()
    })
    this.heartbeat = setInterval(() => {
      if (Date.now() - this.lastPong > this.config.heartbeatMs * 2) { socket.terminate(); return }
      socket.ping()
    }, this.config.heartbeatMs); this.heartbeat.unref()
    void this.request('get_login_info', {}).then(data => {
      if (String(data.user_id) !== this.config.accountId) { this.changed('error', 'OneBot account mismatch'); socket.terminate(); return }
      if (this.socket === socket) this.changed('connected')
    }).catch(() => { this.changed('error', 'OneBot identity check failed'); socket.terminate() })
  }
  async request(action: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new OneBotRejected('OneBot is disconnected')
    const echo = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(echo); reject(new Error('OneBot request timed out; outcome unknown')) }, this.config.requestTimeoutMs)
      timer.unref(); this.pending.set(echo, { resolve, reject, timer })
      socket.send(JSON.stringify({ action, params, echo }), error => { if (error) { clearTimeout(timer); this.pending.delete(echo); reject(new Error('OneBot send failed; outcome unknown')) } })
    })
  }
  private allowed(value: string, allow: string[]): boolean { return allow.includes('*') || allow.includes(value) }
  private normalize(raw: unknown): GatewayEventInput {
    const event = Message.parse(raw)
    if (event.self_id !== this.config.accountId || event.user_id === event.self_id) throw new Error('Invalid OneBot sender')
    const group = event.message_type === 'group'
    if (group && !event.group_id) throw new Error('Missing group ID')
    if (!this.allowed(group ? event.group_id! : event.user_id, group ? this.config.allowedGroups : this.config.allowedUsers)) throw new Error('Conversation is not allowed')
    const conversation=`${group?'group':'private'}:${group?event.group_id:event.user_id}`
    const policy=this.control?.settings(conversation)
    const blocked=this.blocklist?.blocked(event.user_id)===true
    const receiving=!blocked&&policy?.receiveEnabled!==false
    const debouncing=receiving&&policy?.debounceEnabled===true&&!this.config.observeOnly&&(!group||this.config.groupTrigger!=='off')
    const blocks = qqBlocks(event.message)
    const mentioned = blocks.some(b => b.type === 'mention' && b.actor_id === event.self_id)
    const named = blocks.some(b => b.type === 'text' && this.config.keywords.some(word => String(b.text).includes(word)))
    const direct = mentioned || named
    const cooldown = this.runtime.store.record<number>('qq-active-wake', `${event.self_id}:${event.group_id}`) ?? 0
    // AstrBot's possibility_reply gate runs before the LLM; all messages remain in the archive/context.
    const proactive = !this.presence && group && !direct && this.config.groupTrigger === 'all' && this.config.activeReply.enabled
      && Date.now() - cooldown >= this.config.activeReply.cooldownMs && Math.random() < this.config.activeReply.probability
    const trigger = !group || this.config.groupTrigger === 'all' && (direct || proactive) || this.config.groupTrigger === 'mention' && mentioned
      || this.config.groupTrigger === 'keywords' && named
    return { agent_id: this.runtime.role.agent_id, source_kind: 'napcat', platform: 'qq', account_id: event.self_id,
      conversation_id: `${group ? 'group' : 'private'}:${group ? event.group_id : event.user_id}`, actor_id: event.user_id, event_type: 'message',
      timestamp: new Date(event.time * 1000).toISOString(), correlation_id: null, content: blocks,
      metadata: { message_id: event.message_id, message_type: event.message_type, nickname: event.sender?.card || event.sender?.nickname || event.user_id,
        avatar: `https://q1.qlogo.cn/g?b=qq&nk=${encodeURIComponent(event.user_id)}&s=100`, group_id: event.group_id,
        group_name: event.group_id ? this.groups.get(event.group_id) ?? event.group_id : undefined, proactive,
        bot: event.sender?.is_bot === true,user_blocked:blocked,qq_receive_enabled:receiving,qq_debounce:debouncing,
        participation: receiving&&!debouncing&&!!this.presence && group && this.config.groupTrigger !== 'off' && !this.config.observeOnly,
        schedule: receiving&&!debouncing&&trigger && !this.config.observeOnly && !(this.presence && group) },
      visibility: group ? 'public' : 'private', idempotency_key: `${event.message_type}:${event.message_id}` }
  }
  async receive(raw: unknown): Promise<void> {
    if (!this.config.receiveEnabled) return
    const event = Message.parse(raw)
    if (event.self_id !== this.config.accountId || event.user_id === event.self_id || this.state !== 'connected') return
    if (!this.allowed(event.message_type === 'group' ? event.group_id ?? '' : event.user_id,
      event.message_type === 'group' ? this.config.allowedGroups : this.config.allowedUsers)) return
    if (event.group_id && !this.groups.has(event.group_id)) {
      this.groups.set(event.group_id, event.group_id)
      // Enrichment must not delay durable message acceptance.
      void this.request('get_group_info', { group_id: event.group_id }).then(data => { this.groups.set(event.group_id!, String(data.group_name ?? event.group_id)) }).catch(() => {})
    }
    const result = await this.runtime.gateway.ingest('napcat', raw)
    if (result.inserted && result.event.metadata.proactive && result.event.metadata.schedule) {
      this.runtime.store.setRecord('qq-active-wake', `${event.self_id}:${event.group_id}`, Date.now())
    }
    this.lastEvent = new Date().toISOString(); this.runtime.onChange()
  }
  async send(input: { target: OutputTarget; content: ContentBlock[]; idempotency_key: string }) {
    if (this.config.observeOnly || input.target.account_id !== this.config.accountId || this.state !== 'connected') return 'failed' as const
    const match = /^(group|private):(\d+)$/.exec(input.target.conversation_id)
    if (!match || !this.allowed(match[2]!, match[1] === 'group' ? this.config.allowedGroups : this.config.allowedUsers)) return 'failed' as const
    let attempted=false
    try {
      const blocks:ContentBlock[]=[]
      for(const original of input.content){
        const {transport_file:_transport,...block}=original
        if(!['image','audio','video','file'].includes(block.type)||safeMedia(block.url)){blocks.push(block);continue}
        const path=typeof block.path==='string'?block.path:typeof block.url==='string'&&isAbsolute(block.url)?block.url:this.attachmentPath?.(block)
        if(!path)throw new OneBotRejected('多模态内容缺少地址或文件路径')
        const actual=await realpath(path)
        let allowed=false
        for(const root of this.mediaRoots){
          try{const base=await realpath(resolve(root)),child=relative(base,actual);if(child&&!child.startsWith('..')&&!isAbsolute(child))allowed=true}catch{}
        }
        if(!allowed)throw new OneBotRejected('附件不在已授权的工作区或附件目录')
        const info=await stat(actual)
        if(!info.isFile()||info.size>50*1024*1024)throw new OneBotRejected('附件必须是50MB以内的文件')
        blocks.push({...block,transport_file:`base64://${(await readFile(actual)).toString('base64')}`,name:block.name??basename(actual)})
      }
      attempted=true
      const data = await this.request(match[1] === 'group' ? 'send_group_msg' : 'send_private_msg', {
        [match[1] === 'group' ? 'group_id' : 'user_id']: match[2], message: outbound(blocks, input.target.reply_to), auto_escape: false })
      if (data.message_id === undefined) return 'unknown' as const
      return { status: 'sent' as const, receipt: { message_id: String(data.message_id), account_id: this.config.accountId } }
    } catch (error) { return !attempted||error instanceof OneBotRejected ? 'failed' as const : 'unknown' as const }
  }
  async inspect(output:OutputRecord):Promise<{status:'sent'|'unknown';receipt?:Record<string,unknown>}>{
    if(this.state!=='connected'||output.target.account_id!==this.config.accountId)return {status:'unknown'}
    const saved=this.runtime.store.record<{message_id:string}>('receipt',output.output_id)
    if(saved?.message_id){
      const message=await this.request('get_msg',{message_id:saved.message_id})
      const sender=message.sender as Record<string,unknown>|undefined
      if(String(sender?.user_id)===this.config.accountId)return {status:'sent',receipt:saved}
    }
    // Text/mentions/emoji have stable wire values. Media URLs change after upload, so absence is never proof of failure.
    if(output.content.some(block=>!['text','mention','emoji','quote'].includes(block.type)))return {status:'unknown'}
    const match=/^(group|private):(\d+)$/.exec(output.target.conversation_id)
    if(!match)return {status:'unknown'}
    const history=await this.request(match[1]==='group'?'get_group_msg_history':'get_friend_msg_history',{
      [match[1]==='group'?'group_id':'user_id']:match[2],count:20})
    const project=(blocks:ContentBlock[])=>blocks.filter(b=>b.type!=='quote').map(b=>b.type==='text'?['text',String(b.text)]:b.type==='mention'?['mention',String(b.actor_id)]:['emoji',String(b.emoji_id)])
    const wanted=JSON.stringify(project(output.content)),request=this.runtime.store.event(output.event_id)?.event
    const since=Date.parse(request?.timestamp??output.updated_at)/1000
    const messages=(Array.isArray(history.messages)?history.messages:[]) as Record<string,unknown>[]
    const found=messages.filter(message=>{
      const sender=message.sender as Record<string,unknown>|undefined
      return String(sender?.user_id??message.user_id)===this.config.accountId&&Number(message.time)>=since-2
        &&Array.isArray(message.message)&&JSON.stringify(project(qqBlocks(message.message as never)))===wanted
    })
    return found.length===1&&found[0]!.message_id!==undefined?{status:'sent',receipt:{message_id:String(found[0]!.message_id),account_id:this.config.accountId}}:{status:'unknown'}
  }
  async stop(): Promise<void> {
    this.stopped = true; clearTimeout(this.reconnect); clearInterval(this.heartbeat)
    this.socket?.terminate(); this.reverse?.close()
    for (const call of this.pending.values()) { clearTimeout(call.timer); call.reject(new Error('Adapter stopped')) }
    this.pending.clear(); for (const dispose of this.release.reverse()) dispose()
    this.changed('stopped')
  }
}
