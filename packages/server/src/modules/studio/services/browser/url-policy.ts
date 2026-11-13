/**
 * URL policy for the server-hosted browser (spec-04 acceptance 13/14, reused by
 * spec-09). Pure functions only — no IO — so every rejection path is testable.
 *
 * Navigating anywhere must go through `normalizeBrowserUrl()`; after a redirect
 * the resulting URL must be validated again (a 302 must not bypass the policy).
 */

import { isIP } from 'node:net'

export const ALLOWED_BROWSER_PROTOCOLS = ['http:', 'https:'] as const
export const BLANK_PAGE_URL = 'about:blank'

/** Hostnames that are metadata endpoints or otherwise off limits. */
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata.goog',
  'metadata.azure.internal',
  'metadata',
  '169.254.169.254',
  '169.254.170.2',
  '100.100.100.200',
  'fd00:ec2::254',
  'instance-data',
])

const SENSITIVE_QUERY_KEY =
  /^(?:access[_-]?token|refresh[_-]?token|id[_-]?token|token|api[_-]?key|secret|password|authorization|auth|code|session)$/i

const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:/i

export type BrowserUrlRejectionReason =
  | 'empty'
  | 'malformed'
  | 'scheme-not-allowed'
  | 'credentials-in-url'
  | 'blocked-host'
  | 'numeric-host'

export class BrowserUrlRejectedError extends Error {
  readonly reason: BrowserUrlRejectionReason
  readonly input: string

  constructor(reason: BrowserUrlRejectionReason, input: string, detail?: string) {
    super(`Browser navigation rejected (${reason}): ${input}${detail ? ` - ${detail}` : ''}`)
    this.name = 'BrowserUrlRejectedError'
    this.reason = reason
    this.input = input
  }
}

function isIpv4Literal(host: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || /^\d+$/.test(host) || /^0x[0-9a-f]+$/i.test(host)
}

function isPrivateIpv4(host: string): boolean {
  const octets = host.split('.').map(part => Number.parseInt(part, 10))
  if (octets.length !== 4 || octets.some(value => !Number.isInteger(value) || value < 0 || value > 255)) {
    return true
  }
  const [first, second] = octets
  if (first === 0 || first === 10 || first === 127) return true
  if (first === 100 && second >= 64 && second <= 127) return true // CGNAT
  if (first === 169 && second === 254) return true // link-local + cloud metadata
  if (first === 172 && second >= 16 && second <= 31) return true
  if (first === 192 && second === 168) return true
  if (first === 192 && second === 0) return true // 192.0.0.0/24, 192.0.2.0/24
  if (first === 198 && (second === 18 || second === 19)) return true
  if (first >= 224) return true // multicast + reserved
  return false
}

function isPrivateIpv6(host: string): boolean {
  const value = host.replace(/^\[|\]$/g, '').toLowerCase()
  if (value === '::' || value === '::1') return true
  if (value.startsWith('fe80:') || value.startsWith('fec0:')) return true // link-local + site-local
  if (/^f[cd][0-9a-f]{2}:/.test(value)) return true // unique local fc00::/7
  if (value.startsWith('ff')) return true // multicast
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(value)
  if (mapped) return isPrivateIpv4(mapped[1])
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(value)
  if (mappedHex) {
    const high = Number.parseInt(mappedHex[1], 16)
    const low = Number.parseInt(mappedHex[2], 16)
    return isPrivateIpv4(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`)
  }
  return false
}

/** Loopback, private ranges, link-local and cloud metadata hosts. */
export function isBlockedHost(host: string): boolean {
  const value = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (!value) return true
  if (BLOCKED_HOSTNAMES.has(value)) return true
  if (value.endsWith('.localhost') || value.endsWith('.internal')) return true

  const ipVersion = isIP(value)
  if (ipVersion === 4) return isPrivateIpv4(value)
  if (ipVersion === 6) return isPrivateIpv6(value)

  // Numeric host that does not parse as a dotted quad (e.g. 2130706433, 0x7f000001).
  if (isIpv4Literal(value)) return true
  return false
}

/**
 * Accept only `http:` / `https:` and the internal `about:blank` page. Every
 * other scheme (`file:`, `data:`, `javascript:`, `blob:`, `chrome:`,
 * `devtools:`, custom) is rejected instead of being "cleaned up".
 */
export function normalizeBrowserUrl(input: string): string {
  const raw = String(input ?? '').trim()
  if (!raw) throw new BrowserUrlRejectedError('empty', raw)
  if (raw === BLANK_PAGE_URL) return BLANK_PAGE_URL

  const candidate = SCHEME_PATTERN.test(raw) ? raw : `https://${raw}`

  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    throw new BrowserUrlRejectedError('malformed', raw)
  }

  if (!(ALLOWED_BROWSER_PROTOCOLS as readonly string[]).includes(parsed.protocol)) {
    throw new BrowserUrlRejectedError('scheme-not-allowed', raw, parsed.protocol)
  }
  if (parsed.username || parsed.password) {
    throw new BrowserUrlRejectedError('credentials-in-url', raw)
  }
  if (!parsed.hostname) {
    throw new BrowserUrlRejectedError('malformed', raw, 'missing host')
  }
  if (isBlockedHost(parsed.hostname)) {
    throw new BrowserUrlRejectedError('blocked-host', raw, parsed.hostname)
  }

  return parsed.toString()
}

export function tryNormalizeBrowserUrl(input: string): string | null {
  try {
    return normalizeBrowserUrl(input)
  } catch {
    return null
  }
}

/** URL shape safe to hand to the model / the panel: secrets are masked. */
export function publicBrowserUrl(input: string): string {
  const raw = String(input ?? '').trim()
  if (!raw) return ''
  if (raw === BLANK_PAGE_URL) return BLANK_PAGE_URL

  try {
    const parsed = new URL(raw)
    for (const key of [...parsed.searchParams.keys()]) {
      if (SENSITIVE_QUERY_KEY.test(key)) parsed.searchParams.set(key, '[redacted]')
    }
    if (/(?:access[_-]?token|id[_-]?token|token|api[_-]?key|secret|password|authorization|auth|code)=/i.test(parsed.hash)) {
      parsed.hash = '#[redacted]'
    }
    return parsed.toString()
  } catch {
    return raw.slice(0, 2048)
  }
}

/** Collapse whitespace and cut to `limit`; used for titles and log lines. */
export function redactBrowserText(input: unknown, limit = 500): string {
  return String(input ?? '')
    .replace(/\b(?:access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|password|secret)\s*([:=])\s*([^\s&,;]+)/gi, '$1$2[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit)
}
