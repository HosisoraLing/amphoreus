import type { Context } from '@deepseek-ai/cordis'
import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent'
import { z } from 'zod'
import {createHash,randomUUID} from 'node:crypto'
import {BlockAssembler,type TokenUsage} from '@deepseek-ai/dsh-llm'
import { resolveRoleModel } from '../app/role-models.ts'
import type { AmphoreusStore } from './store.ts'

export const ModelRoute = z.object({ provider: z.string().trim().min(1).max(200), model: z.string().trim().min(1).max(300), reasoningEffort: z.string().trim().min(1).max(100).optional() }).strict()
export const ModelScope = z.enum(['main', 'worker', 'continuation', 'topic'])
export type ModelScope = z.infer<typeof ModelScope>
export const ModelInput = z.object({ scope: ModelScope, task_id: z.string().min(1).max(200).optional(), selection: ModelRoute.nullable() }).strict()
type Route = z.infer<typeof ModelRoute>
type ChangeResult={status:'updated'|'rolled_back';message?:string}
type ModelChange={id:string;role:string;input:z.infer<typeof ModelInput>;before:string;recipients:string[];state:'queued'|'testing'|'updated'|'rolled_back';result?:ChangeResult}
type Defaults = { main: Route | null; worker: Route | null; continuation?: Route | null; topic?: Route | null }

