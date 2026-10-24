import { ManagedJsonRpcTransport } from './json-rpc'
import type { ManagedProcessPort } from './transport'

type Id = string | number
export interface NativeRpcMessage {
  id?: Id
  method?: string
  params?: Record<string, unknown>
  result?: unknown
  error?: { code: number; message: string }
}
const validId = (id: unknown): id is Id => (typeof id === 'number' && Number.isSafeInteger(id))
  || (typeof id === 'string' && id.length > 0 && id.length <= 256)

function decode(value: unknown): NativeRpcMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid native RPC frame')
  const frame = value as NativeRpcMessage
  if (frame.method !== undefined) {
    if (typeof frame.method !== 'string' || !frame.method || frame.method.length > 256
      || (frame.id !== undefined && !validId(frame.id))
      || (frame.params !== undefined && (!frame.params || typeof frame.params !== 'object' || Array.isArray(frame.params)))) throw new Error('Invalid native RPC request')
  } else if (!validId(frame.id) || (Object.hasOwn(frame, 'result') === Object.hasOwn(frame, 'error'))
    || (frame.error !== undefined && (!frame.error || !Number.isSafeInteger(frame.error.code) || typeof frame.error.message !== 'string'))) {
    throw new Error('Invalid native RPC response')
  }
  return frame
}

/** Bidirectional JSONL RPC for native servers that omit the JSON-RPC version header. */
export class NativeRpcConnection {
  readonly closed: Promise<never>
  private rejectClosed!: (error: Error) => void
  private readonly transport: ManagedJsonRpcTransport<NativeRpcMessage>
  private readonly pending = new Map<Id, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>()
  private readonly incoming = new Map<Id, AbortController>()
  private sequence = 0
  private ended = false
  private closing?: Promise<void>

  constructor(process: ManagedProcessPort, private readonly callbacks: {
    notification(method: string, params: Record<string, unknown>): void
    request?(method: string, params: Record<string, unknown>, signal: AbortSignal, id: Id): Promise<unknown>
  }) {
    this.closed = new Promise((_, reject) => { this.rejectClosed = reject })
    void this.closed.catch(() => {})
    this.transport = new ManagedJsonRpcTransport(process, decode, { maxMessageBytes: 4 * 1024 * 1024 })
    this.transport.onmessage = message => this.receive(message)
    this.transport.onerror = error => this.fail(error)
    this.transport.onclose = () => this.fail(new Error('Native RPC process closed'))
  }

  start(): Promise<void> { return this.transport.start() }

  request(method: string, params: Record<string, unknown>, timeoutMs = 30_000): Promise<any> {
    if (this.ended) return Promise.reject(new Error('Native RPC connection is closed'))
    if (this.pending.size >= 128) return Promise.reject(new Error('Native RPC request limit exceeded'))
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Native RPC ${method} timed out; remote effects may be unknown`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      void this.transport.send({ id, method, params }).catch(error => this.fail(error))
    })
  }

  notify(method: string, params: Record<string, unknown> = {}): Promise<void> {
    return this.transport.send({ method, params })
  }

  /** A native server may withdraw its own request without closing the connection. */
  withdrawRequest(id: Id): void {
    const controller = this.incoming.get(id)
    if (!controller) return
    this.incoming.delete(id)
    controller.abort('native-resolved')
  }

  private receive(message: NativeRpcMessage): void {
    if (this.ended) return
    if (message.method) {
      if (message.id === undefined) { this.callbacks.notification(message.method, message.params || {}); return }
      const id = message.id
      if (this.incoming.has(id)) { this.fail(new Error('Duplicate native RPC request')); return }
      if (this.incoming.size >= 32 || !this.callbacks.request) {
        void this.transport.send({ id, error: { code: -32601, message: 'Client method unavailable' } }).catch(error => this.fail(error))
        return
      }
      const controller = new AbortController()
      this.incoming.set(id, controller)
      void Promise.resolve().then(() => controller.signal.aborted ? undefined : this.callbacks.request!(message.method!, message.params || {}, controller.signal, id))
        .then(async result => {
          if (!this.ended && !controller.signal.aborted) await this.transport.send({ id, result: result ?? null })
        }, async () => {
          if (!this.ended && !controller.signal.aborted) await this.transport.send({ id, error: { code: -32000, message: 'Client request failed' } })
        }).catch(error => this.fail(error)).finally(() => { if (this.incoming.get(id) === controller) this.incoming.delete(id) })
      return
    }
    const pending = this.pending.get(message.id!)
    if (!pending) return
    this.pending.delete(message.id!); clearTimeout(pending.timer)
    if (message.error) pending.reject(new Error(`Native RPC request failed (${message.error.code})`))
    else pending.resolve(message.result)
  }

  private fail(error: Error): void {
    if (this.ended) return
    this.ended = true
    this.rejectClosed(error)
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error) }
    this.pending.clear()
    for (const controller of this.incoming.values()) controller.abort()
    this.incoming.clear()
    void this.close().catch(() => {})
  }

  close(): Promise<void> {
    if (this.closing) return this.closing
    // Set the barrier before failing requests; callbacks can re-enter close.
    this.closing = Promise.resolve().then(() => this.transport.close())
    this.fail(new Error('Native RPC connection disposed'))
    return this.closing
  }
}
