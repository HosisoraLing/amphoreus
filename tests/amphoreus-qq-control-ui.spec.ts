import {readFileSync} from 'node:fs'
import {JSDOM} from 'jsdom'
import {expect,it} from 'vitest'
it('shows receive/debounce switches for groups and private conversations, persists edits and resets overrides',async()=>{
 const dom=new JSDOM(readFileSync(new URL('../src/amphoreus/console.html',import.meta.url),'utf8'),{url:'http://localhost/amphoreus/',runScripts:'outside-only'})
 const w=dom.window as any,posts:any[]=[]
 const settings={receiveEnabled:true,debounceEnabled:false,waitMs:3000,maxWaitMs:30000}
 w.EventSource=class{addEventListener(){}close(){}}
 w.fetch=async(path:string,input:any={})=>{let data:any;const url=new URL(path,w.location.href)
  if(input.method==='POST'){posts.push(JSON.parse(input.body));data={}}
  else if(url.pathname.endsWith('/me'))data={user:'owner',role:'admin'}
  else if(url.pathname.endsWith('/status'))data={role:{name:'fish'}}
  else if(url.pathname.endsWith('/qq-message-control'))data={settings,conversations:[{conversation_id:'group:44',title:'群聊',settings,override:{},pending:0},{conversation_id:'private:55',title:'私聊',settings,override:{},pending:0}]}
  else if(url.pathname.endsWith('/participation'))data={settings:{mode:'hybrid',probability:.05,windowMs:60000,maxMessages:20,cooldownMs:720000,inertiaMs:120000,shareHigh:.35,shareStop:.5,fatigue:true,sleep:true},groups:[]}
  else if(url.pathname.endsWith('/conversations')||url.pathname.endsWith('/tasks')||url.pathname.endsWith('/messages'))data=[]
  else if(url.pathname.endsWith('/chat-activity'))data={items:[],has_more:false}
  else data={available:false}
  return{ok:true,json:async()=>data}
 }
 w.eval(readFileSync(new URL('../src/amphoreus/console.js',import.meta.url),'utf8')+'\nwindow.cleanup=()=>clearTimeout(refreshTimer);')
 const wait=async(fn:()=>boolean)=>{for(let i=0;i<100;i++){if(fn())return;await new Promise(r=>setTimeout(r,5))}throw Error('QQ control UI did not settle')}
 try{
  await wait(()=>!w.document.getElementById('app').hidden);w.document.querySelector('[data-view="participation"]').click()
  await wait(()=>w.document.getElementById('qq-message-controls').textContent.includes('private:55'))
  const group=w.document.querySelectorAll('#qq-message-controls details')[0],form=group.querySelector('form')
  const checks=form.querySelectorAll('input[type=checkbox]');checks[0].checked=false;checks[1].checked=true
  await form.onsubmit({preventDefault(){}});await wait(()=>posts.length===1)
  expect(posts[0]).toMatchObject({conversation_id:'group:44',patch:{receiveEnabled:false,debounceEnabled:true,waitMs:3000}})
  await form.querySelector('button[type=button]').onclick();await wait(()=>posts.length===2)
  expect(posts[1]).toEqual({conversation_id:'group:44',reset:true})
 }finally{w.cleanup();dom.window.close()}
})
