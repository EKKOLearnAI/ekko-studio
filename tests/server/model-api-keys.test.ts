import Koa from 'koa'
import { bodyParser } from '@koa/bodyparser'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import type { Server } from 'node:http'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

let db: DatabaseSync
const mocks = vi.hoisted(() => ({ models: vi.fn(), prepare: vi.fn(), profiles: ['work', 'default'] }))
vi.mock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({ getDb: () => db, getStoragePath: () => ':memory:' }))
vi.mock('../../packages/server/src/modules/studio/services/model-api/service', () => ({ listApiModels: mocks.models, prepareModelResponse: mocks.prepare }))
vi.mock('../../packages/server/src/modules/studio/public/profile-config', () => ({ getActiveProfileName: () => 'default', listProfileNamesFromDisk: () => mocks.profiles }))
vi.mock('../../packages/server/src/modules/studio/services/session-shares/http-access', () => ({ handleSessionShareHttp: async () => false }))
import { initAllHermesTables } from '../../packages/server/src/modules/studio/infrastructure/database/schemas'
import { userAuthMiddleware, signUserJwt, authenticateUserToken } from '../../packages/server/src/modules/studio/middleware/auth'
import { modelApiRoutes } from '../../packages/server/src/modules/studio/routes/model-api'

let server: Server
let base: string
const login = (id = 7, role = 'admin') => signUserJwt({ id, username: `user-${id}`, role } as any, 'test-secret')
const headers = (token = login(), profile?: string) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(profile ? { 'x-hermes-profile': profile } : {}) })
const call = (path: string, init?: RequestInit) => fetch(`${base}${path}`, init)
async function create(profile = 'work', token = login()) {
  return call('/api/studio/models/api-keys', { method: 'POST', headers: headers(token, profile), body: JSON.stringify({ name: 'Coding client' }) })
}
beforeEach(async () => {
  vi.clearAllMocks()
  vi.stubEnv('AUTH_JWT_SECRET', 'test-secret')
  db = new DatabaseSync(':memory:')
  initAllHermesTables()
  for (const id of [7, 8]) {
    db.prepare('INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, 1, 1)').run(id, `user-${id}`, 'unused')
    for (const profile of ['work', 'default']) db.prepare('INSERT INTO user_profiles (user_id, profile_name, created_at) VALUES (?, ?, 1)').run(id, profile)
  }
  mocks.profiles = ['work', 'default']
  mocks.models.mockResolvedValue({ object: 'list', data: [{ id: 'glm/glm-5.3' }] })
  mocks.prepare.mockResolvedValue({ id: 'resp_test', stream: false, create: async () => ({ object: 'response' }) })
  const app = new Koa().use(bodyParser())
  for (const middleware of userAuthMiddleware) app.use(middleware)
  app.use(modelApiRoutes.routes())
  app.use(ctx => { ctx.body = { reachedProtectedRoute: true } })
  server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  base = `http://127.0.0.1:${(server.address() as any).port}`
})
afterEach(async () => {
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
  db.close()
  vi.unstubAllEnvs()
})

it('returns a secret once, persists only its hash and scopes listing to the account regardless of Profile selectors', async () => {
  expect((await call('/api/studio/models/api-keys')).status).toBe(401)
  const response = await create()
  expect(response.status).toBe(201)
  expect(response.headers.get('cache-control')).toBe('no-store')
  const created = await response.json() as any
  expect(created.apiKey).toMatch(/^sk-ekko-[\w-]{43}$/)
  expect(created.key).toMatchObject({ name: 'Coding client', lastUsedAt: null })
  const row = db.prepare('SELECT * FROM model_api_keys').get() as any
  expect(row.token_hash).toBe(createHash('sha256').update(created.apiKey).digest('hex'))
  expect(JSON.stringify(row)).not.toContain(created.apiKey)
  initAllHermesTables() // restart/schema sync must preserve existing keys
  const listed = await (await call('/api/studio/models/api-keys', { headers: headers(login(), 'work') })).json()
  expect(listed).toEqual({ keys: [created.key] })
  expect(JSON.stringify(listed)).not.toContain(row.token_hash)
  expect(await (await call('/api/studio/models/api-keys', { headers: headers(login(), 'default') })).json()).toEqual({ keys: [created.key] })
  expect(await (await call('/api/studio/models/api-keys', { headers: headers(login(8), 'work') })).json()).toEqual({ keys: [] })
  expect((await call('/api/studio/models/api-keys', { method: 'POST', headers: headers(login(), 'work'), body: '{"name":" "}' })).status).toBe(400)
  expect((await call('/api/studio/models/api-keys', { method: 'POST', headers: headers(login(), 'work'), body: '{"name":"client","userId":8}' })).status).toBe(400)
})

