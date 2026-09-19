export type CursorStreamEvent =
  | { type: 'session'; sessionId: string; model?: string }
  | { type: 'text'; data: string }
  | { type: 'tool_started'; toolCallId: string; toolName: string; input: unknown }
  | { type: 'tool_completed'; toolCallId: string; output: unknown; failed: boolean }
  | { type: 'complete'; sessionId: string; result: string; usage?: unknown }
  | { type: 'error'; message: string; sessionId?: string; usage?: unknown }

export interface ParseCursorStreamJsonOptions {
  /**
   * Studio launches Cursor with `--stream-partial-output`. In that mode only
   * assistant events with `timestamp_ms` and without `model_call_id` carry new
   * text; the other assistant flushes are documented duplicates.
   */
  streamPartial?: boolean
}

function assistantText(event: any): string {
  const content = event?.message?.content
  if (!Array.isArray(content)) return String(event?.message?.text || event?.text || '')
  return content
    .map((part: any) => part?.type === 'text' ? String(part.text || '') : '')
    .join('')
}

function hasOwn(value: any, key: string): boolean {
  return Boolean(value) && Object.prototype.hasOwnProperty.call(value, key)
}

function shouldEmitAssistantText(event: any, streamPartial: boolean): boolean {
  const hasTimestamp = hasOwn(event, 'timestamp_ms')
  const hasModelCallId = String(event?.model_call_id || '').trim().length > 0
  if (hasModelCallId) return false
  if (streamPartial) return hasTimestamp
  return true
}

function firstToolEntry(toolCall: any): { key: string; payload: any } | null {
  if (!toolCall || typeof toolCall !== 'object') return null
  if (toolCall.function && typeof toolCall.function === 'object') {
    return { key: 'function', payload: toolCall.function }
  }
  const key = Object.keys(toolCall).find(name => toolCall[name] && typeof toolCall[name] === 'object')
  if (!key) return null
  return { key, payload: toolCall[key] }
}

function toolNameFromEntry(entry: { key: string; payload: any }): string {
  if (entry.key === 'function') return String(entry.payload?.name || 'function')
  return entry.key.endsWith('ToolCall') ? entry.key.slice(0, -'ToolCall'.length) : entry.key
}

function toolInputFromEntry(entry: { key: string; payload: any }): unknown {
  if (entry.key === 'function') {
    const args = entry.payload?.arguments
    if (typeof args === 'string') {
      try {
        return JSON.parse(args)
      } catch {
        return args
      }
    }
    return args ?? entry.payload
  }
  return entry.payload?.args ?? entry.payload
}

function toolFailed(payload: any): boolean {
  const result = payload?.result
  if (!result || typeof result !== 'object') return false
  return Boolean(result.error || result.failure)
}

function usageFromResult(event: any): unknown {
  const usage: Record<string, unknown> = {}
  if (event.duration_ms != null) usage.duration_ms = event.duration_ms
  if (event.duration_api_ms != null) usage.duration_api_ms = event.duration_api_ms
  return Object.keys(usage).length > 0 ? usage : undefined
}

export function parseCursorStreamJsonLine(
  line: string,
  options: ParseCursorStreamJsonOptions = {},
): CursorStreamEvent | null {
  const trimmed = String(line || '').trim()
  if (!trimmed) return null
  let event: any
  try {
    event = JSON.parse(trimmed)
  } catch {
    return null
  }
  const type = String(event?.type || '').trim()
  const streamPartial = options.streamPartial !== false

  if (type === 'system' && String(event.subtype || '') === 'init') {
    const sessionId = String(event.session_id || '')
    if (!sessionId) return null
    return {
      type: 'session',
      sessionId,
      ...(event.model ? { model: String(event.model) } : {}),
    }
  }

  if (type === 'assistant') {
    if (!shouldEmitAssistantText(event, streamPartial)) return null
    const data = assistantText(event)
    return data ? { type: 'text', data } : null
  }

  if (type === 'tool_call') {
    const entry = firstToolEntry(event.tool_call)
    const toolCallId = String(event.call_id || '')
    const subtype = String(event.subtype || '')
    if (!entry || !toolCallId) return null
    if (subtype === 'started') {
      return {
        type: 'tool_started',
        toolCallId,
        toolName: toolNameFromEntry(entry),
        input: toolInputFromEntry(entry),
      }
    }
    if (subtype === 'completed') {
      return {
        type: 'tool_completed',
        toolCallId,
        output: entry.payload?.result,
        failed: toolFailed(entry.payload),
      }
    }
    return null
  }

  if (type === 'result') {
    const sessionId = String(event.session_id || '')
    const failed = event.is_error === true || String(event.subtype || '') === 'error'
    const usage = usageFromResult(event)
    if (failed) {
      return {
        type: 'error',
        message: String(event.result || event.message || 'Cursor run failed'),
        ...(sessionId ? { sessionId } : {}),
        ...(usage ? { usage } : {}),
      }
    }
    return {
      type: 'complete',
      sessionId,
      result: String(event.result || ''),
      ...(usage ? { usage } : {}),
    }
  }

  return null
}
