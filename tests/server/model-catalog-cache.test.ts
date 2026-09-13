import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockReadFile,
  mockFetchProviderModels,
  mockFetchCustomProviderCatalog,
  mockReadConfigYamlForProfile,
  mockReadText,
  mockUpdateText,
  mockListProfileNamesFromDisk,
  mockGetProfileDir,
  mockReadAppConfig,
  mockResolveCopilotOAuthToken,
  mockFetchCopilotModelsWithOAuthToken,
  mockGlobalFetch,
  mockResolveAuthorizedCredentials,
} = vi.hoisted(() => ({
  mockReadFile: vi.fn(),
  mockFetchProviderModels: vi.fn(),
  mockFetchCustomProviderCatalog: vi.fn(),
  mockReadConfigYamlForProfile: vi.fn(),
  mockReadText: vi.fn(),
  mockUpdateText: vi.fn(),
  mockListProfileNamesFromDisk: vi.fn(),
  mockGetProfileDir: vi.fn(),
  mockReadAppConfig: vi.fn(),
  mockResolveCopilotOAuthToken: vi.fn(),
  mockFetchCopilotModelsWithOAuthToken: vi.fn(),
  mockGlobalFetch: vi.fn(),
  mockResolveAuthorizedCredentials: vi.fn(),
}))

vi.mock('fs/promises', () => ({
  readFile: mockReadFile,
}))

vi.mock('../../packages/server/src/modules/studio/public/config', () => ({
  config: { appHome: '/app-home' },
}))

vi.mock('../../packages/server/src/modules/studio/contracts/providers', () => ({
  PROVIDER_PRESETS: [
    {
      value: 'openrouter',
      label: 'OpenRouter',
      base_url: 'https://openrouter.ai/api/v1',
      models: ['openrouter/fallback'],
    },
    {
      value: 'deepseek',
      label: 'DeepSeek',
      base_url: 'https://api.deepseek.com/v1',
      models: ['deepseek-chat'],
    },
    {
      value: 'openai-codex',
      label: 'OpenAI Codex',
      base_url: 'https://chatgpt.com/backend-api/codex',
      models: ['gpt-5.5', 'gpt-5.4-mini'],
    },
    {
      value: 'xai-oauth',
      label: 'xAI Grok OAuth',
      base_url: 'https://api.x.ai/v1',
      models: ['grok-4.3'],
    },
    {
      value: 'copilot',
      label: 'GitHub Copilot',
      base_url: 'https://api.githubcopilot.com',
      models: ['gpt-5.5', 'claude-sonnet-4.6'],
    },
    {
      value: 'nous',
      label: 'Nous Portal',
      base_url: 'https://inference-api.nousresearch.com/v1',
      models: ['anthropic/claude-opus-4.8'],
    },
    {
      value: 'claude-oauth',
      label: 'Claude OAuth',
      base_url: 'https://api.anthropic.com',
      models: ['claude-sonnet-4-6', 'claude-opus-4-7'],
    },
    {
      value: 'minimax-oauth',
      label: 'MiniMax Coding Plan (OAuth)',
      base_url: 'https://api.minimax.io/anthropic',
      api_mode: 'anthropic_messages',
      models: ['MiniMax-M3', 'MiniMax-M2.7', 'MiniMax-M2.7-highspeed'],
    },
  ],
}))

vi.mock('../../packages/server/src/modules/studio/public/profile-config', () => ({
  PROVIDER_ENV_MAP: {
    openrouter: { api_key_env: 'OPENROUTER_API_KEY', base_url_env: 'OPENROUTER_BASE_URL' },
    deepseek: { api_key_env: 'DEEPSEEK_API_KEY', base_url_env: 'DEEPSEEK_BASE_URL' },
    'openai-codex': { api_key_env: '', base_url_env: '' },
    'xai-oauth': { api_key_env: '', base_url_env: '' },
    copilot: { api_key_env: 'GITHUB_TOKEN', base_url_env: '' },
    nous: { api_key_env: '', base_url_env: '' },
    'claude-oauth': { api_key_env: '', base_url_env: '' },
    'minimax-oauth': { api_key_env: '', base_url_env: '' },
  },
  readConfigYamlForProfile: mockReadConfigYamlForProfile,
}))

vi.mock('../../packages/server/src/modules/studio/public/provider-catalog', () => ({
  fetchProviderModels: mockFetchProviderModels,
}))

vi.mock('../../packages/server/src/modules/hermes/services/providers/provider-editor', () => ({
  fetchProviderCatalogForTest: mockFetchCustomProviderCatalog,
}))

