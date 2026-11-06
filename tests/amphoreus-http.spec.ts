import { mkdtempSync, rmSync, readFileSync,writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { JSDOM } from 'jsdom'
import { afterEach, expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import { AmphoreusStore } from '../src/amphoreus/store.ts'
import { AmphoreusRuntime } from '../src/amphoreus/runtime.ts'
import { Telemetry } from '../src/amphoreus/telemetry.ts'
import { AmphoreusHttp } from '../src/amphoreus/http.ts'
import { ModelSettings } from '../src/amphoreus/models.ts'
import type { ActivityReader } from '../src/amphoreus/activity.ts'
import { totp } from '../src/amphoreus/console-auth.ts'
import { MemoryStore, MemorySettings } from '../src/amphoreus/memory.ts'
import { registerHarnessPanel } from '../src/amphoreus/harness.ts'
import type { MediaInput } from '../src/amphoreus/media.ts'
import { QQControl } from '../src/amphoreus/qq-control.ts'
import { UserBlocklist } from '../src/amphoreus/blocklist.ts'
import { PeopleService } from '../src/amphoreus/people.ts'
import { TopicOrganizer } from '../src/amphoreus/topic-organizer.ts'
import { Recollection } from '../src/amphoreus/recollection.ts'
// Vitest otherwise strips CSS imports; production bundles this asset as raw text.
vi.mock('../src/amphoreus/misans.css?raw',async()=>({default:(await import('node:fs')).readFileSync(new URL('../src/amphoreus/misans.css',import.meta.url),'utf8')}))
const stops: (() => Promise<void>)[] = []
afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop() })
const admin = 'a'.repeat(40), alice = 'b'.repeat(40), bob = 'c'.repeat(40)
async function setup(readActivity?: ActivityReader, secureOrMedia: boolean | Pick<MediaInput,'outputFile'> = false, footer?: import('../src/amphoreus/usage.ts').FooterReader) {
  const secureCookies = typeof secureOrMedia === 'boolean' ? secureOrMedia : false
  const media = typeof secureOrMedia === 'boolean' ? undefined : secureOrMedia
  const dir = mkdtempSync(join(tmpdir(), 'amphoreus-http-')), host = new Store(join(dir, 'db.sqlite')), store = new AmphoreusStore(host)
  const runtime = new AmphoreusRuntime(store, { main: async context => { if (context.event.platform === 'web') await context.speak([{ type: 'text', text: 'Hi' }], 'speak') },
    task: async () => '', messageTask: async () => {}, stop: async () => {} }, { agent_id: 'role', name: 'role', persona: 'private persona' },
    { maxWorkers: 3, mainTimeoutMs: 1000, taskTimeoutMs: 1000, progressIntervalMs: 60000 })
  const config = { secureCookies, host: '127.0.0.1', port: 0, allowedHosts: [] as string[], tokens: [{ token: admin, user: 'admin', role: 'admin' as const }, { token: alice, user: 'alice', role: 'chat' as const }, { token: bob, user: 'bob', role: 'chat' as const }] }
  const memory = new MemoryStore(host, runtime.role.agent_id, MemorySettings.parse({ reasoning: { allowedProviders: ['approved'] } }))
  const control=new QQControl(runtime,'123')
  runtime.controls.qqAccount='123';runtime.controls.qqEnabled=id=>control.settings(id).receiveEnabled;runtime.controls.qqOverride=id=>control.override(id);runtime.controls.setQQ=(id,enabled)=>control.setReceiving(id,enabled)
  const people=new PeopleService(join(dir,'people.sqlite'),'role',[],['admin'])
  const organizer=new TopicOrganizer(memory,store,async()=>{throw Error('No real model in tests')})
  const api = new AmphoreusHttp(runtime, config, {control,blocklist:new UserBlocklist(store,'role','123'),status:()=>({state:'disconnected'})} as never, readActivity, memory, undefined, media, footer,people,undefined,organizer,new Telemetry(memory,store)); await api.listen()
  const port = (api.server.address() as import('node:net').AddressInfo).port
  config.allowedHosts.push(`127.0.0.1:${port}`)
  const url = `http://127.0.0.1:${port}`
  stops.push(async () => { await organizer.stop(); await control.stop(); await api.stop(); await runtime.stop(); people.close(); host.close(); rmSync(dir, { recursive: true }) })
  await runtime.start(); await runtime.scheduler.idle()
  const request = async (path: string, token = '', data?: unknown, headers = {}) => {
    const res = await fetch(url + path, { method: data === undefined ? 'GET' : 'POST', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'x-amphoreus-request': '1', 'content-type': 'application/json', ...headers }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) })
    return { res, data: res.headers.get('content-type')?.includes('application/json') ? await res.json() as any : await res.text() }
  }
  return { runtime, store, request, url, api, memory }
}

