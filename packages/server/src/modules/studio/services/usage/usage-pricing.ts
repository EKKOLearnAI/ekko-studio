import type { UsagePricing } from './usage-cost'
export { getUsagePricing, saveUsagePricing } from '../../repositories/usage-pricing-store'

export function validateUsagePricing(value: unknown): UsagePricing[] {
  if (!Array.isArray(value) || value.length > 200) throw new Error('Expected at most 200 pricing rows')
  const keys = new Set<string>()
  return value.map(row => {
    if (!row || typeof row !== 'object') throw new Error('Invalid pricing row')
    const provider = typeof row.provider === 'string' ? row.provider.trim() : ''
    const model = typeof row.model === 'string' ? row.model.trim() : ''
    if (!provider || !model || provider.length > 200 || model.length > 300) throw new Error('Provider and model are required')
    const key = JSON.stringify([provider, model])
    if (keys.has(key)) throw new Error('Duplicate provider/model pricing')
    keys.add(key)
    const rates: Record<string, number> = {}
    for (const field of ['input', 'output', 'cacheRead', 'cacheWrite']) {
      const rate = row[field]
      if (rate == null && (field === 'cacheRead' || field === 'cacheWrite')) continue
      if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0 || rate > 1_000_000) throw new Error('Invalid USD per million token rate')
      rates[field] = rate
    }
    return { provider, model, input: rates.input, output: rates.output, ...rates }
  })
}
