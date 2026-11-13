import WebSocket, { WebSocketServer, type RawData } from 'ws'
import type { Server as HttpServer, IncomingMessage } from 'http'
import { randomUUID } from 'crypto'
import { createReadStream, createWriteStream, type WriteStream } from 'fs'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { isAbsolute, resolve as resolvePath } from 'path'
import { spawn } from 'child_process'
import { getDeviceRelation } from '../../repositories/devices-store'
import type { LanDeviceInfo } from './lan-pairing-discovery'
import { createDeviceSignature, getPublicSystemInfo, verifyDeviceSignature } from '../../public/system-info'
import { getTerminalConfig, validatePath } from '../files/file-provider'
import { getActiveProfileDir } from '../../public/profile-config'
import { logger } from '../../public/logging'
import { config } from '../../public/config'
import { parseUpgradeRequestUrl, shouldRejectUpgradeOrigin, writeBadUpgradeRequest, writeForbiddenOrigin } from '../../public/security'

const PEER_SOCKET_PATH = '/api/devices/peer-socket'
const REQUEST_TTL_MS = 5 * 60 * 1000
const FILE_CHUNK_SIZE = 64 * 1024
const CLIENT_RECONNECT_LIMIT = 5
const CLIENT_RECONNECT_BASE_MS = 1000
const HEARTBEAT_INTERVAL_MS = 30000
const EXEC_OUTPUT_LIMIT = 5 * 1024 * 1024
const EXEC_TIMEOUT_MS = 30000
const PEER_TERMINAL_MAX_PER_CONNECTION = boundedEnvInt('HERMES_LAN_PEER_MAX_TERMINALS', 4, 1, 32)
const PEER_TERMINAL_IDLE_MS = boundedEnvInt('HERMES_LAN_PEER_TERMINAL_IDLE_MS', 10 * 60 * 1000, 30_000, 24 * 60 * 60 * 1000)
const PEER_TERMINAL_BUFFER_BYTES = boundedEnvInt('HERMES_LAN_PEER_TERMINAL_BUFFER_BYTES', 1024 * 1024, 64 * 1024, 16 * 1024 * 1024)

let pty: any = null
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  pty = require('node-pty')
} catch (err) {
  logger.warn(err, '[lan-peer] node-pty failed to load; peer terminal disabled')
}

type PeerRole = 'server' | 'client'

type PeerJsonMessage = {
  type?: string
  request_id?: string
  terminal_id?: string
  transfer_id?: string
  path?: string
  data?: string
  command?: string
  args?: string[]
  cwd?: string
  cols?: number
  rows?: number
  shell?: string
  size?: number
  timeout_ms?: number
  exit_code?: number
  stdout?: string
  stderr?: string
  timed_out?: boolean
  message?: string
}

type TerminalSession = {
  id: string
  pty: {
    pid: number
    onData: (cb: (data: string) => void) => void
    onExit: (cb: (e: { exitCode: number }) => void) => void
    write: (data: string) => void
    kill: (signal?: string) => void
    resize: (cols: number, rows: number) => void
  }
  shell: string
  pid: number
  lastActiveAt: number
  idleTimer: NodeJS.Timeout | null
}

type UploadTransfer = {
  id: string
  path: string
  stream: WriteStream
}

type ClientPeerTarget = {
  device: LanDeviceInfo
  attempts: number
  reconnectTimer: NodeJS.Timeout | null
  disabled: boolean
}

type PendingRequest = {
  resolve: (msg: PeerJsonMessage) => void
  reject: (err: Error) => void
  successTypes: Set<string>
  errorTypes: Set<string>
  timer: NodeJS.Timeout
}

type PendingDownload = {
  chunks: Buffer[]
  resolve: (data: Buffer) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

type RemoteTerminal = {
  id: string
  buffer: string[]
  bufferBytes: number
  exitCode: number | null
}

export type LanPeerConnectionInfo = {
  id: string
  role: PeerRole
  device_id: string
  computer_name: string
  url: string
  connected_at: number
  local_terminal_sessions: number
  remote_terminal_sessions: number
  reconnect_attempts?: number
}

export type LanPeerTerminalInfo = {
  terminal_id: string
  pid: number
  shell: string
}

export type LanPeerRemoteTerminalSummary = {
  terminal_id: string
  buffered_bytes: number
  buffered_chunks: number
  exited: boolean
  exit_code: number | null
}

export type LanPeerLocalTerminalSummary = {
  terminal_id: string
  pid: number
  shell: string
  last_active_at: number
  idle_timeout_ms: number
}

export type LanPeerTerminalList = {
  remote_terminals: LanPeerRemoteTerminalSummary[]
  local_terminal_sessions: LanPeerLocalTerminalSummary[]
}

export type LanPeerTerminalReadResult = {
  terminal_id: string
  data: string
  exited: boolean
  exit_code: number | null
}

export type LanPeerExecResult = {
  stdout: string
  stderr: string
  exit_code: number | null
  timed_out: boolean
}

function now() {
  return Date.now()
}

function boundedEnvInt(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number(process.env[name])
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.floor(parsed)))
}

