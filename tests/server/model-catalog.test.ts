import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ModelCatalogCache, MODEL_CATALOG_URL } from '../../packages/server/src/modules/studio/services/models/model-catalog'
import { estimateCatalogUsageCost } from '../../packages/server/src/modules/studio/services/usage/catalog-pricing'

const catalog = (input = 2) => ({ openai: { models: {
  model: { limit: { context: 300_000, output: 32_000 }, cost: {
    input, output: 8, cache_read: 0.2, cache_write: 2.5,
    tiers: [{ input: 4, output: 12, cache_read: 0.4, tier: { type: 'context', size: 200_000 } }],
  } },
} } })
const snapshot = (data: any = catalog()) => ({ data, version: 'test-version', fetchedAt: 1234 })

describe('shared models.dev cache', () => {
  let directory: string
  let path: string
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'studio-catalog-'))
    path = join(directory, 'models', 'models.dev.json')
  })
  afterEach(() => rmSync(directory, { recursive: true, force: true }))

  it('downloads once for concurrent callers and reloads the same raw JSON offline after restart', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(catalog())))
    const cache = new ModelCatalogCache(path, fetcher)
    expect(cache.get()).toBeUndefined()
    const [one, two] = await Promise.all([cache.refresh(true), cache.refresh()])
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher).toHaveBeenCalledWith(MODEL_CATALOG_URL, expect.objectContaining({ headers: { Accept: 'application/json' } }))
    expect(one).toBe(two)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(catalog())
    expect(new ModelCatalogCache(path, fetcher).get()?.data.openai.models?.model.limit?.context).toBe(300_000)
    await cache.refresh()
    expect(fetcher).toHaveBeenCalledTimes(1)
    await cache.refresh(true)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('refreshes an existing snapshot and gives new costs a new version without mutating old snapshots', async () => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(catalog()))
    const cache = new ModelCatalogCache(path, vi.fn(async () => new Response(JSON.stringify(catalog(3)))))
    const old = cache.get()!
    const updated = (await cache.refresh(true))!
    expect(updated.version).not.toBe(old.version)
    expect(old.data.openai.models?.model.cost?.input).toBe(2)
    expect(cache.get()?.data.openai.models?.model.cost?.input).toBe(3)
  })

  it.each(['network', 'http', 'json', 'empty', 'shape', 'truncated', 'oversized'])('keeps a valid local file after a %s failure', async failure => {
    const raw = JSON.stringify(catalog())
    mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, raw)
    const fetcher = vi.fn(async () => {
      if (failure === 'network') throw new Error('offline')
      if (failure === 'http') return new Response('Unavailable', { status: 503 })
      if (failure === 'oversized') return new Response(new Uint8Array(21 * 1024 * 1024))
      if (failure === 'truncated') return new Response(new ReadableStream({ start(c) { c.error(new Error('connection closed')) } }))
      return new Response(failure === 'json' ? '<html>error</html>' : failure === 'empty' ? '{}' : '{"openai":{"models":[]}}')
    })
    const cache = new ModelCatalogCache(path, fetcher)
    expect((await cache.refresh(true))?.data).toEqual(catalog())
    expect(readFileSync(path, 'utf8')).toBe(raw)
    await cache.refresh()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('recovers from a corrupt cache and leaves cold offline lookups unknown', async () => {
    mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, '{')
    const cache = new ModelCatalogCache(path, vi.fn(async () => new Response(JSON.stringify(catalog()))))
    expect(cache.get()).toBeUndefined()
    expect((await cache.refresh(true))?.data).toEqual(catalog())
    const offline = new ModelCatalogCache(join(directory, 'missing.json'), vi.fn(async () => { throw new Error('offline') }))
    expect(await offline.refresh()).toBeUndefined()
  })
})

describe('catalog cost estimates', () => {
  const usage = { inputTokens: 1000, outputTokens: 200, reasoningTokens: 100, cacheReadTokens: 5000, cacheWriteTokens: 100 }

  it('prices disjoint token categories and retains the rates, source and catalog version', () => {
    const cost = estimateCatalogUsageCost(snapshot(), 'openai', 'model', usage)!
    expect(cost.costUsd).toBeCloseTo(0.00485)
    expect(cost).toMatchObject({ costSource: 'estimated', costPricing: { source: 'models.dev', catalogVersion: 'test-version', catalogFetchedAt: 1234, rates: { provider: 'openai', model: 'model', input: 2 } } })
  })

  it('uses explicit context tiers, including cache tokens, only when individual request size is known', () => {
    const large = { ...usage, inputTokens: 195_000, cacheReadTokens: 5000, cacheWriteTokens: 0 }
    expect(estimateCatalogUsageCost(snapshot(), 'openai', 'model', large, 'model_call')?.costPricing?.contextThreshold).toBeUndefined()
    large.inputTokens++
    expect(estimateCatalogUsageCost(snapshot(), 'openai', 'model', large, 'model_call')?.costPricing).toMatchObject({ contextThreshold: 200_000, rates: { input: 4, output: 12 } })
    expect(estimateCatalogUsageCost(snapshot(), 'openai', 'model', large, 'run')).toBeUndefined()
    expect(estimateCatalogUsageCost(snapshot(), 'openai', 'model', large, 'run', 1)?.costPricing?.contextThreshold).toBe(200_000)
  })

  it('handles legacy context pricing without confusing a newer explicit tier with the legacy 200k name', () => {
    const data: any = catalog()
    data.openai.models.model.cost.tiers[0].tier.size = 272_000
    data.openai.models.model.cost.context_over_200k = { input: 6, output: 20 }
    const request = { ...usage, inputTokens: 210_000 }
    expect(estimateCatalogUsageCost(snapshot(data), 'openai', 'model', request, 'model_call')?.costPricing?.rates.input).toBe(2)
    delete data.openai.models.model.cost.tiers
    expect(estimateCatalogUsageCost(snapshot(data), 'openai', 'model', request, 'model_call')?.costPricing?.rates.input).toBe(6)
  })

  it('never guesses relay prices or treats incomplete/malformed prices as free', () => {
    expect(estimateCatalogUsageCost(snapshot(), 'custom:relay', 'model', usage)).toBeUndefined()
    expect(estimateCatalogUsageCost(snapshot(), 'openai', 'Model', usage)).toBeUndefined()
    for (const bad of [undefined, null, -1, Infinity, '2']) {
      const data: any = catalog(); data.openai.models.model.cost.input = bad
      expect(estimateCatalogUsageCost(snapshot(data), 'openai', 'model', usage)).toBeUndefined()
    }
    const data: any = catalog(); delete data.openai.models.model.cost.cache_read
    expect(estimateCatalogUsageCost(snapshot(data), 'openai', 'model', usage)).toBeUndefined()
    data.openai.models.model.cost = { input: 0, output: 0, cache_read: 0, cache_write: 0 }
    expect(estimateCatalogUsageCost(snapshot(data), 'openai', 'model', usage)?.costUsd).toBe(0)
  })

  it('supports known provider aliases and separate reasoning rates without double charging', () => {
    const data: any = { google: catalog().openai }
    data.google.models.model.cost.reasoning = 4
    expect(estimateCatalogUsageCost(snapshot(data), 'gemini', 'model', usage)?.costUsd).toBeCloseTo(0.00445)
    data.google.models.model.cost.tiers = [{ tier: { type: 'unknown', size: 1 }, input: 5 }]
    expect(estimateCatalogUsageCost(snapshot(data), 'gemini', 'model', usage)).toBeUndefined()
  })
})
