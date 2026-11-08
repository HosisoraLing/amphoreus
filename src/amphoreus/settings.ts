/** Main's application settings reuse the same validators and stores as the console. No credentials. */
import {z} from 'zod'
import {ControlInput} from './control.ts'
import {ParticipationPatch,type GroupParticipation} from './participation.ts'
import {QQControlInput,QQControlPatch,type QQControl} from './qq-control.ts'
import {ModelInput,type ModelSettings} from './models.ts'
import {MemorySettings,type MemoryStore} from './memory.ts'
import {OrganizerControl,type TopicOrganizer} from './topic-organizer.ts'
import {MemePreferences,type MemeService} from './memes.ts'
import {StatisticsSettings} from './pricing.ts'
import type {Telemetry} from './telemetry.ts'
import type {AmphoreusRuntime} from './runtime.ts'
import {AmphoreusConfig} from './config.ts'

export const SettingsInput=z.object({
 section:z.enum(['overview','controls','participation','qq','models','memory','runtime','organizer','memes','statistics']).default('overview'),
 values:z.record(z.string(),z.unknown()).optional(),conversation_id:z.string().regex(/^(group|private):[1-9]\d{0,19}$/).optional(),
 task_id:z.string().min(1).max(200).optional(),catalog:z.boolean().default(false),
}).strict()
const memoryShape=MemorySettings.unwrap().shape
const MemoryPatch=z.object({
 reasoning:memoryShape.reasoning.unwrap().partial().strict().optional(),timeZone:z.literal('Asia/Shanghai').optional(),
 dreaming:memoryShape.dreaming.unwrap().partial().strict().optional(),search:memoryShape.search.unwrap().partial().strict().optional(),
 observability:memoryShape.observability.unwrap().partial().strict().optional(),socialContext:memoryShape.socialContext.unwrap().partial().strict().optional(),
}).strict()
const RuntimePatch=AmphoreusConfig.shape.limits.unwrap().partial().strict().extend({resumeOnRestart:z.boolean().optional()})
type Services={runtime:AmphoreusRuntime;memory:MemoryStore;presence?:GroupParticipation;qq?:QQControl;models:ModelSettings;
 organizer:TopicOrganizer;memes:MemeService;telemetry:Telemetry;steps:{mainSteps:number;collaborationSteps:number;reviewSteps:number}}
const unavailable=():never=>{throw Error('此功能未配置')}
export async function manageSettings(raw:z.input<typeof SettingsInput>,services:Services){
 const input=SettingsInput.parse(raw),{runtime,memory,presence,qq,models,organizer,memes,telemetry,steps}=services
 const {store,role}=runtime,values=input.values
 if(input.conversation_id&&!['participation','qq'].includes(input.section))throw Error('此项不使用conversation_id；渠道开关在values中指定目标')
 if(input.task_id&&input.section!=='models'||input.catalog&&input.section!=='models')throw Error('task_id和catalog仅用于模型设置')
 let result:unknown
 switch(input.section){
  case 'overview':
   if(values)throw Error('请指定要修改的section')
   return{sections:['controls','participation','qq','models','memory','runtime','organizer','memes','statistics'],note:'省略values读取当前字段；values部分更新。models.catalog=true列可用模型。凭证、账户登录和服务地址由部署者管理。'}
  case 'controls':
   if(values)runtime.controls.configure(ControlInput.parse(values))
   else{const state=runtime.controls.status();result={enabled:state.enabled,channels:state.channels.map(({conversations,...channel})=>({...channel,conversations:conversations.slice(0,20),total_conversations:conversations.length}))}}
   break
  case 'participation':
   if(!presence)unavailable()
   if(values){ParticipationPatch.parse(values);presence!.configure(values,input.conversation_id)}
   else result={...presence!.settings(input.conversation_id),...(input.conversation_id?{effective_mode:presence!.effectiveMode(input.conversation_id)}:{})}
   break
  case 'qq':
   if(!qq)unavailable()
   if(values)qq!.configure(QQControlInput.parse(values.reset===true?{...values,conversation_id:input.conversation_id}:{conversation_id:input.conversation_id,patch:QQControlPatch.parse(values)}))
   else result=qq!.settings(input.conversation_id)
   break
  case 'models':
   if(values){const changed=await models.configureTested(ModelInput.parse({...values,...(input.task_id?{task_id:input.task_id}:{})}));if(changed.status==='rolled_back')return changed}
   else result=input.catalog?await models.catalog():await models.status(input.task_id)
   break
  case 'memory':
   if(values){
    MemoryPatch.parse(values)
    const merged={...memory.settings,...values}
    for(const [key,value] of Object.entries(values))if(value&&typeof value==='object'&&!Array.isArray(value))
     (merged as Record<string,unknown>)[key]={...(memory.settings as unknown as Record<string,object>)[key],...value}
    const settings=MemorySettings.parse(merged)
    store.setRecord('memory-policy',role.agent_id,settings);Object.assign(memory.settings,settings)
   }else result=memory.settings
   break
  case 'runtime':
   if(values){
    RuntimePatch.parse(values)
    const settings=AmphoreusConfig.shape.limits.parse({...runtime.limits,...steps,...values})
    store.setRecord('runtime-settings',role.agent_id,{...store.record<object>('runtime-settings',role.agent_id),...settings,...(Object.hasOwn(values,'resumeOnRestart')?{resumeOnRestart:values.resumeOnRestart}:{})})
    Object.assign(runtime.limits,settings);steps.mainSteps=settings.mainSteps;steps.collaborationSteps=settings.collaborationSteps;steps.reviewSteps=settings.reviewSteps
    runtime.applyControls()
   }else result={...runtime.limits,mainSteps:steps.mainSteps,collaborationSteps:steps.collaborationSteps,reviewSteps:steps.reviewSteps,resumeOnRestart:store.record<{resumeOnRestart?:boolean}>('runtime-settings',role.agent_id)?.resumeOnRestart??true}
   break
  case 'organizer':if(values)organizer.configure(OrganizerControl.parse(values));else result=organizer.settings();break
  case 'memes':if(values)memes.configurePreferences(values);else result=MemePreferences.parse(memes.settings());break
  case 'statistics':
   if(values){StatisticsSettings.partial().parse(values);telemetry.configure({...telemetry.settings(),...values})}
   else{const {holidays,...settings}=telemetry.settings();result={...settings,holidays_count:holidays.length}}
   break
 }
 if(values){store.setRecord('settings-change',`${role.agent_id}:${input.section}`,{section:input.section,fields:Object.keys(values),at:new Date().toISOString()});runtime.onChange();return{status:'updated'}}
 return result
}
