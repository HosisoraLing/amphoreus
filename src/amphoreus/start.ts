import type { Context } from '@deepseek-ai/cordis'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { lockSync } from 'proper-lockfile'
import { Store } from '../app/store.ts'
import { AmphoreusStore } from './store.ts'
import { AmphoreusRuntime } from './runtime.ts'
import { DshAgentDriver } from './dsh.ts'
import { AmphoreusHttp } from './http.ts'
import { QQAdapter } from './qq.ts'
import { readConfiguration,AmphoreusConfig } from './config.ts'
import { readTaskActivity } from './activity.ts'
import { registerHarnessPanel } from './harness.ts'
import { MemoryStore,MemorySettings } from './memory.ts'
import { MemoryArchive, type ArchiveBinding } from './archive.ts'
import { Dreaming } from './dreaming.ts'
import { TaskLifecycle } from './lifecycle.ts'
import { MediaInput } from './media.ts'
import { GroupParticipation } from './participation.ts'
import { QQControl } from './qq-control.ts'
import { UserBlocklist } from './blocklist.ts'
import { nativeFooterReader } from './usage.ts'
import { Recollection } from './recollection.ts'
import { TopicOrganizer } from './topic-organizer.ts'
import { organizerClassifier } from './topic-organizer-llm.ts'
import { TopicThreads } from './topic-threads.ts'
import { PeopleService } from './people.ts'
import {manageSettings} from './settings.ts'
import { ModelSettings } from './models.ts'
import { MemeService } from './memes.ts'
import { Telemetry } from './telemetry.ts'
import { installSessionHeaders } from './opencode-session.ts'

