import { mkdtempSync, rmSync, readFileSync,writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import { AmphoreusStore } from '../src/amphoreus/store.ts'
import { MemoryStore } from '../src/amphoreus/memory.ts'
import { MediaInput, MediaSettings } from '../src/amphoreus/media.ts'
import { normalizeEvent, type ContentBlock } from '../src/amphoreus/model.ts'

const cleanup: (() => void)[] = []
afterEach(() => { cleanup.splice(0).reverse().forEach(stop => stop()); vi.restoreAllMocks() })
function open(settings = MediaSettings.parse({}), rpc = vi.fn(async (_action: string, _params: Record<string, unknown>) => ({} as Record<string, unknown>))) {
  const dir = mkdtempSync(join(tmpdir(),'amphoreus-media-test-')), host = new Store(join(dir,'db.sqlite')), store = new AmphoreusStore(host), memory = new MemoryStore(host,'role')
  cleanup.push(() => { host.close(); rmSync(dir,{recursive:true,force:true}) })
  let id = 0
  const attachments = { imageLimits: { maxImagesPerMessage: 16 },
    saveImage: vi.fn(async (_input: { data: Uint8Array }) => ({ attachmentId: `image-${++id}`, mediaType:'image/png',bytes:8,width:1,height:1 })),
    saveFile: vi.fn(async (input: { data: Buffer; name: string }) => ({ attachmentId:`file-${++id}`,bytes:input.data.length,name:input.name })),
    fileHostPath:vi.fn(()=>join(dir,'stored-file')),imageHostPath:vi.fn(()=>join(dir,'stored-image')),
    readImage:vi.fn(async(ref:object)=>({ref,data:png})) }
  const media = new MediaInput(attachments as never,store,memory,settings,rpc)
  const event = (content: ContentBlock[]) => normalizeEvent({ agent_id:'role',source_kind:'web',platform:'web',account_id:'owner',conversation_id:'web:owner:chat',actor_id:'owner',
    event_type:'message',timestamp:new Date().toISOString(),correlation_id:null,content,metadata:{},visibility:'private',idempotency_key:`test-${id}` })
  return { dir, store, memory, attachments, media, event, rpc }
}
const png = Buffer.from('89504e470d0a1a0a00000000','hex'), signal = () => new AbortController().signal

it('resolves QQ quotes outside the current page once for both UI and model, with scope and current blacklist checks',async()=>{
 const rpc=vi.fn(async()=>({message_type:'group',group_id:123,time:123,sender:{user_id:456,nickname:'小鱼'},message:[{type:'text',data:{text:'被引用的原文'}},{type:'record',data:{file:'voice'}}]})),f=open(undefined,rpc)
 const event={...f.event([{type:'quote',message_id:'42'}]),platform:'qq',source_kind:'napcat',account_id:'bot',conversation_id:'group:123',metadata:{message_type:'group'}}
 expect((await f.media.displayQuotes(event))[0]).toMatchObject({preview:{sender:'小鱼',content:[{type:'text',text:'被引用的原文'},{type:'text',text:'[语音]'}]}})
 expect(await f.media.displayQuotes(event)).toEqual(await f.media.displayQuotes(event));expect(rpc).toHaveBeenCalledTimes(1)
 f.media.blockedUser=(_account,id)=>id==='456'
 expect(JSON.stringify(await f.media.displayQuotes(event))).not.toContain('被引用的原文')
 expect(JSON.stringify(await f.media.prepare(event,signal()))).not.toContain('被引用的原文')
 const other={...event,conversation_id:'group:999'}
 expect((await f.media.displayQuotes(other))[0]).toHaveProperty('unavailable')
 expect(JSON.stringify(await f.media.displayQuotes(other))).not.toContain('被引用的原文')
})

it('shows stored QQ quote text and bot receipts while transport is unavailable, without cross-private reads',async()=>{
 const rpc=vi.fn(async()=>{throw new Error('offline')}),f=open(undefined,rpc)
 const source={...f.event([{type:'text',text:'历史原文'}]),event_id:'old-source',source_kind:'napcat',platform:'qq',account_id:'bot',conversation_id:'private:456',actor_id:'456',metadata:{nickname:'朋友',message_id:'42'}}
 f.store.insertEvent(source)
 const event={...source,event_id:'new',content:[{type:'quote',message_id:'42'}]}
 expect((await f.media.displayQuotes(event))[0]).toMatchObject({preview:{sender:'朋友',content:[{text:'历史原文'}]}})
 expect(rpc).not.toHaveBeenCalled()
 f.store.insertEvent({...source,event_id:'bot-output',idempotency_key:'bot-output',source_kind:'output-gateway',actor_id:'role',metadata:{},content:[{type:'text',text:'我的旧回复'}]})
 f.store.setRecord('receipt','bot-output',{message_id:'43'})
 const outgoing={...event,source_kind:'output-gateway',metadata:{reply_to:'43'},content:[{type:'text',text:'新的回复'}]}
 expect((await f.media.displayQuotes(outgoing))[0]).toMatchObject({type:'quote',preview:{content:[{text:'我的旧回复'}]}})
 expect((await f.media.displayQuotes({...event,conversation_id:'private:999'}))[0]).toHaveProperty('unavailable')
})

it('filters blocked inbox members and identified quote/forward senders even when previews were cached',async()=>{
 const rpc=vi.fn(async(action:string)=>action==='get_msg'?{sender:{user_id:'456'},message:[{type:'text',data:{text:'blocked quote body'}}]}:{messages:[{sender:{user_id:'456',nickname:'blocked'},message:[{type:'text',data:{text:'blocked forward body'}}]},{sender:{user_id:'777',nickname:'allowed'},message:[{type:'text',data:{text:'allowed forward body'}}]}]})
 const f=open(MediaSettings.parse({}),rpc)
 f.media.blockedUser=(_account,user)=>user==='456';f.media.hasBlockedUsers=()=>true
 const quoted=f.event([{type:'quote',message_id:'q'},{type:'forward',forward_id:'f',preview:['blocked stale preview']}])
 f.store.insertEvent(quoted);f.store.setRecord('media-input',quoted.event_id,{version:2,content:[{type:'text',text:'blocked cached body'}]})
 const preview=(await f.media.prepare(quoted,signal())).filter(b=>b.type==='text').map(b=>b.text).join('\n')
 expect(preview).not.toContain('blocked quote body');expect(preview).not.toContain('blocked forward body');expect(preview).not.toContain('blocked stale preview');expect(preview).not.toContain('blocked cached body');expect(preview).toContain('allowed forward body')
 const expanded=(await f.media.forward(quoted.event_id,0,0,10,signal())).filter(b=>b.type==='text').map(b=>b.text).join('\n')
 expect(expanded).not.toContain('blocked forward body');expect(expanded).toContain('allowed forward body')
 f.media.canAdmit=()=>false
 expect(await f.media.prepare(quoted,signal())).toEqual([{type:'text',text:'[该来源用户已被屏蔽。]'}])
 await expect(f.media.forward(quoted.event_id,0,0,10,signal())).rejects.toThrow('来源不存在')
})

it('pins original outgoing file bytes for retries and preserves GIF animation in the Web attachment',async()=>{
  const f=open(),gif=Buffer.from('GIF89a1234567890'),path=join(f.dir,'motion.gif');writeFileSync(path,gif)
  const content=await f.media.outgoing([{type:'text',text:'前文'},{type:'image',path},{type:'text',text:'后文'}],[f.dir])
  expect(content.map(block=>block.type)).toEqual(['text','image','text'])
  expect(content[1]).toMatchObject({media_type:'image/gif',attachment:{name:'motion.gif'},path:join(f.dir,'stored-file')})
  expect(f.attachments.saveFile.mock.calls[0]![0].data.equals(gif)).toBe(true)
  await expect(f.media.outgoing([{type:'file',path}],['/unrelated-workspace'])).rejects.toThrow('授权工作区')
})

it('loads a migrated drawing by memory ID as an actual image and verifies the preserved original bytes',async()=>{
  const f=open(),path=join(f.dir,'old-drawing.png');writeFileSync(path,png)
  const record=f.memory.put({kind:'attachment',title:'缺页插图',text:'原鱼缸画作',created_at:f.memory.now(),source:{platform:'legacy'},
    data:{legacy_import:true,legacy_file:{path,name:'缺页.png',type:'image',sha256:createHash('sha256').update(png).digest('hex')}}})
  expect((await f.media.readMemory(record.id,signal())).some(block=>block.type==='image')).toBe(true)
  writeFileSync(path,'发生了变化')
  await expect(f.media.readMemory(record.id,signal())).rejects.toThrow('校验不符')
})

it('reads migrated native image references in their original text/image order',async()=>{
  const f=open(),record=f.memory.put({kind:'input',title:'旧来信',text:'前文后文',created_at:f.memory.now(),source:{platform:'legacy'},
    data:{legacy_import:true,blocks:[{type:'text',text:'前文'},{type:'image',attachment:{attachmentId:'old-image',mediaType:'image/png',width:1,height:1,bytes:png.length,name:'旧图.png'}},{type:'text',text:'后文'}]}})
  const content=await f.media.readMemory(record.id,signal())
  expect(content.map(block=>block.type)).toEqual(['text','image','text'])
  expect(f.attachments.readImage).toHaveBeenCalledTimes(1)
})

it('delivers a quiet image-only group message in order on the next wake, and acknowledges it only on admission',async()=>{
  const f=open();vi.spyOn(globalThis,'fetch').mockImplementation(async()=>new Response(png))
  const group=(id:string,content:ContentBlock[],schedule=false,conversation='group:456')=>({
    ...f.event(content),event_id:id,idempotency_key:id,source_kind:'napcat',platform:'qq',account_id:'123',conversation_id:conversation,
    metadata:{message_type:'group',schedule},received_at:`2026-11-03T16:04:0${id==='image'?0:1}.000Z` })
  const image=group('image',[{type:'image',url:'https://media.test/standalone'}]),
    other=group('other',[{type:'text',text:'其他群的秘密'}],false,'group:999'),
    wake=group('wake',[{type:'text',text:'看刚才的图'}],true)
  for(const e of [image,other,wake])f.store.insertEvent(e)
  const content=await f.media.inbox(wake,signal()), words=content.filter(b=>b.type==='text').map(b=>b.text).join('\n')
  expect(content.filter(b=>b.type==='image')).toHaveLength(1)
  expect(content.findIndex(b=>b.type==='image')).toBeLessThan(content.findIndex(b=>b.type==='text'&&b.text==='看刚才的图'))
  expect(words).not.toContain('其他群的秘密')
  expect(f.store.record('main-inbox-seen','image')).toBeUndefined()
  expect(await f.media.inbox(wake,signal())).toEqual(content)
  f.media.admitInbox(wake.event_id)
  expect(f.store.record('main-inbox-seen','image')).toBe(true)
  const later=group('later',[{type:'text',text:'下一条'}],true);later.received_at='2026-11-03T16:05:00.000Z';f.store.insertEvent(later)
  expect((await f.media.inbox(later,signal())).some(b=>b.type==='image')).toBe(false)
})

it('renders observation references with their real QQ source and lets explicit reads resolve the original attachment',async()=>{
  const f=open(),fetcher=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>new Response('原文件内容'))
  const source={...f.event([{type:'file',name:'notes.txt',url:'https://media.test/notes'}]),source_kind:'napcat',platform:'qq',
    account_id:'123',conversation_id:'group:456',metadata:{message_type:'group',nickname:'群友'}}
  f.store.insertEvent(source)
  const observation={...source,event_id:'observation',idempotency_key:'observation',source_kind:'qq-observation',content:[],visibility:'internal' as const,
    metadata:{origin_event_id:source.event_id,source_event_ids:[source.event_id]}}
  f.store.insertEvent(observation)
  const content=await f.media.inbox(observation,signal()),words=content.filter(b=>b.type==='text').map(b=>b.text).join('\n')
  expect(words).toContain('QQ 群聊');expect(words).not.toContain('网页');expect(words).toContain('[文件：notes.txt]')
  expect(fetcher).not.toHaveBeenCalled()
  expect((await f.media.read(observation.event_id,0,signal())).some(b=>b.type==='text'&&b.text.includes('原文件内容'))).toBe(true)
})

