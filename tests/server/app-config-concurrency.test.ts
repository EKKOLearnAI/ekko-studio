import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

let appHome = ''
const originalAppHome = process.env.HERMES_WEB_UI_HOME

beforeEach(() => {
  appHome = mkdtempSync(join(tmpdir(), 'app-config-lock-'))
  process.env.HERMES_WEB_UI_HOME = appHome
  vi.resetModules()
})

afterEach(() => {
  vi.resetModules()
  rmSync(appHome, { recursive: true, force: true })
  if (originalAppHome === undefined) delete process.env.HERMES_WEB_UI_HOME
  else process.env.HERMES_WEB_UI_HOME = originalAppHome
})

describe('app config writes', () => {
  it('merges concurrent patches by reading under the shared file lock', async () => {
    const { writeAppConfig } = await import('../../packages/server/src/modules/studio/services/config/app-config')

    await Promise.all([
      writeAppConfig({ modelAliases: { deepseek: { model: 'Alias' } } }),
      writeAppConfig({ providerLabels: { research: { deepseek: 'Research DeepSeek' } } }),
    ])

    const stored = JSON.parse(readFileSync(join(appHome, 'config.json'), 'utf8'))
    expect(stored.modelAliases).toEqual({ deepseek: { model: 'Alias' } })
    expect(stored.providerLabels).toEqual({ research: { deepseek: 'Research DeepSeek' } })
  })
  it('retains global false values and other settings across reload and unrelated upgrades', async () => {
    const first = await import('../../packages/server/src/modules/studio/services/config/app-config')
    await first.writeAppConfig({ copilotEnabled: false, gatewayAutoStart: { enabled: false }, appRelayRoute: 'cloudflare' })
    vi.resetModules()
    const next = await import('../../packages/server/src/modules/studio/services/config/app-config')
    expect(await next.readAppConfig()).toMatchObject({ copilotEnabled: false, gatewayAutoStart: { enabled: false }, appRelayRoute: 'cloudflare' })
    await next.writeAppConfig({ modelAliases: { provider: { model: 'name' } } })
    next.invalidateAppConfigCache()
    expect(await next.readAppConfig()).toMatchObject({ copilotEnabled: false, gatewayAutoStart: { enabled: false }, appRelayRoute: 'cloudflare' })
  })

})
