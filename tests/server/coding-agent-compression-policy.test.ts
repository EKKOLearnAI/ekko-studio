import { describe, expect, it } from 'vitest'
import { resolveCodingAgentCompressionPolicy } from '../../packages/server/src/modules/coding-agents/services/compression-policy'

describe('coding agent compression policy', () => {
  it('maps the shared Studio ratios to native token budgets', () => {
    expect(resolveCodingAgentCompressionPolicy({ compression: { enabled: true, threshold: 0.5, target_ratio: 0.2 } }, 256_000)).toEqual({
      enabled: true, threshold: 0.5, targetRatio: 0.2, contextWindow: 256_000,
      triggerTokens: 128_000, reserveTokens: 128_000, keepRecentTokens: 51_200, thresholdPercent: 50,
    })
  })

  it('clamps invalid settings and keeps the retained tail below the trigger', () => {
    const policy = resolveCodingAgentCompressionPolicy({ compression: { enabled: false, threshold: 0.1, target_ratio: 0.8 } }, 100_000)
    expect(policy).toMatchObject({ enabled: false, threshold: 0.1, targetRatio: 0.09, triggerTokens: 10_000, keepRecentTokens: 9_000, thresholdPercent: 10 })
  })
})
