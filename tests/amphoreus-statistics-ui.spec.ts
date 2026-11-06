import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { expect, it } from 'vitest'
it('renders scoped usage, empty samples, billing settings and paginated redacted logs without interpreting HTML',async()=>{
  const dom=new JSDOM(readFileSync(new URL('../src/amphoreus/console.html',import.meta.url),'utf8'),{url:'http://localhost/console/',runScripts:'outside-only'}),w=dom.window as any
  const requests:any[]=[]
  const totals={total:12345,input:100,output:245,read:12000,write:0,requests:2,missing_usage:1,unpriced:1,cny:.01,usd:.02,cache_hit_rate:.99,average_cache_hit_rate:.9}
  const data={since:'2026-11-03T00:00:00.000Z',as_of:'2026-11-05T08:00:00.000Z',days:3,total:totals,subagents:totals,roles:[{scope:'worker',...totals}],sessions:[{session:'worker-1',scope:'worker',task_id:'task-1',...totals}],models:[{model:'mock/<img src=x onerror=evil()>',provider:'mock',...totals}],daily:[],daily_average:{tokens:4115,cny:.003,usd:.006},activations:{main:10,main_daily:3.33},reply_latency:{samples:0,average_ms:null,maximum_ms:null},context_fill:{samples:0,average_minutes:null},reliability:{web_searches:5,tool_calls:9,failed_runs:1,completed_runs:9},coverage:{native_sessions:2,notes:['说明']},billing:{settings:{goPlan:'go',usdCny:null,logRetentionDays:90,holidays:[],providerKinds:{}},pricing:{as_of:'2026-11-05',sources:['https://api-docs.deepseek.com/zh-cn/quick_start/pricing/']},windows:[{used:.1,average:.05,observed_windows:3}],go_subscription_monthly_usd:10,go_subscription_daily_usd:.333}}
  Object.assign(data,{memory_health:{index:{consistent:true,indexed:40,originals:40},dreaming_cursor_lag:3,alerts:[{message:'<img src=x> 不变量告警'}]},memory_metrics:{search_average_ms:12,searches:4,injected_tokens:700,compaction_attempts:2,compaction_failures:1}})
  w.fetch=async(path:string,input:any={})=>{requests.push([path,input.body]);return{ok:true,json:async()=>path.includes('/logs')?{items:[{at:data.as_of,level:'error',scope:'worker',summary:'调用 <img src=x>',data:{error:'已隐藏'},task:'task-1'}],has_more:true,next_cursor:9,retention_days:90}:data}}
  w.eval(readFileSync(new URL('../src/amphoreus/console.js',import.meta.url),'utf8').replace("if ($('login-form')) boot()",'')+"\nprincipal={role:'admin',user:'owner'};window.statistics=refreshStatistics;window.logs=refreshLogs;window.setup=setupStatisticsPages;")
  try{
    w.setup();await w.statistics();const d=w.document
    expect(d.querySelector('#statistics-metrics').textContent).toContain('记忆索引')
    expect(d.querySelector('#statistics-metrics img')).toBeNull()
    expect(d.querySelector('#statistics-metrics').textContent).toContain('暂无完整周期')
    expect(d.querySelector('#statistics-metrics').textContent).toContain('暂无样本')
    expect(d.querySelector('#statistics-models img')).toBeNull()
    expect(d.querySelector('#statistics-models').textContent).toContain('<img src=x')
    expect(d.querySelector('#statistics-plan').value).toBe('go')
    d.querySelector('#statistics-exchange').value='7.1';await w.statistics();expect(d.querySelector('#statistics-exchange').value).toBe('7.1')
    await w.logs();expect(d.querySelector('#logs-list img')).toBeNull()
    expect(d.querySelector('#logs-list').textContent).toContain('已隐藏')
    expect(d.querySelector('#logs-older').disabled).toBe(false)
    expect(requests[0][0]).toMatch(/^\/console\/api\/statistics/)
    expect(d.querySelector('[data-view=statistics]')).not.toBeNull();expect(d.querySelector('[data-view=logs]')).not.toBeNull()
  }finally{w.close()}
})
