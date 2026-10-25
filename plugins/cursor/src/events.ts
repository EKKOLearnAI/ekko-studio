import { StudioError, type JsonObject } from '@ekko-studio/plugin-sdk'

export type CursorRecord = Record<string, any> & { type: string }
export function record(value: unknown): CursorRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof (value as CursorRecord).type !== 'string') throw new StudioError('INVALID_ARGUMENT', 'Invalid Cursor stream record')
  return value as CursorRecord
}
export function sessionId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/.test(value)) throw new StudioError('INVALID_ARGUMENT', 'Invalid Cursor session identity')
  return value
}
export function text(event: CursorRecord) {
  return Array.isArray(event.message?.content) ? event.message.content.filter((part: any) => part?.type === 'text').map((part: any) => typeof part.text === 'string' ? part.text : '').join('') : ''
}
export function tool(event: CursorRecord) {
  const entries = event.tool_call
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return
  const key = entries.function && typeof entries.function === 'object' ? 'function' : Object.keys(entries).find(key => entries[key] && typeof entries[key] === 'object')
  if (!key || typeof event.call_id !== 'string' || !event.call_id || event.call_id.length > 256) return
  const value = entries[key]
  let data = value.args ?? value
  if (key === 'function') { data = value.arguments ?? value; if (typeof data === 'string') { try { data = JSON.parse(data) } catch { /* Native opaque arguments remain text. */ } } }
  const output = value.result ?? null
  return { callId: event.call_id, name: key === 'function' ? String(value.name || 'function') : key.replace(/ToolCall$/, ''), data: data as JsonObject,
    output, failed: Boolean(output && typeof output === 'object' && (output.error || output.failure)) }
}
export function usage(value: any) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  const input = value.inputTokens ?? value.input_tokens, output = value.outputTokens ?? value.output_tokens
  if (input === undefined && output === undefined) return
  const read = value.cacheReadTokens ?? value.cache_read_input_tokens ?? 0, write = value.cacheWriteTokens ?? value.cache_creation_input_tokens ?? 0
  const reasoning = value.reasoningTokens ?? value.reasoning_tokens
  if (![input, output, read, write, ...(reasoning === undefined ? [] : [reasoning])].every(n => Number.isSafeInteger(n) && n >= 0) || !Number.isSafeInteger(input + read + write)) throw new StudioError('INVALID_ARGUMENT', 'Invalid Cursor token usage')
  return { inputTokens: input + read + write, outputTokens: output, cacheReadTokens: read, cacheWriteTokens: write, ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }) }
}
