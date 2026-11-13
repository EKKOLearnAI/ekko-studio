export type GrokStreamEvent =
  | { type: 'text'; data: string }
  | { type: 'thought'; data: string }
  | { type: 'tool_call'; toolCallId: string; title: string; toolName: string; rawInput: unknown; status: string }
  | { type: 'tool_call_update'; toolCallId: string; status: string; content: unknown; rawOutput: unknown }
  | { type: 'plan'; entries: unknown }
  | { type: 'usage'; usage: unknown; stopReason: string; messageId?: string }
  | { type: 'end'; sessionId: string; stopReason: string; usage: unknown; modelUsage?: unknown }
  | { type: 'error'; message: string; usage?: unknown; modelUsage?: unknown }
  | { type: 'status'; message: string }

function statusMessage(event: any): string {
  if (event.type === 'auto_compact_started') return `Grok is compacting the session (${Number(event.percentage) || 0}%).`
  if (event.type === 'auto_compact_completed') return 'Grok session compaction completed.'
  if (event.type === 'auto_compact_failed') return `Grok session compaction failed: ${String(event.error || 'Unknown error')}`
  if (event.type === 'max_turns_reached') return 'Grok reached the maximum number of turns.'
  return ''
}

export function parseGrokStreamingJsonLine(line: string): GrokStreamEvent | null {
  const trimmed = String(line || '').trim()
  if (!trimmed) return null
  let event: any
  try {
    event = JSON.parse(trimmed)
  } catch {
    return null
  }
  const type = String(event?.type || '').trim()
  if (type === 'text') return { type, data: String(event.data || '') }
  if (type === 'thought') return { type, data: String(event.data || '') }
  if (type === 'tool_call') {
    return {
      type,
      toolCallId: String(event.toolCallId || ''),
      title: String(event.title || ''),
      toolName: String(event.toolName || event.title || 'Grok Tool'),
      rawInput: event.rawInput,
      status: String(event.status || ''),
    }
  }
  if (type === 'tool_call_update') {
    return {
      type,
      toolCallId: String(event.toolCallId || ''),
      status: String(event.status || ''),
      content: event.content,
      rawOutput: event.rawOutput,
    }
  }
  if (type === 'plan') return { type, entries: event.entries }
  if (type === 'usage') {
    return { type, usage: event.usage ?? event.data?.usage, stopReason: String(event.stopReason || event.data?.stopReason || ''), ...(event.messageId ? { messageId: String(event.messageId) } : {}) }
  }
  if (type === 'end') {
    return {
      type,
      sessionId: String(event.sessionId || ''),
      stopReason: String(event.stopReason || ''),
      usage: event.usage ?? event.data?.usage,
      ...(event.modelUsage || event.data?.modelUsage ? { modelUsage: event.modelUsage ?? event.data?.modelUsage } : {}),
    }
  }
  if (type === 'error') {
    return { type, message: String(event.message || event.data?.message || 'Grok run failed'), usage: event.usage ?? event.data?.usage, ...(event.modelUsage || event.data?.modelUsage ? { modelUsage: event.modelUsage ?? event.data?.modelUsage } : {}) }
  }
  const message = statusMessage(event)
  return message ? { type: 'status', message } : null
}