it('preserves inline text/image order, stores original bytes and never opens video/files automatically',async () => {
  const f=open(), fetcher=vi.spyOn(globalThis,'fetch').mockImplementation(async () => new Response(png,{headers:{'content-type':'application/octet-stream'}}))
  const e=f.event([{type:'text',text:'前文'},{type:'image',url:'https://media.test/one'},{type:'text',text:'中间'},
    {type:'image',url:'https://media.test/two'},{type:'text',text:'后文'},{type:'video',url:'https://media.test/video',original:{thumb:'https://media.test/cover'}},{type:'file',name:'notes.txt',url:'https://media.test/file'}])
  const content=await f.media.prepare(e,signal())
  expect(content.slice(0,5).map(block=>block.type)).toEqual(['text','image','text','image','text'])
  expect(content.filter(block=>block.type==='text').slice(0,3).map(block=>block.text)).toEqual(['前文','中间','后文'])
  expect(fetcher).toHaveBeenCalledTimes(3)
  expect(fetcher.mock.calls.some(([url])=>String(url)==='https://media.test/video'||String(url)==='https://media.test/file')).toBe(false)
  expect(f.attachments.saveFile.mock.calls.map(([input])=>input.data)).toEqual([png,png])
  expect(content.slice(5).map(block=>block.type)).toEqual(['text','image','text'])
  expect(content.at(-1)).toEqual({type:'text',text:'[文件：notes.txt]'})
  expect(await f.media.prepare(e,signal())).toEqual(content)
  expect(fetcher).toHaveBeenCalledTimes(3)
})

