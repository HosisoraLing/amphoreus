/** Standalone password + TOTP identities, scoped to pre-authorized console users. */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import type { AmphoreusStore } from './store.ts'
const derive = promisify(scrypt)
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
export function base32(bytes: Buffer): string {
  let bits = 0, value = 0, out = ''
  for (const byte of bytes) { value = (value << 8) | byte; bits += 8; while (bits >= 5) { bits -= 5; out += alphabet[(value >>> bits) & 31] } }
  if (bits) out += alphabet[(value << (5 - bits)) & 31]
  return out
}
function unbase32(secret: string): Buffer {
  let bits = 0, value = 0; const out: number[] = []
  for (const char of secret) { const n = alphabet.indexOf(char); if (n < 0) throw new Error('Invalid secret'); value = (value << 5) | n; bits += 5; if (bits >= 8) { bits -= 8; out.push((value >>> bits) & 255) } }
  return Buffer.from(out)
}
export function totp(secret: string, counter: number): string {
  const bytes = Buffer.alloc(8); bytes.writeBigUInt64BE(BigInt(counter))
  const digest = createHmac('sha1', unbase32(secret)).update(bytes).digest(), offset = digest[digest.length - 1]! & 15
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, '0')
}
const equal = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y) }
function counterFor(secret: string, code: string, now: number, last = -1): number | undefined {
  if (!/^\d{6}$/.test(code)) return
  const current = Math.floor(now / 30000)
  // Check all accepted counters, do not short-circuit secret comparisons.
  let match: number | undefined
  for (const delta of [-1, 0, 1]) { const count = current + delta; if (count >= 0 && equal(totp(secret, count), code) && count > last) match = count }
  return match
}
type Credential = { version: 1; user: string; role: string; salt: string; password: string; secret: string; lastCounter: number; recovery: string[] }
type Identity = { token: string; user: string; role: 'admin' | 'chat' }
type Pending = { user: string; role: string; token: string; secret: string; password: string; salt: string; expires: number; failures: number }
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
/** No public signup: an existing, strong console access token must authorize enrollment. */
export class ConsoleAuth {
  private readonly pending = new Map<string, Pending>()
  private activeHashes = 0
  constructor(private readonly store: AmphoreusStore, private readonly identities: Identity[], private readonly agentId: string, private readonly now = () => Date.now()) {}
  private key(user: string) { return JSON.stringify([this.agentId, user]) }
  private read(user: string) { return this.store.record<Credential>('console-auth', this.key(user)) }
  private save(value: Credential) { this.store.setRecord('console-auth', this.key(value.user), value) }
  enrolled(user: string): boolean { return !!this.read(user) }
  private identity(user: string) { const values = this.identities.filter(identity => identity.user === user); return values.length === 1 ? values[0] : undefined }
  private async password(value: string, salt: string) {
    if (this.activeHashes >= 4) throw new Error('Authentication busy')
    this.activeHashes++
    try { return (await derive(value, salt, 64) as Buffer).toString('hex') }
    finally { this.activeHashes-- }
  }
  private encrypt(secret: string, token: string, user: string): string {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(token).digest(), iv)
    cipher.setAAD(Buffer.from(this.key(user)))
    const value = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()])
    return Buffer.concat([iv, cipher.getAuthTag(), value]).toString('base64')
  }
  private decrypt(secret: string, token: string, user: string): string {
    const bytes = Buffer.from(secret, 'base64'), cipher = createDecipheriv('aes-256-gcm', createHash('sha256').update(token).digest(), bytes.subarray(0, 12))
    cipher.setAAD(Buffer.from(this.key(user))); cipher.setAuthTag(bytes.subarray(12, 28))
    return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8')
  }
  async begin(token: string, password: string, issuer: string) {
    for (const [key, value] of this.pending) if (value.expires <= this.now()) this.pending.delete(key)
    if (this.pending.size >= 100) return
    const identity = this.identities.find(value => equal(value.token, token))
    if (!identity || this.identity(identity.user) !== identity || this.enrolled(identity.user)) return
    const salt = randomBytes(16).toString('hex'), derived = await this.password(password, salt)
    if (this.enrolled(identity.user)) return
    for (const [key, value] of this.pending) if (value.user === identity.user) this.pending.delete(key)
    const id = randomBytes(32).toString('hex'), secret = base32(randomBytes(20))
    this.pending.set(id, { user: identity.user, role: identity.role, token, secret, salt, password: derived, expires: this.now() + 300000, failures: 0 })
    const uri = `otpauth://totp/${encodeURIComponent(`${issuer}:${identity.user}`)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`
    return { challenge: id, secret, uri, user: identity.user }
  }
  confirm(challenge: string, code: string) {
    const pending = this.pending.get(challenge)
    if (!pending || pending.expires <= this.now() || pending.failures >= 5 || this.enrolled(pending.user)) { this.pending.delete(challenge); return }
    pending.failures++
    const count = counterFor(pending.secret, code, this.now())
    if (count === undefined) return
    const recovery = Array.from({ length: 10 }, () => randomBytes(10).toString('hex'))
    this.save({ version: 1, user: pending.user, role: pending.role, salt: pending.salt, password: pending.password,
      secret: this.encrypt(pending.secret, pending.token, pending.user), lastCounter: count, recovery: recovery.map(value => hash(value)) })
    this.pending.delete(challenge)
    return { user: pending.user, role: pending.role as Identity['role'], recovery }
  }
  async login(user: string, password: string, code: string, reset = false) {
    const identity = this.identity(user), initial = this.read(user)
    const derived = await this.password(password, initial?.salt || 'unavailable-account-salt')
    if (!identity || !initial || !equal(initial.password, derived)) return
    // Re-read after async scrypt so concurrent OTP/recovery submissions cannot reuse a factor.
    const record = this.read(user)
    if (!record || record.password !== derived || record.role !== identity.role) return
    const recoveryCode = code.replaceAll('-', '').replaceAll(' ', '').toLowerCase()
    if (/^[a-f0-9]{20}$/.test(recoveryCode)) {
      const index = record.recovery.findIndex(value => equal(value, hash(recoveryCode)))
      if (index < 0) return
      record.recovery.splice(index, 1); this.save(record)
      if (reset) this.store.setRecord('console-auth', this.key(user), null)
      return { user, role: identity.role, recovered: true }
    }
    let secret: string
    try { secret = this.decrypt(record.secret, identity.token, user) } catch { return }
    const count = counterFor(secret, code, this.now(), record.lastCounter)
    if (count === undefined) return
    record.lastCounter = count; this.save(record)
    if (reset) this.store.setRecord('console-auth', this.key(user), null)
    return { user, role: identity.role, recovered: false }
  }
  /** Rebinding requires a recent password + unused TOTP/recovery proof, never a stolen browser cookie alone. */
  async reset(user: string, password: string, code: string) {
    const proof = await this.login(user, password, code, true)
    if (!proof) return
    for (const [key, value] of this.pending) if (value.user === user) this.pending.delete(key)
    return proof
  }
}
