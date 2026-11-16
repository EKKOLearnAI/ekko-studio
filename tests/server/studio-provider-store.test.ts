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
  configureProviderSources({ profileDir: profile => join(source, profile), profiles: userId => userId === 1 ? ['default', 'work'] : ['default'], environmentKeys: ['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL'], environmentMap: { deepseek: { api_key_env: 'DEEPSEEK_API_KEY', base_url_env: 'DEEPSEEK_BASE_URL' } } })
  configureProviderProjection(async () => [{ provider: 'deepseek', models: ['family/model'] }])
})
afterEach(async () => { await rm(fixture.home, { recursive: true, force: true }) })

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

it('keeps conflicting Provider configurations as separately selectable account Providers', async () => {
  await writeFile(join(source, 'work/.env'), 'DEEPSEEK_API_KEY=work-key\nDEEPSEEK_BASE_URL=https://work.invalid/v1\nRELAY_KEY=relay-key\n')
  await withProviderAccount(1, async () => {
    await importAccountProviders()
    const first = await readConfigYamlForProfile('default')
    const second = await readConfigYamlForProfile('work')
    const entries = Object.entries(first.providers).filter(([, entry]: any) => entry.runtime_provider === 'deepseek') as Array<[string, any]>
    expect(entries).toHaveLength(2)
    const extra = entries.find(([id]) => id !== 'deepseek')!
    expect(extra[0]).toMatch(/^custom:deepseek-/)
    expect(extra[1]).toMatchObject({ api_key: 'work-key', base_url: 'https://work.invalid/v1', name: 'DeepSeek 2' })
    expect(second.providers).toEqual(first.providers)
    expect(second.model.provider).toBe(extra[0])
    const resolved = await resolveEkkoProviderRuntimeConfig({ profile: 'default', provider: extra[0], model: 'family/model' })
    expect(resolved).toMatchObject({ apiKey: 'work-key', baseUrl: 'https://work.invalid/v1' })
  })
})

it('keeps conflicting OAuth grants in account-owned Provider credential slots', async () => {
  await writeFile(join(source, 'work/auth.json'), JSON.stringify({ providers: { 'openai-codex': { tokens: { access_token: 'work-oauth' } } } }))
  await withProviderAccount(1, async () => {
    await importAccountProviders()
    const config = await readConfigYamlForProfile('work')
    const entries = Object.entries(config.providers).filter(([, entry]: any) => entry.auth_provider === 'openai-codex') as Array<[string, any]>
    expect(entries).toHaveLength(2)
    for (const [, entry] of entries) {
      expect(entry.api_mode).toBe('codex_responses')
      expect(Object.keys(entry.models || {})).toEqual([])
    }
    const extra = entries.find(([, entry]) => entry.auth_scope)!
    expect(providerCredentialDir(extra[1].auth_scope)).not.toContain('/profiles/')
    configureAuthorizedProviderRuntime({
      isAuthorizedRuntimeProvider: provider => provider === 'openai-codex',
      resolveAuthorizedProviderRuntimeCredentials: async input => {
        expect(input.provider).toBe('openai-codex')
        const auth = JSON.parse(await readFile(join(providerCredentialDir(input.credentialScope), 'auth.json'), 'utf8'))
        return { provider: input.provider, apiKey: auth.providers['openai-codex'].tokens.access_token, baseUrl: 'https://chatgpt.com/backend-api/codex', apiMode: 'codex_responses' }
      },
    })
    expect((await resolveEkkoProviderRuntimeConfig({ profile: 'default', provider: extra[0] })).apiKey).toBe('work-oauth')
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
    const id = Object.keys(config.providers).find(id => id.startsWith('custom:deepseek-'))!
    const before = await getProviderEditorDetail('work', id)
    expect(before.credential_configured).toBe(true)
    await updateProviderEditorDetail('work', id, { label: 'Shared second provider', preferred_model: 'new/model', credential_action: 'replace', api_key: 'edited-account-key' }, before.revision)
    const after = await getProviderEditorDetail('default', id)
    expect(after).toMatchObject({ label: 'Shared second provider', preferred_model: 'new/model', credential_configured: true })
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
    expect(Object.values(shared.providers).filter((entry: any) => entry.runtime_provider === 'deepseek')).toHaveLength(2)
    expect(await readFile(join(providerAccountHome(), '.env'), 'utf8')).toContain('default-edited')
    expect(await authenticateInternalModelCredential(token)).toMatchObject({ userId: 1 })
    const route = JSON.parse(await readFile(join(providerAccountHome(), 'routes.json'), 'utf8'))['deepseek@old']
    expect(route.profile).toBeUndefined()
    expect(route.provider).toMatch(/^custom:deepseek-/)
    expect(Object.values(JSON.parse(await readFile(join(providerAccountHome(), 'catalog.json'), 'utf8')).providers)).toEqual(expect.arrayContaining([expect.objectContaining({ provider: route.provider, models: ['live-only-model'] })]))
    expect(await readFile(join(providerAccountHome(), 'profile-import-backups.json'), 'utf8')).toContain('work-edited')
    await writeFile(join(providerAccountHome(), '.env'), 'DEEPSEEK_API_KEY=after-upgrade\n')
    await importAccountProviders()
    expect(await readFile(join(providerAccountHome(), '.env'), 'utf8')).toBe('DEEPSEEK_API_KEY=after-upgrade\n')
  })
})
