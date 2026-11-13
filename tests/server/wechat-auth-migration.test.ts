import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import Koa from 'koa'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'

const PLATFORM = 'https://platform.example.test'
const APPROVAL_KEY = 'mock-platform-device-key'
const PASSWORD = 'local-account-password'
const nativeFetch = globalThis.fetch
let directory: string
let server: Server
let origin: string
let db: typeof import('../../packages/server/src/modules/studio/infrastructure/database/index')
let users: typeof import('../../packages/server/src/modules/studio/repositories/users-store')
let bindings: typeof import('../../packages/server/src/modules/studio/repositories/wechat-bindings-store')
let migration: typeof import('../../packages/server/src/modules/studio/services/auth/wechat-binding-migration')
let auth: typeof import('../../packages/server/src/modules/studio/middleware/auth')
let workspace: typeof import('../../packages/server/src/modules/studio/public/wechat-workspace')
let platformId = 42
let platformPhone = ''
let exists = new Set<string>()
const provision = vi.fn(async ({ platformProfileId }: { platformProfileId: number }) => {
  const name = `u_${platformProfileId}`
  exists.add(name)
  return name
})
const fetchPlatform = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input))
  expect(url.origin).toBe(PLATFORM)
  expect(init?.redirect).toBe('error')
  expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${APPROVAL_KEY}`)
  if (url.pathname === '/api/device/self') return Response.json({
    success: true, data: { id: platformId, username: `remote-${platformId}`, display_name: '已验证账号', phone: platformPhone },
  })
  if (url.pathname === '/v1/models') return Response.json({
    success: true, data: { data: [{ id: 'verified-model' }] },
  })
  throw new Error('Unexpected platform API')
})

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'studio-wechat-auth-'))
  vi.stubEnv('HERMES_WEB_UI_HOME', directory)
  vi.stubEnv('HERMES_WEB_UI_TEST_DB_DIR', directory)
  vi.stubEnv('AUTH_JWT_SECRET', 'test-only-signing-secret')
  vi.stubEnv('TOKEN_PLATFORM_BASE_URL', PLATFORM)
  db = await import('../../packages/server/src/modules/studio/infrastructure/database/index')
  const schemas = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
  schemas.initAllHermesTables()
  users = await import('../../packages/server/src/modules/studio/repositories/users-store')
  bindings = await import('../../packages/server/src/modules/studio/repositories/wechat-bindings-store')
  migration = await import('../../packages/server/src/modules/studio/services/auth/wechat-binding-migration')
  workspace = await import('../../packages/server/src/modules/studio/public/wechat-workspace')
  workspace.configureWeChatWorkspace({ exists: name => exists.has(name), ensure: provision })
  auth = await import('../../packages/server/src/modules/studio/middleware/auth')
  const { authPublicRoutes, authProtectedRoutes } = await import('../../packages/server/src/modules/studio/routes/auth')
  const { createRequestBodyParser } = await import('../../packages/server/src/modules/studio/middleware/request-body-parser')
  const app = new Koa()
  app.use(createRequestBodyParser())
  app.use(authPublicRoutes.routes())
  app.use(auth.requireUserJwt)
  app.use(auth.resolveUserProfile)
  app.use(authProtectedRoutes.routes())
  app.use(ctx => { if (ctx.path === '/api/test/profile') ctx.body = { profile: ctx.state.profile?.name } })
  server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})

beforeEach(() => {
  db.getDb()!.exec('DELETE FROM wechat_bindings; DELETE FROM user_profiles; DELETE FROM users;')
  platformId = 42
  platformPhone = ''
  exists = new Set()
  provision.mockClear()
  fetchPlatform.mockClear()
  vi.stubGlobal('fetch', fetchPlatform)
})

afterAll(async () => {
  server?.closeAllConnections()
  if (server) await new Promise<void>(resolve => server.close(() => resolve()))
  db?.closeDb()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  await rm(directory, { recursive: true, force: true })
})

function request(path: string, { token, method, body, profile }: { token?: string; method?: string; body?: unknown; profile?: string } = {}) {
  return nativeFetch(origin + path, {
    method: method || (body === undefined ? 'GET' : 'POST'),
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(profile ? { 'X-Hermes-Profile': profile } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

const approval = { api_base: PLATFORM, api_key: APPROVAL_KEY, device_id: 19, models: ['unverified-model'] }

function account(username: string, role: 'super_admin' | 'admin' = 'admin') {
  return users.createUser({ username, password: PASSWORD, role })!
}

function saveLegacyBinding(userId: number, id = platformId) {
  return bindings.upsertBindingByPlatformId({ userId, platformProfileId: id, apiBase: PLATFORM, apiKey: APPROVAL_KEY })
}

it('restores a legacy account on rescan and authorizes only its original workspace', async () => {
  const owner = account('tp_42')
  const other = account('unrelated')
  exists.add('u_42')
  await writeFile(join(directory, 'device-binding.json'), JSON.stringify({
    device_id: '19', api_base: PLATFORM, api_key: APPROVAL_KEY, profile_id: 42, display_name: 'legacy',
  }))
  await migration.migrateLegacyDeviceBinding()
  migration.reconcileWeChatWorkspaces()
  expect(users.userCanAccessProfile(owner.id, 'u_42')).toBe(true)
  expect(users.userCanAccessProfile(other.id, 'u_42')).toBe(false)
  expect(users.getUserActiveProfile(owner.id)).toBe('u_42')

  const response = await request('/api/auth/device-login', { body: approval })
  expect(response.status).toBe(200)
  const signedIn = await response.json()
  expect(signedIn).toMatchObject({ userId: owner.id, activeProfile: 'u_42', profiles: ['u_42'],
    user: { username: 'tp_42', role: 'admin', bound_models: ['verified-model'] } })
  expect(JSON.stringify(signedIn)).not.toContain(APPROVAL_KEY)
  expect((await request('/api/test/profile', { token: signedIn.token })).status).toBe(200)
  expect(await (await request('/api/test/profile', { token: signedIn.token })).json()).toEqual({ profile: 'u_42' })
  expect((await request('/api/test/profile', { token: await auth.issueUserJwt(other), profile: 'u_42' })).status).toBe(403)
})

it('never claims a legacy workspace assigned to another local account', () => {
  const legacy = account('tp_42')
  const other = users.createUser({ username: 'workspace-owner', password: PASSWORD, profiles: ['u_42'] })!
  exists.add('u_42')
  saveLegacyBinding(legacy.id)
  migration.reconcileWeChatWorkspaces()
  expect(users.userCanAccessProfile(legacy.id, 'u_42')).toBe(false)
  expect(users.userCanAccessProfile(other.id, 'u_42')).toBe(true)
})

it('requires proof before binding or inspecting a saved account and rejects caller-chosen origins', async () => {
  const first = account('owner')
  const second = account('signed-in')
  saveLegacyBinding(first.id)
  const token = await auth.issueUserJwt(second)

  expect((await request('/api/auth/device-login/restore', { body: { platform_profile_id: 42 } })).status).toBe(401)
  expect((await request('/api/auth/device-binding')).status).toBe(401)
  expect((await request('/api/auth/device-login/bind-existing', { body: { user_id: first.id } })).status).toBe(401)
  expect((await request('/api/auth/device-login', { body: { ...approval, api_base: 'https://different.example.test' } })).status).toBe(400)
  expect(fetchPlatform).not.toHaveBeenCalled()
  expect((await request('/api/auth/device-login', { token, body: approval })).status).toBe(409)
  expect((await request('/api/auth/device-login/bind-by-credentials', { token,
    body: { ...approval, identifier: first.username, password: PASSWORD } })).status).toBe(401)
  expect(bindings.findBindingByPlatformId(42)?.user_id).toBe(first.id)
  expect(await (await request('/api/auth/device-binding', { token })).json()).toEqual({ bound: false, accounts: [] })
})

it('allows only one local owner while a new WeChat workspace is being provisioned', async () => {
  account('operator', 'super_admin')
  const first = account('first')
  const second = account('second')
  let finish: () => void = () => {}
  let started: () => void = () => {}
  const entered = new Promise<void>(resolve => { started = resolve })
  provision.mockImplementationOnce(async () => {
    started()
    await new Promise<void>(resolve => { finish = resolve })
    return 'u_42'
  })
  const bind = (username: string) => request('/api/auth/device-login/bind-by-credentials', {
    body: { ...approval, identifier: username, password: PASSWORD },
  })
  const inFlight = bind(first.username)
  await entered
  try {
    expect((await bind(second.username)).status).toBe(409)
    expect(bindings.findBindingByPlatformId(42)?.user_id).toBe(first.id)
  } finally {
    finish()
  }
  expect((await inFlight).status).toBe(200)
  expect(users.userCanAccessProfile(first.id, 'u_42')).toBe(true)
  expect(users.userCanAccessProfile(second.id, 'u_42')).toBe(false)
})

it('creates a regular local account only after admin setup and preserves it on verified unlink', async () => {
  platformPhone = '+86 13812345678'
  const create = () => request('/api/auth/device-login/create-user', { body: { ...approval, username: 'new-user', password: PASSWORD } })
  expect((await create()).status).toBe(409)
  account('operator', 'super_admin')
  const response = await create()
  expect(response.status).toBe(200)
  const signedIn = await response.json()
  expect(signedIn).toMatchObject({ user: { role: 'admin', phone_number: '13812345678', wechat_bound: true }, activeProfile: 'u_42' })
  expect((await request('/api/auth/device-binding', { token: signedIn.token, method: 'DELETE' })).status).toBe(401)
  expect((await request('/api/auth/device-binding', { token: signedIn.token, method: 'DELETE', body: { currentPassword: PASSWORD } })).status).toBe(200)
  expect(users.findUserById(signedIn.userId)).toMatchObject({ username: 'new-user', wechat_bound: 0 })
  expect(users.userCanAccessProfile(signedIn.userId, 'u_42')).toBe(true)
  expect(bindings.findBindingByPlatformId(42)).toBeNull()
})

it('lets a verified legacy scan set the first password once, but rejects password setup with a normal token', async () => {
  const legacy = account('tp_42')
  saveLegacyBinding(legacy.id)
  const set = (token: string) => request('/api/auth/set-password', { token, body: { newPassword: 'new-user-known-password' } })
  expect((await set(await auth.issueUserJwt(legacy))).status).toBe(403)
  const signedIn = await (await request('/api/auth/device-login', { body: approval })).json()
  expect(await (await request('/api/auth/me', { token: signedIn.token })).json()).toMatchObject({ user: { requiresPasswordSetup: true } })
  expect((await set(signedIn.token)).status).toBe(200)
  expect((await set(signedIn.token)).status).toBe(403)
  expect((await request('/api/auth/login', { body: { username: legacy.username, password: 'new-user-known-password' } })).status).toBe(200)
})
