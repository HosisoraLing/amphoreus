import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync,symlinkSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import WebSocket, { WebSocketServer } from 'ws'
import { afterEach, expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import { AmphoreusStore } from '../src/amphoreus/store.ts'
import { AmphoreusRuntime, type MainContext } from '../src/amphoreus/runtime.ts'
import { QQAdapter, QQConfig, qqBlocks } from '../src/amphoreus/qq.ts'
import { UserBlocklist } from '../src/amphoreus/blocklist.ts'
const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const stop of cleanup.splice(0).reverse()) await stop() })
const eventually = async (check: () => boolean) => { for (let n = 0; n < 200; n++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)) }; throw new Error('did not settle') }
function open(main: (context: MainContext) => Promise<void> = async () => {}) {
  const dir = mkdtempSync(join(tmpdir(), 'amphoreus-qq-')), host = new Store(join(dir, 'db.sqlite'))
  const store = new AmphoreusStore(host)
  const runtime = new AmphoreusRuntime(store, { main, task: async () => '', messageTask: async () => {}, stop: async () => {} },
    { agent_id: 'role', name: 'role', persona: 'persona' }, { maxWorkers: 3, mainTimeoutMs: 1000, taskTimeoutMs: 1000, progressIntervalMs: 60000 })
  cleanup.push(async () => { await runtime.stop(); host.close(); rmSync(dir, { recursive: true }) })
  return { runtime, store }
}
const message = (id = '1', at = true) => ({ post_type: 'message', self_id: '123', user_id: '456', group_id: '789', message_id: id, time: Date.now() / 1000,
  message_type: 'group', sender: { nickname: 'Test user' }, message: [{ type: 'text', data: { text: 'hello' } },
    ...(at ? [{ type: 'at', data: { qq: '123' } }] : []), { type: 'image', data: { url: 'https://example.test/image.png', file: 'image' } },
    { type: 'reply', data: { id: '0' } }, { type: 'face', data: { id: '66' } }, { type: 'record', data: { url: 'https://example.test/audio.mp3' } }] })
const token = 'test-token-123456789'

it('sends ordered multimodal blocks and local file bytes through NapCat, rejecting paths outside the workspace',async()=>{
  const server=new WebSocketServer({port:0});await once(server,'listening')
  cleanup.push(()=>new Promise<void>(resolve=>{for(const client of server.clients)client.terminate();server.close(()=>resolve())}))
  const frames:Record<string,any>[]=[]
  server.on('connection',socket=>socket.on('message',frame=>{
    const call=JSON.parse(frame.toString());frames.push(call)
    socket.send(JSON.stringify({echo:call.echo,status:'ok',retcode:0,data:call.action==='get_login_info'?{user_id:'123'}:{message_id:'sent-media'}}))
  }))
  const dir=mkdtempSync(join(tmpdir(),'amphoreus-outgoing-media-')),allowed=join(dir,'workspace'),file=join(allowed,'测试.txt'),secret=join(dir,'private.txt')
  mkdirSync(allowed);writeFileSync(file,'附件的原始字节');writeFileSync(secret,'不应发送');symlinkSync(secret,join(allowed,'link'))
  cleanup.push(()=>rmSync(dir,{recursive:true,force:true}))
  const {runtime}=open(),adapter=new QQAdapter(runtime,QQConfig.parse({enabled:true,token,accountId:'123',allowedUsers:['456'],
    wsUrl:`ws://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`}),[allowed])
  cleanup.push(()=>adapter.stop());adapter.start();await eventually(()=>adapter.status().state==='connected')
  const target={platform:'qq',account_id:'123',conversation_id:'private:456'}
  const result=await adapter.send({target,idempotency_key:'all-media',content:[{type:'text',text:'前文'},
    ...['image','audio','video','file'].map(type=>({type,path:file})),{type:'text',text:'后文'}]})
  expect(result).toMatchObject({status:'sent'})
  const message=frames.find(frame=>frame.action==='send_private_msg')!.params.message
  expect(message.map((block:any)=>block.type)).toEqual(['text','image','record','video','file','text'])
  for(const block of message.slice(1,5))expect(Buffer.from(block.data.file.slice('base64://'.length),'base64').equals(readFileSync(file))).toBe(true)
  expect(await adapter.send({target,idempotency_key:'deny',content:[{type:'file',path:join(allowed,'link')}]})).toBe('failed')
  expect(await adapter.send({target,idempotency_key:'deny-internal',content:[{type:'image',url:'https://media.test/image',transport_file:'file:///private/secret'}]})).toMatchObject({status:'sent'})
  const last=frames.filter(frame=>frame.action==='send_private_msg').at(-1)!
  expect(last.params.message[0].data.file).toBe('https://media.test/image')
})

