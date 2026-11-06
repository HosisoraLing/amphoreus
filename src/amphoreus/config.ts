import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { PeopleSettings } from './people.ts'
import { QQConfig } from './qq.ts'
import { MemorySettings } from './memory.ts'
import { MediaSettings } from './media.ts'
import { DeliverySettings } from './output-recovery.ts'
import { ModelRoute } from './models.ts'
const Model = ModelRoute.nullable()
export const AmphoreusConfig = z.object({
  role: z.object({ agent_id: z.string().min(1).max(100), name: z.string().min(1).max(100), persona: z.string().min(1).max(100000) }).strict(),
  workspace: z.string().min(1),
  models: z.object({ main: Model.default(null), worker: Model.default(null), continuation: Model.default(null), topic: Model.default(null) }).default({ main: null, worker: null, continuation: null, topic: null }),
  limits: z.object({ maxWorkers: z.number().int().min(1).max(16).default(3), mainSteps: z.number().int().min(1).max(30).default(8),
    collaborationSteps: z.number().int().min(8).max(200).default(60), collaborationTimeoutMs: z.number().int().min(1000).max(3600000).default(300000),
    reviewSteps: z.number().int().min(1).max(30).default(16), reviewTimeoutMs: z.number().int().min(1000).max(300000).default(180000),
    mainTimeoutMs: z.number().int().min(1000).max(300000).default(90000), taskTimeoutMs: z.number().int().min(1000).max(86400000).default(3600000),
    progressIntervalMs: z.number().int().min(1000).max(3600000).default(60000) }).prefault({}),
  api: z.object({ host: z.string().default('127.0.0.1'), port: z.number().int().min(0).max(65535).default(13103),
    allowedHosts: z.array(z.string().min(1)).min(1), tokens: z.array(z.object({ token: z.string().min(32), user: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
      role: z.enum(['admin', 'chat']) }).strict()).min(1), secureCookies: z.boolean().default(false) }).strict(),
  qq: QQConfig.optional(),
  memory: MemorySettings,
  people: PeopleSettings,
  media: MediaSettings,
  delivery: DeliverySettings,
}).strict().superRefine((config, ctx) => {
  const tokens = config.api.tokens.map(t => t.token)
  if (new Set(tokens).size !== tokens.length) ctx.addIssue({ code: 'custom', path: ['api', 'tokens'], message: 'Duplicate API tokens' })
})
export type Configuration = z.infer<typeof AmphoreusConfig>
export function readConfiguration(path: string): Configuration {
  try { return AmphoreusConfig.parse(JSON.parse(readFileSync(path, 'utf8'))) }
  catch (error) {
    // Config errors must never include token values, provider credentials or the full private persona.
    if (error instanceof z.ZodError) throw new Error(`Invalid Amphoreus configuration fields: ${error.issues.map(i => i.path.join('.')).join(', ')}`)
    throw new Error('Cannot read Amphoreus configuration JSON')
  }
}
