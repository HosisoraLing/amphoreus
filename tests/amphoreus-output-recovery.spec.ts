import { mkdtempSync,rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach,expect,it,vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import { AmphoreusStore } from '../src/amphoreus/store.ts'
import { MessageGateway } from '../src/amphoreus/gateway.ts'
import { OutputRecovery,DeliverySettings } from '../src/amphoreus/output-recovery.ts'

const cleanup:(()=>void)[]=[]
afterEach(()=>{cleanup.splice(0).reverse().forEach(stop=>stop());vi.restoreAllMocks()})
function open(statuses:('sent'|'failed'|'unknown')[],inspection:'sent'|'failed'|'unknown'='unknown',smtp=false){
  const dir=mkdtempSync(join(tmpdir(),'amphoreus-output-')),host=new Store(join(dir,'state.sqlite')),store=new AmphoreusStore(host),gateway=new MessageGateway(store)
  cleanup.push(()=>{host.close();rmSync(dir,{recursive:true,force:true})})
  const send=vi.fn(async()=>statuses.shift()??'sent'),inspect=vi.fn(async()=>({status:inspection})),notify=vi.fn(async()=>{})
  gateway.registerOutput({platform:'qq',send,inspect})
  const settings=DeliverySettings.parse({retryDelayMs:0,...(smtp?{mail:{url:'https://mail.test',token:'private-mail-test-token',to:'owner@example.test'}}:{})})
  const recovery=new OutputRecovery(store,gateway,()=>true,settings,()=>Date.now(),smtp?undefined:notify)
  gateway.onOutput=output=>recovery.schedule(output)
  const speak=()=>gateway.speak({agentId:'role',runId:'run',callId:'call',target:{platform:'qq',account_id:'123',conversation_id:'private:456'},content:[{type:'text',text:'发送内容'}]},()=>true)
  return {store,gateway,recovery,send,inspect,notify,speak,settings}
}

it('retries once in the background and returns the original failed result without occupying Main',async()=>{
  const f=open(['failed','sent']),first=await f.speak()
  expect(first.status).toBe('failed');expect(f.send).toHaveBeenCalledTimes(1)
  await f.recovery.tick()
  expect(f.store.output(first.output_id)?.status).toBe('sent');expect(f.send).toHaveBeenCalledTimes(2)
  expect(f.notify).not.toHaveBeenCalled();expect(f.store.tasks()).toHaveLength(0)
  await f.recovery.tick();await f.speak();expect(f.send).toHaveBeenCalledTimes(2)
})

it('defers retries and SMTP while role/channel sending is switched off',async()=>{
 const f=open(['failed','sent']),output=await f.speak()
 f.gateway.canSend=()=>false;await f.recovery.tick()
 expect(f.send).toHaveBeenCalledTimes(1);expect(f.notify).not.toHaveBeenCalled()
 expect(f.store.record('output-recovery',output.output_id)).toMatchObject({state:'waiting',attempts:0})
 f.gateway.canSend=()=>true;await f.recovery.tick()
 expect(f.send).toHaveBeenCalledTimes(2);expect(f.store.output(output.output_id)?.status).toBe('sent')
})

it('emails after the automatic retry fails and never creates a repair subagent or duplicate alert',async()=>{
  const f=open(['failed','failed']),first=await f.speak();await f.recovery.tick()
  expect(f.send).toHaveBeenCalledTimes(2);expect(f.notify).toHaveBeenCalledTimes(1)
  expect(f.store.tasks()).toHaveLength(0)
  const restored=new OutputRecovery(f.store,f.gateway,()=>true,f.settings,()=>Date.now(),f.notify)
  await restored.tick();expect(f.send).toHaveBeenCalledTimes(2);expect(f.notify).toHaveBeenCalledTimes(1)
  expect(f.store.record('output-recovery',first.output_id)).toMatchObject({state:'alerted',attempts:1})
})

it('checks ambiguous sends before resending and recognizes a successful platform receipt',async()=>{
  const f=open(['unknown'],'sent'),first=await f.speak();await f.recovery.tick()
  expect(f.inspect).toHaveBeenCalledTimes(1);expect(f.send).toHaveBeenCalledTimes(1)
  expect(f.store.output(first.output_id)?.status).toBe('sent');expect(f.notify).not.toHaveBeenCalled()
})

it('retries if the platform confirms failure, but emails without blindly duplicating an unconfirmed send',async()=>{
  const known=open(['unknown','sent'],'failed'),first=await known.speak();await known.recovery.tick()
  expect(known.send).toHaveBeenCalledTimes(2);expect(known.store.output(first.output_id)?.status).toBe('sent')
  const uncertain=open(['unknown'],'unknown');await uncertain.speak();await uncertain.recovery.tick()
  expect(uncertain.send).toHaveBeenCalledTimes(1);expect(uncertain.notify).toHaveBeenCalledTimes(1)
})

it('uses the existing SMTP bridge with the configured recipient and no message body or credentials in alert content',async()=>{
  const fetcher=vi.spyOn(globalThis,'fetch').mockResolvedValue(Response.json({ok:true})),f=open(['failed','failed'],'unknown',true)
  const first=await f.speak();await f.recovery.tick()
  expect(fetcher).toHaveBeenCalledTimes(1)
  const [url,options]=fetcher.mock.calls[0]!,body=JSON.parse(String(options?.body))
  expect(String(url)).toBe('https://mail.test/send');expect(body.to).toBe('owner@example.test')
  expect(body.body).not.toContain('发送内容');expect(body.body).not.toContain('private-mail-test-token')
  expect(f.store.record('output-recovery',first.output_id)).toMatchObject({state:'alerted'})
})

it('records SMTP failure visibly and preserves an interrupted notification without resending it',async()=>{
  const fetcher=vi.spyOn(globalThis,'fetch').mockResolvedValue(Response.json({ok:false},{status:502})),f=open(['failed','failed'],'unknown',true)
  const first=await f.speak();await f.recovery.tick()
  expect(f.store.record('output-recovery',first.output_id)).toMatchObject({state:'mail-failed'})
  await f.recovery.tick();expect(fetcher).toHaveBeenCalledTimes(1)
  f.store.setRecord('output-recovery',first.output_id,{output_id:first.output_id,state:'notifying',attempts:1,due:0})
  await f.recovery.tick();expect(fetcher).toHaveBeenCalledTimes(1)
})
