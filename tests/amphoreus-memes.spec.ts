import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import { AmphoreusStore } from '../src/amphoreus/store.ts'
import { MemeService } from '../src/amphoreus/memes.ts'
import { once } from 'node:events'
import { WebSocketServer } from 'ws'
import { AmphoreusRuntime } from '../src/amphoreus/runtime.ts'
import { QQAdapter,QQConfig } from '../src/amphoreus/qq.ts'
import { MediaInput,MediaSettings } from '../src/amphoreus/media.ts'
import { MemoryStore } from '../src/amphoreus/memory.ts'
import { normalizeEvent } from '../src/amphoreus/model.ts'
const clean:(()=>unknown)[]=[]
afterEach(async()=>{for(const stop of clean.splice(0).reverse())await stop()})
async function fixture(){
 const root=mkdtempSync(join(tmpdir(),'amphoreus-memes-')),db=new Store(join(root,'app.db')),store=new AmphoreusStore(db)
 clean.push(()=>{db.close();rmSync(root,{recursive:true,force:true})})
 const context={llm:{},attachments:{fileHostPath:(ref:{attachmentId:string})=>join(root,ref.attachmentId)},logger:vi.fn(),get:()=>({currentSelection:()=>null})}
 const service=new MemeService(context as never,join(root,'memes'),store,()=>null);await service.start();clean.push(()=>service.stop())
 const server=createServer((req,res)=>{service.handle(req,res,req.url?.startsWith('/export')?'export':'manage').catch(error=>{res.writeHead(400);res.end(JSON.stringify({error:error.message}))})})
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));clean.push(()=>new Promise<void>(resolve=>server.close(()=>resolve())))
 const base=`http://127.0.0.1:${(server.address() as any).port}`
 const post=async(input:object)=>{const response=await fetch(base,{method:'POST',body:JSON.stringify(input)});return response.json() as Promise<any>}
 return{root,service,store,post,base,context,db}
}
// Two-frame original GIF, retained byte-for-byte through collection and speak preparation.
const gif=Buffer.from('R0lGODlhAQABAIEAAP8AAAAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAAAQABAAAIBAABBAQAIfkEAAoAAAAsAAAAAAEAAQCBAP8AAAAAAAAAAAAACAQAAQQEADs=','base64')
it('ports upload/search/edit/export/import and pack switches without registering global tools or sending',async()=>{
 const f=await fixture()
 expect(await f.post({op:'upload',tag:'happy',caption:'开心',keywords:'笑',fileName:'motion.gif',dataBase64:gif.toString('base64')})).toHaveProperty('ok',true)
 const item=f.service.search('开心').items[0]!
 expect(item.content).toEqual([{type:'image',meme_id:item.id}]);expect(JSON.stringify(item)).not.toContain(f.root)
 expect((await f.service.image(item.id)).bytes.equals(gif)).toBe(true)
 const outgoing=await f.service.outgoing([{type:'image',meme_id:item.id}],'qq');expect(readFileSync(outgoing[0]!.path as string).equals(gif)).toBe(true)
 expect(await f.service.update(item.id,{caption:'大笑'})).toEqual({ok:true});expect(f.service.search('大笑').items).toHaveLength(1)
 const zip=Buffer.from(await (await fetch(f.base+'/export?packId=dsh-meme-user')).arrayBuffer())
 expect(zip.subarray(0,2).toString()).toBe('PK')
 expect(await f.post({op:'importMemePack',name:'restored',dataBase64:zip.toString('base64')})).toHaveProperty('ok',true)
 expect(f.service.catalog('大笑').map(row=>row.pack)).toContain('restored')
 await f.post({op:'setPackEnabled',packId:'dsh-meme-user',enabled:false});expect(()=>f.service.resolve(item.id)).toThrow('关闭')
 expect(f.service.view().items).toHaveLength(2)
 expect(await f.post({op:'setMemeRoot',memeRoot:'/tmp'})).toHaveProperty('error','此管理操作未开放')
 expect(await f.post({op:'upload',tag:'happy',fileName:'fake.png',dataBase64:Buffer.from('bad').toString('base64')})).toHaveProperty('error')
})
it('collects the current gateway event original GIF and rejects another event attachment',async()=>{
 const f=await fixture(),origin=normalizeEvent({agent_id:'role',source_kind:'napcat',platform:'qq',account_id:'bot',conversation_id:'group:1',actor_id:'friend',event_type:'message',timestamp:new Date().toISOString(),correlation_id:null,content:[{type:'image'}],metadata:{},visibility:'public',idempotency_key:'gif'})
 writeFileSync(join(f.root,'original.gif'),gif)
 f.store.setRecord('media-original','original.gif',{event_id:origin.event_id,attachment:{attachmentId:'original.gif',name:'original.gif'}})
 const result=await f.service.learn({tag:'happy',caption:'收藏动图',keywords:'动图'},origin)
 expect(result.ok).toBe(true);expect(result.message).not.toContain(' → ')
 const item=f.service.search('收藏动图').items[0]!;expect((await f.service.image(item.id)).bytes.equals(gif)).toBe(true)
 expect((await f.service.learn({attachmentId:'original.gif',tag:'happy',caption:'越界',keywords:'禁止'},{...origin,event_id:'another'})).ok).toBe(false)
})

