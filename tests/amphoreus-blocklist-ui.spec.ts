import {readFileSync} from 'node:fs'
import {JSDOM} from 'jsdom'
import {expect,it} from 'vitest'
it('lets an owner block/unblock exact QQ users without inserting untrusted reason HTML',async()=>{
 const dom=new JSDOM(readFileSync(new URL('../src/amphoreus/console.html',import.meta.url),'utf8'),{url:'http://localhost/',runScripts:'outside-only'})
 const w=dom.window as any,posts:any[]=[],items:any[]=[]
 w.fetch=async(_path:string,input:any={})=>{
  if(input.method==='POST'){const body=JSON.parse(input.body);posts.push(body);if(body.action==='block')items.push({user_id:body.user_id,reason:body.reason,blocked_at:new Date().toISOString()});else items.splice(0)}
  return{ok:true,json:async()=>({items:[...items]})}
 }
 const script=readFileSync(new URL('../src/amphoreus/console.js',import.meta.url),'utf8').replace("if ($('login-form')) boot()",'')
 w.eval(script+'\nwindow.renderBlacklist=refreshBlacklist;')
 try{
  await w.renderBlacklist()
  const form=w.document.querySelector('#user-blacklist form');form.querySelector('[name=user_id]').value='456';form.querySelector('[name=reason]').value='<img src=x onerror=alert(1)>'
  await form.onsubmit({preventDefault(){}})
  expect(posts[0]).toEqual({action:'block',user_id:'456',reason:'<img src=x onerror=alert(1)>'})
  expect(w.document.querySelector('#user-blacklist img')).toBeNull()
  const remove=[...w.document.querySelectorAll('#user-blacklist button')].find((b:any)=>b.textContent==='解除拉黑') as any
  await remove.onclick()
  expect(posts[1]).toEqual({action:'unblock',user_id:'456'})
  expect(w.document.getElementById('user-blacklist').textContent).toContain('暂无拉黑用户')
 }finally{dom.window.close()}
})