it('reads files only on an explicit tool call, within the current role',async () => {
  const f=open(), fetcher=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>new Response('文件原文甲乙丙'))
  const e=f.event([{type:'file',name:'notes.txt',url:'https://media.test/notes'}]);f.store.insertEvent(e)
  await f.media.prepare(e,signal());expect(fetcher).not.toHaveBeenCalled()
  const content=await f.media.read(e.event_id,0,signal())
  expect(content.some(block=>block.type==='text'&&block.text.includes('文件原文甲乙丙'))).toBe(true)
  const followup=f.event([{type:'text',text:'现在想读刚才的文件'}]);f.store.insertEvent(followup)
  expect(f.media.sourceForName(followup.event_id,'notes.txt')).toEqual({eventId:e.event_id,index:0})
  await expect(f.media.read('missing',0,signal())).rejects.toThrow('来源不存在')
})

it('resolves mention names and explicitly distinguishes another member from this account',async () => {
  const rpc=vi.fn(async(_action:string,_params:Record<string,unknown>)=>({nickname:'测试群友'}))
  const f=open(MediaSettings.parse({}),rpc), e={...f.event([{type:'mention',platform:'qq',actor_id:'999'},
    {type:'mention',platform:'qq',actor_id:'123',display_name:'测试角色'}]),platform:'qq',source_kind:'napcat',account_id:'123',conversation_id:'group:456'}
  const content=await f.media.prepare(e,signal())
  expect(content).toEqual([{type:'text',text:'@测试群友（QQ:999，叫的是别人）'},{type:'text',text:'@测试角色（QQ:123，叫你）'}])
  expect(rpc).toHaveBeenCalledWith('get_group_member_info',{group_id:'456',user_id:'999'})
})

