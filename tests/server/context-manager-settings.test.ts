import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let appHome = ''

vi.mock('../../packages/server/src/modules/studio/public/config', () => ({
  config: {
    appHome: appHome,
  },
}))

describe('context manager settings', () => {
  beforeEach(async () => {
    appHome = await mkdtemp(join(tmpdir(), 'context-manager-settings-'))
    vi.resetModules()
  })

  afterEach(async () => {
    await rm(appHome, { recursive: true, force: true })
    vi.resetModules()
  })

  async function loadSettings() {
    return import('../../packages/server/src/modules/studio/services/context-manager/settings')
  }

  it('returns native defaults independently for each profile', async () => {
    const { getContextManagerSettings } = await loadSettings()

    await expect(getContextManagerSettings('default')).resolves.toEqual({
      hermes: { manager: 'native' },
      ekko: { manager: 'native' },
      proxyUrl: 'http://127.0.0.1:8787',
      allowNativeFallback: false,
    })
    await expect(getContextManagerSettings('research')).resolves.toEqual({
      hermes: { manager: 'native' },
      ekko: { manager: 'native' },
      proxyUrl: 'http://127.0.0.1:8787',
      allowNativeFallback: false,
    })
  })

  it('updates one profile without changing another profile', async () => {
    const { getContextManagerSettings, saveContextManagerSettings } = await loadSettings()

    await saveContextManagerSettings('default', { hermes: { manager: 'bili' } })

    await expect(getContextManagerSettings('default')).resolves.toMatchObject({
      hermes: { manager: 'bili' },
      ekko: { manager: 'native' },
    })
    await expect(getContextManagerSettings('research')).resolves.toMatchObject({
      hermes: { manager: 'native' },
      ekko: { manager: 'native' },
    })
  })

  it.each(['native', 'bili'] as const)('persists explicit fallback permission for a healthy %s owner', async manager => {
    const { getContextManagerSettings, saveContextManagerSettings } = await loadSettings()
    await saveContextManagerSettings('permitted', { hermes: { manager }, ekko: { manager }, allowNativeFallback: true })
    vi.resetModules()
    const reloaded = await loadSettings()
    await expect(reloaded.getContextManagerSettings('permitted')).resolves.toMatchObject({
      hermes: { manager }, ekko: { manager }, allowNativeFallback: true,
    })
    await expect(getContextManagerSettings('untouched')).resolves.toMatchObject({ allowNativeFallback: false })
  })

  it('validates the proxy as a credential-free loopback HTTP URL', async () => {
    const { saveContextManagerSettings } = await loadSettings()

    await expect(saveContextManagerSettings('default', { proxyUrl: 'http://localhost:8787' })).resolves.toMatchObject({ proxyUrl: 'http://localhost:8787' })
    await expect(saveContextManagerSettings('default', { proxyUrl: 'https://127.0.0.1:9443/base' })).rejects.toThrow(/origin/i)
    for (const suffix of ['?secret=1', '#fragment', '/path/../', '?', '#']) {
      await expect(saveContextManagerSettings('default', { proxyUrl: `http://127.0.0.1:8787${suffix}` })).rejects.toThrow(/origin/i)
    }
    await expect(saveContextManagerSettings('default', { proxyUrl: 'http://[::1]:8787' })).resolves.toMatchObject({ proxyUrl: 'http://[::1]:8787' })

    await expect(saveContextManagerSettings('default', { proxyUrl: 'http://example.com:8787' })).rejects.toThrow(/loopback/i)
    await expect(saveContextManagerSettings('default', { proxyUrl: 'http://localhost.evil.test:8787' })).rejects.toThrow(/loopback/i)
    await expect(saveContextManagerSettings('default', { proxyUrl: 'http://user:pass@127.0.0.1:8787' })).rejects.toThrow(/credential/i)
    await expect(saveContextManagerSettings('default', { proxyUrl: 'file:///etc/passwd' })).rejects.toThrow(/HTTP/i)
  })

  it('rejects secrets and never writes submitted password fields', async () => {
    const { getContextManagerSettings, saveContextManagerSettings } = await loadSettings()

    await expect(saveContextManagerSettings('secret-profile', { password: 'do-not-save' })).rejects.toThrow(/secret|unknown/i)
    await expect(getContextManagerSettings('secret-profile')).resolves.toMatchObject({
      hermes: { manager: 'native' },
      ekko: { manager: 'native' },
    })
  })

  it('serializes concurrent partial updates atomically', async () => {
    const { getContextManagerSettings, saveContextManagerSettings } = await loadSettings()

    await Promise.all([
      saveContextManagerSettings('default', { hermes: { manager: 'bili' } }),
      saveContextManagerSettings('default', { ekko: { manager: 'bili' } }),
    ])

    await expect(getContextManagerSettings('default')).resolves.toMatchObject({
      hermes: { manager: 'bili' },
      ekko: { manager: 'bili' },
    })
    await expect(getContextManagerSettings('default')).resolves.toMatchObject({
      hermes: { manager: 'bili' },
      ekko: { manager: 'bili' },
    })
  })
})

describe('context manager controller and routes', () => {
  it('requires a profile for settings operations', async () => {
    vi.resetModules()
    const controller = await import('../../packages/server/src/modules/studio/controllers/context-manager')
    const ctx = { state: {}, status: 200, body: null, request: { body: {} }, params: {} } as any

    await controller.getSettings(ctx)

    expect(ctx.status).toBe(400)
    expect(ctx.body).toEqual({ error: 'Profile is required', code: 'context_manager_invalid_request' })
  })

  it('exposes settings, health, and lifecycle routes and delegates to controllers', async () => {
    const mocks = {
      getSettings: vi.fn(async (ctx: any) => { ctx.body = { kind: 'settings' } }),
      updateSettings: vi.fn(async (ctx: any) => { ctx.body = { kind: 'updated' } }),
      health: vi.fn(async (ctx: any) => { ctx.body = { kind: 'health' } }),
      restartWorker: vi.fn(async (ctx: any) => { ctx.body = { kind: 'worker' } }),
      lifecycle: vi.fn(async (ctx: any) => { ctx.body = { kind: 'lifecycle' } }),
    }
    vi.doMock('../../packages/server/src/modules/studio/controllers/context-manager', () => mocks)
    const { contextManagerRoutes } = await import('../../packages/server/src/modules/studio/routes/context-manager')
    const paths = contextManagerRoutes.stack.map((entry: any) => entry.path)

    expect(paths).toEqual(expect.arrayContaining([
      '/api/studio/context-manager/settings',
      '/api/studio/context-manager/health',
      '/api/studio/context-manager/worker/restart',
      '/api/studio/context-manager/lifecycle/:action',
    ]))

    for (const [path, key, ctx] of [
      ['/api/studio/context-manager/settings', 'getSettings', { body: null }],
      ['/api/studio/context-manager/health', 'health', { body: null }],
      ['/api/studio/context-manager/worker/restart', 'restartWorker', { body: null }],
      ['/api/studio/context-manager/lifecycle/:action', 'lifecycle', { body: null, params: { action: 'start' } }],
    ] as const) {
      const layer = contextManagerRoutes.stack.find((entry: any) => entry.path === path)
      await layer.stack[0](ctx)
      expect(mocks[key]).toHaveBeenCalledWith(ctx)
    }
  })
})
