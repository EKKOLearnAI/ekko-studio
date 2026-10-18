import { pty, findShell, canOpenTerminal, resolveTerminalCwd } from '../services/terminal/runtime'
import { WebSocketServer } from 'ws'
import type { IncomingMessage, Server as HttpServer } from 'http'
import type { Duplex } from 'stream'
import { authenticateUserToken, isAuthEnabled } from '../../studio/public/auth'
import { logger } from '../../studio/public/logging'
import { config } from '../../studio/public/config'
import {
  parseUpgradeRequestUrl,
  shouldRejectUpgradeOrigin,
  writeBadUpgradeRequest,
  writeForbiddenOrigin,
} from '../../studio/public/security'
import { killOwnedProcessTree } from '../../studio/public/process-tree'

function shellName(shell: string): string { return shell.split('/').pop() || 'shell' }

// ─── Session types ──────────────────────────────────────────────

interface PtySession {
  id: string
  pty: { pid: number; onData: (cb: (data: string) => void) => void; onExit: (cb: (e: { exitCode: number }) => void) => void; write: (data: string) => void; kill: (signal?: string) => void; resize: (cols: number, rows: number) => void }
  shell: string
  pid: number
  createdAt: number
}

interface Connection {
  sessions: Map<string, PtySession>
  activeSessionId: string | null
  outputBuffers: Map<string, string[]>
}

// ─── Helpers ────────────────────────────────────────────────────

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

function createSession(shell: string): PtySession {
  const id = generateId()
  let ptyProcess: PtySession['pty']
  try {
    ptyProcess = pty.spawn(shell, [], {
      name: 'xterm-color',
      cols: 80,
      rows: 24,
      cwd: resolveTerminalCwd(),
    })
  } catch (err: any) {
    throw new Error(`Failed to spawn shell "${shell}": ${err.message}`)
  }

  const session: PtySession = {
    id,
    pty: ptyProcess,
    shell,
    pid: ptyProcess.pid,
    createdAt: Date.now(),
  }

  return session
}

function killPtySession(session: PtySession): void {
  try {
    killOwnedProcessTree(session.pid, () => session.pty.kill())
  } catch { }
}

// ─── WebSocket server setup ─────────────────────────────────────

