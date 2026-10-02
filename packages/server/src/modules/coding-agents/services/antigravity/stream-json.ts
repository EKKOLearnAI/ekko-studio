/** Antigravity 1.2 stream-json. A model step is NOT an agent turn boundary. */
export type AntigravityEvent =
  | { type: 'session'; sessionId: string; model?: string }
  | { type: 'text'; data: string }
  | { type: 'tool_started'; toolCallId: string; toolName: string; input: unknown }
  | { type: 'tool_completed'; toolCallId: string; output: unknown; failed: boolean }
  | { type: 'complete'; usage?: unknown }
  | { type: 'error'; message: string; usage?: unknown }

function record(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function createAntigravityStreamParser(): (line: string) => AntigravityEvent[] {
  const started = new Set<string>()
  const finished = new Set<string>()
  let text = ''
  let terminal = false
  return line => {
    if (terminal) return []
    let event: any
    try { event = JSON.parse(line) } catch { return [] }
    if (!record(event)) return []
    if (event.event === 'init') {
      const sessionId = String(event.conversation_id || '')
      return sessionId ? [{ type: 'session', sessionId, model: event.init?.model }] : []
    }
    if (event.event === 'step_update' && record(event.step_update)) {
      const step = event.step_update
      if (step.step_type === 'agent_response' && typeof step.text_delta === 'string') {
        text += step.text_delta
        return step.text_delta ? [{ type: 'text', data: step.text_delta }] : []
      }
      if (step.step_type !== 'tool' || !record(step.tool_info) || !Number.isInteger(step.step_index)) return []
      const info = step.tool_info
      const id = `${String(step.conversation_id || '')}:step:${step.step_index}`
      const events: AntigravityEvent[] = []
      if (!started.has(id)) {
        started.add(id)
        events.push({ type: 'tool_started', toolCallId: id, toolName: String(info.name || step.tool_name || 'tool'), input: info.parameters ?? {} })
      }
      if ((step.state === 'DONE' || step.state === 'ERROR') && !finished.has(id)) {
        finished.add(id)
        events.push({ type: 'tool_completed', toolCallId: id, output: info.error ?? info.output ?? '', failed: Boolean(info.error) })
      }
      return events
    }
    if (event.event !== 'result' || !record(event.result)) return []
    terminal = true
    const result = event.result
    const events: AntigravityEvent[] = []
    if (result.conversation_id) events.push({ type: 'session', sessionId: String(result.conversation_id) })
    // Result.response repeats streamed text. Only use it when no text was streamed.
    if (!text && typeof result.response === 'string' && result.response) events.push({ type: 'text', data: result.response })
    // One process per turn: consume final usage only, never add per-step usage.
    const usage = record(result.usage) ? {
      ...result.usage,
      reasoning_tokens: result.usage.thinking_tokens,
      duration_ms: typeof result.duration_seconds === 'number' ? result.duration_seconds * 1000 : undefined,
    } : undefined
    events.push(result.status === 'SUCCESS'
      ? { type: 'complete', usage }
      : { type: 'error', message: String(result.error || `Antigravity turn ended with ${result.status || 'unknown status'}`), usage })
    return events
  }
}
