import bodyParser from '@koa/bodyparser'
import type { Context, Next } from 'koa'

/**
 * Parse every request shape used by the local APIs. `text` is required by the
 * Ekko Studio command-provider bridge, which posts the TTS input file as
 * `text/plain`.
 */
export function createRequestBodyParser() {
  return bodyParser({
    encoding: 'utf-8',
    enableTypes: ['json', 'form', 'text'],
    jsonLimit: '20mb',
    formLimit: '20mb',
    textLimit: '20mb',
    parsedMethods: ['POST', 'PUT', 'PATCH', 'DELETE'],
  })
}

/**
 * Let authenticated Codex Responses requests reach the proxy sanitizer before
 * applying the regular 20 MiB application-wide JSON limit. The proxy still has
 * a bounded ceiling so an authenticated client cannot stream an unlimited body.
 */
export function createCodexProxyRequestBodyParser(isAuthorized: (ctx: Context) => boolean) {
  const parse = bodyParser({
    encoding: 'utf-8',
    enableTypes: ['json'],
    jsonLimit: '64mb',
    parsedMethods: ['POST'],
  })
  return async (ctx: Context, next: Next) => {
    if (ctx.method !== 'POST' || !/^\/api\/codex-proxy\/[^/]+\/(?:v1\/responses|gemini\/v1beta\/models\/[^/]+)$/.test(ctx.path)) {
      return next()
    }
    if (!isAuthorized(ctx)) {
      ctx.status = 401
      ctx.body = { error: { type: 'authentication_error', message: 'Invalid Codex proxy token' } }
      return
    }
    return parse(ctx, next)
  }
}
