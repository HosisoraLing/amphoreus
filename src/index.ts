/** Amphoreus character runtime and its public gateway/storage APIs. */
import type { Context } from '@deepseek-ai/cordis'
import { Config, type DeploymentConfig } from './deployment.ts'
import { startAmphoreus } from './amphoreus/start.ts'

export const name = '翁法罗斯'
export const inject = ['agents', 'sessionController', 'sessionPersistence', 'workspaceRegistry', 'permissionPresets', 'tools', 'systemPrompt', 'webServer', 'llm', 'attachments']
export { Config }
export async function apply(ctx: Context, config: DeploymentConfig): Promise<void> {
  const configPath = config.configPath || process.env.AMPHOREUS_CONFIG
  if (!configPath) throw new Error('请在插件配置中设置 configPath，或提供 AMPHOREUS_CONFIG 环境变量。')
  const stop = await startAmphoreus(ctx, config.stateDir, configPath)
  ctx.effect(() => stop)
}
export type { DeploymentConfig } from './deployment.ts'
export * from './amphoreus/model.ts'
export * from './amphoreus/store.ts'
export * from './amphoreus/gateway.ts'
export * from './amphoreus/scheduler.ts'
export * from './amphoreus/memory.ts'
