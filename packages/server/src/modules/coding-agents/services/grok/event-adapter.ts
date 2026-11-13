import type { GrokStreamEvent } from './streaming-json'

export interface GrokEventSink {
  text: (value: string) => void
  thought: (value: string) => void
  toolStarted: (value: { id: string; name: string; input: unknown }) => void
  toolCompleted: (value: { id: string; output: unknown; failed: boolean }) => void
  usage: (value: unknown) => void
  session: (sessionId: string) => void
  complete: (usage: unknown) => void
  error: (message: string, usage?: unknown) => void
  status: (message: string) => void
}

function stringifyPlan(entries: unknown): string {
  if (!Array.isArray(entries) || entries.length === 0) return ''
  return entries
    .map((entry: any, index) => `${index + 1}. ${String(entry?.content || entry?.title || entry || '')}`)
    .filter(Boolean)
    .join('\n')
}

export function applyGrokStreamEvent(event: GrokStreamEvent, sink: GrokEventSink): void {
  if (event.type === 'text') sink.text(event.data)
  else if (event.type === 'thought') sink.thought(event.data)
  else if (event.type === 'tool_call') {
    sink.toolStarted({ id: event.toolCallId, name: event.toolName || event.title, input: event.rawInput })
  } else if (event.type === 'tool_call_update') {
    const terminal = event.status === 'completed' || event.status === 'failed'
    if (terminal) {
      sink.toolCompleted({
        id: event.toolCallId,
        output: event.rawOutput ?? event.content,
        failed: event.status === 'failed',
      })
    }
  } else if (event.type === 'plan') {
    const plan = stringifyPlan(event.entries)
    if (plan) sink.thought(plan)
  } else if (event.type === 'usage') sink.usage(event.usage)
  else if (event.type === 'end') {
    if (event.sessionId) sink.session(event.sessionId)
    sink.complete(event.usage)
  } else if (event.type === 'error') sink.error(event.message, event.usage)
  else if (event.type === 'status') sink.status(event.message)
}
