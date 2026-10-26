import { createHash, randomUUID } from 'node:crypto'

/** Opaque affinity key; never send a profile path or proxy routing key upstream. */
export function openCodeSessionHeaders(
  baseUrl: string,
  sessionId?: string,
  provider?: string,
): Record<string, string> {
  let hostname = ''
  try { hostname = new URL(baseUrl).hostname.toLowerCase() } catch { /* Provider ID may identify a proxy. */ }
  const providerId = provider?.replace(/^custom[:_]/, '').toLowerCase()
  if (
    hostname !== 'opencode.ai' && !hostname.endsWith('.opencode.ai') &&
    !['opencode', 'opencode-go', 'opencode-zen'].includes(providerId || '')
  ) return {}

  return {
    'x-opencode-session': createHash('sha256').update(sessionId?.trim() || randomUUID()).digest('hex'),
  }
}
