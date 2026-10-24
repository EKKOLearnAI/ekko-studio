import { StudioError } from '../../contracts/plugins'
import { parseSseFrame, readSseFrameTexts } from './protocol/sse'
import { normalizeTokenUsage } from '../usage/token-usage'

export type TranslationStyle = 'openai-chat' | 'openai-responses' | 'anthropic-messages'
const unavailable = () => new StudioError('RUNTIME_UNAVAILABLE', 'Provider translation did not complete')

/** Observe the original wire, before legacy codecs can synthesize counters or completion. */
export class TranslationWire {
  private rawUsage: Record<string, any> = {}
  private completed = false
  status: 'completed' | 'incomplete' | undefined
  constructor(private readonly style: TranslationStyle) {}

  observe(value: any, streaming: boolean): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.error || value.type === 'error') throw unavailable()
    let usage: Record<string, any> | undefined
    if (this.style === 'openai-chat') {
      usage = value.usage
      const reason = value.choices?.[0]?.finish_reason
      if (reason) { this.status = ['length', 'content_filter'].includes(reason) ? 'incomplete' : 'completed'; this.completed = true }
      if (!streaming && !this.status) throw unavailable()
    } else if (this.style === 'openai-responses') {
      const response = streaming ? value.response : value
      usage = response?.usage
      if (value.type === 'response.failed' || response?.status === 'failed') throw unavailable()
      if (!streaming || ['response.completed', 'response.incomplete'].includes(value.type)) {
        if (!['completed', 'incomplete'].includes(response?.status)) throw unavailable()
        this.status = response.status
        this.completed = true
      }
    } else {
      usage = value.type === 'message_start' ? value.message?.usage : value.usage
      if (value.delta?.stop_reason === 'max_tokens' || value.stop_reason === 'max_tokens') this.status = 'incomplete'
      if (value.type === 'message_stop' || (!streaming && value.type === 'message' && value.stop_reason)) { this.status ||= 'completed'; this.completed = true }
    }
    if (usage && typeof usage === 'object') Object.assign(this.rawUsage, usage)
    // Chat usage may arrive after finish_reason, so keep reading until [DONE] or EOF.
    return this.style === 'openai-responses' ? this.status !== undefined
      : this.style === 'anthropic-messages' && (value.type === 'message_stop' || !streaming)
  }

  usage(protocol: 'responses' | 'anthropic'): Record<string, unknown> {
    const raw = this.rawUsage, normalized = normalizeTokenUsage(raw, {}, { inputIncludesCache: this.style !== 'anthropic-messages' })
    const has = (...values: unknown[]) => values.some(value => value != null && Number.isFinite(Number(value)) && Number(value) >= 0)
    return {
      ...(has(raw.input_tokens, raw.prompt_tokens) ? { input_tokens: normalized.inputTokens + (protocol === 'responses' ? normalized.cacheReadTokens + normalized.cacheWriteTokens : 0) } : {}),
      ...(has(raw.output_tokens, raw.completion_tokens) ? { output_tokens: normalized.outputTokens } : {}),
      ...(protocol === 'responses' ? {
        ...(has(raw.input_tokens, raw.prompt_tokens) && has(raw.output_tokens, raw.completion_tokens)
          ? { total_tokens: normalized.inputTokens + normalized.cacheReadTokens + normalized.cacheWriteTokens + normalized.outputTokens } : {}),
        input_tokens_details: { cached_tokens: normalized.cacheReadTokens },
        output_tokens_details: { reasoning_tokens: normalized.reasoningTokens },
        // Internal gateway extension: the Responses standard has no cache-write counter.
        cache_write_tokens: normalized.cacheWriteTokens,
      } : {
        cache_read_input_tokens: normalized.cacheReadTokens,
        cache_creation_input_tokens: normalized.cacheWriteTokens,
        reasoning_tokens: normalized.reasoningTokens,
      }),
    }
  }

  finish() { if (!this.completed) throw unavailable() }
}

/** Bound and normalize upstream frames; a truncated/error stream never becomes adapter EOF success. */
export async function* translationFrames(response: Response, wire: TranslationWire, signal: AbortSignal, check: () => void) {
  const reader = response.body!.getReader(), decoder = new TextDecoder('utf-8', { fatal: true }), encoder = new TextEncoder()
  let buffer = '', bytes = 0
  const cancel = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    while (true) {
      check()
      const next = await reader.read()
      check()
      bytes += next.value?.byteLength || 0
      if (bytes > 32 * 1024 * 1024) throw new StudioError('RESOURCE_EXHAUSTED', 'Native model output limit exceeded')
      buffer += next.done ? decoder.decode() : decoder.decode(next.value, { stream: true })
      const parsed = readSseFrameTexts(buffer)
      buffer = parsed.rest
      if (next.done && buffer.trim()) { parsed.frames.push(buffer); buffer = '' }
      for (const raw of parsed.frames) {
        if (Buffer.byteLength(raw) > 1024 * 1024) throw new StudioError('RESOURCE_EXHAUSTED', 'Native model frame limit exceeded')
        const frame = parseSseFrame(raw)
        if (!frame) continue
        if (frame.data === '[DONE]') { wire.finish(); return }
        const data = JSON.parse(frame.data)
        if (!data.type && frame.event) data.type = frame.event
        const terminal = wire.observe(data, true)
        yield encoder.encode(`${frame.event ? `event: ${frame.event}\n` : ''}data: ${JSON.stringify(data)}\n\n`)
        if (terminal) { wire.finish(); return }
      }
      if (Buffer.byteLength(buffer) > 1024 * 1024) throw new StudioError('RESOURCE_EXHAUSTED', 'Native model frame limit exceeded')
      if (next.done) { wire.finish(); return }
    }
  } finally {
    signal.removeEventListener('abort', cancel)
    try { await reader.cancel() } finally { reader.releaseLock() }
  }
}

export async function translationJson(response: Response): Promise<any> {
  const reader = response.body!.getReader(), chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      bytes += next.value.byteLength
      if (bytes > 32 * 1024 * 1024) throw new StudioError('RESOURCE_EXHAUSTED', 'Native model output limit exceeded')
      chunks.push(next.value)
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
  } finally { try { await reader.cancel() } finally { reader.releaseLock() } }
}
