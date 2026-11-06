import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import { AmphoreusStore } from '../src/amphoreus/store.ts'
import { MemoryStore } from '../src/amphoreus/memory.ts'
import { TaskLifecycle } from '../src/amphoreus/lifecycle.ts'
import type { SubagentTask } from '../src/amphoreus/model.ts'

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'amphoreus-lifecycle-')), host = new Store(join(dir, 'db.sqlite')), store = new AmphoreusStore(host), memory = new MemoryStore(host, 'role')
  const workspace = join(dir, 'work'), root = join(dir, 'sessions'), archived: string[] = [], snapshots = new Map<string, any>(), workspaces = new Map<string, any>(), busy = new Set<string>()
  const mainId = `amphoreus-main-${createHash('sha256').update('role').digest('hex').slice(0,24)}`
  const log = (id: string) => join(root, 'group', id, 'session.v4.jsonl.zstd')
  const native = (id: string, cwd: string, realWork = true) => {
    mkdirSync(join(root, 'group', id), { recursive: true }); writeFileSync(log(id), 'native-log'); mkdirSync(cwd, { recursive: true }); writeFileSync(join(cwd, 'result.txt'), 'artifact')
    snapshots.set(id, { header: { id, cwd }, realWork }); const previous = workspaces.get(cwd)
    workspaces.set(cwd, { id: cwd, path: cwd, sessionIds: [...previous?.sessionIds ?? [], id] })
  }
  native(mainId, join(workspace, 'main', mainId), false)
  const ctx = { agents: { get: (id: string) => busy.has(id) ? {} : undefined }, sessions: { get: () => undefined },
    sessionPersistence: { stat: async (id: string) => existsSync(log(id)) ? snapshots.get(id) : undefined, list: async () => [...snapshots.values()].filter(s => existsSync(log(s.header.id))),
      open: async (id: string) => ({ read: async () => ({ events: snapshots.get(id)?.realWork ? [{ type: 'user/message' }] : [] }), [Symbol.asyncDispose]: async () => {} }) },
    workspaceRegistry: { archivedSessionIds: archived, archiveSession: vi.fn(async (id: string) => { if (busy.has(id)) throw new Error('Active session'); if (!archived.includes(id)) archived.push(id) }),
      unarchiveSession: async (id: string) => { const at = archived.indexOf(id); if (at >= 0) archived.splice(at, 1) }, list: () => [...workspaces.values()], delete: async (id: string) => workspaces.delete(id) } }
  const service = new TaskLifecycle(ctx as never, store, 'role', workspace, () => new Date('2026-11-12T12:00:00Z'))
  const task = (id: string, state: SubagentTask['state'], kind: SubagentTask['kind'] = 'worker', date = '2026-11-03T12:00:00Z') => {
    const cwd = kind === 'continuation' ? join(workspace,'main',mainId) : join(workspace,'tasks',id)
    native(id, cwd); const value: SubagentTask = { task_id: id, subagent_id: id, agent_id: 'role', description: id, context: [], state, kind, created_at: date, updated_at: date, priority: 0 }
    store.enqueueTask(value); return value
  }
  return { dir, host, store, memory, service, task, native, ctx, workspace, root, archived, mainId, log, workspaces, busy, close: () => { host.close(); rmSync(dir,{recursive:true,force:true}) } }
}

it('archives both branch types without deleting old sessions, files, history or the canonical Main', async () => {
  const s = setup()
  try {
    s.task('old-worker', 'completed'); s.task('recent','completed','worker','2026-11-11T12:00:00Z')
    s.task('waiting','waiting','continuation'); s.task('paused','paused','continuation'); s.task('running','running'); s.task('queued','queued')
    s.native('empty-starter',join(s.workspace,'tasks','old-worker'),false)
    await s.service.sweep()
    for (const id of ['old-worker','recent','waiting','paused']) {
      expect(s.archived).toContain(id); expect(s.store.task(id)?.archived_at).toBeDefined(); expect(existsSync(s.log(id))).toBe(true)
    }
    for (const id of ['old-worker','recent']) expect(existsSync(join(s.workspace,'tasks',id,'result.txt'))).toBe(true)
    expect(s.archived).toContain('empty-starter'); expect(existsSync(s.log('empty-starter'))).toBe(true)
    expect(s.archived).not.toContain('running'); expect(s.archived).not.toContain('queued'); expect(s.archived).not.toContain(s.mainId)
    expect(s.workspaces.has(join(s.workspace,'tasks','old-worker'))).toBe(false)
    expect(s.workspaces.has(join(s.workspace,'main',s.mainId))).toBe(true)
    expect(existsSync(s.log(s.mainId))).toBe(true)
    const first = s.store.task('old-worker')!.archived_at
    await s.service.sweep(); expect(s.store.task('old-worker')!.archived_at).toBe(first)
  } finally { await s.service.stop(); s.close() }
})

it('keeps a live native session visible and retries archiving after it becomes idle', async () => {
  const s = setup()
  try {
    s.task('live','completed'); s.busy.add('live')
    await s.service.sweep()
    expect(s.archived).not.toContain('live'); expect(s.store.record('error','task-archive:live')).toBeDefined()
    s.busy.delete('live'); await s.service.sweep()
    expect(s.archived).toContain('live'); expect(s.store.record('error','task-archive:live')).toBeUndefined()
    expect(existsSync(s.log('live'))).toBe(true)
  } finally { await s.service.stop(); s.close() }
})

it('keeps imported legacy sessions searchable on disk while hiding their idle workspace registrations',async()=>{
  const s=setup()
  try{
    const cwd=join(s.dir,'old-project');s.native('old-main',cwd)
    s.store.setRecord('legacy-native-session','old-main',{agent_id:'role',session_id:'old-main'})
    await s.service.sweep()
    expect(s.archived).toContain('old-main');expect(s.workspaces.has(cwd)).toBe(false)
    expect(existsSync(s.log('old-main'))).toBe(true);expect(existsSync(join(cwd,'result.txt'))).toBe(true)
    expect(s.archived).not.toContain(s.mainId)
  }finally{await s.service.stop();s.close()}
})
