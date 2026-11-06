import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { expect, it } from 'vitest'
const wait = async (check:()=>boolean) => { for(let n=0;n<100;n++){if(check())return;await new Promise(resolve=>setTimeout(resolve,5))}throw new Error('Auth UI did not settle') }
it('uses standalone /console APIs, clears enrollment secrets and requires saving recovery codes',async()=>{
 const dom=new JSDOM(readFileSync(new URL('../src/amphoreus/console.html',import.meta.url),'utf8'),{url:'http://localhost:2333/console',runScripts:'outside-only'})
 const w=dom.window as any,d=w.document,requests:string[]=[]
 w.EventSource=class { addEventListener(){} close(){} }
 w.fetch=async(path:string,input:any={})=>{
  requests.push(path);let value:any={},status=200
  if(path.endsWith('/api/me')){status=401;value={error:'Authentication required'}}
  else if(path.endsWith('/auth/enroll'))value={challenge:'c'.repeat(64),secret:'ABCDEF',user:'alice',qr:'data:image/png;base64,AA=='}
  else if(path.endsWith('/auth/confirm'))value={user:'alice',role:'chat',recovery:['recovery-one','recovery-two']}
  else if(path.endsWith('/status'))value={role:{name:'角色'}}
  else if(path.includes('/conversations')||path.includes('/messages')||path.includes('/tasks'))value=[]
  return {ok:status===200,status,json:async()=>value}
 }
 try{
  w.eval(readFileSync(new URL('../src/amphoreus/console.js',import.meta.url),'utf8')+'\nglobalThis.testIdle=()=>!loading;globalThis.testClean=()=>{clearTimeout(refreshTimer);stream?.close()}')
  const el=(id:string)=>d.getElementById(id)
  expect(el('auth-transport-warning').hidden).toBe(false)
  el('auth-tab-enroll').click();expect(el('auth-enroll-form').hidden).toBe(false)
  el('auth-enroll-token').value='a'.repeat(40);el('auth-new-password').value='a strong password'
  el('auth-enroll-form').dispatchEvent(new w.Event('submit',{cancelable:true}))
  await wait(()=>!el('auth-confirm-form').hidden)
  expect(el('auth-secret').textContent).toBe('ABCDEF')
  expect(el('auth-enroll-token').value).toBe('');expect(el('auth-new-password').value).toBe('')
  el('auth-confirm-code').value='123456';el('auth-confirm-form').dispatchEvent(new w.Event('submit',{cancelable:true}))
  await wait(()=>!el('auth-recovery').hidden)
  expect(el('auth-qr').hasAttribute('src')).toBe(false);expect(el('auth-secret').textContent).toBe('')
  expect(el('auth-finish').disabled).toBe(true);expect(el('app').hidden).toBe(true)
  expect(el('auth-recovery-codes').textContent).toContain('recovery-one')
  el('auth-saved').checked=true;el('auth-saved').dispatchEvent(new w.Event('change'));el('auth-finish').click()
  await wait(()=>!el('app').hidden&&w.testIdle())
  expect(el('auth-recovery-codes').textContent).toBe('')
  expect(requests.every(path=>path.startsWith('/console/api/'))).toBe(true)
  expect(w.localStorage.length).toBe(0)
 }finally{w.testClean?.();dom.window.close()}
})
