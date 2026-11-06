import { expect, it } from 'vitest'
import { patchSessionHeaders } from '../src/amphoreus/opencode-session.ts'

it('isolates concurrent model session headers, preserves other hosts and restores the adapter', async () => {
  class Adapter {
    profileOf(provider: unknown) { return { baseURL: String(provider), headers: { existing: 'keep' } } }
    async *stream(options: { sessionId?: string; provider?: string }) {
      await Promise.resolve()
      yield this.profileOf(options.provider)
      await Promise.resolve()
      yield this.profileOf(options.provider)
    }
  }
  const original = { profileOf: Adapter.prototype.profileOf, stream: Adapter.prototype.stream }
  const restore = patchSessionHeaders(Adapter.prototype)
  const collect = async (sessionId: string, provider = 'https://opencode.ai/inference/go/openai/v1') => {
    const values = []
    for await (const value of new Adapter().stream({ sessionId, provider })) values.push(value)
    return values
  }
  const [a, b, other] = await Promise.all([collect('a'), collect('b'), collect('c', 'https://opencode.ai.example.org/v1')])
  expect(a.map(value => value.headers)).toEqual(Array(2).fill({ existing: 'keep', 'x-opencode-session': 'a' }))
  expect(b.map(value => value.headers)).toEqual(Array(2).fill({ existing: 'keep', 'x-opencode-session': 'b' }))
  expect(other.map(value => value.headers)).toEqual(Array(2).fill({ existing: 'keep' }))
  expect(new Adapter().profileOf('https://opencode.ai').headers).toEqual({ existing: 'keep' })
  restore()
  expect(Adapter.prototype.profileOf).toBe(original.profileOf)
  expect(Adapter.prototype.stream).toBe(original.stream)
})
