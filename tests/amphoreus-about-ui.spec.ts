import {readFileSync} from 'node:fs'
import {JSDOM} from 'jsdom'
import {expect,it} from 'vitest'
import {aboutInfo} from '../src/amphoreus/about.ts'
it('renders master/channel and every group/private switch, preserves details and changes only the requested scope',async()=>{
 const dom=new JSDOM(readFileSync(new URL('../src/amphoreus/console.html',import.meta.url),'utf8'),{url:'http://localhost/console/',runScripts:'outside-only'}),w=dom.window as any,posts:any[]=[]
 const state={enabled:true,channels:[{platform:'qq',account_id:'12345',enabled:true,effective:true,available:true,conversations:[{account_id:'12345',conversation_id:'group:77777',title:'<img src=x onerror=alert(1)>',enabled:true,effective:true,override:null},{account_id:'12345',conversation_id:'private:55555',title:'朋友',enabled:true,effective:true,override:null}]},{platform:'bilibili',enabled:false,effective:false,available:false,conversations:[]}]}
 w.fetch=async(path:string,input:any={})=>{
  if(input.method==='POST'){
   const body=JSON.parse(input.body);posts.push(body)
   if(!body.platform)state.enabled=body.enabled
   else if(!body.conversation_id)state.channels[0]!.enabled=body.enabled
   else{const chat=state.channels[0]!.conversations.find(c=>c.conversation_id===body.conversation_id)!;chat.enabled=body.enabled??true;chat.override=body.reset?null:body.enabled}
   for(const channel of state.channels){channel.effective=state.enabled&&channel.enabled;for(const conversation of channel.conversations)conversation.effective=channel.effective&&conversation.enabled}
  }
  return{ok:true,json:async()=>path.includes('/about')?aboutInfo():state}
 }
 const script=readFileSync(new URL('../src/amphoreus/console.js',import.meta.url),'utf8').replace("if ($('login-form')) boot()",'')
 w.eval(script+"\nprincipal={role:'admin',user:'owner'};roleName='角色';window.renderAbout=refreshAbout;")
 try{
  await w.renderAbout();const d=w.document
  expect(d.querySelector('#about-controls img')).toBeNull()
  expect(d.querySelector('#about-version').textContent).toContain('AGPL-3.0-only')
  expect(d.querySelector('#about-source-links a').href).toBe('https://github.com/HosisoraLing/amphoreus')
  expect(d.querySelector('#about-license-usage').textContent).toContain('第13条')
  expect(d.querySelector('#about-software').textContent).toContain('DeepSeek Harness Superagent Prototype')
  expect(d.querySelector('#about-software').textContent).toContain('Limited Redistribution License')
  expect(d.querySelector('[aria-label="B站 渠道"]').disabled).toBe(true)
  const details=d.querySelector('details[data-platform=qq]');details.open=true
  let toggle=d.querySelector('[data-conversation="group:77777"]');toggle.checked=false;await toggle.onchange()
  expect(posts[0]).toEqual({platform:'qq',account_id:'12345',conversation_id:'group:77777',enabled:false})
  expect(d.querySelector('details[data-platform=qq]').open).toBe(true)
  expect(d.querySelector('[data-conversation="private:55555"]').checked).toBe(true)
  const reset=[...d.querySelectorAll('#about-controls button')].find((b:any)=>b.textContent==='恢复默认') as any;await reset.onclick()
  expect(posts[1]).toEqual({platform:'qq',account_id:'12345',conversation_id:'group:77777',reset:true})
  toggle=d.querySelector('[aria-label="QQ 渠道"]');toggle.checked=false;await toggle.onchange()
  expect(posts[2]).toEqual({platform:'qq',enabled:false})
  expect(d.querySelector('#about-controls').textContent).toContain('渠道已关闭')
  expect(d.querySelector('[data-conversation="private:55555"]').checked).toBe(true)
  toggle=d.querySelector('[aria-label="角色 总开关"]');toggle.checked=false;await toggle.onchange()
  expect(posts[3]).toEqual({enabled:false});expect(d.querySelector('#about-controls').textContent).toContain('总开关已关闭')
  const search=d.querySelector('[data-channel-search=qq]');search.value='朋友';search.oninput()
  expect(d.querySelector('[data-conversation="group:77777"]').closest('[data-search]').hidden).toBe(true)
  expect(d.querySelector('[data-conversation="private:55555"]').closest('[data-search]').hidden).toBe(false)
 }finally{w.close()}
})
it('lets a normal chat reader view licenses without fetching administrator controls',async()=>{
 const dom=new JSDOM(readFileSync(new URL('../src/amphoreus/console.html',import.meta.url),'utf8'),{url:'http://localhost/console/',runScripts:'outside-only'}),w=dom.window as any,paths:string[]=[]
 w.fetch=async(path:string)=>{paths.push(path);return{ok:true,json:async()=>aboutInfo()}}
 w.eval(readFileSync(new URL('../src/amphoreus/console.js',import.meta.url),'utf8').replace("if ($('login-form')) boot()",'')+"\nprincipal={role:'chat',user:'alice'};window.renderAbout=refreshAbout;")
 try{await w.renderAbout();expect(paths).toEqual(['/console/api/about']);expect(w.document.querySelector('[data-view=about]')).not.toBeNull()}finally{w.close()}
})
