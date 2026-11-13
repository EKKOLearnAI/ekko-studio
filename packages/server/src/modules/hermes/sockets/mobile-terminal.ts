import { authenticateSessionShare, refreshSessionShare, sessionShareExecutionUser, socketShareToken, assertShareProfile, watchSessionShare, type SessionShareAccess } from '../../studio/public/session-shares'
import { createHash } from 'crypto'
import { accessSync, constants, statSync } from 'fs'
import type { Server, Socket } from 'socket.io'
import { authenticateUserToken } from '../../studio/public/auth'
import { killOwnedProcessTree } from '../../studio/public/process-tree'
import { getTerminalConfig } from '../../studio/public/workspace-files'
import { getProfileDir, listProfileNamesFromDisk } from '../services/profiles/profile'
import { canOpenTerminal, findShell, pty, resolveTerminalCwd } from '../services/terminal/runtime'
import { MOBILE_TERMINAL_LIMITS, MobileTerminalSessions, type TerminalScope } from '../services/terminal/mobile-sessions'

export interface TerminalContext { profile: string; source: 'single' | 'group'; sourceId: string }
type ContextResolver = (context: TerminalContext) => { profile: string; workspace: string } | null
const OPERATIONS = ['capabilities', 'list', 'create', 'attach', 'read', 'input', 'resize', 'detach', 'close'] as const

