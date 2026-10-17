import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockReadFile, mockReadConfigYaml, mockReadConfigYamlForProfile, mockFetchProviderModels, mockBuildModelGroups, mockReadAppConfig, mockWriteAppConfig, mockExistsSync, mockReadFileSync, mockListProfileNamesFromDisk, mockListUserProfiles, mockReadProviderModelCatalogCache, mockResolveProviderCatalogModels, mockRefreshConfiguredProviderModelCatalogs, mockWriteProviderModelCatalogEntry, mockGetCopilotModelsDetailed } = vi.hoisted(() => ({
  mockReadFile: vi.fn(),
  mockReadConfigYaml: vi.fn(),
  mockReadConfigYamlForProfile: vi.fn(),
  mockFetchProviderModels: vi.fn(),
  mockBuildModelGroups: vi.fn(() => ({ default: '', groups: [] })),
  mockReadAppConfig: vi.fn(),
  mockWriteAppConfig: vi.fn(),
  mockExistsSync: vi.fn(() => false),
  mockReadFileSync: vi.fn(),
  mockListProfileNamesFromDisk: vi.fn(() => ['default']),
  mockListUserProfiles: vi.fn(() => []),
  mockReadProviderModelCatalogCache: vi.fn(),
  mockResolveProviderCatalogModels: vi.fn(),
  mockRefreshConfiguredProviderModelCatalogs: vi.fn(),
  mockWriteProviderModelCatalogEntry: vi.fn(),
  mockGetCopilotModelsDetailed: vi.fn(async () => []),
}))

vi.mock('fs/promises', () => ({
  readFile: (...args: any[]) => String(args[0]).endsWith('/auth.json')
    ? Promise.resolve(mockExistsSync(args[0]) ? mockReadFileSync(args[0], 'utf-8') : '{}')
    : mockReadFile(...args),
}))

vi.mock('fs', () => ({
  existsSync: mockExistsSync,
  readFileSync: mockReadFileSync,
}))

vi.mock('../../packages/server/src/modules/hermes/services/profiles/profile', () => ({
  getActiveEnvPath: () => '/fake/home/.hermes/.env',
  getActiveAuthPath: () => '/fake/home/.hermes/auth.json',
  getActiveProfileName: () => 'default',
  getProfileDir: () => '/fake/home/.hermes',
  listProfileNamesFromDisk: mockListProfileNamesFromDisk,
}))

vi.mock('../../packages/server/src/modules/studio/public/users', () => ({
  listUserProfiles: mockListUserProfiles,
}))

vi.mock('../../packages/server/src/modules/studio/public/profile-config', () => ({
  readConfigYaml: mockReadConfigYaml,
  readConfigYamlForProfile: mockReadConfigYamlForProfile,
  writeConfigYaml: vi.fn(),
  buildModelGroups: mockBuildModelGroups,
  PROVIDER_ENV_MAP: {
    'fun-codex': { api_key_env: '', base_url_env: '' },
    deepseek: { api_key_env: 'DEEPSEEK_API_KEY', base_url_env: 'DEEPSEEK_BASE_URL' },
    lmstudio: { api_key_env: 'LM_API_KEY', base_url_env: 'LM_BASE_URL' },
    'xai-oauth': { api_key_env: '', base_url_env: '' },
    'minimax-oauth': { api_key_env: '', base_url_env: '' },
    openrouter: {},
    copilot: { api_key_env: 'GITHUB_TOKEN', base_url_env: '' },
  },
}))

vi.mock('../../packages/server/src/modules/studio/public/provider-catalog', () => ({
  fetchProviderModels: mockFetchProviderModels,
}))

vi.mock('../../packages/server/src/modules/studio/contracts/providers', async importOriginal => ({
  ...await importOriginal<typeof import('../../packages/server/src/modules/studio/contracts/providers')>(),
  buildProviderModelMap: () => ({
    deepseek: ['deepseek-chat', 'deepseek-reasoner'],
    'xai-oauth': ['grok-4.3', 'grok-4.20-0309-reasoning'],
    'minimax-oauth': ['MiniMax-M3', 'MiniMax-M2.7'],
    openrouter: ['openrouter/auto'],
  }),
  PROVIDER_PRESETS: [
    {
      value: 'fun-codex',
      label: 'Codex-apikey.fan',
      base_url: 'https://api.apikey.fan/v1',
      models: ['gpt-5.5', 'gpt-5.4'],
      builtin: true,
    },
    {
      value: 'deepseek',
      label: 'DeepSeek',
      base_url: 'https://api.deepseek.com/v1',
      models: ['deepseek-chat', 'deepseek-reasoner'],
      builtin: true,
    },
    {
      value: 'openrouter',
      label: 'OpenRouter',
      base_url: 'https://openrouter.ai/api/v1',
      models: ['openrouter/auto'],
      builtin: true,
    },
    {
      value: 'lmstudio',
      label: 'LM Studio',
      base_url: 'http://127.0.0.1:1234/v1',
      models: [],
      builtin: true,
    },
    {
      value: 'xai-oauth',
      label: 'xAI Grok OAuth (SuperGrok Subscription)',
      base_url: 'https://api.x.ai/v1',
      models: ['grok-4.3', 'grok-4.20-0309-reasoning'],
      builtin: true,
    },
    {
      value: 'minimax-oauth',
      label: 'MiniMax Coding Plan (OAuth)',
      base_url: 'https://api.minimax.io/anthropic',
      api_mode: 'anthropic_messages',
      models: ['MiniMax-M3', 'MiniMax-M2.7'],
      builtin: true,
    },
    {
      value: 'copilot',
      label: 'GitHub Copilot',
      base_url: 'https://api.githubcopilot.com',
      models: ['gpt-5.5'],
      builtin: true,
    },
  ],
}))

