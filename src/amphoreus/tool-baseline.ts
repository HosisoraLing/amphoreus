import type { Session } from '@deepseek-ai/dsh-session'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'

/** A restricted Fork can remove every original tool. Start a logged declaration
 * series so addition-only providers do not defer all its remaining tools. */
export function resetForkToolBaseline(session: Session, tools: ToolSchema[]): void {
  const header = session.requestHeader(), baseline = session.toolHistory().tools
  if (!header || baseline.some(tool => !tool.deferLoading && tools.some(current => current.name === tool.name))) return
  session.append('request/header', { header: { ...header, tools }, reason: 'series' })
}
