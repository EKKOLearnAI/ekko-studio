import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import YAML from 'js-yaml'

const fixture = vi.hoisted(() => ({ home: '', enabled: true }))
vi.mock('../../packages/server/src/modules/studio/public/config', () => ({ config: { get appHome() { return fixture.home }, port: 18648 } }))
vi.mock('../../packages/server/src/modules/studio/repositories/users-store', () => ({
  findUserById: (id: number | string) => fixture.enabled ? { id: Number(id), status: 'active' } : null,
  getDefaultProfileForUser: () => 'default',
  listUsers: () => [{ id: 1, status: 'active', profiles: ['default', 'work'] }, { id: 2, status: 'active', profiles: ['default'] }],
}))

import { providerAccountHome, providerCredentialDir, configureProviderSources, importAccountProviders, internalModelCredential, authenticateInternalModelCredential, providerProfileDir, withProviderAccount } from '../../packages/server/src/modules/studio/public/provider-account'
import { providerRouteNamespace, qualifyModelRoute, splitModelRoute, logicalModelSelection } from '../../packages/server/src/modules/studio/public/model-routing'
vi.mock('../../packages/server/src/modules/studio/public/app-config', () => ({ readAppConfig: async () => ({}), providerDisplayLabel: (_config: any, _profile: string, _provider: string, label: string) => label, invalidateAppConfigCache: () => {} }))
import { configureProviderProjection, synchronizeHermesProvider, hermesGatewaySelection } from '../../packages/server/src/modules/studio/public/provider-projection'
import { updateSupplementalConfig, supplementalConfigForDisplay } from '../../packages/server/src/modules/studio/services/providers/supplemental-routing'
import { readConfigYamlForProfile, updateConfigYamlForProfile, readAppConfig, writeAppConfig } from '../../packages/server/src/modules/studio/public/provider-config'
import { configureAuthorizedProviderRuntime } from '../../packages/server/src/modules/studio/public/authorized-provider-runtime'
import { resolveEkkoProviderRuntimeConfig } from '../../packages/server/src/modules/ekko/services/provider-runtime'
import { saveModelTarget, savedModelTargets } from '../../packages/server/src/modules/studio/public/model-target-store'
import { getProviderEditorDetail, updateProviderEditorDetail } from '../../packages/server/src/modules/hermes/services/providers/provider-editor'
import { resolveBridgeRunModelConfig } from '../../packages/server/src/modules/studio/services/chat-run/model-config'
import { legacyProviderCredentials } from '../../packages/server/src/modules/studio/middleware/legacy-provider-credentials'
import { LEGACY_PROVIDER_CREDENTIAL } from '../../packages/server/src/modules/studio/contracts/legacy-provider-credential'

let source: string
beforeEach(async () => {
  fixture.home = await mkdtemp(join(tmpdir(), 'studio-provider-store-'))
  fixture.enabled = true
  source = join(fixture.home, 'legacy')
  for (const profile of ['default', 'work']) {
    const dir = join(source, profile)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'config.yaml'), YAML.dump({
      model: { provider: 'deepseek', default: 'family/model', temperature: 0.7 },
      agent: { max_turns: 32 }, mcp_servers: { kept: { command: 'node' } },
      custom_providers: [{ name: 'relay', base_url: 'https://relay.invalid/v1', key_env: 'RELAY_KEY' }],
    }))
    await writeFile(join(dir, '.env'), 'DEEPSEEK_API_KEY=legacy-key\nRELAY_KEY=relay-key\nTOOL_SECRET=keep-tool-secret\n')
    await writeFile(join(dir, 'auth.json'), JSON.stringify({ providers: { 'openai-codex': { tokens: { access_token: 'private-token' } } }, unrelated: 'kept' }))
  }
  configureProviderSources({ profileDir: profile => join(source, profile), profiles: userId => userId === 1 ? ['work', 'default'] : ['default'], environmentKeys: ['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL'], environmentMap: { deepseek: { api_key_env: 'DEEPSEEK_API_KEY', base_url_env: 'DEEPSEEK_BASE_URL' } } })
  configureProviderProjection(async () => [{ provider: 'deepseek', models: ['family/model'] }])
})
afterEach(async () => { await rm(fixture.home, { recursive: true, force: true }) })