function rememberNonce(seenNonces: Map<string, number>, deviceId: string, nonce: string, timestamp: number): boolean {
  const current = now()
  for (const [key, expiresAt] of seenNonces) {
    if (expiresAt <= current) seenNonces.delete(key)
  }

  const key = `${deviceId}:${nonce}`
  if (seenNonces.has(key)) return false
  seenNonces.set(key, timestamp + REQUEST_TTL_MS)
  return true
}

function shellName(shell: string): string {
  return shell.split('/').pop() || shell
}

function findShell(): string {
  if (process.platform === 'win32') return 'powershell.exe'
  const candidates = [process.env.SHELL, '/bin/zsh', '/bin/bash'].filter(Boolean) as string[]
  return candidates.find(shell => existsSync(shell)) || '/bin/bash'
}

function resolveTerminalCwd(): string {
  const fallback = existsSync(getActiveProfileDir()) ? getActiveProfileDir() : homedir()
  const configured = getTerminalConfig().cwd?.trim()
  if (!configured) return fallback
  const cwd = isAbsolute(configured) ? configured : resolvePath(fallback, configured)
  return existsSync(cwd) ? cwd : fallback
}

function targetWsUrl(device: LanDeviceInfo): string {
  const base = device.url.replace(/\/$/, '')
  const url = new URL(base)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = PEER_SOCKET_PATH
  url.search = ''
  return url.toString()
}

function parseJsonMessage(raw: RawData): PeerJsonMessage | null {
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw)
  if (!text || text.charCodeAt(0) !== 0x7B) return null
  try {
    return JSON.parse(text) as PeerJsonMessage
  } catch {
    return null
  }
}

class LanPeerConnection {
  readonly id = randomUUID()
  readonly connectedAt = now()
  private terminalSessions = new Map<string, TerminalSession>()
  private remoteTerminals = new Map<string, RemoteTerminal>()
  private uploads = new Map<string, UploadTransfer>()
  private pendingRequests = new Map<string, PendingRequest>()
  private pendingDownloads = new Map<string, PendingDownload>()
  private heartbeatTimer: NodeJS.Timeout | null = null
  private alive = true
  private closed = false

  constructor(
    private readonly manager: LanPeerSocketManager,
    private readonly ws: WebSocket,
    readonly role: PeerRole,
    readonly deviceId: string,
    private readonly computerName: string,
    private readonly url: string,
  ) {
    this.ws.on('pong', () => {
      this.alive = true
    })
    this.ws.on('message', raw => this.handleMessage(raw))
    this.ws.on('close', () => this.close({ intentional: false }))
    this.ws.on('error', err => {
      logger.warn(err, '[lan-peer] websocket error')
      this.close({ intentional: false })
    })
    this.startHeartbeat()
    this.sendJson({
      type: 'peer.ready',
      connection_id: this.id,
      device_id: this.deviceId,
      role: this.role,
    })
  }

  info(): LanPeerConnectionInfo {
    return {
      id: this.id,
      role: this.role,
      device_id: this.deviceId,
      computer_name: this.computerName,
      url: this.url,
      connected_at: this.connectedAt,
      local_terminal_sessions: this.terminalSessions.size,
      remote_terminal_sessions: this.remoteTerminals.size,
      reconnect_attempts: this.role === 'client' ? this.manager.getReconnectAttempts(this.deviceId) : undefined,
    }
  }

  close(options: { intentional?: boolean } = {}) {
    if (this.closed) return
    this.closed = true
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }

    for (const session of this.terminalSessions.values()) this.disposeTerminalSession(session, { notify: false })
    this.terminalSessions.clear()
    this.remoteTerminals.clear()

