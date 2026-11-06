import { afterEach, expect, it, vi } from 'vitest'
const start = vi.hoisted(() => vi.fn(async () => () => Promise.resolve()))
vi.mock('../src/amphoreus/start.ts', () => ({ startAmphoreus: start }))
import { apply, Config } from '../src/index.ts'
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks() })
it('starts only the character runtime, using the configured private file or environment fallback', async () => {
  vi.stubEnv('AMPHOREUS_CONFIG', '/private/env.json')
  const ctx = { effect: vi.fn() }
  await apply(ctx as never, Config({ stateDir: '/state' }))
  expect(start).toHaveBeenLastCalledWith(ctx, '/state', '/private/env.json')
  await apply(ctx as never, Config({ stateDir: '/state', configPath: '/private/config.json' }))
  expect(start).toHaveBeenLastCalledWith(ctx, '/state', '/private/config.json')
  expect(ctx.effect).toHaveBeenCalledTimes(2)
})
it('reports a missing private configuration without starting another application', async () => {
  vi.stubEnv('AMPHOREUS_CONFIG', '')
  await expect(apply({} as never, Config({ stateDir: '/state' }))).rejects.toThrow('configPath')
  expect(start).not.toHaveBeenCalled()
})
