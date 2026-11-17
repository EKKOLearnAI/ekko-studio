import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let home: string
let server: Server
let port: number
let account: any
let configApi: any
let runtime: any
let service: any
let compat: any
let controller: any
let nextUser = 8100
let source = ''
let tokenStatus = 400
let modelStatus = 200
const requests: string[] = []
const denied: string[] = []
const originalFetch = globalThis.fetch
const taskEnvironmentKeys = ['HERMES_WEB_UI_HOME', 'HERMES_WEBUI_STATE_DIR', 'HERMES_HOME', 'HERMES_WEB_UI_DISABLE_GATEWAY_AUTOSTART', 'HERMES_WEB_UI_DISABLE_MCP_AUTOINJECT'] as const
const originalEnvironment = Object.fromEntries(taskEnvironmentKeys.map(key => [key, process.env[key]]))
const tokenEndpoints = new Set([
  'https://platform.claude.com/v1/oauth/token',
  'https://console.anthropic.com/v1/oauth/token',
])

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'ekko-refresh-isolation-'))
  process.env.HERMES_WEB_UI_HOME = home
  process.env.HERMES_WEBUI_STATE_DIR = home
  process.env.HERMES_HOME = join(home, 'empty-hermes')
  process.env.HERMES_WEB_UI_DISABLE_GATEWAY_AUTOSTART = 'true'
  process.env.HERMES_WEB_UI_DISABLE_MCP_AUTOINJECT = 'true'
  server = createServer((req, res) => {
    requests.push(req.url || '')
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/token') {
      res.statusCode = tokenStatus
      res.end(JSON.stringify(tokenStatus === 200
        ? { access_token: 'synthetic-refreshed', refresh_token: 'synthetic-refresh', expires_in: 3600 }
        : { error: 'invalid_grant', error_description: 'synthetic refresh token expired' }))
    } else {
      res.statusCode = modelStatus
      res.end(JSON.stringify(modelStatus === 200
        ? { data: [{ id: 'fixture-old' }, { id: 'fixture-new' }] }
        : { error: 'synthetic model authorization refused' }))
    }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as any).port
  globalThis.fetch = ((input: any, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
    // Real OAuth resolution still builds its normal request; only its HTTP
    // transport is redirected to this local synthetic token server.
    if (tokenEndpoints.has(url.toString())) return originalFetch(`http://127.0.0.1:${port}/token`, init)
    if (url.hostname === '127.0.0.1' && url.port === String(port)) return originalFetch(input, init)
    denied.push(url.origin)
    throw new Error('Non-fixture network prohibited')
  }) as typeof fetch
  account = await import('../../packages/server/src/modules/studio/public/provider-account')
  account.configureProviderSources({ profileDir: () => source, profiles: () => ['default'], environmentKeys: [] })
  configApi = await import('../../packages/server/src/modules/studio/public/provider-config')
  compat = await import('../../packages/server/src/modules/studio/contracts/provider-compat')
  await import('../../packages/server/src/bootstrap/authorized-provider-adapter')
  runtime = await import('../../packages/server/src/modules/studio/public/authorized-provider-runtime')
  service = await import('../../packages/server/src/modules/hermes/services/providers/provider-model-refresh')
  controller = await import('../../packages/server/src/modules/hermes/controllers/providers')
})
beforeEach(() => { requests.length = 0; tokenStatus = 400; modelStatus = 200 })
afterAll(async () => {
  globalThis.fetch = originalFetch
  if (server) await new Promise<void>(resolve => server.close(() => resolve()))
  try {
    expect(denied).toEqual([])
  } finally {
    if (home) await rm(home, { recursive: true, force: true })
    for (const key of taskEnvironmentKeys) {
      if (originalEnvironment[key] === undefined) delete process.env[key]
      else process.env[key] = originalEnvironment[key]
    }
  }
})

