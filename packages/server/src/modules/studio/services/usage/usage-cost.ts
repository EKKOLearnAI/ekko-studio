import type { UsageCostCoverage } from '../../contracts/runs/usage'

export interface UsageCost {
  costUsd: number
  costSource: 'reported' | 'estimated'
}

export interface UsagePricing {
  provider: string
  model: string
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
}

export function finiteCost(value: unknown): number | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return
  if (typeof value === 'string' && !value.trim()) return
  const amount = Number(value)
  return Number.isFinite(amount) && amount >= 0 ? amount : undefined
}

/** Only explicit USD fields and supported provider usage.cost payloads are accepted. */
export function normalizeUsageCost(value: unknown, source: UsageCost['costSource'] = 'reported'): UsageCost | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  const root = value as Record<string, any>
  const records = [root, root.usage, root.response, root.response?.usage, root.result, root.result?.usage]
    .filter(row => row && typeof row === 'object' && !Array.isArray(row))
  for (const row of records) {
    const actual = finiteCost(row.actual_cost_usd)
    if (actual !== undefined) return { costUsd: actual, costSource: 'reported' }
    for (const candidate of [row.costUsd, row.costUSD, row.cost_usd, row.total_cost_usd, row.cost?.total, row.cost]) {
      const amount = finiteCost(candidate)
      // Native CLI price catalogs also emit zero when a model has no price.
      if (amount === 0 && source === 'estimated' && row.costSource !== 'estimated') continue
      if (amount !== undefined) return { costUsd: amount, costSource: row.costSource === 'estimated' ? 'estimated' : source }
    }
  }
  for (const row of records) {
    const amount = finiteCost(row.estimated_cost_usd)
    if (amount !== undefined) return { costUsd: amount, costSource: 'estimated' }
  }
}

export function estimateUsageCost(usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }, pricing?: UsagePricing): UsageCost | undefined {
  if (!pricing) return
  let costUsd = 0
  for (const [tokens, rate] of [
    [usage.inputTokens, pricing.input], [usage.outputTokens, pricing.output],
    [usage.cacheReadTokens, pricing.cacheRead], [usage.cacheWriteTokens, pricing.cacheWrite],
  ]) {
    if (!tokens) continue
    if (rate === undefined || finiteCost(rate) === undefined) return
    costUsd += tokens * rate / 1_000_000
  }
  // Reasoning tokens are already included in output; never charge them twice.
  return Number.isFinite(costUsd) ? { costUsd, costSource: 'estimated' } : undefined
}

export function emptyCostCoverage(): UsageCostCoverage {
  return { reported: 0, estimated: 0, unknown: 0 }
}

export function addCostCoverage(target: UsageCostCoverage, source?: UsageCostCoverage): void {
  if (!source) return
  target.reported += source.reported
  target.estimated += source.estimated
  target.unknown += source.unknown
}
