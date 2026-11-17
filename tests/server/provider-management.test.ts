import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import YAML from 'js-yaml'

const fixture = vi.hoisted(() => ({ home: '', resolveAuth: vi.fn(), fetch: vi.fn() }))
vi.mock('../../packages/server/src/modules/studio/public/config', () => ({ config: { get appHome() { return fixture.home }, port: 18648 } }))
vi.mock('../../packages/server/src/modules/studio/repositories/users-store', () => ({
  findUserById: (id: unknown) => ({ id: Number(id), status: 'active' }),
  getDefaultProfileForUser: () => 'default',
  listUsers: () => [],
}))
vi.mock('../../packages/server/src/modules/studio/public/app-config', () => ({
  readAppConfig: async () => ({}), invalidateAppConfigCache: () => {},
  providerDisplayLabel: (_config: unknown, _profile: string, _provider: string, label: string) => label,
}))
vi.mock('../../packages/server/src/modules/hermes/services/profiles/profile', () => ({ getActiveProfileName: () => 'default' }))
vi.mock('../../packages/server/src/modules/studio/public/profile-config', () => ({
  PROVIDER_ENV_MAP: { deepseek: { api_key_env: 'DEEPSEEK_API_KEY', base_url_env: 'DEEPSEEK_BASE_URL' }, copilot: { api_key_env: 'COPILOT_GITHUB_TOKEN', base_url_env: '' } },
  buildModelGroups: () => ({ default: '', groups: [] }),
}))
vi.mock('../../packages/server/src/modules/studio/public/provider-context', () => ({ readProviderContextLengths: () => ({}) }))
vi.mock('../../packages/server/src/modules/studio/public/provider-runtime', () => ({ invalidateProviderRuntime: vi.fn() }))
vi.mock('../../packages/server/src/modules/studio/public/provider-audit', () => ({ appendProviderAuditEvent: vi.fn() }))
vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }))
vi.mock('../../packages/server/src/modules/hermes/services/models/metadata', () => ({ createCatalogModelMetadataEnricher: () => (groups: unknown) => groups }))

import { configureProviderSources, importAccountProviders, providerAccountHome, withProviderAccount } from '../../packages/server/src/modules/studio/public/provider-account'
import { readConfigYamlForProfile, updateConfigYamlForProfile } from '../../packages/server/src/modules/studio/public/provider-config'
import { configureAuthorizedProviderRuntime } from '../../packages/server/src/modules/studio/public/authorized-provider-runtime'
import { configureProviderProjection, synchronizeHermesProvider } from '../../packages/server/src/modules/studio/public/provider-projection'
import { refreshConfiguredProviderModelCatalogs, readProviderModelCatalogCache, resolveProviderCatalogRefreshTarget, writeProviderModelCatalogEntry } from '../../packages/server/src/modules/hermes/services/providers/model-catalog-cache'
import { refreshProviderModels, restoreProviderModels } from '../../packages/server/src/modules/hermes/services/providers/provider-model-refresh'
import { fetchProviderModelList, getAvailableModelGroupsForProfile } from '../../packages/server/src/modules/hermes/controllers/models'
import { remove, update } from '../../packages/server/src/modules/hermes/controllers/providers'
import { getProviderEditorDetail, testProviderEditorDraft, updateProviderEditorDetail } from '../../packages/server/src/modules/hermes/services/providers/provider-editor'
import { resolveEkkoProviderRuntimeConfig } from '../../packages/server/src/modules/ekko/services/provider-runtime'

let source: string
beforeEach(async () => {
  vi.clearAllMocks()
  fixture.home = await mkdtemp(join(tmpdir(), 'provider-management-'))
  source = join(fixture.home, 'legacy')
  for (const profile of ['default', 'work']) {
    await mkdir(join(source, profile), { recursive: true })
    await writeFile(join(source, profile, 'config.yaml'), YAML.dump({ model: { provider: 'deepseek', default: 'old-model' } }))
    await writeFile(join(source, profile, '.env'), 'DEEPSEEK_API_KEY=account-key\n')
  }
  configureProviderSources({ profileDir: profile => join(source, profile), profiles: () => ['default', 'work'],
    environmentKeys: ['DEEPSEEK_API_KEY'], environmentMap: { deepseek: { api_key_env: 'DEEPSEEK_API_KEY', base_url_env: 'DEEPSEEK_BASE_URL' } } })
  configureAuthorizedProviderRuntime({ isAuthorizedRuntimeProvider: () => true, resolveAuthorizedProviderRuntimeCredentials: fixture.resolveAuth })
  fixture.resolveAuth.mockRejectedValue(new Error('No nous OAuth credentials were found in the Hermes credential store'))
  fixture.fetch.mockImplementation(async () => Response.json({ data: [{ id: 'new-model' }] }))
  vi.stubGlobal('fetch', fixture.fetch)
  configureProviderProjection(getAvailableModelGroupsForProfile)
})
afterEach(async () => { vi.unstubAllGlobals(); await rm(fixture.home, { recursive: true, force: true }) })

