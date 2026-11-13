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
import { resolveCustomProviderApiKey } from '../../packages/server/src/modules/studio/contracts/provider-compat'

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

it.each(['custom_providers', 'providers'])(
  'advertises profile key_env credentials from %s without returning the secret',
  async schema => {
    const entry = { name: 'cn', base_url: 'https://provider.invalid/v1', key_env: 'CN_API_KEY', model: 'deepseek-v4.1-flash' }
    mocks.readConfig.mockResolvedValue(schema === 'providers'
      ? { providers: { cn: entry } } : { custom_providers: [entry] })
    await writeFile(join(mocks.home, 'work', '.env'), 'CN_API_KEY="fixture-profile-key"\n')
    const ctx = { query: { profile: 'work' }, state: {} } as any

    await getAvailable(ctx)

    expect(ctx.status).not.toBe(500)
    expect(ctx.body.groups).toEqual([expect.objectContaining({
      provider: 'custom:cn', credential_configured: true, api_key: '',
    })])
    expect(ctx.body.profiles[0].groups[0].credential_configured).toBe(true)
    expect(JSON.stringify(ctx.body)).not.toContain('fixture-profile-key')
    expect(resolveCustomProviderApiKey({ ...entry, source: schema as 'providers' | 'custom_providers' },
      'CN_API_KEY="fixture-profile-key"\n')).toBe('fixture-profile-key')
  },
)

it.each(['', 'CN_API_KEY=\n', 'CN_API_KEY=""\n', "CN_API_KEY=''\n"])(
  'does not advertise a missing or empty key_env credential (%j)', async env => {
    mocks.readConfig.mockResolvedValue({ providers: { cn: {
      base_url: 'https://provider.invalid/v1', key_env: 'CN_API_KEY', model: 'model-a',
    } } })
    await writeFile(join(mocks.home, 'work', '.env'), env)
    const result = await getAvailableModelConfigForProfile('work')
    expect(result.groups[0]).toMatchObject({ provider: 'custom:cn', credential_configured: false, api_key: '' })
  },
)

it('keeps readiness profile-local while merging the aggregate catalog', async () => {
  mocks.readConfig.mockResolvedValue({ providers: { cn: {
    base_url: 'https://provider.invalid/v1', key_env: 'CN_API_KEY', model: 'model-a',
  } } })
  await writeFile(join(mocks.home, 'work', '.env'), 'CN_API_KEY=work-only-key\n')
  const ctx = { query: {}, state: {} } as any

  await getAvailable(ctx)

  expect(ctx.body.profiles.find((profile: any) => profile.profile === 'default').groups[0].credential_configured).toBe(false)
  expect(ctx.body.profiles.find((profile: any) => profile.profile === 'work').groups[0].credential_configured).toBe(true)
  expect(ctx.body.groups[0].credential_configured).toBe(true)
  expect(JSON.stringify(ctx.body)).not.toContain('work-only-key')
})

it('preserves inline-key precedence over key_env', async () => {
  const entry = { name: 'cn', base_url: 'https://provider.invalid/v1', api_key: 'inline-key', key_env: 'CN_API_KEY', model: 'model-a' }
  mocks.readConfig.mockResolvedValue({ providers: { cn: entry } })
  await writeFile(join(mocks.home, 'work', '.env'), 'CN_API_KEY=env-key\n')

  const result = await getAvailableModelConfigForProfile('work')

  expect(result.groups[0]).toMatchObject({ credential_configured: true, api_key: 'inline-key' })
  expect(resolveCustomProviderApiKey({ ...entry, source: 'providers' }, 'CN_API_KEY=env-key\n')).toBe('inline-key')
})
