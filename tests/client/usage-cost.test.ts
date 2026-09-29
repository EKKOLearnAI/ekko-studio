import { describe, expect, it } from 'vitest'
import { formatUsageCost, usageCostState } from '../../packages/client/src/utils/usage-cost'

describe('usage cost presentation', () => {
  it('distinguishes unknown, free and legacy server zero', () => {
    expect(formatUsageCost(0, { reported: 0, estimated: 0, unknown: 2 })).toBeNull()
    expect(formatUsageCost(0, { reported: 1, estimated: 0, unknown: 0 })).toBe('$0.00')
    expect(formatUsageCost(0)).toBeNull()
    expect(formatUsageCost(0, undefined, false)).toBe('$0.00')
    expect(formatUsageCost(0.001)).toBe('<$0.01')
  })
  it('identifies partial coverage and estimates without losing the known amount', () => {
    const partial = { reported: 2, estimated: 1, unknown: 1 }
    expect(usageCostState(1.23, partial)).toBe('partial')
    expect(formatUsageCost(1.23, partial)).toBe('$1.23')
    expect(usageCostState(1, { reported: 0, estimated: 1, unknown: 0 })).toBe('estimated')
    expect(usageCostState(1, { reported: 1, estimated: 1, unknown: 0 })).toBe('mixed')
  })
})
