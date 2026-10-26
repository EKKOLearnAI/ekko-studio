import type { ChildProcess } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { readFileSync } from 'node:fs'
import type { CodingAgentImageInput } from '../../protocol/types'
import { logger } from '../../../studio/public/logging'

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
          if (line) this.receiveLine(line)
        }
        if (this.buffer.length > 16 * 1024 * 1024) throw new Error('ACP message exceeds 16 MiB')
      } catch (error) { this.dispose(error instanceof Error ? error : new Error(String(error))) }
    })
    child.on('error', error => this.dispose(error))
    child.on('close', () => this.dispose(new Error('ACP connection closed before the request completed')))
    child.stdin?.on('error', error => this.dispose(error))
  }

  // A valid ACP frame is always a JSON object, so any line not starting with '{'
  // is dependency stdout noise (e.g. the MCP SDK's console.debug), not the
  // protocol. Skip and warn instead of disposing the whole turn; only a line that
  // looks like JSON but fails to parse is a real protocol break and stays fatal.
  private receiveLine(line: string) {
    if (!line.startsWith('{')) {
      logger.warn({ line: line.slice(0, 500) }, 'skipping non-JSON line on ACP stdout')
      return
    }
    this.receive(JSON.parse(line))
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

  async prompt(input: { cwd: string; text: string; images?: CodingAgentImageInput[]; nativeSessionId?: string; mcpServers: object[]; model?: string; reasoningEffort?: string }): Promise<string> {
    const initialized = await this.request('initialize', {
      protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'ekko-studio', version: '1.0.0' },
    })
    if (initialized?.protocolVersion !== 1) throw new Error('Unsupported ACP protocol version')
    const capabilities = initialized.agentCapabilities || {}
    if (input.images?.length && capabilities.promptCapabilities?.image !== true) {
      throw new Error('This CLI does not advertise ACP image input support; update the CLI or choose an image-capable model')
    }
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
    let options = Array.isArray(session.configOptions) ? session.configOptions : []
    if (input.model) {
      const selector = options.find((option: any) => option.category === 'model' || option.id === 'model')
      if (selector) {
        const configured = await this.request('session/set_config_option', { sessionId: this.sessionId, configId: selector.id, value: input.model })
        options = configured.configOptions || options
      } else {
        await this.request('session/set_model', { sessionId: this.sessionId, modelId: input.model })
      }
    }
    if (input.reasoningEffort) {
      const selector = options.find((option: any) => option.category === 'thought_level' || option.id === 'reasoning_effort')
      if (!selector) throw new Error('This CLI does not expose a reasoning effort selector')
      await this.request('session/set_config_option', { sessionId: this.sessionId, configId: selector.id, value: input.reasoningEffort })
    }
    const prompt: any[] = input.text ? [{ type: 'text', text: input.text }] : []
    for (const image of input.images || []) prompt.push({
      type: 'image', mimeType: image.mediaType === 'image/jpg' ? 'image/jpeg' : image.mediaType || 'image/png',
      data: readFileSync(image.path).toString('base64'),
    })
    const result = await this.request('session/prompt', { sessionId: this.sessionId, prompt }, 0)
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
