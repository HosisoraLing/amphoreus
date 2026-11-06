/** OpenCode Go needs a per-request session header; keep this compatibility inside the bundle. */
import { AsyncLocalStorage } from 'node:async_hooks'

type Profile = { baseURL?: string; headers?: Record<string, string> }
type Adapter = {
  profileOf(...args: unknown[]): Profile
  stream(options: { sessionId?: string }): AsyncIterable<unknown>
}
const patched = Symbol.for('dsh.ocgo-session.patched')

export function patchSessionHeaders(proto: Adapter): () => void {
  const state = proto as Adapter & { [patched]?: boolean }
  if (state[patched]) return () => {}
  const sessions = new AsyncLocalStorage<string>()
  const { profileOf, stream } = proto
  const profileWithSession: Adapter['profileOf'] = function (this: Adapter, ...args) {
    const profile = profileOf.apply(this, args), sessionId = sessions.getStore()
    let host = ''
    try { host = new URL(profile.baseURL ?? '').hostname } catch { /* Non-URL providers are unchanged. */ }
    return sessionId && host === 'opencode.ai'
      ? { ...profile, headers: { ...profile.headers, 'x-opencode-session': sessionId } } : profile
  }
  const streamWithSession: Adapter['stream'] = function (this: Adapter, options) {
    const iterable = stream.call(this, options), sessionId = options.sessionId
    if (!sessionId) return iterable
    return {
      [Symbol.asyncIterator]() {
        const inner = iterable[Symbol.asyncIterator]()
        return {
          next: (...args: [] | [unknown]) => sessions.run(sessionId, () => inner.next(...args)),
          return: (value?: unknown) => sessions.run(sessionId, () => inner.return ? inner.return(value) : Promise.resolve({ done: true, value })),
          throw: (error?: unknown) => sessions.run(sessionId, () => inner.throw ? inner.throw(error) : Promise.reject(error)),
        }
      },
    }
  }
  proto.profileOf = profileWithSession; proto.stream = streamWithSession; state[patched] = true
  return () => {
    if (proto.profileOf === profileWithSession) proto.profileOf = profileOf
    if (proto.stream === streamWithSession) proto.stream = stream
    delete state[patched]
  }
}

export async function installSessionHeaders(): Promise<{ restore: () => void; enabled: boolean }> {
  // This adapter belongs to the host. Other model backends do not need it installed.
  const moduleName = '@deepseek-ai/dsh-llm-pi-ai'
  let adapter: { PiAiAdapter: { prototype: Adapter } }
  try { adapter = await import(moduleName) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND') return { restore: () => {}, enabled: false }
    throw error
  }
  return { restore: patchSessionHeaders(adapter.PiAiAdapter.prototype), enabled: true }
}
