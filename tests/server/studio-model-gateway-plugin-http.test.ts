import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Koa from 'koa'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import type { PluginHttpInterceptor } from '../../packages/plugin-sdk/src'

const fixture = vi.hoisted(() => ({ home: '', active: true, calls: [] as any[], respond: undefined as any }))
vi.mock('../../packages/server/src/modules/studio/public/config', () => ({ config: { port: 18648, get appHome() { return fixture.home } } }))
vi.mock('../../packages/server/src/modules/studio/services/auth/token-auth', () => ({ getToken: async () => 'fixture-jwt-secret' }))
vi.mock('../../packages/server/src/modules/studio/services/session-shares/http-access', () => ({ handleSessionShareHttp: async () => false }))
vi.mock('../../packages/server/src/modules/studio/services/auth/run-mcp-credentials', () => ({ runMcpCredentials: { recognizes: () => false } }))
vi.mock('../../packages/server/src/modules/studio/repositories/users-store', () => ({
  findUserById: () => ({ id: 7, username: 'caller', role: 'user', status: fixture.active ? 'active' : 'disabled' }),
  listUserProfiles: () => [{ profile_name: 'work' }], userCanAccessProfile: () => true,
}))
vi.mock('../../packages/server/src/modules/studio/public/provider-account', () => ({
  authenticateInternalModelCredential: async (token: string) => token === 'studio_model_valid' ? { userId: 7, profile: 'work' } : null,
  withProviderAccount: (_id: unknown, task: () => unknown) => task(), providerAccountId: () => 7, providerRequestProfile: () => 'work',
}))
vi.mock('../../packages/server/src/modules/studio/services/providers/account-store', () => ({ withProviderAccount: (_id: unknown, task: () => unknown) => task() }))
vi.mock('../../packages/server/src/modules/studio/public/provider-config', () => ({ readConfigYamlForProfile: async () => ({ providers: {} }) }))
vi.mock('../../packages/server/src/modules/studio/public/provider-runtime', () => ({ getModelRuntimeCapabilities: () => undefined }))
vi.mock('../../packages/server/src/modules/studio/public/model-reasoning-codec', () => ({ reasoningCodec: async () => undefined }))
vi.mock('../../packages/server/src/modules/studio/public/model-routing', () => ({ canonicalModelRoute: async (value: string) => value, providerRouteNamespace: async (_profile: string, provider: string) => provider, qualifyModelRoute: (provider: string, model: string) => `${provider}/${model}` }))
vi.mock('../../packages/server/src/modules/studio/public/provider-upstream', () => ({ resolveProviderUpstream: async () => ({ provider: 'deepseek', baseUrl: 'https://upstream.invalid/v1', apiKey: 'fixture-upstream', apiMode: 'chat_completions' }) }))
vi.mock('../../packages/server/src/modules/studio/public/session-agent-runtime', () => ({ getSessionAvailableModelGroups: async () => [{ provider: 'deepseek', models: ['family/model', 'restricted'], api_mode: 'chat_completions', base_url: 'https://upstream.invalid/v1' }] }))
vi.mock('../../packages/server/src/modules/studio/public/usage', () => ({ normalizeTokenUsage: () => ({}), normalizeUsageCost: () => undefined, recordSessionUsage: vi.fn() }))
vi.mock('../../packages/server/src/modules/coding-agents/services/runtime/run-manager', () => ({ codingAgentRunManager: { handleProxyUsageEvent: vi.fn() } }))
vi.mock('../../packages/server/src/modules/coding-agents/services/context-policy', () => ({ codingAgentOutputLimit: () => 8192 }))
vi.mock('../../packages/server/src/modules/studio/services/model-api/keys', () => ({ MODEL_API_KEY_PREFIX: 'sk-ekko-', findModelApiKey: (token: string) => token === 'sk-ekko-valid' ? { id: 'key-1', userId: 7, models: ['deepseek/family/model'] } : null, touchModelApiKey: vi.fn() }))
vi.mock('../../packages/server/src/modules/studio/services/model-api/budget', () => ({ checkModelApiBudget: vi.fn(), startModelApiKeyRequest: () => () => {} }))
vi.mock('../../packages/server/src/modules/studio/services/model-api/cloud-usage', () => ({ claimCloudUsageReceipt: () => undefined }))