export function setupTerminalWebSocket(httpServers: HttpServer | HttpServer[]) {
  if (!pty) {
    logger.warn('node-pty not available, skipping terminal WebSocket setup')
    return null
  }

  const wss = new WebSocketServer({ noServer: true })
  const defaultShell = findShell()
  const servers = Array.isArray(httpServers) ? httpServers : [httpServers]

  const onUpgrade = async (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = parseUpgradeRequestUrl(req)
    if (!url) {
      writeBadUpgradeRequest(socket)
      return
    }
    if (url.pathname !== '/api/hermes/terminal') {
      return
    }

    if (shouldRejectUpgradeOrigin(req, config.corsOrigins)) {
      writeForbiddenOrigin(socket)
      return
    }

    // Auth check
    if (await isAuthEnabled()) {
      const token = url.searchParams.get('token') || ''
      const user = await authenticateUserToken(token)
      if (!user) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        socket.destroy()
        return
      }
      if (!canOpenTerminal(user)) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
        socket.destroy()
        return
      }
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req)
    })
  }

  servers.forEach(httpServer => httpServer.on('upgrade', onUpgrade))

  wss.on('connection', (ws) => {
    const conn: Connection = {
      sessions: new Map(),
      activeSessionId: null,
      outputBuffers: new Map(),
    }

    // ─── PTY output → WebSocket ──────────────────────────────────

    function attachPtyOutput(session: PtySession) {
      session.pty.onData((data: string) => {
        if (ws.readyState !== ws.OPEN) return
        if (conn.activeSessionId === session.id) {
          ws.send(data)
        } else {
          // Buffer output for inactive sessions
          let buf = conn.outputBuffers.get(session.id)
          if (!buf) {
            buf = []
            conn.outputBuffers.set(session.id, buf)
          }
          buf.push(data)
          // Cap buffer at 1MB to prevent memory issues
          if (buf.length > 5000) {
            buf.splice(0, buf.length - 5000)
          }
        }
      })

      session.pty.onExit(({ exitCode }: { exitCode: number }) => {
        conn.outputBuffers.delete(session.id)
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: 'exited', id: session.id, exitCode }))
        }
        conn.sessions.delete(session.id)
        logger.info('Session %s exited (pid %d, code %d)', session.id, session.pid, exitCode)
      })
    }

    // ─── Message handler ────────────────────────────────────────

    ws.on('message', (raw) => {
      const msg = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw)

      // JSON control message
      if (msg.charCodeAt(0) === 0x7B) {
        try {
          const parsed = JSON.parse(msg)
          handleControl(parsed)
        } catch {
          // Not valid JSON, fall through to raw input
          writeRaw(msg)
        }
        return
      }

      writeRaw(msg)
    })

    function writeRaw(data: string) {
      const session = conn.activeSessionId ? conn.sessions.get(conn.activeSessionId) : null
      if (session) {
        session.pty.write(data)
      }
    }

    function handleControl(parsed: any) {
      switch (parsed.type) {
        case 'create': {
          const shell = parsed.shell || defaultShell
          let session: PtySession
          try {
            session = createSession(shell)
          } catch (err: any) {
            ws.send(JSON.stringify({ type: 'error', message: err.message }))
            return
          }
          conn.sessions.set(session.id, session)
          conn.activeSessionId = session.id
          attachPtyOutput(session)
          ws.send(JSON.stringify({
            type: 'created',
            id: session.id,
            pid: session.pid,
            shell: shellName(shell),
          }))
          logger.info('Session created: %s (%s, pid %d)', session.id, shellName(shell), session.pid)
          break
        }

        case 'switch': {
          const { sessionId } = parsed
          const session = conn.sessions.get(sessionId)
          if (!session) {
            ws.send(JSON.stringify({ type: 'error', message: 'Session not found' }))
            return
          }
          conn.activeSessionId = sessionId

          // Send switched first so frontend mounts the correct terminal
          ws.send(JSON.stringify({ type: 'switched', id: sessionId }))

          // Then flush buffered output for this session
          const buf = conn.outputBuffers.get(sessionId)
          if (buf && buf.length > 0) {
            for (const chunk of buf) {
              ws.send(chunk)
            }
            conn.outputBuffers.delete(sessionId)
          }

          logger.debug('Switched to session %s', sessionId)
          break
        }

        case 'close': {
          const { sessionId } = parsed
          const session = conn.sessions.get(sessionId)
          if (!session) return
          killPtySession(session)
          conn.sessions.delete(sessionId)
          conn.outputBuffers.delete(sessionId)
          if (conn.activeSessionId === sessionId) {
            // Auto-switch to the first remaining session
            const remaining = Array.from(conn.sessions.keys())
            conn.activeSessionId = remaining.length > 0 ? remaining[0] : null
          }
          logger.info('Session closed: %s', sessionId)
          break
        }

        case 'resize': {
          const session = conn.activeSessionId ? conn.sessions.get(conn.activeSessionId) : null
          if (!session) return
          const cols = Math.max(1, parsed.cols || 0)
          const rows = Math.max(1, parsed.rows || 0)
          try { session.pty.resize(cols, rows) } catch { }
          break
        }

        case 'input': {
          if (typeof parsed.data === 'string') writeRaw(parsed.data)
          break
        }
      }
    }

    // ─── Cleanup ────────────────────────────────────────────────

    ws.on('close', () => {
      for (const session of Array.from(conn.sessions.values())) {
        killPtySession(session)
      }
      conn.sessions.clear()
      logger.info('Connection closed, all sessions killed')
    })

    ws.on('error', () => {
      for (const session of Array.from(conn.sessions.values())) {
        killPtySession(session)
      }
      conn.sessions.clear()
    })

    // ─── Auto-create first session ──────────────────────────────

    let firstSession: PtySession
    try {
      firstSession = createSession(defaultShell)
    } catch (err: any) {
      ws.send(JSON.stringify({ type: 'error', message: err.message }))
      logger.error(err, 'Failed to create session')
      ws.close()
      return
    }
    conn.sessions.set(firstSession.id, firstSession)
    conn.activeSessionId = firstSession.id
    attachPtyOutput(firstSession)
    ws.send(JSON.stringify({
      type: 'created',
      id: firstSession.id,
      pid: firstSession.pid,
      shell: shellName(defaultShell),
    }))
    logger.info('First session created: %s (%s, pid %d)', firstSession.id, shellName(defaultShell), firstSession.pid)
  })

  logger.info('WebSocket ready at /terminal (shell: %s, transport: node-pty)', defaultShell)

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
