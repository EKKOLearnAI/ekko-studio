import type { Context, Middleware } from 'koa'
import type { Readable } from 'stream'
import {
  brotliCompressSync,
  constants as zlibConstants,
  createBrotliCompress,
  createGzip,
  gzipSync,
} from 'zlib'

export type StaticCompressionEncoding = 'br' | 'gzip'

export interface StaticCompressionOptions {
  minBytes?: number
  maxBrotliBytes?: number
}

const DEFAULT_MIN_BYTES = 1024
// Dynamic Brotli provides great ratios, but it can add seconds of TTFB on multi-megabyte
// built assets. Cap it and fall back to gzip (or no compression) for larger responses.
const DEFAULT_MAX_BROTLI_BYTES = 256 * 1024

const COMPRESSIBLE_TYPES = new Set([
  'application/ecmascript',
  'application/javascript',
  'application/json',
  'application/ld+json',
  'application/manifest+json',
  'application/rss+xml',
  'application/wasm',
  'application/xhtml+xml',
  'application/xml',
  'application/x-javascript',
  'image/svg+xml',
  'text/javascript',
])

export function isCompressibleContentType(contentType: string): boolean {
  const normalized = contentType.split(';', 1)[0]?.trim().toLowerCase() || ''
  if (!normalized) return false
  return normalized.startsWith('text/') ||
    COMPRESSIBLE_TYPES.has(normalized) ||
    normalized.endsWith('+json') ||
    normalized.endsWith('+xml')
}

function parseEncodingQuality(header: string, encoding: StaticCompressionEncoding): number {
  let wildcardQuality: number | null = null
  let encodingQuality: number | null = null

  for (const rawPart of header.split(',')) {
    const [rawToken, ...rawParams] = rawPart.split(';')
    const token = rawToken?.trim().toLowerCase()
    if (!token) continue

    let quality = 1
    for (const rawParam of rawParams) {
      const [rawName, rawValue] = rawParam.split('=')
      if (rawName?.trim().toLowerCase() !== 'q') continue
      const parsed = Number(rawValue?.trim())
      quality = Number.isFinite(parsed) ? Math.max(0, Math.min(parsed, 1)) : 0
    }

    if (token === encoding) encodingQuality = quality
    if (token === '*') wildcardQuality = quality
  }

  return encodingQuality ?? wildcardQuality ?? 0
}

interface StaticCompressionSelectionOptions {
  bodyLength?: number | null
  maxBrotliBytes?: number
}

export function selectStaticCompressionEncoding(
  acceptEncoding: string,
  options: StaticCompressionSelectionOptions = {},
): StaticCompressionEncoding | null {
  const brQuality = parseEncodingQuality(acceptEncoding, 'br')
  const gzipQuality = parseEncodingQuality(acceptEncoding, 'gzip')
  const bodyLength = options.bodyLength ?? null
  const maxBrotliBytes = options.maxBrotliBytes ?? DEFAULT_MAX_BROTLI_BYTES

  if (brQuality <= 0 && gzipQuality <= 0) return null

  if (brQuality >= gzipQuality) {
    if (bodyLength !== null && bodyLength > maxBrotliBytes) {
      return gzipQuality > 0 ? 'gzip' : null
    }

    return 'br'
  }

  return 'gzip'
}

function isReadableStream(value: unknown): value is Readable {
  return !!value && typeof (value as { pipe?: unknown }).pipe === 'function'
}

function parseBodyLength(ctx: Context, body: unknown): number | null {
  if (Buffer.isBuffer(body)) return body.byteLength
  if (typeof body === 'string') return Buffer.byteLength(body)

  const contentLength = Number(ctx.response.get('Content-Length'))
  return Number.isFinite(contentLength) && contentLength >= 0 ? contentLength : null
}

function shouldCompress(ctx: Context, minBytes: number): boolean {
  if (ctx.method === 'HEAD') return false
  if (ctx.status < 200 || ctx.status >= 300 || ctx.status === 204) return false
  if (ctx.get('Range')) return false
  if (ctx.response.get('Content-Encoding')) return false
  if (!isCompressibleContentType(ctx.response.get('Content-Type') || ctx.type || '')) return false

  const body = ctx.body
  if (!body || !(Buffer.isBuffer(body) || typeof body === 'string' || isReadableStream(body))) return false

  const bodyLength = parseBodyLength(ctx, body)
  return bodyLength === null || bodyLength >= minBytes
}

function compressBuffer(body: Buffer, encoding: StaticCompressionEncoding): Buffer {
  if (encoding === 'br') {
    return brotliCompressSync(body, {
      params: {
        [zlibConstants.BROTLI_PARAM_QUALITY]: zlibConstants.BROTLI_DEFAULT_QUALITY,
      },
    })
  }

  return gzipSync(body)
}

function createCompressionStream(encoding: StaticCompressionEncoding) {
  if (encoding === 'br') {
    return createBrotliCompress({
      params: {
        [zlibConstants.BROTLI_PARAM_QUALITY]: zlibConstants.BROTLI_DEFAULT_QUALITY,
      },
    })
  }

  return createGzip()
}

export function createStaticCompressionMiddleware(options: StaticCompressionOptions = {}): Middleware {
  const minBytes = options.minBytes ?? DEFAULT_MIN_BYTES
  const maxBrotliBytes = options.maxBrotliBytes ?? DEFAULT_MAX_BROTLI_BYTES

  return async (ctx, next) => {
    await next()

    if (!shouldCompress(ctx, minBytes)) return

    const body = ctx.body
    const bodyLength = parseBodyLength(ctx, body)
    ctx.vary('Accept-Encoding')
    const encoding = selectStaticCompressionEncoding(ctx.get('Accept-Encoding'), {
      bodyLength,
      maxBrotliBytes,
    })
    if (!encoding) return

    ctx.set('Content-Encoding', encoding)

    if (Buffer.isBuffer(body) || typeof body === 'string') {
      const original = Buffer.isBuffer(body) ? body : Buffer.from(body)
      const compressed = compressBuffer(original, encoding)
      if (compressed.byteLength >= original.byteLength) {
        ctx.remove('Content-Encoding')
        return
      }

      ctx.body = compressed
      ctx.set('Content-Length', String(compressed.byteLength))
      return
    }

    if (isReadableStream(body)) {
      ctx.remove('Content-Length')
      ctx.body = body.pipe(createCompressionStream(encoding))
    }
  }
}
