import { StudioError, type JsonObject, type JsonValue } from '@ekko-studio/plugin-sdk'

export const record = (value: unknown): value is JsonObject => !!value && typeof value === 'object' && !Array.isArray(value)
export interface NativeUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
}
function usage(value: unknown): NativeUsage | undefined {
  if (!record(value)) return
  const counter = (name: string) =>
    value[name] === undefined ? 0 : Number.isSafeInteger(value[name]) && Number(value[name]) >= 0 ? Number(value[name]) : NaN
  const result = {
    inputTokens: counter('input_tokens'),
    outputTokens: counter('output_tokens'),
    cacheReadTokens: counter('cache_read_tokens'),
    cacheWriteTokens: counter('cache_write_tokens'),
    reasoningTokens: counter('thinking_tokens'),
  }
  if ((value.input_tokens === undefined && value.output_tokens === undefined) || !Object.values(result).every(Number.isSafeInteger)) return
  return result
}
export type NativeEvent =
  | { type: 'session'; id: string; model?: string }
  | { type: 'text'; text: string }
  | { type: 'tool'; id: string; name: string; input: JsonValue; output?: JsonValue; failed?: boolean }
  | { type: 'terminal'; success: boolean; usage?: NativeUsage }

/** Each parser belongs to one process/input; final result usage is conversation-cumulative on resume. */
export function nativeParser(resumed: boolean) {
  const tools = new Set<string>(),
    finished = new Set<string>(),
    usages = new Map<string, NativeUsage>()
  let session = '',
    hasText = false,
    terminal = false
  return (line: string): NativeEvent[] => {
    if (terminal || !line.trim()) return []
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      throw new StudioError('INVALID_ARGUMENT', 'Invalid Antigravity stream JSON')
    }
    if (!record(value)) throw new StudioError('INVALID_ARGUMENT', 'Invalid Antigravity event')
    const events: NativeEvent[] = []
    const identify = (id: JsonValue | undefined, model?: JsonValue) => {
      if (id === undefined || id === '') return
      if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(id) || (session && id !== session))
        throw new StudioError('INVALID_ARGUMENT', 'Antigravity conversation identity changed')
      session = id
      events.push({ type: 'session', id, ...(typeof model === 'string' ? { model } : {}) })
    }
    if (value.event === 'init') {
      identify(value.conversation_id, record(value.init) ? value.init.model : undefined)
      return events
    }
    if (value.event === 'step_update' && record(value.step_update)) {
      const step = value.step_update
      if (step.conversation_id !== undefined) identify(step.conversation_id)
      if (['agent_response', 'checkpoint'].includes(String(step.step_type))) {
        if (['DONE', 'ERROR'].includes(String(step.state)) && Number.isSafeInteger(step.step_index) && Number(step.step_index) >= 0) {
          const parsed = usage(step.usage)
          if (parsed) {
            if (usages.size >= 1024 && !usages.has(String(step.step_index)))
              throw new StudioError('RESOURCE_EXHAUSTED', 'Antigravity model step limit exceeded')
            usages.set(String(step.step_index), parsed)
          }
        }
        if (step.step_type === 'agent_response' && typeof step.text_delta === 'string' && step.text_delta) {
          hasText = true
          events.push({ type: 'text', text: step.text_delta })
        }
      } else if (
        step.step_type === 'tool' &&
        record(step.tool_info) &&
        Number.isSafeInteger(step.step_index) &&
        Number(step.step_index) >= 0
      ) {
        const id = `${session}:step:${step.step_index}`,
          info = step.tool_info,
          name = String(info.name || step.tool_name || 'tool')
        if (!tools.has(id)) {
          if (tools.size >= 512) throw new StudioError('RESOURCE_EXHAUSTED', 'Antigravity tool limit exceeded')
          tools.add(id)
          events.push({ type: 'tool', id, name, input: info.parameters ?? {} })
        }
        if (['DONE', 'ERROR'].includes(String(step.state)) && !finished.has(id)) {
          finished.add(id)
          events.push({
            type: 'tool',
            id,
            name,
            input: info.parameters ?? {},
            output: info.error ?? info.output ?? '',
            failed: step.state === 'ERROR' || !!info.error,
          })
        }
      }
      return events
    }
    if (value.event !== 'result' || !record(value.result)) return events
    terminal = true
    const result = value.result
    identify(result.conversation_id)
    if (!hasText && typeof result.response === 'string' && result.response) events.push({ type: 'text', text: result.response })
    const rows = [...usages.values()]
    const total = rows.length
      ? rows.reduce(
          (sum, row) =>
            Object.fromEntries(
              Object.keys(sum).map((key) => [key, sum[key as keyof NativeUsage] + row[key as keyof NativeUsage]]),
            ) as unknown as NativeUsage,
          { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
        )
      : !resumed && !(Number(result.num_turns) > 1)
        ? usage(result.usage)
        : undefined
    if (total && !Object.values(total).every(Number.isSafeInteger)) throw new StudioError('INVALID_ARGUMENT', 'Antigravity usage overflow')
    events.push({ type: 'terminal', success: result.status === 'SUCCESS', ...(total ? { usage: total } : {}) })
    return events
  }
}
