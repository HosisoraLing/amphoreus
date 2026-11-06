import type { GatewayEvent } from './model.ts'
import type { AmphoreusStore } from './store.ts'

/** Serializes event delivery per role while allowing different roles to proceed independently. */
export class EventScheduler {
  private readonly active = new Map<string, Promise<void>>()
  private readonly requested = new Set<string>()
  private readonly steering = new Map<string, Promise<void>>()
  private stopped = false

  constructor(private readonly store: AmphoreusStore, private readonly deliver: (event: GatewayEvent) => Promise<void>,
    private readonly onError: (event: GatewayEvent, error: unknown) => void = () => {}, private readonly signal?: AbortSignal,
    private readonly steer?: (event: GatewayEvent) => Promise<boolean>) {
    signal?.addEventListener('abort', () => { this.stopped = true }, { once: true })
  }

  /** Starts draining recovered events after Main Agent sessions are available. */
  start(): void { for (const agentId of this.store.pendingEventAgents()) this.wake(agentId) }

  /** Requests a durable queue drain and returns without waiting for any Main Agent model turn. */
  wake(agentId: string): void {
    if (this.stopped) return
    this.requested.add(agentId)
    if (this.active.has(agentId)) { this.startSteering(agentId); return }
    const work = this.drain(agentId)
    this.active.set(agentId, work)
    void work.finally(() => {
      this.active.delete(agentId)
      if (!this.stopped && (this.requested.has(agentId) || this.store.pendingEventAgents().includes(agentId))) this.wake(agentId)
    })
  }

  /** Explicit retry for one failed event; output events remain outside the Main Agent queue. */
  retry(eventId: string): void {
    const stored = this.store.event(eventId)
    if (!stored) throw new Error(`Event not found: ${eventId}`)
    if (stored.state !== 'failed') throw new Error(`Only failed events can be retried: ${stored.state}`)
    this.store.setEventState(eventId, 'queued')
    this.wake(stored.event.agent_id)
  }

  async idle(): Promise<void> {
    while (this.active.size || this.steering.size) await Promise.allSettled([...this.active.values(), ...this.steering.values()])
  }

  stop(): void { this.stopped = true }

  private startSteering(agentId: string): void {
    if (!this.steer || this.steering.has(agentId)) return
    const work = (async () => {
      while (!this.stopped) {
        const event = this.store.claimEvent(agentId)
        if (!event) return
        try {
          if (await this.steer!(event)) continue
          this.store.setEventState(event.event_id, 'queued'); return
        } catch (error) {
          this.store.setEventState(event.event_id, 'failed', error instanceof Error ? error.message : String(error)); this.onError(event, error)
        }
      }
    })()
    this.steering.set(agentId, work)
    void work.finally(() => this.steering.delete(agentId))
  }

  private async drain(agentId: string): Promise<void> {
    while (!this.stopped) {
      this.requested.delete(agentId)
      const event = this.store.claimEvent(agentId)
      if (!event) return
      try {
        await this.deliver(event)
        await this.steering.get(agentId)
        if (!this.stopped) this.store.setEventState(event.event_id, 'processed')
      } catch (error) {
        if (this.signal?.aborted) return
        this.store.setEventState(event.event_id, 'failed', error instanceof Error ? error.message : String(error))
        this.onError(event, error)
      }
    }
  }
}