vi.mock('../../packages/server/src/modules/studio/public/app-config', () => ({
  readAppConfig: mockReadAppConfig,
}))

vi.mock('../../packages/server/src/modules/hermes/services/providers/copilot-models', () => ({
  resolveCopilotOAuthToken: mockResolveCopilotOAuthToken,
  fetchCopilotModelsWithOAuthToken: mockFetchCopilotModelsWithOAuthToken,
}))

vi.mock('../../packages/server/src/modules/hermes/services/providers/authorized-provider-credentials', () => ({
  resolveAuthorizedProviderRuntimeCredentials: mockResolveAuthorizedCredentials,
}))

vi.mock('../../packages/server/src/modules/hermes/services/profiles/profile', () => ({
  getProfileDir: mockGetProfileDir,
  listProfileNamesFromDisk: mockListProfileNamesFromDisk,
}))

vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
  },
}))

vi.mock('../../packages/server/src/modules/studio/public/safe-file-store', () => ({
  safeFileStore: {
    readText: mockReadText,
    updateText: mockUpdateText,
  },
}))

describe('model catalog cache', () => {
  let cacheText = ''

  beforeEach(() => {
    vi.clearAllMocks()
    cacheText = ''
    mockListProfileNamesFromDisk.mockReturnValue(['default', 'team'])
    mockGetProfileDir.mockImplementation((profile: string) => `/hermes/${profile}`)
    mockReadText.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))
    mockUpdateText.mockImplementation(async (_path: string, updater: (current: string) => string) => {
      cacheText = updater(cacheText)
    })
    mockReadAppConfig.mockResolvedValue({})
    mockResolveCopilotOAuthToken.mockResolvedValue('')
    mockFetchCopilotModelsWithOAuthToken.mockResolvedValue([])
  mockFetchProviderModels.mockResolvedValue([])
  mockFetchCustomProviderCatalog.mockResolvedValue([])
    mockResolveAuthorizedCredentials.mockRejectedValue(new Error('not authenticated'))
    mockGlobalFetch.mockResolvedValue({ ok: false, status: 404, json: async () => ({}) })
    vi.stubGlobal('fetch', mockGlobalFetch)
    mockReadFile.mockImplementation(async (path: string) => {
      path = path.replace(/\\/g, '/')
      if (path === '/hermes/default/.env') return 'OPENROUTER_API_KEY=default-openrouter\n'
      if (path === '/hermes/team/.env') {
        return [
          'OPENROUTER_API_KEY=team-openrouter',
          'DEEPSEEK_API_KEY=team-deepseek',
        ].join('\n')
      }
      throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    })
    mockReadConfigYamlForProfile.mockImplementation(async (profile: string) => {
      if (profile === 'default') {
        return {
          custom_providers: [
            { name: 'Shared Local', base_url: 'https://custom.local/v1', api_key: 'custom-a', model: 'local-a' },
          ],
        }
      }
      return {
        custom_providers: [
          { name: 'Shared Local', base_url: 'https://custom.local/v1', api_key: 'custom-b', model: 'local-b' },
        ],
      }
    })
  })

  it('resolves cached catalogs by source and authoritative manifest presence', async () => {
    const { providerModelCatalogKey, resolveProviderCatalogModels } = await import(
      '../../packages/server/src/modules/hermes/services/providers/model-catalog-cache'
    )
    const provider = 'xai'
    const baseUrl = 'https://api.x.ai/v1'
    const key = providerModelCatalogKey(provider, baseUrl)
    const cachedModels = ['grok-4.3', 'grok-imagine-image']
    const currentModels = ['grok-build-0.1', 'grok-4.3']
    const fallbackEntry = {
      provider,
      label: 'xAI',
      base_url: baseUrl,
      models: cachedModels,
      source: 'fallback' as const,
      updated_at: '2026-01-01T00:00:00.000Z',
    }
    const fallbackCache = {
      version: 1 as const,
      updated_at: fallbackEntry.updated_at,
      providers: { [key]: fallbackEntry },
    }

    expect(resolveProviderCatalogModels(
      fallbackCache,
      provider,
      baseUrl,
      currentModels,
      { hasStaticManifest: true },
    )).toEqual(currentModels)
    expect(resolveProviderCatalogModels(
      fallbackCache,
      provider,
      baseUrl,
      [],
      { hasStaticManifest: true },
    )).toEqual([])
    expect(resolveProviderCatalogModels(
      fallbackCache,
      provider,
      baseUrl,
      [],
      { hasStaticManifest: false },
    )).toEqual(cachedModels)
    expect(resolveProviderCatalogModels(
      { ...fallbackCache, providers: { [key]: { ...fallbackEntry, source: 'live' as const } } },
      provider,
      baseUrl,
      currentModels,
      { hasStaticManifest: true },
    )).toEqual(cachedModels)
    expect(resolveProviderCatalogModels(
      { ...fallbackCache, providers: {} },
      provider,
      baseUrl,
      currentModels,
      { hasStaticManifest: true },
    )).toEqual(currentModels)
  })

  it('preserves the last-good live catalog when a refresh returns no models', async () => {
    const { providerModelCatalogKey, refreshProviderModelCatalog } = await import(
      '../../packages/server/src/modules/hermes/services/providers/model-catalog-cache'
    )
    const provider = 'deepseek'
    const baseUrl = 'https://api.deepseek.com/v1'
    const key = providerModelCatalogKey(provider, baseUrl)
    const lastGood = {
      provider,
      label: 'DeepSeek',
      base_url: baseUrl,
      models: ['deepseek-last-good'],
      source: 'live' as const,
      updated_at: '2026-06-01T12:00:00.000Z',
      profiles: ['default'],
    }
    cacheText = JSON.stringify({
      version: 1,
      updated_at: lastGood.updated_at,
      providers: { [key]: lastGood },
    })
    mockFetchProviderModels.mockResolvedValueOnce([])

    await refreshProviderModelCatalog({
      provider,
      label: 'DeepSeek',
      base_url: baseUrl,
      api_key: 'failed-refresh-key',
      fallback_models: ['deepseek-chat'],
      profiles: ['default'],
    })

    const after = JSON.parse(cacheText)
    expect(after.providers[key]).toEqual(lastGood)
  })

  it('refreshes providers from all profiles and deduplicates identical catalogs', async () => {
    const { refreshConfiguredProviderModelCatalogs, providerModelCatalogKey } = await import(
      '../../packages/server/src/modules/hermes/services/providers/model-catalog-cache'
    )

    await refreshConfiguredProviderModelCatalogs({ force: true })

    expect(mockFetchProviderModels).toHaveBeenCalledTimes(2)
    expect(mockFetchProviderModels).toHaveBeenCalledWith('https://openrouter.ai/api/v1', 'default-openrouter', true)
    expect(mockFetchProviderModels).toHaveBeenCalledWith('https://api.deepseek.com/v1', 'team-deepseek', false)
    expect(mockFetchCustomProviderCatalog).toHaveBeenCalledWith('https://custom.local/v1', 'custom-a', undefined, expect.objectContaining({
      provider: 'custom:shared-local',
    }))

    const cache = JSON.parse(cacheText)
    expect(cache.providers[providerModelCatalogKey('openrouter', 'https://openrouter.ai/api/v1', true)]).toMatchObject({
      provider: 'openrouter',
      models: ['openrouter/fallback'],
      profiles: ['default', 'team'],
    })
    expect(cache.providers[providerModelCatalogKey('deepseek', 'https://api.deepseek.com/v1')]).toMatchObject({
      provider: 'deepseek',
      models: ['deepseek-chat'],
      profiles: ['team'],
    })
    expect(cache.providers[providerModelCatalogKey('custom:shared-local', 'https://custom.local/v1')]).toMatchObject({
      provider: 'custom:shared-local',
      models: ['local-a', 'local-b'],
      profiles: ['default', 'team'],
    })
  })

  it('clears a stale profile catalog after a successful global refresh', async () => {
    mockListProfileNamesFromDisk.mockReturnValue(['default'])
    mockFetchProviderModels.mockImplementation(async (baseUrl: string) => (
      baseUrl === 'https://openrouter.ai/api/v1'
        ? ['openrouter/fresh-from-global']
        : []
    ))
    const {
      providerModelCatalogKey,
      refreshConfiguredProviderModelCatalogs,
      resolveProviderCatalogModels,
      writeProviderModelCatalogEntry,
    } = await import('../../packages/server/src/modules/hermes/services/providers/model-catalog-cache')
    const scopedKey = providerModelCatalogKey(
      'openrouter',
      'https://openrouter.ai/api/v1',
      true,
      'default',
    )
    await writeProviderModelCatalogEntry({
      provider: 'openrouter',
      label: 'OpenRouter',
      base_url: 'https://openrouter.ai/api/v1',
      models: ['openrouter/stale-from-card'],
      source: 'live',
      free_only: true,
      profile: 'default',
      profiles: ['default'],
    })

    await refreshConfiguredProviderModelCatalogs({ force: true })

    const cache = JSON.parse(cacheText)
    expect(cache.providers[scopedKey]).toBeUndefined()
    expect(resolveProviderCatalogModels(
      cache,
      'openrouter',
      'https://openrouter.ai/api/v1',
      [],
      { freeOnly: true, profile: 'default' },
    )).toEqual(['openrouter/fresh-from-global'])
  })

  it('adds authorized providers to the catalog cache and fetches live models for compatible auth providers', async () => {
    mockListProfileNamesFromDisk.mockReturnValue(['default'])
    mockReadAppConfig.mockResolvedValue({ copilotEnabled: true })
    mockResolveCopilotOAuthToken.mockResolvedValue('gho-copilot')
    mockFetchCopilotModelsWithOAuthToken.mockResolvedValue([
      { id: 'gpt-5.6-copilot', preview: false, disabled: false },
      { id: 'claude-sonnet-4.6', preview: false, disabled: false },
    ])
    mockGlobalFetch.mockImplementation(async (url: string) => {
      if (url === 'https://chatgpt.com/backend-api/codex/models?client_version=1.0.0') {
        return {
          ok: true,
          json: async () => ({
            models: [
              { slug: 'hidden-codex', visibility: 'hidden', priority: 0 },
              { slug: 'gpt-5.4-mini', priority: 20 },
              { slug: 'gpt-5.5', priority: 10 },
            ],
          }),
        }
      }
      return { ok: false, status: 404, json: async () => ({}) }
    })
    mockFetchProviderModels.mockImplementation(async (baseUrl: string, apiKey: string) => {
      if (baseUrl === 'https://inference-api.nousresearch.com/v1' && apiKey === 'nous-agent-key') {
        return ['nous/live-a', 'nous/live-b']
      }
      if (baseUrl === 'https://api.x.ai/v1' && apiKey === 'xai-access-token') {
        return ['grok-live-a', 'grok-live-b']
      }
      if (baseUrl === 'https://api.minimaxi.com/anthropic' && apiKey === 'minimax-access-token') {
        return ['MiniMax-M3', 'MiniMax-M2.7', 'MiniMax-M2.5']
      }
      return []
    })
    mockResolveAuthorizedCredentials.mockImplementation(async ({ provider }: { provider: string }) => {
      const credentials: Record<string, { apiKey: string; baseUrl: string }> = {
        'openai-codex': {
          apiKey: 'codex-token',
          baseUrl: 'https://chatgpt.com/backend-api/codex',
        },
        'xai-oauth': {
          apiKey: 'xai-access-token',
          baseUrl: 'https://api.x.ai/v1',
        },
        nous: {
          apiKey: 'nous-agent-key',
          baseUrl: 'https://inference-api.nousresearch.com/v1',
        },
        'claude-oauth': {
          apiKey: 'claude-access-token',
          baseUrl: 'https://api.anthropic.com',
        },
        'minimax-oauth': {
          apiKey: 'minimax-access-token',
          baseUrl: 'https://api.minimaxi.com/anthropic',
        },
      }
      if (!credentials[provider]) throw new Error('not authenticated')
      return { provider, ...credentials[provider] }
    })
    mockReadFile.mockImplementation(async (path: string) => {
      path = path.replace(/\\/g, '/')
      if (path === '/hermes/default/.env') return ''
      if (path === '/hermes/default/auth.json') {
        return JSON.stringify({
          providers: {
            'openai-codex': { tokens: { access_token: 'codex-token' } },
            'claude-oauth': {
              tokens: {
                access_token: 'claude-access-token',
                refresh_token: 'claude-refresh-token',
              },
              base_url: 'https://api.anthropic.com',
            },
            'minimax-oauth': {
              access_token: 'minimax-access-token',
              refresh_token: 'minimax-refresh-token',
              inference_base_url: 'https://api.minimaxi.com/anthropic',
            },
          },
          credential_pool: {
            'xai-oauth': [{ access_token: 'xai-access-token' }],
            nous: [{
              agent_key: 'nous-agent-key',
              inference_base_url: 'https://inference-api.nousresearch.com/v1',
            }],
          },
        })
      }
      throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    })
    mockReadConfigYamlForProfile.mockResolvedValue({})

    const {
      providerModelCatalogKey,
      refreshConfiguredProviderModelCatalogs,
      resolveProviderCatalogRefreshTarget,
    } = await import(
      '../../packages/server/src/modules/hermes/services/providers/model-catalog-cache'
    )

    await refreshConfiguredProviderModelCatalogs({ force: true })

    await expect(resolveProviderCatalogRefreshTarget('default', 'openai-codex')).resolves.toMatchObject({
      provider: 'openai-codex',
      api_key: 'codex-token',
      credential_kind: 'oauth',
      profile: 'default',
    })
    expect(mockFetchProviderModels).toHaveBeenCalledTimes(3)
    expect(mockFetchProviderModels).toHaveBeenCalledWith('https://inference-api.nousresearch.com/v1', 'nous-agent-key', false)
    expect(mockFetchProviderModels).toHaveBeenCalledWith('https://api.x.ai/v1', 'xai-access-token', false)
    expect(mockFetchProviderModels).toHaveBeenCalledWith('https://api.minimaxi.com/anthropic', 'minimax-access-token', false)
    expect(mockResolveAuthorizedCredentials).toHaveBeenCalledWith({
      profile: 'default',
      provider: 'openai-codex',
    })
    expect(mockFetchCopilotModelsWithOAuthToken).toHaveBeenCalledWith('gho-copilot')
    const cache = JSON.parse(cacheText)
    expect(cache.providers[providerModelCatalogKey('openai-codex', 'https://chatgpt.com/backend-api/codex')]).toMatchObject({
      provider: 'openai-codex',
      models: ['gpt-5.5', 'gpt-5.4-mini'],
      source: 'live',
      profiles: ['default'],
    })
    expect(cache.providers[providerModelCatalogKey('xai-oauth', 'https://api.x.ai/v1')]).toMatchObject({
      provider: 'xai-oauth',
      models: ['grok-live-a', 'grok-live-b'],
      source: 'live',
      profiles: ['default'],
    })
    expect(cache.providers[providerModelCatalogKey('copilot', 'https://api.githubcopilot.com')]).toMatchObject({
      provider: 'copilot',
      models: ['gpt-5.6-copilot', 'claude-sonnet-4.6'],
      source: 'live',
      profiles: ['default'],
    })
    expect(cache.providers[providerModelCatalogKey('nous', 'https://inference-api.nousresearch.com/v1')]).toMatchObject({
      provider: 'nous',
      models: ['nous/live-a', 'nous/live-b'],
      source: 'live',
      profiles: ['default'],
    })
    expect(cache.providers[providerModelCatalogKey('claude-oauth', 'https://api.anthropic.com')]).toMatchObject({
      provider: 'claude-oauth',
      models: ['claude-sonnet-4-6', 'claude-opus-4-7'],
      source: 'fallback',
      profiles: ['default'],
    })
    expect(cache.providers[providerModelCatalogKey('minimax-oauth', 'https://api.minimaxi.com/anthropic')]).toMatchObject({
      provider: 'minimax-oauth',
      models: ['MiniMax-M3', 'MiniMax-M2.7', 'MiniMax-M2.5'],
      source: 'live',
      profiles: ['default'],
    })
  })

  it.each([
    ['global', 'https://api.minimax.io/anthropic'],
    ['China', 'https://api.minimaxi.com/anthropic'],
  ])('refreshes the MiniMax %s catalog against its authorized region URL', async (_region, baseUrl) => {
    mockListProfileNamesFromDisk.mockReturnValue(['default'])
    mockReadConfigYamlForProfile.mockResolvedValue({})
    mockReadFile.mockImplementation(async (path: string) => {
      path = path.replace(/\\/g, '/')
      if (path === '/hermes/default/.env') return ''
      if (path === '/hermes/default/auth.json') {
        return JSON.stringify({
          providers: {
            'minimax-oauth': {
              access_token: 'minimax-access-token',
              refresh_token: 'minimax-refresh-token',
              inference_base_url: baseUrl,
            },
          },
        })
      }
      throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    })
    mockResolveAuthorizedCredentials.mockResolvedValue({
      provider: 'minimax-oauth',
      apiKey: 'minimax-access-token',
      baseUrl,
    })
    mockFetchProviderModels.mockResolvedValue([
      'MiniMax-M3',
      'MiniMax-M2.7',
      'MiniMax-M2.7-highspeed',
      'MiniMax-M2.5',
    ])

    const { providerModelCatalogKey, refreshConfiguredProviderModelCatalogs } = await import(
      '../../packages/server/src/modules/hermes/services/providers/model-catalog-cache'
    )
    await refreshConfiguredProviderModelCatalogs({ force: true })

    expect(mockFetchProviderModels).toHaveBeenCalledWith(
      baseUrl,
      'minimax-access-token',
      false,
    )
    const cache = JSON.parse(cacheText)
    expect(cache.providers[providerModelCatalogKey('minimax-oauth', baseUrl)]).toMatchObject({
      provider: 'minimax-oauth',
      base_url: baseUrl,
      models: [
        'MiniMax-M3',
        'MiniMax-M2.7',
        'MiniMax-M2.7-highspeed',
        'MiniMax-M2.5',
      ],
      source: 'live',
      profiles: ['default'],
    })
  })
})
