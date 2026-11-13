import type { Middleware } from 'koa'

type LegacyAppApiPrefix = readonly [legacy: string, canonical: string]

/**
 * Compatibility for released clients that predate Studio-owned APIs moving
 * out of /api/hermes. This includes old App versions and MCU firmware that
 * must still reach its legacy OTA manifest. New callers must use canonical
 * /api/studio paths directly.
 */
export const LEGACY_APP_API_PREFIXES: readonly LegacyAppApiPrefix[] = Object.freeze([
  ['/api/hermes/update', '/api/studio/update'],
  ['/api/update/identity', '/api/studio/update/identity'],
  ['/api/hermes/session-categories', '/api/studio/session-categories'],
  ['/api/hermes/search/sessions', '/api/studio/search/sessions'],
  ['/api/hermes/group-chat-link', '/api/studio/group-chat-link'],
  ['/api/hermes/group-chat', '/api/studio/group-chat'],
  ['/api/hermes/app-uploads', '/api/studio/app-uploads'],
  ['/api/hermes/performance', '/api/studio/performance'],
  ['/api/hermes/workflows', '/api/studio/workflows'],
  ['/api/hermes/sessions', '/api/studio/sessions'],
  ['/api/hermes/workspace', '/api/studio/workspace'],
  ['/api/hermes/download', '/api/studio/files/download'],
  ['/api/hermes/files', '/api/studio/files'],
  ['/api/hermes/usage', '/api/studio/usage'],
  ['/api/hermes/logs', '/api/studio/logs'],
  ['/api/hermes/mcu', '/api/studio/mcu'],
  ['/api/hermes/stt', '/api/studio/stt'],
  ['/api/hermes/tts', '/api/studio/tts'],
])

function replacePrefix(pathname: string, legacy: string, canonical: string): string | null {
  if (pathname === legacy) return canonical
  if (pathname.startsWith(`${legacy}/`)) return `${canonical}${pathname.slice(legacy.length)}`
  return null
}

export function canonicalLegacyAppPath(pathname: string): string | null {
  for (const [legacy, canonical] of LEGACY_APP_API_PREFIXES) {
    const mapped = replacePrefix(pathname, legacy, canonical)
    if (mapped) return mapped
  }
  return null
}

export function canonicalLegacyAppUrl(url: string): string | null {
  const queryIndex = url.indexOf('?')
  const pathname = queryIndex >= 0 ? url.slice(0, queryIndex) : url
  const canonicalPath = canonicalLegacyAppPath(pathname)
  if (!canonicalPath) return null
  return `${canonicalPath}${queryIndex >= 0 ? url.slice(queryIndex) : ''}`
}

export const legacyAppApiCompatibility: Middleware = async (ctx, next) => {
  const canonicalUrl = canonicalLegacyAppUrl(ctx.url)
  if (!canonicalUrl) {
    await next()
    return
  }

  const legacyUrl = ctx.url
  ctx.url = canonicalUrl
  ctx.set('Deprecation', 'true')
  ctx.set('X-Hermes-Studio-Canonical-Path', ctx.path)
  try {
    await next()
  } finally {
    ctx.url = legacyUrl
  }
}
