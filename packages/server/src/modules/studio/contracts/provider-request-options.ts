import { validateHeaderName, validateHeaderValue } from 'node:http'

const MANAGED_HEADERS = new Set([
  'authorization', 'x-api-key', 'x-goog-api-key', 'proxy-authorization', 'proxy-connection',
  'host', 'content-type', 'content-length', 'transfer-encoding', 'accept-encoding',
  'connection', 'keep-alive', 'te', 'trailer', 'upgrade', 'cookie',
])

export function normalizeProviderExtraHeaders(value: unknown): Record<string, string> {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Extra headers must be a JSON object')
  }
  const headers: Record<string, string> = Object.create(null)
  for (const [name, content] of Object.entries(value)) {
    const lower = name.toLowerCase()
    if (typeof content !== 'string' || MANAGED_HEADERS.has(lower)) {
      throw new Error('Extra headers cannot override authentication or transport headers')
    }
    try {
      validateHeaderName(name)
      validateHeaderValue(name, content)
    } catch {
      throw new Error('Extra headers must contain valid HTTP names and single-line string values')
    }
    headers[lower] = content.trim()
  }
  if (Buffer.byteLength(JSON.stringify(headers)) > 65_536) {
    throw new Error('Extra headers must not exceed 64 KiB')
  }
  return headers
}

export function normalizeProviderProxyUrl(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || /[\r\n\t]/.test(value) || value.length > 500) {
    throw new Error('Proxy URL must be a valid HTTP(S) proxy URL of at most 500 characters')
  }
  const text = value.trim()
  if (!text) return undefined
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`)
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname ||
      (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash || url.port === '0') {
      throw new Error('Invalid proxy')
    }
    decodeURIComponent(url.username)
    decodeURIComponent(url.password)
    return url.href.replace(/\/$/, '')
  } catch {
    // The URL may contain proxy credentials; never echo it in an error.
    throw new Error('Proxy URL must use HTTP(S), with no path, query, or fragment')
  }
}
