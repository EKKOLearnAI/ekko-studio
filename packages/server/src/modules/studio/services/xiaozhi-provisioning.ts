import { timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os'
import { join } from 'node:path'
import { config, getWebUiHome } from '../public/config'
interface DeviceConfig { deviceId: string; deviceIds?: string[]; setupCode: string; websocketUrl: string; deviceToken: string; gatewayMcpToken?: string }

type Interfaces = Record<string, NetworkInterfaceInfo[] | undefined>

function hostAddress(host: string | undefined): string | undefined {
  if (!host) return undefined
  try {
    const hostname = new URL(`http://${host}`).hostname
    return isIP(hostname) === 4 ? hostname : undefined
  } catch { return undefined }
}

export function selectXiaozhiLanAddress(interfaces: Interfaces, localAddress?: string, requestHost?: string): string | undefined {
  const active = Object.entries(interfaces).flatMap(([name, addresses]) =>
    (addresses || []).filter(address => address.family === 'IPv4' && !address.internal)
      .map(address => ({ name, address: address.address })))
  const requested = localAddress?.replace(/^::ffff:/, '')
  const fromHost = hostAddress(requestHost)
  for (const address of [requested, fromHost]) {
    if (address && active.some(entry => entry.address === address)) return address
  }
  return active.find(entry => /^(wl|en|eth|Wi-Fi)/i.test(entry.name))?.address
    ?? active.find(entry => !/^(br-|docker|veth|virbr|lo|FlClash)/i.test(entry.name))?.address
}

function currentWebsocketUrl(c: DeviceConfig, localAddress?: string, requestHost?: string): string {
  const lanAddress = selectXiaozhiLanAddress(networkInterfaces(), localAddress, requestHost)
  if (!lanAddress) return c.websocketUrl
  const url = new URL(c.websocketUrl)
  url.hostname = lanAddress
  return url.toString()
}

export async function readXiaozhiConfig(): Promise<DeviceConfig | null> {
  try {
    const c = JSON.parse(await readFile(join(getWebUiHome(), 'devices', 'xiaozhi.json'), 'utf8'))
    if (typeof c.deviceId !== 'string' || typeof c.setupCode !== 'string' || c.setupCode.length < 24 || typeof c.deviceToken !== 'string' || c.deviceToken.length < 24) return null
    const u = new URL(c.websocketUrl)
    if (!['ws:', 'wss:'].includes(u.protocol) || u.username || u.password) return null
    return c
  } catch { return null }
}
export async function getXiaozhiProvisioning(deviceId: string, code: string, localAddress?: string, requestHost?: string) {
  const c = await readXiaozhiConfig()
  if (!c || ![c.deviceId, ...(c.deviceIds || [])].some(id => id.toLowerCase() === deviceId.toLowerCase())) return null
  const expected = Buffer.from(c.setupCode), supplied = Buffer.from(code)
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return null
  return { websocket: { url: currentWebsocketUrl(c, localAddress, requestHost), token: c.deviceToken, version: 1 }, server_time: { timestamp: Date.now() } }
}
export async function getXiaozhiStatus(localAddress?: string, requestHost?: string) {
  const c = await readXiaozhiConfig()
  if (!c) return { configured: false, gatewayOnline: false, sessions: 0 }
  const ws = new URL(currentWebsocketUrl(c, localAddress, requestHost))
  const ota = new URL(`http://${ws.hostname}:${config.port}`)
  ota.pathname = `/api/studio/xiaozhi/ota/${encodeURIComponent(c.setupCode)}`
  let gatewayOnline = false, sessions = 0
  try {
    const r = await fetch(`http://127.0.0.1:${ws.port || '8765'}/health`, { signal: AbortSignal.timeout(2000), redirect: 'error' })
    const h = await r.json() as any
    gatewayOnline = r.ok && h.ok === true && h.service === 'xiaozhi-ekko-gateway'
    if (gatewayOnline && Number.isSafeInteger(h.sessions) && h.sessions >= 0) sessions = h.sessions
  } catch { /* Gateway offline. */ }
  return { configured: true, deviceId: c.deviceId, otaUrl: ota.toString(), gatewayOnline, sessions }
}