vi.mock('../../packages/server/src/modules/hermes/services/providers/copilot-models', () => ({
  getCopilotModelsDetailed: mockGetCopilotModelsDetailed,
  resolveCopilotOAuthToken: vi.fn(async () => ''),
}))

vi.mock('../../packages/server/src/modules/studio/public/app-config', () => ({
  readAppConfig: mockReadAppConfig,
  writeAppConfig: mockWriteAppConfig,
  providerDisplayLabel: (appConfig: any, profile: string, providerId: string, fallback: string) =>
    appConfig?.providerLabels?.[profile]?.[providerId]?.trim?.() || fallback,
}))

vi.mock('../../packages/server/src/modules/hermes/services/providers/model-catalog-cache', () => ({
  readProviderModelCatalogCache: mockReadProviderModelCatalogCache,
  resolveProviderCatalogModels: mockResolveProviderCatalogModels,
  resolveProviderCatalogEntry: vi.fn(() => undefined),
  refreshConfiguredProviderModelCatalogs: mockRefreshConfiguredProviderModelCatalogs,
  writeProviderModelCatalogEntry: mockWriteProviderModelCatalogEntry,
}))

vi.mock('../../packages/server/src/modules/hermes/services/providers/provider-model-refresh', () => ({
  providerModelRefreshCapabilities: () => ({ refreshable: true }),
}))

vi.mock('../../packages/server/src/modules/studio/public/provider-context', () => ({
  readModelContextRecord: vi.fn(),
  upsertModelContextRecord: vi.fn(),
}))

const mockInvalidateProviderRuntime = vi.hoisted(() => vi.fn())
vi.mock('../../packages/server/src/modules/studio/public/provider-runtime', () => ({ invalidateProviderRuntime: mockInvalidateProviderRuntime }))

const mockResolveCatalogModel = vi.hoisted(() => vi.fn())
vi.mock('../../packages/server/src/modules/studio/public/model-catalog', async importOriginal => ({
  ...await importOriginal<typeof import('../../packages/server/src/modules/studio/public/model-catalog')>(),
  getModelCatalog: () => ({}),
  resolveCatalogModel: mockResolveCatalogModel,
}))

import { upsertModelContextRecord } from '../../packages/server/src/modules/studio/public/provider-context'

import * as ctrl from '../../packages/server/src/modules/hermes/controllers/models'

function makeCtx(body: Record<string, unknown> = {}): any {
  return { params: {}, query: {}, request: { body }, body: undefined, status: 200 }
}

function modelCatalogKey(provider: string, baseUrl: string, freeOnly = false): string {
  return `${provider}|${baseUrl.replace(/\/+$/, '')}|${freeOnly ? 'free' : 'all'}`
}

function sourceAwareProviderModels(
  cache: any,
  provider: string,
  baseUrl: string,
  staticModels: string[],
  options: { freeOnly?: boolean; hasStaticManifest?: boolean } = {},
): string[] {
  const entry = cache?.providers?.[modelCatalogKey(provider, baseUrl, options.freeOnly === true)]
  if (!entry || !Array.isArray(entry.models) || entry.models.length === 0) return [...staticModels]
  if (entry.source === 'fallback' && options.hasStaticManifest === true) return [...staticModels]
  return [...entry.models]
}

beforeEach(() => {
  vi.clearAllMocks()
  mockResolveCatalogModel.mockReset().mockImplementation((_catalog, query) => ({
    model: { id: query.model, reasoning: true, reasoning_options: [{ type: 'effort', values: ['low', 'high'] }] },
  }))
  mockReadFile.mockResolvedValue('DEEPSEEK_API_KEY=sk-test\n')
  mockFetchProviderModels.mockResolvedValue([])
  mockReadConfigYaml.mockResolvedValue({ model: { default: 'deepseek-chat', provider: 'deepseek' } })
  mockReadConfigYamlForProfile.mockResolvedValue({ model: { default: 'deepseek-chat', provider: 'deepseek' } })
  mockBuildModelGroups.mockReturnValue({ default: '', groups: [] })
  mockReadAppConfig.mockResolvedValue({})
  mockWriteAppConfig.mockImplementation(async patch => patch)
  mockExistsSync.mockReturnValue(false)
  mockReadFileSync.mockReturnValue('{}')
  mockListProfileNamesFromDisk.mockReturnValue(['default'])
  mockListUserProfiles.mockReturnValue([])
  mockReadProviderModelCatalogCache.mockResolvedValue({ version: 1, updated_at: '1970-01-01T00:00:00.000Z', providers: {} })
  mockResolveProviderCatalogModels.mockImplementation(sourceAwareProviderModels)
  mockRefreshConfiguredProviderModelCatalogs.mockResolvedValue(undefined)
  mockWriteProviderModelCatalogEntry.mockResolvedValue({})
  mockGetCopilotModelsDetailed.mockResolvedValue([])
})

