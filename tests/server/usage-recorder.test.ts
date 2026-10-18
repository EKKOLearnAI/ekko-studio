import { beforeEach, describe, expect, it, vi } from 'vitest'

const updateUsageMock = vi.hoisted(() => vi.fn())

vi.mock('../../packages/server/src/modules/studio/repositories/usage-store', () => ({
  updateUsage: updateUsageMock,
}))

vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({
  logger: { warn: vi.fn() },
}))

import { normalizeTokenUsage, recordSessionUsage } from '../../packages/server/src/modules/studio/services/usage/usage-recorder'

describe('usage recorder', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('normalizes OpenAI and Anthropic token detail fields', () => {
    expect(normalizeTokenUsage({
      input_tokens: 120,
      output_tokens: 45,
      input_tokens_details: { cached_tokens: 30 },
      output_tokens_details: { reasoning_tokens: 12 },
    })).toEqual({
      inputTokens: 120,
      outputTokens: 45,
      cacheReadTokens: 30,
      cacheWriteTokens: 0,
      reasoningTokens: 12,
      isEstimated: false,
    })

    expect(normalizeTokenUsage({
      usage: {
        input_tokens: 80,
        output_tokens: 20,
        cache_read_input_tokens: 15,
        cache_creation_input_tokens: 4,
      },
    })).toEqual({
      inputTokens: 80,
      outputTokens: 20,
      cacheReadTokens: 15,
      cacheWriteTokens: 4,
      reasoningTokens: 0,
      isEstimated: false,
    })

    expect(normalizeTokenUsage({
      prompt_tokens: 90,
      completion_tokens: 18,
      prompt_tokens_details: { cached_tokens: 40 },
      completion_tokens_details: { reasoning_tokens: 6 },
    })).toEqual({
      inputTokens: 90,
      outputTokens: 18,
      cacheReadTokens: 40,
      cacheWriteTokens: 0,
      reasoningTokens: 6,
      isEstimated: false,
    })
  })

  it('fills missing provider fields from the per-run estimate', () => {
    expect(normalizeTokenUsage(
      { input_tokens: null, output_tokens: 9 },
      { inputTokens: 25, outputTokens: 8 },
    )).toEqual({
      inputTokens: 25,
      outputTokens: 9,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      isEstimated: true,
    })
  })

  it('splits cached tokens from provider input totals when requested', () => {
    expect(normalizeTokenUsage({
      input_tokens: 120,
      output_tokens: 7,
      input_tokens_details: { cached_tokens: 30 },
    }, {}, { inputIncludesCache: true })).toEqual({
      inputTokens: 90,
      outputTokens: 7,
      cacheReadTokens: 30,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      isEstimated: false,
    })
  })

  it('persists normalized metadata through the shared store entrypoint', () => {
    recordSessionUsage({
      sessionId: 'session-1',
      runId: 'run-1',
      source: 'coding_agent',
      agent: 'codex',
      profile: 'work',
      model: 'gpt-5',
      provider: 'openai',
      usage: { prompt_tokens: 10, completion_tokens: 4 },
    })

    expect(updateUsageMock).toHaveBeenCalledWith('session-1', {
      runId: 'run-1',
      source: 'coding_agent',
      agent: 'codex',
      usageScope: undefined,
      purpose: undefined,
      apiCalls: undefined,
      inputTokens: 10,
      outputTokens: 4,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      model: 'gpt-5',
      provider: 'openai',
      profile: 'work',
      isEstimated: false,
    })
  })

  it('persists Cursor coding-agent usage as cursor, not claude_code', () => {
    recordSessionUsage({
      sessionId: 'session-cursor',
      runId: 'run-cursor',
      source: 'coding_agent',
      agent: 'cursor',
      usage: { input_tokens: 3, output_tokens: 1 },
    })

    expect(updateUsageMock).toHaveBeenCalledWith('session-cursor', expect.objectContaining({
      source: 'coding_agent',
      agent: 'cursor',
    }))
    expect(updateUsageMock.mock.calls[0][1].agent).not.toBe('claude_code')
  })
})
