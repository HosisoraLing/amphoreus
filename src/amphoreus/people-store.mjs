/** Migrated from the role-owned @local/dsh-people store; original SQLite schema is retained. */
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

export function parseIdentity(ref) {
  if (typeof ref !== 'string' || ref.length > 600 || /[\x00-\x20\x7f]/.test(ref)) throw new Error('identity 必须是稳定账号标识');
  const [platform, ...parts] = ref.split(':');
  if (!/^[a-z][a-z0-9-]*$/.test(platform)) throw new Error('无效 platform');
  if (platform === 'qq') {
    if (parts.length !== 1 || !/^[1-9]\d{4,19}$/.test(parts[0])) throw new Error('QQ 身份只能使用 QQ 号：qq:12345');
    return { ref, platform, namespace: '', externalId: parts[0] };
  }
  const namespace = parts.shift(), externalId = parts.join(':');
  if (!namespace || !externalId) throw new Error('其他平台使用 platform:namespace:稳定账号ID；飞书 namespace 为 appId');
  return { ref, platform, namespace, externalId };
}

export function sourceIdentity(identity) {
  if (!identity || typeof identity !== 'object') throw new Error('缺少结构化来源身份');
  const { channel, speakerId, accountId, conversationId, conversationType } = identity;
  if (typeof speakerId !== 'string' || !speakerId.startsWith(`${channel}:`) || !accountId || !conversationId || !['group', 'private'].includes(conversationType)) throw new Error('来源身份不完整');
  const id = speakerId.slice(channel.length + 1);
  const ref = channel === 'qq' ? `qq:${id}` : `${channel === 'lark' ? 'feishu' : channel}:${accountId}:${id}`;
  parseIdentity(ref);
  return { ref, displayName: String(identity.speakerName || '').slice(0, 128), group: conversationType === 'group',
    conversation: JSON.stringify([channel, String(accountId), conversationType, String(conversationId)]),
    messageId: String(identity.platformMessageId || '') };
}