it('aggregates accessible Profiles automatically and attributes inference to the key owner', async () => {
  const { apiKey, key } = await (await create()).json() as any
  const h = headers(apiKey)
  expect((await call('/api/ekko-studio/models/v1/models', { headers: h })).status).toBe(200)
  expect(mocks.models).toHaveBeenCalledWith(['default', 'work'])
  expect((await call('/api/ekko-studio/models/v1/responses', { method: 'POST', headers: h, body: '{"input":"Hi","model":"glm/glm-5.3","accountId":"8"}' })).status).toBe(200)
  expect(mocks.prepare).toHaveBeenCalledWith(expect.objectContaining({ accountId: '7', profiles: ['default', 'work'] }))
  const listed = await (await call('/api/studio/models/api-keys', { headers: headers(login(), 'work') })).json() as any
  expect(listed.keys[0].id).toBe(key.id)
  expect(listed.keys[0].lastUsedAt).toBeGreaterThan(0)
  expect(await authenticateUserToken(apiKey)).toBeNull() // Socket/App auth never accepts these keys
})

it('rejects UI/management endpoints, wrong methods and tokens in query strings', async () => {
  const { apiKey } = await (await create()).json() as any
  for (const [method, path] of [
    ['GET', '/api/studio/models/api-keys'], ['POST', '/api/studio/models/api-keys'], ['DELETE', '/api/studio/models/api-keys/any'],
    ['GET', '/api/ekko-studio/models/v1/responses'], ['POST', '/api/ekko-studio/models/v1/models'],
    ['GET', '/api/unrelated'], ['GET', '/api/ekko-studio/models/v1/models/extra'],
    ['GET', '/api/studio/models/v1/models'], ['POST', '/api/studio/models/v1/responses'],
  ]) {
    expect((await call(path, { method, headers: headers(apiKey) })).status).toBe(403)
  }
  expect((await call(`/api/ekko-studio/models/v1/models?token=${apiKey}`)).status).toBe(401)
  expect((await call('/api/ekko-studio/models/v1/models', { headers: headers('sk-ekko-invalid') })).status).toBe(401)
  expect(mocks.models).not.toHaveBeenCalled()
  expect(mocks.prepare).not.toHaveBeenCalled()
})

it('ignores Profile selectors and never adds inaccessible Profiles to the catalog', async () => {
  db.prepare("DELETE FROM user_profiles WHERE user_id = 7 AND profile_name = 'default'").run()
  const { apiKey } = await (await create()).json() as any
  expect((await call('/api/ekko-studio/models/v1/models', { headers: headers(apiKey, 'default') })).status).toBe(200)
  expect(mocks.models).toHaveBeenLastCalledWith(['work'])
  expect((await call('/api/ekko-studio/models/v1/models?profile=default', { headers: headers(apiKey, 'work') })).status).toBe(200)
  expect(mocks.models).toHaveBeenLastCalledWith(['work'])
  expect((await call('/api/ekko-studio/models/v1/responses', { method: 'POST', headers: headers(apiKey, 'work'), body: '{"profile":"default"}' })).status).toBe(200)
  expect(mocks.prepare).toHaveBeenCalledWith(expect.objectContaining({ profiles: ['work'] }))
  db.prepare("UPDATE users SET role = 'super_admin' WHERE id = 7").run()
  expect((await call('/api/ekko-studio/models/v1/models', { headers: headers(apiKey) })).status).toBe(200)
  expect(mocks.models).toHaveBeenLastCalledWith(['default', 'work'])
})

it('revokes only the current owner’s key and accepts revocation from any Profile context', async () => {
  const { apiKey, key } = await (await create()).json() as any
  expect((await call(`/api/studio/models/api-keys/${key.id}`, { method: 'DELETE', headers: headers(login(8), 'work') })).status).toBe(404)
  expect((await call('/api/ekko-studio/models/v1/models', { headers: headers(apiKey) })).status).toBe(200)
  expect((await call(`/api/studio/models/api-keys/${key.id}`, { method: 'DELETE', headers: headers(login(), 'default') })).status).toBe(200)
  expect((await call('/api/ekko-studio/models/v1/models', { headers: headers(apiKey) })).status).toBe(401)
})

it('rechecks live account status and accessible Profiles on every request', async () => {
  const { apiKey } = await (await create()).json() as any
  db.prepare("UPDATE users SET status = 'disabled' WHERE id = 7").run()
  expect((await call('/api/ekko-studio/models/v1/models', { headers: headers(apiKey) })).status).toBe(403)
  expect(mocks.models).not.toHaveBeenCalled()
  db.prepare("UPDATE users SET status = 'active' WHERE id = 7").run()
  db.prepare("DELETE FROM user_profiles WHERE user_id = 7 AND profile_name = 'work'").run()
  expect((await call('/api/ekko-studio/models/v1/models', { headers: headers(apiKey) })).status).toBe(200)
  expect(mocks.models).toHaveBeenLastCalledWith(['default'])
  mocks.profiles = ['work']
  expect((await call('/api/ekko-studio/models/v1/models', { headers: headers(apiKey) })).status).toBe(200)
  expect(mocks.models).toHaveBeenLastCalledWith([])
  db.prepare('DELETE FROM users WHERE id = 7').run()
  expect((await call('/api/ekko-studio/models/v1/models', { headers: headers(apiKey) })).status).toBe(403)
})