import { PluginManager } from '../../packages/server/src/modules/studio/services/plugins/manager'
import { createPluginHttpMiddleware } from '../../packages/server/src/modules/studio/services/plugins/http'
import { createRequestBodyParser } from '../../packages/server/src/modules/studio/middleware/request-body-parser'
import { requireUserJwt, resolveUserProfile } from '../../packages/server/src/modules/studio/middleware/auth'
import { modelGatewayMiddleware } from '../../packages/server/src/modules/studio/middleware/model-gateway'
import { configureModelGatewayAdapters, gatewayProtocol } from '../../packages/server/src/modules/studio/public/model-gateway-adapters'
import { codingModelGatewayAdapters } from '../../packages/server/src/modules/coding-agents/public/model-gateway'
import { configureProviderHttp, createProviderHttpTransport } from '../../packages/server/src/modules/studio/public/provider-http'
import { serveModelGateway } from '../../packages/server/src/modules/studio/services/model-api/gateway'
import { modelApiErrorBody } from '../../packages/server/src/modules/studio/services/model-api/errors'

const cleanup: Array<() => unknown | Promise<unknown>> = []
const caller = { userId: 7, profile: 'work', surface: 'http' }
beforeEach(async () => {
  fixture.home = await mkdtemp(join(tmpdir(), 'studio-gateway-http-'))
  cleanup.push(() => rm(fixture.home, { recursive: true, force: true }))
  fixture.active = true; fixture.calls = []
  fixture.respond = () => Response.json({ id: 'chat-1', model: 'family/model', choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2 } })
  configureModelGatewayAdapters(codingModelGatewayAdapters)
  configureProviderHttp(createProviderHttpTransport({ createFetch: () => (async (url, init) => {
    fixture.calls.push({ url, ...init, body: JSON.parse(String(init?.body)) })
    return fixture.respond()
  }) as typeof fetch, headers: () => undefined }))
  const target = codingModelGatewayAdapters.register('codex_responses', {
    userId: 7, profile: 'work', provider: 'deepseek', model: 'family/model', baseUrl: 'https://upstream.invalid/v1',
    apiKey: 'fixture-upstream', apiMode: 'chat_completions', sessionId: 'session-1', runId: 'run-1',
  }, { token: 'hwui_run' })
  cleanup.push(() => target.dispose())
})
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

