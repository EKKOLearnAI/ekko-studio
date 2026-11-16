import { beforeEach, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ active: true, access: true, internal: true, handled: vi.fn(), touched: vi.fn() }))
vi.mock('../../packages/server/src/modules/studio/services/auth/token-auth', () => ({ getToken: async () => 'fixture-jwt-secret' }))
vi.mock('../../packages/server/src/modules/studio/services/session-shares/http-access', () => ({ handleSessionShareHttp: async () => false }))
vi.mock('../../packages/server/src/modules/studio/services/auth/run-mcp-credentials', () => ({ runMcpCredentials: { recognizes: () => false } }))
vi.mock('../../packages/server/src/modules/studio/repositories/users-store', () => ({
  findUserById: () => ({ id: 1, username: 'fixture', role: 'user', status: fixture.active ? 'active' : 'disabled' }),
  listUserProfiles: () => [{ profile_name: 'work' }], userCanAccessProfile: () => fixture.access,
}))
vi.mock('../../packages/server/src/modules/studio/public/provider-account', () => ({
  authenticateInternalModelCredential: async () => fixture.internal ? { userId: 1, profile: 'work' } : null,
  withProviderAccount: (_id: unknown, operation: () => unknown) => operation(),
}))
vi.mock('../../packages/server/src/modules/studio/services/model-api/keys', () => ({
  MODEL_API_KEY_PREFIX: 'sk-ekko-', findModelApiKey: (token: string) => token === 'sk-ekko-valid' ? { id: 'key-1', userId: 1, models: ['deepseek/model'] } : null,
  touchModelApiKey: fixture.touched,
}))

import { requireUserJwt, resolveUserProfile } from '../../packages/server/src/modules/studio/middleware/auth'
import { configureModelGatewayAdapters } from '../../packages/server/src/modules/studio/public/model-gateway-adapters'
import { modelGatewayMiddleware } from '../../packages/server/src/modules/studio/middleware/model-gateway'
import { LEGACY_PROVIDER_CREDENTIAL } from '../../packages/server/src/modules/studio/contracts/legacy-provider-credential'

const ctx = (path: string, token: string, header = 'authorization', method = 'POST'): any => ({
  path, method, state: {}, query: {}, headers: { [header]: header === 'authorization' ? `Bearer ${token}` : token },
  request: { body: {} }, get(name: string) { return this.headers[name] || '' },
})
beforeEach(() => {
  vi.clearAllMocks()
  fixture.active = fixture.access = fixture.internal = true
  configureModelGatewayAdapters({
    authenticate: token => token === 'hwui_run' ? { userId: 1, profile: 'work', model: 'model', provider: 'deepseek' } : null,
    handle: fixture.handled, register: () => { throw new Error('not used') },
  })
})

it('never authenticates the non-secret legacy readiness marker', async () => {
  const next = vi.fn()
  const request = ctx('/api/ekko-studio/models/v1/responses', LEGACY_PROVIDER_CREDENTIAL)
  await requireUserJwt(request, next)
  expect(request.status).toBe(401)
  expect(next).not.toHaveBeenCalled()
  expect(fixture.handled).not.toHaveBeenCalled()
})

it.each([
  ['/v1/responses', 'authorization'], ['/v1/chat/completions', 'authorization'],
  ['/v1/messages', 'x-api-key'], ['/v1/messages/count_tokens', 'x-api-key'],
  ['/v1beta/models/deepseek/model:generateContent', 'x-goog-api-key'],
])('authenticates sharing credentials with the native headers on %s', async (path, header) => {
  const request = ctx(`/api/ekko-studio/models${path}`, 'sk-ekko-valid', header)
  const next = vi.fn()
  await requireUserJwt(request, next)
  expect(next).toHaveBeenCalledOnce()
  expect(request.state.modelApiKey).toEqual({ id: 'key-1', models: ['deepseek/model'] })
})

