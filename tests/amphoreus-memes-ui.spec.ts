import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { expect,it } from 'vitest'
it('uses authenticated compact image IDs, preserves in-progress edits and routes picker input through the gateway',async()=>{
 const dom=new JSDOM(readFileSync(new URL('../src/amphoreus/console.html',import.meta.url),'utf8'),{url:'http://localhost/console/',runScripts:'outside-only'}),w=dom.window as any,d=w.document,requests:any[]=[]
 const item={id:'a'.repeat(24),caption:'<img src=x onerror=evil()>',tag:'happy',keywords:'笑',pack:'mine',packName:'收藏'},data={packs:[{id:'mine',name:'收藏',count:1,enabled:true}],items:[item],settings:{packId:'mine',sendMode:'auto'}}
 w.fetch=async(path:string,options:any={})=>{requests.push({path,body:options.body?JSON.parse(options.body):undefined});return{ok:true,json:async()=>path.includes('memes/message')?{event_id:'accepted'}:data}}
 w.eval(readFileSync(new URL('../src/amphoreus/console.js',import.meta.url),'utf8').replace("if ($('login-form')) boot()",'')+"\nprincipal={role:'admin',user:'owner'};window.start=setupMemes;window.load=refreshMemes;window.picker=loadMemePicker;refresh=async()=>{};")
 try{
  w.start();await w.load();expect(d.querySelectorAll('#memes-grid img')).toHaveLength(1);expect(d.querySelector('#memes-grid img').getAttribute('src')).toBe('/console/api/memes/image/'+item.id)
  expect(d.querySelector('#memes-grid').textContent).toContain('<img src=x onerror=evil()>');const edit=d.querySelector('#memes-grid input[aria-label="描述"]');edit.value='未保存';edit.focus();data.items[0]!.caption='来自刷新';await w.load();expect(d.querySelector('#memes-grid input[aria-label="描述"]').value).toBe('未保存')
  d.querySelector('#meme-picker').close=()=>{};await w.picker();await d.querySelector('#meme-picker-grid button').onclick();const request=requests.find(r=>r.path.includes('/memes/message'));expect(request.body).toMatchObject({id:item.id});expect(Object.keys(request.body).sort()).toEqual(['id','idempotency_key'])
  expect(d.querySelector('[data-view=memes]')).not.toBeNull()
 }finally{w.close()}
})
