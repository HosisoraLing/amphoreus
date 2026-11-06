import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import { normalizeEvent } from '../src/amphoreus/model.ts'
import { AmphoreusStore } from '../src/amphoreus/store.ts'
import { MessageGateway } from '../src/amphoreus/gateway.ts'
import { EventScheduler } from '../src/amphoreus/scheduler.ts'

let directory = ''
afterEach(() => { if (directory) rmSync(directory, { recursive: true, force: true }); directory = '' })
const open = () => {
  directory = mkdtempSync(join(tmpdir(), 'amphoreus-'))
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  return { store, gateway: new AmphoreusStore(store) }
}
const message = (idempotency_key = 'qq:bot:group:message-1') => normalizeEvent({
  agent_id: 'agent-1', source_kind: 'napcat', platform: 'qq', account_id: 'bot', conversation_id: 'group:9', actor_id: 'user:3',
  event_type: 'message', timestamp: '2026-11-03T00:00:00Z', correlation_id: null,
  content: [{ type: 'text', text: 'hello' }, { type: 'image', url: 'https://example.test/a.png' }, { type: 'mention', actor_id: 'bot' }],
  metadata: { group_name: 'example' }, visibility: 'private', idempotency_key,
}, new Date('2026-11-03T00:01:00Z'))

it('normalizes and deduplicates structured gateway events without flattening content blocks', () => {
  const { store, gateway } = open()
  const event = message()
  expect(event.event_id).toBe(message().event_id)
  expect(event.content.map(block => block.type)).toEqual(['text', 'image', 'mention'])
  expect(gateway.insertEvent(event)).toBe(true)
  expect(gateway.insertEvent(message())).toBe(false)
  expect(gateway.events({ agentId: 'agent-1' })[0]).toMatchObject({ event, state: 'queued' })
  store.close()
})

it('claims queued events once and recovers an interrupted claim after reopening SQLite', () => {
  const { store, gateway } = open()
  const event = message()
  gateway.insertEvent(event)
  expect(gateway.claimEvent('agent-1')?.event_id).toBe(event.event_id)
  expect(gateway.claimEvent('agent-1')).toBeUndefined()
  store.close()

  const reopened = new Store(join(directory, 'orchestrator.sqlite'))
  const restored = new AmphoreusStore(reopened)
  expect(restored.event(event.event_id)?.state).toBe('queued')
  restored.setEventState(event.event_id, 'processed')
  expect(restored.event(event.event_id)?.state).toBe('processed')
  reopened.close()
})

it('orders durable tasks by priority and retains reports across restart', () => {
  const { store, gateway } = open()
  const base = { agent_id: 'agent-1', subagent_id: 'subagent-1', description: 'inspect', context: [], created_at: '2026-11-03T00:00:00Z', updated_at: '2026-11-03T00:00:00Z' }
  gateway.enqueueTask({ ...base, task_id: 'low', priority: 0, state: 'queued' })
  gateway.enqueueTask({ ...base, task_id: 'high', priority: 2, state: 'queued' })
  expect(gateway.claimTask()?.task_id).toBe('high')
  const report = { report_id: 'report-1', task_id: 'high', agent_id: 'agent-1', subagent_id: 'subagent-1', type: 'discovery' as const,
    summary: 'found it', progress: 50, priority: 1, created_at: '2026-11-03T00:02:00Z', event_id: 'event-report-1' }
  expect(gateway.insertReport(report)).toBe(true)
  expect(gateway.insertReport(report)).toBe(false)
  store.close()

  const reopened = new Store(join(directory, 'orchestrator.sqlite'))
  expect(new AmphoreusStore(reopened).reports('high')).toEqual([report])
  reopened.close()
})

it('routes registered adapters, checks output authorization, and does not repeat an uncertain send', async () => {
  const { store, gateway: storage } = open()
  const gateway = new MessageGateway(storage, () => new Date('2026-11-03T00:10:00Z'))
  const unregister = gateway.registerInput({ kind: 'napcat', platform: 'qq', normalize: raw => ({
    agent_id: 'agent-1', source_kind: 'napcat', platform: 'qq', account_id: 'bot', conversation_id: 'group:9', actor_id: 'user:3',
    event_type: 'message', timestamp: '2026-11-03T00:00:00Z', correlation_id: null, content: [{ type: 'text', text: 'hello' }],
    metadata: {}, visibility: 'private', idempotency_key: String((raw as { id: string }).id),
  }) })
  const ingested = await gateway.ingest('napcat', { id: 'qq:1' })
  expect(ingested.inserted).toBe(true)
  expect((await gateway.ingest('napcat', { id: 'qq:1' })).inserted).toBe(false)

  const send = vi.fn(async () => 'unknown' as const)
  gateway.registerOutput({ platform: 'qq', send })
  const input = { agentId: 'agent-1', runId: 'run-1', callId: 'call-1', target: { platform: 'qq', account_id: 'bot', conversation_id: 'group:9' },
    content: [{ type: 'text', text: 'reply' }] }
  expect((await gateway.speak(input, () => true)).status).toBe('unknown')
  expect((await gateway.speak(input, () => true)).status).toBe('unknown')
  expect(send).toHaveBeenCalledTimes(1)
  await expect(gateway.speak({ ...input, callId: 'call-2' }, () => false)).rejects.toThrow('not authorized')
  expect(storage.outputs()).toHaveLength(1)
  unregister()
  store.close()
})

it('keeps Main Agent deliveries serial per role while other roles continue', async () => {
  const { store, gateway } = open()
  const first = { ...message('event-1'), event_id: 'event-1' }
  const second = { ...message('event-2'), event_id: 'event-2' }
  const other = { ...message('event-other'), event_id: 'event-other', agent_id: 'agent-2' }
  for (const event of [first, second, other]) gateway.insertEvent(event)
  let release!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  const started: string[] = []
  let active = 0, maximum = 0
  const scheduler = new EventScheduler(gateway, async event => {
    started.push(event.event_id)
    active++; maximum = Math.max(maximum, active)
    if (event.event_id === first.event_id) await blocked
    active--
  })
  scheduler.wake('agent-1')
  expect(started).toEqual(['event-1'])
  scheduler.wake('agent-2')
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(started).toEqual(['event-1', 'event-other'])
  release()
  await scheduler.idle()
  expect(started).toEqual(['event-1', 'event-other', 'event-2'])
  expect(maximum).toBe(2)
  expect(gateway.events({ state: 'processed' })).toHaveLength(3)
  scheduler.stop()
  store.close()
})
