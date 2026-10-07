import { describe, expect, it } from 'vitest'
import { selectExternalContextUsage } from '../../packages/server/src/modules/studio/services/context-manager/usage'

const now = 1_800_000
const target = { conversationId: 'child', model: 'model-a', now }
const status = {
  ok: true,
  conversationId: 'child',
  model: 'model-a',
  contextTokens: 1_200,
  contextTokensSource: 'usage',
  contextTokensAt: now - 1_000,
  contextGeneration: 'revision-2',
  contextLimit: 92_000,
  requests: 2,
  inputTokens: 85_000,
  outputTokens: 800,
  cachedTokens: 70_000,
}

describe('external effective context usage', () => {
  it('uses effective tokens, not cumulative billing or an extra compression credit', () => {
    expect(selectExternalContextUsage({ ...status, compressCreditTokens: 500 }, target)).toEqual({
      manager: 'bili',
      conversationId: 'child',
      model: 'model-a',
      tokens: 1_200,
      source: 'usage',
      observedAt: now - 1_000,
      generation: 'revision-2',
      window: 92_000,
    })
  })

  it.each([
    { conversationId: 'parent' },
    { model: 'model-b' },
    { fallback: true },
    { ok: false },
    { contextTokens: -1 },
    { contextTokens: Number.NaN },
    { contextTokensSource: 'unavailable' },
    { contextTokensAt: now - 900_001 },
    { contextTokensAt: now + 60_001 },
    { contextGeneration: '' },
    { requests: 0 },
  ])('rejects unavailable, stale or mismatched status: %j', patch => {
    expect(selectExternalContextUsage({ ...status, ...patch }, target)).toBeUndefined()
  })

  it('does not relabel a proxy estimate as measured usage', () => {
    expect(selectExternalContextUsage({ ...status, contextTokensSource: 'estimate' }, target)?.source).toBe('estimate')
  })

  it('does not invent a source or timestamp for older proxy versions', () => {
    const { contextTokensSource, contextTokensAt, ...legacy } = status
    expect(selectExternalContextUsage(legacy, target)).toBeUndefined()
  })
})