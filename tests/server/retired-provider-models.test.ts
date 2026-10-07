import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let home = ''
let appHome = ''
const originalHome = process.env.HERMES_HOME
const originalAppHome = process.env.HERMES_WEB_UI_HOME
const initialConfig = 'model:\n  provider: deepseek\n  default: deepseek-chat\n'
beforeEach(() => {
  vi.resetModules()
  home = mkdtempSync(join(tmpdir(), 'opencode-free-profile-'))
  appHome = mkdtempSync(join(tmpdir(), 'opencode-free-studio-'))
  process.env.HERMES_HOME = home
  process.env.HERMES_WEB_UI_HOME = appHome
  writeFileSync(join(home, 'config.yaml'), initialConfig)
  writeFileSync(join(home, '.env'), 'DEEPSEEK_API_KEY=test-key\n')
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
})
afterEach(() => {
  vi.unstubAllGlobals()
  if (originalHome === undefined) delete process.env.HERMES_HOME
  else process.env.HERMES_HOME = originalHome
  if (originalAppHome === undefined) delete process.env.HERMES_WEB_UI_HOME
  else process.env.HERMES_WEB_UI_HOME = originalAppHome
  rmSync(home, { recursive: true, force: true })
  rmSync(appHome, { recursive: true, force: true })
})

async function load() {
  await import('../../packages/server/src/bootstrap/agent-profile-adapter')
  const models = await import('../../packages/server/src/modules/hermes/controllers/models')
  const cache = await import('../../packages/server/src/modules/hermes/services/providers/model-catalog-cache')
  return { ...models, ...cache }
}
const ctx = () => ({ query: { profile: 'default' }, body: undefined as any })

describe('retired provider discovery', () => {
  it('omits OpenCode Free from configured and add-provider catalogs without network IO', async () => {
    const { getAvailable } = await load()
    const request = ctx()
    await getAvailable(request)
    expect(request.body.groups.some((g: any) => g.provider === 'opencode-free')).toBe(false)
    expect(request.body.allProviders.some((g: any) => g.provider === 'opencode-free')).toBe(false)
    expect(request.body.allProviders).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'opencode-zen' }),
      expect.objectContaining({ provider: 'opencode-go' }),
    ]))
    expect(request.body.default_provider).toBe('deepseek')
    expect(fetch).not.toHaveBeenCalled()
    expect(readFileSync(join(home, 'config.yaml'), 'utf8')).toBe(initialConfig)
  })

  it('does not resurrect a retired default from a stale cached catalog', async () => {
    const { getAvailable, writeProviderModelCatalogEntry } = await load()
    const retiredConfig = 'model:\n  provider: opencode-free\n  default: mimo-v2.5-free\n'
    writeFileSync(join(home, 'config.yaml'), retiredConfig)
    writeFileSync(join(home, '.env'), '')
    await writeProviderModelCatalogEntry({ provider: 'opencode-free', label: 'OpenCode Free', base_url: 'https://opencode.ai/zen/v1', models: ['mimo-v2.5-free'], source: 'live' })
    const request = ctx()
    await getAvailable(request)
    expect(request.body.groups).toEqual([])
    expect(request.body.default_provider).toBe('')
    expect(request.body.default).toBe('')
    expect(fetch).not.toHaveBeenCalled()
    expect(readFileSync(join(home, 'config.yaml'), 'utf8')).toBe(retiredConfig)
  })

  it('preserves a user-owned custom provider with the same name', async () => {
    const { getAvailable } = await load()
    writeFileSync(join(home, 'config.yaml'), initialConfig + 'custom_providers:\n  - name: opencode-free\n    base_url: https://custom.example/v1\n    api_key: custom-key\n    model: custom-model\n')
    const request = ctx()
    await getAvailable(request)
    expect(request.body.groups).toContainEqual(expect.objectContaining({ provider: 'custom:opencode-free', models: ['custom-model'] }))
  })

  it('rejects selecting and refreshing a retired provider before any write or upstream call', async () => {
    const { setConfigModel, fetchProviderModelList } = await load()
    for (const handler of [setConfigModel, fetchProviderModelList]) {
      const request = { ...ctx(), status: 200, request: { body: { provider: 'opencode-free', default: 'mimo-v2.5-free', base_url: 'https://opencode.ai/zen/v1', api_key: 'stale-key', update_cache: true } } }
      await handler(request)
      expect(request.status).toBe(400)
      expect(request.body.error).toContain('OpenCode Free is no longer supported')
    }
    expect(fetch).not.toHaveBeenCalled()
    expect(readFileSync(join(home, 'config.yaml'), 'utf8')).toBe(initialConfig)
  })
})
