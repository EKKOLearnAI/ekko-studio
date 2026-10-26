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
  return call('/api/studio/models/api-keys', { method: 'POST', headers: headers(token, profile), body: JSON.stringify({ name: 'Coding client', models: ['glm/glm-5.3'] }) })
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
  mocks.models.mockResolvedValue({ object: 'list', data: [{ id: 'glm/glm-5.3', responses_supported: true }, { id: 'deepseek/model', responses_supported: true }, { id: 'bedrock/claude', responses_supported: false }] })
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
  expect(created.key).toMatchObject({ name: 'Coding client', models: ['glm/glm-5.3'], lastUsedAt: null })
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
  expect(mocks.models).toHaveBeenCalledWith(['default', 'work'], ['glm/glm-5.3'])
  expect((await call('/api/ekko-studio/models/v1/responses', { method: 'POST', headers: h, body: '{"input":"Hi","model":"glm/glm-5.3","accountId":"8"}' })).status).toBe(200)
  expect(mocks.prepare).toHaveBeenCalledWith(expect.objectContaining({ accountId: '7', profiles: ['default', 'work'] }))
  const listed = await (await call('/api/studio/models/api-keys', { headers: headers(login(), 'work') })).json() as any
  expect(listed.keys[0].id).toBe(key.id)
  expect(listed.keys[0].lastUsedAt).toBeGreaterThan(0)
  expect(await authenticateUserToken(apiKey)).toBeNull() // Socket/App auth never accepts these keys
})

it('rejects UI/management endpoints, wrong methods and tokens in query strings', async () => {
  const { apiKey } = await (await create()).json() as any
  mocks.models.mockClear()
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
  expect(mocks.models).toHaveBeenLastCalledWith(['work'], ['glm/glm-5.3'])
  expect((await call('/api/ekko-studio/models/v1/models?profile=default', { headers: headers(apiKey, 'work') })).status).toBe(200)
  expect(mocks.models).toHaveBeenLastCalledWith(['work'], ['glm/glm-5.3'])
  expect((await call('/api/ekko-studio/models/v1/responses', { method: 'POST', headers: headers(apiKey, 'work'), body: '{"profile":"default"}' })).status).toBe(200)
  expect(mocks.prepare).toHaveBeenCalledWith(expect.objectContaining({ profiles: ['work'] }))
  db.prepare("UPDATE users SET role = 'super_admin' WHERE id = 7").run()
  expect((await call('/api/ekko-studio/models/v1/models', { headers: headers(apiKey) })).status).toBe(200)
  expect(mocks.models).toHaveBeenLastCalledWith(['default', 'work'], ['glm/glm-5.3'])
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
  mocks.models.mockClear()
  db.prepare("UPDATE users SET status = 'disabled' WHERE id = 7").run()
  expect((await call('/api/ekko-studio/models/v1/models', { headers: headers(apiKey) })).status).toBe(403)
  expect(mocks.models).not.toHaveBeenCalled()
  db.prepare("UPDATE users SET status = 'active' WHERE id = 7").run()
  db.prepare("DELETE FROM user_profiles WHERE user_id = 7 AND profile_name = 'work'").run()
  expect((await call('/api/ekko-studio/models/v1/models', { headers: headers(apiKey) })).status).toBe(200)
  expect(mocks.models).toHaveBeenLastCalledWith(['default'], ['glm/glm-5.3'])
  mocks.profiles = ['work']
  expect((await call('/api/ekko-studio/models/v1/models', { headers: headers(apiKey) })).status).toBe(200)
  expect(mocks.models).toHaveBeenLastCalledWith([], ['glm/glm-5.3'])
  db.prepare('DELETE FROM users WHERE id = 7').run()
  expect((await call('/api/ekko-studio/models/v1/models', { headers: headers(apiKey) })).status).toBe(403)
})


it('requires an explicit nonempty callable model selection for every new key', async () => {
  for (const models of [undefined, [], '*', [null], [''], ['unknown/model'], ['bedrock/claude']]) {
    const result = await call('/api/studio/models/api-keys', {
      method: 'POST', headers: headers(), body: JSON.stringify({ name: 'client', models }),
    })
    expect(result.status).toBe(400)
    expect(db.prepare('SELECT COUNT(*) AS count FROM model_api_keys').get()).toMatchObject({ count: 0 })
  }
  const response = await call('/api/studio/models/api-keys', {
    method: 'POST', headers: headers(), body: JSON.stringify({ name: 'client', models: ['glm/glm-5.3', 'glm/glm-5.3'] }),
  })
  expect(response.status).toBe(201)
  expect((await response.json() as any).key.models).toEqual(['glm/glm-5.3'])
})