it('keeps stored credentials and model defaults when an old client echoes the readiness marker during an edit', async () => {
  await withProviderAccount(1, async () => {
    await importAccountProviders()
    const home = providerAccountHome()
    const credentials = await readFile(join(home, '.env'), 'utf8')
    const model = (await readConfigYamlForProfile('work')).model
    const detail = await getProviderEditorDetail('work', 'deepseek')
    const ctx = { method: 'PATCH', path: '/api/hermes/config/providers/deepseek/editor',
      request: { body: { api_key: LEGACY_PROVIDER_CREDENTIAL, credential_action: 'replace', label: 'Renamed DeepSeek' } } } as any
    await legacyProviderCredentials(ctx, async () => {
      const result = await updateProviderEditorDetail('work', 'deepseek', ctx.request.body, detail.revision)
      expect(result.detail.credential_configured).toBe(true)
      expect(result.changed).not.toContain('api_key_replaced')
    })
    expect(await readFile(join(home, '.env'), 'utf8')).toBe(credentials)
    expect((await readConfigYamlForProfile('work')).model).toEqual(model)
    expect((await resolveEkkoProviderRuntimeConfig({ profile: 'work', provider: 'deepseek' })).apiKey).toBe('legacy-key')
  })
})

it('imports every accessible Profile once, keeps only provider state and preserves private backups', async () => {
  await withProviderAccount(1, async () => {
    await Promise.all([importAccountProviders(), importAccountProviders()])
    const dir = providerProfileDir('work')
    const cfg = YAML.load(await readFile(join(dir, 'config.yaml'), 'utf8')) as any
    expect(cfg.model.default).toBe('family/model')
    expect(cfg.agent).toBeUndefined()
    expect(await readFile(join(providerAccountHome(), '.env'), 'utf8')).toContain('RELAY_KEY=relay-key')
    expect(await readFile(join(providerAccountHome(), '.env'), 'utf8')).not.toContain('TOOL_SECRET')
    expect(JSON.parse(await readFile(join(dir, 'source-backup.json'), 'utf8')).config).toContain('mcp_servers')
    expect((await stat(join(providerAccountHome(), 'auth.json'))).mode & 0o777).toBe(0o600)
    await writeFile(join(providerAccountHome(), '.env'), 'DEEPSEEK_API_KEY=studio-edited\n')
    await importAccountProviders()
    expect(await readFile(join(providerAccountHome(), '.env'), 'utf8')).toBe('DEEPSEEK_API_KEY=studio-edited\n')
  })
})

it('isolates two users sharing a Profile and rejects inaccessible Profiles', async () => {
  let firstDir = ''
  await withProviderAccount(1, async () => { await importAccountProviders(); firstDir = providerAccountHome(); await writeFile(join(firstDir, '.env'), 'edited-by-one') })
  await withProviderAccount(2, async () => {
    await importAccountProviders()
    expect(providerAccountHome()).not.toBe(firstDir)
    expect(await readFile(join(providerAccountHome(), '.env'), 'utf8')).toContain('legacy-key')
    expect(() => providerProfileDir('work')).toThrow('not accessible')
  })
})

it('allocates persistent collision-safe routes and strips only the outer namespace', async () => {
  await withProviderAccount(1, async () => {
    await importAccountProviders()
    expect(await providerRouteNamespace('default', 'deepseek')).toBe('deepseek')
    const other = await providerRouteNamespace('work', 'deepseek')
    expect(other).toBe('deepseek')
    expect(await providerRouteNamespace('work', 'deepseek')).toBe(other)
    expect(logicalModelSelection('work', 'ekkostudio', qualifyModelRoute(other, 'vendor/family/model'))).toEqual({ provider: 'deepseek', model: 'vendor/family/model' })
    expect(logicalModelSelection('default', 'ekkostudio', `${other}/model`)).toEqual({ provider: 'deepseek', model: 'model' })
    expect(splitModelRoute(qualifyModelRoute('custom:a/b%2F', 'vendor/model'))).toEqual({ namespace: 'custom:a/b%2F', model: 'vendor/model' })
  })
})

