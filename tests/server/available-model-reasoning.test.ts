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
  it('includes effort metadata in configured, profile and preset catalogs without changing the configured context', async () => {
    await import('../../packages/server/src/bootstrap/agent-profile-adapter')
    const { getAvailable } = await import('../../packages/server/src/modules/hermes/controllers/models')
    const { getModelContextLength } = await import('../../packages/server/src/modules/hermes/services/models/context')
    const ctx = { query: { profile: 'default' }, body: undefined as any }
    await getAvailable(ctx)
    for (const groups of [ctx.body.groups, ctx.body.profiles[0].groups, ctx.body.allProviders]) {
      expect(groups.find((group: any) => group.provider === 'deepseek').model_meta['deepseek-chat'])
        .toMatchObject({ reasoning: true, reasoning_efforts: ['low', 'high'] })
    }
    expect(getModelContextLength()).toBe(80_000)
    expect(readFileSync(join(home, 'config.yaml'), 'utf8')).toBe(initialConfig)
    expect(fetch).not.toHaveBeenCalled()
  })
})
