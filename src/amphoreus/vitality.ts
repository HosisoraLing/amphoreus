import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { AmphoreusStore } from './store.ts'
import type { Vitality } from './participation.ts'

/** Shared input port for the existing/planned sleep cycle; never invent token usage. */
export function captureVitality(store:AmphoreusStore,agentId:string,event:SessionEvent){
  const value=store.record<Vitality>('main-vitality',agentId)??{}
  if(event.type==='request/context')value.capacity=event.data.contextWindow
  else if(event.type==='request/header')value.reserve=event.data.header.config.maxTokens??8192
  else if(event.type==='assistant/message'&&event.data.usage){
    const u=event.data.usage
    value.used=u.inputTokens+(u.cacheReadTokens??0)+(u.cacheWriteTokens??0)+u.outputTokens
  }else return
  store.setRecord('main-vitality',agentId,value)
}
