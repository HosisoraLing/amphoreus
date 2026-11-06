import {readFileSync} from 'node:fs'
import {JSDOM} from 'jsdom'
import {expect,it} from 'vitest'
it('shows migrated relationships as text and submits evidence-backed changes through the authenticated API',async()=>{
 const dom=new JSDOM(readFileSync(new URL('../src/amphoreus/console.html',import.meta.url),'utf8'),{url:'http://localhost/console/',runScripts:'outside-only'}),w=dom.window as any,posts:any[]=[]
 w.fetch=async(_path:string,input:any={})=>{
  if(input.method==='POST')posts.push(JSON.parse(input.body))
  return{ok:true,json:async()=>({total:1,people:[{identity:'qq:55500001',display_name:'<img src=x onerror=alert(1)>',accounts:[{ref:'qq:55500001',display_name:'测试'}],impressions:[{subject_ref:'qq:55500001',key:'喜好',body:'<script>bad()</script>',evidence:'原话',certainty:'reported'}],contacts:[{address:'person@example.test',label:'主邮箱'}]}]})}
 }
 const script=readFileSync(new URL('../src/amphoreus/console.js',import.meta.url),'utf8').replace("if ($('login-form')) boot()",'')
 w.eval(script+'\nwindow.renderPeople=refreshPeople;')
 try{
  await w.renderPeople()
  expect(w.document.querySelector('#people-list img, #people-list script')).toBeNull()
  expect(w.document.querySelector('#people-list').textContent).toContain('person@example.test')
  const form=w.document.querySelector('#people-list form');form.querySelector('[name=key]').value='喜好';form.querySelector('[name=body]').value='热茶';form.querySelector('[name=evidence]').value='明确自述'
  await form.onsubmit({preventDefault(){}})
  expect(posts[0]).toEqual({tool:'people_note',args:{identity:'qq:55500001',key:'喜好',body:'热茶',evidence:'明确自述'}})
  expect(w.document.querySelector('[data-view=people]').hasAttribute('data-admin')).toBe(true)
 }finally{w.close()}
})
