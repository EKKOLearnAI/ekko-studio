import { resolveCatalogModel } from '../models/model-metadata'
import type { ModelCatalogSnapshot } from '../../public/model-catalog'
import { estimateUsageCost, type UsageCost, type UsagePricing } from './usage-cost'

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

export function estimateCatalogUsageCost(
  snapshot: ModelCatalogSnapshot | undefined,
  provider: string,
  model: string,
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; reasoningTokens?: number },
  scope: 'run' | 'model_call' = 'run',
  apiCalls?: number,
  baseUrl?: string | null,
): UsageCost | undefined {
  if (!snapshot) return
  const match = resolveCatalogModel(snapshot.data, { provider, baseUrl, model })
  if (!match) return
  const entry = match.model
  const cost = object(entry?.cost)
  if (!cost) return
  let selected = { ...cost }
  let contextThreshold: number | undefined
  const prompt = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
  const isSingleCall = apiCalls === 1 || (apiCalls === undefined && scope === 'model_call')
  let tiers: Array<{ threshold: number; rates: Record<string, unknown> }> = []
  if (cost.tiers !== undefined) {
    if (!Array.isArray(cost.tiers)) return
    for (const value of cost.tiers) {
      const rates = object(value)
      const tier = object(rates?.tier)
      if (!rates || tier?.type !== 'context' || typeof tier.size !== 'number' || !Number.isFinite(tier.size) || tier.size <= 0) return
      tiers.push({ threshold: tier.size, rates })
    }
  }
  if (!tiers.length && cost.context_over_200k !== undefined) {
    const rates = object(cost.context_over_200k)
    if (!rates) return
    tiers = [{ threshold: 200_000, rates }]
  }
  for (const tier of tiers.sort((a, b) => a.threshold - b.threshold)) {
    if (prompt <= tier.threshold) continue
    // A whole-run token sum cannot reveal which individual requests crossed a pricing tier.
    if (!isSingleCall) return
    selected = { ...selected, ...tier.rates }
    contextThreshold = tier.threshold
  }
  const rates: UsagePricing = { provider: match.provider, model: match.modelId, input: 0, output: 0 }
  for (const [field, key] of [
    ['input', 'input'], ['output', 'output'], ['cacheRead', 'cache_read'],
    ['cacheWrite', 'cache_write'], ['reasoning', 'reasoning'],
  ] as const) {
    const value = selected[key]
    if (value === undefined && key !== 'input' && key !== 'output') continue
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return
    rates[field] = value
  }
  const estimate = estimateUsageCost(usage, rates)
  return estimate && { ...estimate, costPricing: {
    source: 'models.dev', rates, catalogVersion: snapshot.version, catalogFetchedAt: snapshot.fetchedAt,
    ...(contextThreshold === undefined ? {} : { contextThreshold }),
  } }
}
