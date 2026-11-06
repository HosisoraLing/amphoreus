import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { expect, it } from 'vitest'

it('edits role and single-task routes, offers supported efforts and preserves unsaved choices on live refresh', async () => {
  const dom = new JSDOM(readFileSync(new URL('../src/amphoreus/console.html', import.meta.url), 'utf8'), { url: 'http://localhost/console/', runScripts: 'outside-only' }), w = dom.window as any, posts: any[] = []
  const defaults = { provider: 'host', model: 'default' }, state: any = { roles: Object.fromEntries(['main','worker','continuation','topic'].map(scope => [scope, { selection: null, effective: defaults }])), catalog: { groups: [{ id: 'api', name: '<img src=x>', models: [{ id: 'thinking', name: '推理模型', reasoning: { efforts: [{ id: 'high', name: '高' }] } }, { id: 'fast', name: '快速模型' }] }], failures: [] } }
  w.fetch = async (path: string, input: any = {}) => {
    if (input.method === 'POST') {
      const body = JSON.parse(input.body); posts.push(body)
      if (body.task_id) state.task = { task_id: body.task_id, scope: body.scope, selection: body.selection, effective: body.selection ?? state.roles[body.scope].effective }
      else state.roles[body.scope] = { selection: body.selection, effective: body.selection ?? defaults }
    }
    if (path.includes('task_id=task-1')) state.task ??= { task_id: 'task-1', scope: 'worker', selection: null, effective: defaults }
    return { ok: true, json: async () => state }
  }
  const script = readFileSync(new URL('../src/amphoreus/console.js', import.meta.url), 'utf8').replace("if ($('login-form')) boot()", '')
  w.eval(script + "\nprincipal={role:'admin',user:'owner'};selectedTaskId='task-1';window.models=refreshModels;")
  try {
    await w.models(); const d = w.document
    expect(d.querySelectorAll('#model-settings form')).toHaveLength(4)
    expect(d.querySelector('#model-settings img')).toBeNull()
    const form = d.querySelector('[data-model-scope=main]'), route = form.querySelector('select'), effort = form.querySelectorAll('select')[1]
    route.value = JSON.stringify(['api','thinking']); route.onchange(); effort.value = 'high'
    await w.models()
    expect(form.isConnected).toBe(true); expect(route.value).toContain('thinking')
    await form.onsubmit({ preventDefault() {} })
    expect(posts[0]).toEqual({ scope: 'main', selection: { provider: 'api', model: 'thinking', reasoningEffort: 'high' } })
    route.value = JSON.stringify(['api','fast']); route.onchange()
    expect(effort.disabled).toBe(true)
    await form.onsubmit({ preventDefault() {} })
    expect(posts[1].selection).toEqual({ provider: 'api', model: 'fast' })
    await w.models({ task_id: 'task-1', kind: 'worker' })
    const taskForm = d.querySelector('#task-model-settings form'), taskRoute = taskForm.querySelector('select')
    taskRoute.value = JSON.stringify(['api','fast']); taskRoute.onchange(); await taskForm.onsubmit({ preventDefault() {} })
    expect(posts[2]).toEqual({ scope: 'worker', task_id: 'task-1', selection: { provider: 'api', model: 'fast' } })
    taskRoute.value = ''; taskRoute.onchange(); await taskForm.onsubmit({ preventDefault() {} })
    expect(posts[3]).toEqual({ scope: 'worker', task_id: 'task-1', selection: null })
  } finally { dom.window.close() }
})
