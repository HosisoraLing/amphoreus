import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, expect, it, vi } from 'vitest'
import { apply } from '../src/client/index.tsx'

afterEach(() => vi.unstubAllGlobals())

it.each([true, false])('registers the native sidebar and main panel for Amphoreus mode %s', async enabled => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: enabled, json: async () => ({ mode: 'amphoreus' }) })))
  const registrations: { options: any; component: any }[] = []
  const ctx = { effect: (effect: () => unknown) => effect(), locale: { register: () => () => {}, bind: () => (key: string) => key },
    slots: { inject: (_name: string, effect: () => unknown) => effect(), register: (options: any, component: any) => { registrations.push({ options, component }); return () => {} } } }
  await apply(ctx as never)
  const sidebar = registrations.find(item => item.options.name === 'sidebar.panellist')!
  const main = registrations.find(item => item.options.name === 'main')!
  expect(sidebar.options.id).toBe(enabled ? 'amphoreus' : 'dsh-amphoreus')
  expect(main.options.key).toBe(sidebar.options.id)
  if (enabled) {
    expect(sidebar.options.label()).toBe('翁法罗斯')
    const rendered = renderToStaticMarkup(main.component({ t: (key: string) => key }))
    expect(rendered).toContain('src="/amphoreus/"')
    expect(rendered).toContain('title="翁法罗斯管理"')
    expect(rendered).not.toContain('token=')
  }
})
