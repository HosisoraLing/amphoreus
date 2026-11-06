/** Independent authenticated API/console. Normal chat principals see only their own Web conversations. */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import QRCode from 'qrcode'
import { ConsoleAuth } from './console-auth.ts'
import type { Configuration } from './config.ts'
import type { AmphoreusRuntime } from './runtime.ts'
import type { QQAdapter } from './qq.ts'
import { equalToken } from './qq.ts'
import { Blocks } from './dsh.ts'
import type { ActivityReader } from './activity.ts'
import { readChatActivity } from './chat-activity.ts'
import type { MemoryStore } from './memory.ts'
import type { Dreaming } from './dreaming.ts'
import type { MediaInput } from './media.ts'
import type { FooterReader } from './usage.ts'
import { QQControlInput } from './qq-control.ts'
import { BlocklistInput } from './blocklist.ts'
import { PeopleRequest,type PeopleService } from './people.ts'
import { TopicThreads,TopicRecall } from './topic-threads.ts'
import { OrganizerControl,type TopicOrganizer } from './topic-organizer.ts'
import { Recollection } from './recollection.ts'
import { ControlInput } from './control.ts'
import { aboutInfo } from './about.ts'
import { ModelInput, type ModelSettings } from './models.ts'
import type { MemeService } from './memes.ts'
import type { Telemetry } from './telemetry.ts'
import { createReadStream } from 'node:fs'
import html from './console.html?raw'
import script from './console.js?raw'
import css from './console.css?raw'
import fontCss from './misans.css?raw'

type Principal = Pick<Configuration['api']['tokens'][number], 'user' | 'role'>
class HttpError extends Error { constructor(readonly status: number, message: string) { super(message) } }
const json = (res: ServerResponse, status: number, value: unknown) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)) }
async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let size = 0
  for await (const chunk of req) { const data = Buffer.from(chunk); size += data.length; if (size > 256 * 1024) throw new HttpError(413, 'Request too large'); chunks.push(data) }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { throw new HttpError(400, 'JSON required') }
}
const Page = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), offset: z.coerce.number().int().min(0).max(1000000).default(0) })
const Chat = z.object({ conversation: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/), content: z.union([z.string().min(1).max(32000), Blocks]), idempotency_key: z.string().min(1).max(200) }).strict()

