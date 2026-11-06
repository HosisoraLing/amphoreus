/** Native DSH sidebar entry for the Amphoreus management surface. */
import type { Context } from '@deepseek-ai/cordis'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { SidebarPanelIconOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'

function AmphoreusIcon({ size }: SidebarPanelIconOwnerProps) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} aria-hidden>
    <path d="M12 2 22 12 12 22 2 12Z" /><path d="m12 7 5 5-5 5-5-5Z" />
  </svg>
}
export function AmphoreusPanel() {
  return <iframe title="翁法罗斯管理" src="/amphoreus/" style={{ width: '100%', height: '100%', minHeight: 0, border: 0, display: 'block' }} />
}
export const inject = ['slots']
export function apply(ctx: Context): void {
  if (typeof document !== 'undefined') ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.amphoreusCompact = ''
    style.textContent = '[data-turn-trigger] [class$="_explanation"]{display:none}'
    document.head.append(style)
    return () => style.remove()
  })
  const panel = 'amphoreus' as MainPanelId
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: panel, inject: () => ({}) }, AmphoreusPanel))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: panel, order: 10, label: () => '翁法罗斯' }, AmphoreusIcon))
}
