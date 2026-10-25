import { EventEmitter } from 'node:events'

/** Structural subset of the public SDK ProcessHandle; no host or ChildProcess dependency. */
export interface ManagedProcessPort {
  read(): Promise<{ chunks: Array<{ stream: 'stdout' | 'stderr'; data: Uint8Array }>; truncated: boolean; exit: { code: number | null; signal: string | null } | null }>
  write(data: Uint8Array): Promise<void>
  end(): Promise<void>
  dispose(): Promise<void>
}

export interface AgentProcessIO {
  stdout?: { on(event: 'data', listener: (chunk: Buffer) => void): unknown } | null
  stdin?: {
    readonly writable: boolean
    write(data: string): unknown
    end(): unknown
    on(event: 'error', listener: (error: Error) => void): unknown
  } | null
  on(event: 'error', listener: (error: Error) => void): unknown
  on(event: 'close', listener: () => void): unknown
}

/** Converts bounded SDK pulls to the stream shape used by protocol parsers. */
export class ManagedProcessTransport extends EventEmitter implements AgentProcessIO {
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  readonly stdin = Object.assign(new EventEmitter(), {
    writable: true,
    write: (data: string) => this.write(data),
    end: () => this.end(),
  })
  readonly exited: Promise<{ code: number | null; signal: string | null }>
  private resolveExit!: (value: { code: number | null; signal: string | null }) => void
  private rejectExit!: (error: Error) => void
  private ended = false
  private queuedBytes = 0
  private queuedFrames = 0
  private writes: Promise<void> = Promise.resolve()
  private disposal?: Promise<void>

  constructor(private readonly process: ManagedProcessPort) {
    super()
    this.exited = new Promise((resolve, reject) => { this.resolveExit = resolve; this.rejectExit = reject })
    void this.exited.catch(() => {})
    queueMicrotask(() => { void this.read().catch(() => {}) })
  }

  private async read(): Promise<void> {
    try {
      while (!this.ended) {
        const result = await this.process.read()
        if (this.ended) return
        if (result.truncated) throw new Error('Managed process output was truncated')
        for (const chunk of result.chunks) this[chunk.stream].emit('data', Buffer.from(chunk.data))
        if (result.exit && result.chunks.length === 0) {
          this.ended = true; this.stdin.writable = false
          this.resolveExit(result.exit)
          try { this.emit('close', result.exit.code, result.exit.signal) } catch { /* Client observers cannot retain a process. */ }
          finally { void this.dispose().catch(() => {}) }
        }
      }
    } catch (error) { this.fail(error) }
  }

  private write(data: string): boolean {
    if (!this.stdin.writable || this.ended) throw new Error('Managed process stdin is closed')
    if (typeof data !== 'string') throw new Error('Protocol writes must be strings')
    const length = Buffer.byteLength(data)
    if (this.queuedBytes + length > 16 * 1024 * 1024 || this.queuedFrames >= 128) throw new Error('Managed process write queue is full')
    const bytes = Buffer.from(data)
    this.queuedBytes += length; this.queuedFrames++
    this.writes = this.writes.then(async () => {
      if (this.ended) throw new Error('Managed process ended before the write drained')
      for (let offset = 0; offset < bytes.length; offset += 65_536) await this.process.write(bytes.subarray(offset, offset + 65_536))
    }).catch(error => this.fail(error)).finally(() => { this.queuedBytes -= length; this.queuedFrames-- })
    return this.queuedBytes < 65_536
  }

  private end(): void {
    if (!this.stdin.writable) return
    this.stdin.writable = false
    void this.writes.then(async () => { if (!this.ended) await this.process.end() }).catch(error => this.fail(error))
  }

  private fail(value: unknown): void {
    if (this.ended) return
    this.ended = true; this.stdin.writable = false
    const error = value instanceof Error ? value : new Error('Managed process transport failed')
    this.rejectExit(error)
    for (const emitter of [this, this.stdin]) {
      try { if (emitter.listenerCount('error')) emitter.emit('error', error) } catch { /* Notify the other observer and continue cleanup. */ }
    }
    void this.dispose().catch(() => {})
  }

  dispose(): Promise<void> {
    return this.disposal ??= (async () => {
      const wasEnded = this.ended
      this.ended = true; this.stdin.writable = false
      try { await this.process.dispose() }
      finally {
        if (!wasEnded) {
          this.rejectExit(new Error('Managed process transport disposed'))
          try { this.emit('close', null, null) } catch { /* Preserve the actual disposal result. */ }
        }
      }
    })()
  }
}
