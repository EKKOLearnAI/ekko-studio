import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

let homeDir = ''
const originalHermesHome = process.env.HERMES_HOME
const originalLocalAppData = process.env.LOCALAPPDATA
const originalAppData = process.env.APPDATA

function hermesPath(...parts: string[]) {
  return join(homeDir, '.hermes', ...parts)
}

function writeConfig(content: string) {
  mkdirSync(hermesPath(), { recursive: true })
  writeFileSync(hermesPath('config.yaml'), content)
}

function writeModelsCache(data: Record<string, unknown>) {
  mkdirSync(hermesPath(), { recursive: true })
  writeFileSync(hermesPath('models_dev_cache.json'), JSON.stringify(data))
}

async function loadModelContext() {
  process.env.HERMES_HOME = hermesPath()
  delete process.env.LOCALAPPDATA
  delete process.env.APPDATA
  vi.resetModules()
  vi.doMock('os', async () => ({
    ...(await vi.importActual<typeof import('os')>('os')),
    homedir: () => homeDir,
  }))
  // Mock getDb to return null to avoid "database is locked" errors in parallel tests
  vi.doMock('../../packages/server/src/modules/studio/infrastructure/database/index', async () => {
    const actual = await vi.importActual<typeof import('../../packages/server/src/modules/studio/infrastructure/database/index')>('../../packages/server/src/modules/studio/infrastructure/database/index')
    return {
      ...actual,
      getDb: () => null,
    }
  })
  return import('../../packages/server/src/modules/hermes/services/models/context')
}