it('archives blocked QQ senders without scheduling group mentions or private wakeups',async()=>{
 const {runtime,store}=open(),adapter=new QQAdapter(runtime,QQConfig.parse({token,accountId:'123',allowedGroups:['*'],allowedUsers:['*']}))
 cleanup.push(()=>adapter.stop());adapter.blocklist=new UserBlocklist(store,'role','123')
 adapter.blocklist.configure({action:'block',user_id:'456'})
 const group=await runtime.gateway.ingest('napcat',message('blocked-mention'))
 const privateMessage=await runtime.gateway.ingest('napcat',{...message('blocked-private'),message_type:'private'})
 expect(group.event.metadata).toMatchObject({user_blocked:true,schedule:false,participation:false,qq_debounce:false})
 expect(privateMessage.event.metadata.schedule).toBe(false)
 expect(store.event(group.event.event_id)).toBeDefined()
 adapter.blocklist.configure({action:'unblock',user_id:'456'})
 expect((await runtime.gateway.ingest('napcat',message('allowed-mention'))).event.metadata.schedule).toBe(true)
})

it('archives all group messages but gates ordinary replies by probability and persisted cooldown', async () => {
  const { runtime, store } = open()
  const random = vi.spyOn(Math, 'random').mockReturnValue(.9); cleanup.push(() => random.mockRestore())
  const adapter = new QQAdapter(runtime, QQConfig.parse({ token, accountId: '123', allowedGroups: ['*'], groupTrigger: 'all', keywords: ['角色'] }))
  cleanup.push(() => adapter.stop())
  const quiet = await runtime.gateway.ingest('napcat', message('quiet', false))
  expect(quiet.event.metadata.schedule).toBe(false)
  expect(store.event(quiet.event.event_id)?.state).toBe('processed')
  random.mockReturnValue(.001)
  expect((await runtime.gateway.ingest('napcat', message('chance', false))).event.metadata.schedule).toBe(true)
  store.setRecord('qq-active-wake', '123:789', Date.now())
  expect((await runtime.gateway.ingest('napcat', message('cooldown', false))).event.metadata.schedule).toBe(false)
  expect((await runtime.gateway.ingest('napcat', message('mentioned'))).event.metadata.schedule).toBe(true)
  expect((await runtime.gateway.ingest('napcat', { ...message('named', false), message: [{ type: 'text', data: { text: '角色看这里' } }] })).event.metadata.schedule).toBe(true)
})

it('normalizes segments and CQ codes, deduplicates, checks identities and group triggers', async () => {
  const { runtime, store } = open()
  const adapter = new QQAdapter(runtime, QQConfig.parse({ token, accountId: '123', allowedGroups: ['789'] }))
  cleanup.push(() => adapter.stop())
  const first = await runtime.gateway.ingest('napcat', message())
  expect(first.event.content.map(b => b.type)).toEqual(['text', 'mention', 'image', 'quote', 'emoji', 'audio'])
  expect((await runtime.gateway.ingest('napcat', message())).inserted).toBe(false)
  const muted = await runtime.gateway.ingest('napcat', message('2', false))
  expect(store.event(muted.event.event_id)?.state).toBe('processed')
  await expect(runtime.gateway.ingest('napcat', { ...message('3'), self_id: '999' })).rejects.toThrow('sender')
  await expect(runtime.gateway.ingest('napcat', { ...message('3'), group_id: '999' })).rejects.toThrow('not allowed')
  expect(qqBlocks('Hi&amp;[CQ:at,qq=123][CQ:reply,id=1]')[1]).toEqual({ type: 'mention', actor_id: '123', platform: 'qq' })
  await runtime.scheduler.idle()
})

it('accepts every media-only message without text, with scheduling independent of its modality',async()=>{
  const contexts:MainContext[]=[],{runtime,store}=open(async context=>{contexts.push(context)})
  const adapter=new QQAdapter(runtime,QQConfig.parse({token,accountId:'123',allowedUsers:['456'],allowedGroups:['789'],groupTrigger:'all',activeReply:{probability:0}}))
  cleanup.push(()=>adapter.stop());await runtime.start();await runtime.scheduler.idle()
  for(const type of ['image','record','video','file','forward']){
    const raw={...message(`media-${type}`,false),message_type:'private',group_id:undefined,
      message:[{type,data:{url:`https://media.test/${type}`,file:`only-${type}`,id:'forward-id'}}]}
    const first=await runtime.gateway.ingest('napcat',raw)
    expect(first.inserted).toBe(true);expect(first.event.content).toHaveLength(1)
    expect(first.event.metadata.schedule).toBe(true)
    expect((await runtime.gateway.ingest('napcat',raw)).inserted).toBe(false)
    const quiet=await runtime.gateway.ingest('napcat',{...raw,message_id:`quiet-${type}`,message_type:'group',group_id:'789'})
    expect(quiet.event.metadata.schedule).toBe(false)
  }
  await runtime.scheduler.idle()
  expect(store.events({sourceKind:'napcat'})).toHaveLength(10)
  expect(contexts.filter(context=>context.event.source_kind==='napcat').map(context=>context.event.content[0]?.type)).toEqual(['image','audio','video','file','forward'])
})