it('limits internal credentials to inference and keeps the credential-bound Profile', async () => {
  const request = ctx('/api/ekko-studio/models/v1/responses', 'studio_model_valid')
  request.headers['x-hermes-profile'] = 'other-user-profile'
  await requireUserJwt(request, async () => resolveUserProfile(request, async () => {}))
  expect(request.state.profile.name).toBe('work')
  const management = ctx('/api/studio/models/api-keys', 'studio_model_valid')
  const next = vi.fn()
  await requireUserJwt(management, next)
  expect(management.status).toBe(401)
  expect(next).not.toHaveBeenCalled()
})

it('rejects invalid, revoked and disabled-owner sharing credentials before dispatch', async () => {
  const next = vi.fn()
  await requireUserJwt(ctx('/api/ekko-studio/models/v1/messages', 'sk-ekko-revoked'), next)
  fixture.active = false
  await requireUserJwt(ctx('/api/ekko-studio/models/v1/messages', 'sk-ekko-valid'), next)
  expect(next).not.toHaveBeenCalled()
})

it('uses the common gateway for run credentials and honors Profile revocation', async () => {
  const next = vi.fn()
  const request = ctx('/api/ekko-studio/models/v1/messages', 'hwui_run', 'x-api-key')
  await modelGatewayMiddleware(request, next)
  expect(fixture.handled).toHaveBeenCalledWith('anthropic_messages', request)
  expect(request.state.user).toMatchObject({ id: 1, username: 'fixture', role: 'user' })
  expect(request.state.profile).toEqual({ name: 'work' })
  expect(next).not.toHaveBeenCalled()
  fixture.access = false
  await modelGatewayMiddleware(request, next)
  expect(request.status).toBe(403)
  expect(fixture.handled).toHaveBeenCalledOnce()
})

it('serves run-scoped discovery and accepts old generated URLs through the same handler', async () => {
  const request = ctx('/api/ekko-studio/models/v1/models', 'hwui_run', 'authorization', 'GET')
  await modelGatewayMiddleware(request, vi.fn())
  expect(request.body.data.map((model: any) => model.id)).toEqual(['model'])
  const legacy = ctx('/api/codex-proxy/old-key/v1/responses', 'hwui_run')
  await modelGatewayMiddleware(legacy, vi.fn())
  expect(fixture.handled).toHaveBeenCalledWith('codex_responses', legacy)
  const management = ctx('/api/studio/models/api-keys', 'hwui_run')
  const next = vi.fn()
  await modelGatewayMiddleware(management, next)
  expect(next).toHaveBeenCalledOnce()
})

it.each([
  ['/api/codex-proxy/legacy/v1/responses', 'authorization', 'codex_responses'],
  ['/api/codex-proxy/legacy/v1/chat/completions', 'authorization', 'chat_completions'],
  ['/api/claude-code-proxy/legacy/v1/messages', 'x-api-key', 'anthropic_messages'],
  ['/api/codex-proxy/legacy/gemini/v1beta/models/model:generateContent', 'x-goog-api-key', 'gemini_contents'],
  ['/api/codex-proxy/legacy/gemini/v1beta/models/model:streamGenerateContent', 'x-goog-api-key', 'gemini_contents'],
])('dispatches the legacy %s URL without a separate proxy router', async (path, header, protocol) => {
  const request = ctx(path, 'hwui_run', header)
  const next = vi.fn()
  await modelGatewayMiddleware(request, next)
  expect(fixture.handled).toHaveBeenCalledWith(protocol, request)
  expect(next).not.toHaveBeenCalled()
  fixture.active = false
  await modelGatewayMiddleware(request, next)
  expect(request.status).toBe(403)
  expect(fixture.handled).toHaveBeenCalledOnce()
})

it.each(['codex-proxy', 'claude-code-proxy'])('serves legacy %s model discovery through the gateway', async proxy => {
  const request = ctx(`/api/${proxy}/legacy/v1/models`, 'hwui_run', 'x-api-key', 'GET')
  const next = vi.fn()
  await modelGatewayMiddleware(request, next)
  expect(request.body.data.map((model: any) => model.id)).toEqual(['model'])
  expect(next).not.toHaveBeenCalled()
  expect(fixture.handled).not.toHaveBeenCalled()
})
