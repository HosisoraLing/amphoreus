/** Read the exact native DSH footer projections; never recompute token or timing folds. */
import type { Context } from '@deepseek-ai/cordis'
export type FooterReader = (sessionId: string) => Promise<NativeFooter>
export interface NativeFooter {
  available: boolean; source: 'dsh-session-projections'; as_of_seq?: number;
  contextPressure?: Record<string, number>; contextBreakdown?: Record<string, number>;
  tokenUsage?: Record<string, number>; sessionStats?: Record<string, number>
}
const fields = {
  contextPressure: ['pressureTokens','projectedTokens','contextWindow'],
  contextBreakdown: ['systemTokens','toolsTokens','messageTokens'],
  tokenUsage: ['uncachedInputTokens','outputTokens','cacheReadTokens','cacheWriteTokens'],
  sessionStats: ['turns','steps','llmMs','toolMs','ttftMs','ttftSteps','decodeMs','decodeTokens'],
} as const
/** Whitelist numeric fields so no native prompt, identity or provider secrets cross the console boundary. */
export function projectFooter(values: Record<string, unknown>, seq?: number): NativeFooter {
  const result: NativeFooter = { available:false, source:'dsh-session-projections', ...(seq === undefined?{}:{as_of_seq:seq}) }
  for (const [key, names] of Object.entries(fields)) {
    const value = values[key]
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const clean: Record<string, number> = {}
    for (const name of names) { const n = (value as Record<string, unknown>)[name]; if (typeof n === 'number' && Number.isFinite(n) && n >= 0) clean[name] = n }
    if (Object.keys(clean).length) { result[key as keyof typeof fields] = clean; result.available = true }
  }
  return result
}
/** Query's observation owns native live/cold projection loading and releases its lease after this read. */
export function nativeFooterReader(ctx: Context): FooterReader {
  type Observation = { projections?: { values: Record<string,unknown>; asOfSeq: number }; [Symbol.dispose](): void }
  type Query = { observeSession(id: string): Promise<Observation> }
  return async id => {
    const query = ctx.get('sessionQuery') as Query | undefined
    if (!query) return {available:false,source:'dsh-session-projections'}
    using observation = await query.observeSession(id)
    return projectFooter(observation.projections?.values ?? {}, observation.projections?.asOfSeq)
  }
}