async function addBrokenOAuth() {
  await updateConfigYamlForProfile('default', config => {
    config.providers.nous = { name: 'Nous Portal', catalog_provider: 'nous', runtime_provider: 'nous', auth_provider: 'nous', base_url: 'https://nous.invalid/v1', model: 'nous-model' }
    return config
  })
}

it('refreshes only the requested Provider even when another OAuth grant is missing', async () => {
  await withProviderAccount(1, async () => {
    await importAccountProviders()
    await addBrokenOAuth()
    const result = await refreshProviderModels('default', 'deepseek', { confirm: true })
    expect(result.applied).toBe(true)
    expect(result.models).toContain('new-model')
    expect(fixture.resolveAuth).not.toHaveBeenCalled()
  })
})

it.each(['data', 'models'] as const)('keeps a successful global %s refresh in the shared catalog when an unrelated grant fails', async format => {
  fixture.fetch.mockImplementation(async () => Response.json(format === 'data' ? { data: [{ id: 'new-model' }] } : { models: [{ slug: 'new-model' }] }))
  await withProviderAccount(1, async () => {
    await importAccountProviders()
    await addBrokenOAuth()
    await refreshConfiguredProviderModelCatalogs({ force: true })
    expect(Object.values((await readProviderModelCatalogCache()).providers)).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'deepseek', models: ['new-model'], source: 'live' }),
    ]))
  })
})

it('uses the account Provider credential and protocol instead of its stale environment view', async () => {
  await withProviderAccount(1, async () => {
    await importAccountProviders()
    await updateConfigYamlForProfile('default', config => {
      Object.assign(config.providers.deepseek, { api_key: 'inline-key', api_mode: 'anthropic_messages' })
      delete config.providers.deepseek.key_env
      return config
    })
    expect(await resolveProviderCatalogRefreshTarget('default', 'deepseek')).toMatchObject({ api_key: 'inline-key', api_mode: 'anthropic_messages' })
    await refreshConfiguredProviderModelCatalogs({ force: true })
    expect(fixture.fetch.mock.calls[0][1].headers).toMatchObject({ 'x-api-key': 'inline-key' })
  })
})

it('clears inline builtin credentials from the account pool and keeps other accounts untouched', async () => {
  await withProviderAccount(1, async () => {
    await importAccountProviders()
    await updateConfigYamlForProfile('default', config => {
      Object.assign(config.providers.deepseek, { api_key: 'inline-key' })
      delete config.providers.deepseek.key_env
      return config
    })
    const ctx = { params: { poolKey: 'deepseek' }, state: { profile: { name: 'default' } }, query: {} } as any
    await remove(ctx)
    expect(ctx.body).toEqual({ success: true })
    const config = await readConfigYamlForProfile('work')
    expect(config.providers.deepseek).toBeUndefined()
    expect(config.model.provider).toBeUndefined()
    expect((await getAvailableModelGroupsForProfile('default')).some(group => group.provider === 'deepseek')).toBe(false)
  })
  await withProviderAccount(2, async () => {
    await importAccountProviders()
    expect((await getProviderEditorDetail('default', 'deepseek')).credential_configured).toBe(true)
  })
})

it('does not reuse stale run credentials or a legacy environment key after an editor clear', async () => {
  await withProviderAccount(1, async () => {
    await importAccountProviders()
    await updateConfigYamlForProfile('default', config => {
      config.providers.deepseek.api_key = 'inline-key'
      delete config.providers.deepseek.key_env
      return config
    })
    const before = await getProviderEditorDetail('default', 'deepseek')
    await updateProviderEditorDetail('default', 'deepseek', { credential_action: 'clear' }, before.revision)
    const runtime = await resolveEkkoProviderRuntimeConfig({ profile: 'work', provider: 'deepseek', apiKey: 'cached-run-key' })
    expect(runtime.apiKey).toBeUndefined()
  })
})

