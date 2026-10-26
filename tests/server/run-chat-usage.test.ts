import { describe, expect, it, vi } from 'vitest'
import { countTokens } from '../../packages/server/src/modules/studio/services/context-compressor'
import {
  contextTokensWithCachedOverhead,
  estimateUsageTokensFromMessages,
  updateMessageContextTokenUsage,
} from '../../packages/server/src/modules/studio/services/chat-run/usage'

describe('run-chat usage token estimates', () => {
  it('counts message content instead of serialized message payloads', () => {
    const messages = [
      { role: 'user', content: 'hello from user' },
      { role: 'assistant', content: 'hello from assistant' },
    ]

    const usage = estimateUsageTokensFromMessages(messages)

    expect(usage.inputTokens).toBe(countTokens('hello from user'))
    expect(usage.outputTokens).toBe(countTokens('hello from assistant'))
    expect(usage.inputTokens + usage.outputTokens).toBeLessThan(countTokens(JSON.stringify(messages)))
  })

  it('counts array tool_calls by their JSON size on the output side', () => {
    const toolCalls = [{ id: 'call_1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ content: 'x'.repeat(4_000) }) } }]
    const messages = [{ role: 'assistant', content: 'calling tool', tool_calls: toolCalls }]

    const usage = estimateUsageTokensFromMessages(messages)

    expect(usage.inputTokens).toBe(0)
    expect(usage.outputTokens).toBe(countTokens('calling tool') + countTokens(JSON.stringify(toolCalls)))
  })

  it('counts assistant reasoning_content toward output tokens', () => {
    const reasoning = 'long thinking payload that providers echo back'
    const messages = [
      {
        role: 'assistant',
        content: 'final answer',
        reasoning_content: reasoning,
      },
    ]

    const usage = estimateUsageTokensFromMessages(messages)

    expect(usage.inputTokens).toBe(0)
    expect(usage.outputTokens).toBe(
      countTokens('final answer') + countTokens(reasoning),
    )
  })

  it('uses one stored reasoning token estimate without double-counting aliases or native details', () => {
    const messages = [{
      role: 'assistant',
      content: 'final answer',
      reasoning: 'duplicate reasoning text',
      reasoning_content: 'duplicate reasoning text',
      reasoning_details: JSON.stringify({
        version: 1,
        estimatedTokens: 123,
        native: {
          format: 'openai-responses-items',
          data: [{ type: 'reasoning', encrypted_content: 'opaque-data' }],
        },
      }),
    }]

    const usage = estimateUsageTokensFromMessages(messages)

    expect(usage.outputTokens).toBe(countTokens('final answer') + 123)
  })

  it('adds cached bridge fixed context when updating full context usage', () => {
    const emit = vi.fn()
    const state = {
      messages: [],
      isWorking: false,
      events: [],
      queue: [],
      bridgeContext: { fixedContextTokens: 20_000 },
    } as any

    const contextTokens = updateMessageContextTokenUsage(
      'session-1',
      state,
      emit,
      1_569,
      { inputTokens: 1_200, outputTokens: 369 },
    )

    expect(contextTokens).toBe(21_569)
    expect(state.contextTokens).toBe(21_569)
    expect(emit).toHaveBeenCalledWith('usage.updated', expect.objectContaining({
      session_id: 'session-1',
      inputTokens: 1_200,
      outputTokens: 369,
      contextTokens: 21_569,
    }))
  })

  it('falls back to message tokens when bridge fixed context is missing', () => {
    const emit = vi.fn()
    const state = {
      messages: [],
      isWorking: false,
      events: [],
      queue: [],
    } as any

    expect(contextTokensWithCachedOverhead(state, 1_569)).toBe(1_569)

    const contextTokens = updateMessageContextTokenUsage(
      'session-1',
      state,
      emit,
      1_569,
      { inputTokens: 1_200, outputTokens: 369 },
    )

    expect(contextTokens).toBe(1_569)
    expect(state.contextTokens).toBe(1_569)
    expect(emit).toHaveBeenCalledWith('usage.updated', expect.objectContaining({
      contextTokens: 1_569,
    }))
  })
})
