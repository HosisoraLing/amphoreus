import type { ContentBlock, GatewayEvent } from './model.ts'

const contentText = (blocks: ContentBlock[], accountId?: string): string => blocks.map(block =>
  block.type === 'mention' && block.platform === 'qq'
    ? block.actor_id === 'all' ? '@全体成员' : `@${block.display_name || block.actor_id}（QQ:${block.actor_id}${accountId ? String(block.actor_id) === accountId ? '，叫你' : '，叫的是别人' : ''}）` :
  block.type === 'file' ? `[文件：${block.name ?? '未命名文件'}]` : block.type === 'video' ? '[视频]' : block.type === 'image' ? '[图片]' :
  block.type === 'quote' ? '[引用消息]' :
  block.type === 'text' && typeof block.text === 'string' && Object.keys(block).every(key => key === 'type' || key === 'text')
    ? block.text : JSON.stringify(block)).join('\n')

/** Model-facing text only; the Gateway retains the complete event and owns reply routing. */
export function mainInput(event: GatewayEvent, origin?: GatewayEvent): string {
  if(event.source_kind==='internal'&&event.event_type==='main.resume')return `重启续接${origin?` · ${origin.platform}/${origin.conversation_id}`:''}\n${contentText(event.content)}`
  if (event.source_kind === 'internal' && event.task_id) {
    const reports = event.content.map(block => {
      if (block.type !== 'report') return contentText([block])
      return [typeof block.summary === 'string' ? block.summary : '',
        typeof block.progress === 'number' ? `进度 ${block.progress}%` : '',
        Array.isArray(block.details) ? contentText(block.details) : ''].filter(Boolean).join('\n')
    }).join('\n')
    return `后台任务 ${event.task_id} · ${event.event_type.replace(/^task\./, '')} · ${event.timestamp}${origin ? ` · 来源 ${origin.platform}/${origin.conversation_id}` : ''}\n\n${reports}`
  }
  const meta = event.metadata
  const sender = typeof meta.nickname === 'string' && meta.nickname !== event.actor_id
    ? `${meta.nickname} (${event.actor_id})` : event.actor_id
  const source = event.source_kind === 'genesis' ? '创世问候' : event.platform === 'web' ? '网页'
    : event.platform === 'qq' ? `QQ ${meta.message_type === 'group' ? '群聊' : '私聊'}` : event.platform
  const context = event.platform === 'qq'
    ? meta.message_type === 'group' ? `${meta.group_name ?? '群'} (${event.conversation_id})` : ''
    : event.platform === 'web' ? event.conversation_id : event.source_kind === 'genesis' ? ''
      : JSON.stringify({ account_id: event.account_id, conversation_id: event.conversation_id, event_type: event.event_type, metadata: meta })
  return [`${source} · ${sender} · ${event.timestamp}`, context].filter(Boolean).join(' · ') + `\n\n${contentText(event.content, event.platform === 'qq' ? event.account_id : undefined)}`
}
