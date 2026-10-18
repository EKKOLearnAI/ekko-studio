import Koa from 'koa'
import { bodyParser } from '@koa/bodyparser'
import type { Server } from 'node:http'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ prepare: vi.fn(), models: vi.fn(), user: { id: 7, username: 'tester', role: 'user', status: 'active' }, profiles: ['work'] }))
vi.mock('../../packages/server/src/modules/studio/services/model-api/service', () => ({ prepareModelResponse: mocks.prepare, listApiModels: mocks.models }))
vi.mock('../../packages/server/src/modules/studio/public/profile-config', () => ({ getActiveProfileName: () => 'default', listProfileNamesFromDisk: () => ['work', 'default'] }))
vi.mock('../../packages/server/src/modules/studio/repositories/users-store', () => ({
  findUserById: () => mocks.user, listUserProfiles: () => mocks.profiles.map(profile_name => ({ profile_name })),
  userCanAccessProfile: (_id: number, profile: string) => mocks.profiles.includes(profile), touchUserLogin: vi.fn(),
}))
vi.mock('../../packages/server/src/modules/studio/services/auth/token-auth', () => ({ getToken: async () => 'test-only-secret' }))
vi.mock('../../packages/server/src/modules/studio/services/session-shares/http-access', () => ({ handleSessionShareHttp: async () => false }))
vi.mock('../../packages/server/src/modules/studio/repositories/app-connections-store', () => ({ isAppConnectionTokenActive: () => false }))
import { modelApiRoutes } from '../../packages/server/src/modules/studio/routes/model-api'
import { issueUserJwt, userAuthMiddleware } from '../../packages/server/src/modules/studio/middleware/auth'

let server: Server
let url: string
let token: string
beforeEach(async () => {
  vi.clearAllMocks()
  vi.stubEnv('AUTH_JWT_SECRET', 'test-only-secret')
  mocks.profiles = ['work']
  mocks.models.mockResolvedValue({ object: 'list', data: [{ id: 'glm/glm-5.3' }] })
  const app = new Koa().use(bodyParser())
  for (const middleware of userAuthMiddleware) app.use(middleware)
  app.use(modelApiRoutes.routes())
  server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  url = `http://127.0.0.1:${(server.address() as any).port}/api/ekko-studio/models/v1`
  token = await issueUserJwt(mocks.user as any)
})
afterEach(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); vi.unstubAllEnvs() })
const headers = () => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' })

it('requires authentication and Profile membership before resolving models or upstream credentials', async () => {
  expect((await fetch(`${url}/models`)).status).toBe(401)
  expect(mocks.models).not.toHaveBeenCalled()
  expect(mocks.prepare).not.toHaveBeenCalled()
  expect(await (await fetch(`${url}/models`, { headers: headers() })).json()).toMatchObject({ object: 'list' })
  expect(mocks.models).toHaveBeenCalledWith(['work'])
  mocks.profiles = ['work', 'default']
  expect((await fetch(`${url}/models`, { headers: { ...headers(), 'x-hermes-profile': 'other' } })).status).toBe(200)
  expect(mocks.models).toHaveBeenLastCalledWith(['default', 'work'])
})

it('returns JSON with server-owned account attribution and a request ID', async () => {
  mocks.prepare.mockResolvedValue({ id: 'resp_1', stream: false, create: async () => ({ id: 'resp_1', object: 'response', output: [] }) })
  const response = await fetch(`${url}/responses`, { method: 'POST', headers: headers(), body: JSON.stringify({ model: 'glm/glm-5.3', input: 'Hi', accountId: 'other' }) })
  expect(response.status).toBe(200)
  expect(response.headers.get('x-request-id')).toBe('resp_1')
  expect(await response.json()).toMatchObject({ object: 'response' })
  expect(mocks.prepare).toHaveBeenCalledWith(expect.objectContaining({ accountId: '7', profiles: ['work'] }))
})

it('streams named SSE events and aborts upstream work when the HTTP client disconnects', async () => {
  let signal: AbortSignal | undefined
  const closed = vi.fn()
  mocks.prepare.mockImplementation(async input => {
    signal = input.signal
    return { id: 'resp_2', stream: true, async *events() {
      try {
        yield { type: 'response.created', sequence_number: 0, response: { id: 'resp_2' } }
        await new Promise<void>(resolve => signal!.addEventListener('abort', () => resolve(), { once: true }))
      } finally { closed() }
    } }
  })
  const abort = new AbortController()
  const response = await fetch(`${url}/responses`, { method: 'POST', headers: headers(), body: '{}', signal: abort.signal })
  expect(response.headers.get('content-type')).toContain('text/event-stream')
  const first = await response.body!.getReader().read()
  expect(new TextDecoder().decode(first.value)).toContain('event: response.created\ndata: ')
  abort.abort()
  await vi.waitFor(() => expect(signal?.aborted).toBe(true))
  await vi.waitFor(() => expect(closed).toHaveBeenCalledOnce())
})
