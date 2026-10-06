import { describe, expect, it, vi } from 'vitest'
import { catalogReasoningEfforts, findCatalogModelByProvider, resolveCatalogModel } from '../../packages/server/src/modules/studio/services/models/model-metadata'
import type { ModelCatalog } from '../../packages/server/src/modules/studio/services/models/model-catalog'

const catalog: ModelCatalog = {
  'zhipuai-coding-plan': { models: { glm: { limit: { context: 1_000_000 }, reasoning: true, reasoning_options: [{ type: 'effort', values: ['low', 'high', 'max'] }] } } },
  zhipuai: { models: { glm: { limit: { context: 128_000 } }, old: { reasoning: true, reasoning_options: [{ type: 'toggle' }] } } },
  'zai-coding-plan': { models: { glm: { limit: { context: 200_000 } } } },
}
vi.mock('../../packages/server/src/modules/studio/public/model-catalog', async importOriginal => ({
  ...await importOriginal<typeof import('../../packages/server/src/modules/studio/public/model-catalog')>(),
  getModelCatalog: () => catalog,
}))
import { applyCatalogModelMetadata } from '../../packages/server/src/modules/hermes/services/models/metadata'

describe('catalog provider mapping', () => {
  it.each([
    ['glm', 'zhipuai-coding-plan'], ['glm-coding-plan', 'zai-coding-plan'],
    ['kimi-coding', 'kimi-code-plan-global'], ['kimi-coding-cn', 'kimi-code-plan-cn'],
    ['claude-oauth', 'anthropic'], ['openai-api', 'openai'], ['copilot', 'github-copilot'],
    ['minimax-oauth', 'minimax-coding-plan'], ['xiaomi-token-plan', 'xiaomi-token-plan-sgp'],
  ])('maps %s to %s', (provider, directory) => {
    const model = { reasoning: true }
    expect(findCatalogModelByProvider({ [directory]: { models: { model } } }, provider, 'model')).toBe(model)
  })

  it('keeps provider lookup scoped to its mapped directory before the shared resolver falls back', () => {
    expect(findCatalogModelByProvider(catalog, 'glm', 'glm')).toBe(catalog['zhipuai-coding-plan'].models!.glm)
    expect(findCatalogModelByProvider(catalog, 'glm', 'old')).toBeUndefined()
    expect(resolveCatalogModel(catalog, { provider: 'glm', model: 'old' })?.model).toBe(catalog.zhipuai.models!.old)
    expect(findCatalogModelByProvider(catalog, 'glm-coding-plan', 'old')).toBeUndefined()
    expect(findCatalogModelByProvider(catalog, 'custom:gateway', 'glm')).toBeUndefined()
    expect(findCatalogModelByProvider(catalog, '__proto__', 'glm')).toBeUndefined()
    expect(findCatalogModelByProvider(catalog, 'glm', 'toString')).toBeUndefined()
  })

  it('continues to a mapped provider when the runtime ID exists but omits the model', () => {
    expect(findCatalogModelByProvider({ glm: { models: {} }, ...catalog }, ' GLM ', 'glm'))
      .toBe(catalog['zhipuai-coding-plan'].models!.glm)
  })

  it('preserves case-insensitive provider and model IDs and provider-scoped model names', () => {
    const model = { id: 'vendor/model', name: 'Display model' }
    const data = { GooGle: { models: { 'vendor/model': model } } }
    expect(findCatalogModelByProvider(data, 'gemini', 'MODEL')).toBe(model)
    expect(findCatalogModelByProvider(data, 'gemini', 'DISPLAY MODEL')).toBe(model)
    expect(findCatalogModelByProvider(data, 'unknown', 'model')).toBeUndefined()
  })
})

describe('catalog reasoning effort metadata', () => {
  it('preserves advertised effort values and adds off only when a toggle is advertised', () => {
    expect(catalogReasoningEfforts({ reasoning: true, reasoning_options: [
      { type: 'effort', values: ['low', 'high', 'max', 'high', 'bogus'] }, { type: 'toggle' },
    ] })).toEqual(['none', 'low', 'high', 'max'])
  })

  it('distinguishes missing metadata, fixed reasoning, budgets and models without reasoning', () => {
    expect(catalogReasoningEfforts(undefined)).toBeUndefined()
    expect(catalogReasoningEfforts({ reasoning: true })).toBeUndefined()
    expect(catalogReasoningEfforts({ reasoning: true, reasoning_options: [] })).toEqual([])
    expect(catalogReasoningEfforts({ reasoning: false })).toEqual([])
    expect(catalogReasoningEfforts({ reasoning: true, reasoning_options: [{ type: 'toggle' }] })).toEqual(['none'])
    expect(catalogReasoningEfforts({ reasoning: true, reasoning_options: [{ type: 'budget_tokens', min: 1024 }] })).toEqual([])
  })
})

