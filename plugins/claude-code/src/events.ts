import { StudioError, type AgentOutputEvent } from '@ekko-studio/plugin-sdk'
import type { ClaudeRecord } from './rpc'

export type Output = AgentOutputEvent extends infer T ? T extends AgentOutputEvent ? Omit<T, 'producerSequence'> : never : never
export type UsageTotals = Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning?: number }>
const id = (value: unknown): value is string => typeof value === 'string' && !!value && value.length <= 256
const token = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0

export function usageTotals(value: unknown): UsageTotals {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 128) throw new StudioError('INVALID_ARGUMENT', 'Invalid Claude model usage')
  const totals: UsageTotals = Object.create(null)
  for (const [model, raw] of Object.entries(value)) {
    const usage = raw as Record<string, number>
    if (!id(model) || !usage || !['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens'].every(key => token(usage[key]))) throw new StudioError('INVALID_ARGUMENT', 'Invalid Claude model usage')
    const input = usage.inputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens
    if (!token(input)) throw new StudioError('INVALID_ARGUMENT', 'Invalid Claude input usage')
    if (usage.thinkingTokens !== undefined && (!token(usage.thinkingTokens) || usage.thinkingTokens > usage.outputTokens)) throw new StudioError('INVALID_ARGUMENT', 'Invalid Claude reasoning usage')
    totals[model] = { input, output: usage.outputTokens, cacheRead: usage.cacheReadInputTokens, cacheWrite: usage.cacheCreationInputTokens,
      ...(usage.thinkingTokens !== undefined ? { reasoning: usage.thinkingTokens } : {}) }
  }
  return totals
}

/** Stream deltas and authoritative assistant snapshots share the native message id. */
export function claudeEvents(emit: (event: Output) => void) {
  const tools = new Map<string, { name: string; done: boolean }>(), messages = new Set<string>()
  const snapshots = new Map<string, string>(), frames = new Set<string>()
  let message: string | undefined, rendered = false, notices = 0, snapshotBytes = 0
  function tool(block: any) {
    if (!id(block.id) || !id(block.name)) throw new StudioError('INVALID_ARGUMENT', 'Invalid Claude tool identity')
    if (!tools.has(block.id)) {
      if (tools.size >= 256) throw new StudioError('RESOURCE_EXHAUSTED', 'Claude tool count exceeded')
      tools.set(block.id, { name: block.name, done: false })
      emit({ type: 'tool.started', callId: block.id, name: block.name, data: block.input ?? null })
    }
  }
  return {
    record(record: ClaudeRecord) {
      if (record.parent_tool_use_id) return
      if (record.type === 'stream_event') {
        const event = record.event
        if (event?.type === 'message_start') {
          if (!id(event.message?.id)) throw new StudioError('INVALID_ARGUMENT', 'Invalid Claude message identity')
          message = event.message.id
          if (messages.size >= 256 && !messages.has(message!)) throw new StudioError('RESOURCE_EXHAUSTED', 'Claude message count exceeded')
          messages.add(message!)
        } else if (event?.type === 'content_block_delta') {
          if (!message) throw new StudioError('INVALID_ARGUMENT', 'Claude delta has no message')
          if (event.delta?.type === 'text_delta' && typeof event.delta.text === 'string') {
            rendered = true; emit({ type: 'message.delta', messageId: message, text: event.delta.text })
          } else if (event.delta?.type === 'thinking_delta' && typeof event.delta.thinking === 'string') emit({ type: 'reasoning.delta', messageId: message, text: event.delta.thinking })
        }
      } else if (record.type === 'assistant') {
        if (record.isApiErrorMessage || record.error) throw new StudioError('RUNTIME_UNAVAILABLE', 'Claude model request failed')
        const value = record.message
        if (!id(value?.id) || !Array.isArray(value.content)) throw new StudioError('INVALID_ARGUMENT', 'Invalid Claude assistant message')
        if (messages.size >= 256 && !messages.has(value.id)) throw new StudioError('RESOURCE_EXHAUSTED', 'Claude message count exceeded')
        messages.add(value.id)
        const text = value.content.filter((block: any) => block?.type === 'text').map((block: any) => {
          if (typeof block.text !== 'string') throw new StudioError('INVALID_ARGUMENT', 'Invalid Claude text block')
          return block.text
        }).join('')
        if (text) {
          // Streamed assistant envelopes contain one completed block, not the
          // whole message. Consecutive envelopes can share the same message id.
          if (value.stop_reason === null) {
            if (!id(record.uuid)) throw new StudioError('INVALID_ARGUMENT', 'Claude partial assistant has no delivery identity')
            if (frames.has(record.uuid)) return
            if (frames.size >= 1024) throw new StudioError('RESOURCE_EXHAUSTED', 'Claude assistant block count exceeded')
            frames.add(record.uuid)
          }
          const previous = snapshots.get(value.id) || '', full = value.stop_reason === null ? previous + text : text
          snapshotBytes += Buffer.byteLength(full) - Buffer.byteLength(previous)
          if (snapshotBytes > 4 * 1024 * 1024) throw new StudioError('RESOURCE_EXHAUSTED', 'Claude message text exceeded its limit')
          snapshots.set(value.id, full)
          rendered = true; emit({ type: 'message.snapshot', messageId: value.id, text: full })
        }
        for (const block of value.content) if (block?.type === 'tool_use') tool(block)
      } else if (record.type === 'user' && typeof record.message?.content === 'string') {
        const output = /^<local-command-(stdout|stderr)>([\s\S]*)<\/local-command-\1>$/.exec(record.message.content)
        if (output) {
          rendered = true; emit({ type: 'message.snapshot', messageId: `claude-command-${++notices}`, text: output[2] })
          return output[1] !== 'stderr'
        }
      } else if (record.type === 'user' && Array.isArray(record.message?.content)) {
        for (const block of record.message.content) if (block?.type === 'tool_result') {
          const entry = tools.get(block.tool_use_id)
          if (!entry || entry.done) continue
          entry.done = true
          emit({ type: block.is_error ? 'tool.failed' : 'tool.completed', callId: block.tool_use_id, name: entry.name, data: block.content ?? null })
        }
      } else if (record.type === 'system' && record.subtype === 'local_command_output' && typeof record.content === 'string') {
        rendered = true; emit({ type: 'message.snapshot', messageId: `claude-command-${++notices}`, text: record.content })
      }
    },
    final(record: ClaudeRecord) {
      if (!rendered && typeof record.result === 'string' && record.result) emit({ type: 'message.snapshot', messageId: 'claude-result', text: record.result })
    },
  }
}
