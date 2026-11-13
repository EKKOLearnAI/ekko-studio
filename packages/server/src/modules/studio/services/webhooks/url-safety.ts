import { lookup } from 'dns/promises'
import { isIP } from 'net'

export type WebhookLookup = typeof lookup

export interface ResolvedWebhookTarget {
  url: string
  address: string
  family: 4 | 6
}

function isPrivateIpv4(address: string): boolean {
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return true
  const [a, b, c] = parts
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0 && c === 2)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a >= 224
}

function isPrivateIpv6(address: string): boolean {
  const value = address.toLowerCase().split('%')[0]
  if (value.startsWith('::ffff:')) return isPrivateIpv4(value.slice('::ffff:'.length))
  return value === '::'
    || value === '::1'
    || value.startsWith('fc')
    || value.startsWith('fd')
    || /^fe[89ab]/.test(value)
    || value.startsWith('ff')
    || value.startsWith('2001:db8:')
    || value.startsWith('2001:0:')
    || value.startsWith('2002:')
}

export function isPrivateWebhookAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return isPrivateIpv4(address)
  if (family === 6) return isPrivateIpv6(address)
  return true
}

function validateUrlShape(raw: string): URL {
  const value = String(raw || '').trim()
  if (!value) throw new Error('Webhook URL is required')
  const url = new URL(value)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Webhook URL must use http or https')
  }
  if (url.username || url.password) throw new Error('Webhook URL must not include credentials')
  if (!url.hostname) throw new Error('Webhook URL must include a hostname')
  return url
}

export async function normalizeSafeWebhookUrl(
  raw: string,
  allowPrivateNetwork: boolean,
  lookupFn: WebhookLookup = lookup,
): Promise<string> {
  return (await resolveSafeWebhookTarget(raw, allowPrivateNetwork, lookupFn)).url
}

export async function resolveSafeWebhookTarget(
  raw: string,
  allowPrivateNetwork: boolean,
  lookupFn: WebhookLookup = lookup,
): Promise<ResolvedWebhookTarget> {
  const url = validateUrlShape(raw)
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (!allowPrivateNetwork && (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local'))) {
    throw new Error('Private-network webhook URLs require explicit permission')
  }
  if (isIP(hostname)) {
    if (!allowPrivateNetwork && isPrivateWebhookAddress(hostname)) {
      throw new Error('Private-network webhook URLs require explicit permission')
    }
    return { url: url.toString(), address: hostname, family: isIP(hostname) as 4 | 6 }
  }

  const addresses = await lookupFn(hostname, { all: true, verbatim: true })
  if (!addresses.length) throw new Error('Webhook hostname did not resolve to an address')
  if (!allowPrivateNetwork && addresses.some(item => isPrivateWebhookAddress(item.address))) {
    throw new Error('Webhook hostname resolves to a private or reserved address')
  }
  const target = addresses[0]
  if (target.family !== 4 && target.family !== 6) throw new Error('Webhook hostname resolved to an unsupported address')
  return { url: url.toString(), address: target.address, family: target.family }
}
