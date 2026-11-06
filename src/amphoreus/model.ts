import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'

/** Extensible block: adapters preserve platform payloads instead of flattening messages into text. */
export type ContentBlock = { type: string; [key: string]: unknown }

export interface GatewayEvent {
  event_id: string
  schema_version: 1
  agent_id: string
  source_kind: string
  platform: string
  account_id: string
  conversation_id: string
  actor_id: string
  event_type: string
  timestamp: string
  received_at: string
  correlation_id: string | null
  content: ContentBlock[]
  metadata: Record<string, unknown>
  visibility: 'public' | 'private' | 'internal'
  idempotency_key: string
  task_id?: string
  subagent_id?: string
  report_id?: string
}

/** Only gateway-owned internal review messages may use the nightly review budget. */
export const isMemoryReview = (event: GatewayEvent): boolean => event.source_kind === 'internal' && event.platform === 'internal' && event.conversation_id === 'memory-review'

const ContentBlockSchema = z.object({ type: z.string().min(1) }).passthrough()
export const GatewayEventSchema = z.object({
  event_id: z.string().min(1),
  schema_version: z.literal(1),
  agent_id: z.string().min(1),
  source_kind: z.string().min(1),
  platform: z.string().min(1),
  account_id: z.string(),
  conversation_id: z.string().min(1),
  actor_id: z.string().min(1),
  event_type: z.string().min(1),
  timestamp: z.string().datetime({ offset: true }),
  received_at: z.string().datetime({ offset: true }),
  correlation_id: z.string().nullable(),
  content: z.array(ContentBlockSchema),
  metadata: z.record(z.string(), z.unknown()),
  visibility: z.enum(['public', 'private', 'internal']),
  idempotency_key: z.string().min(1),
  task_id: z.string().optional(),
  subagent_id: z.string().optional(),
  report_id: z.string().optional(),
}).strict() as z.ZodType<GatewayEvent>

export type GatewayEventInput = Omit<GatewayEvent, 'event_id' | 'schema_version' | 'received_at'> & {
  event_id?: string
  received_at?: string
}

/** Validates and stamps a source event. Stable idempotency keys produce stable event IDs across retries. */
export function normalizeEvent(input: GatewayEventInput, now = new Date()): GatewayEvent {
  const id = input.event_id ?? createHash('sha256').update(JSON.stringify([input.agent_id, input.source_kind, input.platform, input.account_id, input.conversation_id,
    input.idempotency_key])).digest('hex').slice(0, 32)
  return GatewayEventSchema.parse({ ...input, event_id: id, schema_version: 1, received_at: input.received_at ?? now.toISOString() })
}

export type EventState = 'queued' | 'processing' | 'processed' | 'failed'

export type ReportType = 'progress' | 'thought' | 'discovery' | 'question' | 'completed' | 'failed'
export interface TaskReport {
  report_id: string
  task_id: string
  agent_id: string
  subagent_id: string
  type: ReportType
  summary: string
  details?: ContentBlock[]
  progress?: number
  priority: number
  created_at: string
  event_id: string
  activation?: number
}
export interface AgentMessage {
  id: string; event_id: string; task_id: string; content: string; from_run_id: string;
  created_at: string; status: 'pending' | 'accepted'; accepted_at?: string
}

export type SubagentKind = 'worker' | 'continuation' | 'topic'
export interface ForkContextSnapshot {
  parent_agent_id: string; parent_session_id: string; fork_event_seq: number; child_session_id: string;
  persona_version: string; self_version: string | null; memory_view_at: string; created_at: string;
  handoff: { run_id: string; trigger: GatewayEvent; task: string; decisions: ContentBlock[] }
}
export type TaskState = 'queued' | 'running' | 'waiting' | 'paused' | 'completed' | 'failed' | 'cancelled'
export interface SubagentTask {
  task_id: string
  agent_id: string
  subagent_id: string
  description: string
  context: ContentBlock[]
  priority: number
  state: TaskState
  created_at: string
  updated_at: string
  error?: string
  origin?: GatewayEvent
  parent_run_id?: string
  kind?: SubagentKind
  topic_id?: string
  memory_access?: boolean
  parent_session_id?: string
  fork?: ForkContextSnapshot
  activation?: number
  resume_note?: string
  pending_messages?: AgentMessage[]
  archived_at?: string
}

export const newId = (): string => randomUUID()