it('serves MiSans subsets before login on standalone and root routes while keeping styles restricted to this origin',async()=>{
 const {url}=await setup()
 const html=await (await fetch(url+'/console/')).text()
 expect(html).toContain('href="/console/misans.css"')
 for(const path of ['/misans.css','/console/misans.css']){
  const response=await fetch(url+path),css=await response.text()
  expect(response.status).toBe(200);expect(response.headers.get('content-type')).toContain('text/css')
  expect(response.headers.get('content-security-policy')).toContain("font-src 'self' https://cdn-file.hyperos.mi.com")
  expect(response.headers.get('content-security-policy')).toContain("style-src 'self'")
  expect(css).toContain('font-family: MiSans VF');expect(css).toContain('font-weight: 1 999');expect(css).toContain('unicode-range:');expect(css).not.toContain('format("truetype")')
 }
})

it('protects model routing with owner authentication, CSRF and validated task scopes',async()=>{
 const {request,api,runtime,store,url}=await setup()
 const ctx={llm:{listProviders:()=>[{id:'safe'}],resolveCallConfig:async(selection:any)=>{if(selection.model==='bad')throw new Error('secret-key');return selection}},get:()=>({currentSelection:()=>({provider:'safe',model:'default'})}),sessionController:{modelCatalog:async()=>({default:{provider:'safe',model:'default'},groups:[],failures:[]})}}
 ;(api as any).models=new ModelSettings(ctx as never,store,runtime.role.agent_id,{main:null,worker:null})
 expect((await request('/api/models')).res.status).toBe(401)
 expect((await request('/api/models',alice)).res.status).toBe(403)
 expect((await request('/api/models',alice,{scope:'main',selection:null})).res.status).toBe(403)
 expect((await fetch(url+'/api/models',{method:'POST',headers:{Authorization:`Bearer ${admin}`,'content-type':'application/json'},body:JSON.stringify({scope:'main',selection:null})})).status).toBe(403)
 expect((await request('/api/models',admin,{scope:'main',selection:{provider:'safe',model:'one'}})).data.roles.main.effective.model).toBe('one')
 expect((await request('/api/models?catalog=1',admin)).data.catalog).toHaveProperty('groups')
 expect((await request('/api/models',admin,{scope:'main',selection:{provider:'safe',model:'bad'}})).res.status).toBe(400)
 expect(JSON.stringify((await request('/api/models',admin,{scope:'main',selection:{provider:'safe',model:'bad'}})).data)).not.toContain('secret-key')
 expect((await request('/api/models',admin,{scope:'main',task_id:'missing',selection:null})).res.status).toBe(400)
 expect((await request('/api/models',admin,{scope:'main',selection:null})).data.roles.main.effective.model).toBe('default')
})

it('keeps administration alive with the master off and restricts hierarchical switch changes to the owner',async()=>{
 const {request,runtime,store,url}=await setup()
 expect((await request('/api/control')).res.status).toBe(401)
 expect((await request('/api/control',alice)).res.status).toBe(403)
 expect((await request('/api/control',alice,{enabled:false})).res.status).toBe(403)
 expect((await fetch(url+'/api/control',{method:'POST',headers:{Authorization:`Bearer ${admin}`,'content-type':'application/json'},body:JSON.stringify({enabled:false})})).status).toBe(403)
 expect((await request('/api/control',admin,{platform:'qq',account_id:'wrong',conversation_id:'group:777',enabled:false})).res.status).toBe(400)
 expect((await request('/api/control',admin,{enabled:false})).data.enabled).toBe(false)
 expect((await request('/api/status',admin)).res.status).toBe(200)
 const result=await request('/api/messages',admin,{conversation:'chat',content:'暂停时仍可保存',idempotency_key:'off-message'})
 expect(store.event(result.data.event_id)?.event.metadata.control_suppressed).toBe(true)
 expect((await request('/api/control',admin,{platform:'qq',account_id:'123',conversation_id:'group:777',enabled:false})).res.status).toBe(200)
 const state=(await request('/api/control',admin)).data
 expect(state.channels.find((c:any)=>c.platform==='qq').conversations).toMatchObject([{conversation_id:'group:777',enabled:false}])
 expect(runtime.controls.enabled).toBe(false)
})

