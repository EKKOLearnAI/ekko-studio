import { StudioError, STUDIO_ERROR_CODES, serializeStudioError, type StudioErrorData } from './errors'
import type { JsonValue } from './types'

export type RpcFrame =
  | { kind: 'request'; id: number; method: string; params: JsonValue }
  | { kind: 'response'; id: number; value: JsonValue }
  | { kind: 'error'; id: number; error: StudioErrorData }

export interface RpcTransport { send(frame: RpcFrame): Promise<void> }
type Handler = (params: JsonValue) => JsonValue | Promise<JsonValue>

function isFrame(value: unknown): value is RpcFrame {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const frame = value as Record<string, unknown>
  if (!Number.isSafeInteger(frame.id) || Number(frame.id) <= 0) return false
  if (frame.kind === 'request') return typeof frame.method === 'string' && frame.method.length > 0 && frame.method.length <= 256 && frame.params !== undefined
  if (frame.kind === 'response') return frame.value !== undefined
  if (frame.kind !== 'error' || !frame.error || typeof frame.error !== 'object') return false
  const error = frame.error as StudioErrorData
  return STUDIO_ERROR_CODES.includes(error.code) && typeof error.message === 'string' && error.message.length <= 4096 && typeof error.retryable === 'boolean'
}

export class RpcPeer {
  private nextId = 0
  private closed = false
  private inbound = 0
  private readonly methods = new Map<string, Handler>()
  private readonly pending = new Map<number, {
    resolve(value: JsonValue): void
    reject(error: unknown): void
    timer: ReturnType<typeof setTimeout>
  }>()

  constructor(private readonly transport: RpcTransport, private readonly timeoutMs = 30_000, private readonly maxPending = 128) {}

  handle(method: string, handler: Handler): () => void {
    if (this.methods.has(method)) throw new StudioError('REGISTRATION_CONFLICT', 'Duplicate RPC method')
    this.methods.set(method, handler)
    return () => { if (this.methods.get(method) === handler) this.methods.delete(method) }
  }

  request(method: string, params: JsonValue, timeoutMs = this.timeoutMs): Promise<JsonValue> {
    if (this.closed) return Promise.reject(new StudioError('PLUGIN_UNAVAILABLE', 'Plugin connection is closed'))
    if (this.pending.size >= this.maxPending) return Promise.reject(new StudioError('RESOURCE_EXHAUSTED', 'Too many pending plugin calls'))
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new StudioError('DEADLINE_EXCEEDED', 'Plugin call timed out'))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      void this.transport.send({ kind: 'request', id, method, params }).catch(error => {
        const pending = this.pending.get(id)
        if (pending) { clearTimeout(timer); this.pending.delete(id); reject(error) }
      })
    })
  }

  async receive(frame: unknown): Promise<void> {
    if (this.closed) return
    if (!isFrame(frame)) {
      this.close()
      throw new StudioError('INVALID_ARGUMENT', 'Malformed plugin RPC frame')
    }
    if (frame.kind !== 'request') {
      const pending = this.pending.get(frame.id)
      if (!pending) return
      clearTimeout(pending.timer)
      this.pending.delete(frame.id)
      if (frame.kind === 'response') pending.resolve(frame.value)
      else pending.reject(new StudioError(frame.error.code, frame.error.message, frame.error.retryable))
      return
    }
    this.inbound++
    try {
      if (this.inbound > this.maxPending) throw new StudioError('RESOURCE_EXHAUSTED', 'Too many inbound plugin calls')
      const handler = this.methods.get(frame.method)
      if (!handler) throw new StudioError('FORBIDDEN', 'Unknown plugin method')
      const value = await handler(frame.params)
      if (!this.closed) await this.transport.send({ kind: 'response', id: frame.id, value })
    } catch (error) {
      if (!this.closed) {
        const safe = serializeStudioError(error, 'Plugin operation failed')
        await this.transport.send({ kind: 'error', id: frame.id, error: safe }).catch(() => this.close())
      }
    } finally { this.inbound-- }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new StudioError('PLUGIN_UNAVAILABLE', 'Plugin connection closed'))
    }
    this.pending.clear()
    this.methods.clear()
  }
}