describe('models controller — model visibility', () => {
  it('refreshes the matching provider runtimes after saving a manual model window', async () => {
    vi.mocked(upsertModelContextRecord).mockReturnValue({ available: true,
      row: { profile: 'research', provider: 'test', model: 'test-model', context_limit: 80000 } } as any)
    const ctx = makeCtx({ provider: 'test', model: 'test-model', context_limit: 80000 })
    ctx.state = { profile: { name: 'research' } }
    await ctrl.updateModelContext(ctx)
    expect(ctx.body.success).toBe(true)
    expect(upsertModelContextRecord).toHaveBeenCalledWith('research', 'test', 'test-model', 80000)
    expect(mockInvalidateProviderRuntime).toHaveBeenCalledWith('research', 'test')
  })

  it('filters available models per provider without changing canonical IDs', async () => {
    mockReadAppConfig.mockResolvedValue({
      modelVisibility: {
        deepseek: { mode: 'include', models: ['deepseek-reasoner'] },
      },
    })

    const ctx = makeCtx()
    await ctrl.getAvailable(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.body.groups).toHaveLength(1)
    expect(ctx.body.groups[0]).toMatchObject({
      provider: 'deepseek',
      models: ['deepseek-reasoner'],
      model_count: 2,
    })
    expect(ctx.body.default).toBe('deepseek-reasoner')
    expect(ctx.body.default_provider).toBe('deepseek')
    expect(ctx.body.model_visibility).toEqual({
      deepseek: { mode: 'include', models: ['deepseek-reasoner'] },
    })
  })

  it.each(['aggregate', 'profile', 'runtime'])('scans only managed visible models in a large %s catalog', async surface => {
    const models = Array.from({ length: 3000 }, (_, index) => `model-${index}`)
    const visible = ['model-2900', 'model-2999']
    mockListProfileNamesFromDisk.mockReturnValue(['default', 'research'])
    mockReadConfigYamlForProfile.mockResolvedValue({ model: { default: 'model-2999', provider: 'deepseek' } })
    mockResolveProviderCatalogModels.mockImplementation((_cache, provider, _url, defaults) => provider === 'deepseek' ? models : defaults)
    mockReadAppConfig.mockResolvedValue({
      modelVisibility: { deepseek: { mode: 'include', models: visible } },
      modelAliases: { deepseek: { 'model-2999': 'My model' } },
    })
    const ctx = makeCtx()
    if (surface === 'profile') ctx.query.profile = 'research'
    if (surface !== 'runtime') await ctrl.getAvailable(ctx)
    const groups = surface === 'runtime'
      ? await ctrl.getAvailableModelGroupsForProfile('research')
      : ctx.body.groups

    const scans = mockResolveCatalogModel.mock.calls.filter(([, query]) => query.provider === 'deepseek')
    expect(scans.map(([, query]) => query.model)).toEqual(visible)
    expect(groups[0].models).toEqual(visible)
    if (surface === 'runtime') expect(groups[0].available_models).toEqual(models)
    else {
      expect(groups[0].available_models).toBeUndefined()
      expect(groups[0].model_count).toBe(3000)
    }
    expect(Object.keys(groups[0].model_meta).sort()).toEqual(visible)
    expect(groups[0].model_meta['model-2999'].reasoning_efforts).toEqual(['low', 'high'])
    if (surface !== 'runtime') {
      expect(ctx.body.default).toBe('model-2999')
      expect(groups[0].model_meta['model-2999'].alias).toBe('My model')
      const preset = ctx.body.allProviders.find((entry: any) => entry.provider === 'deepseek')
      expect(preset.models).toEqual([])
      expect(preset.model_count).toBe(3000)
      expect(preset.model_meta).toBeUndefined()
      for (const profile of ctx.body.profiles) expect(profile.groups[0].model_meta['model-2999'].reasoning).toBe(true)
    }
  })

  it.each(['all', 'include', 'stale'])('resolves all visible models across profiles and allProviders with an %s visibility rule', async mode => {
    const models = Array.from({ length: 3000 }, (_, index) => `model-${index}`)
    const selected = mode === 'include' ? models.slice(2800) : models
    mockListProfileNamesFromDisk.mockReturnValue(['default', 'research'])
    mockReadConfigYamlForProfile.mockResolvedValue({ model: { default: 'model-2999', provider: 'deepseek' } })
    mockResolveProviderCatalogModels.mockImplementation((_cache, provider, _url, defaults) => provider === 'deepseek' ? models : defaults)
    mockReadAppConfig.mockResolvedValue({
      modelVisibility: {
        deepseek: mode === 'all' ? { mode: 'all', models: [] } : { mode: 'include', models: mode === 'stale' ? ['missing'] : selected },
      },
    })
    const ctx = makeCtx()
    await ctrl.getAvailable(ctx)

    const scans = mockResolveCatalogModel.mock.calls.filter(([, query]) => query.provider === 'deepseek')
    expect(scans.map(([, query]) => query.model)).toEqual(selected)
    expect(ctx.body.groups[0].models).toEqual(selected)
    expect(ctx.body.groups[0].available_models).toBeUndefined()
    expect(ctx.body.groups[0].model_count).toBe(3000)
    expect(Object.keys(ctx.body.groups[0].model_meta)).toHaveLength(selected.length)
    expect(ctx.body.allProviders.find((entry: any) => entry.provider === 'deepseek').models).toEqual([])
  })

  it.each(['aggregate', 'profile'])('keeps the %s response small when thousands of hidden models have aliases and custom IDs', async surface => {
    const models = Array.from({ length: 3000 }, (_, index) => `model-${index}`)
    mockResolveProviderCatalogModels.mockImplementation((_cache, provider, _url, defaults) => provider === 'deepseek' ? models : defaults)
    mockReadAppConfig.mockResolvedValue({
      modelVisibility: { deepseek: { mode: 'include', models: ['model-2999'] } },
      modelAliases: { deepseek: Object.fromEntries(models.map(id => [id, `Alias ${id}`])) },
      customModels: { deepseek: models },
    })
    const ctx = makeCtx()
    if (surface === 'profile') ctx.query.profile = 'research'
    await ctrl.getAvailable(ctx)
    expect(ctx.body.groups[0]).toMatchObject({ models: ['model-2999'], model_count: 3001 })
    expect(ctx.body.model_aliases).toEqual({ deepseek: { 'model-2999': 'Alias model-2999' } })
    expect(ctx.body.custom_models).toEqual({ deepseek: ['model-2999'] })
    expect(JSON.stringify(ctx.body)).not.toContain('"model-2000"')
    expect(Buffer.byteLength(JSON.stringify(ctx.body))).toBeLessThan(6000)

    const catalogCtx = makeCtx()
    catalogCtx.query = { provider: 'deepseek', profile: 'research' }
    mockResolveCatalogModel.mockClear()
    await ctrl.getProviderModelCatalog(catalogCtx)
    expect(catalogCtx.body.models).toHaveLength(3001)
    expect(catalogCtx.body.visible_models).toEqual(['model-2999'])
    expect(catalogCtx.body.model_aliases['model-2000']).toBe('Alias model-2000')
    expect(catalogCtx.body.api_key).toBeUndefined()
    expect(mockResolveCatalogModel).not.toHaveBeenCalled()
    expect(mockFetchProviderModels).not.toHaveBeenCalled()
  })

  it('loads a preset catalog before the Provider has credentials', async () => {
    mockReadFile.mockResolvedValue('')
    const ctx = makeCtx()
    ctx.query = { provider: 'deepseek', profile: 'research' }
    await ctrl.getProviderModelCatalog(ctx)
    expect(ctx.body).toEqual({ provider: 'deepseek', models: ['deepseek-chat', 'deepseek-reasoner'], visible_models: ['deepseek-chat', 'deepseek-reasoner'], model_aliases: {} })
    expect(mockReadConfigYamlForProfile).toHaveBeenCalledWith('research')
  })

  it('keeps full custom Provider catalogs scoped to the requested Profile', async () => {
    mockReadFile.mockResolvedValue('')
    mockReadConfigYamlForProfile.mockImplementation(async profile => ({ custom_providers: [{ name: 'local', base_url: `https://${profile}.example/v1`, model: `${profile}-model` }] }))
    for (const profile of ['default', 'research']) {
      const ctx = makeCtx()
      ctx.query = { provider: 'custom:local', profile }
      await ctrl.getProviderModelCatalog(ctx)
      expect(ctx.body.models).toEqual([`${profile}-model`])
    }
  })

  it.each([undefined, ['deepseek'], 'missing-provider'])('rejects missing, invalid or unknown catalog Provider %s', async provider => {
    const ctx = makeCtx()
    ctx.query = { provider }
    await ctrl.getProviderModelCatalog(ctx)
    expect(ctx.status).toBe(provider === 'missing-provider' ? 404 : 400)
    expect(ctx.body.models).toBeUndefined()
  })

  it('uses updated visibility on the next request without reusing hidden metadata', async () => {
    mockReadAppConfig.mockResolvedValue({ modelVisibility: { deepseek: { mode: 'include', models: ['deepseek-chat'] } } })
    await ctrl.getAvailable(makeCtx())
    mockResolveCatalogModel.mockClear()
    mockReadAppConfig.mockResolvedValue({ modelVisibility: { deepseek: { mode: 'include', models: ['deepseek-reasoner'] } } })
    const ctx = makeCtx()
    await ctrl.getAvailable(ctx)

    const scans = mockResolveCatalogModel.mock.calls.filter(([, query]) => query.provider === 'deepseek')
    expect(scans.map(([, query]) => query.model)).toEqual(['deepseek-reasoner'])
    expect(ctx.body.groups[0].model_meta).not.toHaveProperty('deepseek-chat')
  })

  it('exposes single-provider refresh for authorized providers that are not editable', async () => {
    mockReadFile.mockResolvedValue('')
    mockReadConfigYamlForProfile.mockResolvedValue({
      model: { default: 'grok-4.3', provider: 'xai-oauth' },
    })
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(JSON.stringify({
      credential_pool: {
        'xai-oauth': [{ access_token: 'profile-oauth-token' }],
      },
    }))

    const ctx = makeCtx()
    ctx.query = { profile: 'default' }
    await ctrl.getAvailable(ctx)

    expect(ctx.body.groups).toEqual(expect.arrayContaining([
      expect.objectContaining({
        provider: 'xai-oauth',
        provider_editable: false,
        model_refreshable: true,
      }),
    ]))
  })

  it('merges Web UI custom models into available provider groups', async () => {
    mockReadAppConfig.mockResolvedValue({
      customModels: {
        deepseek: ['gemma-4-26b-a4b-it', 'deepseek-chat'],
      },
    })

    const ctx = makeCtx()
    await ctrl.getAvailable(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.body.groups[0]).toMatchObject({
      provider: 'deepseek',
      models: ['deepseek-chat', 'deepseek-reasoner', 'gemma-4-26b-a4b-it'],
      model_count: 3,
    })
    expect(ctx.body.custom_models).toEqual({
      deepseek: ['gemma-4-26b-a4b-it', 'deepseek-chat'],
    })
  })

  it('exposes enabled MoA presets as a profile-scoped virtual provider', async () => {
    mockReadConfigYamlForProfile.mockResolvedValue({
      model: { default: 'deepseek-chat', provider: 'deepseek' },
      moa: {
        default_preset: 'coding',
        presets: {
          research: { enabled: true },
          coding: {},
          archived: { enabled: false },
        },
      },
    })

    const ctx = makeCtx()
    ctx.query = { profile: 'default' }
    await ctrl.getAvailable(ctx)

    expect(ctx.body.groups).toEqual(expect.arrayContaining([
      expect.objectContaining({
        provider: 'moa',
        label: 'Mixture of Agents',
        base_url: 'moa://local',
        api_key: 'moa-virtual-provider',
        api_mode: 'chat_completions',
        models: ['coding', 'research'],
      }),
    ]))
    expect(JSON.stringify(ctx.body.groups)).not.toContain('archived')
  })

  it('prefers cached live provider catalogs over static built-in presets', async () => {
    mockReadConfigYamlForProfile.mockResolvedValue({ model: { default: 'deepseek-live', provider: 'deepseek' } })
    const key = modelCatalogKey('deepseek', 'https://api.deepseek.com/v1')
    mockReadProviderModelCatalogCache.mockResolvedValue({
      version: 1,
      updated_at: '2026-07-11T00:00:00.000Z',
      providers: {
        [key]: {
          provider: 'deepseek',
          label: 'DeepSeek',
          base_url: 'https://api.deepseek.com/v1',
          models: ['deepseek-live', 'deepseek-new'],
          source: 'live',
          updated_at: '2026-07-11T00:00:00.000Z',
        },
      },
    })

    const ctx = makeCtx()
    await ctrl.getAvailable(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.body.groups).toEqual(expect.arrayContaining([
      expect.objectContaining({
        provider: 'deepseek',
        models: ['deepseek-live', 'deepseek-new'],
        model_count: 2,
      }),
    ]))
    expect(mockFetchProviderModels).not.toHaveBeenCalled()
  })

  it('ignores persisted fallback entries for built-ins in groups and allProviders', async () => {
    const key = modelCatalogKey('deepseek', 'https://api.deepseek.com/v1')
    mockReadProviderModelCatalogCache.mockResolvedValue({
      version: 1,
      updated_at: '2026-07-10T00:00:00.000Z',
      providers: {
        [key]: {
          provider: 'deepseek',
          label: 'DeepSeek',
          base_url: 'https://api.deepseek.com/v1',
          models: ['deepseek-old-fallback'],
          source: 'fallback',
          updated_at: '2026-07-10T00:00:00.000Z',
        },
      },
    })

    const ctx = makeCtx()
    await ctrl.getAvailable(ctx)

    expect(ctx.body.groups).toEqual(expect.arrayContaining([
        expect.objectContaining({
          provider: 'deepseek',
          models: ['deepseek-chat', 'deepseek-reasoner'],
        }),
    ]))
    expect(ctx.body.allProviders.find((group: any) => group.provider === 'deepseek')).toMatchObject({ models: [], model_count: 2 })
    expect(JSON.stringify(ctx.body)).not.toContain('deepseek-old-fallback')
  })

  it.each([
    {
      source: 'fallback',
      cachedModels: ['gpt-5.3-stale'],
      expectedModels: ['gpt-5.5', 'gpt-5.4'],
    },
    {
      source: 'live',
      cachedModels: ['gpt-5.6-live'],
      expectedModels: ['gpt-5.5', 'gpt-5.6-live'],
    },
  ])('applies $source cache precedence to built-in-backed custom providers', async ({ source, cachedModels, expectedModels }) => {
    const provider = 'custom:fun-codex'
    const baseUrl = 'https://proxy.example.com/v1'
    const updatedAt = '2026-01-01T00:00:00.000Z'
    mockReadConfigYamlForProfile.mockResolvedValue({
      model: { default: 'gpt-5.5', provider },
      custom_providers: [
        {
          name: 'fun-codex',
          base_url: baseUrl,
          model: 'gpt-5.5',
          api_key: 'test-placeholder',
        },
      ],
    })
    mockReadProviderModelCatalogCache.mockResolvedValue({
      version: 1,
      updated_at: updatedAt,
      providers: {
        [modelCatalogKey(provider, baseUrl)]: {
          provider,
          label: 'fun-codex',
          base_url: baseUrl,
          models: cachedModels,
          source,
          updated_at: updatedAt,
        },
      },
    })

    const ctx = makeCtx()
    ctx.query = { profile: 'default' }
    await ctrl.getAvailable(ctx)

    expect(ctx.body.groups).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider, builtin: true, models: expectedModels }),
    ]))
  })

  it('does not re-inject fallback cache models for an authoritatively empty built-in manifest', async () => {
    const provider = 'custom:lmstudio'
    const baseUrl = 'http://127.0.0.1:1234/v1'
    const updatedAt = '2026-07-11T00:00:00.000Z'
    mockReadConfigYamlForProfile.mockResolvedValue({
      model: { default: 'configured-local-model', provider },
      custom_providers: [
        {
          name: 'lmstudio',
          base_url: baseUrl,
          model: 'configured-local-model',
          api_key: 'test-placeholder',
        },
      ],
    })
    mockReadProviderModelCatalogCache.mockResolvedValue({
      version: 1,
      updated_at: updatedAt,
      providers: {
        [modelCatalogKey(provider, baseUrl)]: {
          provider,
          label: 'lmstudio',
          base_url: baseUrl,
          models: ['stale-fallback-model'],
          source: 'fallback',
          updated_at: updatedAt,
        },
      },
    })

    const ctx = makeCtx()
    ctx.query = { profile: 'default' }
    await ctrl.getAvailable(ctx)

    expect(ctx.body.groups).toEqual(expect.arrayContaining([
      expect.objectContaining({
        provider,
        builtin: true,
        models: ['configured-local-model'],
      }),
    ]))
    expect(JSON.stringify(ctx.body)).not.toContain('stale-fallback-model')
  })

  it('preserves cached catalogs for custom providers without a built-in manifest', async () => {
    const provider = 'custom:research-proxy'
    const baseUrl = 'https://research.invalid/v1'
    const updatedAt = '2026-07-11T00:00:00.000Z'
    mockReadConfigYamlForProfile.mockResolvedValue({
      model: { default: 'research-model', provider },
      custom_providers: [
        {
          name: 'research-proxy',
          base_url: baseUrl,
          model: 'research-model',
          api_key: 'test-placeholder',
          api_mode: 'chat_completions',
        },
      ],
    })
    mockReadProviderModelCatalogCache.mockResolvedValue({
      version: 1,
      updated_at: updatedAt,
      providers: {
        [modelCatalogKey(provider, baseUrl)]: {
          provider,
          label: 'research-proxy',
          base_url: baseUrl,
          models: ['cached-research-model'],
          source: 'fallback',
          updated_at: updatedAt,
        },
      },
    })

    const ctx = makeCtx()
    ctx.query = { profile: 'default' }
    await ctrl.getAvailable(ctx)

    expect(ctx.body.groups).toEqual(expect.arrayContaining([
      expect.objectContaining({
        provider,
        models: ['research-model', 'cached-research-model'],
      }),
    ]))
  })

  it('limits the default available-models response to profiles bound to regular admins', async () => {
    mockListProfileNamesFromDisk.mockReturnValue(['default', 'research', 'private'])
    mockListUserProfiles.mockReturnValue([
      { user_id: 7, profile_name: 'research', is_default: 1, created_at: 1 },
    ])
    mockReadConfigYamlForProfile.mockImplementation(async (profile: string) => ({
      model: {
        default: `${profile}-model`,
        provider: 'deepseek',
      },
    }))

    const ctx = makeCtx()
    ctx.state = { user: { id: 7, username: 'ops', role: 'admin' } }
    ctx.get = vi.fn((name: string) => name.toLowerCase() === 'x-hermes-profile' ? 'private' : '')
    await ctrl.getAvailable(ctx)

    expect(mockReadConfigYamlForProfile).toHaveBeenCalledTimes(1)
    expect(mockReadConfigYamlForProfile).toHaveBeenCalledWith('research')
    expect(ctx.body.profiles.map((profile: any) => profile.profile)).toEqual(['research'])
    expect(ctx.body.groups).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'deepseek' }),
    ]))
  })

  it('uses the requested profile for aggregate response defaults', async () => {
    mockListProfileNamesFromDisk.mockReturnValue(['default', 'tester'])
    mockReadConfigYamlForProfile.mockImplementation(async (profile: string) => ({
      model: {
        default: profile === 'tester' ? 'deepseek-reasoner' : 'deepseek-chat',
        provider: 'deepseek',
      },
    }))

    const ctx = makeCtx()
    ctx.state = { user: { id: 1, username: 'admin', role: 'super_admin' } }
    ctx.get = vi.fn((name: string) => name.toLowerCase() === 'x-hermes-profile' ? 'tester' : '')
    await ctrl.getAvailable(ctx)

    expect(ctx.body.default).toBe('deepseek-reasoner')
    expect(ctx.body.default_provider).toBe('deepseek')
    expect(ctx.body.profiles.map((profile: any) => profile.profile)).toEqual(['default', 'tester'])
  })

  it('uses explicit query profile for single-profile model fetches', async () => {
    mockListProfileNamesFromDisk.mockReturnValue(['default', 'research'])

    const ctx = makeCtx()
    ctx.query = { profile: 'research' }
    ctx.state = { profile: { name: 'default' }, user: { id: 1, username: 'admin', role: 'super_admin' } }
    await ctrl.getAvailable(ctx)

    expect(mockReadConfigYamlForProfile).toHaveBeenCalledTimes(1)
    expect(mockReadConfigYamlForProfile).toHaveBeenCalledWith('research')
    expect(ctx.body.profiles.map((profile: any) => profile.profile)).toEqual(['research'])
  })
  it('accepts OAuth providers stored in credential_pool entries', async () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(JSON.stringify({
      credential_pool: {
        openrouter: [{ label: 'primary', access_token: 'oauth-token' }],
      },
    }))

    const ctx = makeCtx()
    await ctrl.getAvailable(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.body.groups).toEqual(expect.arrayContaining([
      expect.objectContaining({
        provider: 'openrouter',
        label: 'OpenRouter',
        models: ['openrouter/auto'],
        model_count: 1,
      }),
    ]))
  })

  it('shows xAI Grok OAuth when SuperGrok credentials exist in auth.json', async () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(JSON.stringify({
      providers: {
        'xai-oauth': {
          tokens: { access_token: 'xai-token' },
        },
      },
    }))

    const ctx = makeCtx()
    await ctrl.getAvailable(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.body.groups).toEqual(expect.arrayContaining([
      expect.objectContaining({
        provider: 'xai-oauth',
        label: 'xAI Grok OAuth (SuperGrok Subscription)',
        base_url: 'https://api.x.ai/v1',
        models: ['grok-4.3', 'grok-4.20-0309-reasoning'],
      }),
    ]))
  })

  it.each([
    ['global', 'https://api.minimax.io/anthropic'],
    ['China', 'https://api.minimaxi.com/anthropic'],
  ])('uses the authorized MiniMax %s region URL to read the refreshed model cache', async (_region, baseUrl) => {
    mockReadFile.mockResolvedValue('')
    mockReadConfigYamlForProfile.mockResolvedValue({
      model: { default: 'MiniMax-M3', provider: 'minimax-oauth' },
    })
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(JSON.stringify({
      providers: {
        'minimax-oauth': {
          access_token: 'minimax-token',
          inference_base_url: baseUrl,
        },
      },
    }))
    mockReadProviderModelCatalogCache.mockResolvedValue({
      version: 1,
      updated_at: '2026-08-03T09:38:34.855Z',
      providers: {
        [modelCatalogKey('minimax-oauth', baseUrl)]: {
          provider: 'minimax-oauth',
          label: 'MiniMax Coding Plan (OAuth)',
          base_url: baseUrl,
          models: ['MiniMax-M3', 'MiniMax-M2.7', 'MiniMax-M2.5'],
          source: 'live',
          updated_at: '2026-08-03T09:38:34.855Z',
        },
      },
    })

    const ctx = makeCtx()
    ctx.query = { profile: 'default' }
    await ctrl.getAvailable(ctx)

    expect(ctx.body.groups).toEqual(expect.arrayContaining([
      expect.objectContaining({
        provider: 'minimax-oauth',
        base_url: baseUrl,
        models: ['MiniMax-M3', 'MiniMax-M2.7', 'MiniMax-M2.5'],
      }),
    ]))
    expect(mockResolveProviderCatalogModels).toHaveBeenCalledWith(
      expect.anything(),
      'minimax-oauth',
      baseUrl,
      expect.any(Array),
      expect.objectContaining({ profile: 'default' }),
    )
  })

  it('marks allProviders with base URL env support for editable preset URLs', async () => {
    const ctx = makeCtx()
    await ctrl.getAvailable(ctx)

    expect(ctx.body.allProviders).toEqual(expect.arrayContaining([
      expect.objectContaining({
        provider: 'deepseek',
        builtin: true,
        base_url_env: 'DEEPSEEK_BASE_URL',
      }),
      expect.not.objectContaining({
        provider: 'xai-oauth',
        base_url_env: expect.any(String),
      }),
    ]))
  })

  it('marks custom-prefixed providers as builtin when their provider key matches a preset', async () => {
    mockReadConfigYamlForProfile.mockResolvedValue({
      model: { default: 'gpt-5.5', provider: 'custom:fun-codex' },
      custom_providers: [
        {
          name: 'fun-codex',
          base_url: 'https://proxy.example.com/v1',
          model: 'gpt-5.5',
          api_key: 'sk-test',
        },
      ],
    })

    const ctx = makeCtx()
    ctx.query = { profile: 'default' }
    await ctrl.getAvailable(ctx)

    expect(ctx.body.groups).toEqual(expect.arrayContaining([
      expect.objectContaining({
        provider: 'custom:fun-codex',
        builtin: true,
        models: ['gpt-5.5', 'gpt-5.4'],
      }),
    ]))
  })

  it('loads api_mode from custom provider config entries', async () => {
    mockReadConfigYamlForProfile.mockResolvedValue({
      model: { default: 'research-model', provider: 'custom:research-proxy' },
      custom_providers: [
        {
          name: 'research-proxy',
          base_url: 'https://research.invalid/v1',
          model: 'research-model',
          api_key: 'sk-test',
          api_mode: 'chat_completions',
        },
      ],
    })

    const ctx = makeCtx()
    ctx.query = { profile: 'default' }
    await ctrl.getAvailable(ctx)

    expect(ctx.body.groups).toEqual(expect.arrayContaining([
      expect.objectContaining({
        provider: 'custom:research-proxy',
        api_mode: 'chat_completions',
        models: ['research-model'],
      }),
    ]))
  })

  it('returns LM Studio configured default model when env credentials exist and catalog is empty', async () => {
    mockReadFile.mockResolvedValue('LM_API_KEY=local\nLM_BASE_URL=http://127.0.0.1:1234/v1\n')
    mockReadConfigYaml.mockResolvedValue({ model: { default: 'eee', provider: 'lmstudio' } })
    mockReadConfigYamlForProfile.mockResolvedValue({ model: { default: 'eee', provider: 'lmstudio' } })

    const ctx = makeCtx()
    await ctrl.getAvailable(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.body.groups).toEqual(expect.arrayContaining([
      expect.objectContaining({
        provider: 'lmstudio',
        label: 'LM Studio',
        base_url: 'http://127.0.0.1:1234/v1',
        models: ['eee'],
        model_count: 1,
      }),
    ]))
    expect(ctx.body.default).toBe('eee')
    expect(ctx.body.default_provider).toBe('lmstudio')
  })

  it('updates the provider model catalog cache after manual model fetch', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: [{ id: 'nvidia/live-a' }, { id: 'nvidia/live-b' }, { id: '' }] }),
    })) as any

    try {
      const ctx = makeCtx({
        provider: 'nvidia',
        label: 'NVIDIA',
        base_url: 'https://integrate.api.nvidia.com/v1',
        api_key: 'nvapi-test',
        update_cache: true,
      })
      await ctrl.fetchProviderModelList(ctx)

      expect(ctx.status).toBe(200)
      expect(ctx.body).toEqual({ models: ['nvidia/live-a', 'nvidia/live-b'] })
      expect(mockWriteProviderModelCatalogEntry).toHaveBeenCalledWith({
        provider: 'nvidia',
        label: 'NVIDIA',
        base_url: 'https://integrate.api.nvidia.com/v1',
        models: ['nvidia/live-a', 'nvidia/live-b'],
        source: 'live',
        free_only: false,
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('refreshes configured provider model catalog cache on demand', async () => {
    const ctx = makeCtx()
    await ctrl.refreshProviderModelCatalogCache(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.body).toEqual({ success: true })
    expect(mockRefreshConfiguredProviderModelCatalogs).toHaveBeenCalledWith({ force: true })
  })

  it('does not fetch Copilot live models while serving available models', async () => {
    mockReadFile.mockResolvedValue('GITHUB_TOKEN=ghu-test\n')
    mockReadConfigYamlForProfile.mockResolvedValue({ model: { default: 'gpt-5.5', provider: 'copilot' } })

    const ctx = makeCtx()
    await ctrl.getAvailable(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.body.groups).toEqual(expect.arrayContaining([
      expect.objectContaining({
        provider: 'copilot',
        models: ['gpt-5.5'],
      }),
    ]))
    expect(mockGetCopilotModelsDetailed).not.toHaveBeenCalled()
  })



  it('fails open for stale include rules so a provider can be recovered in the UI', async () => {
    mockReadAppConfig.mockResolvedValue({
      modelVisibility: {
        deepseek: { mode: 'include', models: ['missing-model'] },
      },
    })

    const ctx = makeCtx()
    await ctrl.getAvailable(ctx)

    expect(ctx.body.groups[0]).toMatchObject({
      provider: 'deepseek',
      models: ['deepseek-chat', 'deepseek-reasoner'],
      model_count: 2,
    })
  })

  it('applies visibility to the config fallback path when no credentialed providers are active', async () => {
    mockReadFile.mockResolvedValue('')
    mockReadConfigYaml.mockResolvedValue({
      model: { default: 'custom-a' },
      custom_providers: [
        { name: 'local', model: 'custom-a' },
        { name: 'local', model: 'custom-b' },
      ],
    })
    mockReadAppConfig.mockResolvedValue({
      modelVisibility: {
        Custom: { mode: 'include', models: ['custom-b'] },
      },
    })
    mockBuildModelGroups.mockReturnValue({
      default: 'custom-a',
      groups: [
        {
          provider: 'Custom',
          models: [
            { id: 'custom-a', label: 'local: custom-a' },
            { id: 'custom-b', label: 'local: custom-b' },
          ],
        },
      ],
    })

    const ctx = makeCtx()
    await ctrl.getAvailable(ctx)

    expect(ctx.body.groups).toEqual([
      expect.objectContaining({
        provider: 'Custom',
        models: ['custom-b'],
        model_count: 2,
      }),
    ])
    expect(ctx.body.default).toBe('custom-b')
    expect(ctx.body.default_provider).toBe('Custom')
  })

  it('saves include visibility in web-ui app config only', async () => {
    mockReadAppConfig.mockResolvedValue({ copilotEnabled: true })
    mockWriteAppConfig.mockResolvedValue({
      copilotEnabled: true,
      modelVisibility: { deepseek: { mode: 'include', models: ['deepseek-chat'] } },
    })

    const ctx = makeCtx({ provider: 'deepseek', mode: 'include', models: ['deepseek-chat', 'deepseek-chat', ''] })
    await ctrl.setModelVisibility(ctx)

    expect(mockWriteAppConfig).toHaveBeenCalledWith({
      modelVisibility: { deepseek: { mode: 'include', models: ['deepseek-chat'] } },
    })
    expect(ctx.body).toEqual({
      success: true,
      model_visibility: { deepseek: { mode: 'include', models: ['deepseek-chat'] } },
    })
  })

  it('resets a provider to all models by deleting its web-ui visibility rule', async () => {
    mockReadAppConfig.mockResolvedValue({
      modelVisibility: {
        deepseek: { mode: 'include', models: ['deepseek-chat'] },
        openrouter: { mode: 'include', models: ['x'] },
      },
    })
    mockWriteAppConfig.mockResolvedValue({
      modelVisibility: {
        openrouter: { mode: 'include', models: ['x'] },
      },
    })

    const ctx = makeCtx({ provider: 'deepseek', mode: 'all', models: [] })
    await ctrl.setModelVisibility(ctx)

    expect(mockWriteAppConfig).toHaveBeenCalledWith({
      modelVisibility: {
        openrouter: { mode: 'include', models: ['x'] },
      },
    })
    expect(ctx.body.model_visibility).toEqual({
      openrouter: { mode: 'include', models: ['x'] },
    })
  })

  it('adds and removes custom models in web-ui app config only', async () => {
    mockReadAppConfig.mockResolvedValueOnce({
      customModels: { deepseek: ['existing'] },
    })
    mockWriteAppConfig.mockResolvedValueOnce({
      customModels: { deepseek: ['existing', 'manual-model'] },
    })

    const addCtx = makeCtx({ provider: 'deepseek', model: 'manual-model' })
    await ctrl.addCustomModel(addCtx)

    expect(mockWriteAppConfig).toHaveBeenCalledWith({
      customModels: { deepseek: ['existing', 'manual-model'] },
    })
    expect(addCtx.body).toEqual({
      success: true,
      custom_models: { deepseek: ['existing', 'manual-model'] },
    })

    mockReadAppConfig.mockResolvedValueOnce({
      customModels: { deepseek: ['existing', 'manual-model'] },
    })
    mockWriteAppConfig.mockResolvedValueOnce({
      customModels: { deepseek: ['existing'] },
    })

    const removeCtx = makeCtx({ provider: 'deepseek', model: 'manual-model' })
    await ctrl.removeCustomModel(removeCtx)

    expect(mockWriteAppConfig).toHaveBeenLastCalledWith({
      customModels: { deepseek: ['existing'] },
    })
    expect(removeCtx.body).toEqual({
      success: true,
      custom_models: { deepseek: ['existing'] },
    })
  })

  it('removes custom models from query params when DELETE body is missing', async () => {
    mockReadAppConfig.mockResolvedValueOnce({
      customModels: { deepseek: ['manual-model'] },
    })
    mockWriteAppConfig.mockResolvedValueOnce({
      customModels: {},
    })

    const ctx = makeCtx()
    ctx.request.body = undefined
    ctx.query = { provider: 'deepseek', model: 'manual-model' }

    await ctrl.removeCustomModel(ctx)

    expect(ctx.status).toBe(200)
    expect(mockWriteAppConfig).toHaveBeenCalledWith({ customModels: {} })
    expect(ctx.body).toEqual({ success: true, custom_models: {} })
  })

  it('rejects empty include lists', async () => {
    const ctx = makeCtx({ provider: 'deepseek', mode: 'include', models: [] })
    await ctrl.setModelVisibility(ctx)

    expect(ctx.status).toBe(400)
    expect(ctx.body).toEqual({ error: 'Select at least one model' })
    expect(mockWriteAppConfig).not.toHaveBeenCalled()
  })
})
