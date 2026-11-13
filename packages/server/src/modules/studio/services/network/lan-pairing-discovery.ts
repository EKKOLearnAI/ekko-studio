import dgram from 'dgram'
import { networkInterfaces } from 'os'
import { config } from '../../public/config'
import { logger } from '../../public/logging'
import { deviceIdFromPublicKey, getPublicSystemInfo, type PublicSystemInfo } from '../../public/system-info'

const DISCOVERY_VERSION = 1
export const HERMES_DISCOVERY_PORT = 48640
const DISCOVERY_PORT_OFFSET = 40_000
const DEFAULT_HTTP_PORTS = [6060, 8748]
const DEFAULT_SCAN_TIMEOUT_MS = 1000

type DiscoverySocket = dgram.Socket

export type LanDeviceInfo = PublicSystemInfo & {
  id: string
  ip: string
  http_port: number
  endpoint_kind: LanEndpointKind
  url: string
  response_ms: number
  last_seen_at: string
}

export type LanEndpointKind = 'web' | 'desktop' | 'custom'

export type LanDiscoveryState = {
  scanning: boolean
  last_scanned_at: string | null
  devices: LanDeviceInfo[]
}

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

type ScanOptions = {
  timeoutMs?: number
  httpPorts?: number[]
  targetAddresses?: string[]
  includeSelf?: boolean
}

export type LanIPv4Interface = {
  name: string
  address: string
  netmask: string
}

let responderSockets: DiscoverySocket[] = []
let cache: LanDiscoveryState = {
  scanning: false,
  last_scanned_at: null,
  devices: [],
}
let scanInFlight: Promise<LanDiscoveryState> | null = null
let localInfoCache: { value: PublicSystemInfo; expiresAt: number } | null = null

function envFlagDisabled(name: string): boolean {
  const value = String(process.env[name] || '').trim().toLowerCase()
  return ['0', 'false', 'no', 'off'].includes(value)
}

export function isLanDiscoveryEnabled(): boolean {
  return !envFlagDisabled('HERMES_LAN_DISCOVERY_ENABLED')
}

function parsePortList(value: string | undefined): number[] {
  return String(value || '')
    .split(/[\s,]+/)
    .map(item => Number.parseInt(item, 10))
    .filter(port => Number.isInteger(port) && port > 0 && port <= 65535)
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
  if (httpPort === 6060) return 'web'
  if (httpPort === 8748) return 'desktop'
  if (httpPort === 8648 || httpPort === currentPort) return 'web'
  return 'custom'
}

