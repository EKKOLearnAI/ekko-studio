export interface UsageCostCoverage { reported: number; estimated: number; unknown: number }
export type UsageCostState = 'unknown' | 'partial' | 'reported' | 'estimated' | 'mixed' | ''

export function usageCostState(amount: number, coverage?: UsageCostCoverage, hasActivity = true): UsageCostState {
  if (!coverage) return amount > 0 || !hasActivity ? '' : 'unknown'
  const known = coverage.reported + coverage.estimated
  if (!known) return coverage.unknown > 0 || hasActivity ? 'unknown' : ''
  if (coverage.unknown > 0) return 'partial'
  if (!coverage.reported) return 'estimated'
  return coverage.estimated > 0 ? 'mixed' : 'reported'
}

export function formatUsageCost(amount: number, coverage?: UsageCostCoverage, hasActivity = true): string | null {
  if (usageCostState(amount, coverage, hasActivity) === 'unknown') return null
  if (amount === 0) return '$0.00'
  if (amount < 0.000001) return '<$0.000001'
  // Keep small token charges visible in both daily amounts and larger totals.
  return `$${amount.toFixed(6).replace(/(\.\d{2,}?)0+$/, '$1')}`
}
