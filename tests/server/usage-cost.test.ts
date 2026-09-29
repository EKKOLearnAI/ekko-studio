import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeUsageCost, estimateUsageCost } from '../../packages/server/src/modules/studio/services/usage/usage-cost'
import { applyHermesCostFallbacks } from '../../packages/server/src/modules/studio/services/usage/hermes-cost-fallback'
import { NativeTurnUsage } from '../../packages/server/src/modules/coding-agents/services/runtime/native-usage'
import { USAGE_SCHEMA, USAGE_RUN_INDEX, USAGE_PRICING_SCHEMA } from '../../packages/server/src/modules/studio/infrastructure/database/schemas'
import { recordSessionUsage } from '../../packages/server/src/modules/studio/services/usage/usage-recorder'
import { getLocalUsageStats, getUnpricedHermesUsageSessions, updateUsage, fillMissingUsageCost } from '../../packages/server/src/modules/studio/repositories/usage-store'
import { getUsagePricing, saveUsagePricing, validateUsagePricing } from '../../packages/server/src/modules/studio/services/usage/usage-pricing'

let db: DatabaseSync
const catalogMock = vi.hoisted(() => ({ getModelCatalogSnapshot: vi.fn(), refreshModelCatalog: vi.fn() }))
vi.mock('../../packages/server/src/modules/studio/public/model-catalog', () => catalogMock)
vi.mock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({
  isSqliteAvailable: () => true, getDb: () => db,
  jsonGet: vi.fn(), jsonSet: vi.fn(), jsonGetAll: vi.fn(), jsonDelete: vi.fn(),
}))