it('retains legacy custom-prefixed Provider selections when an import uses the builtin identity', async () => {
  const path = join(source, 'default/config.yaml')
  const config = YAML.load(await readFile(path, 'utf8')) as any
  config.custom_providers.push({ name: 'fun-codex', base_url: 'https://relay.invalid/v1', api_key: 'fixture-key', api_mode: 'codex_responses' })
  await writeFile(path, YAML.dump(config))
  await withProviderAccount(1, async () => {
    await importAccountProviders()
    expect(await providerRouteNamespace('default', 'custom:fun-codex')).toBe(await providerRouteNamespace('default', 'fun-codex'))
    expect(logicalModelSelection('default', 'ekkostudio', 'fun-codex/vendor/model')).toEqual({ provider: 'fun-codex', model: 'vendor/model' })
    const storedSession = { sessionProvider: 'custom:fun-codex', sessionModel: 'vendor/model' }
    expect(await resolveBridgeRunModelConfig({ profile: 'default', ...storedSession,
      modelGroups: [{ provider: 'fun-codex', models: ['vendor/model'] }] })).toEqual({ provider: 'fun-codex', model: 'vendor/model' })
    expect(storedSession.sessionProvider).toBe('custom:fun-codex')
  })
})

it('upgrades draft duplicate identities and keeps both logical and gateway session selections usable', async () => {
  await withProviderAccount(1, async () => {
    await importAccountProviders()
    const home = providerAccountHome()
    const config = await readConfigYamlForProfile('default')
    const oldId = 'custom:deepseek-1234567890'
    config.providers[oldId] = { ...config.providers.deepseek, catalog_provider: oldId, name: 'DeepSeek 2', api_key: 'discarded-key' }
    config.custom_providers = [{ name: 'DeepSeek', base_url: 'https://discarded.invalid', api_key: 'legacy-duplicate' },
      { name: 'unique', base_url: 'https://unique.invalid', api_key: 'unique-key' }]
    await writeFile(join(home, 'config.yaml'), YAML.dump(config))
    const state = JSON.parse(await readFile(join(home, 'pool.json'), 'utf8'))
    state.version = 2
    state.imports.work.deepseek = oldId
    await rm(join(home, 'pool-v2-backup.json'))
    await writeFile(join(home, 'pool.json'), JSON.stringify(state))
    await writeFile(join(home, 'routes.json'), JSON.stringify({ 'deepseek@old': { provider: oldId } }))
    await writeFile(join(providerProfileDir('work'), 'config.yaml'), YAML.dump({ model: { provider: oldId, default: 'family/model' } }))
    await importAccountProviders()
    expect(Object.keys((await readConfigYamlForProfile('work')).providers).filter(id => id.includes('deepseek'))).toEqual(['deepseek'])
    expect((await readConfigYamlForProfile('work')).custom_providers).toBeUndefined()
    expect((await resolveEkkoProviderRuntimeConfig({ profile: 'work', provider: 'custom:unique' })).apiKey).toBe('unique-key')
    for (const [provider, model] of [[oldId, 'family/model'], ['ekkostudio', 'deepseek@old/family/model'], ['deepseek', 'family/model']]) {
      expect(await resolveBridgeRunModelConfig({ profile: 'work', sessionProvider: provider, sessionModel: model,
        modelGroups: [{ provider: 'deepseek', models: ['family/model'] }] })).toEqual({ provider: 'deepseek', model: 'family/model' })
    }
    expect((await resolveEkkoProviderRuntimeConfig({ profile: 'work', provider: oldId, apiKey: 'stale-key', baseUrl: 'https://discarded.invalid' })).apiKey).toBe('legacy-key')
    expect((await readConfigYamlForProfile('work')).model.provider).toBe('deepseek')
    expect(await readFile(join(home, 'config.yaml'), 'utf8')).not.toContain('discarded-key')
    expect(await readFile(join(home, 'pool-v2-backup.json'), 'utf8')).toContain('discarded-key')
    expect(JSON.parse(await readFile(join(home, 'pool.json'), 'utf8')).aliases[oldId]).toBe('deepseek')
  })
})

it('rejects duplicate names and display labels atomically, including concurrent creation', async () => {
  await withProviderAccount(1, async () => {
    await importAccountProviders()
    const home = providerAccountHome()
    const before = await readFile(join(home, 'config.yaml'), 'utf8')
    await expect(updateConfigYamlForProfile('work', config => {
      config.custom_providers = [{ name: '  DEEPSEEK  ', base_url: 'https://other.invalid', api_key: 'other-key' }]
      return config
    })).rejects.toMatchObject({ status: 409 })
    expect(await readFile(join(home, 'config.yaml'), 'utf8')).toBe(before)
    await expect(writeAppConfig({ providerLabels: { work: { deepseek: 'relay' } } })).rejects.toMatchObject({ status: 409 })
    const detail = await getProviderEditorDetail('work', 'deepseek')
    await expect(updateProviderEditorDetail('work', 'deepseek', { label: ' RELAY ' }, detail.revision)).rejects.toMatchObject({ status: 409 })
    const results = await Promise.allSettled(['one', 'two'].map(id => updateConfigYamlForProfile('default', config => {
      config.providers[id] = { name: 'Same Name', base_url: 'https://fixture.invalid' }
      return config
    })))
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
  })
})

