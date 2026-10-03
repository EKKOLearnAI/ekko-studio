import type { ChildProcess } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'

interface Pending {
  resolve(value: any): void
  reject(error: Error): void
  timer?: ReturnType<typeof setTimeout>
}

/** Standard ACP only: no DSH extensions or vendor-specific close requests. */
export class NativeAcpTurn {
  private pending = new Map<number, Pending>()
  private sequence = 0
  private decoder = new StringDecoder('utf8')
  private buffer = ''
  private closed = false
  private sessionId = ''

  constructor(private child: ChildProcess, private callbacks: {
    update(update: any): void
    session(id: string): void
    permissionRequired?: boolean
  }) {
    child.stdout?.on('data', (chunk: Buffer) => {
      try {
        this.buffer += this.decoder.write(chunk)
        let end: number
        while ((end = this.buffer.indexOf('\n')) >= 0) {
          const line = this.buffer.slice(0, end).trim()
          this.buffer = this.buffer.slice(end + 1)
          if (line.length > 16 * 1024 * 1024) throw new Error('ACP message exceeds 16 MiB')
          if (line) this.receive(JSON.parse(line))
        }
        if (this.buffer.length > 16 * 1024 * 1024) throw new Error('ACP message exceeds 16 MiB')
      } catch (error) { this.dispose(error instanceof Error ? error : new Error(String(error))) }
    })
    child.on('error', error => this.dispose(error))
    child.on('close', () => this.dispose(new Error('ACP connection closed before the request completed')))
    child.stdin?.on('error', error => this.dispose(error))
  }

  private write(message: object) {
    if (this.closed || !this.child.stdin?.writable) throw new Error('ACP connection is closed')
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
  }

  private request(method: string, params: object, timeout = 60_000): Promise<any> {
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      const timer = timeout ? setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`ACP ${method} timed out`))
      }, timeout) : undefined
      timer?.unref()
      this.pending.set(id, { resolve, reject, timer })
      try { this.write({ id, method, params }) } catch (error) {
        this.pending.delete(id)
        if (timer) clearTimeout(timer)
        reject(error)
      }
    })
  }

  private receive(message: any) {
    if (this.closed) return
    if (message.method) {
      if (message.method === 'session/update' && message.params?.sessionId === this.sessionId) {
        this.callbacks.update(message.params.update)
      } else if (message.id !== undefined) {
        if (message.method === 'session/request_permission' && message.params?.sessionId === this.sessionId) {
          const kind = this.callbacks.permissionRequired ? 'reject_once' : 'allow_once'
          const option = message.params.options?.find((entry: any) => entry.kind === kind)
          this.write({ id: message.id, result: { outcome: option
            ? { outcome: 'selected', optionId: option.optionId }
            : { outcome: 'cancelled' } } })
        } else this.write({ id: message.id, error: { code: -32601, message: 'Unsupported ACP client method' } })
      }
      return
    }
    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    if (pending.timer) clearTimeout(pending.timer)
    if (message.error) pending.reject(new Error(`ACP: ${message.error.message || 'request failed'}`))
    else pending.resolve(message.result)
  }

  async prompt(input: { cwd: string; text: string; nativeSessionId?: string; mcpServers: object[] }): Promise<string> {
    const initialized = await this.request('initialize', {
      protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'ekko-studio', version: '1.0.0' },
    })
    if (initialized?.protocolVersion !== 1) throw new Error('Unsupported ACP protocol version')
    const capabilities = initialized.agentCapabilities || {}
    let method = 'session/new'
    if (input.nativeSessionId) {
      if (capabilities.sessionCapabilities?.resume) method = 'session/resume'
      else if (capabilities.loadSession) method = 'session/load'
      else throw new Error('This CLI does not support restoring ACP sessions; update it before continuing this chat')
    }
    // session/load can replay history. Discard it until loading finishes to
    // avoid saving the same assistant/tool messages a second time in Studio.
    const session = await this.request(method, {
      cwd: input.cwd, mcpServers: input.mcpServers,
      ...(input.nativeSessionId ? { sessionId: input.nativeSessionId } : {}),
    })
    this.sessionId = session?.sessionId || input.nativeSessionId
    if (!this.sessionId || typeof this.sessionId !== 'string') throw new Error('ACP returned no session ID')
    this.callbacks.session(this.sessionId)
    const result = await this.request('session/prompt', {
      sessionId: this.sessionId, prompt: [{ type: 'text', text: input.text }],
    }, 0)
    this.child.stdin?.end()
    return String(result?.stopReason || 'unknown')
  }

  cancel() {
    if (this.closed) return
    try { if (this.sessionId) this.write({ method: 'session/cancel', params: { sessionId: this.sessionId } }) } catch {}
  }

  dispose(error = new Error('ACP turn disposed')) {
    if (this.closed) return
    this.closed = true
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }
}