it('serves software notices to authenticated readers without exposing runtime settings or private role context',async()=>{
 const {request}=await setup()
 expect((await request('/api/about')).res.status).toBe(401)
 const response=await request('/api/about',alice)
 expect(response.res.status).toBe(200)
 expect(response.data.components.some((item:any)=>item.name==='zod'&&item.license==='MIT')).toBe(true)
 expect(response.data.components.find((item:any)=>item.name==='NapCatQQ').license).toContain('Limited Redistribution')
 expect(JSON.stringify(response.data)).not.toContain('private persona')
 expect(response.data).not.toHaveProperty('controls');expect(response.data).not.toHaveProperty('tokens')
})

it('restricts relationship administration to owners and retains real evidence in the original people schema',async()=>{
 const {request}=await setup()
 expect((await request('/api/people')).res.status).toBe(401)
 expect((await request('/api/people',alice)).res.status).toBe(403)
 expect((await request('/api/people',alice,{tool:'people_get',args:{identity:'qq:55500001'}})).res.status).toBe(403)
 expect((await request('/api/people',admin,{tool:'people_get',args:{identity:'qq:nickname'}})).res.status).toBe(400)
 expect((await request('/api/people',admin,{tool:'people_get',args:{identity:'qq:55500001'}})).res.status).toBe(200)
 expect((await request('/api/people',admin,{tool:'people_note',args:{identity:'qq:55500001',key:'喜好',body:'海边',evidence:'明确自述'}})).res.status).toBe(200)
 const result=await request('/api/people?query=55500001',admin)
 expect(result.data.people[0].impressions[0]).toMatchObject({key:'喜好',body:'海边',evidence:'明确自述',origin_ref:'web:admin:admin'})
})

it('keeps topic originals opt-in and organizer controls owner-only, disabled by default',async()=>{
 const {request,memory}=await setup()
 const source=memory.put({kind:'input',title:'原话',text:'do not leak in summary',created_at:memory.now(),source:{platform:'web',actor_id:'alice'}})
 const topic=new Recollection(memory).memorize({kind:'topic',title:'话题串',content:'summary only',source_ids:[source.id],importance:.4},{branch:'main',source:{session_id:'main'},call_id:'topic'})
 expect((await request('/api/topic-organizer',alice)).res.status).toBe(403)
 expect((await request('/api/topic-organizer',admin)).data.settings.enabled).toBe(false)
 expect((await request('/api/topic-organizer',admin,{enabled:true,intervalMs:60000})).data.settings.enabled).toBe(true)
 expect((await request('/api/topic-organizer',admin,{intervalMs:1})).res.status).toBe(400)
 const base=`/api/topics/${topic.data.topic_id}`
 const summary=await request(base,admin);expect(summary.data.text).toBe('summary only');expect(JSON.stringify(summary.data)).not.toContain(source.text)
 const original=await request(base+'?include_original=true',admin);expect(original.data.originals[0].text).toBe(source.text)
 expect((await request(base,alice)).res.status).toBe(403)
})

it('restricts blacklist changes to owners and validates exact QQ identities',async()=>{
  const {request}=await setup()
  expect((await request('/api/user-blacklist')).res.status).toBe(401)
  expect((await request('/api/user-blacklist',alice,{action:'block',user_id:'456'})).res.status).toBe(403)
  expect((await request('/api/user-blacklist',admin,{action:'block'})).res.status).toBe(400)
  expect((await request('/api/user-blacklist',admin,{action:'block',user_id:'456',reason:'testing'})).data.items).toMatchObject([{user_id:'456',reason:'testing'}])
  expect((await request('/api/user-blacklist',admin)).data.items).toHaveLength(1)
  expect((await request('/api/user-blacklist',admin,{action:'unblock',user_id:'456'})).data.items).toHaveLength(0)
})

it('restricts persistent receive/debounce configuration to owners and validates target/timing',async()=>{
  const {request}=await setup()
  expect((await request('/api/qq-message-control',alice)).res.status).toBe(403)
  expect((await request('/api/qq-message-control',admin,{conversation_id:'group:44',patch:{receiveEnabled:false,debounceEnabled:true,waitMs:2500}})).res.status).toBe(200)
  expect((await request('/api/qq-message-control',admin)).data.settings.receiveEnabled).toBe(true)
  expect((await request('/api/qq-message-control',admin,{conversation_id:'http://bad',patch:{receiveEnabled:false}})).res.status).toBe(400)
  expect((await request('/api/qq-message-control',admin,{patch:{waitMs:999999}})).res.status).toBe(400)
})