describe('available model reasoning metadata', () => {
  it('keeps existing aliases and preview flags while attaching mapped model capabilities', () => {
    const group = { provider: 'glm', base_url: 'https://proxy.test/v1', models: ['glm', 'private'], model_meta: { glm: { alias: 'Work', preview: true } } }
    const [result] = applyCatalogModelMetadata([group])
    expect(result.model_meta).toEqual({ glm: { alias: 'Work', preview: true, reasoning: true, reasoning_efforts: ['low', 'high', 'max'] } })
    expect(group.model_meta.glm).toEqual({ alias: 'Work', preview: true })
  })

  it('uses endpoint hostname metadata for custom providers', () => {
    const groups = [
      { provider: 'custom:official', base_url: 'https://open.bigmodel.cn/api/coding/paas/v4/', models: ['glm'] },
      { provider: 'custom:gateway', base_url: 'https://open.bigmodel.cn/other', models: ['glm'] },
    ]
    const results = applyCatalogModelMetadata(groups)
    expect(results[0].model_meta?.glm.reasoning_efforts).toEqual(['low', 'high', 'max'])
    expect(results[1].model_meta?.glm.reasoning_efforts).toEqual(['low', 'high', 'max'])
  })
})

describe('ordered catalog resolution', () => {
  const original = { canonical_model_id: 'maker/shared', cost: { input: 2, output: 4 }, reasoning: true, reasoning_options: [{ type: 'effort', values: ['low', 'high'] }] }
  const relay = { ...original, cost: { input: 5, output: 10 }, reasoning_options: [{ type: 'effort', values: ['max'] }] }
  const plan = { ...original, cost: { input: 0, output: 0 } }
  const data: ModelCatalog = {
    relay: { api: 'https://relay.test/v1', models: { shared: relay } },
    maker: { api: 'https://maker.test/api/v1', models: { shared: original } },
    plan: { api: 'https://maker.test/api/coding/v1', models: { shared: plan } },
  }

  it('uses the provider before a different URL and uses URL before the original model directory', () => {
    expect(resolveCatalogModel(data, { provider: ' RELAY ', baseUrl: 'https://maker.test/api/v1', model: 'shared' }))
      .toMatchObject({ provider: 'relay', matchedBy: 'provider', model: relay })
    expect(resolveCatalogModel(data, { provider: 'unknown', baseUrl: 'https://relay.test/other/path', model: 'shared' }))
      .toMatchObject({ provider: 'relay', matchedBy: 'url', model: relay })
    expect(resolveCatalogModel(data, { provider: 'unknown', baseUrl: 'https://proxy.test', model: 'shared' }))
      .toMatchObject({ provider: 'maker', matchedBy: 'model', model: original })
  })

  it.each([
    ['https://MAKER.test/api/coding/v1/', 'plan'],
    ['https://maker.test/api/v1/chat/completions?stream=true', 'maker'],
    ['https://maker.test/api/coding/v10', 'maker'],
  ])('distinguishes directories on a shared host using path boundaries: %s', (baseUrl, provider) => {
    expect(resolveCatalogModel(data, { baseUrl, model: 'shared' })).toMatchObject({ provider, matchedBy: 'url' })
  })

  it.each(['https://relay.test.attacker.test/v1', 'https://relay.test@attacker.test/v1', 'file://relay.test/v1', 'invalid'])('does not treat a partial or invalid hostname as the relay: %s', baseUrl => {
    expect(resolveCatalogModel(data, { baseUrl, model: 'shared' })).toMatchObject({ provider: 'maker', matchedBy: 'model' })
  })

  it('continues from a missing provider model to URL and then to a unique model ID', () => {
    const catalogs = { ...data, omitted: { models: {} }, unique: { models: { unique: original } } }
    expect(resolveCatalogModel(catalogs, { provider: 'omitted', baseUrl: 'https://relay.test', model: 'shared' })?.matchedBy).toBe('url')
    expect(resolveCatalogModel(catalogs, { provider: 'omitted', baseUrl: 'https://relay.test', model: 'unique' }))
      .toMatchObject({ provider: 'unique', matchedBy: 'model' })
  })

  it('uses the original canonical directory independent of catalog ordering and retains unknown collisions', () => {
    for (const catalogs of [data, Object.fromEntries(Object.entries(data).reverse())]) {
      expect(resolveCatalogModel(catalogs, { model: 'shared' })?.provider).toBe('maker')
    }
    expect(resolveCatalogModel({ a: { models: { shared: { cost: { input: 1, output: 2 } } } }, b: { models: { shared: { cost: { input: 9, output: 8 } } } } }, { model: 'shared' })).toBeUndefined()
    expect(resolveCatalogModel({ a: data.relay, b: data.plan }, { model: 'shared' })).toBeUndefined()
  })

  it('does not label a directory outside the matching host as a URL match', () => {
    const catalogs = { ...data, second: { api: 'https://relay.test/v1', models: { shared: plan } } }
    expect(resolveCatalogModel(catalogs, { baseUrl: 'https://relay.test/v1', model: 'shared' }))
      .toMatchObject({ provider: 'maker', matchedBy: 'model' })
  })

  it('keeps global fallback on model IDs while supporting official endpoints omitted by SDK catalogs', () => {
    const catalogs = { openai: { models: { only: { name: 'Friendly', reasoning: false } } }, proxy: { models: { 'vendor/only': relay } } }
    expect(resolveCatalogModel(catalogs, { model: 'Friendly' })).toBeUndefined()
    expect(resolveCatalogModel({ proxy: catalogs.proxy }, { model: 'only' })).toBeUndefined()
    expect(resolveCatalogModel(catalogs, { baseUrl: 'https://api.openai.com/v1', model: 'only' }))
      .toMatchObject({ provider: 'openai', matchedBy: 'url' })
    expect(resolveCatalogModel({ openai: { models: { only: relay } } }, { baseUrl: 'https://api.openai.com/v1', model: 'only' })?.model).toBe(relay)
  })
})
