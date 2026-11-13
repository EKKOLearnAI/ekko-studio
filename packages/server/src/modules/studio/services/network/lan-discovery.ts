import dgram from 'dgram'
import { networkInterfaces } from 'os'
import type { LanEndpointKind, PublicSystemInfo } from '../../contracts/devices'
import { config } from '../../public/config'
import { logger } from '../../public/logging'
import { getPublicSystemInfo } from '../../public/system-info'

export type { LanEndpointKind } from '../../contracts/devices'

const DISCOVERY_VERSION = 1
export const HERMES_DISCOVERY_PORT = 48640
const DISCOVERY_PORT_OFFSET = 40_000

type DiscoverySocket = dgram.Socket

type DiscoveryRequest = {
  type?: string
  version?: number
  request_id?: string
}

type DiscoveryAnnouncement = PublicSystemInfo & {
  type: 'hermes.announce'
  version: number
  request_id?: string
  http_port: number
  endpoint_kind: LanEndpointKind
  url: string
}

type StartResponderOptions = {
  httpPort?: number
  getSystemInfo?: () => Promise<PublicSystemInfo>
}

export type LanIPv4Interface = {
  name: string
  address: string
  netmask: string
}

let responderSockets: DiscoverySocket[] = []
let localInfoCache: { value: PublicSystemInfo; expiresAt: number } | null = null

function envFlagDisabled(name: string): boolean {
  const value = String(process.env[name] || '').trim().toLowerCase()
  return ['0', 'false', 'no', 'off'].includes(value)
}

export function isLanDiscoveryEnabled(): boolean {
  return !envFlagDisabled('HERMES_LAN_DISCOVERY_ENABLED')
}

export function discoveryPortForHttpPort(httpPort: number): number {
  const port = DISCOVERY_PORT_OFFSET + httpPort
  if (port > 65535) throw new Error(`HTTP port ${httpPort} cannot be mapped to a UDP discovery port`)
  return port
}

function discoveryPortsForHttpPorts(httpPorts: number[]): number[] {
  const ports = new Set<number>([HERMES_DISCOVERY_PORT])
  for (const httpPort of httpPorts) {
    try {
      ports.add(discoveryPortForHttpPort(httpPort))
    } catch {
      // Fixed discovery port still covers endpoints with unmappable HTTP ports.
    }
  }
  return [...ports]
}

export function getLanEndpointKind(httpPort: number, currentPort = config.port): LanEndpointKind {
  if (httpPort === 8748) return 'desktop'
  if (httpPort === 8648 || httpPort === currentPort) return 'web'
  return 'custom'
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.').map(part => Number.parseInt(part, 10))
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return null
  return (((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]) >>> 0
}

export function isPrivateOrLoopbackIPv4(ip: string): boolean {
  const value = ipv4ToInt(ip)
  if (value === null) return false
  const first = (value >>> 24) & 255
  const second = (value >>> 16) & 255
  if (first === 10 || first === 127) return true
  if (first === 172 && second >= 16 && second <= 31) return true
  if (first === 192 && second === 168) return true
  if (first === 169 && second === 254) return true
  return false
}

function getIpv4Interfaces(): LanIPv4Interface[] {
  try {
    return Object.entries(networkInterfaces()).flatMap(([name, addresses]) => (
      (addresses || [])
        .filter(item => item.family === 'IPv4' && !item.internal && item.address && item.netmask)
        .map(item => ({ name, address: item.address, netmask: item.netmask }))
    ))
  } catch {
    return []
  }
}

function isLikelyVirtualInterface(name: string): boolean {
  const normalized = String(name || '').trim().toLowerCase()
  return /^(?:utun|tun(?:\d|$)|tap(?:\d|$)|ppp(?:\d|$)|ipsec|wg(?:\d|$)|gif\d|stf\d|awdl\d|llw\d|bridge\d|docker\d|veth|virbr|vmnet|vboxnet|br-)/.test(normalized)
    || /(?:vpn|openvpn|wireguard|wintun|tailscale|zerotier|zero tier|hamachi|clash|mihomo|sing[ -]?box|surge|cloudflare warp|tunnel|virtual|hyper-v|wsl|隧道|虚拟)/.test(normalized)
}

function isLikelyPhysicalInterface(name: string): boolean {
  const normalized = String(name || '').trim().toLowerCase()
  return /^(?:en\d+|eth\d+|enp\w+|eno\w+|ens\w+|wlan\d+|wl\w+)$/.test(normalized)
    || /(?:wi-?fi|wireless|wlan|ethernet|以太网|无线)/.test(normalized)
}

function isRfc1918IPv4(ip: string): boolean {
  const value = ipv4ToInt(ip)
  if (value === null) return false
  const first = (value >>> 24) & 255
  const second = (value >>> 16) & 255
  return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168)
}

function interfacePreference(iface: LanIPv4Interface): number {
  let score = 0
  if (isLikelyPhysicalInterface(iface.name)) score += 100
  if (isRfc1918IPv4(iface.address)) score += 50
  if (iface.address.startsWith('169.254.')) score -= 50
  if (iface.netmask === '255.255.255.255') score -= 20
  return score
}

