import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { afterEach, expect, it } from 'vitest'
const windows: JSDOM[] = []
afterEach(async () => {
  for (const dom of windows.splice(0)) {
    const ui = dom.window as any
    await eventually(() => ui.__chatIdle())
    ui.__chatCleanup()
    dom.window.close()
  }
})
const eventually = async (check: () => boolean) => { for (let n = 0; n < 100; n++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)) }; throw new Error('UI did not settle') }
function setup(withTask = false, many = false, embedded = false, admin = false) {
  const dom = new JSDOM(readFileSync(new URL('../src/amphoreus/console.html', import.meta.url), 'utf8'), { url: embedded ? 'http://localhost:13101/amphoreus/' : 'http://localhost:2333/', runScripts: 'outside-only', pretendToBeVisual: true })
  windows.push(dom)
  const w = dom.window, document = w.document
  const chats = [{ conversation_id: 'web:alice:first', platform: 'web', account_id: 'alice', title: '第一个对话', preview: '第一段' },
    { conversation_id: 'web:alice:second', platform: 'web', account_id: 'alice', title: '第二个对话', preview: '第二段' },
    { conversation_id: 'group:123', platform: 'qq', account_id: 'bot', title: '测试群', preview: '群消息' }]
  const makeRow = (conversation: string, id: string, text: string) => ({ event: { event_id: id, source_kind: 'web', platform: 'web', account_id: 'alice',
    conversation_id: conversation, actor_id: 'alice', visibility: 'private', timestamp: new Date().toISOString(), metadata: { nickname: 'alice' }, content: [{ type: 'text', text }] }, state: 'processed' })
  const messages = new Map<string, any[]>([['web:alice:first', [makeRow('web:alice:first', 'first-1', '第一段')]],
    ['web:alice:second', Array.from({ length: many ? 61 : 1 }, (_, n) => makeRow('web:alice:second', `second-${n}`, `第二段消息${n}`))]])
  messages.set('group:123', [{ ...makeRow('group:123', 'qq-1', '群消息'), event: { ...makeRow('group:123', 'qq-1', '群消息').event, platform: 'qq', source_kind: 'napcat', account_id: 'bot', actor_id: '456', metadata: { nickname: '小鱼', group_name: '测试群' } } }])
  const posts: any[] = [], listeners = new Map<string, () => void>(), requests: string[] = [], streams: string[] = []
  let failNext = false, heldResolve: (() => void) | undefined, held = false
  ;(w as any).EventSource = class { constructor(path: string) { streams.push(path) } addEventListener(type: string, listener: () => void) { listeners.set(type, listener) } close() {} }
  ;(w as any).fetch = async (path: string, input: any = {}) => {
    const url = new URL(path, w.location.href)
    requests.push(url.pathname); url.pathname = url.pathname.replace(/^\/amphoreus\//, '/')
    let value: unknown
    if (url.pathname === '/api/me') value = { user: 'alice', role: admin ? 'admin' : 'chat' }
    else if (url.pathname === '/api/status') value = { role: { name: '测试角色' } }
    else if (url.pathname === '/api/chat-footer') value = { available:true, source:'dsh-session-projections',contextPressure:{projectedTokens:250,pressureTokens:200,contextWindow:1000},contextBreakdown:{systemTokens:50,toolsTokens:50,messageTokens:100},tokenUsage:{uncachedInputTokens:100,cacheReadTokens:300,cacheWriteTokens:0,outputTokens:100},sessionStats:{turns:3,steps:5,llmMs:4000,toolMs:1000,ttftMs:1000,ttftSteps:2,decodeMs:2000,decodeTokens:100} }
    else if (url.pathname === '/api/chat-activity') value = { has_more: false, next_cursor: 3, items: [
      { id: 'r1', event_id: 'first-1', kind: 'reasoning', text: '接口允许展示的思考', timestamp: new Date().toISOString() },
      { id: 'c1', event_id: 'first-1', kind: 'tool_call', call_id: 'tool-1', tool: 'read_file', arguments: { file: 'notes.txt' }, timestamp: new Date().toISOString() },
      { id: 'o1', event_id: 'first-1', kind: 'tool_result', call_id: 'tool-1', text: '文件读取完成', timestamp: new Date().toISOString() }] }
    else if (url.pathname === '/api/conversations') value = chats
    else if (url.pathname === '/api/tasks') value = withTask ? [{ task_id: 'test-task', description: '检查工作区', state: 'completed' }] : []
    else if (url.pathname === '/api/reports') value = withTask ? [{task_id:'test-task',type:'completed',summary:'任务完成',created_at:new Date().toISOString()}] : []
    else if (url.pathname === '/api/models') value = {roles:{worker:{selection:null,effective:{provider:'host',model:'default'}}},task:{task_id:'test-task',scope:'worker',selection:null,effective:{provider:'host',model:'default'}},catalog:{groups:[],failures:[]}}
    else if (url.pathname === '/api/tasks/test-task') value = { task: { task_id: 'test-task', subagent_id: 'worker', description: '检查工作区', state: 'completed', context: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString(), priority: 0 }, reports: [{ task_id: 'test-task', type: 'completed', summary: '任务完成', created_at: new Date().toISOString() }] }
    else if (url.pathname === '/api/tasks/test-task/activity') value = { available: true, end_offset: 3, has_more: false, items: [{ id: '1', kind: 'message', text: '正在检查', timestamp: new Date().toISOString() }, { id: '2', kind: 'tool_call', call_id: 'call', tool: 'bash', arguments: { command: 'pwd' }, timestamp: new Date().toISOString() }, { id: '3', kind: 'tool_result', call_id: 'call', text: '/workspace', timestamp: new Date().toISOString() }] }
    else if (url.pathname === '/api/messages' && input.method === 'POST') {
      const body = JSON.parse(input.body); posts.push(body)
      if (failNext) { failNext = false; throw new Error('网络暂时断开') }
      if (held) await new Promise<void>(resolve => { heldResolve = resolve })
      const id = `web:alice:${body.conversation}`
      const row = makeRow(id, `sent-${posts.length}`, body.content); row.state = 'processing'
      messages.set(id, [row, ...(messages.get(id) || [])])
      if (!chats.some(chat => chat.conversation_id === id)) chats.unshift({ conversation_id: id, platform: 'web', account_id: 'alice', title: body.content, preview: body.content })
      value = { event_id: row.event.event_id, status: 'queued' }
    } else if (url.pathname === '/api/messages') {
      const offset = Number(url.searchParams.get('offset') || 0)
      value = [...messages.values()].flat().filter(row => (!url.searchParams.get('conversation') || row.event.conversation_id === url.searchParams.get('conversation')) && (!url.searchParams.get('platform') || row.event.platform === url.searchParams.get('platform'))).slice(offset, offset + 50)
    } else throw new Error(`Unexpected endpoint ${path}`)
    return { ok: true, json: async () => value }
  }
  w.eval(readFileSync(new URL('../src/amphoreus/console.js', import.meta.url), 'utf8') + '\nwindow.__chatIdle = () => !loading && !queued && !sending; window.__chatCleanup = () => clearTimeout(refreshTimer); window.__chatRows=(rows,items)=>{messageRows=rows;chatActivityItems=items;renderChat()};window.__chatRefresh=refreshChat;window.__chatMore=loadOlderMessages;window.__chatCount=()=>messageRows.length;')
  const el = (id: string) => document.getElementById(id) as any
  const input = (text: string) => { el('chat-input').value = text; el('chat-input').dispatchEvent(new w.Event('input', { bubbles: true })) }
  const filter = (platform: string, conversation = '') => { el('source').value = platform; el('source').dispatchEvent(new w.Event('change')); el('conversation-filter').value = conversation; el('conversation-filter').dispatchEvent(new w.Event('change')) }
  return { dom, w, document, el, input, filter, posts, messages, listeners, requests, streams,
    fail: () => { failNext = true }, hold: () => { held = true }, release: () => { held = false; heldResolve?.() } }
}

it('bounds an unattended live transcript while allowing explicit older-history paging',async()=>{
  const ui=setup();await eventually(()=>ui.el('message-list').textContent.includes('第一段'))
  const w=ui.w as any,first=ui.messages.get('web:alice:first')![0]
  for(let batch=0;batch<12;batch++){
    const rows=Array.from({length:40},(_,n)=>({...first,event:{...first.event,event_id:`live-${batch}-${n}`,content:[{type:'text',text:`新消息 ${batch}-${n}`}]}}))
    ui.messages.set('web:alice:first',[...rows,...ui.messages.get('web:alice:first')!])
    await w.__chatRefresh()
  }
  expect(w.__chatCount()).toBe(200)
  expect(ui.el('message-list').textContent).toContain('新消息 11-0')
  expect(ui.el('older-messages').hidden).toBe(false)
  await w.__chatMore()
  expect(w.__chatCount()).toBe(250)
  expect(ui.el('message-list').textContent).toContain('新消息 6-0')
  const next={...first,event:{...first.event,event_id:'live-next',content:[{type:'text',text:'继续收到的新消息'}]}}
  ui.messages.get('web:alice:first')!.unshift(next)
  await w.__chatRefresh()
  expect(w.__chatCount()).toBe(250)
  expect(ui.el('message-list').textContent).toContain('继续收到的新消息')
})

it('filters clean task rows and opens a read-only conversation with details and lazy model settings',async()=>{
 const ui=setup(true,false,false,true);await eventually(()=>ui.el('message-list').textContent.includes('第一段'))
 ;(ui.document.querySelector('[data-view=tasks]')as HTMLElement).click();await eventually(()=>!!ui.document.querySelector('.task-list-row'))
 expect(ui.el('task-list').querySelector('.task-card')).toBeNull();expect(ui.el('task-list-summary').textContent).toContain('1 项任务')
 ui.el('task-state-filter').value='active';ui.el('task-state-filter').dispatchEvent(new ui.w.Event('change'));expect(ui.el('task-list').textContent).toContain('当前筛选下没有任务')
 ui.el('task-state-filter').value='ended';ui.el('task-state-filter').dispatchEvent(new ui.w.Event('change'))
 ui.el('task-search').value='不存在';ui.el('task-search').dispatchEvent(new ui.w.Event('input'));expect(ui.el('task-list').querySelector('.task-open')).toBeNull()
 ui.el('task-search').value='工作区';ui.el('task-search').dispatchEvent(new ui.w.Event('input'));ui.el('task-list').querySelector('.task-open').click()
 await eventually(()=>!!ui.document.querySelector('.activity-tool'))
 expect(ui.document.body.classList.contains('task-mode')).toBe(true);expect(ui.document.body.classList.contains('chat-mode')).toBe(true)
 expect(ui.el('task-session-info').open).toBe(false);expect(ui.el('task-detail-title').textContent).toBe('工具助手')
 expect(ui.el('task-detail').querySelector('.chat-composer')).toBeNull();expect(ui.document.querySelector('.task-readonly-composer')?.textContent).toContain('只读会话')
 expect(ui.requests).not.toContain('/api/models')
 ui.el('task-session-info').open=true;ui.el('task-model-options').open=true;await eventually(()=>!!ui.el('task-model-settings').querySelector('form'))
 expect(ui.requests).toContain('/api/models');expect(ui.el('task-model-settings').textContent).toContain('此任务独立模型')
 ui.el('task-back').click();await eventually(()=>!ui.el('tasks').hidden);expect(ui.document.body.classList.contains('task-mode')).toBe(false)
 expect(ui.el('task-search').value).toBe('工作区')
})

it('shows subagent replies by default while keeping bookkeeping hidden, and opens their task details',async()=>{
 const ui=setup(true,false,false,true);await eventually(()=>ui.el('message-list').textContent.includes('第一段'))
 const event={event_id:'report',source_kind:'internal',platform:'internal',account_id:'role',conversation_id:'web:alice:first',actor_id:'worker',task_id:'test-task',visibility:'internal',timestamp:new Date().toISOString(),event_type:'task.completed',metadata:{},content:[{type:'report',report_type:'completed',summary:'后台助手完成的实际回复',details:[{type:'text',text:'分支结果说明'}]}]}
 ;(ui.w as any).__chatRows([{event,state:'processed'},{event:{...event,event_id:'bookkeeping',task_id:undefined,event_type:'agent.message',content:[{type:'text',text:'不显示的内部通知'}]},state:'processed'}],[])
 expect(ui.el('chat-show-internal').checked).toBe(false)
 const report=ui.el('message-list').querySelector('.chat-subagent');expect(report?.tagName).toBe('ARTICLE');expect(report.textContent).toContain('后台助手完成的实际回复');expect(report.textContent).toContain('分支结果说明');expect(ui.el('message-list').textContent).not.toContain('不显示的内部通知')
 report.querySelector('.task-link').click();await eventually(()=>!!ui.document.querySelector('.activity-tool'));expect(ui.el('task-detail-description').textContent).toContain('检查工作区')
})

it('renders resolved QQ quotes even when the original is outside the page, without duplicate reply labels or HTML execution',async()=>{
 const ui=setup();await eventually(()=>ui.el('message-list').textContent.includes('第一段'))
 const card=(ui.w as any).AmphoreusUI.messageCard({event:{event_id:'quoted',source_kind:'output-gateway',platform:'qq',account_id:'bot',conversation_id:'group:123',actor_id:'role',visibility:'public',timestamp:new Date().toISOString(),metadata:{reply_to:'42'},content:[{type:'quote',message_id:'42',preview:{sender:'朋友',content:[{type:'text',text:'原来的话 <script>bad()</script>'},{type:'image',url:'https://example.com/quoted.png'}]}},{type:'text',text:'现在回复'}]}},[])
 expect(card.querySelectorAll('blockquote')).toHaveLength(1);expect(card.textContent).toContain('原来的话');expect(card.textContent).toContain('现在回复');expect(card.querySelector('script')).toBeNull();expect(card.querySelector('blockquote img').src).toBe('https://example.com/quoted.png');expect(card.textContent).not.toContain('#42')
})

it('keeps each wake together when new messages and later tool results arrive',async()=>{
 const ui=setup(false,false,false,true);await eventually(()=>ui.el('message-list').textContent.includes('第一段'))
 const row=(id:string,stamp:string,run?:string)=>({event:{event_id:id,source_kind:id==='reply'?'output-gateway':'web',platform:'web',account_id:'alice',conversation_id:'web:alice:first',actor_id:'alice',visibility:'private',timestamp:stamp,metadata:{},content:[{type:'text',text:id}]},state:'processed',...(run?{wake:{id:run,started_at:'2026-11-04T08:00:00Z',state:'running'}}:{})})
 const rows=[row('new-message','2026-11-04T08:00:02Z'),row('reply','2026-11-04T08:00:04Z','wake-a'),row('initial','2026-11-04T08:00:00Z','wake-a')]
 const activity=[{id:'tool',event_id:'initial',run_id:'wake-a',kind:'tool_call',call_id:'call',tool:'检查文件',timestamp:'2026-11-04T08:00:03Z'}]
 ;(ui.w as any).__chatRows(rows,activity)
 let groups=ui.el('message-list').querySelectorAll('.chat-wake')
 expect(groups).toHaveLength(2);expect(groups[0].dataset.wakeId).toBe('wake-a');expect(groups[0].textContent).toContain('initial');expect(groups[0].textContent).toContain('reply');expect(groups[0].textContent).toContain('检查文件');expect(groups[0].textContent).not.toContain('new-message');expect(groups[1].textContent).toContain('new-message')
 ;(ui.w as any).__chatRows(rows,[...activity,{id:'thought',event_id:'initial',run_id:'wake-a',kind:'reasoning',text:'延迟返回的思考',timestamp:'2026-11-04T08:00:05Z'}])
 groups=ui.el('message-list').querySelectorAll('.chat-wake');expect(groups[0].textContent).toContain('延迟返回的思考');expect(groups[1].textContent).toContain('new-message')
})

it('opens directly into a clean owner chat and preserves expanded tool and thinking cards on refresh', async () => {
  const ui = setup(true, false, true, true)
  await eventually(() => ui.document.querySelectorAll('.chat-activity').length === 2)
  expect(ui.document.body.classList.contains('chat-mode')).toBe(true)
  expect(ui.el('chat-options').hidden).toBe(true)
  expect(ui.el('message-list').textContent).not.toContain('开发者详情')
  expect(ui.el('message-list').textContent).toContain('WEB · web:alice:')
  expect(ui.document.querySelector('.chat-reasoning')?.tagName).toBe('ARTICLE')
  expect(ui.el('message-list').textContent).toContain('接口允许展示的思考')
  const tool = ui.document.querySelector('.chat-tool') as HTMLDetailsElement
  expect(tool.textContent).toContain('完成')
  expect(tool.textContent).toContain('文件读取完成')
  expect(tool.open).toBe(false); tool.open = true
  ui.listeners.get('change')!()
  await new Promise(resolve => setTimeout(resolve, 220))
  await eventually(() => (ui.document.querySelector('.chat-tool') as HTMLDetailsElement).open)
  ui.el('chat-options-toggle').click()
  expect(ui.el('chat-options').hidden).toBe(false)
  expect(ui.el('chat-options-toggle').getAttribute('aria-expanded')).toBe('true')
  ui.el('chat-nav-toggle').click()
  expect(ui.document.body.classList.contains('chat-nav-open')).toBe(true)
  expect(ui.el('nav-backdrop').hidden).toBe(false)
  ui.document.dispatchEvent(new ui.w.KeyboardEvent('keydown', { key:'Escape' }))
  expect(ui.document.body.classList.contains('chat-nav-open')).toBe(false)
  expect(ui.el('chat-options').hidden).toBe(true)
  expect(ui.requests).toContain('/amphoreus/api/chat-activity')
  expect(ui.el('chat-native-footer').textContent).toContain('上下文 25%')
  expect(ui.el('chat-native-footer').textContent).toContain('50.0 tok/s')
  expect(ui.el('chat-native-footer').textContent).toContain('500 tok · 缓存 75%')
  expect(ui.el('chat-native-footer').textContent).toContain('3 轮 · 5 步')
})

it('renders tool output as inert text while keeping thoughts permanently expanded', async () => {
  const ui = setup(); await eventually(() => ui.el('message-list').textContent.includes('第一段'))
  const renderer = (ui.w as any).AmphoreusUI
  const card = renderer.chatActivityCard({ id: 'unsafe', kind: 'tool_call', tool: '<img src=x onerror=alert(1)>', call_id: 'unsafe', arguments: { command: '<script>alert(1)</script>' }, timestamp: new Date().toISOString() }, [{ kind: 'tool_result', call_id: 'unsafe', text: '<img src=x onerror=alert(1)>' }])
  expect(card.classList.contains('native-tool')).toBe(true)
  expect(card.open).toBe(false)
  expect([...card.querySelectorAll('.native-tool-label')].map((label:any)=>label.textContent)).toEqual(['输入','输出'])
  expect(card.querySelector('summary .native-tool-status').textContent).toBe('已完成')
  expect(card.querySelector('.tool-state,.badge,.tool-fields')).toBeNull()
  expect(card.querySelector('img,script')).toBeNull()
  expect(card.textContent).toContain('<script>alert(1)</script>')
  const nested=renderer.chatActivityCard({id:'nested',kind:'tool_call',tool:'speak',call_id:'nested',arguments:{content:'简短回复',items:[{kind:'text',value:'保留结构'}]},timestamp:new Date().toISOString()},[{kind:'tool_result',call_id:'nested',text:'{"status":"failed","reason":"网络暂不可用"}',is_error:true}])
  expect(nested.classList.contains('has-error')).toBe(true)
  expect(JSON.parse(nested.querySelector('.native-tool-text').textContent).items).toEqual([{kind:'text',value:'保留结构'}])
  expect(nested.querySelector('summary').textContent).toContain('失败')
  const thought = renderer.messageCard({ event: { event_id:'thought', visibility:'internal', event_type:'assistant.thought', timestamp:new Date().toISOString(), content:[{type:'text',text:'普通想法'}] } }, [])
  expect(thought.tagName).toBe('ARTICLE'); expect(thought.querySelector('summary')).toBeNull()
  expect(thought.querySelector('.chat-activity-body').textContent).toBe('普通想法')
  expect(thought.textContent).not.toContain('开发者详情')
})

it('uses accessible SVG controls and readable code/list blocks with honest copy feedback', async () => {
  const ui = setup(); await eventually(() => ui.el('message-list').textContent.includes('第一段'))
  expect(ui.el('chat-nav-toggle').querySelector('svg path')).not.toBeNull()
  const nav = ui.document.querySelector('[data-view="memory"]')!
  expect(nav.getAttribute('aria-label')).toBe('记忆与自我')
  expect(ui.el('chat-send').querySelector('svg')).not.toBeNull()
  const text = '## 改动\n- 更清楚\n- 更简洁\n\n```js\nconst unsafe = "<script>"\n```'
  const block = (ui.w as any).AmphoreusUI.markdown(text)
  expect(block.querySelectorAll('ul li')).toHaveLength(2)
  expect(block.querySelectorAll('p:empty')).toHaveLength(0)
  expect(block.querySelector('.code-toolbar').textContent).toContain('js')
  expect(block.querySelector('script')).toBeNull()
  let copied = ''
  Object.defineProperty(ui.w.navigator,'clipboard',{ configurable:true,value:{ writeText:async(value:string)=>{copied=value} } })
  const copy = block.querySelector('.copy-button')
  await copy.onclick()
  expect(copied).toContain('const unsafe')
  expect(copy.getAttribute('aria-label')).toBe('已复制')
  Object.defineProperty(ui.w.navigator,'clipboard',{ configurable:true,value:undefined })
  await copy.onclick()
  expect(copy.getAttribute('aria-label')).toContain('复制失败')
})

it('renders relative protected attachments, GIF images, audio, video and file links without accepting arbitrary relative paths', async () => {
  const ui=setup(false,false,true);await eventually(()=>ui.el('message-list').textContent.includes('第一段'))
  const renderer=(ui.w as any).AmphoreusUI
  const media=renderer.blocks([{type:'image',url:'/api/output-media/out_1/0',name:'动图.gif'},{type:'audio',url:'https://media.test/audio.ogg'},{type:'video',url:'https://media.test/video.mp4'},{type:'file',url:'/api/output-media/out_1/3',name:'notes.txt'},{type:'image',url:'javascript:alert(1)'},{type:'image',url:'/etc/passwd'}])
  expect(media.querySelector('img').getAttribute('src')).toBe('/amphoreus/api/output-media/out_1/0')
  expect(media.querySelector('img').closest('a').getAttribute('aria-label')).toBe('查看原图')
  expect(media.querySelector('audio').controls).toBe(true);expect(media.querySelector('video').controls).toBe(true)
  expect(media.querySelector('.media-file-link').getAttribute('href')).toBe('/amphoreus/api/output-media/out_1/3')
  expect(media.querySelectorAll('.media-unavailable')).toHaveLength(2)
  media.querySelector('img').dispatchEvent(new ui.w.Event('error'))
  expect(media.textContent).toContain('加载失败或链接已过期')
})

it('does not request owner-only thinking/tool history for normal chat users', async () => {
  const ui = setup(); await eventually(() => ui.el('message-list').textContent.includes('第一段'))
  expect(ui.requests).not.toContain('/api/chat-activity')
  expect(ui.requests).not.toContain('/api/chat-footer')
  expect(ui.el('chat-native-footer').hidden).toBe(true)
})

it('uses the Harness mount for all management requests and live events', async () => {
  const ui = setup(false, false, true)
  await eventually(() => ui.el('message-list').textContent.includes('第一段'))
  ui.input('来自插件'); ui.el('chat-form').requestSubmit()
  await eventually(() => ui.posts.length === 1 && !ui.el('chat-input').value)
  expect(ui.requests.every(path => path.startsWith('/amphoreus/api/'))).toBe(true)
  expect(ui.streams).toEqual(['/amphoreus/api/stream'])
})

it('shows a single Main transcript across source conversations and sends through the fixed Web gateway', async () => {
  const ui = setup()
  await eventually(() => ui.el('message-list').textContent.includes('群消息') && ui.el('message-list').textContent.includes('第一段'))
  expect(ui.document.querySelector('#new-chat')).toBeNull()
  expect(ui.document.querySelector('.conversation-item')).toBeNull()
  expect(ui.el('chat-title').textContent).toBe('测试角色')
  expect(ui.el('message-list').textContent).toContain('第二段消息')
  expect(ui.el('message-list').textContent).toContain('QQ · 测试群')
  ui.input('给主 Agent 的消息'); ui.filter('qq')
  await eventually(() => ui.el('message-list').textContent.includes('群消息') && !ui.el('message-list').textContent.includes('第一段'))
  expect(ui.el('chat-form').hidden).toBe(false)
  expect(ui.el('chat-input').value).toBe('给主 Agent 的消息')
  ui.el('chat-input').dispatchEvent(new ui.w.KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }))
  ui.el('chat-input').dispatchEvent(new ui.w.KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }))
  expect(ui.posts).toHaveLength(0)
  ui.el('chat-input').dispatchEvent(new ui.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await eventually(() => ui.posts.length === 1 && !ui.el('chat-input').value)
  expect(ui.posts[0]).toMatchObject({ conversation: 'chat', content: '给主 Agent 的消息' })
  await eventually(() => ui.el('message-list').textContent.includes('给主 Agent 的消息') && ui.el('message-list').textContent.includes('群消息'))
  expect(ui.el('source').value).toBe('')
  expect(ui.el('chat-thinking').hidden).toBe(false)
})

