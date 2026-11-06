/** Isolated dsh-meme backend: scoped tools and authenticated routes, with speak as its sole output. */
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { createHash, randomInt } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import { packagePath } from '../infra/paths.ts'
import type { ContentBlock, GatewayEvent } from './model.ts'
import type { AmphoreusStore } from './store.ts'
import type { RoleModel } from '../app/role-models.ts'

type Row = { path:string;tag:string;caption:string;keywords:string;pack:string;packName:string }
type Item = Row & { id:string }
type Definition = { name:string;execute:(args:Record<string,unknown>,execution?:unknown)=>unknown }
type Route = { path:string;handler:(req:IncomingMessage,res:ServerResponse)=>unknown }
type Settings = { enabledPacks?:string[];promptEnabled?:boolean;sendMode?:string;sendChanceEnabled?:boolean;sendChance?:number;qqSendResize?:boolean;qqSendEdge?:number }
const inside = (root:string,path:string) => {const part=relative(realpathSync(root),realpathSync(path));return !!part&&!part.startsWith('..')&&!isAbsolute(part)}
const memeId = (path:string) => createHash('sha256').update(path).digest('hex').slice(0,24)

/** Original backend closures are owned by one application, not Cordis's global tool/prompt plane. */
export class MemeService {
  readonly routes=new Map<string,Route>()
  readonly tools=new Map<string,Definition>()
  private readonly disposers:(()=>unknown)[]=[]
  private readonly stopSignal=new AbortController()
  private readonly chances=new Map<string,boolean>()
  private core!: {scanPacks:(root:string)=>{id:string;name:string;path:string;count:number}[];MemesStore:new(root:string)=>{list:(tag?:string)=>{memes:Omit<Row,'pack'|'packName'>[]};search:(query:string,limit:number,tag?:string)=>{memes:Omit<Row,'pack'|'packName'>[]}}}
  private service!: {packs:()=>{id:string;name:string;path:string;count:number}[];search:(input:unknown)=>{memes:Row[]};pick:(input:unknown)=>Row&{ok:boolean}}
  private sniff!:(bytes:Buffer)=>string
  private resize!:(path:string,options:unknown)=>Promise<string>
  constructor(readonly ctx:Context,readonly root:string,readonly store:AmphoreusStore,
    private readonly model:()=>RoleModel|null,private readonly settled?:(provider:string,model:string,usage:TokenUsage|undefined,duration:number,ok:boolean)=>void){}
  get settingsFile(){return join(this.root,'settings.json')}
  settings():Settings {try{return JSON.parse(readFileSync(this.settingsFile,'utf8'))}catch{return{}}}
  async start(){
    const source=await import(pathToFileURL(packagePath('vendor','dsh-meme','index.js')).href)
    const core=await import(pathToFileURL(packagePath('vendor','dsh-meme','memes.js')).href)
    this.core=core
    const qq=await import(pathToFileURL(packagePath('vendor','dsh-meme','qq-resize.js')).href)
    mkdirSync(this.root,{recursive:true,mode:0o700});const packs=join(this.root,'packs'),user=join(packs,'dsh-meme-user');core.ensurePackAt(user,{id:'dsh-meme-user',name:'我的收藏'})
    if(!existsSync(this.settingsFile))writeFileSync(this.settingsFile,JSON.stringify({memeRoot:user,packsDir:packs,packId:'dsh-meme-user',enabledPacks:['dsh-meme-user']}),{mode:0o600})
    this.sniff=source.sniffImageMime;this.resize=(path,options)=>qq.resizeForQq(path,options)
    const attachments=this.ctx.attachments
    const llm=new Proxy(this.ctx.llm,{get:(target,key)=>{
      if(key==='prepareCall')return async(...args:unknown[])=>{
        const prepared=await (target.prepareCall as Function).apply(target,args)
        const self=this
        return{...prepared,stream:async function*(options:Record<string,unknown>){
          const start=Date.now();let usage:TokenUsage|undefined,ok=false
          const route=args[0] as {provider:string;model:string}
          try{for await(const chunk of prepared.stream({...options,sessionId:'amphoreus-meme-learning',signal:AbortSignal.any([self.stopSignal.signal,AbortSignal.timeout(60000)])})){
            if(chunk.type==='usage')usage=chunk.usage
            if(chunk.type==='finish')ok=!['error','aborted'].includes(chunk.reason?.kind)
            yield chunk
          }}finally{self.settled?.(route.provider,route.model,usage,Date.now()-start,ok)}
        }}
      }
      const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value
    }})
    const services:Record<string,unknown>={attachments:new Proxy(attachments,{get:(target,key)=>{
      if(key==='readImage')return async(ref:{attachmentId:string;width?:number})=>{
        if(ref.width)return target.readImage(ref as never)
        const path=target.fileHostPath(ref as never);if(!path)throw new Error('原始附件不存在');const data=readFileSync(path);return{data,ref:{...ref,mediaType:this.sniff(data)}}
      }
      const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value
    }}),llm,agentDefaultModel:{currentSelection:()=>this.model()??(this.ctx.get('agentDefaultModel') as {currentSelection:()=>RoleModel}).currentSelection()}}
    const scope={
      tools:{register:(tool:Definition)=>{this.tools.set(tool.name,tool);return()=>this.tools.delete(tool.name)}},
      webServer:{register:(route:Route)=>{this.routes.set(route.path,route);return()=>this.routes.delete(route.path)},tapIndex:()=>()=>{}},
      get:(name:string)=>services[name],provide:(name:string,value:unknown)=>{if(name==='dshMeme')this.service=value as typeof this.service},
      effect:(effect:()=>unknown)=>{const dispose=effect();if(typeof dispose==='function')this.disposers.push(dispose as ()=>unknown);return dispose},
      inject:(_names:string[],effect:()=>unknown)=>effect(),on:()=>()=>{},logger:this.ctx.logger,agentDefaultModel:services.agentDefaultModel,
    }
    source.apply(scope,{settingsFile:this.settingsFile,memeRoot:user,allowedHosts:['localhost','127.0.0.1']})
    if(!this.service||!this.tools.has('learn_meme'))throw new Error('表情图库加载未完成')
  }
  stop(){this.stopSignal.abort();for(const dispose of this.disposers.reverse())dispose();this.routes.clear();this.tools.clear()}
  private item(row:Row):Item|undefined {
    try{if(!inside(this.root,row.path)||!statSync(row.path).isFile())return;return{...row,id:memeId(relative(this.root,row.path))}}catch{return}
  }
  catalog(query='',tag='',pack='',includeDisabled=false){
    const packs=includeDisabled?this.core.scanPacks(join(this.root,'packs')):this.service.packs(),rows:Item[]=[]
    for(const library of packs){if(pack&&pack!==library.id)continue
      try{const store=new this.core.MemesStore(library.path),matched=query?store.search(query,100000,tag).memes:store.list(tag||undefined).memes
        for(const row of matched){const item=this.item({...row,path:join(library.path,row.path),pack:library.id,packName:library.name});if(item)rows.push(item)}
      }catch{/* A missing or invalid pack does not expose arbitrary files. */}
    }return rows
  }
  resolve(id:string){const item=this.catalog().find(row=>row.id===id);if(!item)throw new Error('表情不存在或图库已关闭');return item}
  search(query='',tag='',limit=3){const rows=this.catalog(query,tag);if(!query)for(let i=rows.length-1;i>0;i--){const j=randomInt(i+1);[rows[i],rows[j]]=[rows[j]!,rows[i]!]};return{items:rows.slice(0,Math.min(8,limit)).map(row=>({id:row.id,tag:row.tag,caption:row.caption,content:[{type:'image',meme_id:row.id}]}))}}
  async image(id:string,management=false){const item=management?this.catalog('','','',true).find(row=>row.id===id):this.resolve(id);if(!item)throw new Error('表情不存在');const bytes=readFileSync(item.path),mime=this.sniff(bytes);if(!mime||bytes.length>8*1024*1024)throw new Error('图库文件不是有效图片或超过8MB');return{item,bytes,mime}}
  async outgoing(blocks:ContentBlock[],platform:string){
    const settings=this.settings(),result:ContentBlock[]=[]
    for(const block of blocks){if(!block.meme_id){result.push(block);continue}
      if(settings.sendMode==='text')throw new Error('AI 表情发送已设为纯文字')
      const {item}=await this.image(String(block.meme_id))
      const path=platform==='qq'&&settings.qqSendResize?await this.resize(item.path,{edge:settings.qqSendEdge}):item.path
      const {meme_id: _id,...rest}=block;result.push({...rest,type:'image',path})
    }return result
  }
  guidance(eventId:string){
    const settings=this.settings();if(settings.promptEnabled===false)return''
    let permitted=this.chances.get(eventId)
    if(permitted===undefined){permitted=settings.sendMode==='image'||!settings.sendChanceEnabled||randomInt(100)<(settings.sendChance??30);if(this.chances.size>200)this.chances.clear();this.chances.set(eventId,permitted)}
    return '\n表情：send_meme仅选图，将候选content交speak发送；不贴标记或路径，不强制回复。'+(settings.sendMode==='text'?'本轮只用文字。':!permitted?'本轮不主动发表情，用户明确要图除外。':settings.sendMode==='image'?'气氛合适优先选表情。':'气氛合适可选表情。')
  }
  async learn(args:Record<string,unknown>,origin:GatewayEvent){
    const refs:{attachmentId:string}[]=[]
    for(const record of this.store.records<{event_id:string;attachment:{attachmentId:string}}>('media-original')){
      if(record.event_id!==origin.event_id)continue
      const path=this.ctx.attachments.fileHostPath(record.attachment as never)
      if(path&&this.sniff(readFileSync(path)))refs.push(record.attachment)
    }
    const execution={agent:{inbox:{nextTurn:[],nextStep:[]},session:{deriveMessages:()=>[{role:'user',content:refs.map(attachment=>({type:'image',attachment}))}]}}}
    const value=await this.tools.get('learn_meme')!.execute(args,execution) as {ok:boolean;message?:string}
    return{ok:value.ok,message:value.message?.replace(/ → .*/, '').slice(0,300)}
  }
  async update(id:string,args:Record<string,unknown>){const item=this.resolve(id);const result=await this.tools.get('meme_update')!.execute({...args,path:item.path}) as {ok:boolean};return{ok:result.ok}}
  view(query='',tag='',pack=''){
    const enabled=new Set(this.service.packs().map(pack=>pack.id))
    return{packs:this.core.scanPacks(join(this.root,'packs')).map(({id,name,count})=>({id,name,count,enabled:enabled.has(id)})),items:this.catalog(query,tag,pack,true).map(({id,tag,caption,keywords,pack,packName})=>({id,tag,caption,keywords,pack,packName})),settings:this.settings()}
  }
  async handle(req:IncomingMessage,res:ServerResponse,route:'manage'|'remote'|'export'){
    const incoming=new URL(req.url??'/','http://localhost'),path=route==='export'?'/dsh-memes-export':'/dsh-memes-api'
    let body:Buffer|undefined
    if(req.method==='POST'){
      const chunks:Buffer[]=[];let size=0
      for await(const chunk of req){size+=chunk.length;if(size>32*1024*1024)throw new Error('请求体不能超过32MB');chunks.push(chunk)}
      body=Buffer.concat(chunks);const input=JSON.parse(body.toString())
      if(['upload','recognize'].includes(input.op)){const bytes=Buffer.from(String(input.dataBase64??''),'base64');if(!this.sniff(bytes)||bytes.length>8*1024*1024)throw new Error('请上传不超过8MB的jpg/png/gif/webp图片')}
      if(['update','delete'].includes(input.op)){const item=this.catalog('','','',true).find(row=>row.id===input.id);if(!item||item.pack!==(this.settings() as Settings&{packId?:string}).packId)throw new Error('请先切换到该表情所在图库');input.path=relative(join(this.root,'packs',item.pack),item.path);body=Buffer.from(JSON.stringify(input))}
      const allowed=['createMemePack','recognize','upload','scanPack','update','delete','deleteTag','importMemePack','installRemoteArchive','subscribeRemote','previewManifest','remoteJobStatus','updateRemotePack','getMemeRoot','setPack','setPackEnabled','setRemoteDirUrl','setPromptEnabled','setSendMode','setQqSendResize','setSendChance','setLayoutMode','deleteMemePack','getPackInfo']
      if(!allowed.includes(input.op))throw new Error('此管理操作未开放')
    }
    const proxy=Object.assign(Readable.from(body?[body]:[]),{url:path+(route==='remote'?'?remoteDir=1':incoming.search),headers:{...req.headers,host:'localhost',origin:undefined},method:req.method})
    await this.routes.get(path)!.handler(proxy as unknown as IncomingMessage,res)
  }
}