async function serve(interceptor: PluginHttpInterceptor, permissions = ['http']) {
  const admin = { userId: 1, profile: 'default' }, source = join(fixture.home, 'source')
  await mkdir(source)
  await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'gateway-http', version: '1.0.0', type: 'module' }))
  await writeFile(join(source, 'plugin.json'), JSON.stringify({ id: 'gateway-http', name: 'gateway-http', version: '1.0.0', apiVersion: 1, server: 'server.mjs', permissions }))
  await writeFile(join(source, 'server.mjs'), 'export function apply() {}')
  const manager = new PluginManager(join(fixture.home, 'plugins'), { api: async () => ({}), authorize() {}, emit() {}, log() {} })
  cleanup.push(() => manager.close())
  await manager.install(admin, source, manager.snapshot().revision)
  await manager.update(admin, 'gateway-http', manager.snapshot().revision, { enabled: true })
  manager.runtime(admin, 'gateway-http').context().extensions.http.register(interceptor)
  const app = new Koa(); app.on('error', () => {})
  app.use(createRequestBodyParser())
  app.use(createPluginHttpMiddleware(() => manager))
  app.use(modelGatewayMiddleware)
  app.use(requireUserJwt)
  app.use(resolveUserProfile)
  app.use(async ctx => {
    const protocol = gatewayProtocol(ctx.path)
    if (!protocol) return
    ctx.params ||= {}
    try { await serveModelGateway(ctx, protocol, ['work']) }
    catch (error) { const result = modelApiErrorBody(error); ctx.status = result.status; ctx.body = result.body }
  })
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  cleanup.push(() => { server.closeAllConnections(); return new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing address')
  return `http://127.0.0.1:${address.port}`
}
const request = (base: string, token: string, body: unknown, path = '/v1/responses') => fetch(`${base}/api/ekko-studio/models${path}`, {
  method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
})

it.each(['hwui_run', 'studio_model_valid', 'sk-ekko-valid'])('intercepts %s before protocol translation and after dispatch with the actual caller', async token => {
  const seen: unknown[] = []
  const base = await serve({ name: 'rewrite', onRequest(req, ctx) {
    expect(ctx.identity).toBeUndefined()
    seen.push(structuredClone(req.body))
    req.body = { ...(req.body as object), input: 'plugin prompt' }
  }, onResponse(res, ctx) {
    expect(ctx.identity).toEqual(caller)
    expect(ctx.request.body).toMatchObject({ input: 'plugin prompt' })
    res.headers['x-plugin'] = 'seen'; res.body = { wrapped: res.body }
  } })
  const original = { model: token === 'hwui_run' ? 'family/model' : 'deepseek/family/model', input: 'original prompt' }
  const response = await request(base, token, original)
  expect(response.status).toBe(200); expect(response.headers.get('x-plugin')).toBe('seen')
  expect((await response.json()).wrapped.output[0].content[0].text).toBe('hello')
  expect(seen).toEqual([original])
  expect(fixture.calls).toHaveLength(1)
  expect(fixture.calls[0]).toMatchObject({ headers: { authorization: 'Bearer fixture-upstream' }, body: {
    model: 'family/model', messages: expect.arrayContaining([expect.objectContaining({ role: 'user', content: 'plugin prompt' })]),
  } })
})

it('keeps the gateway streaming while a response hook transforms chunks', async () => {
  let finish!: () => void, hookCalled = false, completed = false
  const gate = new Promise<void>(resolve => { finish = resolve })
  cleanup.push(() => finish())
  fixture.respond = () => new Response(new ReadableStream({ async start(controller) {
    controller.enqueue(new TextEncoder().encode('data: {"model":"family/model","choices":[{"index":0,"delta":{"content":"first"}}]}\n\n'))
    await gate
    controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n')); controller.close(); completed = true
  } }), { headers: { 'content-type': 'text/event-stream' } })
  const base = await serve({ name: 'stream', onResponse(res, ctx) {
    expect(ctx.identity).toEqual(caller); expect(res.body).toBeInstanceOf(Readable)
    hookCalled = true
    res.body = (res.body as Readable).pipe(new Transform({ transform(chunk, _encoding, done) { done(null, String(chunk).replace('first', 'changed')) } }))
  } })
  const response = await request(base, 'hwui_run', { model: 'family/model', stream: true, messages: [{ role: 'user', content: 'hi' }] }, '/v1/chat/completions')
  expect(response.status).toBe(200); expect(hookCalled).toBe(true); expect(completed).toBe(false)
  const reader = response.body!.getReader()
  try {
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('changed')
    finish()
    let tail = ''
    for (;;) { const chunk = await reader.read(); if (chunk.done) break; tail += new TextDecoder().decode(chunk.value) }
    expect(tail).toContain('[DONE]')
  } finally { finish(); await reader.cancel() }
})

it('enforces the sharing key allowlist after a plugin changes the requested model', async () => {
  const responseHook = vi.fn()
  const base = await serve({ name: 'restricted', onRequest(req) { (req.body as any).model = 'deepseek/restricted' }, onResponse: responseHook })
  const response = await request(base, 'sk-ekko-valid', { model: 'deepseek/family/model', input: 'hi' })
  expect(response.status).toBe(404); expect(fixture.calls).toEqual([])
  expect(responseHook).toHaveBeenCalledOnce()
  expect(responseHook.mock.calls[0][1].identity).toBeUndefined()
})

it('reauthenticates rewritten credentials and never uses the activating admin for a failed request', async () => {
  const responseHook = vi.fn()
  const base = await serve({ name: 'invalid-key', onRequest(req) { req.headers.authorization = 'Bearer studio_model_revoked' }, onResponse: responseHook })
  const response = await request(base, 'hwui_run', { model: 'family/model', input: 'hi' })
  expect(response.status).toBe(401); expect(fixture.calls).toEqual([])
  expect(responseHook.mock.calls[0][1].identity).toBeUndefined()
})

it('rejects a disabled run credential owner before granting the response hook an identity', async () => {
  fixture.active = false
  const responseHook = vi.fn()
  const base = await serve({ name: 'disabled', onResponse: responseHook })
  expect((await request(base, 'hwui_run', { model: 'family/model', input: 'hi' })).status).toBe(403)
  expect(fixture.calls).toEqual([]); expect(responseHook.mock.calls[0][1].identity).toBeUndefined()
})

it('does not grant gateway interception without the http permission', async () => {
  await expect(serve({ name: 'denied', onRequest() {} }, [])).rejects.toThrow(/requires http/)
})