/** Separate from the desktop WebSocket: mobile PTYs survive a dropped relay bridge. */
export function setupMobileTerminal(io: Server, resolveContext: ContextResolver) {
  const nsp = io.of('/terminal')
  const sessions = new MobileTerminalSessions((cwd, shell, cols, rows) => {
    if (!pty) throw new Error('terminal_unavailable')
    const process = pty.spawn(shell, [], { name: 'xterm-256color', cwd, cols, rows })
    return {
      pid: process.pid, write: (data) => process.write(data), resize: (c, r) => process.resize(c, r),
      onData: callback => process.onData(callback), onExit: callback => process.onExit(callback),
      kill: () => killOwnedProcessTree(process.pid, () => process.kill()),
    }
  })
  const credentials = new Map<string, { token: string; share?: SessionShareAccess; dispose?: () => void }>()
  const forgetCredentials = (owner: string) => { credentials.get(owner)?.dispose?.(); credentials.delete(owner) }
  const closeOwner = (owner: string) => {
    sessions.closeOwner(owner); forgetCredentials(owner)
    for (const socket of nsp.sockets.values()) if (socket.data.terminalScope?.owner === owner) socket.disconnect(true)
  }
  const executionUser = async (token: string, share?: SessionShareAccess) => {
    if (!share) return authenticateUserToken(token)
    await refreshSessionShare(share, 'terminal')
    return sessionShareExecutionUser(share)
  }
  let closing = false
  let sweeping = false
  const timer = setInterval(() => {
    if (sweeping) return
    sweeping = true
    void (async () => {
      sessions.sweep()
      for (const [owner, credential] of credentials) {
        if (!sessions.hasOwner(owner)) { forgetCredentials(owner); continue }
        const user = await executionUser(credential.token, credential.share).catch(() => null)
        if (!canOpenTerminal(user)) closeOwner(owner)
      }
    })().catch(() => { /* Per-operation authorization still fails closed. */ }).finally(() => { sweeping = false })
  }, 15_000)
  timer.unref()

  nsp.use((socket, next) => {
    void (async () => {
      const token = String(socket.handshake.auth?.token || '')
      const shareToken = socketShareToken(socket.handshake.auth)
      const share = shareToken ? await authenticateSessionShare(shareToken, String(socket.handshake.auth?.appAccessToken || '')) : undefined
      const user = await executionUser(token, share)
      if (!user || !canOpenTerminal(user)) throw new Error('terminal_forbidden')
      if (share) assertShareProfile(share, socket.handshake.query.profile)
      const profile = String(socket.handshake.query.profile || share?.share.profile || 'default')
      const source = String(socket.handshake.query.source || '')
      const sourceId = String(socket.handshake.query.sourceId || '')
      if (share) {
        if (source !== 'single' || sourceId !== share.share.session_id) throw new Error('terminal_invalid_context')
        socket.data.sessionShare = share
      }
      if (!['single', 'group'].includes(source) || !sourceId || sourceId.length > 200
        || !listProfileNamesFromDisk().includes(profile)) throw new Error('terminal_invalid_context')
      const context = { profile, source: source as TerminalContext['source'], sourceId }
      const resolved = resolveContext(context)
      if (!resolved || resolved.profile !== profile) throw new Error('terminal_invalid_context')
      socket.data.terminalContext = context
      socket.data.terminalScope = {
        ...context, userId: user.id, owner: share ? `share:${share.share.id}:${share.actor.id}` : `${user.id}:${createHash('sha256').update(token).digest('hex')}`,
      } satisfies TerminalScope
      if (closing) throw new Error('terminal_unavailable')
      next()
    })().catch(error => next(error instanceof Error ? error : new Error('terminal_forbidden')))
  })

  nsp.on('connection', (socket: Socket) => {
    const scope = socket.data.terminalScope as TerminalScope
    const context = socket.data.terminalContext as TerminalContext
    const token = String(socket.handshake.auth.token)
    const share = socket.data.sessionShare as SessionShareAccess | undefined
    // A refreshed App login may reconnect to the same PTY. Keep its current
    // credential instead of letting an expired, detached bridge kill it.
    if (share && credentials.has(scope.owner)) {
      forgetCredentials(scope.owner)
      credentials.set(scope.owner, { token, share, dispose: watchSessionShare(share, 'terminal', () => closeOwner(scope.owner)) })
    }
    const dispose = share ? watchSessionShare(share, 'terminal', () => {
      const current = credentials.get(scope.owner)?.share
      if (!current || current.appAccessToken === share.appAccessToken) closeOwner(scope.owner)
      else socket.disconnect(true)
    }) : undefined
    let queue = Promise.resolve()
    let pending = 0
    for (const operation of OPERATIONS) {
      socket.on(`terminal.${operation}`, (payload: any = {}, ack?: (value: unknown) => void) => {
        if (typeof ack !== 'function') return
        if (pending >= 32) { ack({ ok: false, error: 'terminal_busy' }); return }
        pending++
        queue = queue.then(async () => {
          if (!socket.connected || closing) throw new Error('terminal_disconnected')
          if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('terminal_invalid_request')
          const user = await executionUser(token, share).catch(() => null)
          if (!user || user.id !== scope.userId || !canOpenTerminal(user)) {
            sessions.closeOwner(scope.owner)
            throw new Error('terminal_forbidden')
          }
          if (!socket.connected || closing) throw new Error('terminal_disconnected')
          const resolved = resolveContext(context)
          if (!resolved || resolved.profile !== scope.profile) throw new Error('terminal_invalid_context')
          const id = String(payload.terminalId || '')
          const lease = String(payload.lease || '')
          let data: unknown = {}
          switch (operation) {
            case 'capabilities': data = { available: Boolean(pty), version: 1, outputPush: true, ...MOBILE_TERMINAL_LIMITS }; break
            case 'list': data = { terminals: sessions.list(scope) }; break
            case 'create': {
              const cwd = resolved.workspace || resolveTerminalCwd(getTerminalConfig(scope.profile), getProfileDir(scope.profile))
              try {
                if (!statSync(cwd).isDirectory()) throw new Error()
                accessSync(cwd, constants.R_OK | constants.X_OK)
              } catch { throw new Error('terminal_invalid_directory') }
              const terminal = sessions.create(scope, payload.requestId, cwd, findShell(), payload.cols, payload.rows)
              if (!credentials.has(scope.owner)) credentials.set(scope.owner, { token, share,
                dispose: share ? watchSessionShare(share, 'terminal', () => closeOwner(scope.owner)) : undefined })
              data = { terminal }; break
            }
            case 'attach': data = sessions.attach(scope, id, socket.id); break
            case 'read': {
              let batch = 0
              data = payload.stream === true
                ? sessions.stream(scope, id, socket.id, lease, payload.cursor, output => {
                  if (socket.connected) socket.emit('terminal.output', { terminalId: id, lease, batch: ++batch, ...output })
                })
                : sessions.read(scope, id, socket.id, lease, payload.cursor)
              break
            }
            case 'input': sessions.input(scope, id, socket.id, lease, payload.seq, payload.data); break
            case 'resize': sessions.resize(scope, id, socket.id, lease, payload.cols, payload.rows); break
            case 'detach': sessions.detach(scope, id, socket.id, lease); break
            case 'close': sessions.close(scope, id); break
          }
          ack({ ok: true, data })
        }).catch(error => {
          const message = error instanceof Error ? error.message : ''
          ack({ ok: false, error: /^terminal_[a-z_]+$/.test(message) ? message : 'terminal_failed' })
        }).finally(() => { pending-- })
      })
    }
    socket.on('disconnect', () => { dispose?.(); sessions.detachWriter(socket.id) })
  })

  return {
    close() {
      closing = true; clearInterval(timer)
      nsp.disconnectSockets(true); sessions.shutdown(); for (const owner of credentials.keys()) forgetCredentials(owner)
    },
  }
}
