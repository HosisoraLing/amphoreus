/* Buildless console. Untrusted content is rendered with DOM/textContent, never HTML injection. */
const $ = id => document.getElementById(id)
const apiBase = location.pathname.startsWith('/amphoreus/') ? '/amphoreus/' : location.pathname === '/console' || location.pathname.startsWith('/console/') ? '/console/' : '/'
const node = (tag, text, cls) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = String(text); if (cls) n.className = cls; return n }
// Small first-party line icons. Paths are constants; message content never becomes SVG markup.
function icon(name, cls = '') {
  const shapes = {
    panel: ['M9 3v18','M4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1'],
    chat: ['M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-2 2V11.5A8.5 8.5 0 0 1 10.5 3h2a8.5 8.5 0 0 1 8.5 8.5Z','M7 9h10M7 13h7'],
    grid: ['M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z'],
    layers: ['m12 3 10 5-10 5L2 8l10-5Z','m2 12 10 5 10-5M2 16l10 5 10-5'],
    memory: ['M9 3a3 3 0 0 0-3 3v1a4 4 0 0 0-2 7 4 4 0 0 0 5 6h3V5a2 2 0 0 0-3-2Z','M15 3a3 3 0 0 1 3 3v1a4 4 0 0 1 2 7 4 4 0 0 1-5 6h-3','M6 9h3M15 9h3M7 15h2M15 15h2'],
    people: ['M8 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z','M2 21v-2a6 6 0 0 1 12 0v2M17 4a4 4 0 0 1 0 8M18 15a5 5 0 0 1 4 5v1'],
    clock: ['M12 3a9 9 0 1 0 9 9 9 9 0 0 0-9-9Z','M12 7v5l3 2'],
    sliders: ['M4 3v7M4 14v7M12 3v11M12 18v3M20 3v3M20 10v11','M1 10h6M9 18h6M17 6h6'],
    spark: ['m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z'],
    code: ['m8 7-5 5 5 5M16 7l5 5-5 5M14 4l-4 16'],
    arrow: ['M12 19V5M6 11l6-6 6 6'],
    check: ['m5 12 4 4L19 6'],
    globe: ['M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM3 12h18','M12 3a18 18 0 0 1 0 18 18 18 0 0 1 0-18Z'],
    copy: ['M9 9h12v12H9z','M15 5V3H3v12h2'],
  }
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  for (const [key, value] of Object.entries({ viewBox:'0 0 24 24', fill:'none', stroke:'currentColor', 'stroke-width':'1.65', 'stroke-linecap':'round', 'stroke-linejoin':'round', 'aria-hidden':'true', class:`ui-icon ${cls}` })) svg.setAttribute(key, value)
  for (const d of shapes[name] || shapes.spark) { const path = document.createElementNS(svg.namespaceURI, 'path'); path.setAttribute('d', d); svg.append(path) }
  return svg
}
function decorateChrome() {
  const navigation = { dashboard:['grid','总览'], messages:['chat','聊天'], tasks:['layers','后台任务'], memory:['memory','记忆与自我'], people:['people','人际关系'], participation:['people','群聊参与'], runs:['clock','运行记录'], memes:['spark','表情图库'], models:['spark','模型设置'], statistics:['grid','用量统计'], logs:['code','日志'], about:['spark','关于'] }
  for (const button of document.querySelectorAll('[data-view]')) { const [name, label] = navigation[button.dataset.view]; button.replaceChildren(icon(name), node('span', label)); button.title = label; button.setAttribute('aria-label', label) }
  $('chat-nav-toggle').replaceChildren(icon('panel'))
  $('page-nav-toggle').replaceChildren(icon('panel'))
  $('task-nav-toggle').replaceChildren(icon('panel'))
  $('chat-options-toggle').replaceChildren(icon('sliders'), node('span','选项'))
  $('chat-send').replaceChildren(icon('arrow'))
  document.querySelector('.chat-role-icon').replaceChildren(icon('spark'))
}
const labels = { waiting: '等待反馈', paused: '已暂停', accepted: '已接收', queued: '排队中', running: '执行中', processing: '处理中', processed: '已处理', completed: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断', sent: '已发出', pending: '待发送', sending: '发送中', unknown: '结果未知', connected: '已连接', disabled: '未启用', disconnected: '未连接', deferred: '已挂起', progress: '进度', thought: '阶段性判断', discovery: '重要发现', question: '待决问题', authenticating: '验证身份', connecting: '连接中', stopped: '已停止', listening: '等待连接' }
const badge = state => node('span', labels[state] || state, `badge ${state}`)
Object.assign(labels, { candidate: '待审阅', adopted: '已采用', archived: '已归档', superseded: '历史版本', expired: '原文已到期', unavailable: '接口未提供', confirmed: '已确认', reviewed: '已审阅', skipped: '已跳过', scheduled: '待安排', awaiting_review: '等待 Main 审阅', complete: '已记录' })
labels.resolved = '已处理'
labels.legacy_history='旧版原文'
Object.assign(labels,{admitted:'已送达角色',buffering:'等待观察',scheduled:'等待主 Agent',archived:'仅归档',
  'probability-miss':'本批未唤醒','observation-only':'仅归档',cooldown:'主动冷却',fatigue:'休息',sleep:'睡眠',
  'speech-share':'发言占比抑制','other-bot':'其他机器人',observing:'围观',engaged:'参与中','following-up':'心意续聊','followup-heart':'心意续聊','followup-ended':'话题已结束',resting:'休息',
  'direct-mention':'明确 @','direct-reply':'回复角色','direct-answer':'等待中的回答',heart:'心意模式',hybrid:'混合调度',
  'main-silent':'观察后保持沉默','main-spoke':'已发言','main-failed':'观察失败','speak-sent':'发送成功','speak-failed':'发送失败','speak-unknown':'发送结果未知'})
const failureText = text => ({
  'Main failed during Steering; inspect before retry': '主 Agent 处理插话时失败，需要核对',
  'Main Run time budget exceeded': '主 Agent 本轮运行超时',
  'Main interrupted after Steering; inspect before retry': '主 Agent 接收插话后被中断，需要核对',
  'Main Run interrupted; review before retry': '主 Agent 本轮运行被中断，需要核对',
  'Runtime interrupted': '服务重启时运行被中断',
})[text] || text
const memoryKinds = { input: '收到的消息', speak: '正式发言', assistant: '想法 / 自言自语', reasoning: '接口推理', insight: '灵感', candidate: '候选记忆', topic: '话题', diary_draft: '日记草稿', diary: '正式日记', self_draft: 'Self 草稿', self: 'Self', decision: '审阅决定', report: '分支通信', tool: '工具记录', segment: '活动片段', consolidation: '自主回顾' }
Object.assign(memoryKinds,{legacy_document:'鱼缸原文',legacy_experience:'鱼缸经历',legacy_person:'人物与关系',legacy_meme:'旧表情',correction:'记录更正',attachment:'原始附件'})
const time = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }) : '—'
function url(value) { try { const internal=typeof value==='string'&&/^\/(amphoreus\/)?api\/output-media\/[^/]+\/\d+$/.test(value);const u = internal?new URL(value,location.href):new URL(value); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password ? u.href : null } catch { return null } }
function inline(parent, text) {
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|!?\[[^\]]*\]\([^\s)]+\))/g
  let end = 0
  for (const match of text.matchAll(pattern)) {
    parent.append(document.createTextNode(text.slice(end, match.index)))
    const part = match[0]
    if (part.startsWith('`')) parent.append(node('code', part.slice(1, -1)))
    else if (part.startsWith('**')) parent.append(node('strong', part.slice(2, -2)))
    else {
      const parsed = /^(!?)\[([^\]]*)\]\((.+)\)$/.exec(part), href = parsed && url(parsed[3])
      if (href && parsed[1]) { const img = node('img'); img.src = href; img.alt = parsed[2] || '图片'; img.loading = 'lazy'; img.referrerPolicy = 'no-referrer'; parent.append(img) }
      else if (href) { const link = node('a', parsed[2]); link.href = href; link.target = '_blank'; link.rel = 'noopener noreferrer'; parent.append(link) }
      else parent.append(document.createTextNode(part))
    }
    end = match.index + part.length
  }
  parent.append(document.createTextNode(text.slice(end)))
}
function copyButton(getText, label = '复制') {
  const button = node('button', undefined, 'copy-button'); button.type = 'button'; button.title = label; button.setAttribute('aria-label', label); button.append(icon('copy'))
  button.onclick = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable')
      await navigator.clipboard.writeText(getText()); button.replaceChildren(icon('check')); button.setAttribute('aria-label','已复制')
    } catch { button.setAttribute('aria-label','复制失败，请手动选择文本'); button.title = '复制失败，请手动选择文本' }
  }
  return button
}
function markdown(text) {
  const root = node('div'), lines = String(text || '').split('\n'); let code = null, list = null
  for (const line of lines) {
    if (/^```/.test(line)) {
      list = null
      if (code) code = null
      else {
        const frame = node('div', undefined, 'code-frame'), toolbar = node('div', undefined, 'code-toolbar'), pre = node('pre'), content = node('code')
        toolbar.append(node('span', line.slice(3).trim().slice(0, 40) || '代码'), copyButton(() => content.textContent, '复制代码'))
        pre.append(content); frame.append(toolbar, pre); root.append(frame); code = content
      }
      continue
    }
    if (code) { code.textContent += `${line}\n`; continue }
    const item = /^\s*(?:([-*])|\d+[.)])\s+(.+)/.exec(line)
    if (item) {
      const tag = item[1] ? 'ul' : 'ol'
      if (!list || list.localName !== tag) { list = node(tag); root.append(list) }
      const li = node('li'); inline(li, item[2]); list.append(li); continue
    }
    list = null
    if (!line.trim()) continue
    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) { root.append(node('hr')); continue }
    const heading = /^(#{1,3})\s+(.+)/.exec(line)
    const n = node(heading ? `h${Math.min(heading[1].length + 1, 4)}` : line.startsWith('> ') ? 'blockquote' : 'p')
    inline(n, heading ? heading[2] : line.replace(/^> /, '')); root.append(n)
  }
  return root
}
function mediaUrl(value) {
  if (typeof value !== 'string') return null
  // Only backend-issued output attachment routes may be resolved as relative media.
  const local = /^(?:\/amphoreus|\/console)?\/api\/output-media\/[a-zA-Z0-9_-]+\/\d+$/.exec(value)
  if (local) return `${apiBase}api/output-media/${value.split('/api/output-media/')[1]}`
  return url(value)
}
function mediaBlock(block) {
  const labels = { image:'图片', audio:'音频', video:'视频', file:'文件' }, label = labels[block.type], href = mediaUrl(block.url)
  const figure = node('figure', undefined, `message-media media-${block.type}`)
  const unavailable = reason => { const info = node('p', `${label} · ${block.name || '附件'}：${reason}`, 'media-unavailable'); info.setAttribute('role','status'); figure.append(info) }
  if (!href) { unavailable('没有可访问的媒体地址，等待后端提供附件。'); return figure }
  const absolute = new URL(href, location.href)
  if (location.protocol === 'https:' && absolute.protocol === 'http:') { unavailable('媒体地址仍为 HTTP，浏览器会阻止不安全加载。'); return figure }
  if (block.type === 'file') {
    const link = node('a', `下载 · ${block.name || '文件'}${block.size ? ` · ${block.size} 字节` : ''}`, 'media-file-link')
    link.href = href; link.target = '_blank'; link.rel = 'noopener noreferrer'; figure.append(icon('layers'),link); return figure
  }
  const media = node(block.type === 'image' ? 'img' : block.type); media.src = href; media.className = 'media'; media.referrerPolicy = 'no-referrer'
  if (block.type === 'image') {
    media.alt = String(block.name || '消息图片'); media.loading = 'lazy'; media.decoding = 'async'
    const link = node('a', undefined, 'media-image-link'); link.href = href; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.setAttribute('aria-label','查看原图'); link.append(media); figure.append(link)
  } else { media.controls = true; media.preload = 'metadata'; if (block.type === 'video') media.playsInline = true; figure.append(media) }
  media.onerror = () => { media.hidden = true; if (!figure.querySelector('.media-unavailable')) unavailable('加载失败或链接已过期。') }
  if (block.name) figure.append(node('figcaption',block.name))
  return figure
}
function blocks(items, known = []) {
  const root = node('div')
  for (const block of items || []) {
    if (block.type === 'text') root.append(markdown(block.text))
    else if (block.type === 'mention') root.append(node('span', `@${block.name || block.actor_id}`, 'mention'))
    else if (block.type === 'emoji') root.append(node('span', block.text || `［QQ 表情 ${block.emoji_id || ''}］`))
    else if (block.type === 'quote') {
      const quoted = block.message_id==null?undefined:known.find(row => String(row.event.metadata.message_id) === String(block.message_id))
      const preview=block.preview,quote=node('blockquote',undefined,'quote')
      if(preview&&Array.isArray(preview.content)){
        quote.append(node('strong',String(preview.sender||'引用消息')),blocks(preview.content))
      }else quote.textContent=quoted?`${quoted.event.metadata.nickname||quoted.event.actor_id}：${quoted.event.content.map(b=>b.type==='text'?b.text:({image:'[图片]',audio:'[语音]',video:'[视频]',file:'[文件]'})[b.type]||'').join(' ')}`:block.unavailable||(block.message_id==null?'引用原文未提供':`引用消息 #${block.message_id}`)
      root.append(quote)
    } else if (['image','audio','video','file'].includes(block.type)) {
      root.append(mediaBlock(block))
    } else if (block.type === 'report') {
      const card = node('div', undefined, 'status-event'); card.append(badge(block.report_type), markdown(block.summary)); if (block.details) card.append(blocks(block.details)); root.append(card)
    } else root.append(node('p', `平台内容 · ${block.platform_type || block.type}`, 'muted'))
  }
  return root
}
function rawDetails(value) { const d = node('details'); d.append(node('summary', '开发者详情'), node('pre', JSON.stringify(value, null, 2))); return d }
const isSubagentReport=event=>event.source_kind==='internal'&&event.task_id&&event.content.some(block=>block.type==='report')
function messageCard(row, known) {
  const { event } = row
  if (event.visibility === 'internal') {
    if (event.event_type === 'assistant.thought') {
      const thought = node('article', undefined, 'chat-activity chat-thought')
      thought.dataset.activityId = event.event_id
      const summary = node('div', undefined, 'thought-heading'); summary.append(icon('spark', 'activity-icon'), node('span', `${roleName}的想法`, 'chat-activity-title'), node('time', new Date(event.timestamp).toLocaleTimeString('zh-CN', { hour:'2-digit', minute:'2-digit' })))
      const body = node('div', undefined, 'chat-activity-body'); body.append(blocks(event.content))
      thought.append(summary, body); return thought
    }
    if(isSubagentReport(event)){
      const report=event.content.find(block=>block.type==='report'),card=node('article',undefined,'chat-activity chat-subagent'),heading=node('div',undefined,'thought-heading subagent-heading'),body=node('div',undefined,'chat-activity-body')
      card.setAttribute('aria-label','后台助手汇报');card.dataset.taskId=event.task_id
      heading.append(icon('layers','activity-icon'),node('strong',`Subagent 回复 · ${labels[report.report_type]||report.report_type||'汇报'}`),node('time',time(event.timestamp)),taskLink(event.task_id))
      body.append(markdown(report.summary));if(report.details)body.append(blocks(report.details));if(typeof report.progress==='number')body.append(node('small',`进度 ${report.progress}%`,'muted'))
      card.append(heading,body);return card
    }
    const card = node('details', undefined, 'chat-notice'), summary = node('summary')
    const report = event.content.find(block => block.type === 'report')
    summary.append(node('span', '◇', 'notice-icon'), node('span', report ? `后台分支 → Main · ${labels[report.report_type] || report.report_type}` : event.event_type === 'agent.message' ? 'Main → 后台分支' : event.source_kind === 'genesis' ? '创建者寄语' : '内部事件'), node('time', time(event.timestamp)))
    if (event.task_id) summary.append(taskLink(event.task_id))
    const content = node('div', undefined, 'notice-content'); content.append(blocks(event.content)); if (row.resolution) { summary.append(badge('resolved')); content.append(node('p', `已核对处理：${row.resolution.note}`, 'muted')) }; card.append(summary, content); return card
  }
  const outgoing = event.source_kind === 'output-gateway', card = node('article', undefined, `message ${outgoing ? 'outgoing from-agent' : 'from-user'}`)
  const avatar = url(event.metadata.avatar) ? node('img', undefined, 'avatar') : node('span', outgoing ? '◈' : String(event.metadata.nickname || event.actor_id).slice(0, 1), 'avatar')
  if (outgoing && avatar.tagName !== 'IMG') avatar.replaceChildren(icon('spark'))
  if (avatar.tagName === 'IMG') { avatar.src = url(event.metadata.avatar); avatar.alt = ''; avatar.referrerPolicy = 'no-referrer'; avatar.loading = 'lazy' }
  const content = node('div', undefined, 'message-body'), meta = node('div', undefined, 'message-meta')
  meta.append(node('strong', event.metadata.operator_test ? '开发验收重放' : outgoing ? roleName : event.platform === 'web' && event.account_id === principal?.user ? '你' : event.metadata.nickname || event.actor_id), node('span', `${String(event.platform || '未知').toUpperCase()} · ${event.metadata.group_name || event.conversation_id || event.account_id || '消息'}`, 'message-source'), node('time', time(event.timestamp)))
  const bubble = node('div', undefined, 'bubble'); bubble.append(blocks(event.content, known.filter(row => row.event.platform === event.platform && row.event.account_id === event.account_id && row.event.conversation_id === event.conversation_id)))
  meta.querySelector('time').title = time(event.timestamp)
  meta.querySelector('time').textContent = new Date(event.timestamp).toLocaleTimeString('zh-CN', { hour:'2-digit', minute:'2-digit' })
  if (event.metadata.reply_to&&!event.content.some(block=>block.type==='quote'&&String(block.message_id)===String(event.metadata.reply_to))) bubble.prepend(blocks([{type:'quote',message_id:String(event.metadata.reply_to)}],known.filter(row=>row.event.platform===event.platform&&row.event.account_id===event.account_id&&row.event.conversation_id===event.conversation_id)))
  content.append(meta, bubble)
  if (outgoing) { const actions = node('div', undefined, 'message-actions'); actions.append(copyButton(() => event.content.filter(block => block.type === 'text').map(block => block.text).join('\n'), '复制回复')); content.append(actions) }
  // Admission/probability diagnostics belong to the management views.
  if (outgoing) for (const output of row.outputs || []) {
    if(output.status!=='sent')content.append(badge(output.status))
    const recovery=output.recovery
    if(recovery)content.append(node('small',({waiting:'系统等待自动核查与重试',retrying:'系统正在自动重试',sent:'系统已确认发送成功',alerted:'自动恢复未成功，已邮件通知',notifying:'正在发送邮件通知','mail-failed':'邮件通知未确认送达，请检查发信服务'})[recovery.state]||'', 'muted'))
  }
  if (row.error) content.append(node('p', failureText(row.error), row.resolution ? 'muted' : 'error'))
  if (row.resolution) content.append(node('p', `已核对处理：${row.resolution.note}`, 'muted'))
  if (row.state === 'failed' && !row.resolution) { const retry = node('button', '重试本事件', 'secondary'); retry.onclick = () => api(`events/${encodeURIComponent(event.event_id)}/retry`, {}).then(refresh).catch(showError); content.append(retry) }
  card.append(avatar, content); return card
}
// Exposed only to exercise the same renderer in the repository's DOM tests.
globalThis.AmphoreusUI = { markdown, blocks, messageCard }
let roleName = '角色', principal, view = 'dashboard', offsets = { messages: 0, reports: 0, runs: 0 }, stream, refreshTimer, loading = false, queued = false
const randomId = () => crypto.randomUUID?.() || Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('')
let messageRows = [], messageFilter, hasOlder = false, olderLoading = false, draftKey, sending = false
let messageCapacity = 200
let chatActivityItems = [], activityCursor, activityHasMore = false, activityLoading = false, activityScope = ''
const chatExpanded = new Set()
const chatFilter = () => new URLSearchParams({ platform: $('source').value, conversation: $('conversation-filter').value }).toString()
function resizeInput() { const input = $('chat-input'); input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight || 28, 180)}px` }
function updateComposer() {
  $('chat-input').disabled = sending
  $('chat-send').disabled = sending || !$('chat-input').value.trim()
  $('chat-target').textContent = sending ? '正在发送…' : 'Enter 发送 · Shift+Enter 换行'
}
function changeChatFilter() { messageRows = []; messageCapacity = 200; messageFilter = undefined; hasOlder = false; chatActivityItems = []; chatExpanded.clear(); activityScope = ''; refresh() }
function renderChat(older = false) {
  const scroller = $('chat-scroll'), oldHeight = scroller.scrollHeight, oldTop = scroller.scrollTop
  const changed = messageFilter !== chatFilter()
  const pinned = oldHeight - scroller.clientHeight - oldTop < 100
  messageFilter = chatFilter()
  const list = $('message-list')
  for (const detail of list.querySelectorAll('details[data-activity-id]')) { if (detail.open) chatExpanded.add(detail.dataset.activityId); else chatExpanded.delete(detail.dataset.activityId) }
  const activityIds = new Set(chatActivityItems.map(item => item.id))
  for (const id of chatExpanded) if (!activityIds.has(id)) chatExpanded.delete(id)
  list.replaceChildren()
  if (!messageRows.length) {
    const welcome = node('div', undefined, 'chat-empty')
    welcome.append(node('span', '◈', 'empty-mark'), node('h2', `和${roleName}聊聊吧`), node('p', '从一句问候开始，也可以交给她一项任务。'))
    list.append(welcome)
  }
  const showInternal = $('chat-show-internal').checked
  const visibleRows = messageRows.filter(row => showInternal || row.event.visibility !== 'internal' || row.event.event_type === 'assistant.thought' || isSubagentReport(row.event))
  const entries = visibleRows.map((row, index) => ({ at: row.event.timestamp, order: -index, row }))
  for (const item of chatActivityItems) if (item.kind !== 'tool_result') entries.push({ at: item.timestamp, order: 0, item })
  const groups = new Map(), eventGroups = new Map(messageRows.map(row=>[row.event.event_id,row.wake?.id||`event:${row.event.event_id}`]))
  for (const entry of entries) {
    const wake=entry.row?.wake, id=wake?.id||entry.item?.run_id||eventGroups.get(entry.item?.event_id)||`event:${entry.row?.event.event_id||entry.item.id}`
    let group=groups.get(id)
    if(!group){group={id,at:wake?.started_at||entry.at,wake,entries:[]};groups.set(id,group)}
    if(wake){group.at=wake.started_at;group.wake=wake}
    group.entries.push(entry)
  }
  for (const group of [...groups.values()].sort((a,b)=>a.at.localeCompare(b.at)||a.id.localeCompare(b.id))) {
    const section=node('section',undefined,'chat-wake');section.dataset.wakeId=group.id
    if(group.wake){const heading=node('div',`一次唤醒 · ${time(group.wake.started_at)}${group.wake.state==='running'?' · 处理中':''}`,'chat-wake-heading');section.append(heading)}
    group.entries.sort((a,b)=>a.at.localeCompare(b.at)||a.order-b.order)
    for(const entry of group.entries){const card=entry.row?messageCard(entry.row,messageRows):chatActivityCard(entry.item,chatActivityItems);if(card)section.append(card)}
    list.append(section)
  }
  if (!entries.length && messageRows.length) list.append(node('p', '当前筛选下没有对话消息。可在选项中查看内部通知。', 'chat-empty'))
  $('chat-more-activity').hidden = !activityHasMore
  $('chat-more-activity').disabled = activityLoading
  $('chat-more-activity').textContent = activityLoading ? '正在加载…' : '加载更早的思考与工具记录'
  $('older-messages').hidden = !hasOlder
  $('older-messages').disabled = olderLoading
  $('older-messages').textContent = olderLoading ? '正在加载…' : '加载更早的消息'
  $('chat-thinking').hidden = !messageRows.some(row => row.event.source_kind !== 'output-gateway' && ['queued', 'processing'].includes(row.state))
  requestAnimationFrame(() => {
    if (messageFilter !== chatFilter()) return
    scroller.scrollTop = older ? scroller.scrollHeight - oldHeight + oldTop : changed || pinned ? scroller.scrollHeight : oldTop
  })
}
// Mirrors native ContextMeter and StatsPills; inputs are native whole-session projections.
function renderNativeFooter(data) {
  const root=$('chat-native-footer'); root.replaceChildren(); root.hidden=principal?.role!=='admin'
  if(root.hidden)return
  if(!data?.available){root.append(node('span','DSH 统计暂不可用','footer-muted'));return}
  const compact=n=>n>=1e6?`${+(n/1e6).toFixed(1)}M`:n>=1000?`${+(n/1000).toFixed(1)}K`:String(n)
  const part=(label,value,details)=>{
    const card=node('details',undefined,'native-stat'),head=node('summary',`${label} ${value}`),body=node('dl')
    for(const [key,value] of details){body.append(node('dt',key),node('dd',value))}
    card.append(head,body);root.append(card)
  }
  const p=data.contextPressure,b=data.contextBreakdown,s=data.sessionStats,u=data.tokenUsage
  const used=p?.projectedTokens??p?.pressureTokens
  if(used!==undefined&&p?.contextWindow>0){const rows=[['上下文',`~${compact(used)} / ${compact(p.contextWindow)}`]];if(b)rows.push(['系统提示',`~${compact(b.systemTokens)}`],['工具',`~${compact(b.toolsTokens)}`],['对话',`~${compact(b.messageTokens)}`]);part('上下文',`${Math.min(100,Math.round(used/p.contextWindow*100))}%`,rows)}
  if(s){
    part('会话',`${s.turns} 轮 · ${s.steps} 步`,[['模型耗时',`${(s.llmMs/1000).toFixed(1)} s`],['工具耗时',`${(s.toolMs/1000).toFixed(1)} s`],['平均首 Token',s.ttftSteps?`${(s.ttftMs/s.ttftSteps/1000).toFixed(2)} s`:'暂无']])
    if(s.decodeMs>0)part('速度',`${(s.decodeTokens/(s.decodeMs/1000)).toFixed(1)} tok/s`,[['口径','原生 DSH 全会话输出 Token / 解码时长'],['输出 Token',String(s.decodeTokens)],['解码耗时',`${(s.decodeMs/1000).toFixed(2)} s`]])
  }
  if(u){const prompt=u.uncachedInputTokens+u.cacheReadTokens+u.cacheWriteTokens,total=prompt+u.outputTokens;const hit=prompt?u.cacheReadTokens/prompt*100:null;let cache=hit===null?'暂无':hit===100?'100%':`${Math.min(99.999999,Math.round(hit*10)/10)}%`;if(hit!==null&&hit<100&&hit>=99.95)cache='>99.9%（未全命中）';part('用量',`${compact(total)} tok · 缓存 ${cache}`,[['总 Token',String(total)],['未缓存输入',String(u.uncachedInputTokens)],['缓存读取',String(u.cacheReadTokens)],['缓存写入',String(u.cacheWriteTokens)],['输出',String(u.outputTokens)],['统计范围','DSH 当前主会话完整日志；不随网页分页变化']])}
}
async function refreshNativeFooter(){
  if(principal?.role!=='admin'){$('chat-native-footer').hidden=true;return}
  try{renderNativeFooter(await api('chat-footer'))}catch{renderNativeFooter(null)}
}

async function refreshChat() {
  const saved = await api('conversations?limit=100')
  if (view !== 'messages') return
  const selected = $('conversation-filter').value, source = $('source').value
  const filter = $('conversation-filter'); filter.replaceChildren(node('option', '全部来源会话')); filter.firstChild.value = ''
  for (const conversation of saved) {
    if (source && conversation.platform !== source) continue
    const option = node('option', `${conversation.platform.toUpperCase()} · ${conversation.title} · ${conversation.conversation_id}`)
    option.value = conversation.conversation_id; filter.append(option)
  }
  if ([...filter.options].some(option => option.value === selected)) filter.value = selected
  $('chat-title').textContent = roleName
  $('chat-subtitle').textContent = principal.role === 'admin' ? 'QQ、Web 与内部汇报，共用同一个主对话' : '同一个主 Agent · 仅展示你有权查看的记录'
  updateComposer()
  const query = chatFilter()
  const [rows, tasks] = await Promise.all([api(`messages?${query}&limit=50`), api('tasks?limit=100')])
  if (view !== 'messages' || chatFilter() !== query) return
  const taskList = $('chat-tasks'); taskList.replaceChildren(); taskList.hidden = !tasks.length; $('chat-task-drawer').hidden = !tasks.length
  const activeTasks = tasks.filter(task => ['queued','running','waiting'].includes(task.state)).length
  $('chat-task-count').hidden = !activeTasks; $('chat-task-count').textContent = `${activeTasks} 项任务进行中`
  for (const task of tasks) { const link = taskLink(task.task_id, `◇ ${labels[task.state] || task.state} · ${task.description.slice(0, 35)}`); link.title = task.description; taskList.append(link) }
  const seen = new Set(rows.map(row => row.event.event_id))
  if (messageFilter !== query || messageRows.length && !messageRows.some(row => seen.has(row.event.event_id))) {
    messageRows = rows; messageCapacity = 200; hasOlder = rows.length === 50
  } else {
    const merged = [...rows, ...messageRows.filter(row => !seen.has(row.event.event_id))]
    if (merged.length > messageCapacity) hasOlder = true
    messageRows = merged.slice(0, messageCapacity)
  }
  await Promise.all([refreshChatActivity(),refreshNativeFooter()])
  if (view === 'messages' && chatFilter() === query) renderChat()
}
async function loadOlderMessages() {
  if (olderLoading || !hasOlder) return
  const query = chatFilter()
  olderLoading = true; $('older-messages').disabled = true; $('older-messages').textContent = '正在加载…'
  try {
    const rows = await api(`messages?${query}&limit=50&offset=${messageRows.length}`)
    if (chatFilter() !== query) return
    const seen = new Set(messageRows.map(row => row.event.event_id))
    messageRows.push(...rows.filter(row => !seen.has(row.event.event_id)))
    messageCapacity = Math.max(messageCapacity, messageRows.length)
    hasOlder = rows.length === 50; olderLoading = false; await refreshChatActivity(); if (chatFilter() === query) renderChat(true)
  } catch (error) { showError(error) }
  finally { olderLoading = false; $('older-messages').disabled = false; $('older-messages').textContent = '加载更早的消息' }
}

function toolText(value) {
  if(typeof value==='string'){try{return JSON.stringify(JSON.parse(value),null,2)}catch{return value}}
  return value===undefined?'':JSON.stringify(value,null,2)
}
// Match DSH ToolRow: a quiet summary line and a bounded input/output disclosure.
function toolCallCard(item,result,{pending=false,open=false,task=false}={}){
  const card=node('details',undefined,`native-tool ${task?'activity-tool':'chat-activity chat-tool'}`),summary=node('summary'),leading=node('span',undefined,'native-tool-leading')
  card.dataset.callId=item.call_id;card.dataset.activityId=item.id;card.open=open;card.classList.toggle('has-error',!!result?.is_error);card.classList.toggle('is-running',!result&&pending)
  leading.append(icon('code'));summary.append(leading,node('span',item.tool||'工具调用','native-tool-title'));summary.title=`${item.tool||'工具调用'} · ${time(item.timestamp)}`
  const args=item.arguments,hint=args&&typeof args==='object'?[args.description,args.command,args.file_path,args.path,args.query,args.content].find(value=>typeof value==='string'):typeof args==='string'?args:''
  let preview=hint
  if(result?.is_error){let error;try{error=JSON.parse(result.text)}catch{};preview=[error?.error?.message,error?.message,error?.reason,typeof error?.error==='string'?error.error:null,result.text,'调用失败'].find(value=>typeof value==='string'&&value).split('\n')[0]}
  if(preview){const text=node('span',String(preview).replace(/\s+/g,' ').slice(0,180),'native-tool-preview');text.title=String(preview);summary.append(node('span','·','native-tool-separator'),text)}
  const state=result?result.is_error?'失败':'已完成':pending?'执行中':'结果未载入'
  const status=node('span',state,`native-tool-status${!result&&pending?'':' sr-only'}`);status.setAttribute('role','status');summary.append(status)
  const body=node('div',undefined,'native-tool-body'),io=node('div',undefined,'native-tool-io')
  const section=(label,value,error,truncated)=>{
    const row=node('div',undefined,'native-tool-section'),text=node('pre',value,'native-tool-text');if(error)text.classList.add('is-error')
    row.append(node('span',label,'native-tool-label'),text);io.append(row)
    if(truncated)row.append(node('span',`已显示前 ${task?'32,000':'12,000'} 字符。`,'native-tool-truncated'))
  }
  section('输入',toolText(args),false,item.truncated)
  section('输出',result?toolText(result.text)||'已执行，无文本输出。':pending?'执行中…':'结果尚未归档，或位于未加载的历史记录中。',!!result?.is_error,result?.truncated)
  body.append(io);card.append(summary,body);return card
}
function chatActivityCard(item, items) {
  if(item.kind==='tool_call')return toolCallCard(item,items.find(row=>row.kind==='tool_result'&&row.call_id===item.call_id),{pending:messageRows.some(row=>row.event.event_id===item.event_id&&['queued','processing'].includes(row.state)),open:chatExpanded.has(item.id)})
  const card=node('article',undefined,'chat-activity chat-reasoning'),heading=node('div',undefined,'thought-heading'),body=node('div',undefined,'chat-activity-body')
  card.dataset.activityId=item.id;heading.append(icon('spark','activity-icon'),node('span','思考','chat-activity-title'),node('time',new Date(item.timestamp).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})))
  body.append(markdown(item.text));if(item.truncated)body.append(node('p','已显示前 12,000 字符。完整归档可在记忆页查看。','muted'))
  card.append(heading,body);return card
}
async function refreshChatActivity(older = false) {
  if (principal?.role !== 'admin') return
  if (activityLoading) return
  const query = chatFilter(), ids = messageRows.filter(row => row.event.source_kind !== 'output-gateway').slice(0, 100).map(row => row.event.event_id)
  const scope = `${query}:${[...ids].sort().join(',')}`
  if (scope !== activityScope) { chatActivityItems = []; activityCursor = undefined; activityHasMore = false; activityScope = scope }
  if (!ids.length) return
  const params = new URLSearchParams(); for (const id of ids) params.append('event', id)
  if (older && activityCursor) params.set('before', activityCursor)
  activityLoading = true
  try {
    const page = await api(`chat-activity?${params}`)
    if (chatFilter() !== query || activityScope !== scope) return
    const seen = new Map(chatActivityItems.map(item => [item.id, item])); for (const item of page.items) seen.set(item.id, item)
    chatActivityItems = [...seen.values()]
    if (older || activityCursor === undefined) { activityCursor = page.next_cursor; activityHasMore = page.has_more }
    $('chat-activity-error').hidden = true
  } catch {
    if (chatFilter() === query) { $('chat-activity-error').textContent = '思考与工具记录暂时无法加载，聊天仍可使用。'; $('chat-activity-error').hidden = false }
  } finally { activityLoading = false }
}
globalThis.AmphoreusUI.chatActivityCard = chatActivityCard

let selectedTaskId, taskDetailRecord, taskReturnView = 'tasks', taskReportOffset = 0, taskActivityItems = [], taskActivityOffset = 0, taskTab = 'activity', loadedTasks=[]
const taskKindName=task=>({worker:'工具助手',continuation:'潜意识分支',topic:'话题助手'})[task.kind||'worker']||'后台助手'
const taskTitle=task=>String(task.description||taskKindName(task)).trim().replace(/^任务[：:]\s*/,'').replace(/^你是[^，,\n]+[，,]\s*/,'').split(/[。\n]/).find(Boolean)||taskKindName(task)
function renderTaskList(){
  const query=$('task-search').value.trim().toLowerCase(),state=$('task-state-filter').value,active=task=>['queued','running','waiting'].includes(task.state)
  const tasks=loadedTasks.filter(task=>(!query||`${task.description} ${taskKindName(task)} ${task.task_id}`.toLowerCase().includes(query))&&(!state||(state==='active')===active(task)))
  $('task-list-summary').textContent=`${loadedTasks.length} 项任务 · ${loadedTasks.filter(active).length} 项进行中`
  const list=$('task-list');list.replaceChildren();if(!tasks.length)empty(list,loadedTasks.length?'当前筛选下没有任务':'尚无后台任务')
  for(const task of tasks){
    const row=node('article',undefined,'task-list-row'),open=node('button',undefined,'task-open'),glyph=icon(task.kind==='continuation'?'memory':task.kind==='topic'?'chat':'code'),text=node('span',undefined,'task-row-text'),title=node('strong',taskTitle(task),'task-row-title')
    glyph.classList.add('task-row-icon');title.title=task.description;text.append(title,node('small',`${taskKindName(task)} · ${time(task.updated_at||task.created_at)}`));if(task.error)text.append(node('small',task.error,'task-row-error'))
    open.type='button';open.setAttribute('aria-label',`查看任务：${taskTitle(task)}`);open.append(glyph,text,badge(task.state),node('span','›','task-row-chevron'));open.onclick=()=>openTask(task.task_id);row.append(open)
    if(['queued','running'].includes(task.state)&&principal?.role==='admin'){const cancel=node('button','取消','quiet task-cancel');cancel.type='button';cancel.setAttribute('aria-label',`取消任务：${task.description}`);cancel.onclick=async()=>{cancel.disabled=true;try{await api(`tasks/${encodeURIComponent(task.task_id)}/cancel`,{});await refresh()}catch(error){showError(error);cancel.disabled=false}};row.append(cancel)}
    list.append(row)
  }
}
function taskLink(id, label = '查看 Subagent →') {
  const button = node('button', label, 'task-link'); button.type = 'button'
  button.onclick = event => { event.preventDefault(); event.stopPropagation(); openTask(id) }
  return button
}
function openTask(id) {
  if (!id) return
  if (view !== 'task-detail') taskReturnView = view
  selectedTaskId = id; taskReportOffset = 0; taskActivityItems = []; taskActivityOffset = 0
  taskDetailRecord=undefined;$('task-session-info').open=false;$('task-model-options').open=false;delete $('task-model-settings').dataset.modelKey
  $('task-detail-title').textContent = '正在加载任务…'
  for (const target of ['task-detail-description', 'task-detail-meta', 'task-detail-state', 'task-detail-error', 'task-detail-context', 'task-activity', 'task-detail-reports','task-actions','task-model-settings']) $(target).replaceChildren()
  setTaskTab('activity', false)
  selectView('task-detail')
}
function setTaskTab(tab, reload = true) {
  taskTab = tab
  for (const name of ['activity', 'reports']) { $(`task-tab-${name}`).setAttribute('aria-selected', String(name === tab)); $(`task-${name}-panel`).hidden = name !== tab }
  if (reload) refresh()
}
function reportCard(report, link = true) {
  const card = node('article', undefined, 'timeline-item')
  card.append(badge(report.type), node('time', time(report.created_at)), markdown(report.summary))
  if (report.progress !== undefined&&report.progress<100) { const progress = node('progress'); progress.value = report.progress; progress.max = 100; progress.setAttribute('aria-label', `进度 ${report.progress}%`); card.append(progress) }
  if (report.details?.length) {const details=node('details',undefined,'report-attachments');details.append(node('summary','附件与补充内容'),blocks(report.details));card.append(details)}
  if (link && report.task_id) card.append(taskLink(report.task_id,'查看会话 →'))
  const raw=rawDetails(report);raw.querySelector('summary').textContent='查看完整记录';card.append(raw);return card
}
function fields(value) {
  if (!value || typeof value !== 'object') return node('pre', String(value ?? ''))
  const list = node('dl', undefined, 'tool-fields')
  const format = item => item && typeof item === 'object' ? Array.isArray(item) ? item.map(format).join('\n') : Object.entries(item).map(([key, val]) => `${key}: ${format(val)}`).join('\n') : String(item ?? '')
  for (const [key, val] of Object.entries(value)) { list.append(node('dt', key), node(key === 'command' || key === 'code' ? 'pre' : 'dd', format(val))) }
  return list
}
function renderTaskActivity(available, state) {
  const list = $('task-activity'),scroller=$('task-session-scroll'), top = scroller.scrollTop, pinned = scroller.scrollHeight - scroller.clientHeight - top < 80
  const expanded = new Set([...list.querySelectorAll('details[open]')].map(detail => detail.dataset.callId))
  list.replaceChildren()
  const results = new Map(taskActivityItems.filter(item => item.kind === 'tool_result').map(item => [item.call_id, item]))
  if (!taskActivityItems.length) empty(list, available ? '暂时没有发言或工具记录，执行时会实时更新。' : '执行记录尚未生成，或对应的 DSH Session 已不在当前存储中。')
  for (const item of taskActivityItems) {
    if (item.kind === 'tool_result') continue
    if (item.kind === 'tool_call') {
      list.append(toolCallCard(item,results.get(item.call_id),{pending:['running','queued'].includes(state),open:expanded.has(item.call_id),task:true}))
    } else if (item.kind === 'message') {
      const card = node('article', undefined, `activity-message ${item.role==='input'?'task-message-input':'task-message-assistant'}`); card.append(node('small', `${item.role === 'input' ? 'Main' : 'Subagent'} · ${time(item.timestamp)}`), markdown(item.text)); if (item.arguments) {const detail=node('details');detail.append(node('summary','消息详情'),node('pre',toolText(item.arguments)));card.append(detail)}; if (item.truncated) card.append(node('p', '此处显示前 32,000 字符。', 'muted')); list.append(card)
    } else list.append(node('p', `${item.text} · ${time(item.timestamp)}`, 'activity-status'))
  }
  scroller.scrollTop = pinned ? scroller.scrollHeight : top
}
async function refreshTaskDetail() {
  const id = selectedTaskId, detail = await api(`tasks/${encodeURIComponent(id)}?limit=50&offset=${taskReportOffset}`)
  if (view !== 'task-detail' || selectedTaskId !== id) return
  const { task, reports, parent_run: run } = detail
  taskDetailRecord=task
  if (principal.role === 'admin'&&$('task-model-options').open) try{await refreshModels(task)}catch(error){$('task-model-settings').textContent='模型配置暂不可用，可稍后重新打开任务。'}
  $('task-parent-name').textContent=roleName;$('task-detail-title').textContent = taskKindName(task)
  $('task-detail-state').replaceChildren(badge(task.state))
  $('task-actions').replaceChildren()
  if (principal.role === 'admin' && ['continuation','topic'].includes(task.kind)) for (const [action, label] of [['pause','暂停'],['resume','继续'],['cancel','终止']]) {
    if (action === 'resume' && ['running','queued'].includes(task.state) || action === 'pause' && ['paused','completed','cancelled','failed'].includes(task.state)) continue
    const button = node('button', label, 'quiet');button.dataset.taskAction=action; button.onclick = () => api(`tasks/${encodeURIComponent(id)}/${action}`, {}).then(refresh).catch(showError); $('task-actions').append(button)
  }
  $('task-detail-description').replaceChildren(markdown(task.description))
  const meta = $('task-detail-meta'); meta.replaceChildren()
  for (const [name, value] of [['任务 ID', task.task_id], ['Subagent', task.subagent_id], ['创建时间', time(task.created_at)], ['更新时间', time(task.updated_at)], ['优先级', task.priority], ['来源', task.origin ? `${task.origin.platform.toUpperCase()} · ${task.origin.conversation_id}` : '内部任务'], ['Main Run', run ? `${run.run_id} · ${labels[run.state] || run.state}` : task.parent_run_id || '—']]) meta.append(node('dt', name), node('dd', value))
  $('task-detail-error').replaceChildren(); if (task.error) $('task-detail-error').append(node('p', task.error, 'error'))
  meta.append(node('dt', '类型'), node('dd', task.kind==='topic'?`专用话题分支 · ${task.topic_id}`:task.kind === 'continuation' ? '长程潜意识 · 原生 Fork' : '工具型助手'))
  if (task.archived_at) meta.append(node('dt', '已归档'), node('dd', time(task.archived_at)))
  if (task.fork) for (const [name, value] of [['父 Session',task.fork.parent_session_id],['Fork 边界',task.fork.fork_event_seq],['Self 版本',task.fork.self_version || '尚未形成'],['当前周期',task.activation ?? 0]]) meta.append(node('dt', name),node('dd', value))
  $('task-context').hidden = !task.context?.length
  $('task-detail-context').replaceChildren(blocks(task.context))
  $('task-detail-reports').replaceChildren()
  for (const item of [...reports.map(report => ({ ...report, direction: 'report' })), ...(detail.messages || [])].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    if (item.direction === 'report') { $('task-detail-reports').append(reportCard(item, false)); continue }
    const card = node('article', undefined, 'timeline-item'); card.append(node('small', `Main → 分支 · ${time(item.created_at)} · ${item.status === 'accepted' ? '已进入分支上下文' : '等待投递'}`), markdown(item.content)); $('task-detail-reports').append(card)
  }
  if (!reports.length && !detail.messages?.length) empty($('task-detail-reports'), '当前没有主动汇报或协作消息')
  $('task-detail-report-page').textContent = `第 ${taskReportOffset / 50 + 1} 页`
  $('task-prev-reports').disabled = taskReportOffset === 0; $('task-next-reports').disabled = reports.length < 50
  if (taskTab === 'activity') {
    const page = await api(`tasks/${encodeURIComponent(id)}/activity?limit=100&offset=${taskActivityOffset}`)
    if (view !== 'task-detail' || selectedTaskId !== id) return
    const seen = new Set(taskActivityItems.map(item => item.id))
    taskActivityItems.push(...page.items.filter(item => !seen.has(item.id))); taskActivityOffset = page.end_offset
    renderTaskActivity(page.available, task.state); $('task-more-activity').hidden = !page.has_more
  }
}

async function api(path, data, method = 'GET') {
  const res = await fetch(`${apiBase}api/${path}`, { method: data === undefined ? method : method === 'GET' ? 'POST' : method,
    headers: { 'content-type': 'application/json', 'x-amphoreus-request': '1' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) })
  const value = await res.json()
  if (!res.ok) throw new Error(value.error || `请求失败 ${res.status}`)
  return value
}
const showError = error => { $('error').hidden = false; $('error').textContent = error.message || String(error) }
const empty = (parent, text) => parent.append(node('p', text, 'empty'))
let memoryOffset = 0, selectedMemory, memoryText = '', memoryNext, memoryDetailGeneration = 0
function memoryLink(id, title = id.slice(0, 16)) {
  const button = node('button', title, 'quiet memory-link'); button.onclick = () => openMemory(id).catch(showError); return button
}
async function openMemory(id, append = false) {
  const generation = ++memoryDetailGeneration
  const record = await api(`memory/${encodeURIComponent(id)}?offset=${append ? memoryNext || 0 : 0}&size=4000`)
  if (generation !== memoryDetailGeneration) return
  selectedMemory = id; memoryText = append ? memoryText + record.text : record.text; memoryNext = record.next_offset
  const detail = $('memory-detail'); detail.replaceChildren(node('h2', record.title), badge(record.status), node('p', `${memoryKinds[record.kind] || record.kind} · ${time(record.created_at)} · 重要性 ${record.importance.toFixed(2)}`, 'muted'))
  const provenance = node('dl', undefined, 'task-meta')
  const branchName = value => ({ main: '主 Agent', continuation: '潜意识',topic:'话题子代理', worker: '工具助手' })[value] || value
  for (const [key, title] of [['branch','提出者'],['platform','来源平台'],['actor_id','发言者'],['conversation_id','来源会话']]) if (record.source[key]) provenance.append(node('dt', title), node('dd', key === 'branch' ? branchName(record.source[key]) : record.source[key]))
  if (record.source.task_id) { const link = node('dd'); link.append(taskLink(record.source.task_id, '查看来源分支 →')); provenance.append(node('dt', '分支记录'), link) }
  if (record.data.draft_source?.branch) provenance.append(node('dt', '草稿来源'), node('dd', branchName(record.data.draft_source.branch)))
  if (record.data.confirmed_by_run) provenance.append(node('dt', '最终确认'), node('dd', '主 Agent 已审阅确认'))
  if (record.data.version) provenance.append(node('dt', '版本'), node('dd', record.data.version))
  for(const [key,title] of [['category','语义类别'],['evidence_type','证据类型'],['observed_at','观察时间'],['valid_from','生效时间'],['valid_to','失效时间']])if(key in record.data)provenance.append(node('dt',title),node('dd',record.data[key]??'未知'))
  if(Array.isArray(record.data.entity_refs)&&record.data.entity_refs.length)provenance.append(node('dt','人物账号'),node('dd',record.data.entity_refs.join('、')))
  detail.append(provenance)
  if (record.expires_at) detail.append(node('p', `原始推理保留至 ${time(record.expires_at)}`, 'muted'))
  if (!memoryText) detail.append(node('p', record.status === 'expired' ? '原文已按保留策略清除，来源与关联仍在。' : '没有可用原文。', 'muted'))
  else detail.append(markdown(memoryText))
  if (memoryNext !== null) { const more = node('button', `继续读取（已读 ${memoryText.length} / ${record.total_chars}）`, 'secondary'); more.onclick = () => openMemory(id, true).catch(showError); detail.append(more) }
  const refs = new Set([...(record.data.source_ids || []), ...(record.data.revisions || []), record.data.related_id, record.data.memory_id, record.data.draft_id, record.data.previous_id, record.data.formal_id, record.data.assistant_id, record.data.job_id].filter(value => typeof value === 'string' && value !== id))
  if (refs.size) { detail.append(node('h3', '来源与版本关联')); for (const ref of refs) { const known = record.related?.find(item => item.id === ref); detail.append(memoryLink(ref, known ? `${memoryKinds[known.kind] || known.kind} · ${known.title}` : undefined)) } }
  if (record.related?.length) { detail.append(node('h3', '后续讨论、采用与正式内容')); for (const ref of record.related) { const row = node('div'); row.append(memoryLink(ref.id, `${memoryKinds[ref.kind] || ref.kind} · ${ref.title}`), badge(ref.status)); detail.append(row) } }
  if (record.data.confirmation_note || record.data.review_note) detail.append(node('p', record.data.confirmation_note || record.data.review_note))
  const form = node('form', undefined, 'memory-review'), label = node('label', '给角色的审阅意见'), feedback = node('textarea'); feedback.rows = 3; feedback.maxLength = 8000; feedback.placeholder = '可附上修改建议，由 Main 决定是否采用或确认。'; label.append(feedback)
  const submit = node('button', '请 Main 审阅', 'secondary'), status = node('p', '', 'muted'); submit.type = 'submit'; form.append(label, submit, status)
  let key
  form.onsubmit = async event => { event.preventDefault(); submit.disabled = true; key ||= randomId(); try { await api(`memory/${encodeURIComponent(id)}/review`, { feedback: feedback.value || '请亲自审阅，决定是否采用或修订。', idempotency_key: key }); status.textContent = '已交给 Main，审阅结果将保留在记忆中。' } catch (error) { showError(error); submit.disabled = false } }
  detail.append(form, rawDetails(record))
}
let topicSelection='',topicOffset=0
async function openTopicThread(id,original=false,offset=0){
  topicSelection=id;topicOffset=offset
  const view=await api(`topics/${encodeURIComponent(id)}?include_original=${original}&limit=8&offset=${offset}`),root=$('topic-thread-detail');root.replaceChildren()
  root.append(node('h3',view.title),markdown(view.text),node('p',`已收录 ${view.total_entries} 条原文／想法；默认只召回摘要。`,'muted'))
  const show=node('button',original?'收起原文':'按需召回原文与想法','secondary');show.onclick=()=>openTopicThread(id,!original).catch(showError);root.append(show)
  if(original){for(const item of view.originals){const entry=node('article',undefined,'panel');entry.append(node('small',`${({thought:'角色的想法',speech:'角色的发言',message:'对话原文'})[item.type]||item.type} · ${time(item.at)} · ${item.source.platform||item.source.branch||''} / ${item.source.conversation_id||''} · ${item.source.actor_id||''}`),markdown(item.text),memoryLink(item.memory_id,'查看完整来源记录'));root.append(entry)}
    if(offset){const prev=node('button','上一页','quiet');prev.onclick=()=>openTopicThread(id,true,Math.max(0,offset-8)).catch(showError);root.append(prev)}
    if(view.next_offset!==null){const more=node('button','下一页原文','quiet');more.onclick=()=>openTopicThread(id,true,view.next_offset).catch(showError);root.append(more)}
  }
}
async function refreshTopicThreads(){
  const [status,list]=await Promise.all([api('topic-organizer'),api('topics?limit=100')]),settings=$('topic-organizer-settings')
  if(!settings.contains(document.activeElement)){
    settings.replaceChildren(node('p','自动整理是独立后台 Agent，会消耗额外模型 Token。默认关闭；只处理开启后的新对话和Main想法，不会自动唤醒Main。','muted'))
    const form=node('form',undefined,'memory-filters'),enabled=node('input'),interval=node('input'),batch=node('input'),save=node('button','保存自动整理设置')
    enabled.type='checkbox';enabled.checked=status.settings.enabled;const label=node('label',undefined,'check');label.append(enabled,document.createTextNode('开启后台话题自动整理'));form.append(label)
    for(const [input,text,value,min,max] of [[interval,'最短间隔（秒）',status.settings.intervalMs/1000,10,3600],[batch,'每批消息／想法',status.settings.batchSize,1,30]]){const field=node('label',text);input.type='number';input.value=value;input.min=min;input.max=max;input.step=1;field.append(input);form.append(field)}
    form.append(save);form.onsubmit=async e=>{e.preventDefault();save.disabled=true;try{await api('topic-organizer',{enabled:enabled.checked,intervalMs:Number(interval.value)*1000,batchSize:Number(batch.value)});save.textContent='已保存'}catch(error){showError(error)}finally{save.disabled=false}};settings.append(form)
    settings.append(node('p',`${status.settings.enabled?'已开启':'已关闭'} · ${status.running?'正在分类':'空闲'}${status.last_job?` · 上批 ${status.last_job.status} / ${status.last_job.records} 条 / 尝试 ${status.last_job.attempts} 次`:''}${status.last_job?.error?` · ${status.last_job.error}`:''}`,'muted'))
  }
  const topics=$('topic-thread-list');topics.replaceChildren()
  for(const item of list.items??[]){const button=node('button',item.title,'quiet');button.onclick=()=>openTopicThread(item.topic_id).catch(showError);topics.append(button)}
}

async function refreshMemory() {
  const query = new URLSearchParams({ limit: '20', offset: String(memoryOffset), order: 'recent', query: $('memory-query').value, kind: $('memory-kind').value, branch: $('memory-branch').value, status: $('memory-status').value, historical: String($('memory-historical').checked) })
  if ($('memory-since').value) query.set('since', new Date(`${$('memory-since').value}T00:00:00`).toISOString())
  if ($('memory-until').value) query.set('until', new Date(`${$('memory-until').value}T23:59:59.999`).toISOString())
  for (const [key, value] of [...query]) if (!value) query.delete(key)
  const [records, stats, dreams] = await Promise.all([api(`memory?${query}`), api('memory/stats'), api('dreaming')])
  if (view !== 'memory') return
  await refreshTopicThreads()
  $('memory-stats').replaceChildren(...stats.counts.map(row => node('span', `${memoryKinds[row.kind] || row.kind} · ${labels[row.status] || row.status} ${row.count}`, 'pill')))
  const overview = $('memory-overview'); overview.replaceChildren(node('h3', '当前的我'))
  overview.append(stats.current_self ? markdown(stats.current_self.text) : node('p', '尚未形成正式 Self。人格基准仍使用完整人设。', 'muted'))
  if (stats.current_self) overview.append(memoryLink(stats.current_self.id, `查看 Self · 版本 ${stats.current_self.data.version}`))
  const days = node('details'); days.append(node('summary', '近 30 个活跃日 · 记忆数量与平均重要性'))
  for (const day of stats.distribution || []) days.append(node('p', `${day.day} · ${day.count} 条 · 重要性 ${Number(day.importance).toFixed(2)}`)); overview.append(days)
  const policy = stats.policy.reasoning
  $('dreaming-policy').textContent = `${dreams.enabled ? '每日' : '已关闭定时回顾'} ${dreams.at} · ${dreams.time_zone}；接口推理保留 ${policy.retentionDays} 天，重要原文${policy.retainImportantRaw ? `最长 ${policy.importantRetentionDays} 天` : '不自动延长'}。`
  $('dreaming-jobs').replaceChildren()
  for (const job of dreams.jobs) { const row = node('div', undefined, 'row'); row.append(memoryLink(job.id, job.title), badge(job.status)); for (const id of job.data.task_ids || []) row.append(taskLink(id)); $('dreaming-jobs').append(row) }
  $('memory-list').replaceChildren()
  if (!records.length) empty($('memory-list'), '没有符合条件的记忆')
  for (const record of records) { const card = node('article', undefined, 'memory-card'); card.append(memoryLink(record.id, record.title), badge(record.status), node('small', `${memoryKinds[record.kind] || record.kind} · ${record.source.branch || record.source.platform || '网关'} · ${time(record.created_at)} · ${record.importance.toFixed(2)}`), node('p', record.excerpt)); $('memory-list').append(card) }
  $('memory-page').textContent = `第 ${memoryOffset / 20 + 1} 页`; $('memory-prev').disabled = !memoryOffset; $('memory-next').disabled = records.length < 20
}
let modelsCatalog
const modelScopeNames={main:'主会话',worker:'工具助手',continuation:'潜意识助手',topic:'话题助手'}
function modelEffectiveText(state){const value=state.effective;return value?`已保存配置：${value.provider} / ${value.model}${value.reasoningEffort?` · ${value.reasoningEffort}`:''}`:state.error||'当前模型不可用，请重新选择'}
function modelForm(scope,state,catalog,task){
  const form=node('form',undefined,'model-form'),title=task?'此任务独立模型':modelScopeNames[scope]
  form.dataset.modelScope=scope;form.append(node('h3',title))
  const field=(title,input)=>{const label=node('label',title);label.append(input);form.append(label);return input}
  const route=node('select'),effort=node('select'),inherit=node('option',task?'跟随此类助手':scope==='continuation'||scope==='topic'?'跟随主会话':'跟随 DSH 默认');inherit.value='';route.append(inherit)
  for(const group of catalog.groups){
    const options=node('optgroup');options.label=group.name
    for(const model of group.models){const option=node('option',model.name);option.value=JSON.stringify([group.id,model.id]);options.append(option)}route.append(options)
  }
  let selected=state.selection,selectedKey=selected?JSON.stringify([selected.provider,selected.model]):''
  if(selected&&!Array.from(route.options).some(option=>option.value===selectedKey)){const option=node('option',`${selected.provider} / ${selected.model}（当前配置）`);option.value=selectedKey;route.append(option)}
  route.value=selectedKey;route.setAttribute('aria-label',`${title}模型`);field('模型',route)
  const syncEffort=()=>{
    effort.replaceChildren();const option=node('option','模型默认');option.value='';effort.append(option)
    const [provider,id]=route.value?JSON.parse(route.value):[]
    const model=catalog.groups.find(group=>group.id===provider)?.models.find(model=>model.id===id)
    for(const value of model?.reasoning?.efforts||[]){const option=node('option',value.name);option.value=value.id;effort.append(option)}
    if(route.value===selectedKey&&selected?.reasoningEffort){if(!Array.from(effort.options).some(option=>option.value===selected.reasoningEffort)){const option=node('option',selected.reasoningEffort);option.value=selected.reasoningEffort;effort.append(option)}effort.value=selected.reasoningEffort}
    effort.disabled=!route.value||effort.options.length===1
  }
  route.onchange=syncEffort;syncEffort();effort.setAttribute('aria-label',`${title}推理强度`);field('推理强度',effort)
  form.append(node('p',modelEffectiveText(state),'muted'))
  const save=node('button','保存','secondary'),message=node('p');message.setAttribute('role','status');save.type='submit';form.append(save,message)
  form.onsubmit=async event=>{
    event.preventDefault();save.disabled=true;route.disabled=true;effort.disabled=true
    try{
      const [provider,model]=route.value?JSON.parse(route.value):[]
      const result=await api('models',{scope,...(task?{task_id:task.task_id}:{}),selection:route.value?{provider,model,...(effort.value?{reasoningEffort:effort.value}:{})}:null})
      const target=task?result.task:result.roles[scope]
      selected=target.selection;selectedKey=selected?JSON.stringify([selected.provider,selected.model]):''
      form.querySelector('.muted').textContent=modelEffectiveText(target)
      if(!task)for(const item of document.querySelectorAll('#model-settings form'))item.querySelector('.muted').textContent=modelEffectiveText(result.roles[item.dataset.modelScope])
      message.textContent='已保存，下次模型请求生效。';$('error').hidden=true
    }catch(error){message.textContent='保存失败，请检查设置后重试。';showError(error)}finally{save.disabled=false;route.disabled=false;effort.disabled=!route.value||effort.options.length===1}
  }
  return form
}
async function refreshModels(task){
  const root=$(task?'task-model-settings':'model-settings'),key=task?task.task_id:'roles'
  // Do not replace unsaved choices on every live event refresh.
  if(root.dataset.modelKey===key)return
  const state=await api(`models?catalog=1${task?`&task_id=${encodeURIComponent(task.task_id)}`:''}`)
  if(task&&selectedTaskId!==task.task_id)return
  modelsCatalog=state.catalog;root.replaceChildren();root.dataset.modelKey=key
  if(task)root.append(modelForm(task.kind||'worker',state.task,modelsCatalog,task))
  else{
    for(const scope of Object.keys(modelScopeNames))root.append(modelForm(scope,state.roles[scope],modelsCatalog))
    $('models-message').textContent=modelsCatalog.failures.length?`部分提供方暂不可用：${modelsCatalog.failures.map(item=>item.name).join('、')}`:''
  }
  const reload=node('button','重新读取配置','quiet');reload.type='button';reload.onclick=async()=>{delete root.dataset.modelKey;try{await refreshModels(task)}catch(error){showError(error)}};root.append(reload)
}
async function saveControl(input){
  const state=await api('control',input);renderAboutControls(state)
  $('about-control-message').textContent='已保存，开关立即生效。';$('error').hidden=true
}
function controlSwitch(title,checked,change,disabled=false){
  const label=node('label',undefined,'control-switch'),input=node('input');input.type='checkbox';input.checked=checked;input.disabled=disabled;input.setAttribute('role','switch');input.setAttribute('aria-label',title)
  label.append(input,node('span',title))
  input.onchange=async()=>{input.disabled=true;try{await change(input.checked)}catch(error){input.checked=checked;$('about-control-message').textContent='保存尚未确认，请刷新核对。';showError(error)}finally{input.disabled=disabled}}
  return label
}
function renderAboutControls(state){
  const root=$('about-controls'),expanded=new Set([...root.querySelectorAll('details[open]')].map(n=>n.dataset.platform))
  const filters=new Map([...root.querySelectorAll('[data-channel-search]')].map(n=>[n.dataset.channelSearch,n.value]))
  root.replaceChildren()
  const master=node('div',undefined,'control-master control-row');master.append(controlSwitch(`${roleName} 总开关`,state.enabled,enabled=>saveControl({enabled})),node('strong',state.enabled?'允许运行':'已暂停'));root.append(master)
  root.append(node('p','关闭总开关也会停止后台工作。重新开启可继续潜意识和话题分支；已经执行工具的助手不会自动重做。','muted'))
  const names={web:'网页聊天',qq:'QQ',bilibili:'B站'}
  for(const channel of state.channels){
    const card=node('article',undefined,'control-channel'),header=node('div',undefined,'control-row')
    header.append(controlSwitch(`${names[channel.platform]} 渠道`,channel.enabled,enabled=>saveControl({platform:channel.platform,enabled}),!channel.available),node('span',!channel.available?'尚未接入':!state.enabled?'总开关已关闭':channel.effective?'允许处理':'渠道已关闭','badge'));card.append(header)
    const details=node('details');details.dataset.platform=channel.platform;details.open=expanded.has(channel.platform)
    details.append(node('summary',`详情 · ${channel.conversations.length} 个已知会话`))
    const search=node('input'),kind=node('select'),filtersRow=node('div',undefined,'control-filter')
    search.type='search';search.placeholder='搜索名称或账号';search.setAttribute('aria-label',`${names[channel.platform]}会话搜索`);search.dataset.channelSearch=channel.platform;search.value=filters.get(channel.platform)||''
    for(const [value,label] of [['','全部会话'],['group','群聊'],['private','私聊']]){const option=node('option',label);option.value=value;kind.append(option)}
    kind.setAttribute('aria-label','会话类型');filtersRow.append(search,kind);details.append(filtersRow)
    const list=node('div',undefined,'control-conversations')
    for(const conversation of channel.conversations){
      const row=node('div',undefined,'control-conversation'),target={platform:channel.platform,account_id:conversation.account_id,conversation_id:conversation.conversation_id}
      const type=conversation.conversation_id.startsWith('group:')?'group':'private'
      row.dataset.kind=type;row.dataset.search=`${conversation.title} ${conversation.conversation_id} ${conversation.account_id}`.toLowerCase()
      const heading=node('div',undefined,'control-row'),label=`${type==='group'?'群聊':'私聊'} · ${conversation.title}`
      const toggle=controlSwitch(label,conversation.enabled,enabled=>saveControl({...target,enabled}),!channel.available)
      toggle.querySelector('input').dataset.conversation=conversation.conversation_id
      heading.append(toggle,node('span',conversation.effective?'允许处理':!state.enabled?'总开关已关闭':!channel.enabled?'渠道已关闭':'会话已关闭','badge'))
      const sub=node('div',undefined,'control-row muted');sub.append(node('small',`${conversation.conversation_id} · ${conversation.override===null?'继承默认':'独立设置'}`))
      if(conversation.override!==null){const reset=node('button','恢复默认','quiet');reset.type='button';reset.onclick=async()=>{reset.disabled=true;try{await saveControl({...target,reset:true})}catch(error){showError(error);reset.disabled=false}};sub.append(reset)}
      row.append(heading,sub);list.append(row)
    }
    if(!channel.conversations.length)empty(list,'还没有已知会话。')
    const filter=()=>{for(const row of list.querySelectorAll('[data-search]'))row.hidden=!!kind.value&&row.dataset.kind!==kind.value||!row.dataset.search.includes(search.value.trim().toLowerCase())}
    search.oninput=kind.onchange=filter;filter();details.append(list)
    if(channel.platform==='qq'&&channel.available){
      const manual=node('form',undefined,'control-filter'),type=node('select'),id=node('input'),choice=node('select'),button=node('button','设置指定会话','secondary')
      for(const [value,label] of [['group','群聊'],['private','私聊']]){const option=node('option',label);option.value=value;type.append(option)}
      for(const [value,label] of [['true','开启'],['false','关闭']]){const option=node('option',label);option.value=value;choice.append(option)}
      type.setAttribute('aria-label','指定会话类型');choice.setAttribute('aria-label','指定会话开关');id.setAttribute('aria-label','群号或QQ号');id.placeholder='群号或 QQ 号';id.required=true;id.pattern='[1-9][0-9]{0,19}'
      manual.append(type,id,choice,button);manual.onsubmit=async event=>{event.preventDefault();button.disabled=true;try{await saveControl({platform:'qq',account_id:channel.account_id,conversation_id:`${type.value}:${id.value}`,enabled:choice.value==='true'})}catch(error){showError(error);button.disabled=false}};details.append(manual)
    }
    card.append(details);root.append(card)
  }
}
async function refreshAbout(){
  const info=await api('about')
  $('about-name').textContent=info.name;$('about-description').textContent=info.description;$('about-version').textContent=`版本 ${info.version} · ${info.runtime} · 源码许可 ${info.license}`
  $('about-usage').replaceChildren(...info.usage.map(text=>node('li',text)));$('about-open-source').textContent=info.open_source
  $('about-license-usage').replaceChildren(...(info.license_usage||[]).map(text=>node('li',text)))
  $('about-source-links').replaceChildren()
  for(const [href,title]of [[info.source_url,'获取对应源码'],[info.license_url,'AGPLv3 完整条文']])if(typeof href==='string'&&/^https:\/\//.test(href)){const link=node('a',title);link.href=href;link.target='_blank';link.rel='noopener noreferrer';$('about-source-links').append(link)}
  const software=$('about-software');software.replaceChildren()
  for(const component of info.components){
    const details=node('details',undefined,'software-notice');details.append(node('summary',`${component.name} · ${component.version} · ${component.license}`),node('p',component.purpose))
    if(component.note)details.append(node('p',component.note,'muted'))
    const links=node('p',undefined,'software-links')
    for(const [url,title] of [[component.source,'原项目'],[component.license_url,'完整许可']])if(typeof url==='string'&&/^https:\/\//.test(url)){const a=node('a',title);a.href=url;a.target='_blank';a.rel='noopener noreferrer';links.append(a)}
    details.append(links)
    if(component.license_text)details.append(node('pre',component.license_text,'notice-text'))
    software.append(details)
  }
  if(principal?.role==='admin')renderAboutControls(await api('control'))
}
let peopleOffset=0
const stablePerson=value=>/^[1-9]\d{4,19}$/.test(value.trim())?`qq:${value.trim()}`:value.trim()
function personForm(title,fields,submit){
  const details=node('details'),form=node('form');details.append(node('summary',title),form)
  for(const [key,label,required] of fields){const row=node('label',label),input=node(['body','evidence','reason'].includes(key)?'textarea':'input');if(input.tagName==='TEXTAREA')input.rows=2;input.name=key;input.required=!!required;input.maxLength=key==='body'?2000:key==='evidence'?1000:600;row.append(input);form.append(row)}
  const button=node('button','保存','secondary');form.append(button)
  form.onsubmit=async event=>{event.preventDefault();button.disabled=true;try{await submit(Object.fromEntries(new FormData(form)));await refreshPeople()}catch(error){showError(error);button.disabled=false}}
  return details
}
async function refreshPeople(){
  const data=await api(`people?query=${encodeURIComponent($('people-query').value)}&offset=${peopleOffset}&limit=12`)
  $('people-list').replaceChildren()
  for(const person of data.people){
    const card=node('article',undefined,'panel');card.append(node('h2',person.display_name||person.identity),node('p',person.accounts.map(account=>`${account.display_name||''} ${account.ref}`).join(' · '),'muted'))
    const change=async(tool,args)=>api('people',{tool,args:{identity:person.identity,...args}})
    for(const note of person.impressions){const row=node('div',undefined,'timeline-item');row.append(node('strong',note.key),node('p',note.body),node('small',`依据：${note.evidence} · ${note.certainty}`));const remove=node('button','删除这条印象','quiet');remove.onclick=async()=>{try{await change('people_note',{identity:note.subject_ref,action:'delete',key:note.key});await refreshPeople()}catch(error){showError(error)}};row.append(remove);card.append(row)}
    for(const contact of person.contacts){const row=node('div',undefined,'row');row.append(node('span',`${contact.label||'邮箱'}：${contact.address}`));const remove=node('button','移除邮箱','quiet');remove.onclick=async()=>{try{await change('people_contact',{action:'delete',address:contact.address});await refreshPeople()}catch(error){showError(error)}};row.append(remove);card.append(row)}
    card.append(personForm('记一条印象（相同主题会更新）',[['key','主题',true],['body','印象',true],['evidence','依据',true]],args=>change('people_note',args)),personForm('添加邮箱',[['address','邮箱',true],['label','备注',false]],args=>change('people_contact',{...args,action:'set'})),personForm('关联另一个已登记账号',[['to','对方账号',true],['reason','确认是同一人的依据',true]],args=>change('people_link',{...args,to:stablePerson(args.to),action:'link'})))
    for(const account of person.accounts)if(person.accounts.length>1)card.append(personForm(`拆出账号 ${account.ref}`,[['reason','纠正关联的依据',true]],args=>change('people_link',{...args,identity:account.ref,action:'unlink'})))
    $('people-list').append(card)
  }
  if(!data.people.length)empty($('people-list'),'没有找到人物。')
  $('people-page').textContent=`${peopleOffset+1}–${peopleOffset+data.people.length} / ${data.total}`;$('people-prev').disabled=!peopleOffset;$('people-next').disabled=peopleOffset+data.people.length>=data.total
}
async function refreshBlacklist(){
  const root=$('user-blacklist'),status=await api('user-blacklist');root.replaceChildren()
  root.append(node('h3','用户黑名单'),node('p','按 QQ 号屏蔽当前账号所有群聊与私聊；艾特不绕过。原始历史保留，解除不补发旧消息，已开始的生成不能收回。'))
  const form=node('form',undefined,'memory-filters'),id=node('input'),reason=node('input'),submit=node('button','拉黑用户')
  id.name='user_id';id.placeholder='QQ 号';id.required=true;id.pattern='[1-9][0-9]{0,19}';id.setAttribute('aria-label','拉黑用户QQ号')
  reason.name='reason';reason.placeholder='原因（可选）';reason.maxLength=500;reason.setAttribute('aria-label','拉黑原因');form.append(id,reason,submit);root.append(form)
  form.onsubmit=async event=>{event.preventDefault();submit.disabled=true;try{await api('user-blacklist',{action:'block',user_id:id.value,reason:reason.value});await refreshBlacklist();$('error').hidden=true}catch(error){showError(error)}finally{submit.disabled=false}}
  if(!status.items?.length)root.append(node('p','暂无拉黑用户','muted'))
  for(const item of status.items??[]){const row=node('article',undefined,'panel'),remove=node('button','解除拉黑','quiet');remove.type='button'
    row.append(node('strong',`QQ ${item.user_id}`),node('p',item.reason||'未填写原因'),node('small',time(item.blocked_at)),remove)
    remove.onclick=async()=>{remove.disabled=true;try{await api('user-blacklist',{action:'unblock',user_id:item.user_id});await refreshBlacklist();$('error').hidden=true}catch(error){showError(error)}finally{remove.disabled=false}}
    root.append(row)
  }
}
function qqControlForm(settings,conversation){
  const form=node('form',undefined,'memory-filters'),fields={}
  for(const [key,title] of [['receiveEnabled','接收消息并允许唤醒'],['debounceEnabled','普通消息消抖（艾特立即唤醒）']]){
    const label=node('label',undefined,'check'),input=node('input');input.type='checkbox';input.checked=settings[key];label.append(input,document.createTextNode(title));form.append(label);fields[key]=()=>input.checked
  }
  for(const [key,title,max] of [['waitMs','安静等待（秒）',120],['maxWaitMs','最长等待（秒）',300]]){
    const label=node('label',title),input=node('input');input.type='number';input.min=.1;input.max=max;input.step=.1;input.value=settings[key]/1000;label.append(input);form.append(label);fields[key]=()=>Math.round(Number(input.value)*1000)
  }
  const save=node('button','保存消息设置');form.append(save)
  form.onsubmit=async event=>{event.preventDefault();save.disabled=true;try{await api('qq-message-control',{...(conversation?{conversation_id:conversation}:{}),patch:Object.fromEntries(Object.entries(fields).map(([key,get])=>[key,get()]))});save.textContent='已保存';$('error').hidden=true}catch(error){showError(error)}finally{save.disabled=false}}
  if(conversation){const reset=node('button','恢复全局默认','quiet');reset.type='button';reset.onclick=async()=>{reset.disabled=true;try{await api('qq-message-control',{conversation_id:conversation,reset:true});reset.textContent='已恢复继承'}catch(error){showError(error)}finally{reset.disabled=false}};form.append(reset)}
  return form
}
async function refreshQQControl(){
  const status=await api('qq-message-control'),root=$('qq-message-controls');root.replaceChildren()
  const global=node('article',undefined,'panel');global.append(node('h3','QQ 消息接收与消抖'),node('p','全局默认可被群聊／私聊单独覆盖。关闭后不送模型；重新开启不补发关闭期间消息。消抖开启时普通消息合并交付，艾特角色立即带上积压；未开启时沿用群聊参与策略。'),qqControlForm(status.settings));root.append(global)
  const manual=node('form',undefined,'memory-filters'),kind=node('select'),id=node('input'),edit=node('button','配置指定会话'),holder=node('div')
  for(const [value,label] of [['group','群聊'],['private','私聊']]){const option=node('option',label);option.value=value;kind.append(option)}
  id.placeholder='群号或 QQ 号';id.required=true;id.pattern='[1-9][0-9]{0,19}';manual.append(kind,id,edit);root.append(manual,holder)
  manual.onsubmit=event=>{event.preventDefault();const conversation=`${kind.value}:${id.value}`,known=status.conversations.find(c=>c.conversation_id===conversation);holder.replaceChildren(node('h3',conversation),qqControlForm(known?.settings??status.settings,conversation))}
  for(const channel of status.conversations){const card=node('article',undefined,'panel'),details=node('details');details.append(node('summary',`${channel.title} · ${channel.conversation_id} · ${channel.settings.receiveEnabled?'接收':'已关闭'} · ${channel.settings.debounceEnabled?'消抖':'即时/参与策略'} · 缓冲 ${channel.pending} 条${Object.keys(channel.override).length?' · 独立配置':' · 继承默认'}`),qqControlForm(channel.settings,channel.conversation_id));card.append(details);root.append(card)}
}

function participationForm(settings,group) {
  const form=node('form',undefined,'memory-filters'),fields={}
  const select=node('select');for(const [value,title] of [['hybrid','混合调度'],['heart','心意模式']]){const option=node('option',title);option.value=value;select.append(option)}
  select.value=settings.mode;const mode=node('label','参与模式');mode.append(select);form.append(mode);fields.mode=()=>select.value
  const numbers=[['probability','基础概率（%）',100,0,100],['windowMs','观察窗口（秒）',.001,0,120],['maxMessages','每批消息上限',1,1,20],
    ['cooldownMs','主动冷却（分钟）',1/60000,0,1440],['inertiaMs','参与惯性（秒）',.001,0,600],['followupMs','回复后心意续聊（分钟，0关闭）',1/60000,0,30],['shareHigh','较高占比（%）',100,20,50],['shareStop','暂停占比（%）',100,35,100]]
  for(const [key,title,scale,min,max] of numbers){const label=node('label',title),input=node('input');input.type='number';input.min=min;input.max=max;input.step='any';input.value=settings[key]*scale;label.append(input);form.append(label);fields[key]=()=>Number(input.value)/scale}
  for(const [key,title] of [...(group?[['enabled','启用这个群的自主参与']]:[]),['fatigue','随精力减少主动参与'],['sleep','睡眠时停止普通唤醒']]){
    const label=node('label',undefined,'check'),input=node('input');input.type='checkbox';input.checked=settings[key];label.append(input,document.createTextNode(title));form.append(label);fields[key]=()=>input.checked
  }
  const save=node('button','保存设置');form.append(save)
  form.onsubmit=async event=>{event.preventDefault();save.disabled=true;try{await api('participation',{...(group?{group}:{}),settings:Object.fromEntries(Object.entries(fields).map(([key,get])=>[key,get()]))});save.textContent='已保存';$('error').hidden=true}catch(error){showError(error)}finally{save.disabled=false}}
  return form
}
async function refreshParticipation(){
  if($('participation').contains(document.activeElement)&&document.activeElement?.matches('input,select,button'))return
  await Promise.all([refreshQQControl(),refreshBlacklist()])
  const status=await api('participation')
  $('participation-settings').replaceChildren(node('h3','全局设置'),participationForm(status.settings))
  $('participation-groups').replaceChildren()
  for(const group of status.groups){
    const card=node('article',undefined,'panel'),summary=node('p',`${group.name} · ${group.group}`)
    summary.append(badge(group.effective_mode||group.settings.mode),badge(group.state));card.append(summary)
    card.append(node('p',`缓冲 ${group.pending.length} 条 · 有效概率 ${(group.probability*100).toFixed(2)}% · 最近发言占比 ${(group.stats.share*100).toFixed(0)}% · 上下文 ${group.usage===undefined?'接口未提供':(group.usage*100).toFixed(1)+'%'}`),
      node('p',`最近发言 ${time(group.lastSpoke)} · 冷却截止 ${time(group.cooldownUntil||undefined)} · 话题 ${group.topic||'未标记'}${group.effective_mode==='heart'&&group.settings.mode==='hybrid'?` · 心意续聊至 ${time(group.followupUntil)}`:''}`))
    const factors=group.factors;card.append(node('small',`批次 ${factors.batch.toFixed(3)} × 精力 ${factors.fatigue} × 占比 ${factors.share} × 昼夜 ${factors.time} × 话题 ${factors.engagement}`))
    const details=node('details');details.append(node('summary','这个群的设置'),participationForm(group.settings,group.group));card.append(details)
    const logs=node('details');logs.append(node('summary','最近参与记录'))
    for(const log of [...group.logs].reverse().slice(0,20))logs.append(node('p',`${time(log.at)} · ${labels[log.reason]||log.reason}${log.count===undefined?'':` · ${log.count}条`}${log.probability===undefined?'':` · ${(log.probability*100).toFixed(2)}%`}`))
    card.append(logs);$('participation-groups').append(card)
  }
}
function pageLabel(kind, count) { $(kind === 'messages' ? 'message-page' : kind === 'reports' ? 'report-page' : 'run-page').textContent = `第 ${offsets[kind] / 50 + 1} 页`; $(`prev-${kind}`).disabled = offsets[kind] === 0; $(`next-${kind}`).disabled = count < 50 }
async function refresh() {
  if (!principal) return
  if (loading) { queued = true; return }
  loading = true
  try {
    const state = await api('status'); $('role-name').textContent = state.role.name; roleName = state.role.name; $('chat-role-label').textContent = roleName
    if (view === 'dashboard') {
      $('metrics').replaceChildren()
      for (const [value, title] of [[state.enabled===false?'已暂停':state.current_run ? '运行中' : '空闲', 'Main Agent'], [state.running_subagents || 0, '执行中的 Subagent'], [state.events?.queued || 0, '排队事件'], [state.events?.processed || 0, '已处理事件']]) {
        const metric = node('div', undefined, 'metric'); metric.append(node('strong', value), node('span', title)); $('metrics').append(metric)
      }
      $('adapters').replaceChildren()
      for (const adapter of state.adapters || [{ platform: 'web', state: 'connected' }]) { const row = node('div', undefined, 'row'); row.append(node('span', adapter.platform === 'qq' ? `QQ / NapCat${adapter.receive_enabled === false ? '（仅发送）' : ''}` : adapter.platform === 'bilibili' ? 'Bilibili 评论' : 'Web 聊天'), badge(adapter.state)); $('adapters').append(row) }
      $('recent').replaceChildren(node('p', state.current_run ? `正在处理事件 ${state.current_run.event_id.slice(0, 12)}` : 'Main Agent 当前空闲。新事件到达时将自动唤醒。', 'muted'))
      $('errors').replaceChildren()
      if (!state.errors?.length) empty($('errors'), '当前没有需要处理的错误。已处理的历史问题保留在运行记录中。')
      for (const error of state.errors || []) {
        const card = node('div', undefined, 'timeline-item'); card.append(node('p', failureText(error.error || error.status), 'error'))
        if (error.at) card.append(node('small', time(error.at)))
        if (error.event_id && error.fingerprint) {
          const resolve = node('button', '标记已处理', 'secondary'); resolve.onclick = async () => {
            resolve.disabled = true
            try { await api(`events/${encodeURIComponent(error.event_id)}/resolve`, { fingerprint: error.fingerprint, note: '管理员已核对，本次问题已处理。' }); await refresh() }
            catch (failure) { showError(failure); resolve.disabled = false }
          }; card.append(resolve)
        }
        card.append(rawDetails(error)); $('errors').append(card)
      }
    } else if (view === 'models') {
      await refreshModels()
    } else if (view === 'about') {
      await refreshAbout()
    } else if (view === 'statistics') {
      await refreshStatistics()
    } else if (view === 'memes') {
      await refreshMemes()
    } else if (view === 'logs') {
      await refreshLogs()
    } else if (view === 'people') {
      await refreshPeople()
    } else if (view === 'participation') {
      await refreshParticipation()
    } else if (view === 'messages') {
      await refreshChat()
      if (state.collaboration?.active) $('chat-subtitle').textContent = `长程协作中 · ${state.collaboration.goal || '继续未完成的创作'} · 新消息仍可接入`
    } else if (view === 'tasks') {
      const [tasks, reports] = await Promise.all([api('tasks?limit=100'), api(`reports?limit=50&offset=${offsets.reports}&task=${encodeURIComponent($('report-task').value)}`)])
      const selected = $('report-task').value; $('report-task').replaceChildren(node('option', '全部任务')); $('report-task').firstChild.value = ''
      loadedTasks=tasks;renderTaskList()
      for (const task of tasks) {
        const option = node('option', task.description.slice(0, 35)); option.value = task.task_id; $('report-task').append(option)
      }
      if ([...$('report-task').options].some(o => o.value === selected)) $('report-task').value = selected
      $('report-list').replaceChildren(); if (!reports.length) empty($('report-list'), '任务的进度、发现和结果会保留在这里')
      for (const report of reports) $('report-list').append(reportCard(report))
      pageLabel('reports', reports.length)
    } else if (view === 'task-detail') {
      await refreshTaskDetail()
    } else if (view === 'memory') {
      await refreshMemory()
    } else if (view === 'runs') {
      const runs = await api(`runs?limit=50&offset=${offsets.runs}`); $('run-list').replaceChildren()
      if (!runs.length) empty($('run-list'), '尚无运行记录')
      for (const run of runs) { const card = node('article', undefined, 'timeline-item'); card.append(badge(run.state), node('time', time(run.started_at)), node('p', `事件 ${run.event_id}`), node('small', run.finished_at ? `结束于 ${time(run.finished_at)}` : '正在处理')); if (run.error) card.append(node('p', failureText(run.error), run.resolution ? 'muted' : 'error')); if (run.resolution) card.append(badge('resolved'), node('p', `${run.resolution.note} · ${time(run.resolution.at)}`, 'muted')); card.append(rawDetails(run)); $('run-list').append(card) }; pageLabel('runs', runs.length)
    }
  } catch (error) { showError(error) }
  finally {
    loading = false
    if (queued) { queued = false; scheduleRefresh() }
    else if (view === 'messages' && principal?.role === 'admin' && messageRows.some(row => ['queued','processing'].includes(row.state))) { clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, 1800) }
  }
}
function scheduleRefresh() { clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, 150) }
function setChatNavigation(open) {
  document.body.classList.toggle('chat-nav-open', open)
  for(const id of ['chat-nav-toggle','page-nav-toggle','task-nav-toggle']){
    $(id).setAttribute('aria-expanded', String(open))
    $(id).setAttribute('aria-label', open ? '关闭导航' : '打开导航')
  }
  $('nav-backdrop').hidden = !open
}
function selectView(next) { if(next==='models'&&view!=='models')delete $('model-settings').dataset.modelKey; setChatNavigation(false); view = next; document.body.classList.toggle('chat-mode', ['messages','task-detail'].includes(next)); document.body.classList.toggle('task-mode',next==='task-detail'); document.querySelectorAll('.view').forEach(n => { n.hidden = n.id !== view }); document.querySelectorAll('[data-view]').forEach(n => n.classList.toggle('selected', n.dataset.view === view || view === 'task-detail' && n.dataset.view === taskReturnView)); $('page-title').textContent = { dashboard: '总览', participation:'群聊参与', people:'人际关系', messages: '消息中心', tasks: '后台任务', memory: '记忆与自我', 'task-detail': 'Subagent 详情', runs: '运行记录', models:'模型设置', statistics:'用量统计', logs:'日志', memes:'表情图库', about:'关于' }[view]; $('breadcrumb').textContent = view.toUpperCase(); refresh() }
function enter(me) {
  principal = me; $('login').hidden = true; $('app').hidden = false; $('identity').textContent = `${me.user} · ${me.role === 'admin' ? '管理者' : '聊天用户'}`
  document.querySelectorAll('[data-admin]').forEach(n => { n.hidden = me.role !== 'admin' }); selectView('messages')
  stream?.close(); stream = new EventSource(`${apiBase}api/stream`); stream.addEventListener('change', scheduleRefresh); stream.addEventListener('ready', () => { $('stream-state').textContent = '● 实时同步'; $('chat-connection').textContent = '已连接' }); stream.onerror = () => { $('stream-state').textContent = '○ 正在重连'; $('chat-connection').textContent = '重新连接中' }
}
function bootConsoleAuth() {
  let challenge, enrolled
  const forms = ['auth-login-form','auth-enroll-form','auth-confirm-form','auth-recovery','login-form']
  const clearSecrets = () => { challenge = undefined; $('auth-qr').removeAttribute('src'); $('auth-secret').textContent = ''; $('auth-enroll-token').value = ''; $('auth-new-password').value = ''; $('auth-confirm-code').value = '' }
  function screen(id) {
    for (const key of forms) $(key).hidden = key !== id
    $('login-error').textContent = ''
    for (const [tab, target] of [['auth-tab-login','auth-login-form'],['auth-tab-enroll','auth-enroll-form'],['auth-tab-token','login-form']]) $(tab).classList.toggle('selected', target === id)
  }
  const run = async (form, callback) => { const controls = [...form.querySelectorAll('button')]; controls.forEach(button => button.disabled = true); try { await callback() } catch(error) { $('login-error').textContent = error.message } finally { controls.forEach(button => button.disabled = false) } }
  $('auth-transport-warning').hidden = location.protocol === 'https:' || document.body.classList.contains('embedded')
  $('auth-tab-login').onclick = () => { clearSecrets(); screen('auth-login-form') }
  $('auth-tab-enroll').onclick = () => { clearSecrets(); screen('auth-enroll-form') }
  $('auth-tab-token').onclick = () => { clearSecrets(); screen('login-form') }
  $('auth-cancel').onclick = () => { clearSecrets(); screen('auth-login-form') }
  $('auth-enroll-form').onsubmit = event => { event.preventDefault(); void run($('auth-enroll-form'), async () => {
    const result = await api('auth/enroll', { token: $('auth-enroll-token').value, password: $('auth-new-password').value })
    clearSecrets(); challenge = result.challenge; $('auth-user').value = result.user; $('auth-secret').textContent = result.secret
    if (typeof result.qr !== 'string' || !result.qr.startsWith('data:image/png;base64,')) throw new Error('二维码格式异常')
    $('auth-qr').src = result.qr; screen('auth-confirm-form'); $('auth-confirm-code').focus()
  }) }
  $('auth-confirm-form').onsubmit = event => { event.preventDefault(); void run($('auth-confirm-form'), async () => {
    const result = await api('auth/confirm', { challenge, code: $('auth-confirm-code').value })
    clearSecrets(); enrolled = { user: result.user, role: result.role }; $('auth-recovery-codes').textContent = result.recovery.join('\n')
    $('auth-saved').checked = false; $('auth-finish').disabled = true; screen('auth-recovery')
    document.querySelector('.auth-tabs').hidden = true
  }) }
  $('auth-saved').onchange = () => { $('auth-finish').disabled = !$('auth-saved').checked }
  $('auth-finish').onclick = () => { if (!$('auth-saved').checked || !enrolled) return; $('auth-recovery-codes').textContent = ''; document.querySelector('.auth-tabs').hidden = false; enter(enrolled); enrolled = undefined }
  const credentials = () => ({ user: $('auth-user').value.trim(), password: $('auth-password').value, code: $('auth-code').value.trim() })
  $('auth-login-form').onsubmit = event => { event.preventDefault(); void run($('auth-login-form'), async () => {
    const result = await api('auth/login', credentials()); $('auth-password').value = ''; $('auth-code').value = ''; enter(result)
  }) }
  $('auth-reset').onclick = () => { if (!confirm('将验证当前密码和动态码（或恢复码），撤销所有网页登录，并解除验证器绑定。之后需要原访问令牌重新绑定。继续吗？')) return; void run($('auth-login-form'), async () => {
    await api('auth/reset', credentials()); $('auth-password').value = ''; $('auth-code').value = ''; clearSecrets(); screen('auth-enroll-form'); $('login-error').textContent = '绑定已解除。请使用原访问令牌重新绑定。'
  }) }
}
function boot() {
  decorateChrome()
  bootConsoleAuth()
  $('login-form').onsubmit = async event => { event.preventDefault(); try { const me = await api('login', { token: $('token').value }); $('token').value = ''; enter(me) } catch (error) { $('login-error').textContent = error.message } }
  $('logout').onclick = async () => { await api('logout', {}); stream?.close(); location.reload() }
  $('people-search').onsubmit=event=>{event.preventDefault();peopleOffset=0;refreshPeople().catch(showError)}
  $('people-add').onsubmit=async event=>{event.preventDefault();try{await api('people',{tool:'people_get',args:{identity:stablePerson($('people-new').value)}});$('people-new').value='';await refreshPeople()}catch(error){showError(error)}}
  $('people-prev').onclick=()=>{peopleOffset=Math.max(0,peopleOffset-12);refreshPeople().catch(showError)}
  $('people-next').onclick=()=>{peopleOffset+=12;refreshPeople().catch(showError)}
  document.querySelectorAll('[data-view]').forEach(n => { n.onclick = () => selectView(n.dataset.view) })
  for (const kind of ['reports', 'runs']) for (const direction of ['prev', 'next']) $(`${direction}-${kind}`).onclick = () => { offsets[kind] = Math.max(0, offsets[kind] + (direction === 'next' ? 50 : -50)); refresh() }
  $('task-back').onclick = () => selectView(taskReturnView)
  $('task-search').oninput=$('task-state-filter').onchange=renderTaskList
  $('task-model-options').ontoggle=()=>{if($('task-model-options').open&&taskDetailRecord)refreshModels(taskDetailRecord).catch(showError)}
  $('task-tab-activity').onclick = () => setTaskTab('activity')
  $('task-tab-reports').onclick = () => setTaskTab('reports')
  setupStatisticsPages()
  setupMemes()
  $('task-more-activity').onclick = () => refresh()
  $('task-prev-reports').onclick = () => { taskReportOffset = Math.max(0, taskReportOffset - 50); refresh() }
  $('task-next-reports').onclick = () => { taskReportOffset += 50; refresh() }
  $('memory-filter').onsubmit = event => { event.preventDefault(); memoryOffset = 0; refresh() }
  $('memory-prev').onclick = () => { memoryOffset = Math.max(0, memoryOffset - 20); refresh() }
  $('memory-next').onclick = () => { memoryOffset += 20; refresh() }
  let dreamKey
  $('dreaming-trigger').onclick = async () => { const button = $('dreaming-trigger'); button.disabled = true; dreamKey ||= randomId(); try { const result = await api('dreaming', { idempotency_key: dreamKey }); button.textContent = result.job ? '已交给潜意识回顾' : '暂无新增经历'; dreamKey = undefined; refresh() } catch (error) { showError(error) } finally { button.disabled = false } }
  $('report-task').onchange = () => { offsets.reports = 0; refresh() }
  $('source').onchange = () => { $('conversation-filter').value = ''; changeChatFilter() }
  $('conversation-filter').onchange = changeChatFilter
  $('older-messages').onclick = loadOlderMessages
  for(const id of ['chat-nav-toggle','page-nav-toggle','task-nav-toggle'])$(id).onclick=()=>setChatNavigation(!document.body.classList.contains('chat-nav-open'))
  $('nav-backdrop').onclick = () => { setChatNavigation(false); $(view==='messages'?'chat-nav-toggle':view==='task-detail'?'task-nav-toggle':'page-nav-toggle').focus() }
  document.addEventListener('keydown', event => { if (event.key === 'Escape') { setChatNavigation(false); $('chat-options').hidden = true; $('chat-options-toggle').setAttribute('aria-expanded','false');if(view==='task-detail'&&$('task-session-info').open){$('task-session-info').open=false;$('task-session-info').querySelector('summary').focus()} } })
  document.addEventListener('click',event=>{if(view==='task-detail'&&$('task-session-info').open&&!$('task-session-info').contains(event.target))$('task-session-info').open=false})
  $('chat-options-toggle').onclick = () => { const open = $('chat-options').hidden; $('chat-options').hidden = !open; $('chat-options-toggle').setAttribute('aria-expanded', String(open)) }
  $('chat-show-internal').onchange = () => renderChat()
  $('chat-more-activity').onclick = async () => { await refreshChatActivity(true); if (view === 'messages') renderChat() }
  $('chat-form').onsubmit = async event => {
    event.preventDefault()
    const text = $('chat-input').value
    if (!text.trim() || sending) return
    const key = draftKey || randomId()
    draftKey = key; sending = true; updateComposer()
    try {
      await api('messages', { conversation: 'chat', content: text, idempotency_key: key })
      if ($('chat-input').value === text) { $('chat-input').value = ''; draftKey = undefined; resizeInput() }
      if ($('source').value || $('conversation-filter').value) { $('source').value = ''; $('conversation-filter').value = ''; messageRows = []; messageFilter = undefined }
      $('error').hidden = true; refresh()
    } catch (error) { showError(error) }
    finally { sending = false; updateComposer(); $('chat-input').focus() }
  }
  $('chat-input').oninput = () => { draftKey = undefined; resizeInput(); updateComposer() }
  $('chat-input').onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); $('chat-form').requestSubmit() } }
  api('me').then(enter).catch(() => {})
}
const scopeLabels = { main:'主 Agent', worker:'工具助手', continuation:'潜意识', topic:'话题助手', organizer:'话题整理', meme:'表情识图' }
const countText = value => Number(value || 0).toLocaleString('zh-CN', { maximumFractionDigits: 1 })
const ratioText = value => value == null ? '暂无样本' : `${(value * 100).toFixed(2)}%`
const amountText = (value, currency) => new Intl.NumberFormat('zh-CN',{style:'currency',currency,minimumFractionDigits:2,maximumFractionDigits:6}).format(value || 0)
const usageText = row => row.missing_usage && !row.total ? '用量未返回' : countText(row.total)+(row.missing_usage?' + 未知':'')
const usageCostText = row => row.missing_usage && !row.total ? '未知' : `${amountText(row.cny,'CNY')} / ${amountText(row.usd,'USD')}${row.unpriced||row.missing_usage?'（不完整）':''}`
const latencyText = value => value == null ? '暂无样本' : value < 1000 ? `${Math.round(value)} 毫秒` : value < 60000 ? `${(value/1000).toFixed(1)} 秒` : `${(value/60000).toFixed(2)} 分钟`
let statisticsData, statisticsLogRows=[], logsBefore, logsNext, logsHasMore=false, logsHistory=[]
const knownStatisticSessions=new Map()
function statisticsParams(prefix) {
  const params=new URLSearchParams()
  for(const edge of ['since','until'])if($(prefix+'-'+edge).value){const date=new Date($(prefix+'-'+edge).value+'T00:00:00+08:00');if(edge==='until')date.setTime(date.getTime()+86400000);params.set(edge,date.toISOString())}
  const scope=$(prefix+'-scope').value;if(scope!=='all')params.set('scope',scope)
  if(prefix==='statistics'&&$('statistics-session').value)params.set('session',$('statistics-session').value)
  return params
}
function statisticsTable(target, headers, rows) {
  target.replaceChildren();if(!rows.length){empty(target,'当前范围暂无记录');return}
  const scroll=node('div',undefined,'statistics-table-scroll'),table=node('table',undefined,'statistics-table'),head=node('thead'),heading=node('tr'),body=node('tbody')
  for(const text of headers){const th=node('th',text);th.scope='col';heading.append(th)}head.append(heading)
  for(const values of rows){const row=node('tr');for(const value of values){const cell=node('td');cell.append(value instanceof Node?value:document.createTextNode(String(value)));row.append(cell)}body.append(row)}
  table.append(head,body);scroll.append(table);target.append(scroll)
}
function statisticsMetric(label,value,hint) {
  const card=node('article',undefined,'metric statistics-metric');card.append(node('span',label),node('strong',value));if(hint)card.append(node('small',hint,'muted'));return card
}
async function refreshStatistics() {
  const data=await api('statistics?'+statisticsParams('statistics'));statisticsData=data
  const t=data.total,main=data.roles.find(row=>row.scope==='main'),a=data.daily_average,r=data.reply_latency,b=data.billing
  $('statistics-period').textContent=`${time(data.since)} 起 · ${data.days} 个北京时间自然日 · 更新于 ${time(data.as_of)}`
  $('statistics-metrics').replaceChildren(...[
    ['Token 总量',countText(t.total),`未缓存输入 ${countText(t.input)} · 缓存读 ${countText(t.read)} · 缓存写 ${countText(t.write)} · 输出 ${countText(t.output)}`],
    ['主 Agent Token',countText(main?.total),'含主会话上下文压缩请求'],['全部 Subagent Token',countText(data.subagents.total),'工具助手、潜意识、话题助手与后台整理'],
    ['日均 Token',countText(a.tokens),'包含零用量日'],['日均费用 / Go 额度',`${amountText(a.cny,'CNY')} / ${amountText(a.usd,'USD')}`,'人民币 API 等值用量 / Go 等值额度，分别计量'],
    ['平均缓存命中率',ratioText(t.average_cache_hit_rate),'每个有输入用量请求的命中率均值'],['整体缓存命中率',ratioText(t.cache_hit_rate),'缓存读取 ÷ 全部输入 Token，加权口径'],
    ['总激活次数（所选范围）',countText(data.activations.total),'Main Run 与分支原生激活轮次合计'],['日均激活（所选范围）',countText(data.activations.daily),'包含零激活日'],
    ['Main 总激活次数',data.activations.main==null?'—':countText(data.activations.main),'选定日期内的 Main Run，非模型调用步数'],['Main 日均激活',data.activations.main_daily==null?'—':countText(data.activations.main_daily),'激活次数 ÷ 所选自然日'],
    ['平均 Main 回话延迟',latencyText(r.average_ms),`${r.samples} 条已成功回复的消息 · 收到至首次发送成功`],['最高 Main 回话延迟',latencyText(r.maximum_ms),'同一消息仅计首条成功回复，含排队和发送耗时'],
    ['平均上下文填充时间',data.context_fill.average_minutes==null?'暂无完整周期':`${data.context_fill.average_minutes} 分钟`,`${data.context_fill.samples} 个完整周期 · 开始累计至压缩完成`],
    ['联网搜索次数',countText(data.reliability.web_searches),'已记录的搜索工具调用，重试分别计数'],['模型请求 / 工具调用',`${countText(t.requests)} / ${countText(data.reliability.tool_calls)}`,'模型请求与工具调用分别计数'],
    ['Main 失败 / 中断',countText(data.reliability.failed_runs),`已完成 ${countText(data.reliability.completed_runs)} 次`],
  ].map(values=>statisticsMetric(...values)))
  if(data.memory_health){
    const h=data.memory_health,m=data.memory_metrics||{}
    $('statistics-metrics').append(
      statisticsMetric('记忆索引',h.index.consistent?'一致':'需要检查',`${countText(h.index.indexed)} 条索引 / ${countText(h.index.originals)} 条原文`),
      statisticsMetric('待巩固历史',countText(h.dreaming_cursor_lag),'已归档且尚未提交回顾的原始记录'),
      statisticsMetric('记忆检索平均耗时',latencyText(m.search_average_ms),`${countText(m.searches)} 次工具检索`),
      statisticsMetric('附加上下文估算',`${countText(m.injected_tokens)} Token`,'所选范围内的社交上下文'),
      statisticsMetric('原生压缩尝试 / 失败',`${countText(m.compaction_attempts)} / ${countText(m.compaction_failures)}`,'沿用宿主事件，未设置额外压缩限额'),
      statisticsMetric('记忆健康告警',countText(h.alerts.length),h.alerts.map(alert=>alert.message).join('；')||'当前无活动告警'))
  }
  $('statistics-roles').replaceChildren()
  for(const role of data.roles){const row=node('div',undefined,'statistics-role'),bar=node('div',undefined,'statistics-bar'),fill=node('span');fill.style.width=`${t.total?role.total/t.total*100:0}%`;bar.append(fill);row.append(node('strong',scopeLabels[role.scope]||role.scope),bar,node('span',`${countText(role.total)} Token`));$('statistics-roles').append(row)}
  if(!data.roles.length)empty($('statistics-roles'),'暂无请求记录')
  const daily=new Map(data.daily.map(row=>[row.day,row])),chart=node('div',undefined,'statistics-trend-bars'),max=Math.max(1,...data.daily.map(row=>row.total)),end=new Date((($('statistics-until').value)||data.as_of.slice(0,10))+'T00:00:00+08:00')
  for(let i=13;i>=0;i--){const day=new Date(end.getTime()-i*86400000+8*3600000).toISOString().slice(0,10),entry=daily.get(day),column=node('div',undefined,'statistics-trend-column'),bar=node('span',undefined,'statistics-trend-bar');bar.style.height=`${(entry?.total||0)/max*100}%`;column.title=`${day}：${countText(entry?.total)} Token`;column.setAttribute('aria-label',column.title);column.append(bar,node('small',day.slice(5)));chart.append(column)}
  $('statistics-trend').replaceChildren(chart,node('p','无用量日显示为空柱；日期不改变统计范围。','muted'))
  $('statistics-windows').replaceChildren()
  for(const [index,window] of b.windows.entries()){
    const row=node('div',undefined,'statistics-window'),bar=node('progress');bar.max=1;bar.value=Math.min(1,window.used||0);bar.setAttribute('aria-label',`${['5 小时','7 天','30 天'][index]}使用率`)
    row.append(node('strong',`${['5 小时','7 天','30 天'][index]} · ${window.used==null?'请先选择套餐':ratioText(window.used)}`),bar,node('small',`平均 ${ratioText(window.average)} · ${window.observed_windows} 个观察窗口${window.unpriced_requests?` · ${window.unpriced_requests} 个请求缺价格`:''}`,'muted'));$('statistics-windows').append(row)
  }
  for(const session of data.sessions)knownStatisticSessions.set(session.session,session)
  const picker=$('statistics-session'),selected=picker.value
  picker.replaceChildren(new Option('全部会话',''),...[...knownStatisticSessions.values()].map(row=>new Option(`${scopeLabels[row.scope]||row.scope} · ${row.session.slice(-14)}`,row.session)));picker.value=selected
  const names=record=>`${scopeLabels[record.scope]||record.scope} · ${record.session.slice(-14)}`
  statisticsTable($('statistics-sessions'),['Agent','请求','输入 / 缓存读 / 缓存写','输出','Token 总量','命中率','估算费用 / Go 额度'],data.sessions.map(row=>{
    const label=row.task_id?taskLink(row.task_id,names(row)):node('span',names(row));return[label,countText(row.requests),`${countText(row.input)} / ${countText(row.read)} / ${countText(row.write)}`,countText(row.output),usageText(row),ratioText(row.cache_hit_rate),usageCostText(row)]
  }))
  statisticsTable($('statistics-models'),['提供方 / 模型','请求','Token','命中率','人民币等值','Go 等值额度'],data.models.map(row=>[row.model,countText(row.requests),countText(row.total),ratioText(row.cache_hit_rate),amountText(row.cny,'CNY'),`${amountText(row.usd,'USD')}${row.unpriced?'（未完整定价）':''}`]))
  const coverage=$('statistics-coverage');coverage.replaceChildren()
  coverage.append(node('p',`已记录 ${data.coverage.native_sessions} 个原生会话；${t.missing_usage} 个请求／压缩未返回用量，${t.unpriced} 个请求缺少价格。${t.unpriced||t.missing_usage?'费用与用量合计可能不完整。':'已排除 Fork 继承历史的重复计量。'}`,t.unpriced||t.missing_usage?'statistics-warning':'muted'))
  coverage.append(node('p',`已定价人民币等值用量 ${amountText(t.cny,'CNY')}；Go 等值额度 ${amountText(t.usd,'USD')}。${b.settings.usdCny?`按设置汇率折合 ${amountText(t.cny+t.usd*b.settings.usdCny,'CNY')}（估算）。`:''}`))
  if(b.go_subscription_monthly_usd!=null)coverage.append(node('p',`Go 订阅单价 ${amountText(b.go_subscription_monthly_usd,'USD')} / 月；本月日均分摊 ${amountText(b.go_subscription_daily_usd,'USD')} / 天。额度消耗不等于订阅外扣款。`))
  for(const note of data.coverage.notes)coverage.append(node('p',note,'muted'))
  const sources=node('p',`价格核对日期 ${b.pricing.as_of} · `,'muted');for(const [index,href] of b.pricing.sources.entries()){const link=node('a',index?'OpenCode Go 官方价格':'DeepSeek 官方价格');link.href=href;link.target='_blank';link.rel='noopener noreferrer';sources.append(link,document.createTextNode(' '))}coverage.append(sources)
  const settings=$('statistics-settings'),key=JSON.stringify(b.settings)
  if(settings.dataset.settingsKey!==key){settings.dataset.settingsKey=key;$('statistics-plan').value=b.settings.goPlan;$('statistics-exchange').value=b.settings.usdCny??'';$('statistics-retention').value=b.settings.logRetentionDays;$('statistics-holidays').value=b.settings.holidays.join('\n');$('statistics-provider-kinds').replaceChildren()
    for(const provider of new Set([...data.models.map(row=>row.provider),...Object.keys(b.settings.providerKinds)])){const label=node('label',provider),select=node('select');select.dataset.provider=provider;select.append(new Option('自动识别',''),new Option('DeepSeek 官方','deepseek'),new Option('OpenCode Go','opencode-go'),new Option('其他（不估价）','other'));select.value=b.settings.providerKinds[provider]||'';label.append(select);$('statistics-provider-kinds').append(label)}
  }
}
function downloadStatistics(value,name,jsonl=false){const blob=new Blob([jsonl?value.map(row=>JSON.stringify(row)).join('\n'):JSON.stringify(value,null,2)],{type:jsonl?'application/x-ndjson':'application/json'}),href=URL.createObjectURL(blob),link=node('a');link.href=href;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(href),1000)}
async function refreshLogs(){
  const params=statisticsParams('logs');for(const key of ['level','kind','search'])if($('logs-'+key).value)params.set(key,$('logs-'+key).value);if(logsBefore)params.set('before',logsBefore)
  const page=await api('logs?'+params);statisticsLogRows=page.items;logsNext=page.next_cursor;logsHasMore=page.has_more
  $('logs-summary').textContent=`本页 ${page.items.length} 条 · 保留 ${page.retention_days} 天 · 北京时间 · 早期状态快照已单独标记`
  $('logs-page-label').textContent=`第 ${logsHistory.length+1} 页`;$('logs-newer').disabled=!logsHistory.length;$('logs-older').disabled=!page.has_more
  const target=$('logs-list');target.setAttribute('role','log');target.setAttribute('aria-label','终端日志');target.replaceChildren();if(!page.items.length){empty(target,'当前筛选下没有日志');return}
  for(const entry of page.items){const row=node('article',undefined,'log-entry'),head=node('div',undefined,'log-entry-head'),level=node('span',`[${String(entry.level||'info').toUpperCase()}]`,`log-level log-${entry.level}`);head.append(node('time',time(entry.at)),level,node('span',scopeLabels[entry.scope]||entry.scope,'log-scope'),node('span',entry.summary,'log-line-message'));row.append(head)
    if(entry.data.error)row.append(node('p',entry.data.error,'error'))
    const meta=node('p',undefined,'muted');if(entry.provider||entry.model)meta.append(document.createTextNode(`${entry.provider||''} / ${entry.model||''} `));if(entry.data.historical)meta.append(node('span','历史状态快照 '));if(entry.task)meta.append(taskLink(entry.task,'查看关联任务'));if(meta.childNodes.length)row.append(meta)
    const details=node('details'),list=node('dl',undefined,'log-details');details.append(node('summary','详情'))
    for(const [label,value] of Object.entries({会话:entry.session,运行:entry.run,事件:entry.event,任务:entry.task,...entry.data})){if(value===null||value===undefined||value==='')continue;list.append(node('dt',label),node('dd',typeof value==='object'?JSON.stringify(value):String(value)))}details.append(list);row.append(details);target.append(row)
  }
}
function setupStatisticsPages(){
  $('statistics-filter').onsubmit=event=>{event.preventDefault();refresh()}
  $('statistics-reset').onclick=()=>{$('statistics-since').value='';$('statistics-until').value='';refresh()}
  $('statistics-export').onclick=()=>{if(statisticsData)downloadStatistics(statisticsData,'amphoreus-statistics.json')}
  $('statistics-settings').onsubmit=async event=>{event.preventDefault();const message=$('statistics-settings-message'),button=event.target.querySelector('button[type=submit],button:not([type])');button.disabled=true
    try{const providerKinds={};for(const select of $('statistics-provider-kinds').querySelectorAll('select'))if(select.value)providerKinds[select.dataset.provider]=select.value;await api('statistics/settings',{goPlan:$('statistics-plan').value,usdCny:$('statistics-exchange').value?Number($('statistics-exchange').value):null,logRetentionDays:Number($('statistics-retention').value),holidays:$('statistics-holidays').value.split(/\s+/).filter(Boolean),providerKinds});message.textContent='已保存';await refreshStatistics()}catch(error){message.textContent=error.message}finally{button.disabled=false}}
  $('logs-filter').onsubmit=event=>{event.preventDefault();logsBefore=undefined;logsHistory=[];refresh()}
  $('logs-latest').onclick=()=>{logsBefore=undefined;logsHistory=[];refresh()}
  $('logs-older').onclick=()=>{if(logsHasMore){logsHistory.push(logsBefore);logsBefore=logsNext;refresh()}}
  $('logs-newer').onclick=()=>{if(logsHistory.length){logsBefore=logsHistory.pop();refresh()}}
  $('logs-export').onclick=()=>downloadStatistics(statisticsLogRows,'amphoreus-logs.jsonl',true)
}

if ($('login-form')) boot()

let memesData,memesSignature='',memesOffset=0,memePickerOffset=0,memePickerItems=[],memePickerBusy=false,memePickerKey
function memePreview(item){const image=node('img');image.src=`${apiBase}api/memes/image/${item.id}`;image.alt=item.caption||item.tag||'表情';image.loading='lazy';return image}
async function memeOperation(input){const result=await api('memes/manage',input);if(result.ok===false)throw new Error(result.error||result.message||'操作失败');return result}
async function memeAction(button,action){button.disabled=true;try{const result=await action();$('memes-status').textContent=result?.message||'已保存';memesSignature='';await refreshMemes()}catch(error){$('memes-status').textContent=error.message;showError(error)}finally{button.disabled=false}}
async function memeFile(input,max=8*1024*1024){const file=input.files[0];if(!file)throw new Error('请先选择文件');if(file.size>max)throw new Error(`文件不能超过 ${max/1024/1024} MB`);const dataBase64=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(new Error('文件读取失败'));reader.readAsDataURL(file)});return{fileName:file.name,dataBase64}}
function renderMemeGrid(){
 const items=memesData?.items||[],target=$('memes-grid');target.replaceChildren()
 for(const item of items.slice(memesOffset,memesOffset+48)){
  const card=node('article',undefined,'meme-card');card.append(memePreview(item),node('p',item.caption||'未填写描述'),node('small',`${item.packName} · ${item.tag}`))
  const details=node('details'),form=node('form');details.append(node('summary','编辑'))
  const fields={};for(const [key,label]of[['tag','分类'],['caption','描述'],['keywords','关键词']]){const wrap=node('label',label),input=node('input');input.value=item[key]||'';input.maxLength=key==='tag'?40:200;if(key==='tag'){input.pattern='[a-z0-9_-]+';input.required=true}input.setAttribute('aria-label',label);wrap.append(input);form.append(wrap);fields[key]=input}
  const actions=node('div',undefined,'actions'),save=node('button','保存'),remove=node('button','删除','quiet');remove.type='button'
  form.onsubmit=event=>{event.preventDefault();memeAction(save,async()=>{await memeOperation({op:'setPack',packId:item.pack});return memeOperation({op:'update',id:item.id,...Object.fromEntries(Object.entries(fields).map(([key,input])=>[key,input.value]))})})}
  remove.onclick=()=>{if(confirm(`删除「${item.caption||item.tag}」？`))memeAction(remove,async()=>{await memeOperation({op:'setPack',packId:item.pack});return memeOperation({op:'delete',id:item.id})})}
  actions.append(save,remove);form.append(actions);details.append(form);card.append(details);target.append(card)
 }
 if(!items.length)empty(target,'暂无匹配的表情。可以上传原图，或导入已有图库。')
 $('memes-page-label').textContent=items.length?`${memesOffset+1}–${Math.min(items.length,memesOffset+48)} / ${items.length}`:'0 张';$('memes-prev').disabled=memesOffset===0;$('memes-next').disabled=memesOffset+48>=items.length
}
async function refreshMemes(){
 const params=new URLSearchParams({q:$('memes-query').value,tag:$('memes-tag').value,pack:$('memes-pack').value}),data=await api('memes?'+params),signature=JSON.stringify([params.toString(),data]);if(signature===memesSignature)return
 // Incoming chat activity must not discard an editor's unsaved metadata.
 if($('memes-grid').contains(document.activeElement))return
 memesData=data;memesSignature=signature;const selected=$('memes-pack').value;$('memes-pack').replaceChildren(new Option('全部图库',''),...data.packs.map(pack=>new Option(pack.name,pack.id)));$('memes-pack').value=selected
 const settings=data.settings||{};if(!$('memes').contains(document.activeElement)||!document.activeElement.id?.startsWith('memes-')){$('memes-mode').value=settings.sendMode||'auto';$('memes-prompt').checked=settings.promptEnabled!==false;$('memes-chance-enabled').checked=!!settings.sendChanceEnabled;$('memes-chance').value=settings.sendChance??30}
 const packs=$('memes-packs');packs.replaceChildren()
 for(const pack of data.packs){
  const row=node('div',undefined,'meme-pack'),toggle=node('input'),label=node('label',undefined,'check'),actions=node('div',undefined,'actions');toggle.type='checkbox';toggle.checked=pack.enabled;toggle.setAttribute('aria-label',`启用${pack.name}`);toggle.onchange=()=>memeAction(toggle,()=>memeOperation({op:'setPackEnabled',packId:pack.id,enabled:toggle.checked}));label.append(toggle,node('span',`${pack.name} · ${pack.count} 张`));row.append(label)
  const select=node('button',settings.packId===pack.id?'当前收藏库':'用于收藏','quiet');select.disabled=settings.packId===pack.id;select.onclick=()=>memeAction(select,()=>memeOperation({op:'setPack',packId:pack.id}));actions.append(select)
  const download=node('a','导出 ZIP','quiet');download.href=`${apiBase}api/memes/export?packId=${encodeURIComponent(pack.id)}`;download.download=`${pack.id}.zip`;actions.append(download)
  if(settings.remoteSubs?.some(sub=>sub.id===pack.id)){const update=node('button','更新','quiet');update.onclick=()=>memeAction(update,async()=>{const job=await memeOperation({op:'updateRemotePack',id:pack.id});watchMemeJob(job);return job});actions.append(update)}
  if(pack.id!=='dsh-meme-user'){const remove=node('button','删除图库','quiet');remove.onclick=()=>{if(confirm(`删除整个「${pack.name}」图库及其图片？`))memeAction(remove,()=>memeOperation({op:'deleteMemePack',packId:pack.id}))};actions.append(remove)}
  row.append(actions);packs.append(row)
 }
 if(memesOffset>=data.items.length)memesOffset=0;renderMemeGrid()
}
async function watchMemeJob(job){
 $('memes-job').textContent=job.message||'任务已开始';if(job.state!=='running'||!job.id)return
 const timer=setInterval(async()=>{try{const update=await memeOperation({op:'remoteJobStatus',jobId:job.id});$('memes-job').textContent=update.message||update.state;if(update.state!=='running'){clearInterval(timer);memesSignature='';await refreshMemes()}}catch(error){clearInterval(timer);$('memes-job').textContent=error.message}},2000)
}
async function loadMemePicker(){memePickerOffset=0;const data=await api('memes?'+new URLSearchParams({q:$('meme-picker-query').value}));const enabled=new Set(data.packs.filter(pack=>pack.enabled).map(pack=>pack.id));memePickerItems=data.items.filter(item=>enabled.has(item.pack));$('meme-picker-grid').replaceChildren();appendMemePicker()}
function appendMemePicker(){const target=$('meme-picker-grid');for(const item of memePickerItems.slice(memePickerOffset,memePickerOffset+48)){const button=node('button',undefined,'meme-card');button.type='button';button.setAttribute('aria-label',item.caption||item.tag);button.append(memePreview(item));button.onclick=async()=>{if(memePickerBusy)return;memePickerBusy=true;button.disabled=true;memePickerKey||={id:item.id,key:randomId()};if(memePickerKey.id!==item.id)memePickerKey={id:item.id,key:randomId()};try{await api('memes/message',{id:item.id,idempotency_key:memePickerKey.key});memePickerKey=undefined;$('meme-picker').close();await refresh()}catch(error){$('meme-picker-status').textContent=error.message}finally{memePickerBusy=false;button.disabled=false}};target.append(button)}memePickerOffset+=48;$('meme-picker-more').hidden=memePickerOffset>=memePickerItems.length;if(!memePickerItems.length)empty(target,'没有匹配的可用表情。')}
function setupMemes(){
 $('memes-filter').onsubmit=event=>{event.preventDefault();memesOffset=0;memesSignature='';refreshMemes().catch(showError)}
 $('memes-reload').onclick=()=>{memesSignature='';refreshMemes().catch(showError)}
 $('memes-prev').onclick=()=>{memesOffset=Math.max(0,memesOffset-48);renderMemeGrid()};$('memes-next').onclick=()=>{memesOffset+=48;renderMemeGrid()}
 $('memes-upload').onsubmit=event=>{event.preventDefault();memeAction(event.submitter||$('memes-upload').querySelector('button:last-child'),async()=>memeOperation({op:'upload',...await memeFile($('memes-file')),tag:$('memes-upload-tag').value,caption:$('memes-caption').value,keywords:$('memes-keywords').value}))}
 $('memes-recognize').onclick=()=>memeAction($('memes-recognize'),async()=>{const result=await memeOperation({op:'recognize',...await memeFile($('memes-file'))});$('memes-upload-tag').value=result.tag;$('memes-caption').value=result.caption||'';$('memes-keywords').value=result.keywords||'';return{message:'识别完成，确认后点「收藏原图」。'}})
 $('memes-create').onsubmit=event=>{event.preventDefault();memeAction(event.submitter,()=>memeOperation({op:'createMemePack',id:$('memes-new-id').value,name:$('memes-new-name').value}))}
 $('memes-import').onsubmit=event=>{event.preventDefault();memeAction(event.submitter,async()=>memeOperation({op:'importMemePack',name:`import-${Date.now().toString(36)}`,...await memeFile($('memes-zip'),22*1024*1024)}))}
 $('memes-scan').onclick=()=>memeAction($('memes-scan'),()=>memeOperation({op:'scanPack'}))
 $('memes-save-preferences').onclick=()=>{const mode=$('memes-mode').value,prompt=$('memes-prompt').checked,enabled=$('memes-chance-enabled').checked,chance=Number($('memes-chance').value);memeAction($('memes-save-preferences'),async()=>{await memeOperation({op:'setSendMode',sendMode:mode});await memeOperation({op:'setPromptEnabled',enabled:prompt});return memeOperation({op:'setSendChance',enabled,chance})})}
 $('memes-install').onsubmit=event=>{event.preventDefault();memeAction(event.submitter,async()=>{const archive=$('memes-remote-type').value==='archive',job=await memeOperation(archive?{op:'installRemoteArchive',archiveUrl:$('memes-remote-url').value}:{op:'subscribeRemote',manifestUrl:$('memes-remote-url').value});watchMemeJob(job);return job})}
 $('memes-market-load').onclick=()=>memeAction($('memes-market-load'),async()=>{const data=await api('memes/remote');$('memes-market').replaceChildren();if(!data.remoteDir)throw new Error(data.remoteDirError||'市场目录暂时不可用');for(const entry of data.remoteDir){const row=node('div',undefined,'row'),choose=node('button','选择','quiet');row.append(node('span',`${entry.name||entry.id}${entry.description?' · '+entry.description:''}`));choose.onclick=()=>{const archive=entry.archiveUrl||entry.archive?.url;$('memes-remote-type').value=archive?'archive':'manifest';$('memes-remote-url').value=archive||entry.manifestUrl||entry.url||''};row.append(choose);$('memes-market').append(row)}return{message:'目录已加载，选中资源后可安装。'}})
 $('chat-memes').onclick=async()=>{$('meme-picker-status').textContent='';$('meme-picker').showModal();try{await loadMemePicker()}catch(error){$('meme-picker-status').textContent=error.message}}
 $('meme-picker-close').onclick=()=>$('meme-picker').close();$('meme-picker-search').onsubmit=event=>{event.preventDefault();loadMemePicker().catch(error=>{$('meme-picker-status').textContent=error.message})};$('meme-picker-more').onclick=appendMemePicker
}
