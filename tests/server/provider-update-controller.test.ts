import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
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

function makeCtx(poolKey: string, body: Record<string, any>, profile = 'research') {
  return {
    params: { poolKey: encodeURIComponent(poolKey) },
    request: { body },
    state: { profile: { name: profile } },
    status: 200,
    body: undefined as unknown,
  }
}

function readYaml(filePath: string) {
  return YAML.load(readFileSync(filePath, 'utf-8')) as any
}

describe('providers controller update', () => {
  beforeEach(() => {
    mockInvalidateProviderRuntime.mockReset()
    hermesHome = mkdtempSync(join(tmpdir(), 'hwui-provider-update-'))
    mkdirSync(join(hermesHome, 'profiles', 'research'), { recursive: true })
    writeFileSync(join(hermesHome, 'config.yaml'), 'model:\n  provider: deepseek\n  default: keep-default-model\n')
    writeFileSync(join(hermesHome, '.env'), [
      'DEEPSEEK_API_KEY=keep-default-key',
      '',
    ].join('\n'))
    writeFileSync(join(hermesHome, 'profiles', 'research', 'config.yaml'), [
      'model:',
      '  provider: custom:research-proxy',
      '  default: research-model',
      'custom_providers:',
      '  - name: research-proxy',
      '    base_url: https://research.invalid/v1',
      '    api_key: old-research-custom-key',
      '    model: research-model',
      '',
    ].join('\n'))
    writeFileSync(join(hermesHome, 'profiles', 'research', '.env'), [
      'DEEPSEEK_API_KEY=old-research-key',
      '',
    ].join('\n'))
  })

  afterEach(() => {
    delete process.env.HERMES_HOME
    vi.doUnmock('../../packages/server/src/modules/hermes/controllers/providers')
    vi.clearAllMocks()
    if (hermesHome) rmSync(hermesHome, { recursive: true, force: true })
    hermesHome = ''
  })

  it('updates built-in provider API keys in the request-scoped profile env only', async () => {
    const { update } = await loadProvidersController()
    const ctx = makeCtx('deepseek', { api_key: 'new-research-key' })

    await update(ctx)

    expect(ctx.body).toEqual({ success: true })
    expect(readFileSync(join(hermesHome, '.env'), 'utf-8')).toContain('DEEPSEEK_API_KEY=keep-default-key')
    expect(readFileSync(join(hermesHome, 'profiles', 'research', '.env'), 'utf-8')).toContain('DEEPSEEK_API_KEY=new-research-key')
    expect(mockInvalidateProviderRuntime).toHaveBeenCalledWith('research', 'deepseek')
  })

  it('clears saved protocol aliases when a custom connection switches to automatic', async () => {
    const path = join(hermesHome, 'profiles', 'research', 'config.yaml')
    const config = readYaml(path)
    Object.assign(config.custom_providers[0], { api_mode: 'codex_responses', transport: 'anthropic_messages', apiMode: 'chat_completions' })
    writeFileSync(path, YAML.dump(config))
    const { update } = await loadProvidersController()
    const ctx = makeCtx('custom:research-proxy', { api_mode: null })
    await update(ctx)
    expect(ctx.body).toEqual({ success: true })
    const saved = readYaml(path).custom_providers[0]
    for (const key of ['api_mode', 'transport', 'apiMode']) expect(saved).not.toHaveProperty(key)
    expect(mockInvalidateProviderRuntime).toHaveBeenCalledWith('research', 'custom:research-proxy')
  })

  it('does not invalidate a runtime when a custom provider update is rejected', async () => {
    const { update } = await loadProvidersController()
    const ctx = makeCtx('custom:missing-provider', { api_key: 'unused-key' })

    await update(ctx)

    expect(ctx.status).toBe(404)
    expect(mockInvalidateProviderRuntime).not.toHaveBeenCalled()
  })

  it('updates custom provider API keys in the request-scoped profile config only', async () => {
    const defaultConfigPath = join(hermesHome, 'config.yaml')
    writeFileSync(defaultConfigPath, [
      'model:',
      '  provider: custom:research-proxy',
      '  default: default-model',
      'custom_providers:',
      '  - name: research-proxy',
      '    base_url: https://default.invalid/v1',
      '    api_key: keep-default-custom-key',
      '    model: default-model',
      '',
    ].join('\n'))

    const { update } = await loadProvidersController()
    const ctx = makeCtx('custom:research-proxy', { api_key: 'new-research-custom-key' })

    await update(ctx)

    expect(ctx.body).toEqual({ success: true })
    const defaultConfig = readYaml(defaultConfigPath)
    const researchConfig = readYaml(join(hermesHome, 'profiles', 'research', 'config.yaml'))
    expect(defaultConfig.custom_providers[0].api_key).toBe('keep-default-custom-key')
    expect(researchConfig.custom_providers[0].api_key).toBe('new-research-custom-key')
  })

  it('updates custom provider api_mode in the request-scoped profile config only', async () => {
    const defaultConfigPath = join(hermesHome, 'config.yaml')
    writeFileSync(defaultConfigPath, [
      'model:',
      '  provider: custom:research-proxy',
      '  default: default-model',
      'custom_providers:',
      '  - name: research-proxy',
      '    base_url: https://default.invalid/v1',
      '    api_key: keep-default-custom-key',
      '    model: default-model',
      '    api_mode: codex_responses',
      '',
    ].join('\n'))

    const { update } = await loadProvidersController()
    const ctx = makeCtx('custom:research-proxy', { api_mode: 'chat_completions' })

    await update(ctx)

    expect(ctx.body).toEqual({ success: true })
    const defaultConfig = readYaml(defaultConfigPath)
    const researchConfig = readYaml(join(hermesHome, 'profiles', 'research', 'config.yaml'))
    expect(defaultConfig.custom_providers[0].api_mode).toBe('codex_responses')
    expect(researchConfig.custom_providers[0].api_mode).toBe('chat_completions')
  })

})
