import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

const fakeIPv4 = (address: string) => /^198\.(?:18|19)\./.test(address)
const usableIPv4 = (address: string) => isIP(address) === 4 && !fakeIPv4(address)
  && !/^(?:0\.|127\.|169\.254\.)/.test(address) && Number(address.split('.')[0]) < 224
const publicSTUNHosts = new Set(['stun.cloudflare.com', 'stun.l.google.com'])

// Bound UDP sockets cannot use a TUN's synthetic DNS addresses. Resolve real
// endpoints before werift chooses its single STUN server; retain configured
// URLs when resolution fails so this optional step cannot break LAN fallback.
export async function resolveP2PSTUN(urls: string[], timeoutMs = 1500): Promise<{
  urls: string[]
  diagnostics: { configured: number; resolved: number; fakeIPHosts: number; encryptedDNSHosts: number }
}> {
  if (!urls.length) return { urls: [], diagnostics: { configured: 0, resolved: 0, fakeIPHosts: 0, encryptedDNSHosts: 0 } }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const results = await Promise.all(urls.map(async url => {
    const unchanged = { url, fakeIP: false, encryptedDNS: false, resolved: false }
    const match = /^stun:([^:[\]?]+)(?::(\d+))?$/.exec(url)
    if (!match || isIP(match[1])) return unchanged
    const host = match[1].toLowerCase(), port = match[2] || '3478'
    const resolve = async () => {
      const addresses = await lookup(host, { all: true, family: 4 })
      if (controller.signal.aborted) return unchanged
      const fakeIP = addresses.some(item => fakeIPv4(item.address))
      unchanged.fakeIP = fakeIP
      let address = addresses.find(item => usableIPv4(item.address))?.address
      let encryptedDNS = false
      if (!address && fakeIP && publicSTUNHosts.has(host) && !controller.signal.aborted) {
        const query = new URL('https://cloudflare-dns.com/dns-query')
        query.searchParams.set('name', host)
        query.searchParams.set('type', 'A')
        const response = await fetch(query, { headers: { accept: 'application/dns-json' }, signal: controller.signal })
        if (response.ok) {
          const data = await response.json() as { Status?: number; Answer?: { type: number; data: string }[] }
          if (data.Status === 0 && Array.isArray(data.Answer)) {
            address = data.Answer.find(item => item.type === 1 && usableIPv4(item.data))?.data
            encryptedDNS = Boolean(address)
          }
        }
      }
      return { url: address ? `stun:${address}:${port}` : url, fakeIP, encryptedDNS, resolved: Boolean(address) }
    }
    let stop!: () => void
    const timeout = new Promise<typeof unchanged>(resolve => {
      stop = () => resolve(unchanged)
      controller.signal.addEventListener('abort', stop, { once: true })
    })
    try { return await Promise.race([resolve(), timeout]) }
    catch { return unchanged }
    finally { controller.signal.removeEventListener('abort', stop) }
  }))
  clearTimeout(timer)
  return {
    urls: [...new Set([...results.filter(result => result.resolved || /^stun:(?:\d+\.|\[)/.test(result.url)).map(result => result.url), ...urls])],
    diagnostics: {
      configured: urls.length, resolved: results.filter(result => result.resolved).length,
      fakeIPHosts: results.filter(result => result.fakeIP).length,
      encryptedDNSHosts: results.filter(result => result.encryptedDNS).length,
    },
  }
}