describe('getModelContextLength', () => {
  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'hwui-model-context-'))
  })

  afterEach(() => {
    vi.doUnmock('os')
    vi.doUnmock('../../packages/server/src/modules/studio/public/provider-context')
    if (originalHermesHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = originalHermesHome
    if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA
    else process.env.LOCALAPPDATA = originalLocalAppData
    if (originalAppData === undefined) delete process.env.APPDATA
    else process.env.APPDATA = originalAppData
    if (homeDir) rmSync(homeDir, { recursive: true, force: true })
    homeDir = ''
  })

  it.each([false, true])('prefers the manually edited model window (config file exists: %s)', async withConfig => {
    if (withConfig) writeConfig('model:\n  default: policy-model\n  provider: test\n  context_length: 256000\n')
    const readModelContextRecord = vi.fn(() => ({ available: true, row: { context_limit: 80000 } }))
    vi.doMock('../../packages/server/src/modules/studio/public/provider-context', () => ({ readModelContextRecord }))
    const { getModelContextLength } = await loadModelContext()
    expect(getModelContextLength({ profile: 'default', provider: 'test', model: 'policy-model' })).toBe(80000)
    expect(readModelContextRecord).toHaveBeenCalledWith('default', 'test', 'policy-model')
  })

  it('does not borrow a same-named model context from another provider when the configured provider is uncached', async () => {
    writeConfig(`model:\n  default: gpt-5.5\n  provider: openai-codex\n`)
    writeModelsCache({
      openai: {
        models: {
          'gpt-5.5': { limit: { context: 1_050_000 } },
        },
      },
    })

    const { getModelContextLength } = await loadModelContext()

    expect(getModelContextLength()).toBe(256_000)
  })

  it('uses a caller-provided fallback only when no model context is configured', async () => {
    writeConfig(`model:\n  default: grok-4.6\n  provider: custom:grok\n`)

    const { getModelContextLength } = await loadModelContext()

    expect(getModelContextLength({ provider: 'custom:grok', model: 'grok-4.6', fallbackContextLength: 128_000 })).toBe(128_000)
  })

  it('does not scan other providers when the configured provider exists without that model', async () => {
    writeConfig(`model:\n  default: gpt-5.5\n  provider: openai-codex\n`)
    writeModelsCache({
      'openai-codex': {
        models: {
          'gpt-5.4': { limit: { context: 256_000 } },
        },
      },
      openai: {
        models: {
          'gpt-5.5': { limit: { context: 1_050_000 } },
        },
      },
    })

    const { getModelContextLength } = await loadModelContext()

    expect(getModelContextLength()).toBe(256_000)
  })

  it('uses the configured provider cache entry when the provider matches', async () => {
    writeConfig(`model:\n  default: gpt-5.5\n  provider: openai\n`)
    writeModelsCache({
      openai: {
        models: {
          'gpt-5.5': { limit: { context: 1_050_000 } },
        },
      },
    })

    const { getModelContextLength } = await loadModelContext()

    expect(getModelContextLength()).toBe(1_050_000)
  })

  it('prefers requested provider model context_length over top-level default context_length', async () => {
    writeConfig(`model:\n  default: gpt-5.5\n  provider: openai-codex\n  context_length: 272000\n\nproviders:\n  qwen:\n    name: Qwen\n    default_model: qwen3.6-plus\n    models:\n      qwen3.6-plus:\n        context_length: 1048576\n`)

    const { getModelContextLength } = await loadModelContext()

    expect(getModelContextLength({ provider: 'qwen', model: 'qwen3.6-plus' })).toBe(1_048_576)
  })

  it('uses provider-level context_length when the requested model belongs to that provider', async () => {
    writeConfig(`model:\n  default: gpt-5.5\n  provider: openai-codex\n  context_length: 272000\n\nproviders:\n  qwen:\n    name: Qwen\n    default_model: qwen3.6-plus\n    models:\n      - qwen3.6-plus\n    context_length: 1048576\n`)

    const { getModelContextLength } = await loadModelContext()

    expect(getModelContextLength({ provider: 'qwen', model: 'qwen3.6-plus' })).toBe(1_048_576)
  })

  it('keeps legacy model-name cache lookup when no provider is configured', async () => {
    writeConfig(`model:\n  default: gpt-5.5\n`)
    writeModelsCache({
      openai: {
        models: {
          'gpt-5.5': { limit: { context: 1_050_000 } },
        },
      },
    })

    const { getModelContextLength } = await loadModelContext()

    expect(getModelContextLength()).toBe(1_050_000)
  })

  it('keeps providerless legacy lookup on global exact matches before prefixed suffix matches', async () => {
    writeConfig(`model:\n  default: gpt-5\n`)
    writeModelsCache({
      vercel: {
        models: {
          'openai/gpt-5': { limit: { context: 1_000_000 } },
        },
      },
      openai: {
        models: {
          'gpt-5': { limit: { context: 400_000 } },
        },
      },
    })

    const { getModelContextLength } = await loadModelContext()

    expect(getModelContextLength()).toBe(400_000)
  })

  it('maps WUI provider keys to model-cache provider keys before looking up limits', async () => {
    writeConfig(`model:\n  default: gemini-3.1-pro-preview\n  provider: gemini\n`)
    writeModelsCache({
      google: {
        models: {
          'gemini-3.1-pro-preview': { limit: { context: 1_000_000 } },
        },
      },
    })

    const { getModelContextLength } = await loadModelContext()

    expect(getModelContextLength()).toBe(1_000_000)
  })

  it('uses gateway provider aliases with prefixed model names inside the aliased provider only', async () => {
    writeConfig(`model:\n  default: openai/gpt-5\n  provider: ai-gateway\n`)
    writeModelsCache({
      vercel: {
        models: {
          'openai/gpt-5': { limit: { context: 1_000_000 } },
        },
      },
      openai: {
        models: {
          'gpt-5': { limit: { context: 400_000 } },
        },
      },
    })

    const { getModelContextLength } = await loadModelContext()

    expect(getModelContextLength()).toBe(1_000_000)
  })

  it('resolves provider: custom through model.base_url before falling back to the default context length', async () => {
    writeConfig(`model:\n  default: deepseek-v4-pro\n  provider: custom\n  base_url: https://api.deepseek.com\n`)
    writeModelsCache({
      deepseek: {
        models: {
          'deepseek-v4-pro': { limit: { context: 1_000_000 } },
        },
      },
    })

    const { getModelContextLength } = await loadModelContext()

    expect(getModelContextLength()).toBe(1_000_000)
  })

  it('resolves custom:name providers when the matched custom provider base_url points at a builtin provider', async () => {
    writeConfig(`model:\n  default: deepseek-v4-pro\n  provider: custom:deepseek\n\ncustom_providers:\n  - name: deepseek\n    base_url: https://api.deepseek.com\n    model: deepseek-v4-pro\n`)
    writeModelsCache({
      deepseek: {
        models: {
          'deepseek-v4-pro': { limit: { context: 1_000_000 } },
        },
      },
    })

    const { getModelContextLength } = await loadModelContext()

    expect(getModelContextLength()).toBe(1_000_000)
  })

  it('prefers the builtin provider inferred from a matched custom provider base_url over an arbitrary custom provider name', async () => {
    writeConfig(`model:\n  default: shared-model\n  provider: custom:corp-proxy\n\ncustom_providers:\n  - name: corp-proxy\n    base_url: https://api.deepseek.com\n    model: shared-model\n`)
    writeModelsCache({
      deepseek: {
        models: {
          'shared-model': { limit: { context: 1_000_000 } },
        },
      },
      openai: {
        models: {
          'shared-model': { limit: { context: 400_000 } },
        },
      },
    })

    const { getModelContextLength } = await loadModelContext()

    expect(getModelContextLength()).toBe(1_000_000)
  })

  it('does not trust a stale custom:name provider hint without a matching custom provider entry', async () => {
    writeConfig(`model:\n  default: deepseek-v4-pro\n  provider: custom:deepseek\n`)
    writeModelsCache({
      deepseek: {
        models: {
          'deepseek-v4-pro': { limit: { context: 1_000_000 } },
        },
      },
    })

    const { getModelContextLength } = await loadModelContext()

    expect(getModelContextLength()).toBe(256_000)
  })

  it('does not trust custom:name alone when the matched custom provider entry points at an unknown proxy url', async () => {
    writeConfig(`model:\n  default: deepseek-v4-pro\n  provider: custom:deepseek\n\ncustom_providers:\n  - name: deepseek\n    base_url: https://proxy.example.com/v1\n    model: deepseek-v4-pro\n`)
    writeModelsCache({
      deepseek: {
        models: {
          'deepseek-v4-pro': { limit: { context: 1_000_000 } },
        },
      },
    })

    const { getModelContextLength } = await loadModelContext()

    expect(getModelContextLength()).toBe(256_000)
  })

  it('does not fall through to a unique global match after a resolved custom:name provider misses in its scoped cache provider', async () => {
    writeConfig(`model:\n  default: gpt-5.5\n  provider: custom:deepseek\n\ncustom_providers:\n  - name: deepseek\n    base_url: https://api.deepseek.com\n    model: gpt-5.5\n`)
    writeModelsCache({
      openai: {
        models: {
          'gpt-5.5': { limit: { context: 400_000 } },
        },
      },
      deepseek: {
        models: {
          'deepseek-v4-pro': { limit: { context: 1_000_000 } },
        },
      },
    })

    const { getModelContextLength } = await loadModelContext()

    expect(getModelContextLength()).toBe(256_000)
  })

  it('allows a unique global model-name fallback for unresolved custom providers', async () => {
    writeConfig(`model:\n  default: deepseek-v4-pro\n  provider: custom\n  base_url: https://proxy.example.com/v1\n`)
    writeModelsCache({
      deepseek: {
        models: {
          'deepseek-v4-pro': { limit: { context: 1_000_000 } },
        },
      },
    })

    const { getModelContextLength } = await loadModelContext()

    expect(getModelContextLength()).toBe(1_000_000)
  })

  it('still allows the unique global fallback when provider: custom matches a custom provider entry that cannot be mapped to a builtin cache provider', async () => {
    writeConfig(`model:\n  default: deepseek-v4-pro\n  provider: custom\n\ncustom_providers:\n  - name: corp-proxy\n    base_url: https://proxy.example.com/v1\n    model: deepseek-v4-pro\n`)
    writeModelsCache({
      deepseek: {
        models: {
          'deepseek-v4-pro': { limit: { context: 1_000_000 } },
        },
      },
    })

    const { getModelContextLength } = await loadModelContext()

    expect(getModelContextLength()).toBe(1_000_000)
  })

  it('keeps the unresolved custom-provider fallback strict to exact or case-insensitive model-name matches', async () => {
    writeConfig(`model:\n  default: gpt-5\n  provider: custom\n  base_url: https://proxy.example.com/v1\n`)
    writeModelsCache({
      vercel: {
        models: {
          'openai/gpt-5': { limit: { context: 1_000_000 } },
        },
      },
    })

    const { getModelContextLength } = await loadModelContext()

    expect(getModelContextLength()).toBe(256_000)
  })

  it('does not guess across multiple cache providers when a custom provider remains unresolved', async () => {
    writeConfig(`model:\n  default: shared-model\n  provider: custom\n  base_url: https://proxy.example.com/v1\n`)
    writeModelsCache({
      deepseek: {
        models: {
          'shared-model': { limit: { context: 1_000_000 } },
        },
      },
      openai: {
        models: {
          'shared-model': { limit: { context: 400_000 } },
        },
      },
    })

    const { getModelContextLength } = await loadModelContext()

    expect(getModelContextLength()).toBe(256_000)
  })

  it('uses the MoA preset aggregator context length for the virtual provider', async () => {
    writeConfig(`model:\n  default: research-team\n  provider: moa\n\nmoa:\n  default_preset: research-team\n  presets:\n    research-team:\n      enabled: true\n      aggregator:\n        provider: qwen\n        model: qwen3.6-plus\n      reference_models:\n        - provider: openai\n          model: gpt-5.5\n\nproviders:\n  qwen:\n    name: Qwen\n    default_model: qwen3.6-plus\n    models:\n      qwen3.6-plus:\n        context_length: 1048576\n`)

    const { getModelContextLength } = await loadModelContext()

    expect(getModelContextLength({ provider: 'moa', model: 'research-team' })).toBe(1_048_576)
  })

  it('falls back safely when a MoA preset has no valid aggregator', async () => {
    writeConfig(`model:\n  default: broken-team\n  provider: moa\n\nmoa:\n  presets:\n    broken-team:\n      enabled: true\n`)

    const { getModelContextLength } = await loadModelContext()

    expect(getModelContextLength({ provider: 'moa', model: 'broken-team' })).toBe(256_000)
  })
})
