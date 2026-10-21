import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getModelCatalog, resolveCatalogModel } = vi.hoisted(() => ({
  getModelCatalog: vi.fn(),
  resolveCatalogModel: vi.fn(),
}))

vi.mock('../../packages/server/src/modules/studio/public/model-catalog', () => ({
  getModelCatalog,
  resolveCatalogModel,
  catalogReasoningEfforts: (model: { reasoning?: boolean }) => model.reasoning ? ['low', 'high'] : [],
}))

import { createCatalogModelMetadataEnricher } from '../../packages/server/src/modules/hermes/services/models/metadata'

const models = Array.from({ length: 3000 }, (_, index) => `model-${index}`)
const group = { provider: 'custom:gateway', base_url: 'https://gateway.test/v1', models }

beforeEach(() => {
  vi.resetAllMocks()
  getModelCatalog.mockReturnValue({})
  resolveCatalogModel.mockImplementation((_catalog, query) => ({ model: { id: query.model, reasoning: true } }))
})

describe('visible catalog metadata scans', () => {
  it('matches namespaced models while keeping complete IDs in the directory and protocol map', () => {
    const models = ['claude/claude-opus-5.5', 'backup/claude-opus-5.5', 'channel/openai/gpt-6.1-sol']
    const input = { ...group, base_url: 'https://opencode.ai/zen/v1', models }
    const [result] = createCatalogModelMetadataEnricher()([input])
    expect(result.models).toEqual(models)
    expect(result.api_mode_by_model).toEqual({
      'claude/claude-opus-5.5': 'anthropic_messages',
      'backup/claude-opus-5.5': 'anthropic_messages',
      'channel/openai/gpt-6.1-sol': 'codex_responses',
    })
    for (const model of models) {
      expect(resolveCatalogModel).toHaveBeenCalledWith({}, {
        provider: input.provider, baseUrl: input.base_url, model,
      })
    }
    expect(input).not.toHaveProperty('api_mode_by_model')
  })

  it('matches automatic custom connections by endpoint and model while preserving fixed modes and unknown connections', () => {
    getModelCatalog.mockReturnValue(null)
    const input = { ...group, models: ['gpt-next', 'claude-next', 'minimax-next'] }
    const [automatic, fixed, unknown] = createCatalogModelMetadataEnricher()([
      { ...input, base_url: 'https://opencode.ai/zen/go/v1' },
      { ...input, base_url: 'https://opencode.ai/zen/go/v1', api_mode: 'chat_completions' as const },
      input,
    ])
    expect(automatic.api_mode_by_model).toEqual({
      'gpt-next': 'codex_responses',
      'claude-next': 'anthropic_messages',
      'minimax-next': 'anthropic_messages',
    })
    expect(automatic.api_mode).toBeUndefined()
    expect(fixed.api_mode).toBe('chat_completions')
    expect(fixed.api_mode_by_model).toBeUndefined()
    expect(unknown.api_mode_by_model).toBeUndefined()
    expect(input).not.toHaveProperty('api_mode_by_model')
  })

  it('routes dynamic OpenCode models without a models.dev snapshot and distinguishes Zen from Go', () => {
    getModelCatalog.mockReturnValue(null)
    const models = ['gpt-new-release', 'claude-new-release', 'minimax-m2.7', 'gemini-new-release', 'brand-new-model']
    const [zen, go, custom] = createCatalogModelMetadataEnricher()([
      { ...group, provider: 'opencode-zen', models },
      { ...group, provider: 'opencode-go', models },
      { ...group, provider: 'custom:opencode-zen', models, api_mode: 'anthropic_messages' },
    ])
    expect(zen.api_mode_by_model).toEqual({
      'gpt-new-release': 'codex_responses', 'claude-new-release': 'anthropic_messages',
      'minimax-m2.7': 'chat_completions', 'gemini-new-release': 'chat_completions', 'brand-new-model': 'chat_completions',
    })
    expect(go.api_mode_by_model).toEqual({ ...zen.api_mode_by_model, 'minimax-m2.7': 'anthropic_messages' })
    expect(custom.api_mode_by_model).toBeUndefined()
    expect(custom.api_mode).toBe('anthropic_messages')
    expect(resolveCatalogModel).not.toHaveBeenCalled()
  })

  it('uses the selected models for protocol metadata and recomputes after a model refresh', () => {
    const enrich = createCatalogModelMetadataEnricher(g => g.models.filter(id => id !== 'hidden'))
    const [first] = enrich([{ ...group, provider: 'opencode-go', models: ['qwen-next', 'hidden'] }])
    const [next] = enrich([{ ...group, provider: 'opencode-go', models: ['qwen-next', 'muse-spark-next'] }])
    expect(first.api_mode_by_model).toEqual({ 'qwen-next': 'anthropic_messages' })
    expect(next.api_mode_by_model).toEqual({ 'qwen-next': 'anthropic_messages', 'muse-spark-next': 'codex_responses' })
  })

  it('resolves all 3,000 selected models while retaining existing metadata', () => {
    const model_meta = { 'model-2999': { alias: 'Last model', preview: true, disabled: true } }
    const [result] = createCatalogModelMetadataEnricher()([{ ...group, model_meta }])

    expect(resolveCatalogModel).toHaveBeenCalledTimes(3000)
    expect(result.models).toEqual(models)
    expect(result.model_meta['model-99']).toMatchObject({ reasoning: true, reasoning_efforts: ['low', 'high'] })
    expect(result.model_meta['model-100']).toMatchObject({ reasoning: true })
    expect(result.model_meta['model-2999']).toMatchObject({ ...model_meta['model-2999'], reasoning: true })
    expect(model_meta).toEqual({ 'model-2999': { alias: 'Last model', preview: true, disabled: true } })
  })

  it('uses selected candidates beyond the first 100 source models without scanning hidden models', () => {
    const [result] = createCatalogModelMetadataEnricher(() => ['model-2999'])([group])

    expect(resolveCatalogModel).toHaveBeenCalledTimes(1)
    expect(resolveCatalogModel).toHaveBeenCalledWith({}, {
      provider: group.provider, baseUrl: group.base_url, model: 'model-2999',
    })
    expect(result.models).toEqual(models)
    expect(Object.keys(result.model_meta!)).toEqual(['model-2999'])
  })

  it('reuses cached hits across profiles and repeated response sections without limiting models', () => {
    const enrich = createCatalogModelMetadataEnricher()
    enrich([{ ...group, models: models.slice(0, 70) }])
    enrich([{ ...group, models: models.slice(50, 150) }])
    const [repeated] = enrich([group])

    expect(resolveCatalogModel).toHaveBeenCalledTimes(3000)
    expect(Object.keys(repeated.model_meta!)).toHaveLength(3000)
    enrich([{ ...group, provider: 'custom:other' }])
    expect(resolveCatalogModel).toHaveBeenCalledTimes(6000)
  })

  it('reuses misses, including duplicate model IDs', () => {
    resolveCatalogModel.mockReturnValue(undefined)
    const enrich = createCatalogModelMetadataEnricher()
    enrich([{ ...group, models: [...models.slice(0, 50), ...models.slice(0, 50)] }])
    enrich([group, group])

    expect(resolveCatalogModel).toHaveBeenCalledTimes(3000)
  })

  it('keeps endpoint-dependent metadata separate for the same provider', () => {
    resolveCatalogModel.mockImplementation((_catalog, query) => ({
      model: { reasoning: query.baseUrl === group.base_url },
    }))
    const enrich = createCatalogModelMetadataEnricher()
    const [first, second] = enrich([
      { ...group, models: models.slice(0, 60) },
      { ...group, base_url: 'https://other.test/v1', models: models.slice(0, 60) },
    ])

    expect(resolveCatalogModel).toHaveBeenCalledTimes(120)
    expect(first.model_meta?.['model-0'].reasoning).toBe(true)
    expect(second.model_meta?.['model-0'].reasoning).toBe(false)
    expect(second.model_meta?.['model-59'].reasoning).toBe(false)
  })

  it('starts a fresh cache and catalog snapshot for each response', () => {
    createCatalogModelMetadataEnricher()([group])
    const nextCatalog = { refreshed: true }
    getModelCatalog.mockReturnValue(nextCatalog)
    resolveCatalogModel.mockReturnValue({ model: { reasoning: false } })
    const [next] = createCatalogModelMetadataEnricher()([group])

    expect(resolveCatalogModel).toHaveBeenCalledTimes(6000)
    expect(resolveCatalogModel.mock.calls[3000][0]).toBe(nextCatalog)
    expect(next.model_meta?.['model-0'].reasoning).toBe(false)
  })

  it('leaves the list intact when the catalog has not loaded', () => {
    getModelCatalog.mockReturnValue(null)
    expect(createCatalogModelMetadataEnricher()([group])).toEqual([group])
    expect(resolveCatalogModel).not.toHaveBeenCalled()
  })
})
