import { describe, expect, it } from 'vitest'
import { buildUsageTrend } from '../../packages/client/src/utils/usage-trend'
import { usageCostState } from '../../packages/client/src/utils/usage-cost'

function day(date: string) {
  return { date, input_tokens: 100, output_tokens: 50, cache_read_tokens: 75,
    cache_write_tokens: 10, sessions: 1, errors: 0, cost: 0.02,
    cost_coverage: { reported: 1, estimated: 0, unknown: 0 } }
}
function series(start: string, length: number) {
  return Array.from({ length }, (_, index) => day(new Date(Date.parse(`${start}T00:00:00Z`) + index * 86_400_000).toISOString().slice(0, 10)))
}

describe('usage trend aggregation', () => {
  it('keeps today, 7 days and 30 days at daily resolution without changing input rows', () => {
    for (const length of [1, 7, 30]) {
      const days = series('2026-01-01', length).reverse()
      const original = structuredClone(days)
      const trend = buildUsageTrend(days)
      expect(trend.granularity).toBe('day')
      expect(trend.buckets).toHaveLength(length)
      expect(trend.buckets[0]).toMatchObject({ date: '2026-01-01', endDate: '2026-01-01', input_tokens: 100 })
      expect(days).toEqual(original)
    }
  })

  it('groups 90 days into calendar weeks with bounded bar counts and unchanged totals', () => {
    const trend = buildUsageTrend(series('2025-12-30', 90), 90)
    expect(trend.granularity).toBe('week')
    expect(trend.buckets.length).toBeLessThanOrEqual(14)
    expect(trend.buckets[0]).toMatchObject({ date: '2025-12-30', endDate: '2026-01-04', input_tokens: 600 })
    expect(trend.buckets[1]).toMatchObject({ date: '2026-01-05', endDate: '2026-01-11', input_tokens: 700 })
    expect(trend.buckets.reduce((sum, bucket) => sum + bucket.input_tokens, 0)).toBe(9000)
    expect(trend.buckets.reduce((sum, bucket) => sum + bucket.output_tokens, 0)).toBe(4500)
  })

  it('groups 365 days into months across years and leap days, retaining partial endpoints', () => {
    const trend = buildUsageTrend(series('2023-12-31', 365), 365)
    expect(trend.granularity).toBe('month')
    expect(trend.buckets).toHaveLength(13)
    expect(trend.buckets[0]).toMatchObject({ date: '2023-12-31', endDate: '2023-12-31', input_tokens: 100 })
    expect(trend.buckets[2]).toMatchObject({ date: '2024-02-01', endDate: '2024-02-29', input_tokens: 2900 })
    expect(trend.buckets.at(-1)).toMatchObject({ date: '2024-12-01', endDate: '2024-12-29', input_tokens: 2900 })
    for (const [field, expected] of [['input_tokens', 36500], ['output_tokens', 18250], ['cache_read_tokens', 27375], ['cache_write_tokens', 3650]] as const) {
      expect(trend.buckets.reduce((sum, bucket) => sum + bucket[field], 0)).toBe(expected)
    }
    expect(trend.buckets.reduce((sum, bucket) => sum + bucket.cost, 0)).toBeCloseTo(7.3)
  })

  it('uses the requested period for sparse data and never fills outside that period', () => {
    const trend = buildUsageTrend([day('2026-10-10')], 365)
    expect(trend.granularity).toBe('month')
    expect(trend.buckets).toHaveLength(1)
    expect(trend.buckets[0]).toMatchObject({ date: '2026-10-10', endDate: '2026-10-10' })
    expect(buildUsageTrend([], 365).buckets).toEqual([])
  })

  it('preserves partial and unknown cost coverage rather than presenting missing costs as free', () => {
    const reported = day('2026-01-01')
    const unknown = { ...day('2026-01-02'), cost: 0, cost_coverage: { reported: 0, estimated: 0, unknown: 1 } }
    const mixed = buildUsageTrend([reported, unknown], 365).buckets[0]!
    expect(mixed.cost).toBe(0.02)
    expect(mixed.cost_coverage).toEqual({ reported: 1, estimated: 0, unknown: 1 })
    expect(usageCostState(mixed.cost, mixed.cost_coverage)).toBe('partial')
    const missing = buildUsageTrend([unknown], 365).buckets[0]!
    expect(usageCostState(missing.cost, missing.cost_coverage)).toBe('unknown')
    const legacy = { ...unknown, cost_coverage: undefined }
    expect(buildUsageTrend([reported, legacy], 365).buckets[0]!.cost_coverage?.unknown).toBe(1)
  })
})
