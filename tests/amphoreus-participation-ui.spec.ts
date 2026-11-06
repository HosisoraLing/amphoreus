import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { expect,it } from 'vitest'
import { ParticipationSettings } from '../src/amphoreus/participation.ts'

it('lets the owner select heart mode and saves it without overriding group settings',async()=>{
  const dom=new JSDOM(readFileSync(new URL('../src/amphoreus/console.html',import.meta.url),'utf8'),{url:'http://localhost/',runScripts:'outside-only'})
  const w=dom.window as any,posts:unknown[]=[]
  w.fetch=async(path:string,input:{body?:string}={})=>{
    const data=input.body?(posts.push(JSON.parse(input.body)),{}):path.includes('qq-message-control')?{settings:{receiveEnabled:true,debounceEnabled:false,waitMs:3000,maxWaitMs:30000},conversations:[]}:{settings:ParticipationSettings.parse({}),groups:[]}
    return {ok:true,json:async()=>data}
  }
  const script=readFileSync(new URL('../src/amphoreus/console.js',import.meta.url),'utf8').replace("if ($('login-form')) boot()",'')
  w.eval(script+'\nwindow.renderParticipation=refreshParticipation;')
  try{
    await w.renderParticipation()
    const form=w.document.querySelector('#participation-settings form'),select=form.querySelector('select')
    expect([...select.options].map((option:any)=>option.textContent)).toEqual(['混合调度','心意模式'])
    select.value='heart';await form.onsubmit({preventDefault(){}})
    expect(posts).toEqual([expect.objectContaining({settings:expect.objectContaining({mode:'heart'})})])
    expect(posts[0]).not.toHaveProperty('group')
    expect(form.querySelector('button').textContent).toBe('已保存')
  }finally{dom.window.close()}
})
