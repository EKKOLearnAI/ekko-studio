import type { ManagedProcessPort } from './transport'

/** Bounded JSONL or Content-Length transport; protocol validation belongs to its client. */
export class ManagedJsonRpcTransport<Message extends object> {
  onmessage?: (message: Message) => void
  onerror?: (error: Error) => void
  onclose?: () => void
  onstderr?: (bytes: Uint8Array) => void
  private started = false
  private closed = false
  private closing?: Promise<void>
  private parts: Buffer[] = []
  private size = 0
  private writes: Promise<void> = Promise.resolve()
  private queuedBytes = 0
  private queuedFrames = 0
  private readonly maximum: number
  private header = ''
  private expected?: number

  constructor(private readonly process: ManagedProcessPort, private readonly decode: (value: unknown) => Message, private readonly options: { maxMessageBytes?: number; framing?: 'jsonl' | 'content-length' } = {}) {
    this.maximum = options.maxMessageBytes ?? 10 * 1024 * 1024
    if (!Number.isSafeInteger(this.maximum) || this.maximum < 1 || this.maximum > 16 * 1024 * 1024) throw new Error('Invalid JSON message limit')
  }

  async start(): Promise<void> {
    if (this.started || this.closed) throw new Error('JSON transport cannot be restarted')
    this.started = true
    void this.read().catch(error => this.fail(error))
  }

  async send(message: Message): Promise<void> {
    if (!this.started || this.closed) throw new Error('JSON transport is not open')
    const encoded = JSON.stringify(message)
    if (typeof encoded !== 'string') throw new Error('Expected a JSON message')
    const length = Buffer.byteLength(encoded)
    if (length > this.maximum) throw new Error('JSON message limit exceeded')
    const bytes = Buffer.from(this.options.framing === 'content-length' ? `Content-Length: ${length}\r\n\r\n${encoded}` : `${encoded}\n`)
    if (this.queuedBytes + bytes.length > 32 * 1024 * 1024 || this.queuedFrames >= 128) throw new Error('JSON write queue is full')
    this.queuedBytes += bytes.length; this.queuedFrames++
    const sent = this.writes.then(async () => {
      for (let offset = 0; offset < bytes.length; offset += 65_536) {
        if (this.closed) throw new Error('JSON transport closed before the write drained')
        await this.process.write(bytes.subarray(offset, offset + 65_536))
      }
    })
    this.writes = sent.catch(() => {})
    try { await sent }
    catch (error) { this.fail(new Error('JSON transport write failed')); throw error }
    finally { this.queuedBytes -= bytes.length; this.queuedFrames-- }
  }

  private append(bytes: Buffer): void {
    if (!bytes.length) return
    this.size += bytes.length
    if (this.size > this.maximum) throw new Error('JSON message limit exceeded')
    this.parts.push(bytes)
  }
  private consume(bytes: Buffer): void {
    if (this.options.framing === 'content-length') { this.consumeFramed(bytes); return }
    let offset = 0
    while (offset < bytes.length && !this.closed) {
      const newline = bytes.indexOf(10, offset)
      if (newline === -1) { this.append(bytes.subarray(offset)); return }
      this.append(bytes.subarray(offset, newline)); offset = newline + 1
      const frame = Buffer.concat(this.parts, this.size)
      this.parts = []; this.size = 0
      if (!frame.length) continue
      this.deliver(frame)
    }
  }
  private deliver(frame: Buffer): void {
    let message: Message
    try { message = this.decode(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(frame))) }
    catch { throw new Error('Invalid JSON protocol message') }
    try { this.onmessage?.(message) } catch { throw new Error('JSON message handler failed') }
  }
  private consumeFramed(bytes: Buffer): void {
    let offset = 0
    while (offset < bytes.length && !this.closed) {
      if (this.expected === undefined) {
        this.header += String.fromCharCode(bytes[offset++])
        if (this.header.length > 8192) throw new Error('JSON protocol header limit exceeded')
        if (!this.header.endsWith('\r\n\r\n')) continue
        const headers = this.header.slice(0, -4).split('\r\n'), lengths: number[] = []
        for (const header of headers) {
          const match = /^([!#$%&'*+.^_`|~\w-]+):[\t ]*([\t\x20-\x7e]*)$/.exec(header)
          if (!match) throw new Error('Invalid JSON protocol header')
          if (match[1].toLowerCase() === 'content-length') {
            if (!/^\d+$/.test(match[2])) throw new Error('Invalid JSON protocol length')
            lengths.push(Number(match[2]))
          }
        }
        if (lengths.length !== 1 || !Number.isSafeInteger(lengths[0]) || lengths[0] < 1 || lengths[0] > this.maximum) throw new Error('Invalid JSON protocol length')
        this.expected = lengths[0]; this.header = ''
      }
      const length = Math.min(bytes.length - offset, this.expected - this.size)
      this.append(bytes.subarray(offset, offset + length)); offset += length
      if (this.size === this.expected) {
        const frame = Buffer.concat(this.parts, this.size)
        this.parts = []; this.size = 0; this.expected = undefined
        this.deliver(frame)
      }
    }
  }
  private async read(): Promise<void> {
    while (!this.closed) {
      const batch = await this.process.read()
      if (this.closed) return
      if (batch.truncated) throw new Error('JSON protocol output was truncated')
      for (const chunk of batch.chunks) {
        if (this.closed) return
        if (chunk.stream === 'stdout') this.consume(Buffer.from(chunk.data))
        else { try { this.onstderr?.(chunk.data) } catch { throw new Error('JSON stderr handler failed') } }
      }
      if (batch.exit && !batch.chunks.length) {
        if (this.size || this.header || this.expected !== undefined) throw new Error('JSON protocol ended with an incomplete message')
        await this.close()
      }
    }
  }
  private fail(value: unknown): void {
    if (this.closed) return
    try { this.onerror?.(value instanceof Error ? value : new Error('JSON transport failed')) } catch { /* Cleanup still owns the process. */ }
    void this.close().catch(() => {})
  }
  close(): Promise<void> {
    return this.closing ??= (async () => {
      this.closed = true
      this.parts = []; this.size = 0; this.header = ''; this.expected = undefined
      try { await this.process.dispose() }
      finally { try { this.onclose?.() } catch { /* A client callback cannot prevent cleanup. */ } }
    })()
  }
}