it('shows native forward card preview without expanding, and renders referenced messages in place',async () => {
  const rpc=vi.fn(async(action:string)=>action==='get_msg'?{time:123,sender:{nickname:'小林'},message:[{type:'text',data:{text:'引用的原文'}}]}:{messages:[{time:124,sender:{nickname:'小林'},message:[{type:'text',data:{text:'内部全文'}}]}]})
  const f=open(MediaSettings.parse({}),rpc as never)
  const e=f.event([{type:'text',text:'前'},{type:'quote',message_id:'42'},
    {type:'forward',forward_id:'forward-1',title:'群聊的聊天记录',preview:['小林: [图片]','小林: 这是什么'],summary:'查看4条转发消息'},{type:'text',text:'后'}]);f.store.insertEvent(e)
  const content=await f.media.prepare(e,signal()), joined=content.filter(b=>b.type==='text').map(b=>b.text).join('\n')
  expect(joined).toContain('小林: [图片]');expect(joined).toContain('查看4条转发消息');expect(joined).toContain('引用的原文');expect(joined).not.toContain('内部全文')
  expect(rpc.mock.calls.map(([action])=>action)).toEqual(['get_msg'])
  expect((await f.media.forward(e.event_id,0,0,5,signal())).some(b=>b.type==='text'&&b.text==='内部全文')).toBe(true)
})

it('builds a compact human-style forward preview in Runtime and reveals the remaining text only on an explicit read',async()=>{
  const messages=Array.from({length:5},(_,index)=>({sender:{nickname:'东方铁蛋'},message:index===0?[{type:'image',data:{url:'https://media.test/private-image'}}]:[{type:'text',data:{text:index===4?'只有主动展开才能看到这句':'这异环在搞啥'}}]}))
  const rpc=vi.fn(async(_action:string,_params:Record<string,unknown>)=>({messages})),f=open(MediaSettings.parse({}),rpc)
  const e=f.event([{type:'forward',forward_id:'native-id'}]);f.store.insertEvent(e)
  const content=await f.media.prepare(e,signal()),preview=content.filter(block=>block.type==='text').map(block=>block.text).join('\n')
  expect(preview).toContain('东方铁蛋: [图片]');expect(preview).toContain('查看5条转发消息');expect(preview).not.toContain('https://');expect(preview).not.toContain('只有主动展开才能看到这句')
  expect(content.some(block=>block.type==='image')).toBe(false)
  expect((await f.media.forward(e.event_id,0,4,1,signal())).some(block=>block.type==='text'&&block.text==='只有主动展开才能看到这句')).toBe(true)
  expect(rpc).toHaveBeenCalledTimes(1)
})

