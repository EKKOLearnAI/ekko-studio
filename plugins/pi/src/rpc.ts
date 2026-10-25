import { ManagedJsonRpcTransport } from '@ekko-studio/agent-drivers'
import { StudioError, type ProcessExit, type ProcessHandle } from '@ekko-studio/plugin-sdk'

export type PiRecord = Record<string, any> & { type: string }

/** Pi command correlation belongs to the plugin; bounded framing belongs to the public driver. */
export class PiRpc {
  readonly exited: Promise<ProcessExit>
  private resolveExit!: (exit: ProcessExit) => void
  private pending = new Map<string, { command: string; resolve(value: any): void; reject(error: unknown): void; timer: ReturnType<typeof setTimeout> }>()
  private sequence = 0
  private ended = false
  private transport: ManagedJsonRpcTransport<PiRecord>
  constructor(private handle: ProcessHandle, private onEvent: (event: PiRecord) => void, private onFailure: (error: unknown) => void) {
    this.exited = new Promise(resolve => { this.resolveExit = resolve })
    const port = { write: (bytes: Uint8Array) => handle.write(bytes), end: () => handle.end(), dispose: () => handle.dispose(), read: async () => {
      const batch = await handle.read()
      if (batch.exit && !batch.chunks.length) this.resolveExit(batch.exit)
      return batch
    } }
    this.transport = new ManagedJsonRpcTransport(port, value => {
      if (!value || typeof value !== 'object' || Array.isArray(value) || typeof (value as PiRecord).type !== 'string') throw new Error('Invalid Pi protocol record')
      return value as PiRecord
    }, { maxMessageBytes: 4 * 1024 * 1024 })
    this.transport.onmessage = event => {
      if (event.type !== 'response') { onEvent(event); return }
      const entry = this.pending.get(event.id)
      if (!entry) return
      this.pending.delete(event.id); clearTimeout(entry.timer)
      if (event.command !== entry.command || typeof event.success !== 'boolean') entry.reject(new StudioError('INVALID_ARGUMENT', 'Invalid Pi command response'))
      else if (!event.success) entry.reject(event.error === 'Nothing to compact (session too small)'
        ? new StudioError('INVALID_ARGUMENT', 'Pi has no older conversation context to compact')
        : event.error === 'Already compacted' ? new StudioError('INVALID_ARGUMENT', 'Pi conversation is already compacted')
        : new StudioError('RUNTIME_UNAVAILABLE', `Pi rejected the native ${entry.command} command`))
      else entry.resolve(event.data)
    }
    this.transport.onerror = error => this.fail(error)
    this.transport.onclose = () => this.fail(new StudioError('RUNTIME_UNAVAILABLE', 'Pi connection closed'))
  }
  start() { return this.transport.start() }
  request(command: string, params: Record<string, unknown> = {}): Promise<any> {
    if (this.ended) return Promise.reject(new StudioError('RUNTIME_UNAVAILABLE', 'Pi connection closed'))
    if (this.pending.size >= 32) return Promise.reject(new StudioError('RESOURCE_EXHAUSTED', 'Pi command limit exceeded'))
    const id = `studio-${++this.sequence}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new StudioError('DEADLINE_EXCEEDED', 'Pi command did not finish')) }, 30000)
      this.pending.set(id, { command, resolve, reject, timer })
      void this.transport.send({ ...params, type: command, id }).catch(error => this.fail(error))
    })
  }
  notify(record: PiRecord) { return this.transport.send(record) }
  end() { return this.handle.end() }
  private fail(error: unknown) {
    if (this.ended) return
    this.ended = true
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error) }
    this.pending.clear()
    this.onFailure(error)
  }
  async dispose() { this.fail(new StudioError('CANCELLED', 'Pi connection disposed')); await this.transport.close() }
}
