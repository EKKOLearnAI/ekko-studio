import type { Socket } from 'socket.io-client'
import type { GroupAgentEventSink } from './agent-clients'

export const AGENT_EVENT_BATCH_CAPABILITY = 'agent.events.v1'
export const AGENT_EVENT_BATCH_BYTES = 16 * 1024
export const AGENT_EVENT_BATCH_COUNT = 64
const BATCH_DELAY_MS = 40
const MAX_PENDING_BYTES = 4 * 1024 * 1024
const MAX_PENDING_EVENTS = 2048
const ACK_TIMEOUT_MS = 30_000
const BUFFERED_EVENTS = new Set(['message_stream_start', 'message_stream_delta', 'message_reasoning_delta', 'typing', 'context_status'])

export type RelayAgentEvent = { runId: string; seq: number; event: string; data: Record<string, unknown> }
type Entry = { event: RelayAgentEvent; bytes: number; resolve?: () => void; reject?: (error: Error) => void }

export function supportsAgentEventBatching(ready: any, cloud: boolean): boolean {
  return Array.isArray(ready?.capabilities) && ready.capabilities.includes(AGENT_EVENT_BATCH_CAPABILITY)
    && (!cloud || (Array.isArray(ready?.relayCapabilities) && ready.relayCapabilities.includes(AGENT_EVENT_BATCH_CAPABILITY)))
}

// One acknowledged packet at a time provides transport backpressure. Events
// arriving meanwhile share a bounded buffer instead of scheduling one timer each.
export class OutboundRelayEventSink implements GroupAgentEventSink {
  private runId = ''
  private sequence = 0
  private secrets: string[] = []
  private batching = false
  private pending: Entry[] = []
  private frames: Entry[][] = []
  private inFlight: Entry[] | null = null
  private pendingBytes = 0
  private totalBytes = 0
  private totalEvents = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private failure: Error | null = null
  private waiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = []

  constructor(
    private readonly socket: Socket,
    private readonly sanitize: (data: Record<string, unknown>, secrets: string[]) => unknown,
    private readonly onFailure: (error: Error) => void = () => {},
  ) {}

  get connected(): boolean { return this.socket.connected }
  get id(): string | undefined { return this.socket.id }
  setBatching(enabled: boolean): void { this.batching = enabled }

  begin(runId: string, secrets: string[] = []): void {
    this.end(this.runId)
    this.runId = runId
    this.sequence = 0
    this.failure = null
    this.secrets = secrets.filter(Boolean)
  }

  end(runId: string): void {
    if (runId !== this.runId) return
    this.cancel(new Error('Remote Agent run ended'))
    this.runId = ''
    this.secrets = []
  }

  abort(error: Error): void {
    if (!this.runId || this.failure) return
    this.failure = error
    this.cancel(error)
    this.onFailure(error)
  }

  sendMessage(_roomId: string, content: string, messageId?: string, extra?: Record<string, unknown>, agentSessionId?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      this.enqueue('message', { content, id: messageId, extra, agentSessionId }, () => resolve(messageId || ''), reject)
    })
  }

  emit(event: string, payload: Record<string, unknown>): void { this.enqueue(event, payload) }

  drain(): Promise<void> {
    if (this.failure) return Promise.reject(this.failure)
    this.flush()
    if (!this.inFlight && !this.frames.length) return Promise.resolve()
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }))
  }

  private enqueue(event: string, data: Record<string, unknown>, resolve?: () => void, reject?: (error: Error) => void): void {
    if (this.failure || !this.runId || !this.socket.connected) {
      reject?.(this.failure || new Error('Relay is not connected to an active run'))
      return
    }
    let entry: Entry
    try {
      const envelope: RelayAgentEvent = { runId: this.runId, seq: ++this.sequence, event, data: this.sanitize(data, this.secrets) as Record<string, unknown> }
      const bytes = Buffer.byteLength(JSON.stringify(envelope)) + 1
      if (this.totalEvents >= MAX_PENDING_EVENTS || this.totalBytes + bytes > MAX_PENDING_BYTES) {
        throw new Error('Remote Agent output exceeded the pending relay queue limit')
      }
      entry = { event: envelope, bytes, resolve, reject }
    } catch (error) {
      const failure = error instanceof Error ? error : new Error('Could not encode remote Agent event')
      reject?.(failure)
      this.abort(failure)
      return
    }
    if (this.pending.length && this.pendingBytes + entry.bytes + 16 > AGENT_EVENT_BATCH_BYTES) this.flush()
    this.pending.push(entry)
    this.pendingBytes += entry.bytes
    this.totalBytes += entry.bytes
    this.totalEvents++
    if (!this.batching || !BUFFERED_EVENTS.has(event) || this.pendingBytes + 16 >= AGENT_EVENT_BATCH_BYTES || this.pending.length >= AGENT_EVENT_BATCH_COUNT) {
      this.flush()
    } else if (!this.timer) {
      this.timer = setTimeout(() => { this.timer = null; this.flush() }, BATCH_DELAY_MS)
      this.timer.unref?.()
    }
  }

  private flush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.pending.length) {
      this.frames.push(this.pending)
      this.pending = []
      this.pendingBytes = 0
    }
    this.pump()
  }

  private pump(): void {
    if (this.failure || this.inFlight) return
    const frame = this.frames.shift()
    if (!frame) {
      if (!this.pending.length) this.waiters.splice(0).forEach(waiter => waiter.resolve())
      return
    }
    this.inFlight = frame
    if (!this.socket.connected) { this.abort(new Error('Agent relay disconnected')); return }
    const batch = this.batching && frame.length > 1
    this.socket.timeout(ACK_TIMEOUT_MS).emit(batch ? 'agent.events' : 'agent.event',
      batch ? { events: frame.map(entry => entry.event) } : frame[0].event,
      (error: Error | null, response: any) => {
        if (this.inFlight !== frame) return
        if (error || response?.error || response?.ok !== true) {
          this.abort(new Error(error ? 'Remote Agent event acknowledgement timed out' : String(response?.error || 'Remote Agent event was not acknowledged')))
          return
        }
        this.inFlight = null
        for (const entry of frame) {
          this.totalBytes -= entry.bytes
          this.totalEvents--
          entry.resolve?.()
        }
        this.pump()
      })
  }

  private cancel(error: Error): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const entries = [...(this.inFlight || []), ...this.frames.flat(), ...this.pending]
    this.inFlight = null
    this.frames = []
    this.pending = []
    this.pendingBytes = this.totalBytes = this.totalEvents = 0
    entries.forEach(entry => entry.reject?.(error))
    this.waiters.splice(0).forEach(waiter => waiter.reject(error))
  }
}