it('retains inline primary credentials during migration', async () => {
  await writeFile(join(source, 'default/config.yaml'), YAML.dump({ model: {
    provider: 'anthropic', default: 'claude-sonnet', base_url: 'https://fixture.services.ai.azure.com/anthropic', api_key: 'inline-fixture-key',
  } }))
  await withProviderAccount(1, async () => {
    await importAccountProviders()
    expect(await resolveEkkoProviderRuntimeConfig({ profile: 'default', provider: 'anthropic' })).toMatchObject({
      apiKey: 'inline-fixture-key', baseUrl: 'https://fixture.services.ai.azure.com/anthropic',
    })
    expect((await readConfigYamlForProfile('default')).model.api_key).toBeUndefined()
  })
})

it('preserves separate credentials for differently named Providers that use the same environment key', async () => {
  const path = join(source, 'work/config.yaml')
  const config = YAML.load(await readFile(path, 'utf8')) as any
  config.custom_providers = [{ name: 'relay-two', base_url: 'https://second.invalid/v1', key_env: 'RELAY_KEY' }]
  await writeFile(path, YAML.dump(config))
  await writeFile(join(source, 'work/.env'), 'DEEPSEEK_API_KEY=legacy-key\nRELAY_KEY=second-key\n')
  await withProviderAccount(1, async () => {
    await importAccountProviders()
    expect((await resolveEkkoProviderRuntimeConfig({ profile: 'work', provider: 'custom:relay' })).apiKey).toBe('relay-key')
    expect((await resolveEkkoProviderRuntimeConfig({ profile: 'default', provider: 'custom:relay-two' })).apiKey).toBe('second-key')
  })
})

it('keeps an inline credential editable when the imported entry also names an environment key', async () => {
  const path = join(source, 'default/config.yaml')
  const config = YAML.load(await readFile(path, 'utf8')) as any
  config.custom_providers[0].api_key = 'inline-key'
  await writeFile(path, YAML.dump(config))
  await withProviderAccount(1, async () => {
    await importAccountProviders()
    expect((await readConfigYamlForProfile('default')).providers['custom:relay'].key_env).toBeUndefined()
    const detail = await getProviderEditorDetail('default', 'custom:relay')
    await updateProviderEditorDetail('default', 'custom:relay', { credential_action: 'replace', api_key: 'replacement-key' }, detail.revision)
    expect((await resolveEkkoProviderRuntimeConfig({ profile: 'default', provider: 'custom:relay' })).apiKey).toBe('replacement-key')
  })
})

it('projects only a gateway into Hermes while preserving unrelated configuration and backing up upstream credentials', async () => {
  await withProviderAccount(1, async () => {
    await importAccountProviders()
    await synchronizeHermesProvider('default')
    const projected = YAML.load(await readFile(join(source, 'default/config.yaml'), 'utf8')) as any
    expect(Object.keys(projected.providers)).toEqual(['ekkostudio'])
    expect(projected.model).toMatchObject({ provider: 'ekkostudio', default: 'deepseek/family/model', temperature: 0.7 })
    expect(projected.mcp_servers.kept.command).toBe('node')
    expect(projected.agent.max_turns).toBe(32)
    expect(projected.custom_providers).toBeUndefined()
    expect(await readFile(join(source, 'default/.env'), 'utf8')).toContain('TOOL_SECRET=keep-tool-secret')
    expect(await readFile(join(source, 'default/.env'), 'utf8')).not.toContain('legacy-key')
    expect(JSON.parse(await readFile(join(source, 'default/auth.json'), 'utf8'))).toEqual({ unrelated: 'kept' })
    expect(await readFile(join(providerAccountHome(), 'auth.json'), 'utf8')).toContain('private-token')
  })
  // A later account imports the pre-migration snapshot, not ekkostudio itself.
  await withProviderAccount(2, async () => {
    await importAccountProviders()
    expect(await readFile(join(providerProfileDir('default'), 'config.yaml'), 'utf8')).toContain('provider: deepseek')
    expect(await readFile(join(providerAccountHome(), '.env'), 'utf8')).toContain('legacy-key')
  })
})

