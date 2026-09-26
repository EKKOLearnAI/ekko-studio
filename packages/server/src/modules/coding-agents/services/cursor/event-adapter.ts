import type { CursorStreamEvent } from './stream-json'

export interface CursorEventSink {
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

export function applyCursorStreamEvent(event: CursorStreamEvent, sink: CursorEventSink): void {
  if (event.type === 'text') sink.text(event.data)
  else if (event.type === 'tool_started') {
    sink.toolStarted({ id: event.toolCallId, name: event.toolName, input: event.input })
  } else if (event.type === 'tool_completed') {
    sink.toolCompleted({ id: event.toolCallId, output: event.output, failed: event.failed })
  }   else if (event.type === 'session') sink.session(event.sessionId)
  else if (event.type === 'complete') {
    if (event.sessionId) sink.session(event.sessionId)
    sink.complete(event.usage)
  } else if (event.type === 'error') {
    sink.error(event.message, event.usage)
  }
}
