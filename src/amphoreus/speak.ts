import { z } from 'zod'
import type { ContentBlock } from './model.ts'
import type { OutputTarget } from './gateway.ts'

export const Speak=z.object({
  content:z.union([z.string().min(1).max(16000),z.array(z.object({type:z.string().min(1)}).passthrough()).min(1).max(100)]),
  channel:z.string().min(1).optional(),
  modality:z.enum(['text','image','audio','video','file']).optional(),
  qq:z.object({group_id:z.string().regex(/^[1-9]\d{0,19}$/).optional(),user_id:z.string().regex(/^[1-9]\d{0,19}$/).optional(),account_id:z.string().min(1).optional()}).strict().refine(value=>!!value.group_id!==!!value.user_id,'群聊group_id和私聊user_id必须且只能指定一个').optional(),
  target:z.object({platform:z.enum(['web','qq','bilibili']),account_id:z.string(),conversation_id:z.string().min(1),reply_to:z.string().optional()}).strict().optional(),
}).strict().refine(value=>!value.channel||!value.target,'channel和target只需指定一个')
  .refine(value=>!value.qq||(!value.target&&!!value.channel&&value.channel.toLowerCase()==='qq'),'qq目标必须配合channel QQ使用，不能同时指定target')
export function speakContent(input:z.infer<typeof Speak>):ContentBlock[]{
  if(Array.isArray(input.content))return input.content
  if(!input.modality||input.modality==='text')return [{type:'text',text:input.content}]
  // Some model routes encode a multimodal block array inside the string union arm.
  if(/^[\[{]/.test(input.content.trim())){
    try{
      const decoded:unknown=JSON.parse(input.content),blocks=Array.isArray(decoded)?decoded:[decoded]
      return z.array(z.object({type:z.enum(['text','image','audio','video','file','mention','emoji','quote'])}).passthrough()).min(1).max(100).parse(blocks)
    }catch{/* A normal filename or URL is handled below. */}
  }
  return [{type:input.modality,...(/^https?:\/\//.test(input.content)?{url:input.content}:{path:input.content})}]
}
export function speakTarget(input:z.infer<typeof Speak>,channels:{channel:string;name:string;target:OutputTarget}[]):OutputTarget|undefined{
  if(!input.channel)return input.target
  if(input.qq){
    const conversation=input.qq.group_id?`group:${input.qq.group_id}`:`private:${input.qq.user_id}`
    const matches=channels.filter(item=>item.target.platform==='qq'&&item.target.conversation_id===conversation&&(!input.qq?.account_id||item.target.account_id===input.qq.account_id))
    const unique=new Map(matches.map(item=>[JSON.stringify([item.target.account_id,item.target.conversation_id]),item.target]))
    if(unique.size!==1)throw new Error('QQ目标未知、未授权或账号不明确，请先用list_channels核对目标和account_id')
    const target=[...unique.values()][0]!
    return {platform:target.platform,account_id:target.account_id,conversation_id:target.conversation_id}
  }
  const shortcut=input.channel.toLowerCase()==='qq'?'qq':input.channel
  const found=channels.filter(item=>item.channel===input.channel||item.name===input.channel||item.target.platform===shortcut)
  if(found.length!==1)throw new Error('渠道不明确或不可用，请用list_channels查询后指定完整channel')
  return {...found[0]!.target}
}
export const speakResult=(value:unknown)=>[{type:'text' as const,text:(value as {status:string}).status==='sent'?'成功':'失败，系统正在自动核查并重试；仍失败将邮件通知。'}]
