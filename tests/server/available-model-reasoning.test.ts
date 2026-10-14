import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let home = ''
let appHome = ''
const initialConfig = 'model:\n  provider: deepseek\n  default: deepseek-chat\n  context_length: 80000\n'
beforeEach(() => {
  vi.resetModules()
  home = mkdtempSync(join(tmpdir(), 'model-reasoning-profile-'))
  appHome = mkdtempSync(join(tmpdir(), 'model-reasoning-studio-'))
  vi.stubEnv('HERMES_HOME', home)
  vi.stubEnv('HERMES_WEB_UI_HOME', appHome)
  writeFileSync(join(home, 'config.yaml'), initialConfig)
  writeFileSync(join(home, '.env'), 'DEEPSEEK_API_KEY=test-key\n')
  mkdirSync(join(appHome, 'models'))
  writeFileSync(join(appHome, 'models', 'models.dev.json'), JSON.stringify({ deepseek: { models: {
    'deepseek-chat': { limit: { context: 256_000 }, reasoning: true, reasoning_options: [{ type: 'effort', values: ['low', 'high'] }] },
  } } }))
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  rmSync(home, { recursive: true, force: true })
  rmSync(appHome, { recursive: true, force: true })
})

describe('available model reasoning metadata', () => {
  it.each(['deepseek-flash', 'vendor/mirror/deepseek-flash', 'deepseek-v4.1-flash'])(
    'lazily resolves custom model metadata only when the actual ID or final segment matches: %s', async modelId => {
      writeFileSync(join(home, 'config.yaml'), `model:\n  provider: custom:api.apikey.fun\n  default: ${modelId}\ncustom_providers:\n  - name: api.apikey.fun\n    base_url: https://api.apikey.fan\n    api_key: test-key\n    model: ${modelId}\n`)
      const model = {
        canonical_model_id: 'deepseek/deepseek-v4.1-flash', reasoning: true,
        reasoning_options: [{ type: 'toggle' }, { type: 'effort', values: ['low', 'high', 'max'] }],
        cost: { input: 0.15, output: 0.6 },
      }
      writeFileSync(join(appHome, 'models', 'models.dev.json'), JSON.stringify({
        deepseek: { models: { 'deepseek-flash': model } },
        relay: { models: { 'deepseek-flash': { ...model, cost: { input: 1, output: 2 } } } },
      }))
      await import('../../packages/server/src/bootstrap/agent-profile-adapter')
      const { getAvailable, getModelMetadata } = await import('../../packages/server/src/modules/hermes/controllers/models')
      const ctx = { query: { profile: 'default' }, body: undefined as any }
      await getAvailable(ctx)
      for (const groups of [ctx.body.groups, ctx.body.profiles[0].groups]) {
        const metadata = groups.find((group: any) => group.provider === 'custom:api.apikey.fun').model_meta?.[modelId]
        expect(metadata).toBeUndefined()
      }
      const selected = { query: { profile: 'default', provider: 'custom:api.apikey.fun', model: modelId }, body: undefined as any }
      await getModelMetadata(selected)
      expect(selected.body.metadata).toEqual(modelId === 'deepseek-v4.1-flash' ? {} : { reasoning: true, reasoning_efforts: ['none', 'low', 'high', 'max'] })
    },
  )

  it('lists catalogs without resolving metadata and keeps configured context precedence', async () => {
    await import('../../packages/server/src/bootstrap/agent-profile-adapter')
    const { getAvailable, getModelMetadata } = await import('../../packages/server/src/modules/hermes/controllers/models')
    const { getModelContextLength } = await import('../../packages/server/src/modules/hermes/services/models/context')
    const ctx = { query: { profile: 'default' }, body: undefined as any }
    await getAvailable(ctx)
    for (const groups of [ctx.body.groups, ctx.body.profiles[0].groups, ctx.body.allProviders]) {
      expect(groups.find((group: any) => group.provider === 'deepseek').model_meta?.['deepseek-chat']).toBeUndefined()
    }
    const selected = { query: { profile: 'default', provider: 'deepseek', model: 'deepseek-chat' }, body: undefined as any }
    await getModelMetadata(selected)
    expect(selected.body.metadata).toEqual({ reasoning: true, reasoning_efforts: ['low', 'high'] })
    expect(getModelContextLength()).toBe(80_000)
    expect(readFileSync(join(home, 'config.yaml'), 'utf8')).toBe(initialConfig)
    expect(fetch).not.toHaveBeenCalled()
  })
  it('never resolves unused models in a 3000-model gateway, including aggregate and profile requests', async () => {
    const models = Array.from({ length: 3000 }, (_, i) => `vendor/model-${i}`)
    writeFileSync(join(home, 'config.yaml'), `model:\n  provider: custom:gateway\n  default: ${models[0]}\ncustom_providers:\n  - name: gateway\n    base_url: https://gateway.test/v1\n    api_key: test-key\n    model: ${models[0]}\n`)
    await import('../../packages/server/src/bootstrap/agent-profile-adapter')
    const catalog = await import('../../packages/server/src/modules/studio/public/model-catalog')
    const resolve = vi.spyOn(catalog, 'resolveCatalogModel')
    const load = vi.spyOn(catalog, 'getModelCatalog')
    const { writeProviderModelCatalogEntry } = await import('../../packages/server/src/modules/hermes/services/providers/model-catalog-cache')
    await writeProviderModelCatalogEntry({ provider: 'custom:gateway', base_url: 'https://gateway.test/v1', label: 'Gateway', models, source: 'remote', profile: 'default' })
    const { getAvailable, getModelMetadata } = await import('../../packages/server/src/modules/hermes/controllers/models')
    for (const query of [{}, { profile: 'default' }]) {
      const ctx = { query, body: undefined as any }
      await getAvailable(ctx)
      expect(ctx.body.groups.find((group: any) => group.provider === 'custom:gateway').models).toHaveLength(3000)
    }
    expect(resolve).not.toHaveBeenCalled()
    expect(load).not.toHaveBeenCalled()
    await getModelMetadata({ query: { profile: 'default', provider: 'custom:gateway', model: models[0] } })
    expect(resolve).toHaveBeenCalledOnce()
  })
  it('rejects missing identities instead of resolving an entire list', async () => {
    const { getModelMetadata } = await import('../../packages/server/src/modules/hermes/controllers/models')
    for (const query of [{}, { model: 'known' }, { provider: 'deepseek', model: ['one', 'two'] }]) {
      const ctx = { query, status: 200, body: undefined as any }
      await getModelMetadata(ctx)
      expect(ctx.status).toBe(400)
    }
  })
  it('uses the selected Profile endpoint when the same gateway/model exists in multiple Profiles', async () => {
    const profileConfig = (baseUrl: string) => `custom_providers:\n  - name: gateway\n    base_url: ${baseUrl}\n    api_key: test-key\n    model: shared\n`
    writeFileSync(join(home, 'config.yaml'), profileConfig('https://maker.test/api/v1'))
    mkdirSync(join(home, 'profiles', 'research'), { recursive: true })
    writeFileSync(join(home, 'profiles', 'research', 'config.yaml'), profileConfig('https://maker.test/api/coding/v1'))
    writeFileSync(join(appHome, 'models', 'models.dev.json'), JSON.stringify({
      normal: { api: 'https://maker.test/api/v1', models: { shared: { reasoning: false } } },
      coding: { api: 'https://maker.test/api/coding/v1', models: { shared: { reasoning: true, reasoning_options: [{ type: 'effort', values: ['max'] }] } } },
    }))
    await import('../../packages/server/src/bootstrap/agent-profile-adapter')
    const { getModelMetadata } = await import('../../packages/server/src/modules/hermes/controllers/models')
    const normal = { query: { profile: 'default', provider: 'custom:gateway', model: 'shared' }, body: undefined as any }
    const coding = { query: { ...normal.query, profile: 'research' }, body: undefined as any }
    await getModelMetadata(normal); await getModelMetadata(coding)
    expect(normal.body.metadata).toEqual({ reasoning: false, reasoning_efforts: [] })
    expect(coding.body.metadata).toEqual({ reasoning: true, reasoning_efforts: ['max'] })
  })

})
