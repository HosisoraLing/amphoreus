import { vi, type Mock } from 'vitest'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
type JobOwner = { status: string; followup(message: UserMessage): unknown; inject(message: UserMessage): unknown }
const notice = (id: string, text: string) => ({ id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'tool-jobs', form: 'notice' } }) as unknown as UserMessage
export function jobRegistry(owner: (sessionId: string) => JobOwner | undefined = () => undefined) {
  type Job = { id: string; owner: string; status: string; label?: string }
  const jobs = new Map<string, Job>()
  const listeners = new Set<{ owner: string; listener: (event: { type: string }) => void }>()
  const waits = new Map<string, ((job: Job) => void)[]>()
  let released = 0
  const emit = (job: Job, type: string) => { for (const listener of [...listeners]) if (listener.owner === job.owner) listener.listener({ type }) }
  const end = (id: string, status = 'completed') => {
    const job = jobs.get(id)!
    job.status = status
    const waiting = waits.get(id) ?? []
    waits.delete(id); released += waiting.length
    for (const wake of waiting) wake({ ...job })
    emit(job, 'settled')
    const agent = waiting.length ? undefined : owner(job.owner)
    const ended = notice(`notice-${id}`, `Job ${id} ended: ${status}`)
    if (agent?.status === 'idle') agent.followup(ended)
    else agent?.inject(ended)
  }
  const service = {
    list: vi.fn((caller: string) => [...jobs.values()].filter(job => job.owner === caller)),
    // A wait ends with the job, or fails once its signal aborts, which leaves the job's end uncollected.
    wait: vi.fn((id: string, _timeoutMs: number, _caller: string, signal?: AbortSignal) => new Promise<Job>((resolve, reject) => {
      const wake = (job: Job) => { signal?.removeEventListener('abort', abort); resolve(job) }
      const abort = () => { waits.set(id, (waits.get(id) ?? []).filter(item => item !== wake)); reject(new Error('wait aborted')) }
      waits.set(id, [...waits.get(id) ?? [], wake])
      signal?.addEventListener('abort', abort, { once: true })
    })),
    // A killed job ends a moment later, as its process does, also under a test's fake timers.
    kill: vi.fn((id: string) => { queueMicrotask(() => { end(id, 'killed') }); return 'requested' }) as Mock<(id: string) => string>,
    events: { subscribe: (filter: { owner: string }, listener: (event: { type: string }) => void) => {
      const entry = { owner: filter.owner, listener }
      listeners.add(entry)
      return () => { listeners.delete(entry) }
    } },
  }
  return { service, end, output: (id: string) => { emit(jobs.get(id)!, 'output') }, get released() { return released },
    run: (owner: string, label?: string) => { const id = `bash-${jobs.size + 1}`; jobs.set(id, { id, owner, status: 'running', label }); return id } }
}