async function fixture(expired: boolean) {
  const user = nextUser++
  source = join(home, `source-${user}`)
  await mkdir(source, { recursive: true })
  const entry = (name: string, path: string, extra: any) => ({ name, base_url: `http://127.0.0.1:${port}/${path}/v1`, model: 'fixture-old', models: { 'fixture-old': {} }, ...extra })
  await writeFile(join(source, 'config.yaml'), JSON.stringify({
    model: { provider: 'custom:fixture-good', default: 'fixture-old' },
    providers: {
      good: entry('Fixture Good', 'good', { api_key: 'synthetic-api-key', api_mode: 'chat_completions' }),
      'claude-oauth': entry('Fixture OAuth', 'oauth', { api_mode: 'anthropic_messages' }),
    },
  }))
  await writeFile(join(source, '.env'), '')
  await writeFile(join(source, 'auth.json'), JSON.stringify({ providers: { 'claude-oauth': {
    base_url: `http://127.0.0.1:${port}/oauth/v1`,
    tokens: { access_token: expired ? 'synthetic-expired' : 'synthetic-fresh', refresh_token: 'synthetic-refresh', expires_at_ms: Date.now() + (expired ? -3_600_000 : 3_600_000) },
  } } }))
  return account.withProviderAccount(user, async () => {
    const providers = compat.getCompatibleCustomProviders(await configApi.readConfigYamlForProfile('default'))
    const good = providers.find((p: any) => p.name === 'Fixture Good')
    const oauth = providers.find((p: any) => p.name === 'Fixture OAuth')
    expect(good?.catalog_provider).toBeTruthy()
    expect(oauth?.auth_provider).toBe('claude-oauth')
    return { user, good, oauth, run: (fn: () => any) => account.withProviderAccount(user, fn, 'default'), catalog: join(account.providerAccountHome(), 'catalog.json'), auth: join(account.providerCredentialDir(oauth.auth_scope), 'auth.json') }
  }, 'default')
}
async function oauthCredentials(f: any) {
  return f.run(() => runtime.resolveAuthorizedProviderRuntimeCredentials({ profile: 'default', provider: 'claude-oauth', credentialScope: f.oauth.auth_scope }))
}
async function refresh(f: any, id: string, confirm = false) {
  return f.run(() => service.refreshProviderModels('default', id, { confirm }))
}

it('refreshes a normal provider despite an unrelated expired OAuth provider', async () => {
  const f = await fixture(true)
  // Establish actual expiry and refresh failure first; do not inject a resolver error.
  await expect(oauthCredentials(f)).rejects.toMatchObject({ code: 'CLAUDE_REFRESH_FAILED', reloginRequired: true })
  expect(requests).toContain('/token')
  requests.length = 0
  const authBefore = await readFile(f.auth, 'utf8')
  const ctx: any = { params: { poolKey: encodeURIComponent(f.good.catalog_provider) }, request: { body: { confirm: false } }, state: { profile: { name: 'default' }, user: { id: f.user, username: 'synthetic', role: 'admin' } }, status: 200 }
  await f.run(() => controller.refreshModels(ctx))
  expect(ctx.status).toBe(200)
  expect(ctx.body).toMatchObject({ success: true, applied: true, models: ['fixture-old', 'fixture-new'] })
  expect(requests).toEqual(['/good/v1/models'])
  expect(await readFile(f.auth, 'utf8')).toBe(authBefore)
})
it('preserves a valid OAuth credential while refreshing a normal provider', async () => {
  const f = await fixture(false)
  expect((await oauthCredentials(f)).apiKey).toBe('synthetic-fresh')
  expect(requests).not.toContain('/token')
  const result = await refresh(f, f.good.catalog_provider)
  expect(result.applied).toBe(true)
  expect(result.models).toEqual(['fixture-old', 'fixture-new'])
})
it('still rejects when the requested OAuth provider itself cannot refresh its expired credentials', async () => {
  const f = await fixture(true)
  await expect(refresh(f, f.oauth.catalog_provider, true)).rejects.toMatchObject({ code: 'CLAUDE_REFRESH_FAILED', reloginRequired: true })
  expect(requests).toContain('/token')
  expect(requests).not.toContain('/oauth/v1/models')
  await expect(readFile(f.catalog)).rejects.toMatchObject({ code: 'ENOENT' })
})
it('refreshes the requested valid OAuth provider through its real catalog fetcher', async () => {
  const f = await fixture(false)
  const result = await refresh(f, f.oauth.catalog_provider, true)
  expect(result.applied).toBe(true)
  expect(result.models).toEqual(['fixture-old', 'fixture-new'])
  expect(requests).toEqual(['/oauth/v1/models'])
})
it('keeps legitimate OAuth token renewal for the requested provider', async () => {
  const f = await fixture(true)
  tokenStatus = 200
  const result = await refresh(f, f.oauth.catalog_provider, true)
  expect(result.applied).toBe(true)
  expect(requests).toContain('/token')
  expect(requests).toContain('/oauth/v1/models')
  expect((await oauthCredentials(f)).apiKey).toBe('synthetic-refreshed')
})
it('does not hide a model endpoint authorization failure on the requested API provider', async () => {
  const f = await fixture(true)
  modelStatus = 401
  await expect(refresh(f, f.good.catalog_provider)).rejects.toMatchObject({ code: 'PROVIDER_TEST_FAILED' })
  expect(requests).toEqual(['/good/v1/models'])
  await expect(readFile(f.catalog)).rejects.toMatchObject({ code: 'ENOENT' })
})
it('preserves restore behavior for the requested API provider with unrelated expired OAuth', async () => {
  const f = await fixture(true)
  const updated = await refresh(f, f.good.catalog_provider)
  expect(updated.restore_available).toBe(true)
  requests.length = 0
  const restored = await f.run(() => service.restoreProviderModels('default', f.good.catalog_provider))
  expect(restored.applied).toBe(true)
  expect(restored.models).toEqual(['fixture-old'])
  expect(restored.restore_available).toBe(false)
  expect(requests).toEqual([])
})
