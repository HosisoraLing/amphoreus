#!/usr/bin/env node
/** Explicit operator test: one real private message via the production Gateway/QQ adapter, no model or incoming message. */
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Store } from '../src/app/store.ts'
import { AmphoreusStore } from '../src/amphoreus/store.ts'
import { MessageGateway } from '../src/amphoreus/gateway.ts'
import { QQAdapter } from '../src/amphoreus/qq.ts'
import { readConfiguration } from '../src/amphoreus/config.ts'

const [configFile, userId, evidenceDirectory] = process.argv.slice(2)
if (!configFile || !/^\d+$/.test(userId ?? '') || !evidenceDirectory) {
  console.error('Usage: node --experimental-transform-types scripts/amphoreus-qq-smoke.mjs CONFIG USER_ID EVIDENCE_DIRECTORY')
  process.exit(2)
}
const config = readConfiguration(configFile)
assert(config.qq, 'QQ is not configured')
assert(config.qq.enabled && !config.qq.observeOnly && !config.qq.receiveEnabled, 'Enable an outbound-only QQ connection first')
assert(config.qq.allowedUsers.includes(userId), 'Test recipient must be explicitly allowlisted')
const directory = resolve(evidenceDirectory)
mkdirSync(directory, { recursive: true, mode: 0o700 })
// Separate evidence database: never open the running service database or start its recovery/scheduler.
const host = new Store(join(directory, 'send.sqlite'))
const store = new AmphoreusStore(host)
const gateway = new MessageGateway(store)
const adapter = new QQAdapter({ role: config.role, gateway, onChange() {} }, config.qq)
try {
  adapter.start()
  const deadline = Date.now() + 30000
  while (adapter.status().state !== 'connected') {
    assert(Date.now() < deadline, `NapCat connection timed out (${adapter.status().state})`)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  const target = { platform: 'qq', account_id: config.qq.accountId, conversation_id: `private:${userId}` }
  const prior = store.outputs(1)[0]
  const text = prior?.content[0]?.text ?? `【翁法罗斯真实 NapCat 发送测试】统一 speak 出口验收。${new Date().toISOString()}`
  const input = { agentId: config.role.agent_id, runId: 'operator-qq-smoke', callId: 'send', target, content: [{ type: 'text', text }] }
  const authorized = candidate => candidate.platform === target.platform && candidate.account_id === target.account_id && candidate.conversation_id === target.conversation_id
  const output = await gateway.speak(input, authorized)
  assert.equal(output.status, 'sent', `Send outcome: ${output.status}; inspect before retrying`)
  const receipt = store.record('receipt', output.output_id)
  assert(receipt?.message_id, 'NapCat did not return a message ID')
  const message = await adapter.request('get_msg', { message_id: receipt.message_id })
  assert.equal(String(message.sender?.user_id), config.qq.accountId, 'Readback sender mismatch')
  assert.equal(message.message_type, 'private', 'Readback is not a private message')
  // NapCat get_msg omits target_id; confirm the same message is in the requested friend's history.
  const history = await adapter.request('get_friend_msg_history', { user_id: userId, count: 20 })
  assert(history.messages?.some(item => String(item.message_id) === String(receipt.message_id)), 'Message not found in recipient history')
  if (message.target_id !== undefined) assert.equal(String(message.target_id), userId, 'Readback recipient mismatch')
  assert(Array.isArray(message.message), 'Readback must contain structured segments')
  assert.equal(message.message.filter(segment => segment.type === 'text').map(segment => segment.data.text).join(''), text, 'Readback text mismatch')
  // Retry the same call only after a known success: Gateway must return its stored receipt without sending again.
  assert.equal((await gateway.speak(input, authorized)).output_id, output.output_id)
  assert.equal(store.outputs().length, 1)
  const evidence = { checked_at: new Date().toISOString(), transport: 'real NapCat OneBot v11 WS',
    path: 'MessageGateway.speak -> QQAdapter -> send_private_msg -> get_msg + get_friend_msg_history',
    scope: 'operator send test; no Main inference or real incoming-message validation',
    status: output.status, message_id: String(receipt.message_id), output_id: output.output_id,
    sender_suffix: config.qq.accountId.slice(-4), recipient_suffix: userId.slice(-4),
    exact_text_match: true, sender_match: true, recipient_match: true, idempotent_replay: true,
    receive_enabled: adapter.status().receive_enabled }
  writeFileSync(join(directory, 'receipt.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 })
  console.log(JSON.stringify(evidence))
} finally { await adapter.stop(); host.close() }
