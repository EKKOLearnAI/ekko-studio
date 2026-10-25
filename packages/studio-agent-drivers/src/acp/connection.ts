import type { AgentProcessIO } from '../process/transport'
import { StringDecoder } from 'node:string_decoder'
import { readFileSync } from 'node:fs'
export type AcpImageInput = ({ path: string; data?: never } | { data: string; path?: never }) & { name?: string; mediaType?: string }
export interface AcpPermissionRequest {
  sessionId: string
  toolCall: Record<string, unknown>
  options: Array<{ optionId: string; name: string; kind: string }>
}

export function acpAutomaticApproval(request: AcpPermissionRequest): string | null {
  return (request.options.find(option => option.kind === 'allow_once')
    || request.options.find(option => option.kind === 'allow_always'))?.optionId ?? null
}

interface Pending {
  method: string
  resolve(value: any): void
  reject(error: Error): void
  timer?: ReturnType<typeof setTimeout>
}
/** Native error data is for the owning plugin to interpret, never host transport authority. */
export class AcpRequestError extends Error {
  constructor(readonly code: number, message: string, readonly data: unknown, readonly method?: string) { super(`ACP: ${message}`); this.name = 'AcpRequestError' }
}

/** Standard ACP only: no DSH extensions or vendor-specific close requests. */
export class AcpConnection {
  private pending = new Map<number, Pending>()
  private sequence = 0
  private decoder = new StringDecoder('utf8')
  private buffer = ''
  private closed = false
  private sessionId = ''
  private loadingSession = false
  private commandCatalogs = new Map<string, unknown>()
  private cancelling = false
  private permissions = new Map<string | number, AbortController>()

  constructor(private child: AgentProcessIO, private callbacks: {
    update(update: any): void
    session(id: string): void
    permissionRequired?: boolean
    /** Resolve only after the host has accepted the user's response. null cancels. */
    permission?(request: AcpPermissionRequest, signal: AbortSignal): Promise<string | null>
    warning?(message: string, detail: string): void
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
      this.callbacks.warning?.('skipping non-JSON line on ACP stdout', line.slice(0, 500))
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
      this.pending.set(id, { method, resolve, reject, timer })
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
      if (message.method === 'session/update') {
        const { sessionId, update } = message.params || {}
        if (this.loadingSession && update?.sessionUpdate === 'available_commands_update') {
          if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 4096
            || JSON.stringify(update).length > 1_048_576 || (!this.commandCatalogs.has(sessionId) && this.commandCatalogs.size >= 4)) throw new Error('ACP startup command catalog limit exceeded')
          this.commandCatalogs.set(sessionId, update)
        } else if (sessionId === this.sessionId && !this.loadingSession) this.callbacks.update(update)
      } else if (message.id !== undefined) {
        if (message.method === 'session/request_permission' && message.params?.sessionId === this.sessionId) {
          if (this.callbacks.permission) { this.requestPermission(message); return }
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
    if (message.error) pending.reject(new AcpRequestError(Number(message.error.code), String(message.error.message || 'request failed'), message.error.data, pending.method))
    else pending.resolve(message.result)
  }

  private requestPermission(message: any): void {
    const { id, params } = message
    const options = params.options
    if (!((typeof id === 'string' && id.length > 0 && id.length <= 256) || (typeof id === 'number' && Number.isSafeInteger(id)))
      || !Array.isArray(options) || !options.length || options.length > 32
      || options.some((option: any) => !option || typeof option.optionId !== 'string' || !option.optionId || option.optionId.length > 256
        || typeof option.name !== 'string' || !option.name || option.name.length > 4096
        || !['allow_once', 'allow_always', 'reject_once', 'reject_always'].includes(option.kind))
      || new Set(options.map((option: any) => option.optionId)).size !== options.length
      || !params.toolCall || typeof params.toolCall !== 'object' || Array.isArray(params.toolCall)) {
      this.write({ id, error: { code: -32602, message: 'Invalid ACP permission request' } }); return
    }
    if (this.permissions.has(id)) { this.dispose(new Error('Duplicate ACP permission request')); return }
    if (this.cancelling || this.permissions.size >= 32) {
      this.write({ id, result: { outcome: { outcome: 'cancelled' } } }); return
    }
    const controller = new AbortController()
    this.permissions.set(id, controller)
    // Retain the wire options separately: application callbacks cannot add an
    // option and thereby authorize an outcome the CLI never offered.
    const request = JSON.parse(JSON.stringify({ sessionId: this.sessionId, toolCall: params.toolCall, options })) as AcpPermissionRequest
    void Promise.resolve().then(() => controller.signal.aborted ? null : this.callbacks.permission!(request, controller.signal))
      .then(optionId => {
        if (this.closed || controller.signal.aborted) return
        const selected = typeof optionId === 'string' && options.some((option: any) => option.optionId === optionId)
        this.permissions.delete(id)
        this.write({ id, result: { outcome: selected ? { outcome: 'selected', optionId } : { outcome: 'cancelled' } } })
      }, () => {
        if (!this.closed && !controller.signal.aborted) {
          this.permissions.delete(id)
          this.write({ id, result: { outcome: { outcome: 'cancelled' } } })
        }
      }).catch(error => this.dispose(error instanceof Error ? error : new Error('ACP permission response failed')))
      .finally(() => { if (this.permissions.get(id) === controller) this.permissions.delete(id) })
  }

  /** Metadata handshake only; does not authenticate or create a native session. */
  async initialize(): Promise<any> {
    const initialized = await this.request('initialize', {
      protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'ekko-studio', version: '1.0.0' },
    })
    if (initialized?.protocolVersion !== 1) throw new Error('Unsupported ACP protocol version')
    return initialized
  }

  async prompt(input: { cwd: string; text: string; images?: AcpImageInput[]; nativeSessionId?: string; mcpServers: object[]; model?: string; reasoningEffort?: string }): Promise<string> {
    const initialized = await this.initialize()
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
    this.loadingSession = true
    let session: any
    try {
      session = await this.request(method, {
        cwd: input.cwd, mcpServers: input.mcpServers,
        ...(input.nativeSessionId ? { sessionId: input.nativeSessionId } : {}),
      })
    } finally { this.loadingSession = false }
    this.sessionId = session?.sessionId || input.nativeSessionId
    if (!this.sessionId || typeof this.sessionId !== 'string') throw new Error('ACP returned no session ID')
    this.callbacks.session(this.sessionId)
    const commands = this.commandCatalogs.get(this.sessionId)
    this.commandCatalogs.clear()
    if (commands) this.callbacks.update(commands)
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
      data: image.data ?? readFileSync(image.path!).toString('base64'),
    })
    const result = await this.request('session/prompt', { sessionId: this.sessionId, prompt }, 0)
    if (this.permissions.size) throw new Error('ACP prompt finished with unresolved permissions')
    this.child.stdin?.end()
    return String(result?.stopReason || 'unknown')
  }

  cancel() {
    if (this.closed) return
    this.cancelling = true
    for (const [id, controller] of this.permissions) {
      controller.abort()
      try { this.write({ id, result: { outcome: { outcome: 'cancelled' } } }) } catch {}
    }
    this.permissions.clear()
    try { if (this.sessionId) this.write({ method: 'session/cancel', params: { sessionId: this.sessionId } }) } catch {}
  }

  dispose(error = new Error('ACP turn disposed')) {
    if (this.closed) return
    this.closed = true
    for (const controller of this.permissions.values()) controller.abort()
    this.permissions.clear()
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }
}
