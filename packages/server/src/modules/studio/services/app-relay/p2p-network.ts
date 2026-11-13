import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os'
import type { PeerConfig } from 'werift'

type NetworkConfig = Pick<PeerConfig, 'iceInterfaceAddresses' | 'iceUseIpv4' | 'iceUseIpv6' | 'icePortRange'>
export type P2PRoute = { interface: string; family: 4 | 6; metric: number }
const ignoredInterface = /^(?:lo\d*|loopback.*|utun\d*|tun\d*|tap\d*|wg\d*|tailscale.*|docker\d*|veth.*|br-.+|virbr\d*|vmnet\d*|vboxnet\d*|awdl\d*|llw\d*|gif\d*|stf\d*|bridge\d*|vethernet.*)$|clash|mihomo|wireguard|vpn/i

function usableAddress(address: string): boolean {
  if (isIP(address) === 4) return Number(address.split('.')[0]) < 224 && !/^(?:0\.|127\.|169\.254\.|198\.(?:18|19)\.)/.test(address)
  return isIP(address) === 6 && /^(?:[23]|f[cd])/i.test(address)
}

export function selectP2PNetwork(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>, routes: P2PRoute[] = [], interfaceName?: string): Partial<NetworkConfig> {
  const eligible = Object.entries(interfaces).filter(([name]) => interfaceName ? name === interfaceName : !ignoredInterface.test(name))
  const addresses: { udp4?: string; udp6?: string } = {}
  for (const family of [4, 6] as const) {
    const metric = (name: string) => Math.min(...routes.filter(route => route.family === family && route.interface === name).map(route => route.metric), Infinity)
    const ranked = [...eligible].sort(([a], [b]) => metric(a) - metric(b))
    for (const [, entries] of ranked) {
      const matches = (entries || []).filter(entry => !entry.internal && isIP(entry.address) === family && usableAddress(entry.address))
      // Prefer globally routed IPv6 over a LAN-only ULA on the same interface.
      const address = family === 6 ? matches.find(entry => /^[23]/.test(entry.address)) || matches[0] : matches[0]
      if (address) { addresses[family === 4 ? 'udp4' : 'udp6'] = address.address; break }
    }
  }
  if (!addresses.udp4 && !addresses.udp6) throw new Error('p2p_network_unavailable')
  return { iceInterfaceAddresses: addresses, iceUseIpv4: Boolean(addresses.udp4), iceUseIpv6: Boolean(addresses.udp6) }
}

export function parseLinuxP2PRoutes(ipv4: string, ipv6: string): P2PRoute[] {
  const routes: P2PRoute[] = []
  for (const line of ipv4.trim().split('\n')) {
    const fields = line.trim().split(/\s+/)
    if (fields[1] === '00000000' && fields[7] === '00000000' && (parseInt(fields[3], 16) & 1)) {
      routes.push({ interface: fields[0], family: 4, metric: Number(fields[6]) || 0 })
    }
  }
  for (const line of ipv6.trim().split('\n')) {
    const fields = line.trim().split(/\s+/)
    if (fields[0] === '0'.repeat(32) && fields[1] === '00' && (parseInt(fields[8], 16) & 1) && !(parseInt(fields[8], 16) & 0x200)) {
      routes.push({ interface: fields[9], family: 6, metric: parseInt(fields[5], 16) || 0 })
    }
  }
  return routes
}

export function parseWindowsP2PRoutes(output: string): P2PRoute[] {
  const value = JSON.parse(output.replace(/^\uFEFF/, '').trim() || '[]')
  return (Array.isArray(value) ? value : [value]).flatMap(item => {
    const family = item?.Family === 'IPv4' ? 4 : item?.Family === 'IPv6' ? 6 : undefined
    return family && typeof item.InterfaceAlias === 'string' && Number.isFinite(Number(item.Metric))
      ? [{ interface: item.InterfaceAlias, family, metric: Number(item.Metric) }] : []
  })
}

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 3000, maxBuffer: 64 * 1024, windowsHide: true }, (error, stdout) => error ? reject(error) : resolve(stdout))
  })
}

