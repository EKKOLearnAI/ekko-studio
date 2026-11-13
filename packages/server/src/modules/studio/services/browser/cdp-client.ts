/**
 * Minimal CDP client over `--remote-debugging-pipe` (spec-03, decision 1).
 *
 * Framing: every message written to the pipe is `JSON.stringify(payload) + '\0'`;
 * reads split on the same `\0`. The reader keeps a byte buffer, so a message
 * split across chunks (or a chunk holding several messages) works, and a
 * multi-byte UTF-8 sequence is never decoded until its message is complete.
 *
 * Zero new dependencies: no `ws`, no CDP library. Responses are matched by an
 * incrementing `id`; events are routed per `sessionId`.
 *
 * Logging never includes the CDP payload — only the method name, the session id
 * and the duration.
 */

import type { Readable, Writable } from 'stream'
import { logger } from '../../public/logging'
import type { BrowserCdpStreams } from './types'

export const DEFAULT_CDP_COMMAND_TIMEOUT_MS = 30_000
const MAX_INBOUND_BUFFER_BYTES = 32 * 1024 * 1024

export interface CdpProtocolErrorShape {
  code: number
  message: string
  data?: unknown
}

export class CdpProtocolError extends Error {
  readonly method: string
  readonly code: number
  readonly data?: unknown

  constructor(method: string, error: CdpProtocolErrorShape) {
    super(`${method} failed (${error.code}): ${error.message}`)
    this.name = 'CdpProtocolError'
    this.method = method
    this.code = error.code
    this.data = error.data
  }
}

export class CdpTimeoutError extends Error {
  readonly method: string
  readonly timeoutMs: number

  constructor(method: string, timeoutMs: number) {
    super(`${method} timed out after ${timeoutMs}ms`)
    this.name = 'CdpTimeoutError'
    this.method = method
    this.timeoutMs = timeoutMs
  }
}

export class CdpClosedError extends Error {
  constructor(reason: string) {
    super(`CDP connection closed: ${reason}`)
    this.name = 'CdpClosedError'
  }
}

export interface CdpEventMeta {
  sessionId?: string
  method: string
}

export type CdpEventHandler<T = any> = (params: T, meta: CdpEventMeta) => void

export interface CdpClientOptions {
  streams: BrowserCdpStreams
  /** Per-command timeout. Default 30s. */
  commandTimeoutMs?: number
  /** Injected for the command-duration log lines. */
  now?: () => number
}

interface PendingCommand {
  method: string
  sessionId?: string
  startedAt: number
  timer: NodeJS.Timeout
  resolve: (value: any) => void
  reject: (error: Error) => void
}

interface CdpResponseMessage {
  id?: number
  method?: string
  params?: unknown
  sessionId?: string
  result?: unknown
  error?: CdpProtocolErrorShape
}

export class CdpClient {
  private readonly options: CdpClientOptions
  private readonly read: Readable
  private readonly write: Writable
  private readonly now: () => number
  private buffer: Buffer = Buffer.alloc(0)
  private nextId = 1
  private readonly pending = new Map<number, PendingCommand>()
  private readonly listeners = new Map<string, Set<CdpEventHandler>>()
  private disposed = false
  private closedReason: string | null = null

  constructor(options: CdpClientOptions) {
    this.options = options
    this.read = options.streams.read
    this.write = options.streams.write
    this.now = options.now ?? (() => Date.now())

    this.read.on('data', this.handleData)
    this.read.on('end', this.handleClose)
    this.read.on('close', this.handleClose)
    this.read.on('error', this.handleStreamError)
    this.write.on('error', this.handleStreamError)
  }

  get isClosed(): boolean {
    return this.closedReason !== null || this.disposed
  }

  get pendingCount(): number {
    return this.pending.size
  }

