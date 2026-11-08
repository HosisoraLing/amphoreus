import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {afterEach,expect,it,vi} from 'vitest'
import {Store} from '../src/app/store.ts'
import {AmphoreusStore} from '../src/amphoreus/store.ts'
import {AmphoreusRuntime} from '../src/amphoreus/runtime.ts'
import {MemorySettings,MemoryStore} from '../src/amphoreus/memory.ts'
import {GroupParticipation} from '../src/amphoreus/participation.ts'
import {QQControl} from '../src/amphoreus/qq-control.ts'
import {QQConfig} from '../src/amphoreus/qq.ts'
import {TopicOrganizer} from '../src/amphoreus/topic-organizer.ts'
import {Telemetry} from '../src/amphoreus/telemetry.ts'
import {MemeService} from '../src/amphoreus/memes.ts'
import {manageSettings,SettingsInput} from '../src/amphoreus/settings.ts'
import {DshAgentDriver} from '../src/amphoreus/dsh.ts'
const clean:(()=>unknown)[]=[]
afterEach(async()=>{for(const close of clean.splice(0).reverse())await close()})
function setup(){
 const dir=mkdtempSync(join(tmpdir(),'amphoreus-settings-')),host=new Store(join(dir,'db.sqlite')),store=new AmphoreusStore(host)
 const runtime=new AmphoreusRuntime(store,{main:async()=>{},task:async()=>'',messageTask:async()=>{},stop:async()=>{}},{agent_id:'role',name:'role',persona:'private persona'},{maxWorkers:1,mainTimeoutMs:0,taskTimeoutMs:10000,progressIntervalMs:1000})
 const memory=new MemoryStore(host,'role',MemorySettings.parse({reasoning:{retentionDays:14},dreaming:{at:'02:00'}}))
 const presence=new GroupParticipation(runtime,QQConfig.parse({accountId:'123',token:'private-napcat-key',allowedGroups:['*']}),async()=>({}))
 const qq=new QQControl(runtime,'123'),organizer=new TopicOrganizer(memory,store,async()=>({groups:[]}))
 const memes=new MemeService({} as never,join(dir,'memes'),store,()=>null);mkdirSync(memes.root)
 writeFileSync(memes.settingsFile,JSON.stringify({sendMode:'auto',privateRemoteToken:'never-return-this',sendChance:30}))
 const steps={mainSteps:8,collaborationSteps:60,reviewSteps:16},models={configureTested:vi.fn(async()=>({status:'updated',message:''})),status:vi.fn(async()=>({roles:{}})),catalog:vi.fn(async()=>({groups:[]}))}
 const services={runtime,memory,presence,qq,organizer,memes,telemetry:new Telemetry(memory,store),steps,models:models as never}
 clean.push(()=>{host.close();rmSync(dir,{recursive:true,force:true})});clean.push(()=>presence.stop());clean.push(()=>qq.stop())
 return{...services,models,dir,host,store,call:(input:Parameters<typeof manageSettings>[0])=>manageSettings(input,services)}
}
it('updates shared application settings partially, persists policy and limits, and does not expose credentials',async()=>{
 const f=setup()
 expect(await f.call({})).toMatchObject({sections:expect.arrayContaining(['participation','models','memory','runtime'])})
 await f.call({section:'participation',values:{mode:'heart',followupMs:90000},conversation_id:'group:456'})
 expect(f.presence.settings('group:456')).toMatchObject({mode:'heart',followupMs:90000,probability:.02})
 await f.call({section:'participation',values:{probability:.2},conversation_id:'group:456'})
 expect(f.presence.settings('group:456').mode).toBe('heart')
 await f.call({section:'qq',conversation_id:'group:456',values:{debounceEnabled:true}})
 expect(f.qq.settings('group:456').debounceEnabled).toBe(true)
 await f.call({section:'memory',values:{dreaming:{enabled:false},reasoning:{retainImportantRaw:true}}})
 expect(f.memory.settings.dreaming).toMatchObject({enabled:false,at:'02:00',consolidation:false})
 expect(f.memory.settings.reasoning.retentionDays).toBe(14)
 expect(new MemoryStore(f.host,'role',MemorySettings.parse(f.store.record('memory-policy','role'))).settings).toEqual(f.memory.settings)
 await f.call({section:'runtime',values:{maxWorkers:4,mainSteps:12,resumeOnRestart:false}})
 expect(f.runtime.limits).toMatchObject({maxWorkers:4,mainTimeoutMs:0})
 expect(f.steps.mainSteps).toBe(12);expect(f.store.record('runtime-settings','role')).toMatchObject({resumeOnRestart:false,maxWorkers:4})
 await f.call({section:'models',values:{scope:'worker',selection:{provider:'known',model:'coding'}}})
 expect(f.models.configureTested).toHaveBeenCalledWith({scope:'worker',selection:{provider:'known',model:'coding'}})
 await f.call({section:'memes',values:{sendMode:'text',sendChanceEnabled:true}})
 expect(f.memes.settings()).toMatchObject({sendMode:'text',sendChance:30,privateRemoteToken:'never-return-this'})
 expect(JSON.stringify(await f.call({section:'memes'}))).not.toContain('never-return-this')
 await f.call({section:'organizer',values:{batchSize:3}});expect(f.organizer.settings().batchSize).toBe(3)
 await f.call({section:'statistics',values:{goPlan:'go'}});expect(f.telemetry.settings().goPlan).toBe('go')
 await f.call({section:'controls',values:{enabled:false,platform:'web'}});expect(f.runtime.controls.channelEnabled('web')).toBe(false)
 expect(JSON.stringify(await f.call({section:'controls'}))).not.toContain('private persona')
})
it('rejects unsupported settings and out-of-range values before changing stored configuration',async()=>{
 const f=setup()
 for(const input of [{section:'participation',values:{probability:2}},{section:'memory',values:{reasoning:{apiKey:'secret'}}},{section:'runtime',values:{maxWorkers:100}},{section:'memes',values:{remoteDirUrl:'https://untrusted.test'}},{section:'models',values:{scope:'main',selection:{provider:'x'}}}])
  await expect(f.call(input as never)).rejects.toThrow()
 expect(f.store.record('memory-policy','role')).toBeUndefined();expect(f.runtime.limits.maxWorkers).toBe(1)
 expect(f.memes.settings().sendMode).toBe('auto')
})
it('registers the settings capability only on Main using plain JSON tool parameters',async()=>{
 const driver=new DshAgentDriver({on:vi.fn(()=>()=>{})} as never,()=>({agent_id:'role',name:'role',persona:'persona'}),'/unused',{main:null,worker:null},8)
 ;(driver as any).ensure=async()=>({id:'main',session:{},ctx:{get:()=>undefined,tools:{register:vi.fn()}}})
 driver.manageSettings=vi.fn(async()=>({status:'updated'}))
 const registered=new Map<string,any>();(driver as any).register=(_agent:unknown,name:string,_description:string,schema:unknown,execute:unknown)=>{registered.set(name,{schema,execute});return()=>{}}
 ;(driver as any).run=async(agent:unknown,_id:unknown,_input:unknown,_prompt:unknown,_worker:unknown,_signal:unknown,tools:(agent:unknown)=>unknown)=>{tools(agent)}
 const event={event_id:'source',source_kind:'web',platform:'web',account_id:'owner',conversation_id:'web:owner:chat',actor_id:'owner',metadata:{},content:[{type:'text',text:'settings'}]}
 await driver.main({event,origin:event,runId:'run'} as never,new AbortController().signal)
 const tool=registered.get('amphoreus_settings');expect(tool).toBeDefined()
 await tool.execute(SettingsInput.parse({section:'runtime',values:{resumeOnRestart:false}}))
 expect(driver.manageSettings).toHaveBeenCalledWith(expect.objectContaining({section:'runtime',values:{resumeOnRestart:false}}))
})

it('returns the model API rollback receipt directly instead of reporting a successful settings update',async()=>{
 const f=setup()
 f.models.configureTested.mockResolvedValueOnce({status:'rolled_back',message:'模型API测试失败，已回退'})
 expect(await f.call({section:'models',values:{scope:'main',selection:{provider:'known',model:'unavailable'}}})).toEqual({status:'rolled_back',message:'模型API测试失败，已回退'})
 expect(f.store.record('settings-change','role:models')).toBeUndefined()
})