export class PeopleStore {
  constructor(file) {
    if (file !== ':memory:') { mkdirSync(dirname(file), { recursive: true, mode: 0o700 }); }
    this.db = new DatabaseSync(file);
    if (file !== ':memory:') chmodSync(file, 0o600);
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS people(id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS identities(
        ref TEXT PRIMARY KEY, platform TEXT NOT NULL, namespace TEXT NOT NULL, external_id TEXT NOT NULL,
        person_id TEXT NOT NULL REFERENCES people(id), display_name TEXT NOT NULL DEFAULT '',
        first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, UNIQUE(platform,namespace,external_id));
      CREATE TABLE IF NOT EXISTS impressions(
        id TEXT PRIMARY KEY, subject_ref TEXT NOT NULL REFERENCES identities(ref), key TEXT NOT NULL,
        body TEXT NOT NULL, kind TEXT NOT NULL, certainty TEXT NOT NULL, visibility TEXT NOT NULL,
        evidence TEXT NOT NULL, origin_ref TEXT REFERENCES identities(ref), conversation TEXT NOT NULL,
        session_id TEXT NOT NULL, message_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(subject_ref,key));
      CREATE INDEX IF NOT EXISTS identities_person ON identities(person_id);
      CREATE TABLE IF NOT EXISTS contacts(
        person_id TEXT NOT NULL REFERENCES people(id), channel TEXT NOT NULL, address TEXT NOT NULL,
        label TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY(person_id,channel,address));
      CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, action TEXT NOT NULL, actor TEXT NOT NULL,
        details TEXT NOT NULL, created_at TEXT NOT NULL);
      PRAGMA user_version=1;`);
  }
  close() { this.db.close(); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const out = fn(); this.db.exec('COMMIT'); return out; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  audit(action, actor, details) {
    this.db.prepare('INSERT INTO audit(action,actor,details,created_at) VALUES(?,?,?,?)').run(action, actor, JSON.stringify(details), new Date().toISOString());
  }
  identity(ref) { parseIdentity(ref); return this.db.prepare('SELECT * FROM identities WHERE ref=?').get(ref); }
  encounter(ref, displayName = '') {
    const parsed = parseIdentity(ref), old = this.identity(ref), now = new Date().toISOString();
    const name = String(displayName).slice(0, 128);
    if (old) {
      // Keep last_seen coarse to avoid writing every group message to disk.
      if ((name && name !== old.display_name) || Date.parse(now) - Date.parse(old.last_seen) > 3600000) {
        this.db.prepare('UPDATE identities SET display_name=?,last_seen=? WHERE ref=?').run(name || old.display_name, now, ref);
      }
      return this.identity(ref);
    }
    return this.transaction(() => {
      const personId = randomUUID();
      this.db.prepare('INSERT INTO people VALUES(?,?)').run(personId, now);
      this.db.prepare('INSERT INTO identities VALUES(?,?,?,?,?,?,?,?)').run(ref, parsed.platform, parsed.namespace, parsed.externalId, personId, name, now, now);
      return this.identity(ref);
    });
  }
  samePerson(a, b) { return !!a && !!b && this.identity(a)?.person_id === this.identity(b)?.person_id && !!this.identity(a); }
  profile(ref, actor) {
    const identity = this.identity(ref);
    if (!identity) return null;
    const accounts = this.db.prepare('SELECT ref,display_name,last_seen FROM identities WHERE person_id=? ORDER BY ref').all(identity.person_id);
    const notes = this.db.prepare(`SELECT n.* FROM impressions n JOIN identities i ON i.ref=n.subject_ref
      WHERE i.person_id=? ORDER BY n.updated_at DESC`).all(identity.person_id);
    const contacts = this.db.prepare('SELECT channel,address,label,updated_at FROM contacts WHERE person_id=? ORDER BY channel,address').all(identity.person_id);
    return { person_id: identity.person_id, identity: ref, display_name: identity.display_name,
      accounts, impressions: notes, contacts };
  }
  list(query = '', offset = 0, limit = 50) {
    const args = [`%${String(query).slice(0, 128)}%`, `%${String(query).slice(0, 128)}%`];
    const where = 'WHERE ref LIKE ? OR display_name LIKE ?';
    const total = this.db.prepare(`SELECT count(DISTINCT person_id) n FROM identities ${where}`).get(...args).n;
    const rows = this.db.prepare(`SELECT person_id,min(ref) ref FROM identities ${where} GROUP BY person_id ORDER BY ref LIMIT ? OFFSET ?`).all(...args, limit, offset);
    return { total, offset, people: rows.map(row => this.profile(row.ref, { admin: true })) };
  }
  note(ref, args, actor) {
    if (!this.identity(ref)) throw new Error('账号尚未登记，先 people_get 明确的稳定账号');
    const key = String(args.key || '').trim();
    if (!key || key.length > 100) throw new Error('key 必填，最多100字，用同一个 key 更新旧印象');
    const old = this.db.prepare('SELECT * FROM impressions WHERE subject_ref=? AND key=?').get(ref, key);
    return this.transaction(() => {
      if (args.action === 'delete') {
        this.db.prepare('DELETE FROM impressions WHERE subject_ref=? AND key=?').run(ref, key);
        this.audit('note.delete', actor.ref || 'web-admin', { ref, key });
        return { deleted: !!old, key };
      }
      const body = String(args.body || '').trim(), evidence = String(args.evidence || '').trim();
      const visibility = args.visibility || (actor.group || actor.admin ? 'public' : 'private');
      const kind = args.kind || 'impression', certainty = args.certainty || 'inferred';
      if (!body || body.length > 2000 || !evidence || evidence.length > 1000) throw new Error('body(1–2000字)及 evidence(1–1000字)必填');
      if (!['public', 'private'].includes(visibility) || !['fact', 'preference', 'impression', 'boundary'].includes(kind) || !['observed', 'reported', 'inferred'].includes(certainty)) throw new Error('无效类别、确定性或可见性');
      const now = new Date().toISOString(), id = old?.id || randomUUID();
      this.db.prepare(`INSERT INTO impressions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(subject_ref,key) DO UPDATE SET
        body=excluded.body,kind=excluded.kind,certainty=excluded.certainty,visibility=excluded.visibility,
        evidence=excluded.evidence,origin_ref=excluded.origin_ref,conversation=excluded.conversation,
        session_id=excluded.session_id,message_id=excluded.message_id,updated_at=excluded.updated_at`).run(
          id, ref, key, body, kind, certainty, visibility, evidence, actor.ref || null, actor.conversation || '',
          actor.sessionId || '', actor.messageId || '', old?.created_at || now, now);
      this.audit(old ? 'note.update' : 'note.add', actor.ref || 'web-admin', { ref, key, id, visibility });
      return { id, key, visibility };
    });
  }
  contact(ref, args, actor) {
    const identity = this.identity(ref);
    if (!identity) throw new Error('账号尚未登记，先 people_get 明确的稳定账号');
    const channel = String(args.channel || 'email').toLowerCase();
    if (channel !== 'email') throw new Error('目前只支持 email 这一种联系方式');
    const action = args.action || 'list';
    if (action === 'list' || (!args.address && action !== 'delete')) {
      const rows = this.db.prepare('SELECT channel,address,label,updated_at FROM contacts WHERE person_id=? ORDER BY channel,address').all(identity.person_id);
      return { identity: ref, contacts: rows };
    }
    const address = String(args.address || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(address) || address.length > 254) throw new Error('address 不是合法邮箱');
    const label = String(args.label || '').slice(0, 60);
    const now = new Date().toISOString();
    return this.transaction(() => {
      if (action === 'delete') {
        const info = this.db.prepare('DELETE FROM contacts WHERE person_id=? AND channel=? AND address=?').run(identity.person_id, channel, address);
        this.audit('contact.delete', actor.ref || 'web-admin', { ref, channel, address });
        return { deleted: info.changes > 0, channel, address };
      }
      if (action !== 'set') throw new Error('action 为 set | delete | list');
      this.db.prepare(`INSERT INTO contacts VALUES(?,?,?,?,?,?) ON CONFLICT(person_id,channel,address) DO UPDATE SET
        label=excluded.label,updated_at=excluded.updated_at`).run(identity.person_id, channel, address, label, now, now);
      this.audit('contact.set', actor.ref || 'web-admin', { ref, channel, address });
      return { identity: ref, channel, address, label };
    });
  }
  link(from, to, actor, reason) {
    if (!actor.owner) throw new Error('只有拥有者可关联账号');
    if (!String(reason || '').trim() || reason.length > 500) throw new Error('必须记录关联依据 reason，最多500字');
    const a = this.identity(from), b = to ? this.identity(to) : null;
    if (!a || (to && !b)) throw new Error('先 people_get 登记两端稳定账号');
    return this.transaction(() => {
      if (to) {
        if (a.person_id !== b.person_id) this.db.prepare(`INSERT OR IGNORE INTO contacts(person_id,channel,address,label,created_at,updated_at)
          SELECT ?,channel,address,label,created_at,updated_at FROM contacts WHERE person_id=?`).run(b.person_id,a.person_id);
        this.db.prepare('UPDATE identities SET person_id=? WHERE person_id=?').run(b.person_id, a.person_id);
      } else {
        const id = randomUUID();
        this.db.prepare('INSERT INTO people VALUES(?,?)').run(id, new Date().toISOString());
        this.db.prepare('UPDATE identities SET person_id=? WHERE ref=?').run(id, from);
      }
      this.audit(to ? 'identity.link' : 'identity.unlink', actor.ref || 'web-admin', { from, to: to || null, reason, previous_person: a.person_id });
      return { identity: from, person_id: this.identity(from).person_id, linked_to: to || null };
    });
  }
}