    for (const upload of this.uploads.values()) {
      try { upload.stream.destroy() } catch { }
    }
    this.uploads.clear()

    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Peer connection closed'))
    }
    this.pendingRequests.clear()

    for (const pending of this.pendingDownloads.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Peer connection closed'))
    }
    this.pendingDownloads.clear()

    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      try { this.ws.close() } catch { }
    }
    this.manager.removeConnection(this.id)
    if (this.role === 'client' && !options.intentional) {
      this.manager.scheduleReconnect(this.deviceId)
    }
  }

  private startHeartbeat() {
    this.heartbeatTimer = setInterval(() => {
      if (this.ws.readyState !== WebSocket.OPEN) return
      if (!this.alive) {
        try { this.ws.terminate() } catch { }
        return
      }
      this.alive = false
      try { this.ws.ping() } catch { }
    }, HEARTBEAT_INTERVAL_MS)
    this.heartbeatTimer.unref?.()
  }

  private sendJson(payload: Record<string, unknown>) {
    if (this.ws.readyState !== WebSocket.OPEN) return
    this.ws.send(JSON.stringify(payload))
  }

  private disposeTerminalSession(session: TerminalSession, options: { notify?: boolean; exitCode?: number } = {}) {
    if (session.idleTimer) {
      clearTimeout(session.idleTimer)
      session.idleTimer = null
    }
    this.terminalSessions.delete(session.id)
    try { session.pty.kill() } catch { }
    if (options.notify) {
      this.sendJson({ type: 'terminal.exit', terminal_id: session.id, exit_code: options.exitCode ?? 0 })
    }
  }

  private touchTerminalSession(session: TerminalSession) {
    session.lastActiveAt = now()
    this.scheduleTerminalIdleTimeout(session, PEER_TERMINAL_IDLE_MS)
  }

  private scheduleTerminalIdleTimeout(session: TerminalSession, delayMs: number) {
    if (session.idleTimer) clearTimeout(session.idleTimer)
    session.idleTimer = setTimeout(() => {
      const current = this.terminalSessions.get(session.id)
      if (!current) return
      const remainingMs = PEER_TERMINAL_IDLE_MS - (now() - current.lastActiveAt)
      if (remainingMs > 0) {
        this.scheduleTerminalIdleTimeout(current, remainingMs)
        return
      }
      logger.info(
        { connectionId: this.id, terminalId: current.id, idleMs: PEER_TERMINAL_IDLE_MS },
        '[lan-peer] closing idle terminal',
      )
      this.disposeTerminalSession(current, { notify: true, exitCode: 0 })
    }, delayMs)
    session.idleTimer.unref?.()
  }

  private request(
    payload: Record<string, unknown>,
    successTypes: string[],
    errorTypes: string[] = ['error'],
    timeoutMs = 30000,
  ): Promise<PeerJsonMessage> {
    if (this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Peer connection is not open'))
    }

    const requestId = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId)
        reject(new Error('Peer request timed out'))
      }, timeoutMs)
      timer.unref?.()
      this.pendingRequests.set(requestId, {
        resolve,
        reject,
        successTypes: new Set(successTypes),
        errorTypes: new Set(errorTypes),
        timer,
      })
      this.sendJson({ ...payload, request_id: requestId })
    })
  }

  async createRemoteTerminal(options: { shell?: string; cols?: number; rows?: number } = {}): Promise<LanPeerTerminalInfo> {
    const response = await this.request({
      type: 'terminal.create',
      shell: options.shell,
      cols: options.cols,
      rows: options.rows,
    }, ['terminal.created'], ['terminal.error', 'error'])

    const terminalId = response.terminal_id || ''
    if (!terminalId) throw new Error('Peer did not return a terminal id')
    this.remoteTerminals.set(terminalId, { id: terminalId, buffer: [], bufferBytes: 0, exitCode: null })
    return {
      terminal_id: terminalId,
      pid: Number((response as any).pid || 0),
      shell: String((response as any).shell || ''),
    }
  }

  listTerminals(): LanPeerTerminalList {
    return {
      remote_terminals: [...this.remoteTerminals.values()].map(terminal => ({
        terminal_id: terminal.id,
        buffered_bytes: terminal.bufferBytes,
        buffered_chunks: terminal.buffer.length,
        exited: terminal.exitCode !== null,
        exit_code: terminal.exitCode,
      })),
      local_terminal_sessions: [...this.terminalSessions.values()].map(session => ({
        terminal_id: session.id,
        pid: session.pid,
        shell: shellName(session.shell),
        last_active_at: session.lastActiveAt,
        idle_timeout_ms: PEER_TERMINAL_IDLE_MS,
      })),
    }
  }

  writeRemoteTerminal(terminalId: string, data: string) {
    if (!this.remoteTerminals.has(terminalId)) throw new Error('Remote terminal not found')
    this.sendJson({ type: 'terminal.input', terminal_id: terminalId, data })
  }

  resizeRemoteTerminal(terminalId: string, cols: number, rows: number) {
    if (!this.remoteTerminals.has(terminalId)) throw new Error('Remote terminal not found')
    this.sendJson({ type: 'terminal.resize', terminal_id: terminalId, cols, rows })
  }

  closeRemoteTerminal(terminalId: string) {
    if (!this.remoteTerminals.has(terminalId)) throw new Error('Remote terminal not found')
    this.sendJson({ type: 'terminal.close', terminal_id: terminalId })
    this.remoteTerminals.delete(terminalId)
  }

  readRemoteTerminal(terminalId: string): LanPeerTerminalReadResult {
    const terminal = this.remoteTerminals.get(terminalId)
    if (!terminal) throw new Error('Remote terminal not found')
    const data = terminal.buffer.join('')
    terminal.buffer.length = 0
    terminal.bufferBytes = 0
    return {
      terminal_id: terminalId,
      data,
      exited: terminal.exitCode !== null,
      exit_code: terminal.exitCode,
    }
  }

  async execRemoteCommand(options: {
    command: string
    args?: string[]
    cwd?: string
    timeoutMs?: number
  }): Promise<LanPeerExecResult> {
    const response = await this.request({
      type: 'terminal.exec',
      command: options.command,
      args: options.args || [],
      cwd: options.cwd,
      timeout_ms: options.timeoutMs,
    }, ['terminal.exec.result'], ['terminal.exec.error', 'error'], Math.max(1000, (options.timeoutMs || 30000) + 1000))
    return {
      stdout: String(response.stdout || ''),
      stderr: String(response.stderr || ''),
      exit_code: typeof response.exit_code === 'number' ? response.exit_code : null,
      timed_out: Boolean(response.timed_out),
    }
  }

  downloadFileToBuffer(path: string, timeoutMs = 60000): Promise<Buffer> {
    if (this.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Peer connection is not open'))
    const transferId = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingDownloads.delete(transferId)
        reject(new Error('Peer file download timed out'))
      }, timeoutMs)
      timer.unref?.()
      this.pendingDownloads.set(transferId, { chunks: [], resolve, reject, timer })
      this.sendJson({ type: 'file.download', transfer_id: transferId, path })
    })
  }

  async uploadFileFromBuffer(path: string, data: Buffer, timeoutMs = 60000): Promise<{ path: string; size: number }> {
    const transferId = randomUUID()
    await this.request({ type: 'file.upload.start', transfer_id: transferId, path }, ['file.upload.ready'], ['file.error', 'error'], timeoutMs)
    for (let offset = 0; offset < data.length; offset += FILE_CHUNK_SIZE) {
      this.sendJson({
        type: 'file.upload.chunk',
        transfer_id: transferId,
        data: data.subarray(offset, offset + FILE_CHUNK_SIZE).toString('base64'),
      })
    }
    await this.request({ type: 'file.upload.complete', transfer_id: transferId }, ['file.upload.complete'], ['file.error', 'error'], timeoutMs)
    return { path, size: data.length }
  }

  private handleMessage(raw: RawData) {
    const msg = parseJsonMessage(raw)
    if (!msg?.type) {
      this.sendJson({ type: 'error', message: 'Invalid peer message' })
      return
    }

    if (this.handlePendingMessage(msg)) return

    switch (msg.type) {
      case 'terminal.data':
        this.bufferRemoteTerminalData(msg)
        break
      case 'terminal.exit':
        this.markRemoteTerminalExit(msg)
        break
      case 'terminal.create':
        if (!this.canServeLocalToolRequest(msg)) break
        this.createTerminal(msg)
        break
      case 'terminal.input':
        if (!this.canServeLocalToolRequest(msg)) break
        this.writeTerminal(msg)
        break
      case 'terminal.resize':
        if (!this.canServeLocalToolRequest(msg)) break
        this.resizeTerminal(msg)
        break
      case 'terminal.close':
        if (!this.canServeLocalToolRequest(msg)) break
        this.closeTerminal(msg)
        break
      case 'terminal.exec':
        if (!this.canServeLocalToolRequest(msg)) break
        this.execCommand(msg)
        break
      case 'file.download':
        if (!this.canServeLocalToolRequest(msg)) break
        this.downloadFile(msg)
        break
      case 'file.download.started':
        break
      case 'file.download.chunk':
      case 'file.download.complete':
      case 'file.error':
        this.handleFileTransferMessage(msg)
        break
      case 'file.upload.start':
        if (!this.canServeLocalToolRequest(msg)) break
        this.startUpload(msg)
        break
      case 'file.upload.chunk':
        if (!this.canServeLocalToolRequest(msg)) break
        this.writeUploadChunk(msg)
        break
      case 'file.upload.complete':
        if (!this.canServeLocalToolRequest(msg)) break
        this.completeUpload(msg)
        break
      default:
        this.sendJson({ type: 'error', request_id: msg.request_id, message: `Unsupported peer message: ${msg.type}` })
    }
  }

  private canServeLocalToolRequest(msg: PeerJsonMessage): boolean {
    if (this.role === 'server') return true
    const message = 'Peer connection is not authorized to control this device'
    if (msg.type === 'terminal.create') {
      this.sendJson({ type: 'terminal.error', request_id: msg.request_id, message })
      return false
    }
    if (msg.type === 'terminal.exec') {
      this.sendJson({ type: 'terminal.exec.error', request_id: msg.request_id, message })
      return false
    }
    if (msg.type?.startsWith('file.')) {
      this.sendJson({ type: 'file.error', request_id: msg.request_id, transfer_id: msg.transfer_id, message })
      return false
    }
    this.sendJson({ type: 'error', request_id: msg.request_id, message })
    return false
  }

  private handlePendingMessage(msg: PeerJsonMessage): boolean {
    if (msg.request_id) {
      const pending = this.pendingRequests.get(msg.request_id)
      if (pending) {
        if (pending.successTypes.has(msg.type || '')) {
          clearTimeout(pending.timer)
          this.pendingRequests.delete(msg.request_id)
          pending.resolve(msg)
          return true
        }
        if (pending.errorTypes.has(msg.type || '')) {
          clearTimeout(pending.timer)
          this.pendingRequests.delete(msg.request_id)
          pending.reject(new Error(msg.message || `Peer request failed: ${msg.type}`))
          return true
        }
      }
    }
    return false
  }

  private bufferRemoteTerminalData(msg: PeerJsonMessage) {
    const terminal = msg.terminal_id ? this.remoteTerminals.get(msg.terminal_id) : null
    if (!terminal || typeof msg.data !== 'string') return
    const bytes = Buffer.byteLength(msg.data, 'utf8')
    terminal.buffer.push(msg.data)
    terminal.bufferBytes += bytes
    while (terminal.bufferBytes > PEER_TERMINAL_BUFFER_BYTES && terminal.buffer.length > 1) {
      const removed = terminal.buffer.shift() || ''
      terminal.bufferBytes -= Buffer.byteLength(removed, 'utf8')
    }
  }

  private markRemoteTerminalExit(msg: PeerJsonMessage) {
    const terminal = msg.terminal_id ? this.remoteTerminals.get(msg.terminal_id) : null
    if (!terminal) return
    terminal.exitCode = typeof msg.exit_code === 'number' ? msg.exit_code : 0
  }

  private handleFileTransferMessage(msg: PeerJsonMessage): boolean {
    const transfer = msg.transfer_id ? this.pendingDownloads.get(msg.transfer_id) : null
    if (!transfer) return false

    if (msg.type === 'file.download.chunk' && typeof msg.data === 'string') {
      transfer.chunks.push(Buffer.from(msg.data, 'base64'))
      return true
    }
    if (msg.type === 'file.download.complete') {
      clearTimeout(transfer.timer)
      this.pendingDownloads.delete(msg.transfer_id!)
      transfer.resolve(Buffer.concat(transfer.chunks))
      return true
    }
    if (msg.type === 'file.error') {
      clearTimeout(transfer.timer)
      this.pendingDownloads.delete(msg.transfer_id!)
      transfer.reject(new Error(msg.message || 'Peer file transfer failed'))
      return true
    }
    return false
  }

  private createTerminal(msg: PeerJsonMessage) {
    if (!pty) {
      this.sendJson({ type: 'terminal.error', request_id: msg.request_id, message: 'Terminal is not available' })
      return
    }
    if (this.terminalSessions.size >= PEER_TERMINAL_MAX_PER_CONNECTION) {
      this.sendJson({
        type: 'terminal.error',
        request_id: msg.request_id,
        message: `Terminal limit reached (${PEER_TERMINAL_MAX_PER_CONNECTION} per peer connection)`,
      })
      return
    }

    const shell = msg.shell || findShell()
    let ptyProcess: TerminalSession['pty']
    try {
      ptyProcess = pty.spawn(shell, [], {
        name: 'xterm-color',
        cols: Math.max(1, msg.cols || 80),
        rows: Math.max(1, msg.rows || 24),
        cwd: resolveTerminalCwd(),
      })
    } catch (err: any) {
      this.sendJson({ type: 'terminal.error', request_id: msg.request_id, message: err?.message || 'Failed to create terminal' })
      return
    }

    const id = randomUUID()
    const session: TerminalSession = {
      id,
      pty: ptyProcess,
      shell,
      pid: ptyProcess.pid,
      lastActiveAt: now(),
      idleTimer: null,
    }
    this.terminalSessions.set(id, session)
    this.touchTerminalSession(session)

    session.pty.onData((data: string) => {
      if (!this.terminalSessions.has(id)) return
      this.touchTerminalSession(session)
      this.sendJson({ type: 'terminal.data', terminal_id: id, data })
    })
    session.pty.onExit(({ exitCode }) => {
      if (!this.terminalSessions.has(id)) return
      if (session.idleTimer) clearTimeout(session.idleTimer)
      this.terminalSessions.delete(id)
      this.sendJson({ type: 'terminal.exit', terminal_id: id, exit_code: exitCode })
    })

    this.sendJson({
      type: 'terminal.created',
      request_id: msg.request_id,
      terminal_id: id,
      pid: session.pid,
      shell: shellName(shell),
    })
  }

  private writeTerminal(msg: PeerJsonMessage) {
    const session = msg.terminal_id ? this.terminalSessions.get(msg.terminal_id) : null
    if (!session || typeof msg.data !== 'string') return
    this.touchTerminalSession(session)
    session.pty.write(msg.data)
  }

  private resizeTerminal(msg: PeerJsonMessage) {
    const session = msg.terminal_id ? this.terminalSessions.get(msg.terminal_id) : null
    if (!session) return
    this.touchTerminalSession(session)
    try {
      session.pty.resize(Math.max(1, msg.cols || 80), Math.max(1, msg.rows || 24))
    } catch { }
  }

  private closeTerminal(msg: PeerJsonMessage) {
    const session = msg.terminal_id ? this.terminalSessions.get(msg.terminal_id) : null
    if (!session) return
    this.disposeTerminalSession(session, { notify: false })
  }

  private execCommand(msg: PeerJsonMessage) {
    const command = typeof msg.command === 'string' ? msg.command.trim() : ''
    const args = Array.isArray(msg.args) ? msg.args.filter(arg => typeof arg === 'string') : []
    if (!command) {
      this.sendJson({ type: 'terminal.exec.error', request_id: msg.request_id, message: 'Missing command' })
      return
    }

    let cwd = resolveTerminalCwd()
    if (msg.cwd) {
      try {
        const resolved = validatePath(msg.cwd)
        cwd = existsSync(resolved) ? resolved : cwd
      } catch (err: any) {
        this.sendJson({ type: 'terminal.exec.error', request_id: msg.request_id, message: err?.message || 'Invalid cwd' })
        return
      }
    }

    const timeoutMs = Math.max(1000, Math.min(Number(msg.timeout_ms) || EXEC_TIMEOUT_MS, 10 * 60 * 1000))
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let stdoutLength = 0
    let stderrLength = 0
    let settled = false
    let timedOut = false

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, args, { cwd, shell: false, windowsHide: true })
    } catch (err: any) {
      this.sendJson({ type: 'terminal.exec.error', request_id: msg.request_id, message: err?.message || 'Failed to start command' })
      return
    }

    const finish = (exitCode: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      this.sendJson({
        type: 'terminal.exec.result',
        request_id: msg.request_id,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        exit_code: exitCode,
        timed_out: timedOut,
      })
    }

    const append = (chunks: Buffer[], currentLength: number, chunk: Buffer): number => {
      if (currentLength >= EXEC_OUTPUT_LIMIT) return currentLength
      const remaining = EXEC_OUTPUT_LIMIT - currentLength
      const next = chunk.subarray(0, remaining)
      chunks.push(next)
      return currentLength + next.length
    }

    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill() } catch { }
      finish(null)
    }, timeoutMs)
    timer.unref?.()

    child.stdout?.on('data', chunk => {
      stdoutLength = append(stdoutChunks, stdoutLength, Buffer.from(chunk))
    })
    child.stderr?.on('data', chunk => {
      stderrLength = append(stderrChunks, stderrLength, Buffer.from(chunk))
    })
    child.on('error', err => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      this.sendJson({ type: 'terminal.exec.error', request_id: msg.request_id, message: err.message })
    })
    child.on('close', code => finish(code))
  }

  private downloadFile(msg: PeerJsonMessage) {
    if (!msg.transfer_id || !msg.path) {
      this.sendJson({ type: 'file.error', request_id: msg.request_id, transfer_id: msg.transfer_id, message: 'Missing file path' })
      return
    }

    let filePath: string
    try {
      filePath = validatePath(msg.path)
    } catch (err: any) {
      this.sendJson({ type: 'file.error', request_id: msg.request_id, transfer_id: msg.transfer_id, message: err?.message || 'Invalid file path' })
      return
    }

    const stream = createReadStream(filePath, { highWaterMark: FILE_CHUNK_SIZE })
    this.sendJson({ type: 'file.download.started', request_id: msg.request_id, transfer_id: msg.transfer_id })
    stream.on('data', chunk => {
      this.sendJson({
        type: 'file.download.chunk',
        transfer_id: msg.transfer_id,
        data: Buffer.from(chunk).toString('base64'),
      })
    })
    stream.on('error', err => {
      this.sendJson({ type: 'file.error', transfer_id: msg.transfer_id, message: err.message })
    })
    stream.on('end', () => {
      this.sendJson({ type: 'file.download.complete', transfer_id: msg.transfer_id })
    })
  }

  private startUpload(msg: PeerJsonMessage) {
    if (!msg.transfer_id || !msg.path) {
      this.sendJson({ type: 'file.error', request_id: msg.request_id, transfer_id: msg.transfer_id, message: 'Missing upload path' })
      return
    }

    let filePath: string
    try {
      filePath = validatePath(msg.path)
    } catch (err: any) {
      this.sendJson({ type: 'file.error', request_id: msg.request_id, transfer_id: msg.transfer_id, message: err?.message || 'Invalid upload path' })
      return
    }

    const stream = createWriteStream(filePath)
    stream.on('error', err => {
      this.uploads.delete(msg.transfer_id!)
      this.sendJson({ type: 'file.error', transfer_id: msg.transfer_id, message: err.message })
    })
    this.uploads.set(msg.transfer_id, { id: msg.transfer_id, path: filePath, stream })
    this.sendJson({ type: 'file.upload.ready', request_id: msg.request_id, transfer_id: msg.transfer_id })
  }

  private writeUploadChunk(msg: PeerJsonMessage) {
    const upload = msg.transfer_id ? this.uploads.get(msg.transfer_id) : null
    if (!upload || typeof msg.data !== 'string') return
    upload.stream.write(Buffer.from(msg.data, 'base64'))
  }

  private completeUpload(msg: PeerJsonMessage) {
    const upload = msg.transfer_id ? this.uploads.get(msg.transfer_id) : null
    if (!upload) return
    upload.stream.end(() => {
      this.uploads.delete(upload.id)
      this.sendJson({ type: 'file.upload.complete', request_id: msg.request_id, transfer_id: upload.id, path: upload.path })
    })
  }
}

