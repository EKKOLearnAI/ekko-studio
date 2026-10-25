import { StudioError, type ModelCallRecord, type ModelGatewayInput } from '../../contracts/plugins'
import { normalizeTokenUsage } from '../usage/token-usage'

type Status = Extract<ModelCallRecord['status'], 'completed' | 'incomplete'>
const unavailable = () => new StudioError('RUNTIME_UNAVAILABLE', 'Native model response is unavailable')

/** Observe counters and completion without translating native tools, signatures or images. */
export class NativeModelWire {
  usage: ReturnType<typeof normalizeTokenUsage> | undefined
  status: Status | undefined
  private anthropicUsage: Record<string, unknown> = {}
  constructor(readonly protocol: ModelGatewayInput['protocol']) {}

  finishChat(): void {
    if (this.protocol !== 'chat-completions' || !this.status) throw unavailable()
  }

  observe(value: any, streaming: boolean): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.error || value.type === 'error') throw unavailable()
    if (this.protocol === 'chat-completions') {
      if (!Array.isArray(value.choices) || value.choices.length > 1 || !streaming && value.choices.length !== 1) throw unavailable()
      if (value.usage) this.usage = normalizeTokenUsage(value.usage, {}, { inputIncludesCache: true })
      const reason = value.choices[0]?.finish_reason
      if (reason) this.status = ['length', 'content_filter'].includes(reason) ? 'incomplete' : 'completed'
      if (!streaming && !this.status) throw unavailable()
      // Streaming usage can arrive after finish_reason. [DONE] closes the wire.
      return !streaming
    } else if (this.protocol === 'responses') {
      const response = streaming ? value.response : value
      if (response?.usage) this.usage = normalizeTokenUsage(response.usage, {}, { inputIncludesCache: true })
      if (value.type === 'response.failed' || response?.status === 'failed') throw unavailable()
      if (!streaming || ['response.completed', 'response.incomplete'].includes(value.type)) {
        if (!['completed', 'incomplete'].includes(response?.status)) throw unavailable()
        this.status = response.status
      }
    } else {
      if (value.type === 'message_start' && value.message?.usage) Object.assign(this.anthropicUsage, value.message.usage)
      if (value.type === 'message_delta' && value.usage) Object.assign(this.anthropicUsage, value.usage)
      if (!streaming && value.usage) Object.assign(this.anthropicUsage, value.usage)
      if (Object.keys(this.anthropicUsage).length) this.usage = normalizeTokenUsage(this.anthropicUsage)
      if (value.delta?.stop_reason === 'max_tokens' || value.stop_reason === 'max_tokens') this.status = 'incomplete'
      if (value.type === 'message_stop' || (!streaming && value.type === 'message' && value.stop_reason)) {
        this.status ||= 'completed'
        return true
      }
      return false
    }
    return this.status !== undefined
  }
}

/** A bounded SSE decoder, including CRLF and multiline data. Terminal frames are held by the caller until accounting commits. */
export async function* nativeModelFrames(response: Response, streaming: boolean, wire: NativeModelWire) {
  if (!response.ok || !response.body) { await response.body?.cancel(); throw unavailable() }
  const mediaType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
  if (mediaType !== (streaming ? 'text/event-stream' : 'application/json')) { await response.body.cancel(); throw unavailable() }
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true })
  let buffer = '', bytes = 0, tail = ''
  try {
    while (true) {
      const { value, done } = await reader.read()
      bytes += value?.byteLength || 0
      if (bytes > 32 * 1024 * 1024) throw new StudioError('RESOURCE_EXHAUSTED', 'Native model output limit exceeded')
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
      if (streaming) {
        let match: RegExpExecArray | null
        while ((match = /\r?\n\r?\n/.exec(buffer))) {
          const frame = buffer.slice(0, match.index), data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n')
          buffer = buffer.slice(match.index + match[0].length)
          if (Buffer.byteLength(frame) > 1024 * 1024) throw new StudioError('RESOURCE_EXHAUSTED', 'Native model frame limit exceeded')
          if (!data) { yield { data: `${frame}\n\n`, terminal: false }; continue }
          if (data === '[DONE]') {
            wire.finishChat()
            yield { data: `${tail}${frame}\n\n`, terminal: true }
            return
          }
          const terminal = wire.observe(JSON.parse(data), true)
          if (wire.protocol === 'chat-completions' && wire.status) {
            tail += `${frame}\n\n`
            if (Buffer.byteLength(tail) > 1024 * 1024) throw new StudioError('RESOURCE_EXHAUSTED', 'Native terminal output limit exceeded')
            continue
          }
          yield { data: `${frame}\n\n`, terminal }
          if (terminal) return
        }
        if (Buffer.byteLength(buffer) > 1024 * 1024) throw new StudioError('RESOURCE_EXHAUSTED', 'Native model frame limit exceeded')
      }
      if (done) break
    }
    if (streaming) throw unavailable() // EOF without a native terminal is not success.
    if (!wire.observe(JSON.parse(buffer), false)) throw unavailable()
    yield { data: buffer, terminal: true }
  } finally { try { await reader.cancel() } finally { reader.releaseLock() } }
}