export async function startAmphoreus(ctx: Context, stateDir: string, configPath: string): Promise<() => Promise<void>> {
  const config = readConfiguration(configPath)
  const sessionHeaders = await installSessionHeaders()
  ctx.effect(() => sessionHeaders.restore)
  ctx.logger.info('翁法罗斯内置模型会话头兼容：%s', sessionHeaders.enabled ? '已启用' : '宿主未安装此适配器')
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  mkdirSync(config.workspace, { recursive: true, mode: 0o700 })
  const unlock = lockSync(stateDir, { realpath: false })
  let host: Store | undefined, runtime: AmphoreusRuntime | undefined, api: AmphoreusHttp | undefined, qq: QQAdapter | undefined, dreaming: Dreaming | undefined, lifecycle: TaskLifecycle | undefined, people:PeopleService|undefined,topicOrganizer:TopicOrganizer|undefined, memes:MemeService|undefined, modelSettings:ModelSettings|undefined, stopped = false
  const stop = async () => {
    if (stopped) return
    stopped = true
    try { await topicOrganizer?.stop(); dreaming?.stop(); await qq?.control?.stop(); await qq?.presence?.stop(); await lifecycle?.stop(); await qq?.stop(); await api?.stop(); await runtime?.stop(); await modelSettings?.stop() }
    finally { memes?.stop(); people?.close(); host?.close(); unlock() }
  }
  try {
    host = new Store(join(stateDir, 'orchestrator.sqlite'))
    host.db.exec('PRAGMA busy_timeout=5000')
    const store = new AmphoreusStore(host)
    const role = store.record<typeof config.role>('identity', config.role.agent_id) ?? config.role
    const memory = new MemoryStore(host, role.agent_id, MemorySettings.parse(store.record('memory-policy',role.agent_id)??config.memory))
    new Recollection(memory).repairTopics()
    const secrets=[...config.api.tokens.map(token=>token.token),config.qq?.token??'',config.media.asr?.apiKey??'',config.delivery.mail?.token??'']
    const telemetry = new Telemetry(memory, store, secrets)
    store.onOperation = (...args) => telemetry.operation(...args)
    const archive = new MemoryArchive(memory, store, ctx, secrets)
    telemetry.measure=session=>{
      const meter=ctx.get('tokenMeter') as {measure(session:unknown):{totalTokens:number}}|undefined
      return meter?.measure(session).totalTokens??null
    }
    const limits=AmphoreusConfig.shape.limits.parse({...config.limits,...store.record<object>('runtime-settings',role.agent_id)})
    const driver = new DshAgentDriver(ctx, () => role, config.workspace, config.models, limits.mainSteps, archive, limits.collaborationSteps, limits.reviewSteps)
    driver.modelSettings = modelSettings = new ModelSettings(ctx, store, role.agent_id, config.models)
    driver.modelSettings.onProbe=(selected,usage,duration,ok,scope)=>telemetry.auxiliary(selected.provider,selected.model,usage,duration,ok,scope,'model-test')
    driver.onMetric=(kind,session,data)=>telemetry.metric(kind,session,data,archive.binding(session))
    memes=new MemeService(ctx,join(stateDir,'../../amphoreus/memes'),store,()=>driver.modelSettings!.configured('worker')??driver.modelSettings!.configured('main'),(...args)=>telemetry.auxiliary(...args,'meme'))
    await memes.start();driver.memes=memes
    people=new PeopleService(join(stateDir,'people.sqlite'),role.agent_id,config.people.ownerIdentities,config.api.tokens.filter(user=>user.role==='admin').map(user=>user.user),join(stateDir,'../../amphoreus/legacy-fishtank/.consistent/home/people/people.sqlite'))
    driver.people=people
    memory.entityRefs=ref=>{
      const person=people!.store.identity(ref)
      return person?people!.store.db.prepare('SELECT ref FROM identities WHERE person_id=? ORDER BY ref').all(person.person_id).map(row=>String(row.ref)):[]
    }
    runtime = new AmphoreusRuntime(store, driver, role, limits,config.delivery)
    topicOrganizer=new TopicOrganizer(memory,store,organizerClassifier(ctx,()=>driver.modelSettings!.configured('worker')??driver.modelSettings!.configured('main'),(...args)=>telemetry.auxiliary(...args)))
    driver.topicOrganizer=topicOrganizer
    for(const topic of memory.recent(100000,0,'topic'))if(topic.status==='active')new TopicThreads(memory).seed(String(topic.data.topic_id))
    runtime.permitChannel=target=>{
      const known=store.conversations().some(c=>c.agent_id===role.agent_id&&c.platform===target.platform&&c.account_id===target.account_id&&c.conversation_id===target.conversation_id)
      if(!known)return false
      if(target.platform==='web')return config.api.tokens.some(user=>user.user===target.account_id)
      const match=/^(group|private):(\d+)$/.exec(target.conversation_id)
      if(target.platform!=='qq'||!config.qq?.enabled||target.account_id!==config.qq.accountId||!match)return false
      const allow=match[1]==='group'?config.qq.allowedGroups:config.qq.allowedUsers
      return allow.includes('*')||allow.includes(match[2]!)
    }
    lifecycle = new TaskLifecycle(ctx, store, role.agent_id, config.workspace)
    runtime.onTaskIdle = task => lifecycle!.archiveTask(task)
    dreaming = new Dreaming(memory, runtime); archive.dreaming = dreaming
    dreaming.onHealth=()=>telemetry.audit()
    if (config.qq) qq = new QQAdapter(runtime, config.qq,[config.workspace,join(stateDir,'../../attachments')],block=>{
      if(!block.attachment)return undefined
      return block.type==='image'?ctx.attachments.imageHostPath(block.attachment as never):ctx.attachments.fileHostPath(block.attachment as never)
    })
    if (qq && config.qq?.enabled) {
      qq.presence = new GroupParticipation(runtime,config.qq,(action,params)=>qq!.request(action,params))
      driver.presence = qq.presence
      qq.control=new QQControl(runtime,config.qq.accountId)
      qq.control.routeGroupsThroughParticipation=true
      runtime.controls.qqAccount=config.qq.accountId
      runtime.controls.extraConversations=()=>qq!.groupConversations()
      runtime.controls.qqEnabled=conversation=>qq!.control!.settings(conversation).receiveEnabled
      runtime.controls.qqOverride=conversation=>qq!.control!.override(conversation)
      runtime.controls.setQQ=(conversation,enabled)=>qq!.control!.setReceiving(conversation,enabled)
      qq.control.canReceive=conversation=>runtime!.controls.scopeEnabled({platform:'qq',account_id:config.qq!.accountId,conversation_id:conversation})
      driver.qqControl=qq.control
      qq.blocklist=new UserBlocklist(store,role.agent_id,config.qq.accountId)
      driver.blocklist=qq.blocklist
      qq.blocklist.onChange=()=>runtime!.onChange()
      qq.control.canAdmit=event=>runtime!.controls.allows(event)&&qq!.blocklist!.allowed(event)
      qq.presence.canAdmit=event=>runtime!.controls.allows(event)&&qq!.blocklist!.allowed(event)
      runtime.permitInput=event=>event.platform!=='qq'||qq!.control!.enabled(event.conversation_id)&&qq!.blocklist!.allowed(event)
      qq.presence.canReceive=group=>qq!.control!.enabled(group)
      qq.control.onPolicyChange=()=>runtime!.applyControls()
      runtime.onControlsChange=()=>{qq!.control!.clearDisabled();qq!.presence!.clearDisabled()}
    }
    driver.media = new MediaInput(ctx.attachments, store, memory, config.media, config.qq?.enabled ? (action, params) => qq!.request(action, params) : undefined)
    if(qq?.blocklist){
      driver.media.canAdmit=event=>runtime!.controls.allows(event)&&qq!.blocklist!.allowed(event)
      driver.media.blockedUser=(account,user)=>account===qq!.blocklist!.accountId&&qq!.blocklist!.blocked(user)
      driver.media.hasBlockedUsers=()=>qq!.blocklist!.list().length>0
    }
    if(!qq?.blocklist)driver.media.canAdmit=event=>runtime!.controls.allows(event)
    driver.canAdmit=event=>runtime!.controls.allows(event)
    runtime.prepareOutput=async(content,target)=>driver.media!.outgoing(await memes!.outgoing(content,target.platform),[config.workspace,join(stateDir,'../../attachments'),memes!.root])
    driver.manageSettings=(input,requestId)=>manageSettings(input,{runtime:runtime!,memory,presence:qq?.presence,qq:qq?.control,models:driver.modelSettings!,organizer:topicOrganizer!,memes:memes!,telemetry,steps:driver},requestId)
    api = new AmphoreusHttp(runtime, config.api, qq, (task, offset, limit) => readTaskActivity(ctx, task, offset, limit,
      secrets), memory, dreaming,driver.media,nativeFooterReader(ctx),people,driver.modelSettings,topicOrganizer,telemetry,memes)
    topicOrganizer.canRun=()=>runtime!.controls.enabled
    topicOrganizer.canInclude=record=>{const event=record.source.event_id?store.event(record.source.event_id)?.event:undefined;return !event||runtime!.controls.allows(event)&&runtime!.permitInput(event)}
    topicOrganizer.onChange=()=>runtime!.onChange()
    const notify = runtime.onChange
    runtime.onChange = () => { topicOrganizer?.reconcile(); archive.captureGateway(); people?.capture(store); dreaming?.reconcile(); qq?.presence?.wake(); qq?.control?.wake(); notify() }
    archive.onThought = async record => {
      const origin = record.source.event_id ? store.event(record.source.event_id)?.event : undefined
      await runtime!.gateway.ingest('internal', { agent_id: role.agent_id, source_kind: 'internal', platform: 'internal', account_id: role.agent_id,
        conversation_id: origin?.conversation_id ?? 'main', actor_id: role.agent_id, event_type: 'assistant.thought', timestamp: record.created_at,
        received_at: record.created_at, correlation_id: record.source.run_id ?? null, content: [{ type: 'text', text: record.text }],
        metadata: { schedule: false, memory_id: record.id, branch: record.source.branch }, visibility: 'internal', idempotency_key: `thought:${record.id}` })
      runtime!.onChange()
    }
    archive.onSelfConfirmed = record => runtime!.syncSelf(record.id, record.source.event_id, record.source.run_id)
    ctx.inject(['connection'], child => { child.effect(() => registerHarnessPanel(child, api!)) })
    ctx.on('session/event', (session, event) => {
      if (!archive.binding(session.id)) return
      void archive.observe(session, event).catch(() => { store.setRecord('error', 'memory-archive', { error: '历史归档暂未完成，原生记录保留，重启后补入。' }); runtime?.onChange() })
      try { telemetry.observe(session, archive.binding(session.id)!, event) } catch { store.setRecord('error','statistics',{error:'统计记录暂未完成，原生日志保留，重启后补录。'}) }
      if (['assistant/message', 'tool/call', 'tool/result', 'turn/end'].includes(event.type)) runtime?.onChange()
    })
    await api.listen()
    qq?.start(api.server)
    const bindings = new Map<string, ArchiveBinding>()
    for (const run of store.runs(10000).reverse()) bindings.set(run.session_id, { session_id: run.session_id, branch: 'main', run_id: run.run_id, event_id: run.event_id })
    for (const task of store.tasks({ agentId: role.agent_id, limit: 10000 })) bindings.set(task.subagent_id, { session_id: task.subagent_id, branch: task.kind==='topic'?'topic':task.kind === 'continuation' ? 'continuation' : 'worker', task_id: task.task_id, event_id: task.origin?.event_id, run_id: task.parent_run_id, parent_session_id: task.fork?.parent_session_id })
    await archive.backfill([...bindings.values()])
    await telemetry.backfill(ctx, [...bindings.values()])
    runtime.applyControls()
    modelSettings.start()
    await runtime.start()
    qq?.presence?.start()
    qq?.control?.start()
    await lifecycle.start()
    dreaming.start()
    topicOrganizer.start()
    ctx.logger.info('翁法罗斯已就绪，端口 %s；QQ %s；B站暂缓', config.api.port, config.qq?.enabled ? '已启用' : '已关闭')
    return stop
  } catch (error) { await stop(); throw error }
}
