import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage } from 'node:http'
import type { AmphoreusHttp } from './http.ts'

/** Connection owns browser authentication, Host/Origin checks and Peer identity. */
type Connection = { admit(request: IncomingMessage): { rejection: number } | { peer: { principal: { kind: string } } } }

export function registerHarnessPanel(ctx: Context, api: AmphoreusHttp): () => void {
  const connection = ctx.get('connection') as Connection
  const standalone = ctx.webServer.register({ kind: 'prefix', path: '/console', handler: async (req, res) => {
    // Intentionally no Harness owner admission: the standalone API enforces its own Host, Origin and MFA session.
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    if (path !== '/console' && !path.startsWith('/console/')) { res.writeHead(404); res.end(); return }
    await api.handle(req, res)
  } })
  const panel = ctx.webServer.register({ kind: 'prefix', path: '/amphoreus', handler: async (req, res) => {
    const admission = connection.admit(req)
    const rejection = 'rejection' in admission ? admission.rejection : admission.peer.principal.kind !== 'owner' ? 403 : undefined
    if (rejection) {
      res.writeHead(rejection, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ error: 'Harness owner authentication required' })); return
    }
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname === '/amphoreus') { res.writeHead(302, { location: '/amphoreus/' }); res.end(); return }
    if (url.pathname === '/amphoreus/manifest' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ mode: 'amphoreus' })); return
    }
    await api.handle(req, res, { user: api.config.tokens.find(token => token.role === 'admin')?.user ?? 'owner', role: 'admin' })
  } })
  return () => { panel(); standalone() }
}