export class LanPeerSocketManager {
  private readonly wss = new WebSocketServer({ noServer: true })
  private readonly connections = new Map<string, LanPeerConnection>()
  private readonly clientTargets = new Map<string, ClientPeerTarget>()
  private readonly seenNonces = new Map<string, number>()
  private setupDone = false

  setupServer(httpServers: HttpServer | HttpServer[]) {
    if (this.setupDone) return
    this.setupDone = true
    const servers = Array.isArray(httpServers) ? httpServers : [httpServers]

    servers.forEach(httpServer => {
      httpServer.on('upgrade', async (req, socket, head) => {
        const url = parseUpgradeRequestUrl(req)
        if (!url) { writeBadUpgradeRequest(socket); return }
        if (url.pathname !== PEER_SOCKET_PATH) return

        if (shouldRejectUpgradeOrigin(req, config.corsOrigins)) {
          writeForbiddenOrigin(socket)
          return
        }

        const auth = await this.authenticateUpgrade(url, req)
        if (!auth.ok) {
          socket.write(`HTTP/1.1 ${auth.status} ${auth.message}\r\n\r\n`)
          socket.destroy()
          return
        }

        this.wss.handleUpgrade(req, socket, head, ws => {
          const connection = new LanPeerConnection(
            this,
            ws,
            'server',
            auth.device.id,
            auth.device.computerName,
            auth.device.url,
          )
          this.connections.set(connection.id, connection)
          this.wss.emit('connection', ws, req)
        })
      })
    })
  }

