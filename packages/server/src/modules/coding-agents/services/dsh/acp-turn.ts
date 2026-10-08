import type { ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'
import type { CodingAgentImageInput } from '../../protocol/types'
import { dshReasoningEffort } from './runtime-config'
import { DSH_STREAM_METHOD, DSH_USAGE_METHOD } from './stream-plugin'
import { logger } from '../../../studio/public/logging'

interface StreamedText { agent_message_chunk: string; agent_thought_chunk: string }

interface Pending {
  resolve(value: any): void
  reject(error: Error): void
  timer?: ReturnType<typeof setTimeout>
}

/** One ACP connection belongs to exactly one Studio turn and its spawned process. */
export class DshAcpTurn {
  private pending = new Map<number, Pending>()
  private sequence = 0
  private buffer = ''
  private decoder = new StringDecoder('utf8')
  private closed = false
  private sessionId = ''
  private attempts = new Map<string, StreamedText>()
  private committed = new Map<string, StreamedText>()

  constructor(private child: ChildProcess, private callbacks: {
    update(update: any): void
    session(id: string): void
    config(options: any[]): void
    usage?(event: any): void
    permissionRequired?: boolean
  }) {
    child.stdout?.on('data', (chunk: Buffer) => {
      try {
        this.buffer += this.decoder.write(chunk)
        if (this.buffer.length > 16 * 1024 * 1024) throw new Error('DSH ACP message exceeds 16 MiB')
        let end: number
        while ((end = this.buffer.indexOf('\n')) >= 0) {
          const line = this.buffer.slice(0, end).trim()
          this.buffer = this.buffer.slice(end + 1)
          if (line) this.receiveLine(line)
        }
      } catch (error) { this.dispose(error instanceof Error ? error : new Error(String(error))) }
    })
    child.on('error', error => this.dispose(error))
    child.on('close', () => this.dispose(new Error('DSH ACP connection closed before the request completed')))
    child.stdin?.on('error', error => this.dispose(error))
  }

  // A valid ACP frame is always a JSON object, so any line not starting with '{'
  // is dependency stdout noise (e.g. the MCP SDK's console.debug), not the
  // protocol. Skip and warn instead of disposing the whole turn; only a line that
  // looks like JSON but fails to parse is a real protocol break and stays fatal.
  private receiveLine(line: string) {
    if (!line.startsWith('{')) {
      logger.warn({ line: line.slice(0, 500) }, '[dsh] skipping non-JSON line on ACP stdout')
      return
    }
    this.receive(JSON.parse(line))
  }

  private write(message: unknown) {
    if (this.closed || !this.child.stdin?.writable) throw new Error('DSH ACP connection is closed')
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message as object })}\n`)
  }

  private request(method: string, params: unknown, timeout = 60_000): Promise<any> {
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      const timer = timeout ? setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`DSH ACP ${method} timed out`))
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
      if (message.method === DSH_USAGE_METHOD && this.sessionId) {
        try { this.callbacks.usage?.(message.params) }
        catch (err) { logger.warn({ err }, '[dsh] failed to record native usage') }
      } else if (message.method === 'session/update' && message.params?.sessionId === this.sessionId) {
        this.receiveUpdate(message.params.update)
      } else if (message.method === DSH_STREAM_METHOD && message.params?.sessionId === this.sessionId) {
        this.receiveStream(message.params.frame)
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
    if (message.error) pending.reject(new Error(`DSH ACP: ${message.error.message || 'request failed'}`))
    else pending.resolve(message.result)
  }

  private receiveStream(frame: any) {
    if (!frame || typeof frame.attemptId !== 'string') return
    if (frame.type === 'start') {
      this.attempts.set(frame.attemptId, { agent_message_chunk: '', agent_thought_chunk: '' })
      return
    }
    const attempt = this.attempts.get(frame.attemptId)
    if (!attempt) return
    if (frame.type === 'end') this.attempts.delete(frame.attemptId)
    else if (frame.type === 'commit' && typeof frame.messageId === 'string') {
      this.committed.set(frame.messageId, { ...attempt })
    } else if ((frame.type === 'text-delta' || frame.type === 'reasoning-delta') && typeof frame.text === 'string' && frame.text) {
      const sessionUpdate = frame.type === 'text-delta' ? 'agent_message_chunk' : 'agent_thought_chunk'
      attempt[sessionUpdate] += frame.text
      this.callbacks.update({ sessionUpdate, content: { type: 'text', text: frame.text } })
    }
  }

  private receiveUpdate(update: any) {
    const streamed = this.committed.get(update?.messageId)
    const kind: unknown = update?.sessionUpdate
    if (streamed && (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk') && update.content?.type === 'text') {
      const remaining = streamed[kind]
      const text = update.content.text
      // Consume only this message's streamed prefix; identical text in another
      // model call or a retry is a new delta. Keep final-only suffixes as fallback.
      if (remaining.startsWith(text)) {
        streamed[kind] = remaining.slice(text.length)
        return
      }
      streamed[kind] = ''
      if (text.startsWith(remaining)) update = { ...update, content: { ...update.content, text: text.slice(remaining.length) } }
    }
    this.callbacks.update(update)
  }

  async prompt(input: {
    cwd: string
    nativeSessionId?: string
    agentPreset?: string
    modelValue?: string
    reasoningEffort?: string
    text: string
    images: CodingAgentImageInput[]
  }): Promise<string> {
    const initialized = await this.request('initialize', {
      protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'ekko-studio', version: '1.0.0' },
    })
    if (initialized?.protocolVersion !== 1) throw new Error('Unsupported DSH ACP protocol version')
    if (input.images.length && !initialized.agentCapabilities?.promptCapabilities?.image) {
      throw new Error('The configured DSH model does not support image prompts')
    }
    const session = await this.request(input.nativeSessionId ? 'session/resume' : 'session/new', {
      ...(!input.nativeSessionId && input.agentPreset ? { _meta: { agentPreset: input.agentPreset } } : {}),
      cwd: input.cwd, mcpServers: [], ...(input.nativeSessionId ? { sessionId: input.nativeSessionId } : {}),
    })
    this.sessionId = input.nativeSessionId || session?.sessionId
    if (typeof this.sessionId !== 'string' || !this.sessionId) throw new Error('DSH ACP returned no session ID')
    this.callbacks.session(this.sessionId)
    let options = session.configOptions || []
    if (input.modelValue) {
      const configured = await this.request('session/set_config_option', {
        sessionId: this.sessionId, configId: 'model', value: input.modelValue,
      })
      options = configured.configOptions || options
    }
    const effort = dshReasoningEffort(input.reasoningEffort)
    if (effort) {
      const configured = await this.request('session/set_config_option', {
        sessionId: this.sessionId, configId: 'reasoning_effort', value: effort,
      })
      options = configured.configOptions || options
    }
    this.callbacks.config(options)
    const prompt: any[] = input.text ? [{ type: 'text', text: input.text }] : []
    for (const image of input.images) prompt.push({
      type: 'image', mimeType: image.mediaType || 'image/png', data: readFileSync(image.path).toString('base64'),
    })
    const result = await this.request('session/prompt', { sessionId: this.sessionId, prompt }, 0)
    // Explicit close flushes persistence before EOF; the manager owns exit escalation.
    await this.request('session/close', { sessionId: this.sessionId }, 10_000)
    this.child.stdin?.end()
    return String(result?.stopReason || 'unknown')
  }

  cancel() {
    if (this.closed) return
    try { if (this.sessionId) this.write({ method: 'session/cancel', params: { sessionId: this.sessionId } }) } catch {}
  }

  dispose(error = new Error('DSH ACP turn disposed')) {
    if (this.closed) return
    this.closed = true
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
    this.attempts.clear()
    this.committed.clear()
  }
}
