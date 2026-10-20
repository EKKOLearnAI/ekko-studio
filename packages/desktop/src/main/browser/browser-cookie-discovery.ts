import { createServer, type Server } from 'node:http'

export const COOKIE_EXTENSION_ORIGIN = 'chrome-extension://mfkhigkkkiodagdmjklacpboihnmegpk'

export const COOKIE_DISCOVERY_PORT = 19489

/** Fixed loopback rendezvous; only extension POSTs may request a session from the bundled extension. */
export class BrowserCookieDiscovery {
  private server?: Server
  private connecting = false

  async start(connect: () => Promise<unknown>, port = COOKIE_DISCOVERY_PORT): Promise<void> {
    const server = createServer(async (req, res) => {
      const reply = (code: number, body: object) => {
        res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify(body))
      }
      const address = server.address()
      const origin = req.headers.origin || ''
      if (!address || typeof address === 'string' || req.headers.host !== `127.0.0.1:${address.port}`
        || origin !== COOKIE_EXTENSION_ORIGIN) {
        reply(403, { detail: 'Extension origin required' }); return
      }
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Vary', 'Origin')
      if (req.url !== '/api/cookie-import-helper/connect') { reply(404, { detail: 'Not found' }); return }
      if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', 'POST')
        res.writeHead(204); res.end(); return
      }
      if (req.method !== 'POST' || (req.headers['content-length'] && req.headers['content-length'] !== '0') || req.headers['transfer-encoding']) {
        reply(400, { detail: 'Empty POST required' }); return
      }
      if (this.connecting) { reply(409, { detail: 'An import request is already open in Studio' }); return }
      this.connecting = true
      try { reply(200, await connect() as object) }
      catch { reply(409, { detail: 'Open Studio or close the existing import session' }) }
      finally { this.connecting = false }
    })
    server.maxConnections = 8
    server.requestTimeout = 10_000
    server.headersTimeout = 10_000
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve() })
    })
    server.on('error', () => { void this.stop() })
    server.unref()
    this.server = server
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = undefined
    if (server) {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  }
}