/** Role-local routes; never call selectModel(), which also changes DSH's global default. */
export class ModelSettings {
  private work?:Promise<void>
  private timer?:ReturnType<typeof setTimeout>
  private closed=false
  private requested=false
  private readonly lifetime=new AbortController()
  onProbe?:(selection:ModelSelection,usage:TokenUsage|undefined,duration:number,ok:boolean,scope:ModelScope)=>void
  constructor(readonly ctx: Context, readonly store: AmphoreusStore, readonly roleId: string, readonly defaults: Defaults) {}
  private key(scope: ModelScope, taskId?: string) { return JSON.stringify([this.roleId, scope, taskId ?? null]) }
  configured(scope: ModelScope, taskId?: string): Route | null {
    const saved = this.store.record<{ selection: Route | null }>('model-route', this.key(scope, taskId))
    return saved ? saved.selection : taskId ? null : this.defaults[scope] ?? null
  }
  private task(scope: ModelScope, id?: string) {
    if (!id) return
    const task = this.store.task(id)
    if (!task || task.agent_id !== this.roleId || (task.kind ?? 'worker') !== scope) throw new Error('任务不存在或模型作用域不匹配')
  }
  async resolve(scope: ModelScope, taskId?: string): Promise<ModelSelection> {
    this.task(scope, taskId)
    const selection = (taskId ? this.configured(scope, taskId) : null) ?? this.configured(scope)
      ?? (scope === 'continuation' || scope === 'topic' ? this.configured('main') : null)
      ?? (this.ctx.get('agentDefaultModel') as { currentSelection(): ModelSelection }).currentSelection()
    return resolveRoleModel(this.ctx, selection)
  }
  reserve(raw:z.infer<typeof ModelInput>,requestId:string=randomUUID()){
    if(this.closed)throw Error('模型预订服务已停止')
    const input=ModelInput.parse(raw);this.task(input.scope,input.task_id)
    const id=`model-change-${createHash('sha256').update(JSON.stringify([this.roleId,requestId])).digest('hex')}`
    if(!this.store.record('model-change',id)){
      const targets=input.task_id?[this.store.task(input.task_id)!]:input.scope==='main'?[]:
        this.store.tasks({agentId:this.roleId,limit:10000}).filter(task=>(task.kind??'worker')===input.scope&&['running','queued','waiting','paused'].includes(task.state)&&!this.configured(input.scope,task.task_id))
      const job:ModelChange={id,role:this.roleId,input,before:JSON.stringify(this.store.record('model-route',this.key(input.scope,input.task_id))??null),
        recipients:['main',...targets.map(task=>task.task_id)],state:'queued'}
      this.store.atomic(()=>{this.store.setRecord('model-change',id,job);this.store.setRecord('model-change-latest',this.key(input.scope,input.task_id),id)})
    }
    this.wake()
    return{status:'reserved',message:'已预订'}
  }
  start(){
    for(const job of this.jobs())if(job.state==='testing')this.store.setRecord('model-change',job.id,{...job,state:'queued'})
    this.wake()
  }
  private jobs(){return this.store.records<ModelChange>('model-change').filter(job=>job.role===this.roleId)}
  private wake(){
    this.requested=true
    if(this.closed||this.work||this.timer||!this.jobs().some(job=>job.state==='queued'))return
    this.timer=setTimeout(()=>{
      this.timer=undefined;this.requested=false
      this.work=this.drain().catch(()=>{this.store.setRecord('error','model-change',{error:'模型预订暂未完成，已保留待重试状态。'})})
        .finally(()=>{this.work=undefined;if(this.requested)this.wake()})
    },0)
  }
  private async drain(){
    for(;;){
      if(this.closed)return
      const job=this.jobs().find(job=>job.state==='queued');if(!job)return
      this.store.setRecord('model-change',job.id,{...job,state:'testing'})
      let result:ChangeResult
      try{result=await this.configureTested(job.input,job)}catch{result={status:'rolled_back',message:'切换目标不可用，已回退。'}}
      if(this.closed){
        if(this.store.record<ModelChange>('model-change',job.id)?.state==='testing')this.store.setRecord('model-change',job.id,{...job,state:'queued'})
        return
      }
      if(this.store.record<ModelChange>('model-change',job.id)?.state==='testing')this.store.setRecord('model-change',job.id,{...job,state:result.status,result})
    }
  }
  async idle(){if(this.timer)await new Promise<void>(resolve=>setTimeout(resolve,0));await this.work}
  async stop(){this.closed=true;clearTimeout(this.timer);this.timer=undefined;this.lifetime.abort(Error('Model change service stopped'));await this.work}
  notices(scope:ModelScope,taskId?:string){
    const recipient=scope==='main'?'main':taskId
    if(!recipient)return[]
    const names={main:'主会话',worker:'工具助手',continuation:'潜意识',topic:'话题助手'}
    return this.jobs().filter(job=>job.result&&job.recipients.includes(recipient)&&!this.store.record('model-change-seen',JSON.stringify([job.id,recipient])))
      .slice(0,8).map(job=>({id:job.id,recipient,text:`${names[job.input.scope]}${job.input.task_id?`（${job.input.task_id}）`:''}模型 ${job.input.selection?`${job.input.selection.provider}/${job.input.selection.model}`:'跟随配置'} 切换${job.result!.status==='updated'?'成功。':`未生效，${job.result!.message??'已回退。'}`}`}))
  }
  acknowledge(id:string,recipient:string){this.store.setRecord('model-change-seen',JSON.stringify([id,recipient]),true)}
  private async prepare(input:z.infer<typeof ModelInput>){
    let selection: ModelSelection | null = null
    if (input.selection) {
      if (!this.ctx.llm.listProviders().some(provider => provider.id === input.selection!.provider)) throw new Error('提供方不可用，请检查 DSH 模型配置')
      try { selection = await resolveRoleModel(this.ctx, input.selection) }
      catch { throw new Error('模型或推理强度不可用，请检查 DSH 模型配置') }
    }
    return selection
  }
  async configure(input: z.infer<typeof ModelInput>) {
    this.task(input.scope,input.task_id)
    const selection=await this.prepare(input)
    this.store.setRecord('model-route',this.key(input.scope,input.task_id),{selection})
  }
  /** Probe a proposal without exposing an untested route to active Sessions. */
  async configureTested(input:z.infer<typeof ModelInput>,job?:ModelChange):Promise<ChangeResult>{
    this.task(input.scope,input.task_id)
    const key=this.key(input.scope,input.task_id),before=job?.before??JSON.stringify(this.store.record('model-route',key)??null)
    const assembler=new BlockAssembler(),started=Date.now();let selected:ModelSelection|undefined,ok=false
    try{
      if(job&&(this.store.record('model-change-latest',key)!==job.id||JSON.stringify(this.store.record('model-route',key)??null)!==before))return{status:'rolled_back',message:'预订已被更新，已回退；保留当前配置。'}
      const selection=await this.prepare(input)
      selected=selection??await resolveRoleModel(this.ctx,(input.task_id?this.configured(input.scope):null)
        ??(['continuation','topic'].includes(input.scope)?this.configured('main'):null)
        ??(this.ctx.get('agentDefaultModel') as {currentSelection():ModelSelection}).currentSelection())
      const signal=job?AbortSignal.any([AbortSignal.timeout(30000),this.lifetime.signal]):AbortSignal.timeout(30000)
      for await(const chunk of this.ctx.llm.stream({...selected,maxTokens:64,signal,messages:[{role:'user',content:[{type:'text',text:'Reply OK.'}]}]}))assembler.push(chunk)
      signal.throwIfAborted()
      if(!['stop','max-tokens'].includes(assembler.finish.kind)||!assembler.blocks().some(block=>(block.type==='text'||block.type==='reasoning')&&block.text.trim()))throw Error('Model probe failed')
      ok=true
      if(JSON.stringify(this.store.record('model-route',key)??null)!==before||job&&this.store.record('model-change-latest',key)!==job.id)return{status:'rolled_back',message:'设置已被更新，已回退；保留当前配置。'}
      this.store.atomic(()=>{this.store.setRecord('model-route',key,{selection});if(job)this.store.setRecord('model-change',job.id,{...job,state:'updated',result:{status:'updated'}})})
      return{status:'updated'}
    }catch{
      return{status:'rolled_back',message:'模型API测试失败或超时，已回退，继续使用原配置。'}
    }finally{if(selected)this.onProbe?.(selected,assembler.usage,Date.now()-started,ok,input.scope)}
  }
  async status(taskId?: string) {
    const view = async (scope: ModelScope, id?: string) => {
      const selection = this.configured(scope, id)
      try { return { selection, effective: await this.resolve(scope, id) } }
      catch { return { selection, effective: null, error: '当前模型不可用，请重新选择' } }
    }
    const roles = Object.fromEntries(await Promise.all(ModelScope.options.map(async scope => [scope, await view(scope)])))
    if (!taskId) return { roles }
    const task = this.store.task(taskId)
    if (!task || task.agent_id !== this.roleId) throw new Error('任务不存在')
    const scope = task.kind ?? 'worker'
    return { roles, task: { task_id: taskId, scope, ...await view(scope, taskId) } }
  }
  async catalog() {
    const catalog = await this.ctx.sessionController.modelCatalog()
    // Provider exceptions may contain request URLs or credential fragments. Do not expose them.
    return { default: catalog.default, groups: catalog.groups, failures: catalog.failures.map(item => ({ id: item.id, name: item.name, message: '模型列表暂不可用，请检查提供方配置' })) }
  }
}

/** Capture routing when a step assembles, so retries stay on that route and later steps see saved changes. */
export function installRoleRouting(ctx: Context, agent: Agent, settings: ModelSettings, scope: ModelScope, taskId?: string): () => void {
  let assembled: ModelSelection | undefined
  const disposers = [
    agent.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      const selected = await settings.resolve(scope, taskId)
      const result = await next()
      assembled = selected
      const last = agent.session.snapshotEvents().findLast(event => event.type === 'model/selection')
      if (!last || JSON.stringify(last.data) !== JSON.stringify(selected)) {
        // Attached Session.append publishes session/event itself. Emitting again queues
        // the same seq twice and permanently blocks the persistence writer's drain.
        agent.session.append('model/selection', selected)
      }
      return { ...result, variables: { ...result.variables, provider: selected.provider, model: selected.model } }
    }, { prepend: true }),
    agent.ctx.on('agent/request', async (_payload, next) => {
      const result = await next()
      if (!assembled) return result
      const { reasoningEffort: _inherited, ...rest } = result
      return { ...rest, ...assembled }
    }, { prepend: true }),
  ]
  return () => disposers.forEach(dispose => dispose())
}
