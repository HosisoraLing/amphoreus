import type { Context } from '@deepseek-ai/cordis'
import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent'
import { z } from 'zod'
import { resolveRoleModel } from '../app/role-models.ts'
import type { AmphoreusStore } from './store.ts'

export const ModelRoute = z.object({ provider: z.string().trim().min(1).max(200), model: z.string().trim().min(1).max(300), reasoningEffort: z.string().trim().min(1).max(100).optional() }).strict()
export const ModelScope = z.enum(['main', 'worker', 'continuation', 'topic'])
export type ModelScope = z.infer<typeof ModelScope>
export const ModelInput = z.object({ scope: ModelScope, task_id: z.string().min(1).max(200).optional(), selection: ModelRoute.nullable() }).strict()
type Route = z.infer<typeof ModelRoute>
type Defaults = { main: Route | null; worker: Route | null; continuation?: Route | null; topic?: Route | null }

/** Role-local routes; never call selectModel(), which also changes DSH's global default. */
export class ModelSettings {
  constructor(readonly ctx: Context, readonly store: AmphoreusStore, readonly roleId: string, readonly defaults: Defaults) {}
  private key(scope: ModelScope, taskId?: string) { return JSON.stringify([this.roleId, scope, taskId ?? null]) }
  configured(scope: ModelScope, taskId?: string): Route | null {
    const saved = this.store.record<{ selection: Route | null }>('model-route', this.key(scope, taskId))
    return saved ? saved.selection : taskId ? null : this.defaults[scope] ?? null
  }
  private task(scope: ModelScope, id?: string) {
    if (!id) return
    const task = this.store.task(id)
    if (!task || task.agent_id !== this.roleId || (task.kind ?? 'worker') !== scope) throw new Error('任务不存在或模型作用域不匹配')
  }
  async resolve(scope: ModelScope, taskId?: string): Promise<ModelSelection> {
    this.task(scope, taskId)
    const selection = (taskId ? this.configured(scope, taskId) : null) ?? this.configured(scope)
      ?? (scope === 'continuation' || scope === 'topic' ? this.configured('main') : null)
      ?? (this.ctx.get('agentDefaultModel') as { currentSelection(): ModelSelection }).currentSelection()
    return resolveRoleModel(this.ctx, selection)
  }
  async configure(input: z.infer<typeof ModelInput>) {
    this.task(input.scope, input.task_id)
    let selection: ModelSelection | null = null
    if (input.selection) {
      if (!this.ctx.llm.listProviders().some(provider => provider.id === input.selection!.provider)) throw new Error('提供方不可用，请检查 DSH 模型配置')
      try { selection = await resolveRoleModel(this.ctx, input.selection) }
      catch { throw new Error('模型或推理强度不可用，请检查 DSH 模型配置') }
    }
    this.store.setRecord('model-route', this.key(input.scope, input.task_id), { selection })
  }
  async status(taskId?: string) {
    const view = async (scope: ModelScope, id?: string) => {
      const selection = this.configured(scope, id)
      try { return { selection, effective: await this.resolve(scope, id) } }
      catch { return { selection, effective: null, error: '当前模型不可用，请重新选择' } }
    }
    const roles = Object.fromEntries(await Promise.all(ModelScope.options.map(async scope => [scope, await view(scope)])))
    if (!taskId) return { roles }
    const task = this.store.task(taskId)
    if (!task || task.agent_id !== this.roleId) throw new Error('任务不存在')
    const scope = task.kind ?? 'worker'
    return { roles, task: { task_id: taskId, scope, ...await view(scope, taskId) } }
  }
  async catalog() {
    const catalog = await this.ctx.sessionController.modelCatalog()
    // Provider exceptions may contain request URLs or credential fragments. Do not expose them.
    return { default: catalog.default, groups: catalog.groups, failures: catalog.failures.map(item => ({ id: item.id, name: item.name, message: '模型列表暂不可用，请检查提供方配置' })) }
  }
}

/** Capture routing when a step assembles, so retries stay on that route and later steps see saved changes. */
export function installRoleRouting(ctx: Context, agent: Agent, settings: ModelSettings, scope: ModelScope, taskId?: string): () => void {
  let assembled: ModelSelection | undefined
  const disposers = [
    agent.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      const selected = await settings.resolve(scope, taskId)
      const result = await next()
      assembled = selected
      const last = agent.session.snapshotEvents().findLast(event => event.type === 'model/selection')
      if (!last || JSON.stringify(last.data) !== JSON.stringify(selected)) {
        // Attached Session.append publishes session/event itself. Emitting again queues
        // the same seq twice and permanently blocks the persistence writer's drain.
        agent.session.append('model/selection', selected)
      }
      return { ...result, variables: { ...result.variables, provider: selected.provider, model: selected.model } }
    }, { prepend: true }),
    agent.ctx.on('agent/request', async (_payload, next) => {
      const result = await next()
      if (!assembled) return result
      const { reasoningEffort: _inherited, ...rest } = result
      return { ...rest, ...assembled }
    }, { prepend: true }),
  ]
  return () => disposers.forEach(dispose => dispose())
}
