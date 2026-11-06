import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { expect, it } from 'vitest'

it('browses sourced memory, follows its adopted result and requests Main review without confirming in the browser', async () => {
  const dom = new JSDOM(readFileSync(new URL('../src/amphoreus/console.html', import.meta.url), 'utf8'), { url: 'http://localhost/amphoreus/', runScripts: 'outside-only' })
  const w = dom.window as any, posts: string[] = []
  const record = { id: 'idea', title: '星光构思', text: '由潜意识提出的想法', excerpt: '由潜意识提出的想法', kind: 'insight', status: 'adopted', importance: .95, created_at: '2026-11-03T08:00:00Z', source: { branch: 'continuation', task_id: 'fork-task' }, data: { revisions: ['decision'] }, total_chars: 12, next_offset: null, related: [{ id: 'formal', kind: 'diary', title: '今天', status: 'confirmed' }] }
  w.EventSource = class { addEventListener() {} close() {} }
  w.fetch = async (path: string, input: { method?: string } = {}) => {
    const url = new URL(path, w.location.href); let data: unknown
    if (input.method === 'POST') { posts.push(url.pathname); data = { status: 'queued' } }
    else if (url.pathname.endsWith('/me')) data = { user: 'owner', role: 'admin' }
    else if (url.pathname.endsWith('/status')) data = { role: { name: '测试角色' } }
    else if (url.pathname.endsWith('/topic-organizer')) data={settings:{enabled:false,intervalMs:60000,batchSize:12},running:false,last_job:null}
    else if (url.pathname.endsWith('/topics')) data={items:[]}
    else if (url.pathname.endsWith('/memory/stats')) data = { counts: [], distribution: [], policy: { reasoning: { retentionDays: 7 } }, current_self: null }
    else if (url.pathname.endsWith('/dreaming')) data = { enabled: true, at: '23:00', time_zone: 'Asia/Hong_Kong', jobs: [] }
    else if (url.pathname.endsWith('/memory')) data = [record]
    else if (url.pathname.endsWith('/memory/idea')) data = record
    else if (url.pathname.endsWith('/memory/formal')) data = { ...record, id: 'formal', title: '今天', kind: 'diary', related: [] }
    else throw new Error(`Unexpected ${path}`)
    return { ok: true, json: async () => data }
  }
  w.eval(readFileSync(new URL('../src/amphoreus/console.js', import.meta.url), 'utf8') + '\nwindow.cleanup = () => clearTimeout(refreshTimer);')
  const wait = async (check: () => boolean) => { for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)) }; throw new Error('Memory UI did not settle') }
  try {
    await wait(() => !w.document.getElementById('app').hidden)
    w.document.querySelector('[data-view="memory"]').click()
    await wait(() => w.document.getElementById('memory-list').textContent.includes('星光构思'))
    w.document.querySelector('#memory-list button').click()
    await wait(() => w.document.getElementById('memory-detail').textContent.includes('后续讨论'))
    expect(w.document.getElementById('memory-detail').textContent).toContain('潜意识')
    const resultLink = [...w.document.querySelectorAll('#memory-detail button')].find((b: any) => b.textContent.includes('正式日记')) as any
    resultLink.click(); await wait(() => w.document.querySelector('#memory-detail h2').textContent === '今天')
    w.document.querySelector('#memory-detail form').requestSubmit()
    await wait(() => posts.length === 1)
    expect(posts).toEqual(['/amphoreus/api/memory/formal/review'])
  } finally { w.cleanup(); dom.window.close() }
})