  /**
   * Send a command. `sessionId` attaches it to a flattened target session.
   */
  send<T = any>(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<T> {
    if (this.disposed) return Promise.reject(new CdpClosedError('client disposed'))
    if (this.closedReason) return Promise.reject(new CdpClosedError(this.closedReason))

    const id = this.nextId++
    const startedAt = this.now()
    const timeoutMs = this.options.commandTimeoutMs ?? DEFAULT_CDP_COMMAND_TIMEOUT_MS

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new CdpTimeoutError(method, timeoutMs))
      }, timeoutMs)
      timer.unref?.()

      this.pending.set(id, {
        method,
        sessionId,
        startedAt,
        timer,
        resolve,
        reject,
      })

      const payload: Record<string, unknown> = { id, method }
      if (params !== undefined) payload.params = params
      if (sessionId) payload.sessionId = sessionId

      try {
        this.writeMessage(payload)
      } catch (err) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  /** Subscribe to a CDP event; returns an unsubscribe function. */
  on<T = any>(method: string, handler: CdpEventHandler<T>): () => void {
    let handlers = this.listeners.get(method)
    if (!handlers) {
      handlers = new Set()
      this.listeners.set(method, handlers)
    }
    handlers.add(handler as CdpEventHandler)
    return () => this.off(method, handler as CdpEventHandler)
  }

  off(method: string, handler: CdpEventHandler): void {
    const handlers = this.listeners.get(method)
    if (!handlers) return
    handlers.delete(handler)
    if (handlers.size === 0) this.listeners.delete(method)
  }

  /** Drop every listener, reject pending commands and detach from the pipe. */
  dispose(reason = 'disposed'): void {
    if (this.disposed) return
    this.disposed = true
    this.listeners.clear()
    this.rejectAllPending(reason)
    this.read.removeListener('data', this.handleData)
    this.read.removeListener('end', this.handleClose)
    this.read.removeListener('close', this.handleClose)
    this.read.removeListener('error', this.handleStreamError)
    this.write.removeListener('error', this.handleStreamError)
    this.buffer = Buffer.alloc(0)
  }

  private writeMessage(payload: Record<string, unknown>): void {
    this.write.write(`${JSON.stringify(payload)}\0`)
  }

  private handleData = (chunk: Buffer | string): void => {
    const incoming = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
    this.buffer = this.buffer.length === 0 ? incoming : Buffer.concat([this.buffer, incoming])

    if (this.buffer.length > MAX_INBOUND_BUFFER_BYTES) {
      const reason = `inbound buffer exceeded ${MAX_INBOUND_BUFFER_BYTES} bytes`
      this.buffer = Buffer.alloc(0)
      this.handleClose(reason)
      return
    }

    let separator = this.buffer.indexOf(0)
    while (separator !== -1) {
      const raw = this.buffer.subarray(0, separator)
      this.buffer = this.buffer.subarray(separator + 1)
      if (raw.length > 0) this.handleRawMessage(raw)
      separator = this.buffer.indexOf(0)
    }
  }

  private handleRawMessage(raw: Buffer): void {
    let message: CdpResponseMessage
    try {
      message = JSON.parse(raw.toString('utf8')) as CdpResponseMessage
    } catch (err) {
      // A malformed frame must not take the connection down; log and drop it.
      logger.warn(err, '[cdp] dropped a malformed frame')
      return
    }
    if (!message || typeof message !== 'object') return

    if (typeof message.id === 'number') {
      this.handleResponse(message)
      return
    }
    if (typeof message.method === 'string') {
      this.handleEvent(message)
    }
  }

  private handleResponse(message: CdpResponseMessage): void {
    const id = message.id as number
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    clearTimeout(pending.timer)

    const durationMs = this.now() - pending.startedAt
    logger.debug(
      '[cdp] %s done in %dms session=%s',
      pending.method,
      durationMs,
      pending.sessionId || '-',
    )

    if (message.error) {
      pending.reject(new CdpProtocolError(pending.method, message.error))
      return
    }
    pending.resolve(message.result)
  }

  private handleEvent(message: CdpResponseMessage): void {
    const handlers = this.listeners.get(message.method as string)
    if (!handlers || handlers.size === 0) return
    const meta: CdpEventMeta = {
      method: message.method as string,
      sessionId: message.sessionId,
    }
    for (const handler of [...handlers]) {
      try {
        handler(message.params, meta)
      } catch (err) {
        logger.warn(err, '[cdp] event handler failed: %s', meta.method)
      }
    }
  }

  private handleStreamError = (err: Error): void => {
    this.handleClose(err?.message || 'stream error')
  }

  private handleClose = (reason?: string | Event): void => {
    if (this.disposed) return
    if (typeof reason === 'string' && reason) {
      this.closedReason = reason
    } else if (!this.closedReason) {
      this.closedReason = 'pipe closed'
    }
    this.rejectAllPending(this.closedReason)
  }

  private rejectAllPending(reason: string): void {
    if (this.pending.size === 0) return
    const entries = [...this.pending.values()]
    this.pending.clear()
    for (const entry of entries) {
      clearTimeout(entry.timer)
      entry.reject(new CdpClosedError(reason))
    }
  }
}