it('edits an owned key without rotating the secret and applies its new models on the next request', async () => {
  const { apiKey, key } = await (await create()).json() as any
  const original = db.prepare('SELECT * FROM model_api_keys').get() as any
  const response = await call(`/api/studio/models/api-keys/${key.id}`, {
    method: 'PATCH', headers: headers(login(), 'work'),
    body: JSON.stringify({ name: ' Renamed ', models: ['deepseek/model'] }),
  })
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(await response.json()).toEqual({ key: { ...key, name: 'Renamed', models: ['deepseek/model'] } })
  const updated = db.prepare('SELECT * FROM model_api_keys').get() as any
  expect(updated.token_hash).toBe(original.token_hash)
  expect(updated.created_at).toBe(original.created_at)
  expect(updated.preview).toBe(original.preview)
  expect(JSON.parse(updated.models_json)).toEqual(['deepseek/model'])
  expect((await call('/api/ekko-studio/models/v1/models', { headers: headers(apiKey) })).status).toBe(200)
  expect(mocks.models).toHaveBeenLastCalledWith(['default', 'work'], ['deepseek/model'])
  await call('/api/ekko-studio/models/v1/responses', {
    method: 'POST', headers: headers(apiKey), body: JSON.stringify({ model: 'deepseek/model', input: 'hi' }),
  })
  expect(mocks.prepare).toHaveBeenLastCalledWith(expect.objectContaining({ allowedModels: ['deepseek/model'], accountId: '7' }))
})

it('rejects another owner, model-key authentication and invalid edits without changing the key', async () => {
  const { apiKey, key } = await (await create()).json() as any
  const original = db.prepare('SELECT * FROM model_api_keys').get()
  const path = `/api/studio/models/api-keys/${key.id}`
  for (const [token, body, status] of [
    [login(8), { name: 'stolen', models: ['deepseek/model'] }, 404],
    [apiKey, { name: 'self', models: ['deepseek/model'] }, 403],
    [login(), { name: 'bad', models: [] }, 400],
    [login(), { name: 'bad', models: ['unknown/model'] }, 400],
    [login(), { name: 'bad', models: ['bedrock/claude'] }, 400],
    [login(), { name: '', models: ['glm/glm-5.3'] }, 400],
    [login(), { name: 'bad', models: ['glm/glm-5.3'], userId: 8 }, 400],
  ] as const) {
    expect((await call(path, { method: 'PATCH', headers: headers(token), body: JSON.stringify(body) })).status).toBe(status)
    expect(db.prepare('SELECT * FROM model_api_keys').get()).toEqual(original)
  }
})

it('creates, lists and edits USD budgets without resetting settled spend or returning a new secret', async () => {
  const response = await call('/api/studio/models/api-keys', {
    method: 'POST', headers: headers(), body: JSON.stringify({ name: 'Budget client', models: ['glm/glm-5.3'], budgetUsd: 12.5 }),
  })
  expect(response.status).toBe(201)
  const { key } = await response.json() as any
  expect(key).toMatchObject({ budgetUsd: 12.5, spentUsd: 0, unpricedRequests: 0 })
  db.prepare("INSERT INTO session_usage (session_id, account_id, model_api_key_id, origin, run_id, cost_usd) VALUES ('', '7', ?, 'external', 'paid', 1.25)").run(key.id)
  for (const budgetUsd of [0.5, 20, 0, null]) {
    const updated = await call(`/api/studio/models/api-keys/${key.id}`, { method: 'PATCH', headers: headers(), body: JSON.stringify({ name: 'Edited', models: key.models, budgetUsd }) })
    expect(updated.status).toBe(200)
    const value = await updated.json() as any
    expect(value.key).toMatchObject({ budgetUsd, spentUsd: 1.25 })
    expect(value.apiKey).toBeUndefined()
  }
  const listed = await (await call('/api/studio/models/api-keys', { headers: headers() })).json() as any
  expect(listed.keys[0]).toMatchObject({ budgetUsd: null, spentUsd: 1.25 })
})

it('rejects invalid or client-supplied spend values and preserves the original settings', async () => {
  const { key } = await (await create()).json() as any
  expect(key.budgetUsd).toBeNull()
  const original = db.prepare('SELECT * FROM model_api_keys').get()
  for (const budgetUsd of [-1, 1000000.01, '5', false, {}, []]) {
    const result = await call(`/api/studio/models/api-keys/${key.id}`, {
      method: 'PATCH', headers: headers(), body: JSON.stringify({ name: key.name, models: key.models, budgetUsd }),
    })
    expect(result.status).toBe(400)
    expect((await result.json() as any).error.param).toBe('budgetUsd')
    expect(db.prepare('SELECT * FROM model_api_keys').get()).toEqual(original)
  }
  expect((await call(`/api/studio/models/api-keys/${key.id}`, {
    method: 'PATCH', headers: headers(), body: JSON.stringify({ name: key.name, models: key.models, spentUsd: 0 }),
  })).status).toBe(400)
})
