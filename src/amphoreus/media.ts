/** Durable media admission: native images, animation/video frames, speech transcripts and verbatim files. */
import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock as ModelBlock } from '@deepseek-ai/dsh-llm'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, readdir, rm, writeFile,realpath,stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, join,relative,isAbsolute,resolve } from 'node:path'
import { z } from 'zod'
import { createHash } from 'node:crypto'
import type { ContentBlock, GatewayEvent } from './model.ts'
import type { AmphoreusStore } from './store.ts'
import { MemoryStore, memoryId } from './memory.ts'
import { safeMedia, qqBlocks } from './qq.ts'
import { mainInput } from './main-input.ts'

export const MediaSettings = z.object({ asr: z.object({ baseUrl: z.url(), apiKey: z.string().min(1), model: z.string().default('mimo-v2.5-asr') }).strict().optional() }).strict().prefault({})
type Rpc = (action: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>
const exec = promisify(execFile), LIMIT = 100 * 1024 * 1024
const text = (value: string): ModelBlock => ({ type: 'text', text: value })
function imageType(bytes: Buffer): 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' {
  if (bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (['GIF87a','GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif'
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp'
  throw new Error('图片编码不受支持')
}

async function download(url: string, signal: AbortSignal) {
  const safe = safeMedia(url)
  if (!safe) throw new Error('附件地址无效')
  const response = await fetch(safe, { signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]), redirect: 'error' })
  if (!response.ok || !response.body) throw new Error('附件下载失败')
  if (Number(response.headers.get('content-length')) > LIMIT) { await response.body.cancel(); throw new Error('附件超过100MB') }
  const chunks: Uint8Array[] = []; let length = 0
  for await (const chunk of response.body) {
    length += chunk.byteLength
    if (length > LIMIT) { await response.body.cancel().catch(() => {}); throw new Error('附件超过100MB') }
    chunks.push(chunk)
  }
  return { bytes: Buffer.concat(chunks), mediaType: response.headers.get('content-type')?.split(';')[0] ?? '' }
}

export class MediaInput {
  private readonly quotes = new Map<string, Promise<{ sender: string; actor_id: string; timestamp: string; content: ContentBlock[] }>>()
  canAdmit:(event:GatewayEvent)=>boolean=()=>true
  blockedUser:(account:string,user:string)=>boolean=()=>false
  hasBlockedUsers:()=>boolean=()=>false
  constructor(private readonly attachments: Context['attachments'], private readonly store: AmphoreusStore,
    private readonly memory: MemoryStore, private readonly settings: z.infer<typeof MediaSettings>, private readonly rpc?: Rpc) {}
  private async quote(event: GatewayEvent, id: string) {
    const key=JSON.stringify([event.agent_id,event.account_id,event.conversation_id,id])
    const load=async()=>{
      const cached=this.store.record<{sender:string;actor_id:string;timestamp:string;content:ContentBlock[]}>('qq-quote',key)
      if(cached)return cached
      const source=this.store.qqMessage(event,id)
      let result:{sender:string;actor_id:string;timestamp:string;content:ContentBlock[]}
      if(source){
        result={sender:String(source.metadata.nickname||source.actor_id),actor_id:source.actor_id,timestamp:source.timestamp,content:source.content.map((block,index)=>block.attachment&&source.source_kind==='output-gateway'?{...block,url:`/api/output-media/${source.event_id}/${index}`}:block)}
      }else{
        if(!this.rpc)throw new Error('引用服务暂不可用')
        const raw=await this.rpc('get_msg',{message_id:id}),sender=raw.sender as Record<string,unknown>|undefined
        if(event.platform==='qq'){
          if(event.conversation_id.startsWith('group:')){
            if(String(raw.group_id)!==event.conversation_id.slice(6))throw new Error('引用不属于当前群聊')
          }else{
            const peer=event.conversation_id.replace(/^private:/,'')
            if(raw.message_type==='group'||raw.group_id||![raw.user_id,raw.target_id,raw.peer_id,sender?.user_id].some(value=>value!==undefined&&String(value)===peer))throw new Error('引用不属于当前私聊')
          }
        }
        const body=raw.message??raw.raw_message
        result={sender:String(sender?.card||sender?.nickname||sender?.user_id||'未知发送者'),actor_id:String(sender?.user_id??raw.user_id??''),timestamp:typeof raw.time==='number'?new Date(raw.time*1000).toISOString():'',content:typeof body==='string'||Array.isArray(body)?qqBlocks(body as never):[{type:'text',text:'[引用正文不可用]'}]}
      }
      this.store.setRecord('qq-quote',key,result);return result
    }
    let pending=this.quotes.get(key)
    if(!pending){pending=load().finally(()=>this.quotes.delete(key));this.quotes.set(key,pending)}
    const result=await pending
    if(this.blockedUser(event.account_id,result.actor_id))return {...result,sender:'已屏蔽用户',content:[{type:'text',text:'[已屏蔽用户的引用内容]'}]}
    return result
  }
  /** UI quote previews share the scoped runtime resolver; never depend on the current page of history. */
  async displayQuotes(event: GatewayEvent): Promise<ContentBlock[]> {
    if(event.platform!=='qq')return event.content
    const reply=event.metadata.reply_to
    const content=reply&&!event.content.some(block=>block.type==='quote'&&String(block.message_id)===String(reply))?[{type:'quote',message_id:String(reply)},...event.content]:event.content
    const result:ContentBlock[]=[];let count=0
    for(const block of content){
      if(block.type!=='quote'||++count>4){result.push(block);continue}
      try{
        const value=await this.quote(event,String(block.message_id))
        const preview=value.content.slice(0,30).map(item=>['text','mention','emoji','image'].includes(item.type)?item:{type:'text',text:item.type==='file'?`[文件：${item.name??'未命名文件'}]`:item.type==='forward'?'[聊天记录]':item.type==='audio'?'[语音]':item.type==='video'?'[视频]':'[引用消息]'})
        result.push({...block,preview:{sender:value.sender,timestamp:value.timestamp,content:preview}})
      }catch{result.push({...block,unavailable:'引用原文暂不可用，可能已撤回或过期'})}
    }
    return result
  }
  async outgoing(blocks:ContentBlock[],roots:string[]):Promise<ContentBlock[]>{
    const result:ContentBlock[]=[]
    for(const block of blocks){
      if(!['image','audio','video','file'].includes(block.type)||safeMedia(block.url)){result.push(block);continue}
      const existing=block.attachment as {width?:number}|undefined
      const raw=typeof block.path==='string'?block.path:typeof block.url==='string'&&isAbsolute(block.url)?block.url:
        existing?(existing.width?this.attachments.imageHostPath(existing as never):this.attachments.fileHostPath(existing as never)):undefined
      if(!raw)throw new Error('多模态消息缺少附件')
      const path=await realpath(raw);let allowed=false
      for(const root of roots){try{const child=relative(await realpath(resolve(root)),path);if(child&&!child.startsWith('..')&&!isAbsolute(child))allowed=true}catch{}}
      const info=await stat(path)
      if(!allowed||!info.isFile()||info.size>50*1024*1024)throw new Error('附件须在授权工作区内且不超过50MB')
      const bytes=await readFile(path),name=String(block.name??basename(path)),attachment=await this.attachments.saveFile({data:bytes,name})
      const types:Record<string,string>={'.mp3':'audio/mpeg','.wav':'audio/wav','.ogg':'audio/ogg','.mp4':'video/mp4','.webm':'video/webm'}
      result.push({...block,path:this.attachments.fileHostPath(attachment),attachment,name,media_type:block.type==='image'?imageType(bytes):types[extname(name).toLowerCase()]??'application/octet-stream'})
    }
    return result
  }
  async outputFile(block:ContentBlock){
    if(!block.attachment)throw new Error('输出附件不存在')
    const ref=block.attachment as {width?:number},path=ref.width?this.attachments.imageHostPath(ref as never):this.attachments.fileHostPath(ref as never)
    if(!path)throw new Error('附件后端不支持本地读取')
    const info=await stat(path)
    return {path,bytes:info.size,name:String(block.name??'附件'),mediaType:String(block.media_type??'application/octet-stream')}
  }
  async readMemory(id:string,signal:AbortSignal,frames=5):Promise<ModelBlock[]>{
    const record=this.memory.get(id),file=record?.data.legacy_file as {path?:string;sha256?:string;name?:string;type?:string}|undefined
    if(!record||!record.data.legacy_import)throw new Error('历史附件不存在')
    if(!file?.path&&Array.isArray(record.data.blocks)){
      const content:ModelBlock[]=[]
      for(const block of record.data.blocks as ContentBlock[]){
        if(block.type==='text')content.push(text(String(block.text??'')))
        else if(block.type==='image'&&block.attachment){
          const stored=await this.attachments.readImage(block.attachment as never,signal)
          content.push(...await this.admit({type:'image',name:stored.ref.name},{event_id:`legacy-memory:${id}`,memory_id:id},signal,Math.min(frames,this.attachments.imageLimits.maxImagesPerMessage),Buffer.from(stored.data),frames))
        }else if(block.type==='file'&&block.attachment)content.push({type:'file',attachment:block.attachment as never})
      }
      if(content.length)return content
    }
    if(!file?.path||!file.sha256)throw new Error('历史附件不存在')
    const info=await stat(file.path)
    if(!info.isFile()||info.size>LIMIT)throw new Error('历史附件超过直接读取上限，请交工具助手读取原文件')
    const bytes=await readFile(file.path);signal.throwIfAborted()
    if(createHash('sha256').update(bytes).digest('hex')!==file.sha256)throw new Error('历史附件校验不符，原始记录保留，请检查迁移目录')
    let type=file.type??'file'
    if(type==='file'){try{imageType(bytes);type='image'}catch{}}
    return this.admit({type,name:file.name??basename(file.path)},
      {event_id:record.source.event_id??`legacy-memory:${record.id}`,memory_id:record.id},signal,Math.min(frames,this.attachments.imageLimits.maxImagesPerMessage),bytes,frames)
  }
  /** Quiet group messages are still messages. Admit their original ordered blocks on the next wake. */
  async inbox(event: GatewayEvent, signal: AbortSignal, includeUnread=true): Promise<ModelBlock[]> {
    let ids = this.store.record<string[]>('main-inbox-plan', event.event_id)
    if(!includeUnread&&event.source_kind==='napcat')ids=undefined
    if (!ids) {
      const refs = ['qq-observation','qq-debounce'].includes(event.source_kind) && Array.isArray(event.metadata.source_event_ids)
        ? event.metadata.source_event_ids.filter((id):id is string => typeof id === 'string') : undefined
      const unread = includeUnread && event.source_kind === 'napcat' && event.metadata.message_type === 'group'
        ? this.store.events({ agentId: event.agent_id, sourceKind: 'napcat', platform: event.platform,
          accountId: event.account_id, conversationId: event.conversation_id, limit: 200 }).reverse()
          .map(row => row.event).filter(past => past.received_at <= event.received_at && past.event_id !== event.event_id
            && past.metadata.schedule === false && !this.store.record('main-inbox-seen', past.event_id)).slice(-19)
        : []
      ids = refs ?? [...unread.map(past => past.event_id), event.event_id]
      ids = ids.filter(id => !this.store.record('main-inbox-seen',id)&&this.store.event(id)?.event.metadata.qq_receive_enabled!==false)
      this.store.setRecord('main-inbox-plan', event.event_id, ids)
    }
    const content: ModelBlock[] = []
    if (ids.length > 1) content.push(text('同一群的未读消息（按顺序；看见不代表需要回复）：'))
    for (const id of ids) {
      const source = id === event.event_id ? event : this.store.event(id)?.event
      if (!source || source.agent_id!==event.agent_id || source.platform!==event.platform || source.account_id!==event.account_id || source.conversation_id!==event.conversation_id||!this.canAdmit(source)) continue
      content.push(text(mainInput({ ...source, content: [] })), ...await this.prepare(source, signal))
    }
    return content.length ? content : [text('这批群聊已在主对话中看过，无需重复回复。')]
  }
  /** Called only after DSH has actually admitted the delivery, never when probability declines a wake. */
  admitInbox(eventId: string): void {
    this.store.atomic(() => {
      for (const id of this.store.record<string[]>('main-inbox-plan', eventId) ?? []) {
        this.store.setRecord('main-inbox-seen', id, true)
      }
    })
  }
  async prepare(event: GatewayEvent, signal: AbortSignal): Promise<ModelBlock[]> {
    if(!this.canAdmit(event))return [text('[该来源用户已被屏蔽。]')]
    const nested=event.content.some(block=>['quote','forward'].includes(block.type))
    const cached = this.store.record<{ content: ModelBlock[]; version?:number }>('media-input', event.event_id)
    if (!nested&&cached?.version===2) return cached.content
    const content = await this.render(event.content, event, signal)
    if (event.content.some(block => ['image','audio','video','quote','forward'].includes(block.type))) {
      this.store.setRecord('media-input', event.event_id, { content,version:2 })
      this.memory.put({ id: memoryId('media', event.event_id), kind: 'attachment', title: '附件内容与读取结果',
        text: content.filter(item => item.type === 'text').map(item => item.text).join('\n'), created_at: event.timestamp,
        source: { event_id: event.event_id, platform: event.platform, actor_id: event.actor_id, account_id: event.account_id, conversation_id: event.conversation_id },
        data: { content } })
    }
    return content
  }
  private async render(blocks: ContentBlock[], event: GatewayEvent, signal: AbortSignal, depth = 0,
    budget = { images: Math.min(16, this.attachments.imageLimits.maxImagesPerMessage), media: 0 }): Promise<ModelBlock[]> {
    const content: ModelBlock[] = []
    for (const block of blocks) {
      signal.throwIfAborted()
      const media = ['image','audio','video','file'].includes(block.type), mediaIndex = budget.media
      if (media) budget.media++
      try {
        if (block.type === 'text') content.push(text(String(block.text ?? '')))
        else if (['image','audio'].includes(block.type)) {
          const admitted = await this.admit(block, event, signal, budget.images)
          budget.images -= admitted.filter(item => item.type === 'image').length
          content.push(...admitted)
        }
        else if (block.type === 'video') {
          content.push(text(`[视频${mediaIndex + 1}]`))
          if (budget.images > 0) {
            content.push(...await this.cover(block, signal)); budget.images--
          }
        }
        else if (block.type === 'file') content.push(text(`[文件：${block.name ?? '未命名文件'}]`))
        else if (block.type === 'quote' && depth < 2) {
          const quoted = await this.quote(event,String(block.message_id))
          content.push(text(`引用 ${quoted.sender}：`))
          content.push(...await this.render(quoted.content,event,signal,depth+1,budget))
          content.push(text('引用结束。'))
        } else if (block.type === 'forward') {
          let preview = block
          if ((!Array.isArray(block.preview)||this.hasBlockedUsers()) && this.rpc) {
            const result = await this.forwardData(event.event_id, String(block.forward_id ?? ''))
            const messages = (Array.isArray(result.messages) ? result.messages as Record<string, unknown>[] : []).filter(message=>{
              const sender=message.sender as Record<string,unknown>|undefined
              return !this.blockedUser(event.account_id,String(sender?.user_id??message.user_id??''))
            })
            preview = { ...block, count: messages.length, summary: `查看${messages.length}条转发消息`, preview: messages.slice(0,4).map(message => {
              const sender = message.sender as Record<string, unknown> | undefined
              const nodes = message.content ?? message.message
              const body = Array.isArray(nodes) ? nodes.map((node: { type?: string; data?: Record<string, unknown> }) => node.type === 'text' ? String(node.data?.text ?? '')
                : ({image:'[图片]',record:'[语音]',video:'[视频]',file:'[文件]',forward:'[聊天记录]',face:'[表情]',reply:'[引用]'} as Record<string,string>)[node.type ?? ''] ?? '[卡片]').join('') : ''
              const line = `${sender?.card || sender?.nickname || sender?.user_id || '未知发送者'}: ${body.replace(/https?:\/\/\S+/g,'[链接]').replace(/\s+/g,' ')}`
              return Array.from(line).length > 48 ? Array.from(line).slice(0,48).join('')+'…' : line
            }) }
          }
          if(this.hasBlockedUsers()&&!this.rpc){content.push(text('[转发预览无法核验发送者，已省略；原件保留。]'));continue}
          content.push(text(this.forwardPreview(preview)))
        }
        else if (block.type === 'mention' && block.platform === 'qq') {
          const key = `${event.account_id}:${event.conversation_id}:${block.actor_id}`
          let name = typeof block.display_name === 'string' ? block.display_name : this.store.record<{ name: string }>('qq-mention-name', key)?.name
          if (!name && block.actor_id !== 'all' && this.rpc) {
            try {
              const group = event.conversation_id.startsWith('group:')
              const info = await this.rpc(group ? 'get_group_member_info' : 'get_stranger_info', group
                ? { group_id: event.conversation_id.slice(6), user_id: block.actor_id } : { user_id: block.actor_id })
              name = String(info.card || info.nickname || block.actor_id)
              this.store.setRecord('qq-mention-name', key, { name })
            } catch { name = String(block.actor_id ?? '') }
          }
          content.push(text(block.actor_id === 'all' ? '@全体成员'
            : `@${name || block.actor_id}（QQ:${block.actor_id}，${String(block.actor_id) === event.account_id ? '叫你' : '叫的是别人'}）`))
        }
        else if (block.type === 'emoji') content.push(text(`[表情${block.emoji_id ?? ''}]`))
        else if (block.type === 'platform') content.push(text(`[${String(block.title || block.platform_type || '平台消息').replace(/https?:\/\/\S+/g,'[链接]').slice(0,300)}]`))
        else content.push(text(`[${block.type}]`))
      } catch (error) {
        signal.throwIfAborted()
        const reason = error instanceof Error && /^[\u4e00-\u9fff\dA-Za-z，。：；（）/ .-]{1,80}$/.test(error.message) ? error.message : '下载或解析未完成'
        content.push(text(`[${block.type}读取失败：${reason}。不能声称已看见或听见。]`))
      }
    }
    return content
  }
  private forwardPreview(block: ContentBlock): string {
    const preview = Array.isArray(block.preview) ? block.preview.map(line => typeof line === 'string' ? line : String((line as Record<string, unknown>)?.text ?? '')).slice(0,4) : []
    return [String(block.title || '群聊的聊天记录'), ...preview, String(block.summary || (block.count ? `查看${block.count}条转发消息` : '查看转发消息')),
      ].join('\n')
  }
  private async forwardData(eventId: string, forwardId: string) {
    const key = `${eventId}:${forwardId}`
    let result = this.store.record<Record<string, unknown>>('forward-content', key)
    if (!result) {
      if (!this.rpc || !forwardId) throw new Error('转发来源不可用')
      result = await this.rpc('get_forward_msg', { message_id: forwardId })
      this.store.setRecord('forward-content', key, result)
    }
    return result
  }
  private async cover(block: ContentBlock, signal: AbortSignal): Promise<ModelBlock[]> {
    const original = block.original as Record<string, unknown> | undefined
    const thumbnail = safeMedia(block.cover_url ?? original?.thumb ?? original?.thumbnail ?? original?.cover ?? original?.cover_url)
    let bytes: Buffer
    if (thumbnail) bytes = (await download(thumbnail, signal)).bytes
    else {
      const url = safeMedia(block.url)
      if (!url) throw new Error('视频封面暂不可用')
      const result = await exec('ffmpeg', ['-nostdin','-v','error','-rw_timeout','10000000','-i',url,'-an','-sn','-frames:v','1',
        '-vf','scale=960:960:force_original_aspect_ratio=decrease','-f','image2pipe','-c:v','mjpeg','pipe:1'],
        { signal, timeout: 15000, maxBuffer: 4 * 1024 * 1024, encoding: 'buffer' })
      bytes = result.stdout
    }
    return [{ type: 'image', attachment: await this.attachments.saveImage({ data: bytes, mediaType: imageType(bytes), name: 'video-cover.jpg' }) }]
  }
  resolveIndex(eventId: string, name: string): number {
    const blocks = this.mediaBlocks(eventId)
    const indices = blocks.flatMap((block,index) => String(block.name ?? '') === name ? [index] : [])
    const video = /^视频(\d+)$/.exec(name)
    if (!indices.length && video && blocks[Number(video[1])-1]?.type === 'video') return Number(video[1])-1
    if (!indices.length) throw new Error('文件名不属于此消息')
    if (indices.length > 1) throw new Error(`同名附件有多个，请指定index：${indices.join(',')}`)
    return indices[0]!
  }
  sourceForName(eventId: string, name: string): { eventId: string; index: number } {
    const current = this.sourceEvent(eventId)
    if (!current || current.agent_id !== this.memory.agentId) throw new Error('附件来源不存在')
    const candidates = [current, ...this.store.events({ agentId: current.agent_id, platform: current.platform, accountId: current.account_id, conversationId: current.conversation_id, limit: 100 })
      .map(row => row.event).filter(event => event.event_id !== current.event_id && ['web','napcat'].includes(event.source_kind))]
    for (const event of candidates) {
      try { return { eventId: event.event_id, index: this.resolveIndex(event.event_id,name) } }
      catch (error) { if (error instanceof Error && error.message.startsWith('同名附件')) throw error }
    }
    throw new Error('近期同一会话中没有此附件')
  }
  private mediaBlocks(eventId: string): ContentBlock[] {
    const event = this.sourceEvent(eventId)
    if (!event || event.agent_id !== this.memory.agentId||!this.canAdmit(event)) return []
    eventId=event.event_id
    const direct = event.content.filter(block => ['image','audio','video','file'].includes(block.type))
    if (direct.length) return direct
    return event.content.filter(block => block.type === 'forward').flatMap(block => {
      const cached = this.store.record<Record<string, unknown>>('forward-content',`${eventId}:${block.forward_id}`)
      return (Array.isArray(cached?.messages) ? cached.messages as Record<string, unknown>[] : []).filter(message=>!this.blockedUser(event.account_id,String((message.sender as Record<string,unknown>|undefined)?.user_id??message.user_id??''))).flatMap(message =>
        Array.isArray(message.content ?? message.message) ? qqBlocks((message.content ?? message.message) as never).filter(block => ['image','audio','video','file'].includes(block.type)) : [])
    })
  }
  async forward(eventId: string, index: number, offset: number, limit: number, signal: AbortSignal): Promise<ModelBlock[]> {
    const wake = this.store.event(eventId)?.event
    if (!wake || wake.agent_id !== this.memory.agentId || !this.canAdmit(wake)||!this.rpc) throw new Error('转发来源不存在')
    // Match the cards actually delivered by inbox(), not just the batch's final origin message.
    const ids = this.store.record<string[]>('main-inbox-plan', eventId)
      ?? (['qq-observation','qq-debounce'].includes(wake.source_kind) && Array.isArray(wake.metadata.source_event_ids)
        ? wake.metadata.source_event_ids.filter((id):id is string => typeof id === 'string')
        : [this.sourceEvent(eventId)?.event_id ?? eventId])
    const cards: { event: GatewayEvent; block: ContentBlock }[] = []
    const collect = async (blocks: ContentBlock[], event: GatewayEvent, depth = 0): Promise<void> => {
      for (const block of blocks) {
        signal.throwIfAborted()
        if (block.type === 'forward') cards.push({ event, block })
        else if (block.type === 'quote' && depth < 2) {
          let quoted
          try { quoted = await this.quote(event, String(block.message_id)) }
          catch { signal.throwIfAborted(); continue }
          await collect(quoted.content, event, depth + 1)
        }
      }
    }
    for (const id of ids) {
      const source = this.store.event(id)?.event
      if (!source || source.agent_id !== wake.agent_id || source.platform !== wake.platform || source.account_id !== wake.account_id
        || source.conversation_id !== wake.conversation_id || source.metadata.qq_receive_enabled === false || !this.canAdmit(source)) continue
      await collect(source.content, source)
    }
    const selected = cards[index]
    if (!selected) throw new Error('转发编号不存在（按本次唤醒中卡片出现顺序，从0起）')
    const { event, block } = selected
    eventId = event.event_id
    const result = await this.forwardData(eventId,String(block.forward_id ?? ''))
    const messages = Array.isArray(result.messages) ? result.messages : []
    const content: ModelBlock[] = [text(`展开第${offset + 1}至${Math.min(messages.length, offset + limit)}条；共${messages.length}条。`)]
    const preceding = (messages.slice(0,offset) as Record<string, unknown>[]).flatMap(message => Array.isArray(message.content ?? message.message) ? qqBlocks((message.content ?? message.message) as never).filter(block => ['image','audio','video','file'].includes(block.type)) : [])
    const budget = { images: Math.min(16, this.attachments.imageLimits.maxImagesPerMessage), media: preceding.length }
    for (const message of messages.slice(offset, offset + limit) as Record<string, unknown>[]) {
      const sender = message.sender as Record<string, unknown> | undefined
      if(this.blockedUser(event.account_id,String(sender?.user_id??message.user_id??'')))continue
      content.push(text(`${sender?.nickname || sender?.user_id || '未知发送者'} · ${message.time ?? ''}：`))
      if (Array.isArray(message.content ?? message.message)) content.push(...await this.render(qqBlocks((message.content ?? message.message) as never), event, signal, 0, budget))
    }
    return content
  }
  async read(eventId: string, index: number, signal: AbortSignal, frames=5): Promise<ModelBlock[]> {
    const event = this.sourceEvent(eventId)
    if (!event || event.agent_id !== this.memory.agentId) throw new Error('附件来源不存在')
    const block = this.mediaBlocks(eventId)[index]
    if (!block) throw new Error('附件编号不存在')
    return this.admit(block, event, signal, Math.min(frames, this.attachments.imageLimits.maxImagesPerMessage),undefined,frames)
  }
  private sourceEvent(id:string):GatewayEvent|undefined {
    const event=this.store.event(id)?.event
    if(!event||!['qq-observation','qq-debounce'].includes(event.source_kind))return event
    const source=this.store.event(String(event.metadata.origin_event_id))?.event
    return source&&source.agent_id===event.agent_id&&source.platform===event.platform&&source.account_id===event.account_id&&source.conversation_id===event.conversation_id?source:undefined
  }
  private async bytes(block: ContentBlock, signal: AbortSignal) {
    if(block.attachment){
      signal.throwIfAborted()
      const ref=block.attachment as {width?:number}
      if(ref.width){const stored=await this.attachments.readImage(ref as never,signal);return{bytes:Buffer.from(stored.data),mediaType:stored.ref.mediaType}}
      const path=this.attachments.fileHostPath(ref as never)
      const info=path?await stat(path):undefined
      if(!path||!info?.isFile()||info.size>LIMIT)throw new Error('原始附件不存在或超过100MB')
      const bytes=await readFile(path);return{bytes,mediaType:imageType(bytes)}
    }
    if (safeMedia(block.url) && !(block.type === 'audio' && block.platform === 'qq' && this.rpc)) return download(String(block.url), signal)
    const original = block.original as Record<string, unknown> | undefined
    const file = String(original?.file_id ?? original?.file ?? block.name ?? '')
    if (!this.rpc || !file) throw new Error('附件缺少可下载地址')
    const result = await this.rpc(block.type === 'audio' ? 'get_record' : block.type === 'image' ? 'get_image' : 'get_file',
      block.type === 'audio' ? { file, out_format: 'mp3' } : block.type === 'image' ? { file } : { file_id: file })
    if (block.type === 'audio' && typeof result.base64 === 'string') {
      if (result.base64.length > LIMIT * 1.4) throw new Error('附件超过100MB')
      return { bytes: Buffer.from(result.base64, 'base64'), mediaType: 'audio/mpeg' }
    }
    if (typeof result.url === 'string') return download(result.url, signal)
    throw new Error('平台未返回附件下载地址')
  }
  private async transcribe(bytes: Buffer, signal: AbortSignal): Promise<string> {
    const config = this.settings.asr
    if (!config) throw new Error('语音识别尚未配置')
    const response = await fetch(config.baseUrl.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST', signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]),
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: config.model, messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: bytes.toString('base64'), format: 'mp3' } }] }] }),
    })
    if (!response.ok) throw new Error('语音识别接口失败')
    const result = await response.json() as { choices?: { message?: { content?: string } }[] }
    const transcript = result.choices?.[0]?.message?.content?.trim()
    if (!transcript) throw new Error('语音识别没有返回文字')
    return transcript
  }
  private async admit(block: ContentBlock, event: {event_id:string;memory_id?:string}, signal: AbortSignal, slots: number,supplied?:Buffer,frames=5): Promise<ModelBlock[]> {
    const bytes = supplied??(await this.bytes(block, signal)).bytes
    const isGif = ['GIF87a','GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))
    const name = basename(String(block.name ?? `${block.type}${isGif ? '.gif' : ''}`)).slice(-160)
    const original = await this.attachments.saveFile({ data: bytes, name })
    this.store.setRecord('media-original', String(original.attachmentId), { event_id: event.event_id,...(event.memory_id?{memory_id:event.memory_id}:{}), attachment: original })
    const content: ModelBlock[] = block.type === 'image' || block.type === 'audio' ? [] : [{ type: 'file', attachment: original }]
    if (block.type === 'image' && !isGif) {
      if (slots < 1) return [...content, text('[图片超过本轮视觉数量限制，原文件已保留，可交工具助手继续读取。]')]
      const attachment = await this.attachments.saveImage({ data: bytes, mediaType: imageType(bytes), name })
      return [...content, { type: 'image', attachment }]
    }
    if (!['audio','video'].includes(block.type) && !isGif) {
      const sample = bytes.subarray(0, 16000).toString('utf8')
      if (!sample.includes('\u0000') && !sample.includes('\ufffd')) return [...content, text(`文件 ${name} 原文${bytes.length > 16000 ? '（前16000字节，全文在原文件中）' : ''}：\n${sample}`)]
    }
    const directory = await mkdtemp(join(tmpdir(), 'amphoreus-media-'))
    const file = join(directory, 'source' + (isGif ? '.gif' : extname(name)))
    await writeFile(file, bytes)
    const run = (command: string, args: string[]) => exec(command, args, { signal, timeout: 30000, maxBuffer: 1024 * 1024 })
    try {
      if (isGif || block.type === 'video' || block.type === 'audio') {
        const { stdout } = await run('ffprobe', ['-v','error','-show_entries','format=duration:stream=codec_type','-of','json',file])
        const info = JSON.parse(stdout) as { format?: { duration?: string }; streams?: { codec_type?: string }[] }
        const duration = Number(info.format?.duration) || 1
        if (isGif || block.type === 'video') {
          const count = Math.min(isGif?frames:8,16, Math.max(0, slots))
          if (count) {
            await run('ffmpeg', ['-nostdin','-v','error','-i',file,'-vf',`fps=${count / Math.max(.1, duration)},scale=960:960:force_original_aspect_ratio=decrease`,'-frames:v',String(count),'-q:v','3',join(directory,'frame-%03d.jpg')])
            const frames = (await readdir(directory)).filter(name => name.startsWith('frame-')).sort()
            content.push(text(isGif?'[动图，按顺序展示部分画面；需要更多细节时主动调用 read_media。]':`视频，约${duration.toFixed(2)}秒；画面为抽样，不能推断未展示的细节。`))
            for (const frame of frames) {
              content.push({ type: 'image', attachment: await this.attachments.saveImage({ data: await readFile(join(directory, frame)), mediaType: 'image/jpeg', name: '画面.jpg' }) })
            }
          } else content.push(text('[视觉数量限制已达上限，完整原文件已保留。]'))
        }
        if (block.type === 'audio' || info.streams?.some(stream => stream.codec_type === 'audio')) {
          const audio = join(directory,'audio.mp3')
          await run('ffmpeg', ['-nostdin','-v','error','-i',file,'-vn','-ac','1','-ar','16000','-codec:a','libmp3lame','-y',audio])
          try { content.push(text(`音轨转写：\n${await this.transcribe(await readFile(audio), signal)}`)) }
          catch { signal.throwIfAborted(); content.push(text('[音轨未能转写，不能声称听清内容。]')) }
        }
        return content
      }
      // Existing native file references keep the complete original; technical workers can read further.
      content.push(text('[二进制文件原文已作为附件保存；需委派工具助手读取内容，不能凭文件名猜测。]'))
      return content
    } finally { await rm(directory, { recursive: true, force: true }) }
  }
}
