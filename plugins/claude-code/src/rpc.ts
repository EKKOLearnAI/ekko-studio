import { ManagedJsonRpcTransport } from '@ekko-studio/agent-drivers'
import { StudioError, type ProcessExit, type ProcessHandle } from '@ekko-studio/plugin-sdk'

export type ClaudeRecord = Record<string, any> & { type: string }

/** Native control envelopes are Claude's protocol; the public driver owns bounded framing. */
export class ClaudeRpc {
  readonly exited: Promise<ProcessExit>
  private resolveExit!: (exit: ProcessExit) => void
  private pending = new Map<string, { resolve(value: any): void; reject(error: unknown): void; timer: ReturnType<typeof setTimeout> }>()
  private sequence = 0
  private closed = false
  private naturalExit = false
  private transport: ManagedJsonRpcTransport<ClaudeRecord>
  constructor(private handle: ProcessHandle, onEvent: (event: ClaudeRecord) => void, private onFailure: (error: unknown) => void) {
    this.exited = new Promise(resolve => { this.resolveExit = resolve })
    const port = { write: (bytes: Uint8Array) => handle.write(bytes), end: () => handle.end(), dispose: () => handle.dispose(), read: async () => {
      const batch = await handle.read()
      if (batch.exit && !batch.chunks.length) { this.naturalExit = true; this.resolveExit(batch.exit) }
      return batch
    } }
    this.transport = new ManagedJsonRpcTransport(port, value => {
      if (!value || typeof value !== 'object' || Array.isArray(value) || typeof (value as ClaudeRecord).type !== 'string') throw new Error('Invalid Claude protocol record')
      return value as ClaudeRecord
    }, { maxMessageBytes: 12 * 1024 * 1024 })
    this.transport.onmessage = event => {
      if (event.type !== 'control_response') { onEvent(event); return }
      const response = event.response, entry = this.pending.get(response?.request_id)
      if (!entry) return
      this.pending.delete(response.request_id); clearTimeout(entry.timer)
      if (response.subtype === 'success') entry.resolve(response.response)
      else entry.reject(new StudioError('RUNTIME_UNAVAILABLE', 'Claude Code rejected the native control request'))
    }
    this.transport.onerror = error => this.fail(error)
    this.transport.onclose = () => this.fail(new StudioError('RUNTIME_UNAVAILABLE', 'Claude Code connection closed'), !this.naturalExit)
  }
  start() { return this.transport.start() }
  request(subtype: string, params: Record<string, unknown> = {}): Promise<any> {
    if (this.closed) return Promise.reject(new StudioError('RUNTIME_UNAVAILABLE', 'Claude Code connection closed'))
    if (this.pending.size >= 32) return Promise.reject(new StudioError('RESOURCE_EXHAUSTED', 'Claude control request limit exceeded'))
    const id = `studio-${++this.sequence}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new StudioError('DEADLINE_EXCEEDED', 'Claude control request did not finish')) }, 20000)
      this.pending.set(id, { resolve, reject, timer })
      void this.transport.send({ type: 'control_request', request_id: id, request: { ...params, subtype } }).catch(error => this.fail(error))
    })
  }
  send(record: ClaudeRecord) { return this.transport.send(record) }
  end() { return this.handle.end() }
  private fail(error: unknown, notify = true) {
    if (this.closed) return
    this.closed = true
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error) }
    this.pending.clear(); if (notify) this.onFailure(error)
  }
  async dispose() { this.fail(new StudioError('CANCELLED', 'Claude connection disposed')); await this.transport.close() }
}
