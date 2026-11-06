import {readFileSync} from 'node:fs'
import {JSDOM} from 'jsdom'
import {expect,it} from 'vitest'
it('shows summary first, fetches originals only on explicit request, and persists the opt-in organizer switch',async()=>{
 const dom=new JSDOM(readFileSync(new URL('../src/amphoreus/console.html',import.meta.url),'utf8'),{url:'http://localhost/',runScripts:'outside-only'}),w=dom.window as any,requests:string[]=[],posts:any[]=[]
 w.fetch=async(path:string,input:any={})=>{requests.push(path);let data:any
  if(input.method==='POST'){posts.push(JSON.parse(input.body));data={}}
  else if(path.includes('topic-organizer'))data={settings:{enabled:false,intervalMs:60000,batchSize:12},running:false,last_job:null}
  else if(path.startsWith('/api/topics?'))data={items:[{topic_id:'topic-a',title:'海边'}]}
  else data={title:'海边',text:'summary only',total_entries:2,originals:path.includes('include_original=true')?[{type:'message',text:'original conversation',at:new Date().toISOString(),source:{platform:'qq',actor_id:'123'},memory_id:'source-1'},{type:'thought',text:'fish thought',at:new Date().toISOString(),source:{branch:'main'},memory_id:'source-2'}]:[],next_offset:null}
  return{ok:true,json:async()=>data}
 }
 const script=readFileSync(new URL('../src/amphoreus/console.js',import.meta.url),'utf8').replace("if ($('login-form')) boot()",'')
 w.eval(script+'\nwindow.renderThreads=refreshTopicThreads;window.readThread=openTopicThread;')
 try{
  await w.renderThreads();expect(w.document.querySelector('#topic-organizer-settings input[type=checkbox]').checked).toBe(false)
  await w.readThread('topic-a');expect(w.document.getElementById('topic-thread-detail').textContent).toContain('summary only')
  expect(w.document.getElementById('topic-thread-detail').textContent).not.toContain('original conversation')
  expect(requests.some(r=>r.includes('include_original=true'))).toBe(false)
  await w.readThread('topic-a',true);expect(w.document.getElementById('topic-thread-detail').textContent).toContain('original conversation');expect(w.document.getElementById('topic-thread-detail').textContent).toContain('角色的想法')
  const form=w.document.querySelector('#topic-organizer-settings form');form.querySelector('input[type=checkbox]').checked=true;await form.onsubmit({preventDefault(){}})
  expect(posts).toEqual([{enabled:true,intervalMs:60000,batchSize:12}])
 }finally{dom.window.close()}
})