it('issues user-bound automatic credentials and pins bridge credentials independently of the physical Profile', async () => {
  const one = await withProviderAccount(1, async () => { await importAccountProviders(); return internalModelCredential('default') })
  const two = await withProviderAccount(2, async () => { await importAccountProviders(); await synchronizeHermesProvider('default'); return internalModelCredential('default') })
  expect(one.token).not.toBe(two.token)
  expect((await withProviderAccount(1, () => internalModelCredential('work'))).token).toBe(one.token)
  expect(await authenticateInternalModelCredential(one.token)).toMatchObject({ userId: 1 })
  expect(await authenticateInternalModelCredential('studio_model_invalid')).toBeNull()
  const selection = await withProviderAccount(1, () => hermesGatewaySelection('default', 'deepseek', 'family/model'))
  expect(selection.gateway_runtime?.api_key).toBe(one.token)
  expect(selection.model).toBe('deepseek/family/model')
  fixture.enabled = false
  expect(await authenticateInternalModelCredential(one.token)).toBeNull()
})

it('does not change a source Profile or persist a poisoned snapshot when import validation fails', async () => {
  const path = join(source, 'default/config.yaml')
  await writeFile(path, 'model: [broken')
  await withProviderAccount(1, async () => {
    await expect(importAccountProviders()).rejects.toThrow()
    expect(await readFile(path, 'utf8')).toBe('model: [broken')
    await writeFile(path, 'model: {provider: deepseek, default: repaired}\n')
    await importAccountProviders()
    expect(await readFile(join(providerProfileDir('default'), 'config.yaml'), 'utf8')).toContain('repaired')
  })
})

it('keeps existing auxiliary, MoA, fallback and delegation routes and their native credentials during import', async () => {
  const path = join(source, 'default/config.yaml')
  const original = YAML.load(await readFile(path, 'utf8')) as any
  Object.assign(original, {
    providers: { relay: { base_url: 'https://relay.invalid/v1', api_key: 'legacy-inline-key' } },
    auxiliary: { vision: { provider: 'relay', model: 'old-vision', timeout: 120 }, compression: { provider: 'deepseek', model: 'old-compression' } },
    moa: { presets: { original: { reference_models: [{ provider: 'relay', model: 'old-reference' }], aggregator: { provider: 'deepseek', model: 'old-aggregator' } } } },
    fallback_providers: [{ provider: 'deepseek', model: 'old-fallback' }],
    delegation: { provider: 'relay', model: 'old-delegate', enabled: true },
  })
  await writeFile(path, YAML.dump(original))
  await writeFile(join(source, 'default/.anthropic_oauth.json'), '{"access_token":"legacy-sidecar"}')
  const environment = await readFile(join(source, 'default/.env'), 'utf8')
  const auth = await readFile(join(source, 'default/auth.json'), 'utf8')
  await withProviderAccount(1, async () => {
    await importAccountProviders()
    await synchronizeHermesProvider('default')
    const projected = YAML.load(await readFile(path, 'utf8')) as any
    expect(projected.model.provider).toBe('ekkostudio')
    for (const section of ['auxiliary', 'moa', 'fallback_providers', 'delegation', 'custom_providers']) expect(projected[section]).toEqual(original[section])
    expect(projected.providers.relay).toEqual(original.providers.relay)
    expect(await readFile(join(source, 'default/.env'), 'utf8')).toBe(environment)
    expect(await readFile(join(source, 'default/auth.json'), 'utf8')).toBe(auth)
    expect(await readFile(join(source, 'default/.anthropic_oauth.json'), 'utf8')).toContain('legacy-sidecar')
  })
})

