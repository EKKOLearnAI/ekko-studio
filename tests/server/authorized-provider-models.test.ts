import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

const mocks = vi.hoisted(() => ({
  home: '',
  readConfig: vi.fn(),
  readApp: vi.fn(),
  copilotToken: vi.fn(),
}))
vi.mock('../../packages/server/src/modules/hermes/services/profiles/profile', () => ({
  getProfileDir: (profile: string) => join(mocks.home, profile),
  getActiveProfileName: () => 'default',
  listProfileNamesFromDisk: () => ['default', 'work'],
}))
vi.mock('../../packages/server/src/modules/studio/public/profile-config', async () => ({
  ...await import('../../packages/server/src/modules/hermes/services/profiles/config'),
  readConfigYamlForProfile: mocks.readConfig,
}))
vi.mock('../../packages/server/src/modules/studio/public/app-config', () => ({
  readAppConfig: mocks.readApp,
  providerDisplayLabel: (_config: unknown, _profile: string, _provider: string, label: string) => label,
}))
vi.mock('../../packages/server/src/modules/studio/public/users', () => ({ listUserProfiles: vi.fn() }))
vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({ logger: {} }))
vi.mock('../../packages/server/src/modules/studio/public/provider-context', () => ({}))
vi.mock('../../packages/server/src/modules/hermes/services/models/context', () => ({}))
vi.mock('../../packages/server/src/modules/hermes/services/models/metadata', () => ({
  createCatalogModelMetadataEnricher: () => (groups: unknown[]) => groups,
}))
vi.mock('../../packages/server/src/modules/hermes/services/providers/provider-editor', () => ({
  providerEditorCapabilities: () => ({ editable: false, editable_fields: [] }),
}))
vi.mock('../../packages/server/src/modules/hermes/services/providers/model-catalog-cache', () => ({
  readProviderModelCatalogCache: async () => ({ version: 1, providers: {} }),
  resolveProviderCatalogModels: (_cache: unknown, _provider: string, _url: string, fallback: string[]) => fallback,
  resolveProviderCatalogEntry: () => undefined,
}))
vi.mock('../../packages/server/src/modules/hermes/services/providers/copilot-models', () => ({
  resolveCopilotOAuthToken: mocks.copilotToken,
}))

import { PROVIDER_ENV_MAP } from '../../packages/server/src/modules/hermes/services/profiles/config'
import { getAvailable, getAvailableModelConfigForProfile } from '../../packages/server/src/modules/hermes/controllers/models'

const keylessProviders = Object.entries(PROVIDER_ENV_MAP)
  .filter(([, mapping]) => !mapping.api_key_env)
  .map(([provider]) => provider)

async function saveAuth(profile: string, auth: unknown) {
  await writeFile(join(mocks.home, profile, 'auth.json'), JSON.stringify(auth))
}

beforeEach(async () => {
  vi.clearAllMocks()
  mocks.home = await mkdtemp(join(tmpdir(), 'studio-authorized-models-'))
  await Promise.all(['default', 'work'].map(profile => mkdir(join(mocks.home, profile))))
  mocks.readConfig.mockResolvedValue({})
  mocks.readApp.mockResolvedValue({ copilotEnabled: false })
  mocks.copilotToken.mockResolvedValue(null)
})
afterEach(async () => { await rm(mocks.home, { recursive: true, force: true }) })

it.each(['nested tokens', 'access token', 'credential pool'])(
  'keeps every authorized keyless provider visible with %s',
  async format => {
    const entries = keylessProviders.map(provider => [provider, format === 'nested tokens'
      ? { tokens: { access_token: 'fixture-token' } }
      : format === 'access token' ? { access_token: 'fixture-token' } : [{ agent_key: 'fixture-agent-key' }]])
    await saveAuth('work', { [format === 'credential pool' ? 'credential_pool' : 'providers']: Object.fromEntries(entries) })
    mocks.readConfig.mockResolvedValue({ model: { provider: 'openai-codex', default: 'configured-codex-model' } })

    const result = await getAvailableModelConfigForProfile('work')

    expect(result.groups.map(group => group.provider).sort()).toEqual([...keylessProviders].sort())
    expect(result.groups.find(group => group.provider === 'openai-codex')?.models).toContain('configured-codex-model')
  },
)

it.each([undefined, 'work'])('includes authorized providers in the available endpoint (profile=%s)', async profile => {
  await saveAuth('work', { providers: { 'openai-codex': { tokens: { access_token: 'fixture-codex' } } } })
  const ctx = { query: profile ? { profile } : {}, state: {} } as any

  await getAvailable(ctx)

  expect(ctx.status).not.toBe(500)
  expect(ctx.body.groups.map((group: { provider: string }) => group.provider)).toEqual(['openai-codex'])
  expect(ctx.body.profiles.find((item: { profile: string }) => item.profile === 'work').groups)
    .toEqual(expect.arrayContaining([expect.objectContaining({ provider: 'openai-codex' })]))
})

it('keeps root OAuth grants and the legacy anthropic alias available in a named profile', async () => {
  await saveAuth('default', { providers: {
    nous: { agent_key: 'fixture-nous', inference_base_url: 'https://inference.example.invalid/v1/' },
    anthropic: { tokens: { access_token: 'fixture-claude' } },
  } })

  const result = await getAvailableModelConfigForProfile('work')

  expect(result.groups.map(group => group.provider).sort()).toEqual(['claude-oauth', 'nous'])
  expect(result.groups.find(group => group.provider === 'nous')?.base_url).toBe('https://inference.example.invalid/v1')
})

it('hides providers without credentials and still requires API keys for API-key providers', async () => {
  await saveAuth('work', { providers: { deepseek: { access_token: 'unrelated-oauth-token' } } })
  expect((await getAvailableModelConfigForProfile('work')).groups).toEqual([])

  await writeFile(join(mocks.home, 'work', '.env'), 'DEEPSEEK_API_KEY=fixture-api-key\n')
  const result = await getAvailableModelConfigForProfile('work')
  expect(result.groups.map(group => group.provider)).toEqual(['deepseek'])
})

it('still requires Copilot activation and a runtime-readable token', async () => {
  mocks.copilotToken.mockResolvedValue('fixture-copilot')
  expect((await getAvailableModelConfigForProfile('work')).groups).toEqual([])

  mocks.readApp.mockResolvedValue({ copilotEnabled: true })
  mocks.copilotToken.mockResolvedValue(null)
  expect((await getAvailableModelConfigForProfile('work')).groups).toEqual([])

  mocks.copilotToken.mockResolvedValue('fixture-copilot')
  expect((await getAvailableModelConfigForProfile('work')).groups.map(group => group.provider)).toEqual(['copilot'])
  expect(mocks.copilotToken).toHaveBeenCalledWith('', false)
})