export function selectLanIPv4Address(
  remoteAddress: string,
  interfaces: LanIPv4Interface[] = getIpv4Interfaces(),
): string {
  const remote = ipv4ToInt(normalizeRemoteAddress(remoteAddress))
  if (remote !== null) {
    for (const iface of interfaces) {
      const ip = ipv4ToInt(iface.address)
      const mask = ipv4ToInt(iface.netmask)
      if (ip !== null && mask !== null && (ip & mask) === (remote & mask)) return iface.address
    }
  }

  const nonVirtualInterfaces = interfaces.filter(iface => !isLikelyVirtualInterface(iface.name))
  const candidates = nonVirtualInterfaces.length ? nonVirtualInterfaces : interfaces
  return candidates
    .map((iface, index) => ({ iface, index, score: interfacePreference(iface) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)[0]?.iface.address || '127.0.0.1'
}

function normalizeRemoteAddress(value: string): string {
  const address = String(value || '').trim()
  return address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address
}

export function getLanBackendUrl(
  remoteAddress = '',
  httpPort = config.port,
  interfaces: LanIPv4Interface[] = getIpv4Interfaces(),
): string {
  const advertised = normalizeAdvertisedOrigin(config.lanAdvertiseUrl)
  if (advertised) return advertised
  const address = selectLanIPv4Address(remoteAddress, interfaces)
  return `http://${address}:${httpPort}`
}

export function getLanBackendUrlForRequest(
  remoteAddress = '',
  requestOrigin = '',
  httpPort = config.port,
  advertisedUrl = config.lanAdvertiseUrl,
  interfaces: LanIPv4Interface[] = getIpv4Interfaces(),
): string {
  const advertised = normalizeAdvertisedOrigin(advertisedUrl)
  if (advertised) return advertised
  const requested = normalizeAdvertisedOrigin(requestOrigin, true)
  if (requested) {
    const requestedHostname = new URL(requested).hostname
    const requestedInterface = interfaces.find(iface => iface.address === requestedHostname)
    const hasNonVirtualInterface = interfaces.some(iface => !isLikelyVirtualInterface(iface.name))
    if (!requestedInterface || !isLikelyVirtualInterface(requestedInterface.name) || !hasNonVirtualInterface) {
      return requested
    }
  }
  const address = selectLanIPv4Address(remoteAddress, interfaces)
  return `http://${address}:${httpPort}`
}

function normalizeAdvertisedOrigin(value: string, rejectLoopback = false): string {
  const raw = String(value || '').trim()
  if (!raw) return ''
  try {
    const url = new URL(raw.includes('://') ? raw : `http://${raw}`)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
    if (!url.hostname || url.username || url.password) return ''
    const hostname = url.hostname.toLowerCase()
    if (rejectLoopback && (
      hostname === 'localhost'
      || hostname.endsWith('.localhost')
      || hostname === '::1'
      || hostname === '0.0.0.0'
      || hostname.startsWith('127.')
    )) return ''
    return url.origin
  } catch {
    return ''
  }
}

async function getCachedLocalInfo(getSystemInfo: () => Promise<PublicSystemInfo>): Promise<PublicSystemInfo> {
  const now = Date.now()
  if (localInfoCache && localInfoCache.expiresAt > now) return localInfoCache.value
  const value = await getSystemInfo()
  localInfoCache = { value, expiresAt: now + 60_000 }
  return value
}

function parseJson(buffer: Buffer): any | null {
  try {
    return JSON.parse(buffer.toString('utf8'))
  } catch {
    return null
  }
}

async function buildAnnouncement(
  request: DiscoveryRequest,
  remoteAddress: string,
  httpPort: number,
  getSystemInfo: () => Promise<PublicSystemInfo>,
): Promise<DiscoveryAnnouncement> {
  const info = await getCachedLocalInfo(getSystemInfo)
  const localAddress = selectLanIPv4Address(remoteAddress)
  return {
    type: 'hermes.announce',
    version: DISCOVERY_VERSION,
    request_id: request.request_id,
    http_port: httpPort,
    endpoint_kind: getLanEndpointKind(httpPort),
    url: `http://${localAddress}:${httpPort}`,
    ...info,
  }
}

export function startLanDiscoveryResponder(options: StartResponderOptions = {}): DiscoverySocket | null {
  if (!isLanDiscoveryEnabled()) return null
  if (responderSockets.length > 0) return responderSockets[0]

  const httpPort = options.httpPort || config.port
  const getSystemInfo = options.getSystemInfo || getPublicSystemInfo
  const discoveryPorts = discoveryPortsForHttpPorts([httpPort])

  for (const discoveryPort of discoveryPorts) {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })

    socket.on('message', (message, rinfo) => {
      if (!isPrivateOrLoopbackIPv4(rinfo.address)) return
      const request = parseJson(message) as DiscoveryRequest | null
      if (!request || request.type !== 'hermes.discover' || request.version !== DISCOVERY_VERSION) return

      void buildAnnouncement(request, rinfo.address, httpPort, getSystemInfo)
        .then(announcement => {
          const response = Buffer.from(JSON.stringify(announcement))
          socket.send(response, rinfo.port, rinfo.address)
        })
        .catch(err => logger.warn(err, '[lan-discovery] failed to build discovery response'))
    })

    socket.on('error', err => {
      logger.warn(err, '[lan-discovery] UDP responder error on port %d', discoveryPort)
    })

    socket.bind(discoveryPort, '0.0.0.0', () => {
      socket.setBroadcast(true)
      socket.unref()
      logger.info('[lan-discovery] responder listening on udp://0.0.0.0:%d for http port %d', discoveryPort, httpPort)
    })

    responderSockets.push(socket)
  }

  return responderSockets[0] || null
}

export function stopLanDiscoveryResponder(): void {
  for (const socket of responderSockets) {
    try {
      socket.close()
    } catch {
      // Ignore close races during shutdown/tests.
    }
  }
  responderSockets = []
}

export function resetLanDiscoveryState(): void {
  localInfoCache = null
  stopLanDiscoveryResponder()
}
