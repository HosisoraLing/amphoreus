import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach,expect,it} from 'vitest'
import {Store} from '../src/app/store.ts'
import {AmphoreusStore} from '../src/amphoreus/store.ts'
import {normalizeEvent} from '../src/amphoreus/model.ts'
import {UserBlocklist,BlocklistInput} from '../src/amphoreus/blocklist.ts'
const stops:(()=>void)[]=[]
afterEach(()=>stops.splice(0).reverse().forEach(stop=>stop()))
function open(){
 const dir=mkdtempSync(join(tmpdir(),'user-blocklist-')),host=new Store(join(dir,'db.sqlite')),store=new AmphoreusStore(host),list=new UserBlocklist(store,'role','123')
 stops.push(()=>{host.close();rmSync(dir,{recursive:true,force:true})})
 let seq=0
 const message=(user='456',conversation='group:44',account='123',metadata:Record<string,unknown>={})=>{
  const event=normalizeEvent({agent_id:'role',source_kind:'napcat',platform:'qq',account_id:account,conversation_id:conversation,actor_id:user,event_type:'message',timestamp:new Date().toISOString(),content:[{type:'mention',platform:'qq',actor_id:'123'},{type:'text',text:`message from ${user}`}],metadata,visibility:'public',correlation_id:null,idempotency_key:String(++seq)})
  store.insertEvent(event);return event
 }
 return{store,list,message}
}
it('persists blocks across group/private sources without affecting other users/accounts/roles',()=>{
 const f=open(),group=f.message(),privateMessage=f.message('456','private:456'),other=f.message('777'),account=f.message('456','group:44','999')
 f.list.configure({action:'block',user_id:'456',reason:'测试原因'})
 const restored=new UserBlocklist(f.store,'role','123')
 expect(restored.allowed(group)).toBe(false);expect(restored.allowed(privateMessage)).toBe(false);expect(restored.allowed(other)).toBe(true);expect(restored.allowed(account)).toBe(true)
 expect(new UserBlocklist(f.store,'other-role','123').blocked('456')).toBe(false)
 expect(restored.list()).toMatchObject([{user_id:'456',reason:'测试原因'}]);expect(f.store.event(group.event_id)).toBeDefined()
 expect(()=>f.list.configure({action:'block',user_id:'123'})).toThrow('itself')
 expect(()=>BlocklistInput.parse({action:'block'})).toThrow();expect(()=>BlocklistInput.parse({action:'block',user_id:'name'})).toThrow()
})
it('suppresses pending and disabled-period messages forever after unblock, not future messages',()=>{
 const f=open(),pending=f.message()
 f.list.configure({action:'block',user_id:'456'})
 const during=f.message('456','group:44','123',{user_blocked:true,qq_receive_enabled:false})
 f.list.configure({action:'unblock',user_id:'456'})
 expect(f.list.allowed(pending)).toBe(false);expect(f.list.allowed(during)).toBe(false)
 expect(f.store.event(pending.event_id)?.state).toBe('processed');expect(f.list.allowed(f.message())).toBe(true)
 expect(f.list.list()).toHaveLength(0)
})
it('preserves allowed members of mixed batches and excludes blocked sources from recent channel context',()=>{
 const f=open(),blocked=f.message(),allowed=f.message('777')
 f.list.configure({action:'block',user_id:'456'})
 const batch={...allowed,source_kind:'qq-debounce',metadata:{source_event_ids:[blocked.event_id,allowed.event_id],origin_event_id:blocked.event_id}}
 expect(f.list.allowed(batch)).toBe(true)
 expect(f.list.allowed({...batch,metadata:{source_event_ids:[blocked.event_id]}})).toBe(false)
 expect(f.list.allowed({...batch,metadata:{source_event_ids:['unknown']}})).toBe(false)
 const rows=f.store.recentChannelMessages('role','9999-01-01T00:00:00Z','none').flat()
 expect(rows.map(e=>e.event_id)).not.toContain(blocked.event_id);expect(rows.map(e=>e.event_id)).toContain(allowed.event_id)
})
