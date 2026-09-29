import { describe, expect, it } from 'vitest'
import { formatUsageCost, usageCostState } from '../../packages/client/src/utils/usage-cost'

describe('usage cost presentation', () => {
  it('distinguishes unknown, free and legacy server zero', () => {
    expect(formatUsageCost(0, { reported: 0, estimated: 0, unknown: 2 })).toBeNull()
    expect(formatUsageCost(0, { reported: 1, estimated: 0, unknown: 0 })).toBe('$0.00')
    expect(formatUsageCost(0)).toBeNull()
    expect(formatUsageCost(0, undefined, false)).toBe('$0.00')
    expect(formatUsageCost(0.001)).toBe('$0.001')
  })
  it('identifies partial coverage and estimates without losing the known amount', () => {
    const partial = { reported: 2, estimated: 1, unknown: 1 }
    expect(usageCostState(1.23, partial)).toBe('partial')
    expect(formatUsageCost(1.23, partial)).toBe('$1.23')
    expect(usageCostState(1, { reported: 0, estimated: 1, unknown: 0 })).toBe('estimated')
    expect(usageCostState(1, { reported: 1, estimated: 1, unknown: 0 })).toBe('mixed')
  })

  it('shows small charges changing the total instead of hiding both below one cent', () => {
    const coverage = { reported: 0, estimated: 3, unknown: 9 }
    expect(formatUsageCost(0.002887398, coverage)).toBe('$0.002887')
    expect(formatUsageCost(0.004529376, coverage)).toBe('$0.004529')
    expect(formatUsageCost(10.001641978, coverage)).toBe('$10.001642')
    expect(formatUsageCost(0.000001, coverage)).toBe('$0.000001')
    expect(formatUsageCost(0.0000001, coverage)).toBe('<$0.000001')
    expect(formatUsageCost(10, coverage)).toBe('$10.00')
    expect(formatUsageCost(0.1, coverage)).toBe('$0.10')
  })
})