it('sends a selected original GIF through the unified gateway as an actual OneBot image',async()=>{
 const f=await fixture(),server=new WebSocketServer({port:0});await once(server,'listening')
 clean.push(()=>new Promise<void>(resolve=>{for(const client of server.clients)client.terminate();server.close(()=>resolve())}))
 const frames:any[]=[];server.on('connection',socket=>socket.on('message',frame=>{const call=JSON.parse(frame.toString());frames.push(call);socket.send(JSON.stringify({echo:call.echo,status:'ok',retcode:0,data:call.action==='get_login_info'?{user_id:'123'}:{message_id:'meme-sent'}}))}))
 const runtime=new AmphoreusRuntime(f.store,{main:async()=>{},task:async()=>'',messageTask:async()=>{},stop:async()=>{}},{agent_id:'role',name:'role',persona:'persona'},{maxWorkers:1,mainTimeoutMs:1000,taskTimeoutMs:1000,progressIntervalMs:60000});clean.push(()=>runtime.stop())
 const attachments={...f.context.attachments,saveFile:async({data,name}:{data:Buffer;name:string})=>{const attachmentId='pinned-'+name;writeFileSync(join(f.root,attachmentId),data);return{attachmentId,name,bytes:data.length}}}
 const media=new MediaInput(attachments as never,f.store,new MemoryStore(f.db,'role'),MediaSettings.parse({}),async()=>({}))
 runtime.prepareOutput=async(content,target)=>media.outgoing(await f.service.outgoing(content,target.platform),[f.root])
 const adapter=new QQAdapter(runtime,QQConfig.parse({enabled:true,token:'meme-test-token-12345',accountId:'123',allowedUsers:['456'],wsUrl:`ws://127.0.0.1:${(server.address() as any).port}`}),[f.root]);clean.push(()=>adapter.stop());adapter.start()
 await vi.waitFor(()=>expect(adapter.status().state).toBe('connected'))
 await f.post({op:'upload',tag:'happy',caption:'原图',fileName:'motion.gif',dataBase64:gif.toString('base64')})
 const selected=f.service.search('原图').items[0]!
 const result=await runtime.gateway.speak({agentId:'role',runId:'mock',callId:'speak',target:{platform:'qq',account_id:'123',conversation_id:'private:456'},content:[{type:'text',text:'耶'},...selected.content]},()=>true)
 expect(result.status).toBe('sent');const call=frames.find(frame=>frame.action==='send_private_msg');expect(call.params.user_id).toBe('456');expect(call.params.message.map((block:any)=>block.type)).toEqual(['text','image']);expect(Buffer.from(call.params.message[1].data.file.slice(9),'base64').equals(gif)).toBe(true)
 expect(result.content[1]).not.toHaveProperty('meme_id')
})