it('serves only the trusted Main native footer to an owner, not arbitrary sessions or chat users',async()=>{
  let selected=''
  const {request,store}=await setup(undefined,false,async id=>{selected=id;return{available:true,source:'dsh-session-projections',tokenUsage:{uncachedInputTokens:10,outputTokens:5,cacheReadTokens:90,cacheWriteTokens:0}}})
  expect((await request('/api/chat-footer')).res.status).toBe(401)
  expect((await request('/api/chat-footer',alice)).res.status).toBe(403)
  store.startRun({run_id:'footer-run',session_id:'trusted-main',agent_id:'role',event_id:'footer-event',state:'completed',started_at:new Date().toISOString()} as never)
  const response=await request('/api/chat-footer?session=untrusted',admin)
  expect(response.res.status).toBe(200);expect(selected).toBe('trusted-main')
  expect(response.data.tokenUsage.cacheReadTokens).toBe(90)
})

it('serves outgoing media only to its Web recipient, preserving original bytes and video/audio byte ranges',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'amphoreus-media-http-')),path=join(dir,'motion.gif'),bytes=Buffer.from('GIF89aabcdefgh')
  writeFileSync(path,bytes);stops.push(async()=>{rmSync(dir,{recursive:true,force:true})})
  const {runtime,request}=await setup(undefined,{outputFile:async()=>({path,bytes:bytes.length,name:'动图.gif',mediaType:'image/gif'})})
  const output=await runtime.gateway.speak({agentId:'role',runId:'media',callId:'gif',target:{platform:'web',account_id:'alice',conversation_id:'web:alice:chat'},
    content:[{type:'image',attachment:{attachmentId:'stored-gif'},path:'/workspace/original.gif'}]},()=>true)
  const route=`/api/output-media/${output.output_id}/0`
  expect((await request(route)).res.status).toBe(401)
  expect((await request(route,bob)).res.status).toBe(403)
  const full=await request(route,alice);expect(full.res.status).toBe(200);expect(full.data).toBe(bytes.toString())
  const range=await request(route,alice,undefined,{Range:'bytes=6-8'});expect(range.res.status).toBe(206);expect(range.data).toBe('abc')
  expect(range.res.headers.get('content-range')).toBe(`bytes 6-8/${bytes.length}`)
  const rows=(await request('/api/messages',alice)).data
  expect(rows.find((row:any)=>row.event.event_id===output.event_id).event.content[0].url).toBe(route)
})

