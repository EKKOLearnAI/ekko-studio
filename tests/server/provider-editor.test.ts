import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import YAML from 'js-yaml'

let hermesHome = ''
let webUiHome = ''
let db: DatabaseSync | null = null
const originalHermesHome = process.env.HERMES_HOME
const originalWebUiHome = process.env.HERMES_WEB_UI_HOME

function profileDir(profile: string): string {
  return profile === 'default' ? hermesHome : join(hermesHome, 'profiles', profile)
}

function writeProfile(profile: string, config: string, env = '', auth: Record<string, unknown> = {}) {
  const dir = profileDir(profile)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.yaml'), config, 'utf8')
  writeFileSync(join(dir, '.env'), env, 'utf8')
  writeFileSync(join(dir, 'auth.json'), JSON.stringify(auth, null, 2) + '\n', 'utf8')
}

function readYaml(path: string): any {
  return YAML.load(readFileSync(path, 'utf8'))
}

async function loadEditor() {
  await import('../../packages/server/src/bootstrap/agent-profile-adapter')
  return import('../../packages/server/src/modules/hermes/services/providers/provider-editor')
}

beforeEach(() => {
  hermesHome = mkdtempSync(join(tmpdir(), 'provider-editor-hermes-'))
  webUiHome = mkdtempSync(join(tmpdir(), 'provider-editor-webui-'))
  process.env.HERMES_HOME = hermesHome
  process.env.HERMES_WEB_UI_HOME = webUiHome
  db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys=ON')
  vi.resetModules()
  vi.doMock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({
    getDb: () => db,
    getStoragePath: () => ':memory:',
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.doUnmock('../../packages/server/src/modules/studio/infrastructure/database/index')
  vi.resetModules()
  db?.close()
  db = null
  rmSync(hermesHome, { recursive: true, force: true })
  rmSync(webUiHome, { recursive: true, force: true })
  if (originalHermesHome === undefined) delete process.env.HERMES_HOME
  else process.env.HERMES_HOME = originalHermesHome
  if (originalWebUiHome === undefined) delete process.env.HERMES_WEB_UI_HOME
  else process.env.HERMES_WEB_UI_HOME = originalWebUiHome
})

describe('provider editor service', () => {
  it('persists, normalizes, and clears provider network settings without changing credentials', async () => {
    writeProfile('research', YAML.dump({
      providers: {
        example: { baseUrl: 'https://provider.example/v1', apiKey: 'existing-key', extra_body: { keep: true } },
      },
    }))
    const { getProviderEditorDetail, updateProviderEditorDetail } = await loadEditor()
    const before = await getProviderEditorDetail('research', 'custom:example')
    const { detail: changed } = await updateProviderEditorDetail('research', 'custom:example', {
      preserve_client_identity: true,
      proxy_url: 'localhost:8080',
      extra_headers: { 'User-Agent': 'configured-client' },
    }, before.revision)
    expect(changed).toMatchObject({
      preserve_client_identity: true, proxy_url: 'http://localhost:8080',
      extra_headers: { 'user-agent': 'configured-client' },
    })
    expect(readYaml(join(profileDir('research'), 'config.yaml')).providers.example).toMatchObject({
      apiKey: 'existing-key', extra_body: { keep: true },
      preserve_client_identity: true, proxy_url: 'http://localhost:8080',
    })
    const { detail: cleared } = await updateProviderEditorDetail('research', 'custom:example', {
      preserve_client_identity: false, proxy_url: null, extra_headers: null,
    }, changed.revision)
    expect(cleared.preserve_client_identity).toBe(false)
    expect(cleared.proxy_url).toBeUndefined()
    expect(cleared.extra_headers).toBeUndefined()
  })

  it.each([
    { extra_headers: { 'Bad Header': 'value' } },
    { extra_headers: { Authorization: 'replacement' } },
    { proxy_url: 'http://user:private-password@proxy.example/path' },
    { preserve_client_identity: 'true' },
  ])('rejects invalid network settings without writing configuration: %j', async patch => {
    writeProfile('research', YAML.dump({
      custom_providers: [{ name: 'example', base_url: 'https://provider.example', api_key: 'existing-key' }],
    }))
    const path = join(profileDir('research'), 'config.yaml')
    const original = readFileSync(path, 'utf8')
    const { getProviderEditorDetail, updateProviderEditorDetail } = await loadEditor()
    const before = await getProviderEditorDetail('research', 'custom:example')
    await expect(updateProviderEditorDetail('research', 'custom:example', {
      ...patch,
    } as any, before.revision)).rejects.toMatchObject({ status: 400 })
    expect(readFileSync(path, 'utf8')).toBe(original)
  })

  it('uses draft extra headers for catalog tests and does not persist them', async () => {
    writeProfile('research', YAML.dump({
      custom_providers: [{
        name: 'example', base_url: 'https://provider.example/v1', api_key: 'existing-key',
        extra_headers: { 'User-Agent': 'saved-client' },
      }],
    }))
    const path = join(profileDir('research'), 'config.yaml')
    const original = readFileSync(path, 'utf8')
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ data: [{ id: 'model-a' }] }))
    vi.stubGlobal('fetch', fetchMock)
    const { testProviderEditorDraft } = await loadEditor()
    await testProviderEditorDraft('research', 'custom:example', { extra_headers: { 'User-Agent': 'draft-client' } })
    expect(new Headers(fetchMock.mock.calls[0][1].headers).get('user-agent')).toBe('draft-client')
    expect(new Headers(fetchMock.mock.calls[0][1].headers).get('authorization')).toBe('Bearer existing-key')
    expect(readFileSync(path, 'utf8')).toBe(original)
  })

  it('keeps the OpenCode probe affinity header across same-origin redirects', async () => {
    const { fetchProviderCatalogForTest } = await loadEditor()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 307, headers: { location: '/zen/go/v1/models/' } }))
      .mockResolvedValueOnce(Response.json({ data: [{ id: 'glm-5' }] }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await fetchProviderCatalogForTest('https://opencode.ai/zen/go/v1', 'test-key')).toEqual(['glm-5'])
    const headers = fetchMock.mock.calls.map(([, init]) => new Headers(init.headers))
    expect(headers[0].get('x-opencode-session')).toMatch(/^[a-f0-9]{64}$/)
    expect(headers[1].get('x-opencode-session')).toBe(headers[0].get('x-opencode-session'))
    expect(headers[1].get('authorization')).toBe('Bearer test-key')
  })

  it('returns capability metadata without exposing the stored credential', async () => {
    const storedCredential = ['stored', 'credential'].join('-')
    writeProfile('research', [
      'model:',
      '  provider: custom:research-proxy',
      '  default: active-model',
      'custom_providers:',
      '  - name: research-proxy',
      '    base_url: https://old.example/v1',
      `    api_key: ${storedCredential}`,
      '    api_mode: chat_completions',
      '    model: preferred-old',
      '',
    ].join('\n'))

    const { getProviderEditorDetail } = await loadEditor()
    const detail = await getProviderEditorDetail('research', 'custom:research-proxy')

    expect(detail.id).toBe('custom:research-proxy')
    expect(detail.credential_configured).toBe(true)
    expect(detail.editable_fields).toEqual([
      'label',
      'base_url',
      'api_key',
      'api_mode',
      'preferred_model',
      'context_lengths',
      'discover_models',
      'rate_limit_delay',
      'request_timeout_seconds',
      'stale_timeout_seconds',
      'extra_body',
      'extra_headers',
      'preserve_client_identity',
      'proxy_url',
    ])
    expect(JSON.stringify(detail)).not.toContain(storedCredential)
    expect(detail.revision).toMatch(/^[a-f0-9]{64}$/)
  })

  it('rejects embedded credentials in provider base URLs', async () => {
    writeProfile('research', [
      'model:',
      '  provider: custom:url-check',
      '  default: model-a',
      'custom_providers:',
      '  - name: url-check',
      '    base_url: https://models.example/v1',
      '    api_key: existing-credential',
      '    model: model-a',
      '',
    ].join('\n'))

    const { getProviderEditorDetail, updateProviderEditorDetail } = await loadEditor()
    const before = await getProviderEditorDetail('research', 'custom:url-check')
    await expect(updateProviderEditorDetail('research', 'custom:url-check', {
      base_url: 'https://username:password@models.example/v1',
    }, before.revision)).rejects.toMatchObject({ status: 400, code: 'INVALID_BASE_URL' })
  })

  it('updates a legacy custom provider without changing its identity or profile default', async () => {
    const oldCredential = ['old', 'credential'].join('-')
    const replacement = ['replacement', 'credential'].join('-')
    writeProfile('default', [
      'model:',
      '  provider: custom:research-proxy',
      '  default: keep-default',
      'custom_providers:',
      '  - name: research-proxy',
      '    base_url: https://default.example/v1',
      `    api_key: ${oldCredential}`,
      '    model: keep-default',
      '',
    ].join('\n'))
    writeProfile('research', [
      'model:',
      '  provider: custom:research-proxy',
      '  default: keep-active',
      'custom_providers:',
      '  - name: research-proxy',
      '    base_url: https://old.example/v1',
      `    api_key: ${oldCredential}`,
      '    api_mode: chat_completions',
      '    model: old-preferred',
      '',
    ].join('\n'))

    const { getProviderEditorDetail, updateProviderEditorDetail } = await loadEditor()
    const before = await getProviderEditorDetail('research', 'custom:research-proxy')
    const result = await updateProviderEditorDetail('research', 'custom:research-proxy', {
      label: 'Research Display',
      base_url: 'https://new.example/v1/',
      api_mode: 'codex_responses',
      preferred_model: 'manual-model',
      discover_models: true,
      rate_limit_delay: 1.5,
      request_timeout_seconds: 120,
      stale_timeout_seconds: 300,
      extra_body: { routing: { tier: 'fast' } },
      credential_action: 'replace',
      api_key: replacement,
    }, before.revision)

    const research = readYaml(join(profileDir('research'), 'config.yaml'))
    expect(research.model).toEqual({ provider: 'custom:research-proxy', default: 'keep-active' })
    expect(research.custom_providers[0]).toMatchObject({
      name: 'research-proxy',
      base_url: 'https://new.example/v1',
      api_mode: 'codex_responses',
      model: 'manual-model',
      api_key: replacement,
      discover_models: true,
      rate_limit_delay: 1.5,
      request_timeout_seconds: 120,
      stale_timeout_seconds: 300,
      extra_body: { routing: { tier: 'fast' } },
    })
    expect(readYaml(join(profileDir('default'), 'config.yaml')).custom_providers[0].base_url)
      .toBe('https://default.example/v1')

    const appConfig = JSON.parse(readFileSync(join(webUiHome, 'config.json'), 'utf8'))
    expect(appConfig.providerLabels.research['custom:research-proxy']).toBe('Research Display')
    expect(appConfig.providerPreferredModels.research['custom:research-proxy']).toBe('manual-model')

    const authText = readFileSync(join(profileDir('research'), 'auth.json'), 'utf8')
    expect(authText).not.toContain(replacement)
    const auth = JSON.parse(authText)
    expect(auth.credential_pool['custom:research-proxy'][0]).toMatchObject({
      auth_type: 'api_key',
      base_url: 'https://new.example/v1',
      source: 'config:research-proxy',
    })
    expect(auth.credential_pool['custom:research-proxy'][0].secret_fingerprint).toMatch(/^sha256:/)
    expect(result.detail.label).toBe('Research Display')
    expect(result.detail.revision).not.toBe(before.revision)
  })

  it('preserves providers-dict aliases while editing a dict-backed provider', async () => {
    const existing = ['dict', 'credential'].join('-')
    const replacement = ['dict', 'replacement'].join('-')
    writeProfile('research', [
      'model:',
      '  provider: custom:volcengine-coding',
      '  default: keep-active',
      'providers:',
      '  volcengine-coding:',
      '    api: https://old.example/api/coding/v3',
      '    key_env: ARK_CODING_API_KEY',
      '    transport: chat_completions',
      '    default_model: old-model',
      '    models:',
      '      - old-model',
      '',
    ].join('\n'), `ARK_CODING_API_KEY=${existing}\n`)

    const { getProviderEditorDetail, updateProviderEditorDetail } = await loadEditor()
    const before = await getProviderEditorDetail('research', 'custom:volcengine-coding')
    await updateProviderEditorDetail('research', 'custom:volcengine-coding', {
      base_url: 'https://new.example/api/coding/v3',
      api_mode: 'codex_responses',
      preferred_model: 'new-model',
      credential_action: 'replace',
      api_key: replacement,
    }, before.revision)

    const config = readYaml(join(profileDir('research'), 'config.yaml'))
    const provider = config.providers['volcengine-coding']
    expect(provider.api).toBe('https://new.example/api/coding/v3')
    expect(provider.transport).toBe('codex_responses')
    expect(provider.default_model).toBe('new-model')
    expect(provider.base_url).toBeUndefined()
    expect(provider.api_mode).toBeUndefined()
    expect(config.model).toEqual({ provider: 'custom:volcengine-coding', default: 'keep-active' })
    expect(readFileSync(join(profileDir('research'), '.env'), 'utf8')).toContain(`ARK_CODING_API_KEY=${replacement}`)
  })

  it('updates an API-key built-in provider in only the request-scoped profile', async () => {
    const defaultCredential = ['default', 'credential'].join('-')
    const oldCredential = ['research', 'old'].join('-')
    const replacement = ['research', 'new'].join('-')
    writeProfile('default', 'model:\n  provider: deepseek\n  default: keep-default\n', `DEEPSEEK_API_KEY=${defaultCredential}\n`)
    writeProfile('research', 'model:\n  provider: deepseek\n  default: keep-research\n', `DEEPSEEK_API_KEY=${oldCredential}\n`)

    const { getProviderEditorDetail, updateProviderEditorDetail } = await loadEditor()
    const before = await getProviderEditorDetail('research', 'deepseek')
    expect(before.editable_fields).toContain('base_url')
    expect(before.editable_fields).not.toContain('api_mode')

    const result = await updateProviderEditorDetail('research', 'deepseek', {
      label: 'Research DeepSeek',
      base_url: 'http://127.0.0.1:8080/v1',
      preferred_model: 'deepseek-reasoner',
      credential_action: 'replace',
      api_key: replacement,
    }, before.revision)

    const researchEnv = readFileSync(join(profileDir('research'), '.env'), 'utf8')
    expect(researchEnv).toContain(`DEEPSEEK_API_KEY=${replacement}`)
    expect(researchEnv).toContain('DEEPSEEK_BASE_URL=http://127.0.0.1:8080/v1')
    expect(readFileSync(join(profileDir('default'), '.env'), 'utf8')).toContain(`DEEPSEEK_API_KEY=${defaultCredential}`)
    expect(readYaml(join(profileDir('research'), 'config.yaml')).model)
      .toEqual({ provider: 'deepseek', default: 'keep-research' })
    expect(result.detail.label).toBe('Research DeepSeek')
    expect(result.detail.preferred_model).toBe('deepseek-reasoner')
  })

  it('clears a credential without deleting the provider and rejects a stale revision', async () => {
    const existing = ['clear', 'credential'].join('-')
    writeProfile('research', [
      'model:',
      '  provider: custom:clearable',
      '  default: keep-model',
      'custom_providers:',
      '  - name: clearable',
      '    base_url: https://clear.example/v1',
      `    api_key: ${existing}`,
      '    model: keep-model',
      '',
    ].join('\n'))

    const { getProviderEditorDetail, updateProviderEditorDetail, ProviderEditorError } = await loadEditor()
    const before = await getProviderEditorDetail('research', 'custom:clearable')
    const cleared = await updateProviderEditorDetail('research', 'custom:clearable', {
      credential_action: 'clear',
    }, before.revision)

    expect(cleared.detail.credential_configured).toBe(false)
    const config = readYaml(join(profileDir('research'), 'config.yaml'))
    expect(config.custom_providers).toHaveLength(1)
    expect(config.custom_providers[0].api_key).toBeUndefined()

    await expect(updateProviderEditorDetail('research', 'custom:clearable', {
      label: 'stale edit',
    }, before.revision)).rejects.toMatchObject<Partial<InstanceType<typeof ProviderEditorError>>>({
      status: 412,
      code: 'REVISION_CONFLICT',
    })
  })

  it('stores context overrides by profile and model without switching defaults', async () => {
    const credential = ['context', 'credential'].join('-')
    const config = [
      'model:',
      '  provider: custom:contextual',
      '  default: keep-active',
      'custom_providers:',
      '  - name: contextual',
      '    base_url: https://context.example/v1',
      `    api_key: ${credential}`,
      '    model: model-a',
      '',
    ].join('\n')
    writeProfile('default', config)
    writeProfile('research', config)

    const { getProviderEditorDetail, updateProviderContextLengths } = await loadEditor()
    const before = await getProviderEditorDetail('research', 'custom:contextual')
    const updated = await updateProviderContextLengths('research', 'custom:contextual', {
      'model-a': 128000,
      'model-b': 64000,
    }, before.revision)

    expect(updated.detail.context_lengths).toEqual({ 'model-a': 128000, 'model-b': 64000 })
    expect((await getProviderEditorDetail('default', 'custom:contextual')).context_lengths).toEqual({})
    expect(readYaml(join(profileDir('research'), 'config.yaml')).model.default).toBe('keep-active')

    const removed = await updateProviderContextLengths('research', 'custom:contextual', {
      'model-b': null,
    }, updated.detail.revision)
    expect(removed.detail.context_lengths).toEqual({ 'model-a': 128000 })
  })

  it('serializes concurrent context updates and rejects the stale revision', async () => {
    const credential = ['race', 'credential'].join('-')
    writeProfile('research', [
      'model:',
      '  provider: custom:context-race',
      '  default: model-a',
      'custom_providers:',
      '  - name: context-race',
      '    base_url: https://context-race.example/v1',
      `    api_key: ${credential}`,
      '    model: model-a',
      '',
    ].join('\n'))

    const { getProviderEditorDetail, updateProviderContextLengths } = await loadEditor()
    const before = await getProviderEditorDetail('research', 'custom:context-race')
    const outcomes = await Promise.allSettled([
      updateProviderContextLengths('research', 'custom:context-race', { 'model-a': 128000 }, before.revision),
      updateProviderContextLengths('research', 'custom:context-race', { 'model-b': 64000 }, before.revision),
    ])

    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1)
    const rejected = outcomes.find(outcome => outcome.status === 'rejected') as PromiseRejectedResult
    expect(rejected.reason).toMatchObject({ status: 412, code: 'REVISION_CONFLICT' })
    expect(Object.keys((await getProviderEditorDetail('research', 'custom:context-race')).context_lengths)).toHaveLength(1)
  })

  it('tests an unsaved draft and rejects a cross-origin credential redirect', async () => {
    const credential = ['test', 'credential'].join('-')
    writeProfile('research', [
      'model:',
      '  provider: custom:testable',
      '  default: old-model',
      'custom_providers:',
      '  - name: testable',
      '    base_url: https://models.example/v1',
      `    api_key: ${credential}`,
      '    model: old-model',
      '',
    ].join('\n'))

    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [{ id: 'model-a' }, { id: 'model-b' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const { testProviderEditorDraft, ProviderEditorError } = await loadEditor()

    const result = await testProviderEditorDraft('research', 'custom:testable', {
      base_url: 'https://draft.example/v1',
    })
    expect(result).toEqual({ models: ['model-a', 'model-b'], model_count: 2 })
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://draft.example/v1/models')

    fetchMock.mockResolvedValueOnce(new Response(null, {
      status: 302,
      headers: { location: 'https://redirect-attacker.example/models' },
    }))
    await expect(testProviderEditorDraft('research', 'custom:testable', {}))
      .rejects.toMatchObject<Partial<InstanceType<typeof ProviderEditorError>>>({
        status: 422,
        code: 'PROVIDER_REDIRECT_REJECTED',
      })
  })

  it('reports a missing model catalog as its own outcome rather than a failed connection', async () => {
    const credential = ['catalog', 'credential'].join('-')
    writeProfile('research', [
      'model:',
      '  provider: custom:nocatalog',
      '  default: glm-5.2',
      'custom_providers:',
      '  - name: nocatalog',
      '    base_url: https://plan.example/v3',
      `    api_key: ${credential}`,
      '    model: glm-5.2',
      '',
    ].join('\n'))

    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { testProviderEditorDraft, ProviderEditorError } = await loadEditor()

    // Token-plan endpoints answer the catalog probe with 404 or 405 while the
    // chat path they exist for works fine.
    for (const status of [404, 405]) {
      fetchMock.mockResolvedValueOnce(new Response('not found', { status }))
      await expect(testProviderEditorDraft('research', 'custom:nocatalog', {}))
        .resolves.toEqual({ models: [], model_count: 0, catalog_unavailable: true })
    }

    // Anything else is still a failure, so a broken provider cannot pass.
    fetchMock.mockResolvedValueOnce(new Response('boom', { status: 500 }))
    await expect(testProviderEditorDraft('research', 'custom:nocatalog', {}))
      .rejects.toMatchObject<Partial<InstanceType<typeof ProviderEditorError>>>({
        status: 422,
        code: 'PROVIDER_TEST_FAILED',
      })

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    await expect(testProviderEditorDraft('research', 'custom:nocatalog', {}))
      .rejects.toMatchObject<Partial<InstanceType<typeof ProviderEditorError>>>({
        code: 'PROVIDER_EMPTY_CATALOG',
      })
  })

  it('marks unsupported API modes as unavailable for draft connection tests', async () => {
    const credential = ['bedrock', 'credential'].join('-')
    writeProfile('research', [
      'model:',
      '  provider: custom:bedrock',
      '  default: model-a',
      'custom_providers:',
      '  - name: bedrock',
      '    base_url: https://bedrock.example',
      `    api_key: ${credential}`,
      '    api_mode: bedrock_converse',
      '    model: model-a',
      '',
    ].join('\n'))

    const { getProviderEditorDetail, testProviderEditorDraft, ProviderEditorError } = await loadEditor()
    const detail = await getProviderEditorDetail('research', 'custom:bedrock')
    expect(detail.connection_test_supported).toBe(false)
    expect(detail.connection_test_reason).toContain('bedrock_converse')
    await expect(testProviderEditorDraft('research', 'custom:bedrock', {}))
      .rejects.toMatchObject<Partial<InstanceType<typeof ProviderEditorError>>>({
        status: 422,
        code: 'PROVIDER_TEST_UNSUPPORTED',
      })
  })
})