it('switches only the auxiliary slot the user edits and displays its original logical names', async () => {
  const path = join(source, 'default/config.yaml')
  const original = YAML.load(await readFile(path, 'utf8')) as any
  original.auxiliary = { vision: { provider: 'deepseek', model: 'old-vision', timeout: 120 }, compression: { provider: 'relay', model: 'old-compression' } }
  await writeFile(path, YAML.dump(original))
  await withProviderAccount(1, async () => {
    await importAccountProviders()
    await synchronizeHermesProvider('default')
    // The page submits every task; only the changed task should migrate.
    await updateSupplementalConfig('default', 'auxiliary', current => ({ ...current, vision: { ...current.vision, model: 'family/model' } }))
    await synchronizeHermesProvider('default')
    const projected = YAML.load(await readFile(path, 'utf8')) as any
    expect(projected.auxiliary.vision).toMatchObject({ provider: 'ekkostudio', model: 'deepseek/family/model', timeout: 120, api_key: expect.stringMatching(/^studio_model_/) })
    expect(projected.auxiliary.compression).toEqual(original.auxiliary.compression)
    expect(projected.custom_providers).toEqual(original.custom_providers)
    const owned = YAML.load(await readFile(join(providerProfileDir('default'), 'config.yaml'), 'utf8')) as any
    const display = await supplementalConfigForDisplay('default', owned)
    expect(display.auxiliary.vision).toEqual({ provider: 'deepseek', model: 'family/model', timeout: 120 })
    // Unmanaged settings continue to reflect subsequent native Hermes edits.
    projected.auxiliary.compression.timeout = 456
    await writeFile(path, YAML.dump(projected))
    expect((await supplementalConfigForDisplay('default', owned)).auxiliary.compression.timeout).toBe(456)
    await updateSupplementalConfig('default', 'auxiliary', current => ({ ...current, vision: { provider: 'auto', timeout: 200 } }))
    await synchronizeHermesProvider('default')
    expect((YAML.load(await readFile(path, 'utf8')) as any).auxiliary.vision).toEqual({ provider: 'auto', timeout: 200 })
  })
})

it('does not migrate unchanged slots on save and preserves fallback deletions', async () => {
  const path = join(source, 'default/config.yaml')
  const original = YAML.load(await readFile(path, 'utf8')) as any
  original.auxiliary = { vision: { provider: 'deepseek', model: 'old' } }
  original.fallback_providers = [{ provider: 'deepseek', model: 'first' }, { provider: 'relay', model: 'second' }]
  await writeFile(path, YAML.dump(original))
  await withProviderAccount(1, async () => {
    await importAccountProviders()
    await synchronizeHermesProvider('default')
    await updateSupplementalConfig('default', 'auxiliary', current => current)
    await updateSupplementalConfig('default', 'fallback_providers', current => current.slice(0, 1))
    await synchronizeHermesProvider('default')
    const projected = YAML.load(await readFile(path, 'utf8')) as any
    expect(projected.auxiliary).toEqual(original.auxiliary)
    expect(projected.fallback_providers).toEqual([original.fallback_providers[0]])
    await updateSupplementalConfig('default', 'fallback_providers', () => undefined)
    await synchronizeHermesProvider('default')
    expect((YAML.load(await readFile(path, 'utf8')) as any).fallback_providers).toBeUndefined()
  })
})

it('persists native CLI bindings per user without copying upstream secrets', async () => {
  await withProviderAccount(1, async () => {
    await importAccountProviders()
    await saveModelTarget('codex_responses', { profile: 'default', provider: 'deepseek', model: 'family/model', apiKey: 'do-not-copy' } as any, 'hwui_fixture')
    expect(await savedModelTargets()).toEqual([expect.objectContaining({ ownerUserId: 1, token: 'hwui_fixture' })])
    expect(JSON.stringify(await savedModelTargets())).not.toContain('do-not-copy')
  })
  await withProviderAccount(2, async () => { await importAccountProviders(); expect(await savedModelTargets()).toEqual([]) })
})

