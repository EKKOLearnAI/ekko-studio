/** One consumer, bounded buffering for native protocols whose callbacks cannot await. */
export class AgentEventQueue<T> implements AsyncIterable<T> {
  private values: Array<{ value: T; bytes: number }> = []
  private bytes = 0
  private ended = false
  private failure?: Error
  private reader = false
  private wake?: () => void

  constructor(private readonly maxBytes = 4 * 1024 * 1024, private readonly maxEvents = 512) {}

  push(value: T): void {
    if (this.ended) throw new Error('Agent event stream is closed')
    const bytes = Buffer.byteLength(JSON.stringify(value))
    if (this.bytes + bytes > this.maxBytes || this.values.length >= this.maxEvents) {
      const error = new Error('Agent event buffer limit exceeded')
      this.fail(error)
      throw error
    }
    this.values.push({ value, bytes })
    this.bytes += bytes
    this.wake?.()
  }

  end(): void { this.ended = true; this.wake?.() }
  fail(error: Error): void { this.failure ??= error; this.end() }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    if (this.reader) throw new Error('Agent events support one reader')
    this.reader = true
    try {
      while (true) {
        const entry = this.values.shift()
        if (entry) { this.bytes -= entry.bytes; yield entry.value; continue }
        if (this.ended) { if (this.failure) throw this.failure; return }
        await new Promise<void>(resolve => { this.wake = resolve })
        this.wake = undefined
      }
    } finally {
      this.end()
      this.values = []
      this.bytes = 0
    }
  }
}
