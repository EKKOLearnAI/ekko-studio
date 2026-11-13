import { WebSocketServer } from 'ws'
import type { WebSocket } from 'ws'
import type { Server as HttpServer, IncomingMessage } from 'http'
import type { Duplex } from 'stream'
import { authenticateUserToken, isAuthEnabled } from '../../studio/public/auth'
import { config } from '../../studio/public/config'
import { logger } from '../../studio/public/logging'
import {
  parseUpgradeRequestUrl,
  shouldRejectUpgradeOrigin,
  writeBadUpgradeRequest,
  writeForbiddenOrigin,
} from '../../studio/public/security'
import { userCanAccessProfile } from '../../studio/public/users'
import { killOwnedProcessTree } from '../../studio/public/process-tree'
import * as kanbanCli from '../services/kanban/kanban-service'

interface KanbanEventsRequest extends IncomingMessage {
  kanbanBoard?: string
  kanbanProfile?: string
}

function sendJson(ws: WebSocket, payload: Record<string, unknown>) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload))
}

function streamLines(onLine: (line: string) => void) {
  let buffer = ''
  return (chunk: Buffer | string) => {
    buffer += chunk.toString()
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() || ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed) onLine(trimmed)
    }
  }
}

export function setupKanbanEventsWebSocket(httpServers: HttpServer | HttpServer[]) {
  const wss = new WebSocketServer({ noServer: true })
  const servers = Array.isArray(httpServers) ? httpServers : [httpServers]

  const onUpgrade = async (req: KanbanEventsRequest, socket: Duplex, head: Buffer) => {
    const url = parseUpgradeRequestUrl(req)
    if (!url) {
      writeBadUpgradeRequest(socket)
      return
    }
    if (url.pathname !== '/api/hermes/kanban/events') return

    if (shouldRejectUpgradeOrigin(req, config.corsOrigins)) {
      writeForbiddenOrigin(socket)
      return
    }

    if (await isAuthEnabled()) {
      const token = url.searchParams.get('token') || ''
      const user = await authenticateUserToken(token)
      if (!user) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        socket.destroy()
        return
      }
      const profile = (url.searchParams.get('profile') || '').trim()
      if (profile && user.role !== 'super_admin' && !userCanAccessProfile(user.id, profile)) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
        socket.destroy()
        return
      }
      req.kanbanProfile = profile || undefined
    }

    try {
      req.kanbanBoard = kanbanCli.normalizeBoardSlug(url.searchParams.get('board'))
    } catch {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
      socket.destroy()
      return
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req)
    })
  }

  servers.forEach(httpServer => httpServer.on('upgrade', onUpgrade))

  wss.on('connection', (ws, req: KanbanEventsRequest) => {
    const board = req.kanbanBoard || 'default'
    const child = kanbanCli.watchEvents({ board, interval: 0.5 })
    let closed = false

    sendJson(ws, { type: 'connected', board })

    const closeChild = () => {
      if (closed) return
      closed = true
      killOwnedProcessTree(child.pid, () => {
        if (!child.killed) child.kill()
      })
    }

    child.stdout?.on('data', streamLines((line) => {
      if (line.toLowerCase().startsWith('watching kanban events')) return
      sendJson(ws, { type: 'event', board })
    }))

    child.stderr?.on('data', streamLines((line) => {
      sendJson(ws, { type: 'error', board, message: line })
    }))

    child.on('error', (err) => {
      logger.error(err, 'Hermes CLI: kanban watch failed')
      sendJson(ws, { type: 'error', board, message: err.message })
      if (ws.readyState === ws.OPEN) ws.close()
    })

    child.on('exit', (code, signal) => {
      sendJson(ws, { type: 'stopped', board, code, signal })
      if (ws.readyState === ws.OPEN) ws.close()
    })

    ws.on('close', closeChild)
    ws.on('error', closeChild)
  })

  logger.info('WebSocket ready at /api/hermes/kanban/events (kanban watch bridge)')

  let closePromise: Promise<void> | null = null
  const detachAndTerminate = () => {
    servers.forEach(httpServer => httpServer.off('upgrade', onUpgrade))
    for (const ws of wss.clients) ws.terminate()
  }
  return {
    forceClose: detachAndTerminate,
    close(): Promise<void> {
      if (closePromise) return closePromise
      detachAndTerminate()
      closePromise = new Promise(resolve => {
        wss.close(() => resolve())
      })
      return closePromise
    },
  }
}