it('exchanges private/group frames and receipts over real WS, reconnects, and marks timeout unknown', async () => {
  const server = new WebSocketServer({ port: 0 }); await once(server, 'listening')
  cleanup.push(() => new Promise<void>(resolve => { for (const c of server.clients) c.terminate(); server.close(() => resolve()) }))
  let connections = 0, peer!: WebSocket
  const sends: Record<string, any>[] = []
  server.on('connection', (socket, req) => {
    connections++; peer = socket
    expect(req.headers.authorization).toBe(`Bearer ${token}`)
    socket.on('message', frame => {
      const call = JSON.parse(frame.toString())
      if (call.action === 'get_login_info') socket.send(JSON.stringify({ echo: call.echo, status: 'ok', retcode: 0, data: { user_id: '123' } }))
      else if (call.action.startsWith('send_')) {
        sends.push(call)
        if (sends.length < 3) socket.send(JSON.stringify({ echo: call.echo, status: 'ok', retcode: 0, data: { message_id: `sent-${sends.length}` } }))
      } else socket.send(JSON.stringify({ echo: call.echo, status: 'ok', retcode: 0, data: { group_name: 'Group name' } }))
    })
  })
  const contexts: MainContext[] = []
  const { runtime, store } = open(async context => { contexts.push(context); if (context.event.platform === 'qq') await context.speak([{ type: 'text', text: 'reply' }], 'speak') })
  const adapter = new QQAdapter(runtime, QQConfig.parse({ enabled: true, token, accountId: '123', allowedGroups: ['789'], allowedUsers: ['456'],
    wsUrl: `ws://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`, reconnectMs: 50, requestTimeoutMs: 100, heartbeatMs: 100 }))
  cleanup.push(() => adapter.stop()); await runtime.start(); await runtime.scheduler.idle(); adapter.start()
  await eventually(() => adapter.status().state === 'connected')
  peer.send(JSON.stringify(message()))
  peer.send(JSON.stringify(message()))
  await eventually(() => store.outputs().length === 1 && store.outputs()[0]?.status === 'sent')
  expect(sends[0]?.params.message[0]).toEqual({ type: 'reply', data: { id: '1' } })
  expect(store.record('receipt', store.outputs()[0]!.output_id)).toMatchObject({ message_id: 'sent-1' })
  peer.terminate(); await eventually(() => connections === 2 && adapter.status().state === 'connected')
  peer.send(JSON.stringify({ ...message('private'), group_id: undefined, message_type: 'private' }))
  await eventually(() => sends.length === 2)
  expect(sends[1]?.action).toBe('send_private_msg')
  // This private frame contains an explicit mention; only mentioned messages retain automatic quoting.
  expect(sends[1]?.params.message[0].type).toBe('reply')
  peer.send(JSON.stringify(message('3')))
  await eventually(() => store.outputs().some(o => o.status === 'unknown'))
  await runtime.scheduler.idle()
  expect(contexts.filter(c => c.event.platform === 'qq')).toHaveLength(3)
  await runtime.receiveWeb('alice', 'chat', [{ type: 'text', text: '来自 Web' }], 'web-after-qq')
  await runtime.scheduler.idle()
  expect(new Set(contexts.map(context => context.sessionId)).size).toBe(1)
  expect(contexts.at(-1)?.event.platform).toBe('web')
  expect(adapter.status().state).toBe('connected')
})

it('authenticates reverse WS before accepting frames and binds it to the configured account', async () => {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())))
  const { runtime, store } = open()
  const adapter = new QQAdapter(runtime, QQConfig.parse({ enabled: true, token, accountId: '123', direction: 'reverse', allowedGroups: ['789'] }))
  cleanup.push(() => adapter.stop()); await runtime.start(); await runtime.scheduler.idle(); adapter.start(server)
  const url = `ws://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/onebot`
  const denied = new WebSocket(url, { headers: { Authorization: 'Bearer wrong', 'X-Self-ID': '123' } })
  const error = once(denied, 'error'); await error
  const client = new WebSocket(url, { headers: { Authorization: `Bearer ${token}`, 'X-Self-ID': '123' } })
  cleanup.push(() => { client.terminate() })
  client.on('message', raw => { const call = JSON.parse(raw.toString()); client.send(JSON.stringify({ echo: call.echo, status: 'ok', retcode: 0, data: { user_id: '123' } })) })
  await eventually(() => adapter.status().state === 'connected')
  client.send(JSON.stringify(message()))
  await eventually(() => store.events({ sourceKind: 'napcat' }).length === 1)
  await runtime.scheduler.idle()
})

