import { describe, expect, it, vi } from 'vitest'
import { catalogReasoningEfforts, findCatalogModelByProvider } from '../../packages/server/src/modules/studio/services/models/model-metadata'
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

  it('prefers plan metadata and only falls back to the same vendor for omitted models', () => {
    expect(findCatalogModelByProvider(catalog, 'glm', 'glm')).toBe(catalog['zhipuai-coding-plan'].models!.glm)
    expect(findCatalogModelByProvider(catalog, 'glm', 'old')).toBe(catalog.zhipuai.models!.old)
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

  it('preserves full preset URL inference for custom providers without guessing from the hostname', () => {
    const groups = [
      { provider: 'custom:official', base_url: 'https://open.bigmodel.cn/api/coding/paas/v4/', models: ['glm'] },
      { provider: 'custom:gateway', base_url: 'https://open.bigmodel.cn/other', models: ['glm'] },
    ]
    const results = applyCatalogModelMetadata(groups)
    expect(results[0].model_meta?.glm.reasoning_efforts).toEqual(['low', 'high', 'max'])
    expect(results[1]).toBe(groups[1])
  })
})
