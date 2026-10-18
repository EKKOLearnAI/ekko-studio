import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import YAML from 'js-yaml'

const mockInvalidateProviderRuntime = vi.hoisted(() => vi.fn())

vi.mock('../../packages/server/src/modules/hermes/services/runtime/cli', () => ({
  restartGateway: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../packages/server/src/modules/studio/public/provider-runtime', () => ({
  invalidateProviderRuntime: mockInvalidateProviderRuntime,
}))

let hermesHome = ''

async function loadProvidersController() {
  vi.resetModules()
  process.env.HERMES_HOME = hermesHome
  await import('../../packages/server/src/bootstrap/agent-profile-adapter')
  return import('../../packages/server/src/modules/hermes/controllers/providers')
}

function makeCtx(poolKey: string, overrides: Record<string, any> = {}) {
  return {
    params: { poolKey: encodeURIComponent(poolKey) },
    request: { body: {} },
    status: 200,
    body: undefined as unknown,
    ...overrides,
  }
}

function readAuth(profileDir = hermesHome) {
  return JSON.parse(readFileSync(join(profileDir, 'auth.json'), 'utf-8'))
}

function readYaml(filePath: string) {
  return YAML.load(readFileSync(filePath, 'utf-8')) as any
}

describe('providers controller delete', () => {
  beforeEach(() => {
    mockInvalidateProviderRuntime.mockReset()
    hermesHome = mkdtempSync(join(tmpdir(), 'hwui-provider-delete-'))
    mkdirSync(hermesHome, { recursive: true })
    writeFileSync(join(hermesHome, 'config.yaml'), 'model:\n  provider: openai-codex\n  default: gpt-5.5\n')
  })

  afterEach(() => {
    delete process.env.HERMES_HOME
    vi.doUnmock('../../packages/server/src/modules/hermes/controllers/providers')
    vi.clearAllMocks()
    if (hermesHome) rmSync(hermesHome, { recursive: true, force: true })
    hermesHome = ''
  })

  it('removes built-in API-key provider credentials from env and auth pool', async () => {
    writeFileSync(join(hermesHome, '.env'), [
      ['DEEPSEEK_API_KEY', 'deepseek-placeholder'].join('='),
      ['DEEPSEEK_BASE_URL', 'https://deepseek-proxy.invalid/v1'].join('='),
      ['OPENROUTER_API_KEY', 'openrouter-placeholder'].join('='),
      ['OPENROUTER_BASE_URL', 'https://openrouter-proxy.invalid/v1'].join('='),
      '',
    ].join('\n'))
    writeFileSync(join(hermesHome, 'auth.json'), JSON.stringify({
      providers: {
        deepseek: { access_token: 'legacy-token' },
        openrouter: { access_token: 'keep-token' },
      },
      credential_pool: {
        deepseek: [{ label: 'DEEPSEEK_API_KEY', source: 'env:DEEPSEEK_API_KEY' }],
        openrouter: [{ label: 'OPENROUTER_API_KEY', source: 'env:OPENROUTER_API_KEY' }],
      },
    }, null, 2))

    const { remove } = await loadProvidersController()
    const ctx = makeCtx('deepseek')

    await remove(ctx)

    expect(ctx.body).toEqual({ success: true })
    const envAfter = readFileSync(join(hermesHome, '.env'), 'utf-8')
    expect(envAfter).not.toContain('DEEPSEEK_API_KEY')
    expect(envAfter).not.toContain('DEEPSEEK_BASE_URL')
    expect(envAfter).toContain(['OPENROUTER_API_KEY', 'openrouter-placeholder'].join('='))
    expect(envAfter).toContain(['OPENROUTER_BASE_URL', 'https://openrouter-proxy.invalid/v1'].join('='))

    const authAfter = readAuth()
    expect(authAfter.providers).not.toHaveProperty('deepseek')
    expect(authAfter.credential_pool).not.toHaveProperty('deepseek')
    expect(authAfter.providers.openrouter).toEqual({ access_token: 'keep-token' })
    expect(authAfter.credential_pool.openrouter).toEqual([
      { label: 'OPENROUTER_API_KEY', source: 'env:OPENROUTER_API_KEY' },
    ])
    expect(mockInvalidateProviderRuntime).toHaveBeenCalledWith('default', 'deepseek')
  })

  it('does not invalidate a runtime when a custom provider removal is rejected', async () => {
    const { remove } = await loadProvidersController()
    const ctx = makeCtx('custom:missing-provider')

    await remove(ctx)

    expect(ctx.status).toBe(404)
    expect(mockInvalidateProviderRuntime).not.toHaveBeenCalled()
  })

  it('does not remove unrelated base URL env for a provider without a base URL env mapping', async () => {
    writeFileSync(join(hermesHome, '.env'), [
      ['XAI_BASE_URL', 'https://xai-proxy.invalid/v1'].join('='),
      ['DEEPSEEK_BASE_URL', 'https://deepseek-proxy.invalid/v1'].join('='),
      '',
    ].join('\n'))

    const { remove } = await loadProvidersController()
    const ctx = makeCtx('xai-oauth')

    await remove(ctx)

    expect(ctx.body).toEqual({ success: true })
    const envAfter = readFileSync(join(hermesHome, '.env'), 'utf-8')
    expect(envAfter).toContain(['XAI_BASE_URL', 'https://xai-proxy.invalid/v1'].join('='))
    expect(envAfter).toContain(['DEEPSEEK_BASE_URL', 'https://deepseek-proxy.invalid/v1'].join('='))
  })

  it('removes custom provider config and any matching stored auth entry', async () => {
    writeFileSync(join(hermesHome, 'config.yaml'), [
      'model:',
      '  provider: openai-codex',
      '  default: gpt-5.5',
      'custom_providers:',
      '  - name: deepseek-proxy',
      '    base_url: https://example.invalid/v1',
      '    api_key: placeholder',
      '    model: deepseek-chat',
      '  - name: keep-provider',
      '    base_url: https://keep.invalid/v1',
      '    api_key: placeholder',
      '    model: keep-model',
      '',
    ].join('\n'))
    writeFileSync(join(hermesHome, 'auth.json'), JSON.stringify({
      credential_pool: {
        'custom:deepseek-proxy': [{ label: 'custom' }],
        'custom:keep-provider': [{ label: 'keep' }],
      },
    }, null, 2))

    const { remove } = await loadProvidersController()
    const ctx = makeCtx('custom:deepseek-proxy')

    await remove(ctx)

    expect(ctx.body).toEqual({ success: true })
    const configAfter = readFileSync(join(hermesHome, 'config.yaml'), 'utf-8')
    expect(configAfter).not.toContain('deepseek-proxy')
    expect(configAfter).toContain('keep-provider')

    const authAfter = readAuth()
    expect(authAfter.credential_pool).not.toHaveProperty('custom:deepseek-proxy')
    expect(authAfter.credential_pool['custom:keep-provider']).toEqual([{ label: 'keep' }])
  })

  it('preserves provider-independent model settings when removing the last provider', async () => {
    writeFileSync(join(hermesHome, 'config.yaml'), [
      'model:',
      '  provider: custom:deepseek-proxy',
      '  default: deepseek-chat',
      '  context_length: 256000',
      'custom_providers:',
      '  - name: deepseek-proxy',
      '    base_url: https://example.invalid/v1',
      '    api_key: placeholder',
      '    model: deepseek-chat',
      '',
    ].join('\n'))

    const { remove } = await loadProvidersController()
    await remove(makeCtx('custom:deepseek-proxy'))

    expect(readYaml(join(hermesHome, 'config.yaml')).model).toEqual({ context_length: 256000 })
  })

  it('removes v12 providers dict entries when requested by source', async () => {
    writeFileSync(join(hermesHome, 'config.yaml'), [
      'model:',
      '  provider: custom:dict-provider',
      '  default: dict-model',
      'providers:',
      '  dict-provider:',
      '    api: https://dict.invalid/v1',
      '    api_key: dict-key',
      '    default_model: dict-model',
      '  keep-provider:',
      '    api: https://keep.invalid/v1',
      '    default_model: keep-model',
      '',
    ].join('\n'))
    writeFileSync(join(hermesHome, 'auth.json'), JSON.stringify({
      credential_pool: {
        'custom:dict-provider': [{ label: 'dict' }],
        'custom:keep-provider': [{ label: 'keep' }],
      },
    }, null, 2))

    const { remove } = await loadProvidersController()
    const ctx = makeCtx('custom:dict-provider', {
      query: { source: 'providers', providerKey: 'dict-provider' },
    })

    await remove(ctx)

    expect(ctx.body).toEqual({ success: true })
    const configAfter = readYaml(join(hermesHome, 'config.yaml'))
    expect(configAfter.providers).not.toHaveProperty('dict-provider')
    expect(configAfter.providers).toHaveProperty('keep-provider')
    expect(configAfter.model).toEqual({
      provider: 'custom:keep-provider',
      default: 'keep-model',
    })

    const authAfter = readAuth()
    expect(authAfter.credential_pool).not.toHaveProperty('custom:dict-provider')
    expect(authAfter.credential_pool['custom:keep-provider']).toEqual([{ label: 'keep' }])
  })

  it('uses provider source to delete one side when legacy and dict providers share a name', async () => {
    writeFileSync(join(hermesHome, 'config.yaml'), [
      'model:',
      '  provider: custom:shared',
      '  default: legacy-model',
      'custom_providers:',
      '  - name: shared',
      '    base_url: https://legacy.invalid/v1',
      '    api_key: legacy-key',
      '    model: legacy-model',
      'providers:',
      '  shared:',
      '    api: https://dict.invalid/v1',
      '    api_key: dict-key',
      '    default_model: dict-model',
      '',
    ].join('\n'))

    const { remove } = await loadProvidersController()
    const ctx = makeCtx('custom:shared', {
      query: { source: 'providers', providerKey: 'shared' },
    })

    await remove(ctx)

    expect(ctx.body).toEqual({ success: true })
    const configAfter = readYaml(join(hermesHome, 'config.yaml'))
    expect(configAfter.providers).not.toHaveProperty('shared')
    expect(configAfter.custom_providers).toHaveLength(1)
    expect(configAfter.custom_providers[0].name).toBe('shared')
  })

  it('keeps OAuth-style provider deletion clearing stored auth entries', async () => {
    writeFileSync(join(hermesHome, 'auth.json'), JSON.stringify({
      providers: {
        'openai-codex': { account_id: 'remove-me' },
        copilot: { account_id: 'keep-me' },
      },
      credential_pool: {
        'openai-codex': [{ label: 'remove-me' }],
        copilot: [{ label: 'keep-me' }],
      },
    }, null, 2))

    const { remove } = await loadProvidersController()
    const ctx = makeCtx('openai-codex')

    await remove(ctx)

    expect(ctx.body).toEqual({ success: true })
    const authAfter = readAuth()
    expect(authAfter.providers).not.toHaveProperty('openai-codex')
    expect(authAfter.credential_pool).not.toHaveProperty('openai-codex')
    expect(authAfter.providers.copilot).toEqual({ account_id: 'keep-me' })
    expect(authAfter.credential_pool.copilot).toEqual([{ label: 'keep-me' }])
  })

  it('does not create auth.json when deleting a provider without stored auth credentials', async () => {
    writeFileSync(join(hermesHome, '.env'), [['DEEPSEEK_API_KEY', 'deepseek-placeholder'].join('='), ''].join('\n'))

    const { remove } = await loadProvidersController()
    const ctx = makeCtx('deepseek')

    await remove(ctx)

    expect(ctx.body).toEqual({ success: true })
    expect(existsSync(join(hermesHome, 'auth.json'))).toBe(false)
  })

  it('deletes provider state from the request-scoped profile only', async () => {
    const researchDir = join(hermesHome, 'profiles', 'research')
    mkdirSync(researchDir, { recursive: true })
    writeFileSync(join(hermesHome, 'config.yaml'), [
      'model:',
      '  provider: deepseek',
      '  default: keep-default-model',
      '',
    ].join('\n'))
    writeFileSync(join(hermesHome, '.env'), [
      ['DEEPSEEK_API_KEY', 'keep-default-key'].join('='),
      ['OPENROUTER_API_KEY', 'keep-default-openrouter'].join('='),
      '',
    ].join('\n'))
    writeFileSync(join(hermesHome, 'auth.json'), JSON.stringify({
      providers: {
        deepseek: { access_token: 'keep-default-token' },
      },
      credential_pool: {
        deepseek: [{ label: 'keep-default' }],
      },
    }, null, 2))
    writeFileSync(join(researchDir, 'config.yaml'), [
      'model:',
      '  provider: deepseek',
      '  default: research-model',
      'custom_providers:',
      '  - name: keep-provider',
      '    base_url: https://keep.invalid/v1',
      '    api_key: placeholder',
      '    model: keep-model',
      '',
    ].join('\n'))
    writeFileSync(join(researchDir, '.env'), [
      ['DEEPSEEK_API_KEY', 'remove-research-key'].join('='),
      ['OPENROUTER_API_KEY', 'keep-research-openrouter'].join('='),
      '',
    ].join('\n'))
    writeFileSync(join(researchDir, 'auth.json'), JSON.stringify({
      providers: {
        deepseek: { access_token: 'remove-research-token' },
        openrouter: { access_token: 'keep-research-token' },
      },
      credential_pool: {
        deepseek: [{ label: 'remove-research' }],
        openrouter: [{ label: 'keep-research' }],
      },
    }, null, 2))

    const { remove } = await loadProvidersController()
    const ctx = makeCtx('deepseek', { state: { profile: { name: 'research' } } })

    await remove(ctx)

    expect(ctx.body).toEqual({ success: true })

    const defaultEnvAfter = readFileSync(join(hermesHome, '.env'), 'utf-8')
    expect(defaultEnvAfter).toContain(['DEEPSEEK_API_KEY', 'keep-default-key'].join('='))
    expect(defaultEnvAfter).toContain(['OPENROUTER_API_KEY', 'keep-default-openrouter'].join('='))
    expect(readFileSync(join(hermesHome, 'config.yaml'), 'utf-8')).toContain('keep-default-model')
    expect(readAuth()).toEqual({
      providers: {
        deepseek: { access_token: 'keep-default-token' },
      },
      credential_pool: {
        deepseek: [{ label: 'keep-default' }],
      },
    })

    const researchEnvAfter = readFileSync(join(researchDir, '.env'), 'utf-8')
    expect(researchEnvAfter).not.toContain('DEEPSEEK_API_KEY')
    expect(researchEnvAfter).toContain(['OPENROUTER_API_KEY', 'keep-research-openrouter'].join('='))
    const researchConfigAfter = readFileSync(join(researchDir, 'config.yaml'), 'utf-8')
    expect(researchConfigAfter).toContain('keep-provider')
    expect(researchConfigAfter).toContain('keep-model')
    const researchAuthAfter = readAuth(researchDir)
    expect(researchAuthAfter.providers).not.toHaveProperty('deepseek')
    expect(researchAuthAfter.credential_pool).not.toHaveProperty('deepseek')
    expect(researchAuthAfter.providers.openrouter).toEqual({ access_token: 'keep-research-token' })
    expect(researchAuthAfter.credential_pool.openrouter).toEqual([{ label: 'keep-research' }])
  })
})
