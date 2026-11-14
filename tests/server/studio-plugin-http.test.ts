import { afterEach, expect, it, vi } from 'vitest'
import Koa, { type Middleware } from 'koa'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { PluginManager } from '../../packages/server/src/modules/studio/services/plugins/manager'
import { createPluginHttpMiddleware, pluginHttpInternalHeaders } from '../../packages/server/src/modules/studio/services/plugins/http'
import { createRequestBodyParser } from '../../packages/server/src/modules/studio/middleware/request-body-parser'
import type { PluginHttpInterceptor, PluginIdentity, PluginPermission } from '../../packages/plugin-sdk/src'

const admin = { userId: 1, profile: 'default' }
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })

async function fixture(ids = ['http-test'], permissions: PluginPermission[] = ['http', 'api.read']) {
  const home = await mkdtemp(join(tmpdir(), 'studio-plugin-http-'))
  cleanup.push(() => rm(home, { recursive: true, force: true }))
  const api = vi.fn(async (identity: PluginIdentity, path: string) => ({ identity, path }))
  const manager = new PluginManager(join(home, 'host'), { api, authorize() {}, emit() {}, log() {} })
  cleanup.push(() => manager.close())
  for (const id of ids) {
    const source = join(home, id); await mkdir(source)
    await writeFile(join(source, 'package.json'), JSON.stringify({ name: id, version: '1.0.0', type: 'module' }))
    await writeFile(join(source, 'plugin.json'), JSON.stringify({ id, name: id, version: '1.0.0', apiVersion: 1, server: 'server.mjs', permissions }))
    await writeFile(join(source, 'server.mjs'), 'export function apply() {}')
    await manager.install(admin, source, manager.snapshot().revision)
    await manager.update(admin, id, manager.snapshot().revision, { enabled: true })
  }
  const runtime = manager.runtime(admin, ids[0])
  return { manager, api, runtime, register: (interceptor: PluginHttpInterceptor, id = ids[0]) => manager.runtime(admin, id).context().extensions.http.register(interceptor) }
}
async function serve(manager: PluginManager, route: Middleware) {
  const app = new Koa(); app.on('error', () => {})
  app.use(createRequestBodyParser())
  app.use(createPluginHttpMiddleware(() => manager))
  app.use(async (ctx, next) => {
    ctx.state.user = { id: 7, username: 'caller', role: 'user' }
    ctx.state.profile = { name: 'work' }
    await next()
  })
  app.use(route)
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  cleanup.push(() => { server.closeAllConnections(); return new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing test server address')
  return `http://127.0.0.1:${address.port}`
}

it('rewrites the parsed request before routing and the response before sending, with the real caller identity', async () => {
  const { manager, runtime, api, register } = await fixture()
  register({ name: 'rewrite', onRequest(request, ctx) {
    expect(ctx.originalUrl).toBe('/original?old=1'); expect(ctx.identity).toBeUndefined()
    expect(() => runtime.context().host.agents.list()).toThrow(/identity is unavailable/)
    request.method = 'PUT'; request.url = '/rewritten?new=2'
    request.headers['x-rewritten'] = 'yes'; delete request.headers['x-remove']
    request.body = { changed: true }
  }, async onResponse(response, ctx) {
    expect(ctx.identity).toEqual({ userId: 7, profile: 'work', surface: 'http' })
    expect(ctx.request.url).toBe('/rewritten?new=2')
    await runtime.context().host.agents.list()
    response.status = 202; response.headers['x-plugin'] = 'yes'
    response.body = { wrapped: response.body }
  } })
  const base = await serve(manager, ctx => {
    expect(ctx.method).toBe('PUT'); expect(ctx.path).toBe('/rewritten'); expect(ctx.query.new).toBe('2')
    expect(ctx.get('x-rewritten')).toBe('yes'); expect(ctx.get('x-remove')).toBe('')
    ctx.body = ctx.request.body
    ctx.set('ETag', 'old-body'); ctx.set('Content-Length', '1'); ctx.set('Set-Cookie', ['a=1', 'b=2'])
  })
  const response = await fetch(`${base}/original?old=1`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-remove': 'remove' }, body: '{"original":true}' })
  expect(response.status).toBe(202); expect(response.headers.get('x-plugin')).toBe('yes')
  expect(response.headers.get('etag')).toBeNull(); expect(response.headers.getSetCookie()).toEqual(['a=1', 'b=2'])
  expect(await response.json()).toEqual({ wrapped: { changed: true } })
  expect(api).toHaveBeenCalledExactlyOnceWith({ userId: 7, profile: 'work', surface: 'http' }, '/api/studio/agents', {}, expect.any(AbortSignal))
})

it('orders interceptors across plugins by priority and unwinds responses in reverse', async () => {
  const { manager, register } = await fixture(['z-plugin', 'a-plugin'])
  const order: string[] = []
  for (const [id, name, priority] of [['z-plugin', 'early', -1], ['z-plugin', 'late', 0], ['a-plugin', 'first', 0]] as const) {
    register({ name, priority, onRequest() { order.push(`${id}/${name}:request`) }, onResponse() { order.push(`${id}/${name}:response`) } }, id)
  }
  const base = await serve(manager, ctx => { order.push('route'); ctx.body = 'ok' })
  expect(await (await fetch(base)).text()).toBe('ok')
  expect(order).toEqual(['z-plugin/early:request', 'a-plugin/first:request', 'z-plugin/late:request', 'route', 'z-plugin/late:response', 'a-plugin/first:response', 'z-plugin/early:response'])
})

it('can return a response without routing and only unwinds interceptors already entered', async () => {
  const { manager, register } = await fixture()
  const later = vi.fn(), route = vi.fn(), order: string[] = []
  register({ name: 'outer', priority: -1, onResponse(response) { order.push('outer'); response.headers['x-outer'] = 'yes' } })
  register({ name: 'block', onRequest() { return { status: 418, headers: {}, body: { blocked: true } } }, onResponse() { order.push('block') } })
  register({ name: 'later', priority: 1, onRequest: later })
  const base = await serve(manager, route), response = await fetch(base)
  expect(response.status).toBe(418); expect(response.headers.get('x-outer')).toBe('yes')
  expect(response.headers.get('content-type')).toContain('application/json')
  expect(await response.json()).toEqual({ blocked: true }); expect(order).toEqual(['block', 'outer'])
  expect(route).not.toHaveBeenCalled(); expect(later).not.toHaveBeenCalled()
})

it('requires http permission, validates registrations and releases individual interceptors', async () => {
  const denied = await fixture(['denied'], [])
  expect(() => denied.register({ name: 'denied', onRequest() {} })).toThrow(/requires http/)
  const { manager, register } = await fixture()
  expect(() => register({ name: 'empty' })).toThrow(/Invalid HTTP interceptor/)
  expect(() => register({ name: 'priority', priority: Infinity, onRequest() {} })).toThrow(/Invalid HTTP interceptor/)
  const callback = vi.fn(), release = register({ name: 'temporary', onRequest: callback })
  expect(() => register({ name: 'temporary', onRequest() {} })).toThrow(/Duplicate/)
  const base = await serve(manager, ctx => { ctx.body = 'ok' })
  await fetch(base); await release(); await fetch(base)
  expect(callback).toHaveBeenCalledTimes(1)
})

it('disables a plugin inside a route without deadlocking or running its stale response callback', async () => {
  const { manager, register } = await fixture(), responseHook = vi.fn()
  register({ name: 'lifetime', onResponse: responseHook })
  const base = await serve(manager, async ctx => {
    await manager.update(admin, 'http-test', manager.snapshot().revision, { enabled: false })
    ctx.body = 'disabled'
  })
  expect(await (await fetch(base)).text()).toBe('disabled')
  expect(responseHook).not.toHaveBeenCalled(); expect(manager.httpInterceptors()).toEqual([])
})

it('cancels a pending callback on plugin shutdown and lets subsequent traffic pass', async () => {
  const { manager, register } = await fixture()
  let started!: () => void, signal!: AbortSignal
  const ready = new Promise<void>(resolve => { started = resolve })
  register({ name: 'pending', onRequest(_request, ctx) { signal = ctx.signal; started(); return new Promise(() => {}) } })
  const base = await serve(manager, ctx => { ctx.body = 'ok' }), pending = fetch(base)
  await ready
  await manager.update(admin, 'http-test', manager.snapshot().revision, { enabled: false })
  expect(signal.aborted).toBe(true); expect((await pending).status).toBe(500)
  expect(await (await fetch(base)).text()).toBe('ok')
})

it('bypasses interception for authenticated SDK loopback calls while rejecting forged bypass markers', async () => {
  const { manager, runtime, api, register } = await fixture(), requests: string[] = []
  let base = ''
  api.mockImplementation(async (identity, path) => ({ identity, path: await (await fetch(`${base}${path}`, { headers: pluginHttpInternalHeaders() })).text() }))
  register({ name: 'internal', onRequest(request) { requests.push(request.url) }, async onResponse() { await runtime.context().host.agents.list() } })
  base = await serve(manager, ctx => { expect(ctx.get('x-studio-plugin-internal-http')).toBe(''); ctx.body = 'ok' })
  expect(await (await fetch(base, { headers: { 'x-studio-plugin-internal-http': 'forged' } })).text()).toBe('ok')
  expect(requests).toEqual(['/']); expect(api).toHaveBeenCalledTimes(1)
})

it('allows response stream transforms without buffering and leaves committed native responses alone', async () => {
  const { manager, register } = await fixture(), transformed: string[] = []
  register({ name: 'stream', onResponse(response, ctx) {
    transformed.push(ctx.request.url)
    if (response.body instanceof Readable) response.body = response.body.pipe(new Transform({ transform(chunk, _encoding, done) { done(null, String(chunk).toUpperCase()) } }))
  } })
  const base = await serve(manager, ctx => {
    if (ctx.path === '/native') { ctx.respond = false; ctx.res.end('native'); return }
    ctx.body = Readable.from(['stream', '-body'])
  })
  expect(await (await fetch(`${base}/stream`)).text()).toBe('STREAM-BODY')
  expect(await (await fetch(`${base}/native`)).text()).toBe('native')
  expect(transformed).toEqual(['/stream'])
})

it('rejects invalid rewrites before a route sees them', async () => {
  const { manager, register } = await fixture(), route = vi.fn()
  const release = register({ name: 'bad-url', onRequest(request) { request.url = 'https://example.com/api' } })
  const base = await serve(manager, route)
  expect((await fetch(base)).status).toBe(400); expect(route).not.toHaveBeenCalled()
  await release()
  register({ name: 'bad-header', onRequest(request) { request.headers['x-injected'] = 'one\r\ntwo' } })
  expect((await fetch(base)).status).toBe(500); expect(route).not.toHaveBeenCalled()
})

it('keeps nested Buffer serialization intact when a response callback only observes the body', async () => {
  const { manager, register } = await fixture()
  register({ name: 'observe', onResponse(response) { expect(Buffer.isBuffer((response.body as { data: Buffer }).data)).toBe(true) } })
  const base = await serve(manager, ctx => { ctx.body = { data: Buffer.from('ok') } })
  expect(await (await fetch(base)).json()).toEqual({ data: { type: 'Buffer', data: [111, 107] } })
})