it.each(['replace', 'clear'] as const)('keeps a shared environment credential when an editor requests %s', async action => {
  await withProviderAccount(1, async () => {
    await importAccountProviders()
    await updateConfigYamlForProfile('default', config => {
      config.providers['custom:other'] = { name: 'Other DeepSeek', catalog_provider: 'custom:other', runtime_provider: 'deepseek', base_url: 'https://other.invalid/v1', key_env: 'DEEPSEEK_API_KEY', model: 'other-model' }
      return config
    })
    const before = await getProviderEditorDetail('default', 'deepseek')
    await updateProviderEditorDetail('default', 'deepseek', { credential_action: action, api_key: 'replacement-key' }, before.revision)
    expect((await resolveEkkoProviderRuntimeConfig({ profile: 'work', provider: 'custom:other' })).apiKey).toBe('account-key')
    expect((await resolveEkkoProviderRuntimeConfig({ profile: 'work', provider: 'deepseek' })).apiKey).toBe(action === 'replace' ? 'replacement-key' : undefined)
  })
})

it('deletes custom records by their stable identity after their display name changes', async () => {
  await withProviderAccount(1, async () => {
    await importAccountProviders()
    await updateConfigYamlForProfile('default', config => {
      config.providers['custom:relay'] = { name: 'Renamed Relay', catalog_provider: 'custom:relay', base_url: 'https://relay.invalid/v1', api_key: 'relay-secret', model: 'relay-model' }
      return config
    })
    const ctx = { params: { poolKey: 'custom:relay' }, state: { profile: { name: 'work' } }, query: {} } as any
    await remove(ctx)
    expect(ctx.body).toEqual({ success: true })
    expect((await readConfigYamlForProfile('default')).providers['custom:relay']).toBeUndefined()
    expect((await readConfigYamlForProfile('default')).providers.deepseek).toBeDefined()
  })
})

it('clears a scoped OAuth grant only after its last Provider reference is removed', async () => {
  await withProviderAccount(1, async () => {
    await importAccountProviders()
    const scope = 'a'.repeat(64)
    const dir = join(providerAccountHome(), 'credentials', scope)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'auth.json'), JSON.stringify({ providers: { nous: { agent_key: 'scoped-secret' }, unrelated: { access_token: 'keep' } }, credential_pool: { nous: [{ agent_key: 'scoped-secret' }] } }))
    await updateConfigYamlForProfile('default', config => {
      for (const id of ['nous', 'custom:shared-nous']) config.providers[id] = {
        name: id, catalog_provider: id, runtime_provider: 'nous', auth_provider: 'nous', auth_scope: scope, base_url: 'https://nous.invalid/v1', model: 'nous-model',
      }
      return config
    })
    const ctx = { params: { poolKey: 'nous' }, state: { profile: { name: 'work' } }, query: {} } as any
    await remove(ctx)
    expect(ctx.body).toEqual({ success: true })
    expect(JSON.parse(await readFile(join(dir, 'auth.json'), 'utf8')).providers.nous.agent_key).toBe('scoped-secret')
    ctx.params.poolKey = 'custom:shared-nous'
    await remove(ctx)
    expect(ctx.body).toEqual({ success: true })
    const auth = JSON.parse(await readFile(join(dir, 'auth.json'), 'utf8'))
    expect(auth.providers.nous).toBeUndefined()
    expect(auth.credential_pool.nous).toBeUndefined()
    expect(auth.providers.unrelated.access_token).toBe('keep')
  })
})

it('keeps an existing catalog when a global remote probe fails', async () => {
  await withProviderAccount(1, async () => {
    await importAccountProviders()
    await writeProviderModelCatalogEntry({ provider: 'deepseek', label: 'DeepSeek', base_url: 'https://api.deepseek.com', models: ['last-good'], source: 'live' })
    fixture.fetch.mockResolvedValue(new Response('', { status: 401 }))
    await refreshConfiguredProviderModelCatalogs({ force: true })
    expect(Object.values((await readProviderModelCatalogCache()).providers)).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'deepseek', models: ['last-good'], source: 'live' }),
    ]))
  })
})

