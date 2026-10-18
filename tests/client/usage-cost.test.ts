import { describe, expect, it, vi } from 'vitest'
import { formatUsageCost, formatUsageCurrency, usageCostState } from '../../packages/client/src/utils/usage-cost'

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

  it('localizes USD formatting while preserving unknown, free and sub-cent costs', () => {
    const known = { reported: 1, estimated: 0, unknown: 0 }
    expect(formatUsageCost(1.23, known, true, 'fr')?.replace(/\s/g, ' ')).toBe('1,23 $')
    expect(formatUsageCost(0, known, true, 'fr')?.replace(/\s/g, ' ')).toBe('0,00 $')
    expect(formatUsageCost(0.001, known, true, 'fr')?.replace(/\s/g, ' ')).toBe('<0,01 $')
    expect(formatUsageCost(0, { reported: 0, estimated: 0, unknown: 1 }, true, 'fr')).toBeNull()
    expect(formatUsageCurrency(0.001, 'fr').replace(/\s/g, ' ')).toBe('0,00 $')
  })

  it('formats long floating-point totals when toLocaleString ignores its options', () => {
    const raw = vi.spyOn(Number.prototype, 'toLocaleString').mockImplementation(function (this: number) { return String(this.valueOf()) })
    try {
      expect(formatUsageCost(360.37559642599996)).toBe('$360.38')
    } finally {
      raw.mockRestore()
    }
  })

  it('retains USD and cost states without Intl', () => {
    vi.stubGlobal('Intl', undefined)
    try {
      expect(formatUsageCost(360.37559642599996)).toBe('$360.38')
      expect(formatUsageCost(0, { reported: 1, estimated: 0, unknown: 0 })).toBe('$0.00')
      expect(formatUsageCost(0.001)).toBe('<$0.01')
      expect(formatUsageCost(0, { reported: 0, estimated: 0, unknown: 1 })).toBeNull()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