it('preserves failed request identity and drafts while filtering during an in-flight send', async () => {
  const ui = setup(); await eventually(() => ui.el('message-list').textContent.includes('第一段'))
  ui.input('稍后重试'); ui.fail(); ui.el('chat-form').requestSubmit()
  await eventually(() => ui.el('error').textContent.includes('网络暂时断开') && !ui.el('chat-send').disabled)
  expect(ui.el('chat-input').value).toBe('稍后重试')
  ui.hold(); ui.el('chat-form').requestSubmit(); await eventually(() => ui.posts.length === 2)
  expect(ui.posts[0].idempotency_key).toBe(ui.posts[1].idempotency_key)
  ui.filter('qq'); expect(ui.el('chat-input').value).toBe('稍后重试')
  ui.release(); await eventually(() => !ui.el('chat-input').disabled && !ui.el('chat-input').value)
  expect(ui.el('chat-title').textContent).toBe('测试角色')
})

it('paginates the unified timeline and filters source conversations without opening another Main chat', async () => {
  const ui = setup(false, true)
  await eventually(() => ui.document.querySelectorAll('#message-list .message').length === 50)
  ui.el('older-messages').click(); await eventually(() => ui.document.querySelectorAll('#message-list .message').length === 63)
  expect(ui.el('older-messages').hidden).toBe(true)
  ui.listeners.get('change')!(); await new Promise(resolve => setTimeout(resolve, 200))
  expect(ui.document.querySelectorAll('#message-list .message')).toHaveLength(63)
  ui.filter('web', 'web:alice:first')
  await eventually(() => ui.el('message-list').textContent.includes('第一段') && !ui.el('message-list').textContent.includes('第二段消息'))
  expect(ui.el('chat-title').textContent).toBe('测试角色')
  expect(ui.el('chat-form').hidden).toBe(false)
})

it('opens a Subagent from the unified Main transcript, shows execution/report details, and returns without losing the chat draft', async () => {
  const ui = setup(true)
  await eventually(() => ui.el('chat-tasks').querySelector('button'))
  ui.input('需要保留的草稿')
  ui.el('chat-tasks').querySelector('button').click()
  await eventually(() => !!ui.document.querySelector('.activity-tool'))
  expect(ui.el('task-detail').hidden).toBe(false)
  expect(ui.el('task-detail-description').textContent).toContain('检查工作区')
  expect(ui.document.querySelector('.activity-tool')?.textContent).toContain('bash')
  expect(ui.document.querySelector('.activity-tool')?.textContent).toContain('/workspace')
  expect(ui.document.querySelector('.activity-tool')?.textContent).toContain('已完成')
  ui.el('task-tab-reports').click()
  await eventually(() => ui.el('task-detail-reports').textContent.includes('任务完成'))
  expect(ui.el('task-reports-panel').hidden).toBe(false)
  ui.el('task-back').click()
  expect(ui.el('messages').hidden).toBe(false)
  expect(ui.el('chat-input').value).toBe('需要保留的草稿')
})