  close(): void {
    for (const target of this.clientTargets.values()) {
      target.disabled = true
      if (target.reconnectTimer) clearTimeout(target.reconnectTimer)
    }
    for (const connection of this.connections.values()) connection.close({ intentional: true })
    this.clientTargets.clear()
    this.wss.close()
  }

  async connectToDevice(device: LanDeviceInfo): Promise<LanPeerConnectionInfo> {
    const existing = this.findConnectionByDevice(device.id, 'client')
    if (existing) return existing.info()

    const target = this.getOrCreateClientTarget(device)
    target.device = device
    target.disabled = false
    if (target.reconnectTimer) {
      clearTimeout(target.reconnectTimer)
      target.reconnectTimer = null
    }

    const connection = await this.openClientConnection(device)
    target.attempts = 0
    return connection.info()
  }

  private async openClientConnection(device: LanDeviceInfo): Promise<LanPeerConnection> {
    const localInfo = await getPublicSystemInfo()
    const timestamp = now()
    const nonce = randomUUID()
    const signature = await createDeviceSignature(nonce, timestamp)
    const url = new URL(targetWsUrl(device))
    url.searchParams.set('device_id', localInfo.device_id)
    url.searchParams.set('device_public_key', localInfo.device_public_key)
    url.searchParams.set('computer_name', localInfo.computer_name)
    url.searchParams.set('timestamp', String(timestamp))
    url.searchParams.set('nonce', nonce)
    url.searchParams.set('signature', signature)

    const ws = new WebSocket(url)
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        ws.close()
        reject(new Error('Peer socket connection timeout'))
      }, 5000)
      ws.once('open', () => {
        clearTimeout(timeout)
        resolve()
      })
      ws.once('error', err => {
        clearTimeout(timeout)
        reject(err)
      })
    })

    const connection = new LanPeerConnection(this, ws, 'client', device.id, device.computer_name, device.url)
    this.connections.set(connection.id, connection)
    return connection
  }

  listConnections(): LanPeerConnectionInfo[] {
    return [...this.connections.values()]
      .map(connection => connection.info())
      .sort((a, b) => b.connected_at - a.connected_at)
  }

  getConnection(connectionId: string): LanPeerConnection | null {
    return this.connections.get(connectionId) || null
  }

  disconnect(connectionId: string): boolean {
    const connection = this.connections.get(connectionId)
    if (!connection) return false
    if (connection.role === 'client') this.disableClientReconnect(connection.deviceId)
    connection.close({ intentional: true })
    return true
  }

  disconnectDevice(deviceId: string): number {
    this.disableClientReconnect(deviceId)
    const connections = [...this.connections.values()].filter(connection => connection.deviceId === deviceId)
    connections.forEach(connection => connection.close({ intentional: true }))
    return connections.length
  }

  removeConnection(connectionId: string) {
    this.connections.delete(connectionId)
  }

  getReconnectAttempts(deviceId: string): number {
    return this.clientTargets.get(deviceId)?.attempts || 0
  }

  scheduleReconnect(deviceId: string) {
    const target = this.clientTargets.get(deviceId)
    if (!target || target.disabled) return
    if (this.findConnectionByDevice(deviceId, 'client')) return
    if (target.reconnectTimer) return
    if (target.attempts >= CLIENT_RECONNECT_LIMIT) {
      logger.warn({ deviceId }, '[lan-peer] client reconnect limit reached')
      return
    }

    target.attempts += 1
    const delay = CLIENT_RECONNECT_BASE_MS * 2 ** (target.attempts - 1)
    target.reconnectTimer = setTimeout(() => {
      target.reconnectTimer = null
      void this.openClientConnection(target.device)
        .then(() => {
          target.attempts = 0
        })
        .catch(err => {
          logger.warn({ err, deviceId, attempt: target.attempts }, '[lan-peer] client reconnect failed')
          this.scheduleReconnect(deviceId)
        })
    }, delay)
    target.reconnectTimer.unref?.()
  }

  private getOrCreateClientTarget(device: LanDeviceInfo): ClientPeerTarget {
    let target = this.clientTargets.get(device.id)
    if (!target) {
      target = {
        device,
        attempts: 0,
        reconnectTimer: null,
        disabled: false,
      }
      this.clientTargets.set(device.id, target)
    }
    return target
  }

  private disableClientReconnect(deviceId: string) {
    const target = this.clientTargets.get(deviceId)
    if (!target) return
    target.disabled = true
    if (target.reconnectTimer) {
      clearTimeout(target.reconnectTimer)
      target.reconnectTimer = null
    }
  }

  private findConnectionByDevice(deviceId: string, role?: PeerRole): LanPeerConnection | null {
    return [...this.connections.values()].find(connection => (
      connection.deviceId === deviceId && (!role || connection.role === role)
    )) || null
  }

  private async authenticateUpgrade(url: URL, req: IncomingMessage): Promise<
    | { ok: true; device: { id: string; computerName: string; url: string } }
    | { ok: false; status: number; message: string }
  > {
    const deviceId = url.searchParams.get('device_id')?.trim() || ''
    const publicKey = url.searchParams.get('device_public_key') || ''
    const timestamp = Number(url.searchParams.get('timestamp') || '')
    const nonce = url.searchParams.get('nonce') || ''
    const signature = url.searchParams.get('signature') || ''
    const computerName = url.searchParams.get('computer_name') || ''

    if (!deviceId || !publicKey || !Number.isFinite(timestamp) || !nonce || !signature) {
      return { ok: false, status: 400, message: 'Bad Request' }
    }
    if (Math.abs(now() - timestamp) > REQUEST_TTL_MS) {
      return { ok: false, status: 400, message: 'Expired Request' }
    }
    if (!verifyDeviceSignature({ device_id: deviceId, device_public_key: publicKey, nonce, timestamp, signature })) {
      return { ok: false, status: 401, message: 'Unauthorized' }
    }
    if (!rememberNonce(this.seenNonces, deviceId, nonce, timestamp)) {
      return { ok: false, status: 409, message: 'Replay Request' }
    }

    const relation = getDeviceRelation(deviceId)
    if (relation?.inbound_status !== 'approved') {
      return { ok: false, status: 403, message: 'Forbidden' }
    }

    const host = req.socket.remoteAddress?.startsWith('::ffff:')
      ? req.socket.remoteAddress.slice(7)
      : req.socket.remoteAddress || ''
    return {
      ok: true,
      device: {
        id: deviceId,
        computerName,
        url: host ? `ws://${host}` : '',
      },
    }
  }
}

let singleton: LanPeerSocketManager | null = null

export function getLanPeerSocketManager(): LanPeerSocketManager {
  if (!singleton) singleton = new LanPeerSocketManager()
  return singleton
}

export function getLanPeerSocketPath(): string {
  return PEER_SOCKET_PATH
}