it('keeps outbound-only connections from ingesting events while still delivering through speak', async () => {
  const server = new WebSocketServer({ port: 0 }); await once(server, 'listening')
  cleanup.push(() => new Promise<void>(resolve => { for (const c of server.clients) c.terminate(); server.close(() => resolve()) }))
  let peer!: WebSocket, sends = 0
  server.on('connection', socket => {
    peer = socket
    socket.on('message', frame => {
      const call = JSON.parse(frame.toString())
      if (call.action === 'send_private_msg') sends++
      socket.send(JSON.stringify({ echo: call.echo, status: 'ok', retcode: 0,
        data: call.action === 'get_login_info' ? { user_id: '123' } : { message_id: 'outbound-only' } }))
    })
  })
  const { runtime, store } = open()
  const adapter = new QQAdapter(runtime, QQConfig.parse({ enabled: true, token, accountId: '123', allowedUsers: ['456'], receiveEnabled: false,
    wsUrl: `ws://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}` }))
  cleanup.push(() => adapter.stop()); adapter.start()
  await eventually(() => adapter.status().state === 'connected')
  peer.send(JSON.stringify(message()))
  await adapter.receive({ ...message(), message_type: 'private', group_id: undefined })
  const input = { agentId: 'role', runId: 'operator-test', callId: 'send', target: { platform: 'qq', account_id: '123', conversation_id: 'private:456' }, content: [{ type: 'text', text: 'test' }] }
  const output = await runtime.gateway.speak(input, () => true)
  expect(output.status).toBe('sent')
  expect((await runtime.gateway.speak(input, () => true)).output_id).toBe(output.output_id)
  expect(sends).toBe(1)
  expect(store.events({ sourceKind: 'napcat' })).toHaveLength(0)
  expect(adapter.status().receive_enabled).toBe(false)
})

it('runs the operator smoke script with private evidence, history verification and no resend on restart', async () => {
  const server = new WebSocketServer({ port: 0 }); await once(server, 'listening')
  cleanup.push(() => new Promise<void>(resolve => { for (const c of server.clients) c.terminate(); server.close(() => resolve()) }))
  const dir = mkdtempSync(join(tmpdir(), 'amphoreus-qq-smoke-')), file = join(dir, 'config.json'), evidence = join(dir, 'evidence')
  cleanup.push(() => rmSync(dir, { recursive: true }))
  let sends = 0, message: unknown
  server.on('connection', socket => socket.on('message', frame => {
    const call = JSON.parse(frame.toString())
    let data = {}
    if (call.action === 'get_login_info') data = { user_id: '123' }
    if (call.action === 'send_private_msg') { sends++; expect(call.params.user_id).toBe('456'); message = call.params.message; data = { message_id: '42' } }
    if (call.action === 'get_msg') data = { message_type: 'private', sender: { user_id: '123' }, message }
    if (call.action === 'get_friend_msg_history') { expect(call.params.user_id).toBe('456'); data = { messages: [{ message_id: '42' }] } }
    socket.send(JSON.stringify({ echo: call.echo, status: 'ok', retcode: 0, data }))
  }))
  writeFileSync(file, JSON.stringify({ role: { agent_id: 'role', name: 'Role', persona: 'Persona' }, workspace: dir,
    api: { allowedHosts: ['localhost'], tokens: [{ token: 'a'.repeat(40), user: 'admin', role: 'admin' }] }, memory: {},
    qq: { enabled: true, token, accountId: '123', allowedUsers: ['456'], receiveEnabled: false,
      wsUrl: `ws://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}` } }))
  const run = (user = '456') => promisify(execFile)(process.execPath, ['--experimental-transform-types', 'scripts/amphoreus-qq-smoke.mjs', file, user, evidence])
  await run(); await run()
  expect(sends).toBe(1)
  const receipt = readFileSync(join(evidence, 'receipt.json'), 'utf8')
  expect(JSON.parse(receipt)).toMatchObject({ status: 'sent', exact_text_match: true, recipient_match: true, idempotent_replay: true, receive_enabled: false })
  expect(receipt).not.toContain(token)
  await expect(run('999')).rejects.toThrow('explicitly allowlisted')
  expect(sends).toBe(1)
})