it('shares Provider edits and credentials across Profiles of one account while retaining their model selections', async () => {
  await withProviderAccount(1, async () => {
    await importAccountProviders()
    const first = await readConfigYamlForProfile('default')
    const second = await readConfigYamlForProfile('work')
    expect(first.providers).toEqual(second.providers)
    expect(Object.values(first.providers).filter((provider: any) => provider.runtime_provider === 'deepseek')).toHaveLength(1)
    await updateConfigYamlForProfile('work', config => {
      config.providers.deepseek.base_url = 'https://edited.invalid/v1'
      config.model = { provider: 'deepseek', default: 'work-model' }
      return config
    })
    expect((await readConfigYamlForProfile('default')).providers.deepseek.base_url).toBe('https://edited.invalid/v1')
    expect((await readConfigYamlForProfile('default')).model.default).toBe('family/model')
    expect((await readConfigYamlForProfile('work')).model.default).toBe('work-model')
    await expect(readFile(join(providerProfileDir('work'), '.env'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await internalModelCredential('work')).token).toBe((await internalModelCredential('default')).token)
  })
})

it('keeps the default Provider when endpoints or credentials conflict', async () => {
  await writeFile(join(source, 'work/.env'), 'DEEPSEEK_API_KEY=work-key\nDEEPSEEK_BASE_URL=https://work.invalid/v1\nRELAY_KEY=relay-key\n')
  await withProviderAccount(1, async () => {
    await importAccountProviders()
    const first = await readConfigYamlForProfile('default')
    const second = await readConfigYamlForProfile('work')
    const entries = Object.entries(first.providers).filter(([, entry]: any) => entry.runtime_provider === 'deepseek') as Array<[string, any]>
    expect(entries).toHaveLength(1)
    expect(entries[0][0]).toBe('deepseek')
    expect(entries[0][1].name).toBe('DeepSeek')
    expect(second.providers).toEqual(first.providers)
    expect(second.model.provider).toBe('deepseek')
    const resolved = await resolveEkkoProviderRuntimeConfig({ profile: 'work', provider: 'deepseek', model: 'family/model' })
    expect(resolved.apiKey).toBe('legacy-key')
    expect(resolved.baseUrl).not.toBe('https://work.invalid/v1')
    expect(await readFile(join(providerAccountHome(), 'profile-import-backups.json'), 'utf8')).toContain('work-key')
  })
})

it('keeps only the first OAuth grant and backs up the discarded grant', async () => {
  await writeFile(join(source, 'work/auth.json'), JSON.stringify({ providers: { 'openai-codex': { tokens: { access_token: 'work-oauth' } } } }))
  await withProviderAccount(1, async () => {
    await importAccountProviders()
    const config = await readConfigYamlForProfile('work')
    const entries = Object.entries(config.providers).filter(([, entry]: any) => entry.auth_provider === 'openai-codex') as Array<[string, any]>
    expect(entries).toHaveLength(1)
    for (const [, entry] of entries) {
      expect(entry.api_mode).toBe('codex_responses')
      expect(Object.keys(entry.models || {})).toEqual([])
    }
    expect(entries[0][1].auth_scope).toBeUndefined()
    expect(await readFile(join(providerAccountHome(), 'profile-import-backups.json'), 'utf8')).toContain('work-oauth')
    configureAuthorizedProviderRuntime({
      isAuthorizedRuntimeProvider: provider => provider === 'openai-codex',
      resolveAuthorizedProviderRuntimeCredentials: async input => {
        expect(input.provider).toBe('openai-codex')
        const auth = JSON.parse(await readFile(join(providerCredentialDir(input.credentialScope), 'auth.json'), 'utf8'))
        return { provider: input.provider, apiKey: auth.providers['openai-codex'].tokens.access_token, baseUrl: 'https://chatgpt.com/backend-api/codex', apiMode: 'codex_responses' }
      },
    })
    expect((await resolveEkkoProviderRuntimeConfig({ profile: 'default', provider: 'openai-codex' })).apiKey).toBe('private-token')
    expect((await resolveEkkoProviderRuntimeConfig({ profile: 'work', provider: 'openai-codex' })).apiKey).toBe('private-token')
  })
})

it('shares labels and preferred models when users edit them from another Profile', async () => {
  await withProviderAccount(1, async () => {
    await importAccountProviders()
    await writeAppConfig({ providerLabels: { work: { deepseek: 'Shared label' } }, providerPreferredModels: { work: { deepseek: 'family/model' } } })
    const view = await readAppConfig()
    expect(view.providerLabels?.default?.deepseek).toBe('Shared label')
    expect(view.providerPreferredModels?.default?.deepseek).toBe('family/model')
    await writeAppConfig({ providerLabels: { ...view.providerLabels, default: { deepseek: 'Renamed globally' } } })
    expect((await readAppConfig()).providerLabels?.work?.deepseek).toBe('Renamed globally')
    expect(JSON.parse(await readFile(join(providerAccountHome(), 'display.json'), 'utf8')).providerLabels).toEqual({ account: { deepseek: 'Renamed globally' } })
  })
})

it('edits merged Provider identities and preferences from any Profile without creating a second copy', async () => {
  await writeFile(join(source, 'work/.env'), 'DEEPSEEK_API_KEY=work-key\n')
  await withProviderAccount(1, async () => {
    await importAccountProviders()
    const config = await readConfigYamlForProfile('default')
    expect(Object.keys(config.providers).filter(id => id.includes('deepseek'))).toEqual(['deepseek'])
    const id = 'deepseek'
    const before = await getProviderEditorDetail('work', id)
    expect(before.credential_configured).toBe(true)
    await updateProviderEditorDetail('work', id, { label: 'Shared provider', preferred_model: 'new/model', credential_action: 'replace', api_key: 'edited-account-key' }, before.revision)
    const after = await getProviderEditorDetail('default', id)
    expect(after).toMatchObject({ label: 'Shared provider', preferred_model: 'new/model', credential_configured: true })
    expect((await resolveEkkoProviderRuntimeConfig({ profile: 'default', provider: id })).apiKey).toBe('edited-account-key')
    const primary = await getProviderEditorDetail('work', 'deepseek')
    await updateProviderEditorDetail('work', 'deepseek', { base_url: 'https://edited.invalid/v1' }, primary.revision)
    expect((await resolveEkkoProviderRuntimeConfig({ profile: 'default', provider: 'deepseek' })).baseUrl).toBe('https://edited.invalid/v1')
  })
})

it('upgrades an already imported account without losing edited credentials or breaking issued keys', async () => {
  await withProviderAccount(1, async () => {
    const token = 'studio_model_' + 'a'.repeat(43)
    for (const profile of ['default', 'work']) {
      const dir = providerProfileDir(profile)
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'import.json'), JSON.stringify({ version: 1, profile }))
      await writeFile(join(dir, 'config.yaml'), 'model: {provider: deepseek, default: family/model}\n')
      await writeFile(join(dir, '.env'), `DEEPSEEK_API_KEY=${profile}-edited\n`)
      await writeFile(join(dir, 'auth.json'), '{}')
      await writeFile(join(dir, 'source-backup.json'), JSON.stringify({ config: await readFile(join(source, profile, 'config.yaml'), 'utf8'), env: 'DEEPSEEK_API_KEY=original\n', auth: '{}' }))
    }
    await writeFile(join(providerProfileDir('default'), 'gateway-credential.json'), JSON.stringify({ userId: 1, profile: 'default', token }))
    await writeFile(join(providerAccountHome(), 'routes.json'), JSON.stringify({ 'deepseek@old': { profile: 'work', provider: 'deepseek' } }))
    await writeFile(join(providerAccountHome(), 'catalog.json'), JSON.stringify({ version: 1, providers: { 'profile:account:1:work|deepseek|https://api.deepseek.com/v1|all': { provider: 'deepseek', profiles: ['work'], base_url: 'https://api.deepseek.com/v1', models: ['live-only-model'], updated_at: '2026-11-16T00:00:00Z' } } }))
    await importAccountProviders()
    const shared = await readConfigYamlForProfile('default')
    expect(Object.values(shared.providers).filter((entry: any) => entry.runtime_provider === 'deepseek')).toHaveLength(1)
    expect(await readFile(join(providerAccountHome(), '.env'), 'utf8')).toContain('default-edited')
    expect(await authenticateInternalModelCredential(token)).toMatchObject({ userId: 1 })
    const route = JSON.parse(await readFile(join(providerAccountHome(), 'routes.json'), 'utf8'))['deepseek@old']
    expect(route.profile).toBeUndefined()
    expect(route.provider).toBe('deepseek')
    expect(Object.values(JSON.parse(await readFile(join(providerAccountHome(), 'catalog.json'), 'utf8')).providers)).toEqual(expect.arrayContaining([expect.objectContaining({ provider: route.provider, models: ['live-only-model'] })]))
    expect(await readFile(join(providerAccountHome(), 'profile-import-backups.json'), 'utf8')).toContain('work-edited')
    await writeFile(join(providerAccountHome(), '.env'), 'DEEPSEEK_API_KEY=after-upgrade\n')
    await importAccountProviders()
    expect(await readFile(join(providerAccountHome(), '.env'), 'utf8')).toBe('DEEPSEEK_API_KEY=after-upgrade\n')
  })
})
