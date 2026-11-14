import { randomUUID } from 'node:crypto'
import { validateHeaderName, validateHeaderValue } from 'node:http'
import { isDeepStrictEqual } from 'node:util'
import { deserialize, serialize } from 'node:v8'
import type { Context, Middleware } from 'koa'
import type { PluginHttpContext, PluginHttpHeaders, PluginHttpRequest, PluginHttpResponse, PluginIdentity } from '../../contracts/plugins'
import type { PluginManager } from './manager'
import { PluginError } from './errors'

const internalHeader = 'x-studio-plugin-internal-http'
const internalToken = randomUUID()
/** Only the authenticated loopback SDK transport uses this process-local recursion guard. */
export const pluginHttpInternalHeaders = () => ({ [internalHeader]: internalToken })

function copyBody(body: unknown): unknown {
  if (Buffer.isBuffer(body)) return Buffer.from(body)
  if (body && (Array.isArray(body) || Object.getPrototypeOf(body) === Object.prototype || Object.getPrototypeOf(body) === null)) {
    try { return deserialize(serialize(body)) } catch { /* Opaque Koa bodies (for example toJSON handlers) stay process-local. */ }
  }
  return body
}
function headers(value: unknown): PluginHttpHeaders {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PluginError('Invalid HTTP headers')
  const result: PluginHttpHeaders = Object.create(null)
  for (const [name, field] of Object.entries(value)) {
    validateHeaderName(name)
    if (field === undefined) continue
    if (typeof field !== 'string' && (!Array.isArray(field) || field.some(item => typeof item !== 'string'))) throw new PluginError('HTTP header values must be strings or string arrays')
    for (const item of Array.isArray(field) ? field : [field]) validateHeaderValue(name, item)
    result[name.toLowerCase()] = Array.isArray(field) ? [...field] : field
  }
  return result
}
function requestSnapshot(ctx: Context): PluginHttpRequest {
  return { method: ctx.method, url: ctx.url, headers: headers(ctx.headers), body: copyBody(ctx.request.body) }
}
function applyRequest(ctx: Context, request: PluginHttpRequest) {
  if (typeof request.method !== 'string' || !/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(request.method)) throw new PluginError('Invalid HTTP method')
  if (typeof request.url !== 'string' || !request.url.startsWith('/') || request.url.startsWith('//') || /[\x00-\x20\x7f#\\]/.test(request.url)) throw new PluginError('HTTP request URL must be an origin-relative path and query')
  const next = headers(request.headers)
  // The raw bytes were already parsed; their original length no longer describes a rewritten body.
  if (!isDeepStrictEqual(ctx.request.body, request.body)) delete next['content-length']
  ctx.method = request.method.toUpperCase(); ctx.url = request.url
  for (const name of Object.keys(ctx.headers)) delete ctx.headers[name]
  Object.assign(ctx.headers, next)
  ctx.request.body = request.body
}
function responseSnapshot(ctx: Context): PluginHttpResponse {
  const values = Object.fromEntries(Object.entries(ctx.response.headers).map(([name, value]) => [name, typeof value === 'number' ? String(value) : value]))
  return { status: ctx.status, headers: headers(values), body: copyBody(ctx.body) }
}
function applyResponse(ctx: Context, response: PluginHttpResponse) {
  if (!response || !Object.hasOwn(response, 'body') || !Number.isInteger(response.status) || response.status < 100 || response.status > 999) throw new PluginError('Invalid HTTP response status or body')
  const next = headers(response.headers)
  const changed = !isDeepStrictEqual(ctx.body, response.body)
  if (changed) {
    // Koa recalculates length for buffered bodies. Do not retain a validator for the old content.
    delete next['content-length']; delete next.etag
  }
  for (const name of ctx.res.getHeaderNames()) if (!Object.hasOwn(next, name.toLowerCase())) ctx.remove(name)
  for (const [name, value] of Object.entries(next)) if (value !== undefined) ctx.set(name, value)
  if (changed) ctx.body = response.body
  ctx.status = response.status
}
function identity(ctx: Context): PluginIdentity | undefined {
  const userId = ctx.state.user?.id, profile = ctx.state.profile?.name
  return userId && profile && !ctx.state.sessionShare ? Object.freeze({ userId, profile, surface: 'http' }) : undefined
}

/** Parsed inbound HTTP, before route authentication; the response phase runs before Koa writes. */
export function createPluginHttpMiddleware(manager: () => Pick<PluginManager, 'httpInterceptors'>): Middleware {
  return async (ctx, next) => {
    const internal = ctx.get(internalHeader) === internalToken
    delete ctx.headers[internalHeader]
    if (internal) return next()
    const interceptors = manager().httpInterceptors()
    if (!interceptors.length) return next()
    const lifetime = new AbortController(), originalUrl = ctx.originalUrl
    const abort = () => lifetime.abort()
    ctx.req.once('aborted', abort); ctx.res.once('close', abort)
    const entered: typeof interceptors = []
    const context = (signal: AbortSignal, request: PluginHttpRequest): PluginHttpContext => ({ originalUrl, request, identity: identity(ctx), signal })
    try {
      let handled = false
      for (const entry of interceptors) {
        const { runtime, interceptor } = entry
        if (runtime.effects.controller.signal.aborted || runtime.http.get(interceptor.name) !== interceptor) continue
        entered.push(entry)
        if (!interceptor.onRequest) continue
        const request = requestSnapshot(ctx)
        const result = await runtime.withHttpIdentity(identity(ctx), lifetime.signal, signal => interceptor.onRequest!(request, context(signal, request)))
        applyRequest(ctx, request)
        if (result !== undefined) { applyResponse(ctx, result); handled = true; break }
      }
      if (!handled) await next()
      // Native SSE/proxy handlers may already own and write the raw ServerResponse.
      if (ctx.respond === false || ctx.headerSent || !ctx.writable) return
      for (const { runtime, interceptor } of entered.reverse()) {
        if (!interceptor.onResponse || runtime.effects.controller.signal.aborted || runtime.http.get(interceptor.name) !== interceptor) continue
        const response = responseSnapshot(ctx), request = requestSnapshot(ctx)
        await runtime.withHttpIdentity(identity(ctx), lifetime.signal, signal => interceptor.onResponse!(response, context(signal, request)))
        applyResponse(ctx, response)
      }
    } finally {
      lifetime.abort(); ctx.req.off('aborted', abort); ctx.res.off('close', abort)
    }
  }
}