export function getDiscoveryHttpPorts(currentPort = config.port): number[] {
  const configured = parsePortList(process.env.HERMES_LAN_DISCOVERY_HTTP_PORTS)
  return [...new Set([...(configured.length ? configured : DEFAULT_HTTP_PORTS), currentPort])]
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.').map(part => Number.parseInt(part, 10))
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return null
  return (((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]) >>> 0
}

function intToIpv4(value: number): string {
  return [
    (value >>> 24) & 255,
    (value >>> 16) & 255,
    (value >>> 8) & 255,
    value & 255,
  ].join('.')
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

function getLocalIPv4Addresses(): Set<string> {
  return new Set([
    '127.0.0.1',
    ...getIpv4Interfaces().map(iface => iface.address),
  ])
}

function broadcastAddress(address: string, netmask: string): string | null {
  const ip = ipv4ToInt(address)
  const mask = ipv4ToInt(netmask)
  if (ip === null || mask === null) return null
  return intToIpv4((ip | (~mask >>> 0)) >>> 0)
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

export function getDiscoveryTargetAddresses(): string[] {
  const targets = new Set<string>(['255.255.255.255'])
  for (const iface of getIpv4Interfaces()) {
    const broadcast = broadcastAddress(iface.address, iface.netmask)
    if (broadcast) targets.add(broadcast)
  }
  return [...targets]
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

function normalizeDevice(data: any, sourceAddress: string, responseMs: number, seenAt: string): LanDeviceInfo | null {
  if (!data || data.type !== 'hermes.announce' || data.version !== DISCOVERY_VERSION) return null
  const httpPort = Number(data.http_port)
  if (!Number.isInteger(httpPort) || httpPort <= 0 || httpPort > 65535) return null
  const deviceId = typeof data.device_id === 'string' && data.device_id ? data.device_id : ''
  const devicePublicKey = typeof data.device_public_key === 'string' ? data.device_public_key : ''
  if (!deviceId || !devicePublicKey || deviceIdFromPublicKey(devicePublicKey) !== deviceId) return null
  const endpointKind = data.endpoint_kind === 'web' || data.endpoint_kind === 'desktop' || data.endpoint_kind === 'custom'
    ? data.endpoint_kind
    : getLanEndpointKind(httpPort)
  const url = `http://${sourceAddress}:${httpPort}`
  return {
    id: deviceId,
    device_id: deviceId,
    device_public_key: devicePublicKey,
    ip: sourceAddress,
    http_port: httpPort,
    endpoint_kind: endpointKind,
    url,
    computer_name: String(data.computer_name || ''),
    os: {
      type: String(data.os?.type || ''),
      platform: String(data.os?.platform || '') as NodeJS.Platform,
      release: String(data.os?.release || ''),
      arch: String(data.os?.arch || ''),
    },
    hermes_agent_version: String(data.hermes_agent_version || ''),
    hermes_web_ui_version: String(data.hermes_web_ui_version || ''),
    response_ms: responseMs,
    last_seen_at: seenAt,
  }
}

function isSelfDevice(device: LanDeviceInfo, localAddresses: Set<string>): boolean {
  return localAddresses.has(device.ip)
}

export function getLanDiscoveryCache(): LanDiscoveryState {
  return {
    scanning: cache.scanning,
    last_scanned_at: cache.last_scanned_at,
    devices: [...cache.devices],
  }
}

export async function scanLanDevices(options: ScanOptions = {}): Promise<LanDiscoveryState> {
  if (!isLanDiscoveryEnabled()) return getLanDiscoveryCache()
  if (scanInFlight) return scanInFlight

  const timeoutMs = Math.max(100, Math.min(options.timeoutMs || DEFAULT_SCAN_TIMEOUT_MS, 5000))
  const httpPorts = [...new Set(options.httpPorts || getDiscoveryHttpPorts())]
  const targetAddresses = options.targetAddresses || getDiscoveryTargetAddresses()
  const localAddresses = getLocalIPv4Addresses()
  const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`

  cache = { ...cache, scanning: true }
  const startedAt = Date.now()

  scanInFlight = new Promise<LanDiscoveryState>((resolve) => {
    const socket = dgram.createSocket('udp4')
    const found = new Map<string, LanDeviceInfo>()

    socket.on('message', (message, rinfo) => {
      if (!isPrivateOrLoopbackIPv4(rinfo.address)) return
      const data = parseJson(message)
      if (data?.request_id && data.request_id !== requestId) return
      const device = normalizeDevice(data, rinfo.address, Date.now() - startedAt, new Date().toISOString())
      if (device && !options.includeSelf && isSelfDevice(device, localAddresses)) return
      if (device) found.set(device.id, device)
    })

    socket.on('error', err => {
      logger.warn(err, '[lan-discovery] UDP scan error')
    })

    socket.bind(0, '0.0.0.0', () => {
      socket.setBroadcast(true)
      const packet = Buffer.from(JSON.stringify({
        type: 'hermes.discover',
        version: DISCOVERY_VERSION,
        request_id: requestId,
      }))
      for (const discoveryPort of discoveryPortsForHttpPorts(httpPorts)) {
        for (const target of targetAddresses) {
          socket.send(packet, discoveryPort, target)
        }
      }
    })

    setTimeout(() => {
      try {
        socket.close()
      } catch {
        // Ignore close races.
      }
      cache = {
        scanning: false,
        last_scanned_at: new Date().toISOString(),
        devices: [...found.values()].sort((a, b) => a.id.localeCompare(b.id)),
      }
      resolve(getLanDiscoveryCache())
    }, timeoutMs)
  }).finally(() => {
    scanInFlight = null
  })

  return scanInFlight
}

export function resetLanDiscoveryState(): void {
  cache = {
    scanning: false,
    last_scanned_at: null,
    devices: [],
  }
  scanInFlight = null
  localInfoCache = null
  stopLanDiscoveryResponder()
}
