/** Versioned official price snapshot. Estimates never stand in for a provider invoice. */
import { z } from 'zod'
import snapshotText from './pricing-snapshot.json?raw'
const holidayRanges = [['2026-01-01',3],['2026-02-15',9],['2026-04-04',3],['2026-05-01',5],['2026-06-19',3],['2026-09-25',3],['2026-10-01',7]] as const
const holidays2026 = holidayRanges.flatMap(([start, length]) => Array.from({length}, (_, i) => new Date(Date.parse(start) + i * 86400000).toISOString().slice(0,10)))
export const StatisticsSettings = z.object({
  goPlan: z.enum(['unknown', 'go', 'go-plus', 'go-teams']).default('unknown'),
  usdCny: z.number().positive().max(100).nullable().default(null),
  holidays: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).max(3660).default(holidays2026),
  providerKinds: z.record(z.string().min(1).max(200), z.enum(['deepseek', 'opencode-go', 'other'])).default({}),
  logRetentionDays: z.number().int().min(7).max(3650).default(90),
}).strict()
export type StatisticsSettings = z.infer<typeof StatisticsSettings>
type Rate = { input: number; output: number; read: number; write: number; go: number; 'go-plus': number; 'go-teams': number;
  long_context?: { threshold: number; input: number; output: number; read: number; write: number } }
export const pricingSnapshot = JSON.parse(snapshotText) as { as_of: string; sources: string[]; go: Record<string, Rate> }
export const beijingDay = (time: number | string): string => new Date(new Date(time).getTime() + 8 * 3600000).toISOString().slice(0, 10)
export function peak(time: string, holidays: string[] = [], official = false): boolean {
  const date = new Date(Date.parse(time) + 8 * 3600000), hour = date.getUTCHours(), day = date.getUTCDay()
  return day > 0 && day < 6 && (!official || !holidays.includes(beijingDay(time))) && (hour >= 9 && hour < 12 || hour >= 14 && hour < 18)
}
export type Usage = { input: number; output: number; read: number; write: number }
export function providerKind(provider: string, settings: StatisticsSettings): string {
  return settings.providerKinds[provider] ?? (['deepseek','deepseek-account'].includes(provider) ? 'deepseek' : /^(opencode-go|opencode-go-plus)$/.test(provider) ? 'opencode-go' : 'other')
}
export function price(provider: string, model: string, usage: Usage, at: string, settings: StatisticsSettings) {
  const kind = providerKind(provider, settings), key = model.toLowerCase(), input = usage.input + usage.read + usage.write
  let rate: Pick<Rate, 'input' | 'output' | 'read' | 'write'> | undefined, currency: 'CNY' | 'USD' = kind === 'deepseek' ? 'CNY' : 'USD'
  let monthly: number | null = null, factor = 1
  if (kind === 'deepseek') {
    if (['deepseek-flash', 'deepseek-v4.1-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'].includes(key)) rate = { input: 2, output: 8, read: .04, write: 2 }
    if (key === 'deepseek-v4-pro') rate = { input: 9, output: 27, read: .3, write: 9 }
    if (!peak(at, settings.holidays, true)) factor = .5
  } else if (kind === 'opencode-go') {
    const row = pricingSnapshot.go[key]
    if (row) {
      rate = row.long_context && input > row.long_context.threshold ? row.long_context : row
      if (settings.goPlan !== 'unknown') monthly = row[settings.goPlan]
      if (key.startsWith('deepseek-') && !peak(at)) factor = .5
      if (key === 'gemini-4-argon' && at >= '2026-12-01T00:00:00.000Z') rate = undefined
    }
  }
  const amount = rate ? factor * (usage.input * rate.input + usage.output * rate.output + usage.read * rate.read + usage.write * rate.write) / 1e6 : null
  return { kind, currency, amount, monthly, allowance: amount !== null && monthly ? amount / monthly : null, estimated: true,
    cny: amount === null ? null : currency === 'CNY' ? amount : settings.usdCny ? amount * settings.usdCny : null }
}
