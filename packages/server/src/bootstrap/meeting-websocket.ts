import type http from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { authenticateUserToken, getToken, isAuthEnabled } from '../modules/studio/public/auth'
import { config } from '../modules/studio/public/config'
import { meetingASRService } from '../modules/studio/services/meeting-asr'
import { ensureRealtimeBackendReady } from '../modules/studio/services/realtime-backend'
import { logger } from '../modules/studio/public/logging'
import { parseUpgradeRequestUrl, shouldRejectUpgradeOrigin, writeForbiddenOrigin } from '../modules/studio/middleware/security'

export const MEETING_WEBSOCKET_PATHS = new Set(['/ws/asr', '/ws/diarize', '/ws/omni-realtime'])

/** Keep browser-facing TLS termination separate from the managed ASR child. */
export function setupMeetingWebSocketProxy(servers: http.Server[]): void {
  // ASR/DIARIZE WebSocket proxy: forward browser WSS upgrade requests to the
  // Python backend on loopback. Node already terminates browser-facing TLS.
  //
  // The transport (raw TCP vs TLS) follows whatever meetingASRService decided
  // for its uvicorn children — see MeetingASRService.useTls. Keeping the
  // decision inside the service removes the chance of desynced deploy
  // configuration (proxy in one mode, uvicorn in another).
  servers.forEach((httpServer) => {
    httpServer.on('upgrade', async (req: http.IncomingMessage, socket: import('net').Socket, head: Buffer) => {
      const upgradeUrl = parseUpgradeRequestUrl(req)
      if (!upgradeUrl) return
      const pathname = upgradeUrl.pathname
      let targetPort: number | null = null
      if (pathname === '/ws/asr') {
        targetPort = meetingASRService.getASRPort() || 8000
      } else if (pathname === '/ws/diarize') {
        targetPort = meetingASRService.getDiarizePort() || 8001
      } else if (pathname === '/ws/omni-realtime') {
        // Omni-Realtime shares the main ASR port (same Python uvicorn process).
        // The endpoint /ws/omni-realtime is routed inside FastAPI in main.py.
        targetPort = meetingASRService.getASRPort() || 8000
      }
      if (!targetPort) return // fall through to catch-all

      socket.pause()
      if (shouldRejectUpgradeOrigin(req, config.corsOrigins)) {
        writeForbiddenOrigin(socket)
        return
      }
      // Released native Qt clients connect directly on device loopback without
      // Origin. Browser and remote clients must present the existing Studio
      // user JWT or server token; forwarded-IP headers never grant this bypass.
      const address = req.socket.remoteAddress || ''
      const nativeLoopback = !req.headers.origin
        && (address === '::1' || /^127\./.test(address) || /^::ffff:127\./.test(address))
      try {
        if (!nativeLoopback && await isAuthEnabled()) {
          const authorization = req.headers.authorization || ''
          const token = upgradeUrl.searchParams.get('token')
            || (authorization.startsWith('Bearer ') ? authorization.slice(7) : '')
          const user = token ? await authenticateUserToken(token) : null
          const serverToken = token && !user ? await getToken() : ''
          const matchesServerToken = Boolean(token && serverToken && Buffer.byteLength(token) === Buffer.byteLength(serverToken)
            && timingSafeEqual(Buffer.from(token), Buffer.from(serverToken)))
          if (!user && !matchesServerToken) {
            socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
            return
          }
        }
      } catch {
        socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n')
        return
      }
      if (socket.destroyed) return
      // Do not send browser credentials to the Python child or its access log.
      upgradeUrl.searchParams.delete('token')
      const upstreamPath = upgradeUrl.pathname + upgradeUrl.search

      const upgradeTimer = setTimeout(() => socket.destroy(), 65_000)
      socket.once('close', () => clearTimeout(upgradeTimer))
      const forward = (upstream: import('net').Socket): void => {
        clearTimeout(upgradeTimer)
        const requestLine = `${req.method} ${upstreamPath} HTTP/${req.httpVersion}\r\n`
        const headers = Object.entries(req.headers)
          .filter(([key]) => key !== 'authorization' && key !== 'cookie')
          .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
          .join('\r\n')
        upstream.write(`${requestLine}${headers}\r\n\r\n`)
        if (head && head.length > 0) {
          upstream.write(head)
        }
        upstream.pipe(socket)
        socket.pipe(upstream)
        socket.resume()
        socket.on('close', () => upstream.destroy())
        upstream.on('close', () => socket.destroy())
        upstream.on('error', () => socket.destroy())
        socket.on('error', () => upstream.destroy())
      }

      // Realtime uses the managed ASR child. Node reloads stop that child;
      // lazily restore it instead of forwarding into a closed port forever.
      void (pathname === '/ws/omni-realtime'
        // Realtime 接入前补推一次持久化的 DashScope key：设备端 Qt 客户端只开 WS、
        // 不像浏览器那样把 key 显式下发，若后端先以空 key 启动（用户后来才在
        // 「设置 → 模型 → Realtime 模型」里填 key），这里让它无需重启即可生效。
        ? ensureRealtimeBackendReady().then(() => meetingASRService.ensureDashScopeKeyPushed())
        : Promise.resolve())
        .then(() => {
          if (socket.destroyed) return
          if (pathname === '/ws/omni-realtime') targetPort = meetingASRService.getASRPort() || 8000
          if (meetingASRService.useTls) {
            // Lazy-load tls only when the device runtime actually needs it.
            import('node:tls').then((tls) => {
              forward(tls.connect({ port: targetPort!, host: '127.0.0.1', rejectUnauthorized: false }))
            }).catch((err) => {
              logger.error('[bootstrap] failed to load node:tls for ASR proxy: %s', err?.message || err)
              socket.destroy()
            })
          } else {
            // Dev/local default — uvicorn serves plain HTTP, so a raw TCP relay
            // is correct and avoids TLS handshake failures against non-SSL backends.
            import('net').then((net) => {
              forward(net.connect(targetPort!, '127.0.0.1'))
            }).catch((err) => {
              logger.error('[bootstrap] failed to load node:net for ASR proxy: %s', err?.message || err)
              socket.destroy()
            })
          }
        }).catch((err) => {
          logger.warn('[bootstrap] realtime backend unavailable: %s', err?.message || err)
          socket.destroy()
        })
    })
  })

}
