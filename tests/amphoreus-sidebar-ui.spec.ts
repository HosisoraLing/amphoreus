import {readFileSync} from 'node:fs'
import {JSDOM} from 'jsdom'
import {expect,it} from 'vitest'
it('offers accessible navigation toggles in chat and management without removing existing views',()=>{
 const dom=new JSDOM(readFileSync(new URL('../src/amphoreus/console.html',import.meta.url),'utf8'),{url:'http://localhost/',runScripts:'outside-only'}),w=dom.window as any
 try{
  const script=readFileSync(new URL('../src/amphoreus/console.js',import.meta.url),'utf8').replace("if ($('login-form')) boot()",'')
  w.eval(script+'\nwindow.nav=setChatNavigation;window.decorate=decorateChrome;')
  w.decorate();w.nav(true)
  for(const id of ['page-nav-toggle','chat-nav-toggle']){const button=w.document.getElementById(id);expect(button.getAttribute('aria-controls')).toBe('app-navigation');expect(button.getAttribute('aria-expanded')).toBe('true')}
  expect(w.document.getElementById('nav-backdrop').hidden).toBe(false)
  w.nav(false);expect(w.document.body.classList.contains('chat-nav-open')).toBe(false)
  expect(w.document.getElementById('nav-backdrop').hidden).toBe(true)
  expect([...w.document.querySelectorAll('.sidebar nav [data-view]')].map((b:any)=>b.dataset.view)).toEqual(expect.arrayContaining(['models','memory','about','messages','people']))
 }finally{dom.window.close()}
})
