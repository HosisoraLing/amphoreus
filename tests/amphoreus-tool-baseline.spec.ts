import { expect, it } from 'vitest'
import { Session, type SessionId } from '@deepseek-ai/dsh-session'
import { resetForkToolBaseline } from '../src/amphoreus/tool-baseline.ts'

it('logs a fresh tool baseline when a native Fork removes all original capabilities, retaining history', () => {
  const session = Session.create('child' as SessionId)
  const old = { name: 'speak', description: 'external', parameters: { type: 'object' } }
  const current = { name: 'memory_find', description: 'read memory', parameters: { type: 'object' } }
  session.append('turn/start', { turn: 1 })
  session.append('request/header', { header: { config: { provider: 'provider', model: 'model' }, tools: [old] }, reason: 'initial' })
  const before = session.snapshotEvents()
  resetForkToolBaseline(session, [current])
  expect(session.toolHistory().tools).toEqual([current])
  expect(session.snapshotEvents().slice(0, before.length)).toEqual(before)
  expect(session.snapshotEvents().at(-1)).toMatchObject({ type: 'request/header', data: { reason: 'series', header: { tools: [current] } } })
  resetForkToolBaseline(session, [current])
  expect(session.snapshotEvents()).toHaveLength(before.length + 1)
})