async function defaultRoutes(platform: NodeJS.Platform): Promise<P2PRoute[]> {
  if (platform === 'linux') {
    const results = await Promise.allSettled([readFile('/proc/net/route', 'utf8'), readFile('/proc/net/ipv6_route', 'utf8')])
    return parseLinuxP2PRoutes(...results.map(result => result.status === 'fulfilled' ? result.value : '') as [string, string])
  }
  if (platform === 'win32') {
    const script = [
      "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false);",
      "Get-NetRoute -DestinationPrefix '0.0.0.0/0','::/0' -ErrorAction SilentlyContinue",
      "| Select-Object InterfaceAlias,@{Name='Family';Expression={$_.AddressFamily.ToString()}},@{Name='Metric';Expression={$_.RouteMetric + $_.InterfaceMetric}}",
      '| ConvertTo-Json -Compress',
    ].join(' ')
    return parseWindowsP2PRoutes(await run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script]))
  }
  if (platform === 'darwin') {
    const results = await Promise.allSettled([run('/sbin/route', ['-n', 'get', 'default']), run('/sbin/route', ['-n', 'get', '-inet6', 'default'])])
    return results.flatMap((result, index) => {
      const name = result.status === 'fulfilled' ? /^\s*interface:\s*(\S+)\s*$/m.exec(result.value)?.[1] : undefined
      return name ? [{ interface: name, family: index === 0 ? 4 as const : 6 as const, metric: 0 }] : []
    })
  }
  return []
}

export async function getP2PNetworkConfig(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): Promise<{ peer: Partial<NetworkConfig>; advertiseAddresses: string[] }> {
  let routes: P2PRoute[] = []
  const interfaceName = env.STUDIO_P2P_INTERFACE?.trim() || undefined
  if (!interfaceName) { try { routes = await defaultRoutes(platform) } catch { /* Use interface enumeration if route discovery is unavailable. */ } }
  const peer = selectP2PNetwork(networkInterfaces(), routes, interfaceName)
  const range = env.STUDIO_P2P_UDP_PORT_RANGE?.trim()
  if (range) {
    const match = /^(\d+)-(\d+)$/.exec(range)
    const low = Number(match?.[1]); const high = Number(match?.[2])
    if (!match || low < 1024 || high > 65535 || low > high || high - low > 4095) throw new Error('p2p_invalid_port_range')
    peer.icePortRange = [low, high]
  }
  const advertiseAddresses = [...new Set((env.STUDIO_P2P_ADVERTISE_ADDRESSES || '').split(',').map(address => address.trim()).filter(Boolean))]
  if (advertiseAddresses.length > 8 || advertiseAddresses.some(address => !usableAddress(address)
    || (isIP(address) === 4 ? !peer.iceUseIpv4 : !peer.iceUseIpv6)) || advertiseAddresses.length && !range) throw new Error('p2p_invalid_advertise_addresses')
  // Bind the actual UDP source, not just an SDP candidate. On macOS this also
  // avoids a TUN's more-specific routes. Other OS/VPN policies may need an exclusion.
  return { peer, advertiseAddresses }
}

export function addP2PAdvertiseCandidates(sdp: string, addresses: string[]): string {
  if (!addresses.length) return sdp
  return sdp.split('\r\n').flatMap(line => {
    const candidate = /^a=candidate:\S+ (\d+) udp (\d+) (\S+) (\d+) typ host(.*)$/i.exec(line)
    if (!candidate) return [line]
    return [line, ...addresses.filter(address => address !== candidate[3] && isIP(address) === isIP(candidate[3])).map(address => {
      const foundation = createHash('sha256').update(address).digest('hex').slice(0, 16)
      // Reuse the socket/port published by Docker instead of opening an extra
      // socket for an address which is not assigned inside the container.
      return `a=candidate:${foundation} ${candidate[1]} udp ${candidate[2]} ${address} ${candidate[4]} typ host${candidate[5]}`
    })]
  }).join('\r\n')
}