it('keeps the account Copilot grant when removing a separate scoped Copilot record', async () => {
  await withProviderAccount(1, async () => {
    await importAccountProviders()
    const scope = 'b'.repeat(64)
    const dir = join(providerAccountHome(), 'credentials', scope)
    await mkdir(dir, { recursive: true })
    await writeFile(join(providerAccountHome(), '.env'), 'COPILOT_GITHUB_TOKEN=account-token\n')
    await writeFile(join(dir, '.env'), 'COPILOT_GITHUB_TOKEN=scoped-token\n')
    await updateConfigYamlForProfile('default', config => {
      config.providers['custom:other-copilot'] = { name: 'Other Copilot', catalog_provider: 'custom:other-copilot', runtime_provider: 'copilot', auth_provider: 'copilot', auth_scope: scope, base_url: 'https://api.githubcopilot.com', model: 'test-model' }
      return config
    })
    const ctx = { params: { poolKey: 'custom:other-copilot' }, state: { profile: { name: 'work' } }, query: {} } as any
    await remove(ctx)
    expect(ctx.body).toEqual({ success: true })
    expect(await readFile(join(providerAccountHome(), '.env'), 'utf8')).toContain('COPILOT_GITHUB_TOKEN=account-token')
    expect(await readFile(join(dir, '.env'), 'utf8')).not.toContain('scoped-token')
  })
})

it('updates pooled credentials through the released Provider update endpoint', async () => {
  await withProviderAccount(1, async () => {
    await importAccountProviders()
    await updateConfigYamlForProfile('default', config => {
      Object.assign(config.providers.deepseek, { api_key: 'inline-key' })
      delete config.providers.deepseek.key_env
      return config
    })
    const ctx = { params: { poolKey: 'deepseek' }, state: { profile: { name: 'default' } }, request: { body: { api_key: 'replacement-key' } } } as any
    await update(ctx)
    expect(ctx.body).toEqual({ success: true })
    expect((await readConfigYamlForProfile('work')).providers.deepseek.api_key).toBe('replacement-key')
  })
})

it.each(['data', 'models'] as const)('shows and restores an authoritative %s refreshed list and projects it back to Hermes', async format => {
  fixture.fetch.mockImplementation(async () => Response.json(format === 'data' ? { data: [{ id: 'new-model' }] } : { models: [{ slug: 'new-model' }] }))
  await withProviderAccount(1, async () => {
    await importAccountProviders()
    await updateConfigYamlForProfile('default', config => {
      config.providers.deepseek.models = { 'old-model': {}, 'removed-model': {} }
      return config
    })
    await synchronizeHermesProvider('default')
    const preview = await refreshProviderModels('default', 'deepseek')
    expect(preview.requires_confirmation).toBe(true)
    await refreshProviderModels('default', 'deepseek', { confirm: true })
    const models = (await getAvailableModelGroupsForProfile('work')).find(group => group.provider === 'deepseek')!.models
    expect(models).toContain('new-model')
    expect(models).not.toContain('removed-model')
    await synchronizeHermesProvider('default')
    expect(await readFile(join(source, 'default/config.yaml'), 'utf8')).toContain('new-model')
    await restoreProviderModels('work', 'deepseek')
    expect((await getAvailableModelGroupsForProfile('default')).find(group => group.provider === 'deepseek')!.models).toContain('removed-model')
  })
})

