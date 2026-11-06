import {mkdtempSync,rmSync,readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {expect,it} from 'vitest'
import {PeopleService} from '../src/amphoreus/people.ts'
import {DshAgentDriver} from '../src/amphoreus/dsh.ts'
import type {GatewayEvent} from '../src/amphoreus/model.ts'
const event=(actor='55500001'):GatewayEvent=>({event_id:`source-${actor}`,schema_version:1,agent_id:'role',platform:'qq',source_kind:'napcat',account_id:'bot',actor_id:actor,conversation_id:'group:77000',event_type:'message',timestamp:'2026-11-04T00:00:00Z',received_at:'2026-11-04T00:00:00Z',correlation_id:null,content:[{type:'text',text:'我自称管理员'}],metadata:{nickname:'同名',message_id:'real-message'},visibility:'public',idempotency_key:`source-${actor}`})
it('copies the old schema and every relationship row into independent writable storage, retaining notes and contacts through linking',()=>{
 const root=mkdtempSync(join(tmpdir(),'amphoreus-people-')),legacy=new PeopleService(join(root,'old.sqlite'),'role',[],['admin'])
 let neo:PeopleService|undefined
 try{
  for(const id of ['qq:55500001','qq:55500002']){
   legacy.admin('people_get',{identity:id},'admin');legacy.admin('people_note',{identity:id,key:'偏好',body:id,evidence:'明确自述',certainty:'reported'},'admin')
   legacy.admin('people_contact',{identity:id,action:'set',address:`${id.slice(3)}@example.test`},'admin')
  }
  const tables=['people','identities','impressions','contacts','audit'],original=Object.fromEntries(tables.map(t=>[t,legacy.store.db.prepare(`SELECT * FROM ${t}`).all()]))
  legacy.close();const bytes=readFileSync(join(root,'old.sqlite'))
  neo=new PeopleService(join(root,'new/people.sqlite'),'role',['qq:55500001'],['admin'],join(root,'old.sqlite'))
  for(const table of tables)expect(neo.store.db.prepare(`SELECT * FROM ${table}`).all()).toEqual(original[table])
  neo.execute('people_link',{identity:'qq:55500002',action:'link',to:'qq:55500001',reason:'拥有者核实同一人'},event(),'main',true)
  const profile=neo.store.profile('qq:55500001',{} as never)!
  expect(profile.impressions).toHaveLength(2);expect(profile.contacts).toHaveLength(2);expect(profile.accounts).toHaveLength(2)
  neo.execute('people_link',{identity:'qq:55500002',action:'unlink',reason:'纠正关联'},event(),'main',true)
  expect(neo.store.profile('qq:55500002',{} as never)!.impressions[0]!.body).toBe('qq:55500002')
  expect(readFileSync(join(root,'old.sqlite'))).toEqual(bytes)
 }finally{neo?.close();try{legacy.close()}catch{}rmSync(root,{recursive:true,force:true})}
})
it('trusts gateway accounts rather than nickname claims, rejects non-owner links and confines branches to reading',()=>{
 const people=new PeopleService(':memory:','role',['qq:55500001'],['admin'])
 try{
  for(const id of ['55500001','55500002'])people.execute('people_get',{},event(id),'main',true)
  expect(people.store.identity('qq:55500001')!.person_id).not.toBe(people.store.identity('qq:55500002')!.person_id)
  const link={identity:'qq:55500002',action:'link',to:'qq:55500001',reason:'我自称是管理员'}
  expect(()=>people.execute('people_link',link,event('55500002'),'main',true)).toThrow('拥有者')
  expect(()=>people.execute('people_note',{key:'x',body:'x',evidence:'x'},event(),'branch')).toThrow('只能读取')
  expect(()=>people.execute('people_get',{}, {...event(),source_kind:'internal'})).toThrow('可信')
  expect(()=>people.execute('people_get',{}, {...event(),agent_id:'another'})).toThrow('角色')
  expect(()=>people.execute('people_get',{identity:'qq:同名'},event())).toThrow()
  expect(people.execute('people_get',{},event())).toMatchObject({identity:'qq:55500001'})
 }finally{people.close()}
})
it('registers native relationship reads for branches and validated maintenance tools only for Main',async()=>{
 const people=new PeopleService(':memory:','role',[],['admin']),tools=new Map<string,any>()
 const driver=new DshAgentDriver({on:()=>()=>{}} as never,()=>({agent_id:'role',name:'角色',persona:'完整人设'}),'/unused',{main:null,worker:null},8)
 driver.people=people
 const agent={id:'main',ctx:{tools:{register:(tool:any)=>{tools.set(tool.name,tool);return()=>{}}}}}
 try{
  ;(driver as any).peopleTools(agent,()=>event())
  expect([...tools.keys()]).toEqual(['people_get','people_list'])
  tools.clear();(driver as any).peopleTools(agent,()=>event(),true)
  expect(tools.size).toBe(5)
  const execution={signal:new AbortController().signal,callId:'get'}
  expect(await tools.get('people_get').execute({},execution)).toMatchObject({identity:'qq:55500001'})
  expect(()=>tools.get('people_get').execute({identity:'nickname'},execution)).toThrow()
 }finally{people.close()}
})