it('mounts the console inside Harness with owner authentication, same-origin assets/API and SSE, without exposing console tokens', async () => {
  const { api, runtime } = await setup()
  let handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>
  const dispose = registerHarnessPanel({ get: () => ({ admit: (req: import('node:http').IncomingMessage) =>
    req.headers.origin === 'https://evil.test' ? { rejection: 403 } : req.headers.cookie === 'dsh=owner'
      ? { peer: { principal: { kind: 'owner' } } } : req.headers.cookie === 'dsh=api'
        ? { peer: { principal: { kind: 'api' } } } : { rejection: 401 } }),
  webServer: { register: (route: { path: string; handler: typeof handler }) => { if (route.path === '/amphoreus') handler = route.handler; else expect(route.path).toBe('/console'); return () => {} } } } as never, api)
  const server = createServer((req, res) => { void handler(req, res) })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  stops.push(async () => { dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/amphoreus`
  const native = (path: string, headers: Record<string, string> = {}) => fetch(base + path, { headers: { Cookie: 'dsh=owner', ...headers } })
  expect((await native('/api/status', { Cookie: '' })).status).toBe(401)
  expect((await native('/api/status', { Cookie: '', Authorization: `Bearer ${admin}` })).status).toBe(401)
  expect((await native('/api/status', { Cookie: 'dsh=api' })).status).toBe(403)
  expect((await native('/api/status', { Origin: 'https://evil.test' })).status).toBe(403)
  expect((await native('/manifest')).status).toBe(200)
  const html = await native('/'), text = await html.text()
  expect(text).toContain('<body class="embedded">')
  expect(text).toContain('href="console.css"')
  expect(html.headers.get('content-security-policy')).toContain("frame-ancestors 'self'")
  expect(text).not.toContain(admin)
  expect((await native('/console.js')).status).toBe(200)
  expect((await (await native('/api/me')).json())).toEqual({ user: 'admin', role: 'admin' })
  const headers = { Cookie: 'dsh=owner', 'content-type': 'application/json' }, body = JSON.stringify({ conversation: 'chat', content: 'from plugin', idempotency_key: 'native' })
  expect((await fetch(base + '/api/messages', { method: 'POST', headers, body })).status).toBe(403)
  expect((await fetch(base + '/api/messages', { method: 'POST', headers: { ...headers, 'x-amphoreus-request': '1' }, body })).status).toBe(202)
  await runtime.scheduler.idle()
  expect((await (await native('/api/messages')).json())).toEqual(expect.arrayContaining([expect.objectContaining({ event: expect.objectContaining({ actor_id: 'admin' }) })]))
  const controller = new AbortController()
  const stream = await fetch(base + '/api/stream', { headers, signal: controller.signal }), reader = stream.body!.getReader()
  expect(new TextDecoder().decode((await reader.read()).value)).toContain('event: ready')
  controller.abort(); await reader.cancel().catch(() => {})
})

it('registers /console on the existing Harness web listener without requiring or inheriting DSH owner access', async () => {
  const { api } = await setup(), routes = new Map<string, any>()
  const dispose=registerHarnessPanel({get:()=>({admit:()=>({rejection:401})}),webServer:{register:(route:any)=>{routes.set(route.path,route.handler);return()=>{routes.delete(route.path)}}}} as never,api)
  const server=createServer((req,res)=>{void routes.get('/console')(req,res)})
  server.listen(0,'127.0.0.1');await once(server,'listening')
  stops.push(async()=>{dispose();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()))})
  const port=(server.address() as import('node:net').AddressInfo).port
  api.config.allowedHosts.push(`127.0.0.1:${port}`)
  const base=`http://127.0.0.1:${port}/console`
  expect((await fetch(base)).status).toBe(200)
  expect((await fetch(base+'/console.js')).status).toBe(200)
  expect((await fetch(base+'/api/me',{headers:{cookie:'dsh=owner'}})).status).toBe(401)
  const login=await fetch(base+'/api/login',{method:'POST',headers:{'content-type':'application/json','x-amphoreus-request':'1'},body:JSON.stringify({token:alice})})
  expect(login.status).toBe(200)
  const cookie=login.headers.get('set-cookie')!.split(';')[0]!
  expect((await (await fetch(base+'/api/me',{headers:{cookie}})).json())).toEqual({user:'alice',role:'chat'})
})

it('serves the independent /console entry and enforces confirmed MFA, recovery, CSRF and session rotation', async () => {
  const { request } = await setup(undefined, true), password = 'a strong password'
  const page = await request('/console')
  expect(page.res.status).toBe(200); expect(page.data).toContain('无需登录 DeepSeek Harness')
  expect(page.data).toContain('href="/console/console.css"')
  expect((await request('/console/console.js')).res.status).toBe(200)
  expect((await request('/console/api/me')).res.status).toBe(401)
  const before = await request('/console/api/login','',{token:alice}), oldCookie=before.res.headers.get('set-cookie')!.split(';')[0]!
  expect(before.res.headers.get('set-cookie')).toContain('; Secure')
  expect((await request('/console/api/auth/enroll','',{token:alice,password},{'x-amphoreus-request':''})).res.status).toBe(403)
  expect((await request('/console/api/auth/enroll','',{token:alice,password},{origin:'https://evil.test'})).res.status).toBe(403)
  const pending=await request('/console/api/auth/enroll','',{token:alice,password})
  expect(pending.res.status).toBe(200); expect(pending.data.qr).toMatch(/^data:image\/png;base64,/)
  expect(pending.res.headers.get('cache-control')).toBe('no-store')
  const code=totp(pending.data.secret,Math.floor(Date.now()/30000))
  const confirmed=await request('/console/api/auth/confirm','',{challenge:pending.data.challenge,code})
  expect(confirmed.res.status).toBe(200); expect(confirmed.data.recovery).toHaveLength(10)
  expect((await request('/console/api/me','',undefined,{cookie:oldCookie})).res.status).toBe(401)
  expect((await request('/console/api/login','',{token:alice})).res.status).toBe(401)
  expect((await request('/console/api/auth/login','',{user:'alice',password,code})).res.status).toBe(401)
  const logged=await request('/console/api/auth/login','',{user:'alice',password,code:confirmed.data.recovery[0]})
  expect(logged.res.status).toBe(200); expect(logged.data.role).toBe('chat')
  const cookie=logged.res.headers.get('set-cookie')!.split(';')[0]!
  expect((await request('/console/api/me','',undefined,{cookie})).data).toEqual({user:'alice',role:'chat'})
  expect((await request('/console/api/chat-activity','',undefined,{cookie})).res.status).toBe(403)
  expect((await request('/console/api/logout','',{}, {cookie})).res.status).toBe(200)
  expect((await request('/console/api/me','',undefined,{cookie})).res.status).toBe(401)
})

it('throttles unauthenticated requests without trusting spoofed forwarding headers', async () => {
  const { request } = await setup()
  for (let n=0;n<20;n++) expect((await request('/console/api/login','',{token:'wrong'},{'x-forwarded-for':`192.0.2.${n}`})).res.status).toBe(401)
  expect((await request('/console/api/login','',{token:alice})).res.status).toBe(429)
})

it('keeps archived Main thinking and tools owner-only, scoped and policy filtered', async () => {
  const { runtime, request, memory } = await setup()
  const received = await runtime.receiveWeb('alice', 'chat', [{ type: 'text', text: 'hello' }], 'activity')
  await runtime.scheduler.idle()
  const event_id = received.event.event_id
  for (const [id, sourceEvent, permitted] of [['allowed', event_id, true], ['disabled', event_id, false], ['foreign', 'missing-event', true]] as const) {
    memory.put({ id, kind: 'reasoning', title: id, text: id, created_at: new Date().toISOString(), source: { branch: 'main', event_id: sourceEvent, provider: 'approved' }, data: { permitted } })
  }
  const path = `/api/chat-activity?event=${encodeURIComponent(event_id)}&event=missing-event`
  expect((await request(path)).res.status).toBe(401)
  expect((await request(path, alice)).res.status).toBe(403)
  expect((await request(path, bob)).res.status).toBe(403)
  expect((await request(path, admin)).data.items.map((item: any) => item.id)).toEqual(['allowed'])
  expect((await request('/api/chat-activity?before=-1', admin)).res.status).toBe(400)
})

it('authenticates, routes Web messages through Gateway and isolates users and management operations', async () => {
  const { runtime, store, request } = await setup()
  expect((await request('/api/status')).res.status).toBe(401)
  expect((await request('/api/status', alice)).data.role.persona).toBeUndefined()
  expect((await request('/api/tasks', alice)).data).toEqual([])
  expect((await request('/api/participation', alice)).res.status).toBe(403)
  expect((await request('/api/participation', alice, {settings:{mode:'heart'}})).res.status).toBe(403)
  expect((await request('/api/participation', admin)).res.status).toBe(409)
  expect((await request('/api/status', admin, undefined, { Origin: 'https://evil.test' })).res.status).toBe(403)
  const input = { conversation: 'chat', content: 'hello', idempotency_key: '1' }
  expect((await request('/api/messages', alice, input)).res.status).toBe(202)
  expect((await request('/api/messages', alice, input)).data.inserted).toBe(false)
  await runtime.scheduler.idle()
  expect(store.events({ sourceKind: 'web' })).toHaveLength(1)
  expect((await request('/api/messages?conversation=&source=', admin)).data.length).toBeGreaterThan(1)
  store.insertReport({ report_id: 'r', task_id: 't', subagent_id: 's', agent_id: 'role', event_id: 'e', type: 'discovery', summary: 'report', priority: 0, created_at: new Date().toISOString() })
  expect((await request('/api/reports?task=', admin)).data).toHaveLength(1)
  expect((await request('/api/messages?conversation=web:alice:chat', alice)).data).toHaveLength(2)
  expect((await request('/api/messages?conversation=web:alice:chat', bob)).res.status).toBe(403)
  expect((await request('/api/messages', alice)).data).toHaveLength(2)
  expect((await request('/api/messages', bob)).data).toHaveLength(0)
  await runtime.receiveWeb('alice', 'other-source', [{ type: 'text', text: 'another source' }], 'other-source')
  await runtime.scheduler.idle()
  expect((await request('/api/messages', alice)).data).toHaveLength(4)
  expect((await request('/api/messages?platform=internal', admin)).data.every((row: any) => row.event.platform === 'internal')).toBe(true)
  expect((await request('/api/messages?platform=internal', alice)).data.every((row: any) => row.event.platform === 'web' && row.event.account_id === 'alice')).toBe(true)
  expect((await request('/api/conversations', bob)).data).toHaveLength(0)
  expect((await request('/api/conversations', alice)).data.find((row: any) => row.conversation_id === 'web:alice:chat')).toMatchObject({ title: 'hello', preview: 'Hi', account_id: 'alice' })
  expect((await request('/api/messages', alice, { ...input, actor_id: 'bob' })).res.status).toBe(400)
  const login = await request('/api/login', '', { token: alice })
  expect(login.res.headers.get('set-cookie')).toContain('HttpOnly')
  expect(login.res.headers.get('set-cookie')).toContain('SameSite=Strict')
  expect(JSON.stringify((await request('/api/status', admin)).data)).not.toContain(admin)
})

it('serves an independent formatted console and realtime change events', async () => {
  const { request, url, runtime } = await setup()
  const html = await request('/')
  expect(html.data).toContain('消息中心')
  expect(html.res.headers.get('content-security-policy')).toContain("script-src 'self'")
  expect((await request('/console.js')).res.status).toBe(200)
  const controller = new AbortController()
  const stream = await fetch(url + '/api/stream', { headers: { Authorization: `Bearer ${admin}` }, signal: controller.signal })
  const reader = stream.body!.getReader()
  expect(new TextDecoder().decode((await reader.read()).value)).toContain('event: ready')
  await runtime.receiveWeb('alice', 'chat', [{ type: 'text', text: 'event' }], 'stream')
  expect(new TextDecoder().decode((await reader.read()).value)).toContain('event: change')
  controller.abort(); await reader.cancel().catch(() => {})
  await runtime.scheduler.idle()
})

it('resolves only the reviewed failure, retains its history and resurfaces a failed retry', async () => {
  const { runtime, store, request } = await setup()
  const event = (await runtime.receiveWeb('alice', 'review', [{ type: 'text', text: 'test input' }], 'review-failure')).event
  await runtime.scheduler.idle()
  const run = store.runs().find(run => run.event_id === event.event_id)!
  store.finishRun(run.run_id, 'failed', 'Main Run time budget exceeded')
  store.setEventState(event.event_id, 'failed', 'Main Run time budget exceeded')
  const before = (await request('/api/status', admin)).data.errors.find((error: any) => error.event_id === event.event_id)
  const path = `/api/events/${event.event_id}/resolve`, input = { fingerprint: before.fingerprint, note: 'Reviewed the test failure and verified its later successful replacement.' }
  expect((await request(path, alice, input)).res.status).toBe(403)
  expect((await request(path, admin, { ...input, fingerprint: 'stale' })).res.status).toBe(409)
  expect((await request(path, admin, input)).data).toEqual({ resolved: true })
  expect((await request(path, admin, input)).res.status).toBe(200)
  expect((await request('/api/status', admin)).data.errors).not.toEqual(expect.arrayContaining([expect.objectContaining({ event_id: event.event_id })]))
  expect(store.event(event.event_id)?.state).toBe('failed')
  expect(store.run(run.run_id)?.state).toBe('failed')
  expect((await request('/api/runs', admin)).data.find((item: any) => item.run_id === run.run_id).resolution).toMatchObject({ note: input.note, reviewer: 'admin' })
  const message = (await request('/api/messages', admin)).data.find((item: any) => item.event.event_id === event.event_id)
  expect(message.resolution.note).toBe(input.note)
  store.setRecord('run-attempt', event.event_id, 2)
  store.startRun({ ...run, run_id: `${run.run_id}-2`, started_at: new Date().toISOString() })
  store.finishRun(`${run.run_id}-2`, 'failed', 'Main Run time budget exceeded')
  store.setEventState(event.event_id, 'failed', 'Main Run time budget exceeded')
  const again = (await request('/api/status', admin)).data.errors.find((error: any) => error.event_id === event.event_id)
  expect(again).toBeDefined()
  expect(again.fingerprint).not.toBe(before.fingerprint)
  expect((await request(path, admin, input)).res.status).toBe(409)
})

it('renders QQ segments, Web Markdown, code and report cards without executing untrusted HTML or URLs', () => {
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' })
  dom.window.eval(readFileSync(new URL('../src/amphoreus/console.js', import.meta.url), 'utf8'))
  const ui = (dom.window as any).AmphoreusUI
  const event = { source_kind: 'napcat', platform: 'qq', visibility: 'public', actor_id: 'user', timestamp: new Date().toISOString(), metadata: { nickname: '<script>evil()</script>', group_name: 'Group' },
    content: [{ type: 'text', text: '**Hello**\n```js\nconsole.log(1)\n```\n<img src=x onerror=evil()>\n[bad](javascript:evil)' },
      { type: 'image', url: 'javascript:evil' }, { type: 'mention', actor_id: '123' }, { type: 'quote', message_id: '9' }, { type: 'emoji', emoji_id: '66' }] }
  const card = ui.messageCard({ event, state: 'processed' }, [])
  dom.window.document.body.append(card)
  expect(card.querySelector('strong')?.textContent).toContain('<script>')
  expect(card.querySelector('script')).toBeNull()
  expect(card.querySelector('[onerror]')).toBeNull()
  expect(card.querySelector('a[href^="javascript:"]')).toBeNull()
  expect(card.querySelector('.mention').textContent).toBe('@123')
  expect(card.querySelector('.quote').textContent).toContain('#9')
  expect(card.querySelector('pre code').textContent).toContain('console.log(1)')
  const report = ui.blocks([{ type: 'report', report_type: 'discovery', summary: '找到结果', progress: 40 }])
  expect(report.querySelector('.status-event').textContent).toContain('重要发现')
  dom.window.close()
})


it('opens an authorized Subagent detail and paginated activity without exposing other users tasks', async () => {
  const reads: string[] = []
  const { runtime, store, request } = await setup(async (task, offset) => {
    reads.push(task.subagent_id)
    return { available: true, items: [{ id: String(offset), timestamp: new Date().toISOString(), kind: 'message', text: 'worker output' }], end_offset: offset + 1, has_more: false }
  })
  const origin = (await runtime.receiveWeb('alice', 'detail', [{ type: 'text', text: 'please inspect' }], 'detail')).event
  await runtime.scheduler.idle()
  store.enqueueTask({ task_id: 'task/detail', subagent_id: 'worker-trusted', agent_id: 'role', description: 'inspect', context: [], priority: 0, state: 'completed', created_at: origin.timestamp, updated_at: origin.timestamp, origin })
  store.insertReport({ report_id: 'r-detail', task_id: 'task/detail', subagent_id: 'worker-trusted', agent_id: 'role', event_id: 'event-detail', type: 'completed', summary: 'done', priority: 0, created_at: origin.timestamp })
  const path = '/api/tasks/task%2Fdetail'
  expect((await request(path)).res.status).toBe(401)
  expect((await request(path, bob)).res.status).toBe(403)
  expect((await request(path + '/activity', bob)).res.status).toBe(403)
  expect(reads).toHaveLength(0)
  expect((await request('/api/tasks/missing', admin)).res.status).toBe(404)
  const detail = await request(path, alice)
  expect(detail.data.task.description).toBe('inspect')
  expect(detail.data.reports[0].summary).toBe('done')
  expect((await request(path + '/activity?offset=12', alice)).data).toMatchObject({ end_offset: 13, items: [{ text: 'worker output' }] })
  expect(reads).toEqual(['worker-trusted'])
  expect((await request(path, admin)).res.status).toBe(200)
  expect((await request('/api/tasks?conversation=web:alice:detail', alice)).data).toHaveLength(1)
  expect((await request('/api/tasks?conversation=web:bob:detail', bob)).data).toHaveLength(0)
  expect((await request('/api/tasks?conversation=web:alice:detail', bob)).res.status).toBe(403)
  expect((await request('/api/tasks', alice)).data).toHaveLength(1)
  expect((await request('/api/tasks', bob)).data).toHaveLength(0)
})


it('restricts usage and logs to admins, validates filters and persists plan settings',async()=>{
 const {request}=await setup()
 expect((await request('/api/statistics')).res.status).toBe(401)
 expect((await request('/api/statistics',alice)).res.status).toBe(403)
 expect((await request('/api/logs',alice)).res.status).toBe(403)
 const result=await request('/api/statistics',admin)
 expect(result.res.status).toBe(200);expect(result.data.time_zone).toBe('Asia/Shanghai')
 expect((await request('/api/logs?before=bad',admin)).res.status).toBe(400)
 expect((await request('/api/statistics/settings',admin,{goPlan:'go'})).data.goPlan).toBe('go')
 expect((await request('/api/statistics/settings',admin)).data.goPlan).toBe('go')
 expect(JSON.stringify((await request('/api/logs',admin)).data)).not.toContain(admin)
})

it('restricts the embedded meme library, raw images and mutations to administrators',async()=>{
 const f=await setup(),view=vi.fn(()=>({packs:[],items:[],settings:{}})),handle=vi.fn((_req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end('{"ok":true}')})
 ;(f.api as any).memes={view,handle}
 for(const path of ['/api/memes','/api/memes/image/'+'a'.repeat(24),'/api/memes/export']){
  expect((await f.request(path)).res.status).toBe(401);expect((await f.request(path,alice)).res.status).toBe(403)
 }
 expect((await f.request('/api/memes',admin)).data.items).toEqual([])
 expect((await fetch(f.url+'/api/memes/manage',{method:'POST',headers:{Authorization:`Bearer ${admin}`,'content-type':'application/json'},body:'{"op":"scanPack"}'})).status).toBe(403)
 expect(handle).not.toHaveBeenCalled();expect((await f.request('/api/memes/manage',admin,{op:'scanPack'})).data.ok).toBe(true);expect(handle).toHaveBeenCalledOnce()
})