it('tests a Responses Provider draft against a CC-Switch catalog with its stored credential', async () => {
  await withProviderAccount(1, async () => {
    await importAccountProviders()
    fixture.fetch.mockImplementation(async () => Response.json({ models: [null, { slug: 'new-model' }, { slug: 'new-model' }] }))
    expect(await testProviderEditorDraft('default', 'deepseek', { api_mode: 'codex_responses' })).toEqual({ models: ['new-model'], model_count: 1 })
    expect(fixture.fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer account-key')
    expect(Object.values((await readProviderModelCatalogCache()).providers)).toEqual([])
  })
})

it.each([
  { label: 'OpenAI', body: { data: [{ id: 'z:free' }, { id: 'a:free' }, { id: 'paid' }, { id: 'a:free' }] }, models: ['a:free', 'z:free'] },
  { label: 'CC-Switch', body: { models: [null, {}, { slug: ' ' }, { slug: ' z:free ' }, { slug: 'a:free' }, { slug: 'paid' }, { slug: 'a:free' }] }, models: ['a:free', 'z:free'] },
  { label: 'data priority', body: { data: [{ id: 'a:free', slug: 'ignored:free' }], models: [{ slug: 'ignored:free' }] }, models: ['a:free'] },
  { label: 'non-array data fallback', body: { data: {}, models: [{ slug: 'a:free' }] }, models: ['a:free'] },
  { label: 'empty data priority', body: { data: [], models: [{ slug: 'ignored:free' }] }, models: [] },
])('manually fetches $label and saves the filtered catalog only when requested', async ({ body, models }) => {
  await withProviderAccount(1, async () => {
    await importAccountProviders()
    fixture.fetch.mockResolvedValue(Response.json(body))
    const ctx = { request: { body: { provider: 'custom:relay', label: 'Relay', base_url: 'https://relay.invalid/v1/', api_key: 'draft-key', freeOnly: true, update_cache: true } } } as any
    await fetchProviderModelList(ctx)
    expect(ctx.body).toEqual({ models })
    expect(fixture.fetch).toHaveBeenCalledWith('https://relay.invalid/v1/models', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer draft-key' }), signal: expect.any(AbortSignal),
    }))
    expect(Object.values((await readProviderModelCatalogCache()).providers)).toEqual([
      expect.objectContaining({ provider: 'custom:relay', label: 'Relay', models, source: 'live', free_only: true }),
    ])
  })
})

it('keeps manual fetches without cache opt-in read-only and supports an absent API key', async () => {
  await withProviderAccount(1, async () => {
    await importAccountProviders()
    fixture.fetch.mockImplementation(async () => Response.json({ models: [{ slug: 'new-model' }] }))
    const ctx = { request: { body: { provider: 'deepseek', base_url: 'https://relay.invalid' } } } as any
    await fetchProviderModelList(ctx)
    expect(ctx.body).toEqual({ models: ['new-model'] })
    expect(fixture.fetch.mock.calls[0][1].headers.Authorization).toBeUndefined()
    expect(Object.values((await readProviderModelCatalogCache()).providers)).toEqual([])
  })
})

it.each(['format', 'http', 'json', 'timeout'] as const)('keeps manual %s errors and the last-good cache', async failure => {
  await withProviderAccount(1, async () => {
    await importAccountProviders()
    await writeProviderModelCatalogEntry({ provider: 'deepseek', label: 'DeepSeek', base_url: 'https://api.deepseek.com', models: ['last-good'], source: 'live' })
    if (failure === 'timeout') fixture.fetch.mockRejectedValue(new DOMException('timed out', 'TimeoutError'))
    else fixture.fetch.mockResolvedValue(failure === 'http' ? new Response('', { status: 401 }) : failure === 'json' ? new Response('invalid JSON') : Response.json({ models: {} }))
    const ctx = { request: { body: { provider: 'deepseek', base_url: 'https://api.deepseek.com', update_cache: true } } } as any
    await fetchProviderModelList(ctx)
    expect(ctx.status).toBe(failure === 'timeout' ? 504 : 502)
    expect(ctx.body.error).toBeTypeOf('string')
    if (failure === 'format') expect(ctx.body.error).toBe('Provider returned unexpected format')
    if (failure === 'http') expect(ctx.body.error).toBe('Provider returned HTTP 401')
    expect(Object.values((await readProviderModelCatalogCache()).providers)).toEqual([
      expect.objectContaining({ models: ['last-good'], source: 'live' }),
    ])
  })
})

it.each([{ models: [] }, { models: {} }])('keeps the last-good catalog when CC-Switch refresh returns %j', async body => {
  await withProviderAccount(1, async () => {
    await importAccountProviders()
    await writeProviderModelCatalogEntry({ provider: 'deepseek', label: 'DeepSeek', base_url: 'https://api.deepseek.com', models: ['last-good'], source: 'live' })
    fixture.fetch.mockImplementation(async () => Response.json(body))
    await expect(refreshProviderModels('default', 'deepseek', { confirm: true })).rejects.toMatchObject({
      code: Array.isArray(body.models) ? 'PROVIDER_EMPTY_CATALOG' : 'PROVIDER_TEST_FAILED',
    })
    await refreshConfiguredProviderModelCatalogs({ force: true })
    expect(Object.values((await readProviderModelCatalogCache()).providers)).toEqual([
      expect.objectContaining({ models: ['last-good'], source: 'live' }),
    ])
  })
})
