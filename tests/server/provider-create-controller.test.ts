import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import YAML from 'js-yaml'

vi.mock('../../packages/server/src/modules/hermes/services/runtime/cli', () => ({
  restartGateway: vi.fn().mockResolvedValue(undefined),
}))

let hermesHome = ''

async function loadProvidersController() {
  vi.resetModules()
  process.env.HERMES_HOME = hermesHome
  await import('../../packages/server/src/bootstrap/agent-profile-adapter')
  return import('../../packages/server/src/modules/hermes/controllers/providers')
}

function makeCtx(body: Record<string, any>, profile = 'default') {
  return {
    request: { body },
    state: { profile: { name: profile } },
    status: 200,
    body: undefined as unknown,
  }
}

function readYaml(filePath: string) {
  return YAML.load(readFileSync(filePath, 'utf-8')) as any
}

describe('providers controller create', () => {
  beforeEach(() => {
    hermesHome = mkdtempSync(join(tmpdir(), 'hwui-provider-create-'))
    mkdirSync(hermesHome, { recursive: true })
    writeFileSync(join(hermesHome, 'config.yaml'), 'model: {}\n')
    writeFileSync(join(hermesHome, '.env'), '')
  })

  afterEach(() => {
    delete process.env.HERMES_HOME
    vi.doUnmock('../../packages/server/src/modules/hermes/controllers/providers')
    vi.clearAllMocks()
    if (hermesHome) rmSync(hermesHome, { recursive: true, force: true })
    hermesHome = ''
  })

  it('does not persist a built-in provider base URL when it matches the preset default', async () => {
    const { create } = await loadProvidersController()
    const ctx = makeCtx({
      name: 'DeepSeek',
      base_url: 'https://api.deepseek.com',
      api_key: 'deepseek-key',
      model: 'deepseek-chat',
      providerKey: 'deepseek',
    })

    await create(ctx)

    expect(ctx.body).toEqual({ success: true })
    const envAfter = readFileSync(join(hermesHome, '.env'), 'utf-8')
    expect(envAfter).toContain('DEEPSEEK_API_KEY=deepseek-key')
    expect(envAfter).not.toContain('DEEPSEEK_BASE_URL')
  })

  it.each(['', 'stale-key'])('rejects retired OpenCode Free without changing configuration (key: %s)', async apiKey => {
    const { create } = await loadProvidersController()
    const before = readFileSync(join(hermesHome, 'config.yaml'), 'utf-8')
    const ctx = makeCtx({ name: 'OpenCode Free', providerKey: 'opencode-free', base_url: 'https://opencode.ai/zen/v1', model: 'mimo-v2.5-free', api_key: apiKey })
    await create(ctx)
    expect(ctx.status).toBe(400)
    expect(ctx.body).toEqual({ error: expect.stringContaining('OpenCode Free is no longer supported') })
    expect(readFileSync(join(hermesHome, 'config.yaml'), 'utf-8')).toBe(before)
    expect(readFileSync(join(hermesHome, '.env'), 'utf-8')).toBe('')
  })

  it('persists a built-in provider base URL when it differs from the preset default', async () => {
    const { create } = await loadProvidersController()
    const ctx = makeCtx({
      name: 'DeepSeek',
      base_url: 'https://deepseek-proxy.invalid/v1',
      api_key: 'deepseek-key',
      model: 'deepseek-chat',
      providerKey: 'deepseek',
    })

    await create(ctx)

    expect(ctx.body).toEqual({ success: true })
    const envAfter = readFileSync(join(hermesHome, '.env'), 'utf-8')
    expect(envAfter).toContain('DEEPSEEK_API_KEY=deepseek-key')
    expect(envAfter).toContain('DEEPSEEK_BASE_URL=https://deepseek-proxy.invalid/v1')
  })

  it('creates xAI OAuth as a direct config provider without an API key or custom provider entry', async () => {
    const { create } = await loadProvidersController()
    const ctx = makeCtx({
      name: 'xAI Grok OAuth',
      base_url: 'https://api.x.ai/v1',
      api_key: '',
      model: 'grok-4.3',
      providerKey: 'xai-oauth',
    })

    await create(ctx)

    expect(ctx.body).toEqual({ success: true })
    const configAfter = readYaml(join(hermesHome, 'config.yaml'))
    expect(configAfter.model).toEqual({ default: 'grok-4.3', provider: 'xai-oauth' })
    expect(configAfter.custom_providers).toBeUndefined()
    expect(readFileSync(join(hermesHome, '.env'), 'utf-8')).toBe('')
  })

  it('creates LongCat preset as a custom provider instead of env-backed builtin provider', async () => {
    const { create } = await loadProvidersController()
    const ctx = makeCtx({
      name: 'LongCat',
      base_url: 'https://api.longcat.chat/openai',
      api_key: 'longcat-key',
      model: 'LongCat-2.0-Preview',
      providerKey: 'longcat',
    })

    await create(ctx)

    expect(ctx.body).toEqual({ success: true })
    const configAfter = readYaml(join(hermesHome, 'config.yaml'))
    expect(configAfter.model).toEqual({ default: 'LongCat-2.0-Preview', provider: 'custom:longcat' })
    expect(configAfter.custom_providers).toEqual([
      expect.objectContaining({
        name: 'longcat',
        base_url: 'https://api.longcat.chat/openai',
        api_key: 'longcat-key',
        model: 'LongCat-2.0-Preview',
        api_mode: 'codex_responses',
      }),
    ])
    expect(readFileSync(join(hermesHome, '.env'), 'utf-8')).not.toContain('LONGCAT_API_KEY')
  })

  it('persists api_mode for custom providers', async () => {
    const { create } = await loadProvidersController()
    const ctx = makeCtx({
      name: 'Research Proxy',
      base_url: 'https://research.invalid/v1',
      api_key: 'research-key',
      model: 'research-model',
      api_mode: 'chat_completions',
    })

    await create(ctx)

    expect(ctx.body).toEqual({ success: true })
    const configAfter = readYaml(join(hermesHome, 'config.yaml'))
    expect(configAfter.custom_providers).toEqual([
      expect.objectContaining({
        name: 'research-proxy',
        base_url: 'https://research.invalid/v1',
        api_key: 'research-key',
        model: 'research-model',
        api_mode: 'chat_completions',
      }),
    ])
  })
})
