import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { SubagentTask } from './model.ts'
import type { AmphoreusStore } from './store.ts'

const idle = (task: SubagentTask) => !['running','queued'].includes(task.state)

/** Use native archival to hide idle branches, retaining all session logs and files. */
export class TaskLifecycle {
  private timer?: ReturnType<typeof setInterval>
  private sweeping?: Promise<void>
  private stopped = false
  constructor(private readonly ctx: Context, private readonly store: AmphoreusStore, private readonly agentId: string,
    private readonly workspace: string,
    private readonly clock = () => new Date()) {}
  async start(): Promise<void> {
    await this.sweep()
    this.timer = setInterval(() => { void this.sweep() }, 3600000); this.timer.unref()
  }
  async stop(): Promise<void> { this.stopped = true; clearInterval(this.timer); await this.sweeping }
  async archiveTask(task: SubagentTask): Promise<void> {
    if (!idle(task) || this.stopped) return
    try {
      const id = task.subagent_id as SessionId
      if (await this.ctx.sessionPersistence.stat(id)) await this.ctx.workspaceRegistry.archiveSession(id)
      const current = this.store.task(task.task_id)
      if (current && idle(current) && current.activation === task.activation && !current.archived_at) this.store.updateTask({ ...current, archived_at: this.clock().toISOString() })
      if (task.kind !== 'continuation') await this.hideEmptyWorkspace(join(this.workspace, 'tasks', task.subagent_id))
      this.store.deleteRecord('error', `task-archive:${task.task_id}`)
    } catch (error) { this.recordError(`task-archive:${task.task_id}`, error) }
  }
  sweep(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    this.sweeping ??= this.performSweep().catch(error => this.recordError('task-archive-maintenance', error)).finally(() => { this.sweeping = undefined })
    return this.sweeping
  }
  private async performSweep(): Promise<void> {
    for (let offset = 0; !this.stopped; offset += 100) {
      const tasks = this.store.tasks({ agentId: this.agentId, limit: 100, offset })
      for (const task of tasks) {
        if (this.stopped) return
        await this.archiveTask(task)
      }
      if (tasks.length < 100) break
    }
    // Older per-conversation Main Sessions were retired when the single Main was introduced.
    const mainId = `amphoreus-main-${createHash('sha256').update(this.agentId).digest('hex').slice(0, 24)}`
    for(const record of this.store.records<{agent_id:string;session_id:string;archived_at?:string}>('legacy-native-session')){
      if(record.agent_id!==this.agentId||record.session_id===mainId||this.stopped||record.archived_at)continue
      const id=record.session_id as SessionId
      if(this.ctx.agents.get(id))continue
      const snapshot=await this.ctx.sessionPersistence.stat(id)
      if(!snapshot)continue
      await this.ctx.workspaceRegistry.archiveSession(id)
      this.store.setRecord('legacy-native-session',record.session_id,{...record,archived_at:this.clock().toISOString()})
      const workspace=this.ctx.workspaceRegistry.list().find(entry=>entry.path===snapshot.header.cwd)
      if(workspace&&workspace.sessionIds.every(session=>this.ctx.workspaceRegistry.archivedSessionIds.includes(session)))await this.ctx.workspaceRegistry.delete(workspace.id)
    }
    for (const id of new Set(this.store.runs(10000).filter(run => run.agent_id === this.agentId && run.state !== 'running').map(run => run.session_id))) {
      if (id === mainId || this.stopped) continue
      const snapshot = await this.ctx.sessionPersistence.stat(id as SessionId)
      if (snapshot?.header.cwd !== join(this.workspace, 'main', id)) continue
      await this.ctx.workspaceRegistry.archiveSession(id as SessionId)
      await this.hideEmptyWorkspace(snapshot.header.cwd)
    }
    await this.hideEmptyWorkspace(join(this.workspace, 'main', mainId), false, mainId)
    this.store.deleteRecord('error', 'task-archive-maintenance')
  }
  private async hideEmptyWorkspace(path: string, remove = true, protectedId?: string): Promise<void> {
    const workspace = this.ctx.workspaceRegistry.list().find(entry => entry.path === path)
    if (!workspace) return
    for (const id of workspace.sessionIds) {
      if (id === protectedId) continue
      if (this.ctx.workspaceRegistry.archivedSessionIds.includes(id)) continue
      // The native UI can leave an untouched starter Session when opening a task workspace.
      if (this.ctx.agents.get(id)) continue
      if (!await this.ctx.sessionPersistence.stat(id)) continue
      await using handle = await this.ctx.sessionPersistence.open(id, 'read')
      const { events } = await handle.read(0, 16)
      if (events.length < 16 && events.every(event => ['approval/policy','permission/preset','sandbox/mode','session/end-seed'].includes(event.type))) await this.ctx.workspaceRegistry.archiveSession(id)
    }
    if (remove && workspace.sessionIds.every(id => this.ctx.workspaceRegistry.archivedSessionIds.includes(id))) await this.ctx.workspaceRegistry.delete(workspace.id)
  }
  private recordError(id: string, error: unknown): void {
    this.store.setRecord('error', id, { error: `后台任务归档待重试：${error instanceof Error ? error.message : String(error)}` })
  }
}