describe('usage cost accounting', () => {
  beforeEach(() => {
    catalogMock.getModelCatalogSnapshot.mockReset()
    catalogMock.refreshModelCatalog.mockReset().mockResolvedValue(undefined)
    db = new DatabaseSync(':memory:')
    db.exec(`CREATE TABLE session_usage (${Object.entries(USAGE_SCHEMA).map(([key, sql]) => `${key} ${sql}`).join(',')}); ${USAGE_RUN_INDEX};
      CREATE TABLE usage_pricing (${Object.entries(USAGE_PRICING_SCHEMA).map(([key, sql]) => `${key} ${sql}`).join(',')});`)
  })
  afterEach(() => db.close())
  function record(runId: string, usage: unknown, extra: Record<string, any> = {}) {
    recordSessionUsage({ sessionId: 'session', source: 'coding_agent', agent: 'codex', runId, profile: 'p', provider: 'global', model: 'test-model', usage, ...extra })
  }

  it('retains explicit free usage and rejects invalid costs', () => {
    expect(normalizeUsageCost({ usage: { cost: 0 } })).toEqual({ costUsd: 0, costSource: 'reported' })
    expect(normalizeUsageCost({ response: { usage: { cost: '0.12345' } } })).toEqual({ costUsd: 0.12345, costSource: 'reported' })
    expect(normalizeUsageCost({ cost: { total: 0 } }, 'estimated')).toBeUndefined()
    expect(normalizeUsageCost({ estimated_cost_usd: 1, actual_cost_usd: 0 })).toEqual({ costUsd: 0, costSource: 'reported' })
    for (const cost of [null, undefined, false, true, '', ' ', -1, Infinity, NaN, {}, []]) expect(normalizeUsageCost({ cost })).toBeUndefined()
  })

  it('persists fractional USD once per call and distinguishes unknown from free', () => {
    const usage = { input_tokens: 100, output_tokens: 10 }
    record('paid', { ...usage, cost: 0.00234 })
    record('paid', { ...usage, cost: 0.00234 })
    record('free', { ...usage, cost: 0 })
    record('unknown', usage)
    const stats = getLocalUsageStats('p', 30)
    expect(stats.cost).toBeCloseTo(0.00234)
    expect(stats.input_tokens).toBe(300)
    expect(stats.cost_coverage).toEqual({ reported: 2, estimated: 0, unknown: 1 })
    expect(stats.by_day[0].cost).toBeCloseTo(stats.cost)
    expect(stats.by_day[0].cost_coverage).toEqual(stats.cost_coverage)
    expect(getLocalUsageStats('other', 30).cost).toBe(0)
  })

  it('estimates disjoint input/output/cache tokens using saved prices without repricing history', () => {
    const price = { provider: 'global', model: 'test-model', input: 2, output: 8, cacheRead: 0.2, cacheWrite: 2.5 }
    saveUsagePricing('p', [price])
    const usage = { inputTokens: 1000, outputTokens: 200, reasoningTokens: 100, cacheReadTokens: 5000, cacheWriteTokens: 100 }
    record('estimate', usage)
    expect(getLocalUsageStats('p', 1)).toMatchObject({ cost: 0.00485, cost_coverage: { reported: 0, estimated: 1, unknown: 0 } })
    saveUsagePricing('p', [{ ...price, input: 99 }])
    record('reported', { ...usage, cost: 0 })
    expect(getLocalUsageStats('p', 1).cost).toBeCloseTo(0.00485)
    expect(estimateUsageCost(usage, { ...price, cacheRead: undefined })).toBeUndefined()
    record('other-profile', usage, { profile: 'other' })
    expect(getLocalUsageStats('other', 1).cost_coverage?.unknown).toBe(1)
    expect(getUsagePricing('p')[0].input).toBe(99)
    expect(getUsagePricing('other')).toEqual([])
  })

  it('only permits exact, unique, finite, non-negative model pricing', () => {
    const row = { provider: ' global ', model: ' m ', input: 1, output: 0, cacheRead: null }
    expect(validateUsagePricing([row])).toEqual([{ provider: 'global', model: 'm', input: 1, output: 0 }])
    for (const input of [-1, NaN, Infinity, '1', null]) expect(() => validateUsagePricing([{ ...row, input }])).toThrow()
    expect(() => validateUsagePricing([row, row])).toThrow()
    expect(() => validateUsagePricing([{ ...row, provider: '' }])).toThrow()
  })

  it('supplements unpriced Hermes sessions once while preserving token totals', () => {
    const usage = { inputTokens: 10, outputTokens: 2 }
    record('one', usage, { source: 'hermes', agent: 'hermes' })
    record('two', usage, { source: 'hermes', agent: 'hermes' })
    const candidates = getUnpricedHermesUsageSessions('p', 1)
    expect(candidates).toHaveLength(1)
    const stats = getLocalUsageStats('p', 1)
    const fallback = { session_id: 'session', date: candidates[0].days[0].date, cost: 0.25, source: 'estimated' as const }
    applyHermesCostFallbacks(stats, candidates, [fallback, fallback])
    expect(stats).toMatchObject({ cost: 0.25, input_tokens: 20, output_tokens: 4, sessions: 1, cost_coverage: { reported: 0, estimated: 1, unknown: 0 } })
    expect(stats.by_day[0]).toMatchObject({ cost: 0.25, cost_coverage: { reported: 0, estimated: 1, unknown: 0 } })
    record('known', { ...usage, cost: 0 }, { source: 'hermes', agent: 'hermes' })
    expect(getUnpricedHermesUsageSessions('p', 1)).toEqual([])
  })

  it('does not apply cumulative Hermes costs to sessions extending beyond the period', () => {
    record('old', { input_tokens: 10, output_tokens: 2 }, { source: 'hermes', agent: 'hermes' })
    db.prepare('UPDATE session_usage SET created_at = ?').run(Date.now() - 3 * 86_400_000)
    record('new', { input_tokens: 10, output_tokens: 2 }, { source: 'hermes', agent: 'hermes' })
    expect(getUnpricedHermesUsageSessions('p', 1)).toEqual([])
  })

  it('keeps native model costs and authoritative Claude run totals without double counting', () => {
    const native = new NativeTurnUsage()
    native.observeClaude({ type: 'result', usage: { input_tokens: 100, output_tokens: 10 }, total_cost_usd: 0.25,
      modelUsage: { a: { inputTokens: 100, outputTokens: 10, costUSD: 0.3 } } })
    expect(native.rows('claude-code', undefined)).toMatchObject([{ usage: { inputTokens: 100 }, cost: { costUsd: 0.25, costSource: 'estimated' } }])
    const pi = new NativeTurnUsage()
    const event = { type: 'message_end', message: { id: 'x', role: 'assistant', model: 'm', usage: { input: 10, output: 2, cost: { total: 0.02 } } } }
    expect(pi.observePi(event)?.cost).toEqual({ costUsd: 0.02, costSource: 'estimated' })
    expect(pi.observePi(event)).toBeUndefined()
  })
  it('retains known Grok response costs when the terminal event omits totals', () => {
    const tracker = new NativeTurnUsage()
    tracker.observeGrok({ type: 'usage', messageId: 'one', usage: { input_tokens: 10, output_tokens: 2, cost: 0.03 } })
    tracker.observeGrok({ type: 'usage', messageId: 'one', usage: { input_tokens: 10, output_tokens: 2, cost: 0.03 } })
    tracker.observeGrok({ type: 'usage', messageId: 'two', usage: { input_tokens: 20, output_tokens: 3, cost: 0.04 } })
    tracker.observeGrok({ type: 'error' })
    expect(tracker.rows('grok', undefined)).toMatchObject([{ usage: { inputTokens: 30 }, cost: { costUsd: 0.07, costSource: 'estimated' } }])
  })

  const catalogSnapshot = { version: 'catalog-v1', fetchedAt: 1234, data: { global: { models: {
    'test-model': { cost: { input: 2, output: 8, cache_read: 0.2 } },
  } } } }

  it('persists catalog estimates and the exact pricing snapshot, with reported and manual costs taking priority', () => {
    catalogMock.getModelCatalogSnapshot.mockReturnValue(catalogSnapshot)
    record('catalog', { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 5000 })
    const saved = db.prepare('SELECT * FROM session_usage').get() as any
    expect(saved.cost_usd).toBeCloseTo(0.0046)
    expect(JSON.parse(saved.cost_pricing)).toMatchObject({ source: 'models.dev', catalogVersion: 'catalog-v1', rates: { input: 2 } })
    saveUsagePricing('p', [{ provider: 'global', model: 'test-model', input: 4, output: 16, cacheRead: 0.4 }])
    record('manual', { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 5000 })
    record('reported', { inputTokens: 1000, outputTokens: 200, cost: 0 })
    const rows = db.prepare('SELECT * FROM session_usage ORDER BY id').all() as any[]
    expect(rows.map(row => row.cost_usd)).toEqual([0.0046, 0.0092, 0])
    expect(JSON.parse(rows[1].cost_pricing).source).toBe('manual')
    expect(rows[2].cost_pricing).toBeNull()
    expect(catalogMock.refreshModelCatalog).not.toHaveBeenCalled()
  })

  it('fills a cold-start record after download without duplicating tokens or repricing a replay', async () => {
    let finish!: (snapshot: unknown) => void
    catalogMock.refreshModelCatalog.mockReturnValue(new Promise(resolve => { finish = resolve }))
    record('cold', { inputTokens: 1000, outputTokens: 200 })
    record('cold', { inputTokens: 1000, outputTokens: 200 })
    const before = db.prepare('SELECT * FROM session_usage').get() as any
    expect(before.cost_usd).toBeNull()
    expect(catalogMock.refreshModelCatalog).toHaveBeenCalledTimes(1)
    finish(catalogSnapshot)
    await vi.waitFor(() => expect(getLocalUsageStats('p', 1).cost).toBeCloseTo(0.0036))
    const after = db.prepare('SELECT * FROM session_usage').get() as any
    expect(after.created_at).toBe(before.created_at)
    expect(getLocalUsageStats('p', 1).input_tokens).toBe(1000)
    catalogMock.getModelCatalogSnapshot.mockReturnValue({ ...catalogSnapshot, version: 'new' })
    record('cold', { inputTokens: 9000, outputTokens: 9000 })
    expect(db.prepare('SELECT * FROM session_usage').get()).toEqual(after)
  })

  it('does not replace an explicit partial manual price with catalog rates', () => {
    catalogMock.getModelCatalogSnapshot.mockReturnValue(catalogSnapshot)
    saveUsagePricing('p', [{ provider: 'global', model: 'test-model', input: 1, output: 2 }])
    record('missing-cache', { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 5000 })
    expect(getLocalUsageStats('p', 1).cost_coverage?.unknown).toBe(1)
    expect(catalogMock.refreshModelCatalog).not.toHaveBeenCalled()
  })

  it('late enrichment cannot overwrite a known cost or restore a deleted row', () => {
    const ref = updateUsage('one', { inputTokens: 10, outputTokens: 1 })!
    fillMissingUsageCost(ref, { costUsd: 0, costSource: 'reported' })
    fillMissingUsageCost(ref, { costUsd: 5, costSource: 'estimated' })
    expect((db.prepare('SELECT cost_usd FROM session_usage').get() as any).cost_usd).toBe(0)
    db.exec('DELETE FROM session_usage')
    fillMissingUsageCost(ref, { costUsd: 5, costSource: 'estimated' })
    expect(db.prepare('SELECT * FROM session_usage').all()).toEqual([])
  })

})
