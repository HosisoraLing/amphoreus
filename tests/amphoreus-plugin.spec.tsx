import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, expect, it, vi } from 'vitest'
import { apply } from '../src/client/index.tsx'

afterEach(() => vi.unstubAllGlobals())

it('registers only the Amphoreus panel without probing or loading the retired UI', async () => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
  const registrations: { options: any; component: any }[] = []
  const ctx = { effect: (effect: () => unknown) => effect(),
    slots: { inject: (_name: string, effect: () => unknown) => effect(), register: (options: any, component: any) => { registrations.push({ options, component }); return () => {} } } }
  await apply(ctx as never)
  expect(fetch).not.toHaveBeenCalled()
  expect(registrations).toHaveLength(2)
  const sidebar = registrations.find(item => item.options.name === 'sidebar.panellist')!
  const main = registrations.find(item => item.options.name === 'main')!
  expect(sidebar.options.id).toBe('amphoreus')
  expect(main.options.key).toBe(sidebar.options.id)
  expect(sidebar.options.label()).toBe('翁法罗斯')
  const rendered = renderToStaticMarkup(main.component({}))
  expect(rendered).toContain('src="/amphoreus/"')
  expect(rendered).not.toContain('token=')
})
