// Offline DOM fixture: no production API, model calls or QQ traffic.
import { readFileSync, writeFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
const base = new URL('../src/amphoreus/', import.meta.url)
const dom = new JSDOM(readFileSync(new URL('console.html', base), 'utf8'), { url:'http://localhost/amphoreus/', runScripts:'outside-only' })
const w = dom.window, d = w.document
d.getElementById('login-form').removeAttribute('id')
w.eval(readFileSync(new URL('console.js', base), 'utf8') + "\nroleName='测试角色'; principal={user:'owner',role:'admin'}; decorateChrome()")
d.getElementById('login').hidden=true; d.getElementById('app').hidden=false
const management=process.argv.includes('--management')
d.body.className=management?'embedded':'embedded chat-mode'
for(const n of d.querySelectorAll('.view')) n.hidden=n.id!==(management?'dashboard':'messages')
for(const n of d.querySelectorAll('[data-view]'))n.classList.toggle('selected',n.dataset.view===(management?'dashboard':'messages'))
d.getElementById('identity').textContent='owner · 管理者'
d.getElementById('role-name').textContent='测试角色'
d.getElementById('stream-state').textContent='● 实时同步'
d.getElementById('chat-title').textContent='测试角色'
d.getElementById('chat-connection').textContent='已连接'
const stamp = '2026-11-04T01:00:00Z'
const row=(id,text,out=false)=>({event:{event_id:id,visibility:'private',event_type:'message',platform:'web',account_id:'owner',actor_id:out?'角色':'owner',source_kind:out?'output-gateway':'web',timestamp:stamp,metadata:{},content:[{type:'text',text}]},state:'processed'})
const coding=process.argv.includes('--coding')
const list=d.getElementById('message-list'),ui=w.AmphoreusUI
list.append(ui.messageCard(row('1',coding?'把聊天界面整理得更清爽，保留思考和工具调用。':'看看今天的笔记，帮我整理一下吧。'),[]))
const thinking=ui.chatActivityCard({id:'r',kind:'reasoning',timestamp:stamp,text:'先阅读今天的笔记，再整理成简短的待办。这里只展示接口已提供、允许保留的思考记录。'},[])
list.append(thinking)
const result={kind:'tool_result',call_id:'c',text:'找到 3 条笔记：海边散步、整理书架、晚上看星星。'}
const tool=ui.chatActivityCard({id:'c',kind:'tool_call',call_id:'c',tool:'read_notes',arguments:{date:'今天'},timestamp:stamp},[result])
tool.open=!coding; thinking.open=coding; list.append(tool)
list.append(ui.messageCard(row('2',coding?'界面整理好了。保留完整的工作过程，让内容成为主角。\n\n### 这次的调整\n- **聊天排版**：更明确的文字层级与间距。\n- **工具卡片**：状态常驻，细节按需展开。\n- **消息输入**：统一入口，发送更清楚。\n\n```css\n.agent-canvas {\n  color: var(--ink);\n  max-width: 808px;\n}\n```':'整理好啦。\n\n**今天的小计划**\n去海边散步，回来整理书架。\n晚上留一点时间看星星，不用把每一分钟都填满。',true),[]))
for(const n of d.querySelectorAll('script,link[rel=stylesheet]'))n.remove()
const style=d.createElement('style');style.textContent=readFileSync(new URL('console.css',base),'utf8');d.head.append(style)
if (process.argv.includes('--audit')) {
  const audit=d.createElement('script')
  audit.textContent=`addEventListener('load',()=>{
    const management=${management};
    const $=id=>document.getElementById(id), width=innerWidth, checks=[];
    const check=(name,ok)=>checks.push({name,ok:!!ok});
    const navigation=$('app-navigation');
    check('no horizontal overflow',document.documentElement.scrollWidth<=width);
    if(!management){
    check('composer inside viewport',$('chat-form').getBoundingClientRect().bottom<=innerHeight);
    check('thinking visible',document.querySelector('.chat-reasoning').getBoundingClientRect().height>0);
    check('tool visible',document.querySelector('.chat-tool').getBoundingClientRect().height>0);
    }
    check('navigation baseline',width>900?Math.round(navigation.getBoundingClientRect().width)===232:getComputedStyle(navigation).display==='none');
    check('desktop navigation labels',width<=900||getComputedStyle(navigation.querySelector('nav button span')).display!=='none');
    document.body.classList.add('chat-nav-open');
    check('navigation expanded',Math.round(navigation.getBoundingClientRect().width)===(width>900?232:Math.min(280,width*.85)));
    document.body.classList.remove('chat-nav-open');
    check('content beside sidebar',width<=900||document.querySelector('main').getBoundingClientRect().left>=navigation.getBoundingClientRect().right);
    check('mobile page navigation reachable',!management||width>900||getComputedStyle($('page-nav-toggle')).display!=='none');
    if(!management){
    const scroll=$('chat-scroll').getBoundingClientRect(),input=$('chat-form').getBoundingClientRect();
    check('composer does not cover scroll region',scroll.bottom<=input.top);
    $('chat-options').hidden=false;
    check('options float without pushing conversation',Math.abs($('chat-scroll').getBoundingClientRect().top-scroll.top)<1);
    check('options fit viewport',$('chat-options').getBoundingClientRect().right<=width);
    }
    const result=document.createElement('pre');result.id='layout-audit';result.textContent=JSON.stringify(checks);document.body.append(result);
  });`
  d.body.append(audit)
}
writeFileSync(new URL('../webchat-preview.html',import.meta.url),dom.serialize())
dom.window.close()