export class AmphoreusHttp {
  readonly server: Server
  private readonly clients = new Set<ServerResponse>()
  private readonly streamOwners = new Map<ServerResponse, IncomingMessage>()
  private readonly sessions = new Map<string, { principal: Principal; expires: number; multifactor?: boolean }>()
  private readonly auth: ConsoleAuth
  private readonly loginAttempts = new Map<string, { count: number; until: number }>()
  private readonly heartbeat: ReturnType<typeof setInterval>
  private readonly previousChange: () => void
  constructor(readonly runtime: AmphoreusRuntime, readonly config: Omit<Configuration['api'], 'secureCookies'> & { secureCookies?: boolean }, private readonly qq?: QQAdapter, private readonly readActivity?: ActivityReader, readonly memory?: MemoryStore, private readonly dreaming?: Dreaming, private readonly media?: Pick<MediaInput,'outputFile'> & Partial<Pick<MediaInput,'displayQuotes'>>, private readonly readFooter?: FooterReader,readonly people?:PeopleService,readonly models?:ModelSettings,readonly topicOrganizer?:TopicOrganizer,readonly telemetry?:Telemetry,readonly memes?:MemeService) {
    this.auth = new ConsoleAuth(runtime.store, config.tokens, runtime.role.agent_id)
    this.server = createServer((req, res) => { void this.handle(req, res) })
    this.server.requestTimeout = 30000; this.server.headersTimeout = 10000
    this.previousChange = runtime.onChange
    runtime.onChange = () => { this.previousChange(); this.notify() }
    this.heartbeat = setInterval(() => {
      for (const client of this.clients) {
        const request = this.streamOwners.get(client)
        if (request && !this.authenticate(request)) { client.end(); continue }
        if (!client.write(': heartbeat\n\n')) client.destroy()
      }
      for (const [id, session] of this.sessions) if (session.expires < Date.now()) this.sessions.delete(id)
      for (const [id, entry] of this.loginAttempts) if (entry.until < Date.now()) this.loginAttempts.delete(id)
    }, 15000); this.heartbeat.unref()
  }
  notify(): void { for (const client of this.clients) {
    const request = this.streamOwners.get(client)
    if (request && !this.authenticate(request)) { client.end(); continue }
    if (!client.write(`event: change\ndata: {}\n\n`)) client.destroy()
  } }
  private authenticate(req: IncomingMessage): Principal | undefined {
    const bearer = req.headers.authorization?.replace(/^Bearer /i, '')
    if (bearer) return this.config.tokens.find(p => equalToken(p.token, bearer))
    const id = /(?:^|;\s*)amphoreus_session=([a-f0-9]+)/.exec(req.headers.cookie ?? '')?.[1]
    const session = id && this.sessions.get(id)
    if (session && session.expires > Date.now() && this.config.tokens.some(identity => identity.user === session.principal.user && identity.role === session.principal.role) && (session.multifactor || !this.auth.enrolled(session.principal.user))) return session.principal
  }
  private cookie(res: ServerResponse, id: string, age: number): void {
    res.setHeader('set-cookie', `amphoreus_session=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}${this.config.secureCookies ? '; Secure' : ''}`)
  }
  private issue(res: ServerResponse, principal: Principal, multifactor = false): void {
    const id = randomBytes(32).toString('hex')
    this.sessions.set(id, { principal: { user: principal.user, role: principal.role }, expires: Date.now() + 12 * 3600000, multifactor })
    this.cookie(res, id, 43200)
  }
  private limitLogin(req: IncomingMessage, user?: string): void {
    const now = Date.now(), keys = [`ip:${req.socket.remoteAddress ?? 'unknown'}`, ...(user ? [`user:${user}`] : [])]
    for (const [id, value] of this.loginAttempts) if (value.until <= now) this.loginAttempts.delete(id)
    if (this.loginAttempts.size > 10000) throw new HttpError(429, 'Too many login attempts')
    for (const key of keys) { const value = this.loginAttempts.get(key); if (value && value.until > now && value.count >= (key.startsWith('ip:') ? 20 : 10)) throw new HttpError(429, 'Too many login attempts') }
    for (const key of keys) { const value = this.loginAttempts.get(key); this.loginAttempts.set(key, { count: (value?.count ?? 0) + 1, until: value?.until ?? now + 60000 }) }
  }
  private scope(principal: Principal, conversation: string): boolean { return principal.role === 'admin' || conversation.startsWith(`web:${principal.user}:`) }
  private admin(principal: Principal): void { if (principal.role !== 'admin') throw new HttpError(403, 'Administrator required') }
  /** The optional principal is supplied only by the authenticated Harness owner route. */
  async handle(req: IncomingMessage, res: ServerResponse, harnessOwner?: Principal): Promise<void> {
    res.setHeader('x-content-type-options', 'nosniff'); res.setHeader('referrer-policy', 'no-referrer')
    res.setHeader('content-security-policy', `default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self' https://cdn-file.hyperos.mi.com; img-src 'self' data: https: http:; media-src 'self' https: http:; connect-src 'self'; frame-ancestors '${harnessOwner ? 'self' : 'none'}'; base-uri 'none'; form-action 'self'`)
    try {
      if (!harnessOwner && !this.config.allowedHosts.includes(req.headers.host ?? '')) throw new HttpError(403, 'Host denied')
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (harnessOwner) url.pathname = url.pathname.slice('/amphoreus'.length) || '/'
      else if (url.pathname === '/console' || url.pathname.startsWith('/console/')) url.pathname = url.pathname.slice('/console'.length) || '/'
      const method = req.method ?? 'GET'
      if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}` && req.headers.origin !== `https://${req.headers.host}`) throw new HttpError(403, 'Origin denied')
      if (method === 'GET' && ['/', '/console.js', '/console.css', '/misans.css', '/favicon.ico'].includes(url.pathname)) {
        if (url.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return }
        const asset = url.pathname === '/' ? [harnessOwner ? html.replace('<body>', '<body class="embedded">') : html.replace('href="misans.css"', 'href="/console/misans.css"').replace('href="console.css"', 'href="/console/console.css"').replace('src="console.js"', 'src="/console/console.js"'), 'text/html'] : url.pathname.endsWith('.js') ? [script, 'text/javascript'] : [url.pathname === '/misans.css' ? fontCss : css, 'text/css']
        res.writeHead(200, { 'content-type': `${asset[1]}; charset=utf-8`, 'cache-control': 'no-store' }); res.end(asset[0]); return
      }
      if (harnessOwner && (['/api/login', '/api/logout'].includes(url.pathname) || url.pathname.startsWith('/api/auth/'))) throw new HttpError(404, 'Use Harness authentication')
      if (url.pathname === '/api/auth/info' && method === 'GET') { json(res, 200, { password_totp: true, secure: !!this.config.secureCookies, enrollment: true }); return }
      if ((url.pathname === '/api/login' || url.pathname.startsWith('/api/auth/')) && method === 'POST') {
        if (req.headers['x-amphoreus-request'] !== '1') throw new HttpError(403, 'Request header required')
        this.limitLogin(req)
        if (url.pathname === '/api/login') {
          const input = z.object({ token: z.string().max(500) }).strict().parse(await body(req))
          const principal = this.config.tokens.find(p => equalToken(p.token, input.token))
          if (!principal || this.auth.enrolled(principal.user)) throw new HttpError(401, 'Use password and authenticator, or check your access token')
          this.issue(res, principal); json(res, 200, { user: principal.user, role: principal.role }); return
        }
        if (url.pathname === '/api/auth/enroll') {
          const input = z.object({ token: z.string().min(1).max(500), password: z.string().min(12).max(256) }).strict().parse(await body(req))
          const result = await this.auth.begin(input.token, input.password, 'Amphoreus')
          if (!result) throw new HttpError(401, 'Enrollment unavailable or access token invalid')
          const qr = await QRCode.toDataURL(result.uri, { errorCorrectionLevel: 'M', width: 240, margin: 2 })
          json(res, 200, { ...result, qr }); return
        }
        if (url.pathname === '/api/auth/confirm') {
          const input = z.object({ challenge: z.string().regex(/^[a-f0-9]{64}$/), code: z.string().regex(/^\d{6}$/) }).strict().parse(await body(req))
          const result = this.auth.confirm(input.challenge, input.code)
          if (!result) throw new HttpError(401, 'Invalid or expired verification')
          for (const [id, session] of this.sessions) if (session.principal.user === result.user) this.sessions.delete(id)
          this.issue(res, result, true); json(res, 200, result); return
        }
        if (url.pathname === '/api/auth/login' || url.pathname === '/api/auth/reset') {
          const input = z.object({ user: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/), password: z.string().min(1).max(256), code: z.string().min(6).max(40) }).strict().parse(await body(req))
          this.limitLogin(req, input.user)
          const result = url.pathname.endsWith('/reset') ? await this.auth.reset(input.user, input.password, input.code) : await this.auth.login(input.user, input.password, input.code)
          if (!result) throw new HttpError(401, 'Account, password or verification code invalid')
          if (url.pathname.endsWith('/reset')) {
            for (const [id, session] of this.sessions) if (session.principal.user === result.user) this.sessions.delete(id)
            this.cookie(res, '', 0); json(res, 200, { reset: true }); return
          }
          this.issue(res, result, true); json(res, 200, result); return
        }
        throw new HttpError(404, 'Unknown authentication endpoint')
      }
      const principal = harnessOwner ?? this.authenticate(req)
      if (!principal) throw new HttpError(401, 'Authentication required')
      if (!['GET', 'HEAD'].includes(method) && req.headers['x-amphoreus-request'] !== '1') throw new HttpError(403, 'Request header required')
      if (method === 'POST' && url.pathname !== '/api/messages') this.telemetry?.operation('management',url.pathname,'requested')
      const { limit, offset } = Page.parse(Object.fromEntries(url.searchParams))
      const { store } = this.runtime
      if(url.pathname==='/api/about'&&method==='GET'){json(res,200,aboutInfo());return}
      if(url.pathname.startsWith('/api/memes')){
        this.admin(principal);if(!this.memes)throw new HttpError(503,'表情图库暂不可用')
        if(url.pathname==='/api/memes'&&method==='GET'){json(res,200,this.memes.view(url.searchParams.get('q')??'',url.searchParams.get('tag')??'',url.searchParams.get('pack')??''));return}
        const image=/^\/api\/memes\/image\/([a-f0-9]{24})$/.exec(url.pathname)
        if(image&&method==='GET'){const result=await this.memes.image(image[1]!,true);res.writeHead(200,{'content-type':result.mime,'cache-control':'private, no-store'});res.end(result.bytes);return}
        if(url.pathname==='/api/memes/message'&&method==='POST'){
          const input=z.object({id:z.string().regex(/^[a-f0-9]{24}$/),idempotency_key:z.string().min(1).max(200)}).strict().parse(await body(req))
          const image=await this.memes.image(input.id),attachment=await this.memes.ctx.attachments.saveFile({data:image.bytes,name:image.item.path.split(/[\\/]/).pop()!})
          const result=await this.runtime.receiveWeb(principal.user,'chat',[{type:'image',attachment,name:attachment.name,media_type:image.mime}],input.idempotency_key)
          json(res,202,{event_id:result.event.event_id});return
        }
        if(['/api/memes/manage','/api/memes/remote','/api/memes/export'].includes(url.pathname)){await this.memes.handle(req,res,url.pathname.split('/').pop() as 'manage'|'remote'|'export');this.runtime.onChange();return}
        throw new HttpError(404,'图库接口不存在')
      }
      if (['/api/statistics','/api/statistics/settings','/api/logs'].includes(url.pathname)) {
        this.admin(principal)
        if (!this.telemetry) throw new HttpError(503, '统计服务暂不可用')
        if (url.pathname === '/api/statistics/settings') {
          if (method === 'GET') { json(res,200,this.telemetry.settings()); return }
          if (method === 'POST') { json(res,200,this.telemetry.configure(await body(req))); this.runtime.onChange(); return }
        } else if (method === 'GET') {
          const input = z.object({ since:z.iso.datetime().optional(), until:z.iso.datetime().optional(), scope:z.enum(['all','main','subagents','worker','continuation','topic','organizer','meme']).optional(),
            session:z.string().max(300).optional(), level:z.enum(['info','warn','error']).optional(), kind:z.string().max(80).optional(), search:z.string().max(300).optional(),
            before:z.coerce.number().int().positive().optional(), limit:z.coerce.number().int().min(1).max(200).optional() }).parse(Object.fromEntries(url.searchParams))
          if (input.since && input.until && input.since >= input.until) throw new HttpError(400,'结束时间必须晚于开始时间')
          json(res,200,url.pathname==='/api/logs'?this.telemetry.logs(input):this.telemetry.statistics(input));return
        }
      }
      if(url.pathname==='/api/models'){
        this.admin(principal)
        if(!this.models)throw new HttpError(409,'模型设置尚未启用')
        try{
          if(method==='GET'){
            const taskId=url.searchParams.get('task_id')??undefined
            const state=await this.models.status(taskId)
            json(res,200,{...state,...(url.searchParams.get('catalog')==='1'?{catalog:await this.models.catalog()}:{})});return
          }
          if(method==='POST'){
            const input=ModelInput.parse(await body(req))
            await this.models.configure(input)
            this.runtime.onChange()
            json(res,200,await this.models.status(input.task_id));return
          }
        }catch(error){if(error instanceof z.ZodError)throw error;throw new HttpError(400,'模型设置失败，请检查提供方、模型及任务作用域')}
      }
      if(url.pathname==='/api/control'){
        this.admin(principal)
        if(method==='GET'){json(res,200,this.runtime.controls.status());return}
        if(method==='POST'){
          const input=ControlInput.parse(await body(req))
          try{this.runtime.controls.configure(input)}catch(error){if(error instanceof z.ZodError)throw error;throw new HttpError(400,error instanceof Error?error.message:'开关设置失败')}
          json(res,200,this.runtime.controls.status());return
        }
      }
      if(url.pathname==='/api/people'){
        this.admin(principal)
        if(!this.people)throw new HttpError(409,'人物关系库尚未启用')
        if(method==='GET'){json(res,200,this.people.admin('people_list',{query:url.searchParams.get('query')??'',offset,limit:Math.min(limit,30)},principal.user));return}
        if(method==='POST'){
          const input=PeopleRequest.parse(await body(req))
          try{json(res,200,this.people.admin(input.tool,input.args,principal.user))}catch(error){if(error instanceof z.ZodError)throw error;throw new HttpError(400,error instanceof Error?error.message:'人物关系操作失败')}
          return
        }
      }
      const outputMedia=/^\/api\/output-media\/([^/]+)\/(\d+)$/.exec(url.pathname)
      if(outputMedia&&(method==='GET'||method==='HEAD')){
        const output=store.output(outputMedia[1]!),block=output?.content[Number(outputMedia[2])]
        if(!output||output.platform!=='web'||output.status!=='sent'||!block?.attachment||!this.media)throw new HttpError(404,'Attachment not found')
        if(principal.role!=='admin'&&(output.target.account_id!==principal.user||!this.scope(principal,output.target.conversation_id)))throw new HttpError(403,'Attachment denied')
        const file=await this.media.outputFile(block);let start=0,end=file.bytes-1
        if(req.headers.range){
          const match=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range)
          if(!match||(!match[1]&&!match[2]))throw new HttpError(416,'Invalid byte range')
          start=match[1]?Number(match[1]):Math.max(0,file.bytes-Number(match[2]));end=match[1]&&match[2]?Math.min(Number(match[2]),end):end
          if(start>end||start>=file.bytes)throw new HttpError(416,'Invalid byte range')
          res.setHeader('content-range',`bytes ${start}-${end}/${file.bytes}`)
        }
        res.writeHead(req.headers.range?206:200,{'content-type':file.mediaType,'content-length':Math.max(0,end-start+1),'accept-ranges':'bytes',
          'cache-control':'private, max-age=300','content-disposition':`${block.type==='file'?'attachment':'inline'}; filename*=UTF-8''${encodeURIComponent(file.name)}`})
        if(method==='HEAD'||!file.bytes){res.end();return}
        createReadStream(file.path,{start,end}).on('error',()=>res.destroy()).pipe(res);return
      }
      if(url.pathname==='/api/user-blacklist'){
        this.admin(principal)
        if(!this.qq?.blocklist)throw new HttpError(409,'QQ blacklist is unavailable')
        if(method==='GET'){json(res,200,this.qq.blocklist.configure({action:'list'}));return}
        if(method==='POST'){json(res,200,this.qq.blocklist.configure(BlocklistInput.parse(await body(req))));return}
      }
      if(url.pathname==='/api/qq-message-control'){
        this.admin(principal)
        if(!this.qq?.control)throw new HttpError(409,'QQ message control is unavailable')
        if(method==='GET'){json(res,200,this.qq.control.status());return}
        if(method==='POST'){json(res,200,this.qq.control.configure(QQControlInput.parse(await body(req))));return}
      }
      if (url.pathname === '/api/participation') {
        if(principal.role!=='admin')throw new HttpError(403,'Administrator required')
        if(!this.qq?.presence)throw new HttpError(409,'QQ participation is unavailable')
        if(method==='GET'){json(res,200,this.qq.presence.status());return}
        if(method==='POST'){
          const input=z.object({group:z.string().optional(),settings:z.unknown()}).strict().parse(await body(req))
          json(res,200,this.qq.presence.configure(input.settings,input.group));return
        }
      }
      if (url.pathname === '/api/logout' && method === 'POST') {
        const id = /(?:^|;\s*)amphoreus_session=([a-f0-9]+)/.exec(req.headers.cookie ?? '')?.[1]
        if (id) this.sessions.delete(id)
        this.cookie(res, '', 0); json(res, 200, { logged_out: true }); return
      }
      if (url.pathname === '/api/me' && method === 'GET') { json(res, 200, { user: principal.user, role: principal.role }); return }
      if (url.pathname === '/api/stream' && method === 'GET') {
        if (this.clients.size >= 64) throw new HttpError(429, 'Too many streams')
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
        res.write('event: ready\ndata: {}\n\n'); this.clients.add(res); if (!harnessOwner) this.streamOwners.set(res, req)
        const expiry = setTimeout(() => res.end(), 3600000); expiry.unref()
        res.on('close', () => { this.clients.delete(res); this.streamOwners.delete(res); clearTimeout(expiry) }); return
      }
      if (url.pathname === '/api/status' && method === 'GET') {
        const state = this.runtime.status()
        json(res, 200, principal.role === 'admin' ? { ...state, role: { agent_id: state.role.agent_id, name: state.role.name },
          adapters: [{ platform: 'web', state: 'connected' }, this.qq?.status() ?? { platform: 'qq', state: 'disabled' }, { platform: 'bilibili', state: 'deferred' }],
          errors: [...store.records('error'),...store.records<{state:string;error?:string;output_id:string}>('output-recovery').filter(item=>item.state==='mail-failed'), ...store.unresolvedFailures(this.runtime.role.agent_id),
            ...store.outputs(20).filter(output => output.status === 'failed' || output.status === 'unknown')].slice(0, 20) }
          : { role: { agent_id: state.role.agent_id, name: state.role.name } }); return
      }
      if (url.pathname === '/api/conversations' && method === 'GET') {
        json(res, 200, store.conversations().filter(c => this.scope(principal, String(c.conversation_id))).slice(offset, offset + limit)); return
      }
      if (url.pathname === '/api/messages' && method === 'GET') {
        const wakes = new Map<string, import('./store.ts').MainRun | null>()
        const conversationId = url.searchParams.get('conversation') || undefined
        if (principal.role !== 'admin' && conversationId && !this.scope(principal, conversationId)) throw new HttpError(403, 'Conversation denied')
        const sourceKind = url.searchParams.get('source') || undefined
        const platform = url.searchParams.get('platform') || undefined
        const rows=store.events({ agentId: this.runtime.role.agent_id, conversationId, sourceKind, limit, offset,
          ...(platform ? { platform } : {}),
          ...(principal.role !== 'admin' ? { platform: 'web', accountId: principal.user } : {}) })
          .filter(row => principal.role === 'admin' || row.event.platform === 'web' && row.event.account_id === principal.user && row.event.visibility !== 'internal')
        json(res,200,await Promise.all(rows.map(async row=>{
          const content=await this.media?.displayQuotes?.(row.event)??row.event.content
          return { ...row,wake: (()=>{const run=store.eventWake(row.event,wakes);return run?{id:run.run_id,started_at:run.started_at,state:run.state}:null})(),event:{...row.event,content:row.event.source_kind==='output-gateway'&&row.event.platform==='web'?content.map((block,index)=>block.attachment?
            {...block,url:`${harnessOwner?'/amphoreus':''}/api/output-media/${row.event.event_id}/${index}`}:block):content},
            observation: row.event.source_kind==='napcat'&&row.event.metadata.message_type==='group' ? this.qq?.presence?.delivery(row.event) : undefined,
            resolution: principal.role === 'admin' ? store.failure(row.event.event_id)?.resolution ?? null : null,
            outputs: [store.output(row.event.event_id)].filter((output):output is NonNullable<typeof output>=>!!output).map(output=>({...output,recovery:store.record('output-recovery',output.output_id)})),
            receipt: store.record('receipt', row.event.event_id) ?? null }
        }))); return
      }
      if (url.pathname === '/api/chat-footer' && method === 'GET') {
        this.admin(principal)
        const run = store.runs(1).find(run => run.agent_id === this.runtime.role.agent_id)
        if (!run || !this.readFooter) { json(res,200,{available:false,source:'dsh-session-projections'}); return }
        try { json(res,200,await this.readFooter(run.session_id)) }
        catch { json(res,200,{available:false,source:'dsh-session-projections',unavailable_reason:'native_projection_unavailable'}) }
        return
      }
      if (url.pathname === '/api/chat-activity' && method === 'GET') {
        this.admin(principal)
        const ids = z.array(z.string().min(1).max(300)).max(100).parse(url.searchParams.getAll('event'))
        const before = url.searchParams.has('before') ? z.coerce.number().int().positive().parse(url.searchParams.get('before')) : undefined
        const allowed = ids.filter(id => store.event(id)?.event.agent_id === this.runtime.role.agent_id)
        json(res, 200, this.memory ? readChatActivity(this.memory, allowed, before, this.config.tokens.map(p => p.token)) : { items: [], has_more: false, next_cursor: null }); return
      }
      if (url.pathname === '/api/messages' && method === 'POST') {
        const input = Chat.parse(await body(req))
        const result = await this.runtime.receiveWeb(principal.user, input.conversation, typeof input.content === 'string' ? [{ type: 'text', text: input.content }] : input.content, input.idempotency_key)
        json(res, 202, { event_id: result.event.event_id, inserted: result.inserted, status: result.event.metadata.control_suppressed?'archived':'queued' }); return
      }
      const taskRoute = /^\/api\/tasks\/([^/]+)(\/activity)?$/.exec(url.pathname)
      if (taskRoute && method === 'GET') {
        const task = store.task(decodeURIComponent(taskRoute[1]!))
        if (!task || task.agent_id !== this.runtime.role.agent_id) throw new HttpError(404, 'Task not found')
        if (principal.role !== 'admin' && !(task.origin?.platform === 'web' && task.origin.account_id === principal.user && this.scope(principal, task.origin.conversation_id))) throw new HttpError(403, 'Task denied')
        if (taskRoute[2]) {
          json(res, 200, this.readActivity ? await this.readActivity(task, offset, limit) : { items: [], end_offset: offset, has_more: false, available: false })
        } else json(res, 200, { task, parent_run: task.parent_run_id ? store.run(task.parent_run_id) ?? null : null,
          reports: store.reports(task.task_id, limit, offset), messages: store.records<{ task_id: string; created_at: string }>('agent-message').filter(m => m.task_id === task.task_id).slice(-100) })
        return
      }
      if (url.pathname === '/api/tasks' && method === 'GET') {
        const conversationId = url.searchParams.get('conversation') || undefined
        if (principal.role !== 'admin' && conversationId && !this.scope(principal, conversationId)) throw new HttpError(403, 'Task denied')
        json(res, 200, store.tasks({ agentId: this.runtime.role.agent_id, conversationId, limit, offset,
          ...(principal.role !== 'admin' ? { accountId: principal.user } : {}) })); return
      }
      this.admin(principal)
      if(url.pathname==='/api/topic-organizer'){
        if(!this.topicOrganizer)throw new HttpError(503,'Topic organizer unavailable')
        if(method==='GET'){json(res,200,this.topicOrganizer.status());return}
        if(method==='POST'){json(res,200,this.topicOrganizer.configure(OrganizerControl.parse(await body(req))));return}
      }
      if(url.pathname==='/api/topics'&&method==='GET'){
        if(!this.memory)throw new HttpError(503,'Memory unavailable')
        json(res,200,{items:new Recollection(this.memory).topics(limit,offset)});return
      }
      const topicPath=/^\/api\/topics\/([^/]+)$/.exec(url.pathname)
      if(topicPath&&method==='GET'){
        if(!this.memory)throw new HttpError(503,'Memory unavailable')
        const input=TopicRecall.parse({id:decodeURIComponent(topicPath[1]!),include_original:url.searchParams.get('include_original')==='true',
          offset,limit:Math.min(20,limit),text_offset:Number(url.searchParams.get('text_offset')??0),size:Number(url.searchParams.get('size')??4000)})
        json(res,200,new TopicThreads(this.memory).recall(input));return
      }
      if (url.pathname === '/api/dreaming' && this.dreaming) {
        if (method === 'GET') { json(res, 200, this.dreaming.status()); return }
        if (method === 'POST') {
          const input = z.object({ idempotency_key: z.string().min(1).max(200), job_id:z.string().min(1).max(200).optional(),action:z.enum(['review','resume']).default('review'),
            backfill:z.object({from:z.number().int().min(0),to:z.number().int().positive()}).strict().optional() }).strict().parse(await body(req))
          if(input.backfill&&input.job_id||input.action==='resume'&&!input.job_id)throw new HttpError(400,'恢复需要job_id，回填与恢复不能同时请求')
          const job = input.backfill?await this.dreaming.backfill(input.backfill.from,input.backfill.to,input.idempotency_key):input.job_id?(input.action==='resume'?this.dreaming.resume(input.job_id):await this.dreaming.reviewReady(input.job_id,input.idempotency_key)):await this.dreaming.schedule(true, input.idempotency_key); json(res, 202, { job: job ?? null }); return
        }
      }
      const review = /^\/api\/memory\/([^/]+)\/review$/.exec(url.pathname)
      if (review && method === 'POST') {
        const record = this.memory?.get(decodeURIComponent(review[1]!))
        if (!record) throw new HttpError(404, 'Memory not found')
        const input = z.object({ feedback: z.string().max(8000).default('请亲自审阅，决定是否采用或修订。'), idempotency_key: z.string().min(1).max(200) }).strict().parse(await body(req))
        const result = await this.runtime.receiveWeb(principal.user, 'chat', [{ type: 'text', text: `请审阅记忆 ${record.id}（${record.kind}：${record.title}）。${input.feedback}正式日记和Self请由你亲自决定并确认。` }], input.idempotency_key)
        json(res, 202, { event_id: result.event.event_id, status: 'queued' }); return
      }
      if (url.pathname === '/api/collaboration' && method === 'POST') {
        const input = z.object({ active: z.boolean(), goal: z.string().max(4000).default('') }).strict().parse(await body(req))
        this.runtime.setCollaboration(input.active, input.goal); json(res, 200, this.runtime.collaboration()); return
      }
      if (url.pathname.startsWith('/api/memory') && method === 'GET') {
        if (!this.memory) throw new HttpError(503, 'Memory is not initialized')
        if (url.pathname === '/api/memory/stats') { json(res, 200, { counts: this.memory.counts(), policy: this.memory.settings, distribution: this.memory.distribution(), current_self: this.memory.find({ kind: 'self', status: 'confirmed', limit: 1 })[0] ?? null }); return }
        if (url.pathname === '/api/memory') {
          const query = z.object({ query: z.string().max(500).optional(), kind: z.string().optional(), branch: z.string().optional(), status: z.string().optional(),
            since: z.string().optional(), until: z.string().optional(), historical: z.enum(['true','false']).optional(), order: z.enum(['recent']).optional() }).parse(Object.fromEntries([...url.searchParams].filter(([key]) => !['limit','offset'].includes(key))))
          json(res, 200, this.memory.summaries({ ...query, historical: query.historical === 'true', limit, offset })); return
        }
        const id = /^\/api\/memory\/([^/]+)$/.exec(url.pathname)
        if (id) { const key = decodeURIComponent(id[1]!); if (!this.memory.get(key)) throw new HttpError(404, 'Memory not found'); json(res, 200, { ...this.memory.read(key, offset, z.coerce.number().int().min(200).max(12000).default(4000).parse(url.searchParams.get('size') ?? undefined)), related: this.memory.related(key) }); return }
      }
      if (url.pathname === '/api/reports' && method === 'GET') { json(res, 200, store.reports(url.searchParams.get('task') || undefined, limit, offset)); return }
      if (url.pathname === '/api/runs' && method === 'GET') { json(res, 200, store.runs(limit, offset).map(run => ({ ...run, resolution: store.failure(run.event_id)?.resolution ?? null }))); return }
      if (url.pathname === '/api/outputs' && method === 'GET') { json(res, 200, store.outputs(limit, offset).map(output=>({...output,recovery:store.record('output-recovery',output.output_id)}))); return }
      if (url.pathname === '/api/adapters' && method === 'GET') { json(res, 200, [{ platform: 'web', state: 'connected' }, this.qq?.status() ?? { platform: 'qq', state: 'disabled' }, { platform: 'bilibili', state: 'deferred' }]); return }
      const cancel = /^\/api\/tasks\/([^/]+)\/cancel$/.exec(url.pathname)
      if (cancel && method === 'POST') { this.runtime.cancelTask(decodeURIComponent(cancel[1]!)); json(res, 200, { cancelled: true }); return }
      const control = /^\/api\/tasks\/([^/]+)\/(pause|resume)$/.exec(url.pathname)
      if (control && method === 'POST') { this.runtime.controlTask(decodeURIComponent(control[1]!), control[2] as 'pause' | 'resume'); json(res, 200, { accepted: true }); return }
      const retry = /^\/api\/events\/([^/]+)\/retry$/.exec(url.pathname)
      if (retry && method === 'POST') { this.runtime.scheduler.retry(decodeURIComponent(retry[1]!)); json(res, 200, { queued: true }); return }
      const resolve = /^\/api\/events\/([^/]+)\/resolve$/.exec(url.pathname)
      if (resolve && method === 'POST') {
        const id = decodeURIComponent(resolve[1]!)
        if (store.event(id)?.event.agent_id !== this.runtime.role.agent_id) throw new HttpError(404, 'Event not found')
        const input = z.object({ fingerprint: z.string().min(1).max(8000), note: z.string().trim().min(1).max(2000) }).strict().parse(await body(req))
        if (!store.resolveFailure(id, input.fingerprint, input.note, principal.user)) throw new HttpError(409, 'Failure changed; refresh before marking it handled')
        this.runtime.onChange(); json(res, 200, { resolved: true }); return
      }
      throw new HttpError(404, 'Unknown endpoint')
    } catch (error) {
      if (res.headersSent) { res.end(); return }
      const status = error instanceof HttpError ? error.status : error instanceof z.ZodError ? 400 : 500
      if (status >= 500) { try { this.telemetry?.operation('runtime','http','failed','管理 API 操作失败，未记录请求正文或凭证。') } catch { /* Never hide the original response when logging is unavailable. */ } }
      json(res, status, { error: error instanceof HttpError ? error.message : error instanceof z.ZodError ? 'Invalid request' : 'Operation failed' })
    }
  }
  async listen(): Promise<void> { await new Promise<void>((resolve, reject) => { this.server.once('error', reject); this.server.listen(this.config.port, this.config.host, resolve) }) }
  async stop(): Promise<void> {
    clearInterval(this.heartbeat); this.runtime.onChange = this.previousChange
    for (const client of this.clients) client.end()
    this.clients.clear(); this.sessions.clear()
    await new Promise<void>(resolve => { this.server.close(() => resolve()); this.server.closeIdleConnections() })
  }
}
