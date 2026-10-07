import { describe, expect, it, vi } from 'vitest'
import { countTokens } from '../../packages/server/src/modules/studio/services/context-compressor'
import {
  contextTokensWithCachedOverhead,
  estimateUsageTokensFromMessages,
  updateContextTokenUsage,
  updateMessageContextTokenUsage,
} from '../../packages/server/src/modules/studio/services/chat-run/usage'

describe('run-chat usage token estimates', () => {
  it('publishes an explicit native fallback snapshot after restoring a context estimate', () => {
    const state = { contextOwner: { manager: 'native', conversationId: 'session-1' },
      contextFallback: true, contextManagerStatus: 'unavailable' } as any
    const emit = vi.fn()
    expect(updateContextTokenUsage('session-1', state, emit, 123)).toBe(123)
    expect(state.contextManagerStatus).toBe('native')
    expect(emit).toHaveBeenCalledWith('usage.updated', expect.objectContaining({
      contextManager: 'native', contextSource: 'estimate', contextManagerStatus: 'native', contextFallback: true,
    }))
  })

  it('does not label a direct native estimate as observed bili usage', () => {
    const emit = vi.fn()
    const state = { contextTokens: 1_200, contextManagerStatus: 'active', externalContext: {
      manager: 'bili', conversationId: 'session-1', model: 'test-model', tokens: 1_200,
      source: 'usage', observedAt: Date.now(), generation: '2', window: 92_000,
    } } as any
    expect(updateContextTokenUsage('session-1', state, emit, 85_000)).toBe(1_200)
    expect(emit).toHaveBeenCalledWith('usage.updated', expect.objectContaining({ contextTokens: 1_200, contextSource: 'usage' }))
  })

  it.each(['expired', 'foreign'])('rejects %s bili authority at the direct usage update boundary', kind => {
    const emit = vi.fn()
    const state = { contextTokens: 1_200, contextManagerStatus: 'active', externalContext: {
      manager: 'bili', conversationId: kind === 'foreign' ? 'other-session' : 'session-1', model: 'test-model', tokens: 1_200,
      source: 'usage', observedAt: Date.now() - (kind === 'expired' ? 900_001 : 0), generation: '2', window: 92_000,
    } } as any
    expect(updateContextTokenUsage('session-1', state, emit, 85_000)).toBeUndefined()
    expect(state.externalContext).toBeUndefined()
    expect(emit).toHaveBeenCalledWith('usage.updated', expect.objectContaining({ contextTokens: null, contextSource: 'unavailable' }))
  })

  it('does not overwrite live bili context with database message estimates', () => {
    const emit = vi.fn()
    const state = {
      messages: [], isWorking: false, events: [], queue: [], contextTokens: 1_200,
      externalContext: {
        manager: 'bili', conversationId: 'session-1', model: 'test-model',
        tokens: 1_200, source: 'usage', observedAt: Date.now(), generation: '2', window: 92_000,
      },
    } as any
    expect(updateMessageContextTokenUsage('session-1', state, emit, 85_000)).toBe(1_200)
    expect(state.contextTokens).toBe(1_200)
    expect(emit).not.toHaveBeenCalled()
  })

  it('clears expired bili authority without substituting a local estimate', () => {
    const emit = vi.fn()
    const state = {
      messages: [], isWorking: false, events: [], queue: [], contextTokens: 1_200,
      externalContext: {
        manager: 'bili', conversationId: 'session-1', model: 'test-model',
        tokens: 1_200, source: 'usage', observedAt: Date.now() - 900_001, generation: '2', window: 92_000,
      },
    } as any
    expect(updateMessageContextTokenUsage('session-1', state, emit, 85_000)).toBeUndefined()
    expect(state.externalContext).toBeUndefined()
    expect(state.contextTokens).toBeUndefined()
    expect(emit).toHaveBeenCalledWith('usage.updated', expect.objectContaining({
      contextTokens: null, contextManager: 'bili', contextSource: 'unavailable', contextManagerStatus: 'unavailable',
    }))
  })

  it('never uses database estimates for a bili owner with unavailable usage', () => {
    const emit = vi.fn()
    const state = { messages: [], isWorking: false, events: [], queue: [], contextTokens: 1_200,
      contextOwner: { manager: 'bili', conversationId: 'session-1' }, contextManagerStatus: 'unavailable' } as any
    expect(updateMessageContextTokenUsage('session-1', state, emit, 60_000)).toBeUndefined()
    expect(state.contextTokens).toBeUndefined()
    expect(emit).toHaveBeenCalledWith('usage.updated', expect.objectContaining({ contextSource: 'unavailable', contextTokens: null }))
  })

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

  it('keeps assistant tool call tokens on the output side', () => {
    const messages = [
      {
        role: 'assistant',
        content: 'calling tool',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }],
      },
    ]

    const usage = estimateUsageTokensFromMessages(messages)

    expect(usage.inputTokens).toBe(0)
    expect(usage.outputTokens).toBe(countTokens('calling tool') + countTokens(String(messages[0].tool_calls || '')))
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
