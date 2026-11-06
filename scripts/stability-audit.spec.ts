/** Optional accelerated lifecycle audit. No model/network calls or production database access. */
import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { Store } from '../src/app/store.ts'
import { AmphoreusStore } from '../src/amphoreus/store.ts'
import { MemoryStore } from '../src/amphoreus/memory.ts'
import { MemoryArchive } from '../src/amphoreus/archive.ts'
import { Telemetry } from '../src/amphoreus/telemetry.ts'
import { DshAgentDriver } from '../src/amphoreus/dsh.ts'

const result: Record<string, unknown> = { commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), source_dirty: spawnSync('git',['diff','--quiet']).status !== 0, model_calls: 0, network_calls: 0 }
const output = () => { if (process.env.AMPHOREUS_STABILITY_REPORT) writeFileSync(process.env.AMPHOREUS_STABILITY_REPORT, JSON.stringify(result, null, 2)+'\n') }
async function sample() {
  if (!globalThis.gc) throw new Error('Run with the supplied audit config to enable GC')
  for (let i=0;i<3;i++) { globalThis.gc(); await new Promise<void>(resolve=>setImmediate(resolve)) }
  const { heapUsed, rss, external, arrayBuffers } = process.memoryUsage()
  return { heapUsed, rss, external, arrayBuffers }
}

it('measures native tool/prompt/listener registration cleanup across 16000 wake cycles', async () => {
  const root=new Context(); await root.plugin(SystemPrompt); await root.plugin(ToolRuntime)
  const ctx=await new Promise<Context>(resolve=>{root.inject(['tools','systemPrompt'],child=>{resolve(child)})})
  const agent={id:SessionId('audit-agent')} as Agent,scope=createScope(ctx,agent);Object.assign(agent,{ctx:scope.ctx})
  const driver=new DshAgentDriver(ctx,()=>({agent_id:'audit',name:'角色',persona:'synthetic'}),'/unused',{main:null,worker:null},8)
  const controller=new AbortController(),points=[];let cycles=0
  const cycle=()=>{
    const release=[...(driver as any).scopeTools(agent,false,false,false,controller.signal),
      agent.ctx.systemPrompt.section({name:'audit-persona',order:1,text:()=> 'synthetic'}),
      agent.ctx.tools.register({name:'audit_tool',description:'temporary',parameters:{type:'object'},output:{schema:{type:'object'},render:()=>[]},execute:async()=>({})}),
      agent.ctx.on('agent/pre-step',async(_event,next)=>next())]
    release.reverse().forEach(stop=>stop());cycles++
  }
  try{
    for(let i=0;i<1000;i++)cycle()
    points.push({cycles,...await sample()})
    for(let batch=0;batch<5;batch++){
      for(let i=0;i<3000;i++)cycle()
      expect(ctx.tools.schemas(agent)).toEqual([])
      expect(await agent.ctx.systemPrompt.assemble()).not.toHaveProperty('audit-persona')
      points.push({cycles,...await sample()})
    }
    const heap_delta=points.at(-1)!.heapUsed-points[0]!.heapUsed
    result.native_scopes={cycles,points,heap_delta};output()
    expect(heap_delta).toBeLessThan(3*1024*1024)
  }finally{await root.fiber.dispose()}
})

it('measures archive/statistics retention across 26000 synthetic Session identities and verifies durable resume',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'amphoreus-stability-')),host=new Store(join(dir,'audit.sqlite'))
  // The database is disposable; one transaction per batch avoids unnecessary fsyncs/writes.
  const store=new AmphoreusStore(host),memory=new MemoryStore(host,'audit'),archive=new MemoryArchive(memory,store,{} as never),telemetry=new Telemetry(memory,store)
  const points=[];let sessions=0;const started=performance.now()
  const batch=async(count:number)=>{
    host.atomic(()=>{
      for(let i=0;i<count;i++){
        const id='audit-session-'+sessions++,binding={session_id:id,branch:'worker' as const,task_id:'task-'+id}
        archive.bind(binding)
        const session={id:SessionId(id),isOwnSeq:()=>true} as never
        const event={type:'step/start' as const,seq:SessionSeq(0),time:Date.now(),surfaceOp:'append' as const,data:{turn:1,step:1}}
        void archive.observe(session,event)
        telemetry.observe(session,binding,event)
      }
    })
    await new Promise<void>(resolve=>setImmediate(resolve))
    points.push({sessions,...await sample()})
  }
  try{
    await batch(1000)
    for(let i=0;i<5;i++)await batch(5000)
    const id=SessionId('audit-session-0'),binding=archive.binding(id)!
    expect(binding.task_id).toBe('task-'+id)
    const duplicate={type:'step/start' as const,seq:SessionSeq(0),time:Date.now(),surfaceOp:'append' as const,data:{turn:1,step:1}}
    await archive.observe({id,isOwnSeq:()=>true} as never,duplicate);telemetry.observe({id,isOwnSeq:()=>true},binding,duplicate)
    expect(store.record<{offset:number}>('memory-native',id)?.offset).toBe(1)
    expect(store.record<{offset:number}>('statistics-native',id)?.offset).toBe(1)
    const heap_delta=points.at(-1)!.heapUsed-points[0]!.heapUsed
    result.durable_cursors={sessions,duration_ms:performance.now()-started,points,heap_delta,durable_resume:true};output()
    expect(heap_delta).toBeLessThan(3*1024*1024)
  }finally{host.close();rmSync(dir,{recursive:true,force:true})}
})