it('defaults a long GIF to five quiet frames and admits more only on explicit read',async()=>{
  const f=open(),gif=join(f.dir,'long.gif'),exec=promisify(execFile)
  await exec('ffmpeg',['-v','error','-f','lavfi','-i','testsrc=size=32x32:rate=20:duration=2','-y',gif])
  vi.spyOn(globalThis,'fetch').mockImplementation(async()=>new Response(readFileSync(gif)))
  const event=f.event([{type:'image',url:'https://media.test/long.gif',name:'long.gif'}]);f.store.insertEvent(event)
  const normal=await f.media.prepare(event,signal())
  expect(normal.filter(b=>b.type==='image')).toHaveLength(5)
  expect(normal.filter(b=>b.type==='text').map(b=>b.text).join('')).not.toMatch(/第\d+帧|frame-\d|秒|amphoreus-media-/)
  const more=await f.media.read(event.event_id,0,signal(),9)
  expect(more.filter(b=>b.type==='image')).toHaveLength(9)
  expect(f.attachments.saveFile).toHaveBeenCalled()
  expect(JSON.stringify(f.memory.recent(10))).not.toContain('base64')
})

it('extracts ordered GIF frames and sends voice through the configured MiMo v2.5 ASR',async () => {
  const f=open(MediaSettings.parse({asr:{baseUrl:'https://mimo.test/v1',apiKey:'private-test-key',model:'mimo-v2.5-asr'}}))
  const gif=join(f.dir,'sample.gif'),mp3=join(f.dir,'sample.mp3'),exec=promisify(execFile)
  await exec('ffmpeg',['-v','error','-f','lavfi','-i','color=c=red:s=16x16:r=2:d=0.5','-f','lavfi','-i','color=c=blue:s=16x16:r=2:d=0.5',
    '-filter_complex','[0:v][1:v]concat=n=2:v=1:a=0','-y',gif])
  await exec('ffmpeg',['-v','error','-f','lavfi','-i','anullsrc=r=16000:cl=mono','-t','0.2','-y',mp3])
  f.rpc.mockResolvedValue({ base64: readFileSync(mp3).toString('base64') })
  const fetcher=vi.spyOn(globalThis,'fetch').mockImplementation(async(url,options)=>{
    if(String(url).includes('chat/completions')) {
      const body=JSON.parse(String(options?.body));expect(body.model).toBe('mimo-v2.5-asr');expect(body.messages[0].content[0].type).toBe('input_audio')
      return Response.json({choices:[{message:{content:'语音识别验收'}}]})
    }
    return new Response(readFileSync(String(url).endsWith('gif')?gif:mp3))
  })
  const content=await f.media.prepare(f.event([{type:'image',name:'sample.gif',url:'https://media.test/sample.gif'},
    {type:'audio',platform:'qq',name:'sample.mp3',url:'https://media.test/sample.silk',original:{file:'voice.silk'}}]),signal())
  expect(content.filter(block=>block.type==='image').length).toBeGreaterThan(1)
  expect(content.filter(block=>block.type==='image').length).toBeLessThanOrEqual(5)
  const modelText=content.filter(block=>block.type==='text').map(block=>block.text).join('\n')
  expect(modelText).not.toMatch(/第\d+帧|frame-\d|amphoreus-media-|约\d+\.\d+秒/)
  const frameBytes=f.attachments.saveImage.mock.calls.map(([input])=>Buffer.from(input.data).toString('base64'))
  expect(new Set(frameBytes).size).toBeGreaterThan(1)
  expect(content.some(block=>block.type==='text'&&block.text.includes('语音识别验收'))).toBe(true)
  expect(fetcher.mock.calls.some(([url])=>String(url)==='https://mimo.test/v1/chat/completions')).toBe(true)
})

it('admits a library picker file attachment as an inline image without a download URL',async()=>{
 const f=open();writeFileSync(join(f.dir,'stored-file'),png)
 const event=f.event([{type:'text',text:'前'},{type:'image',attachment:{attachmentId:'stored',name:'picked.png'}},{type:'text',text:'后'}])
 const content=await f.media.prepare(event,signal())
 expect(content.map(block=>block.type)).toEqual(['text','image','text'])
 expect(f.store.records<any>('media-original').some(record=>record.event_id===event.event_id)).toBe(true)
})
