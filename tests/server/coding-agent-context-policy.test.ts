import { describe, expect, it } from 'vitest'
import { claudeCompactionPercent, compactionPercent, piCompactionSettings } from '../../packages/server/src/modules/coding-agents/services/context-policy'
import { normalizeCompressionPolicy } from '../../packages/server/src/modules/studio/public/compression-policy'

describe('coding agent context policy boundaries', () => {
  it('shares ordinary chat threshold normalization without using invalid values', () => {
    expect(normalizeCompressionPolicy({ threshold: Number.NaN }).threshold).toBe(0.5)
    expect(normalizeCompressionPolicy({ threshold: 10 }).threshold).toBe(0.95)
    expect(normalizeCompressionPolicy({ threshold: -1 }).threshold).toBe(0.05)
  })

  it('converts percentage decimals without rounding 29% down to 28%', () => {
    expect(compactionPercent(0.29)).toBe(29)
  })

  it('accounts for Claude minimum and maximum rolling windows', () => {
    expect(claudeCompactionPercent({ contextWindow: 64000, outputLimit: 8192, threshold: 0.5, triggerTokens: 32000 })).toBe(32)
    expect(claudeCompactionPercent({ contextWindow: 2000000, outputLimit: 8192, threshold: 0.8, triggerTokens: 1600000 })).toBe(100)
  })

  it('leaves room for a summary on small Pi windows and replaces an inherited model override', () => {
    const input = { compaction: { enabled: false, keepRecentTokens: 20000,
      modelOverrides: { 'hermes-studio/small': { reserveTokens: 1 }, 'another/model': { reserveTokens: 123 } } } }
    const result = piCompactionSettings(input, { contextWindow: 8000, outputLimit: 1024, threshold: 0.5, triggerTokens: 4000 }, 'small')
    expect(result.compaction).toMatchObject({ enabled: true, reserveTokens: 4000, keepRecentTokens: 2000,
      modelOverrides: { 'hermes-studio/small': { reserveTokens: 4000, keepRecentTokens: 2000 }, 'another/model': { reserveTokens: 123 } } })
    expect(input.compaction.enabled).toBe(false)
  })
})
