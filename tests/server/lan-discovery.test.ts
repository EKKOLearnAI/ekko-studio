import { readFileSync } from 'fs'
import { createHash, generateKeyPairSync } from 'crypto'
import { afterEach, describe, expect, it } from 'vitest'
import {
  HERMES_DISCOVERY_PORT,
  discoveryPortForHttpPort,
  getDiscoveryHttpPorts,
  getLanBackendUrl,
  getLanBackendUrlForRequest,
  getLanEndpointKind,
  isPrivateOrLoopbackIPv4,
  resetLanDiscoveryState,
  scanLanDevices,
  selectLanIPv4Address,
  startLanDiscoveryResponder,
} from '../../packages/server/src/modules/studio/services/network/lan-pairing-discovery'
import type { PublicSystemInfo } from '../../packages/server/src/modules/studio/public/system-info'

const fakeKeyPair = generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})
const fakeDeviceId = `hwui_${createHash('sha256').update(fakeKeyPair.publicKey).digest('base64url').slice(0, 32)}`

const fakeInfo: PublicSystemInfo = {
  device_id: fakeDeviceId,
  device_public_key: fakeKeyPair.publicKey,
  computer_name: 'test-machine',
  os: {
    type: 'TestOS',
    platform: 'linux',
    release: '1.0.0',
    arch: 'x64',
  },
  hermes_agent_version: 'v1.2.3',
  hermes_web_ui_version: '9.9.9',
}

describe('LAN discovery', () => {
  const originalPorts = process.env.HERMES_LAN_DISCOVERY_HTTP_PORTS

  afterEach(() => {
    resetLanDiscoveryState()
    if (originalPorts === undefined) delete process.env.HERMES_LAN_DISCOVERY_HTTP_PORTS
    else process.env.HERMES_LAN_DISCOVERY_HTTP_PORTS = originalPorts
  })

  it('maps HTTP ports to UDP discovery ports', () => {
    expect(HERMES_DISCOVERY_PORT).toBe(48640)
    expect(discoveryPortForHttpPort(6060)).toBe(46060)
    expect(discoveryPortForHttpPort(8748)).toBe(48748)
  })

  it('starts a fixed-port discovery responder for HTTP ports without a UDP mapping', async () => {
    const socket = startLanDiscoveryResponder({
      httpPort: 54321,
      getSystemInfo: async () => fakeInfo,
    })

    expect(socket).not.toBeNull()
    if (socket) await new Promise<void>(resolve => socket.once('listening', () => resolve()))
  })

  it('classifies well-known LAN endpoints', () => {
    expect(getLanEndpointKind(6060)).toBe('web')
    expect(getLanEndpointKind(8748)).toBe('desktop')
    expect(getLanEndpointKind(19001)).toBe('custom')
  })

  it('builds an App backend URL on a private local interface', () => {
    const url = new URL(getLanBackendUrl('::ffff:127.0.0.1', 19004, [{ name: 'eth0', address: '192.168.10.10', netmask: '255.255.255.0' }]))

    expect(url.protocol).toBe('http:')
    expect(url.port).toBe('19004')
    expect(isPrivateOrLoopbackIPv4(url.hostname)).toBe(true)
  })

  it('uses the externally requested host instead of a Docker container interface', () => {
    expect(getLanBackendUrlForRequest(
      '172.19.0.1',
      'http://192.168.10.102:6060',
      6060,
      '',
    )).toBe('http://192.168.10.102:6060')
  })

  it('supports an explicit Docker LAN advertise URL and ignores localhost request origins', () => {
    expect(getLanBackendUrlForRequest(
      '172.19.0.1',
      'http://localhost:6060',
      6060,
      'http://192.168.10.102:16060',
    )).toBe('http://192.168.10.102:16060')
    expect(getLanBackendUrlForRequest(
      '192.168.10.20',
      'http://localhost:6060',
      6060,
      '',
    )).not.toBe('http://localhost:6060')
  })

  it('prefers a physical LAN interface over VPN and virtual adapters for local QR codes', () => {
    const interfaces = [
      { name: 'utun4', address: '10.8.0.2', netmask: '255.255.255.255' },
      { name: 'docker0', address: '172.17.0.1', netmask: '255.255.0.0' },
      { name: 'en0', address: '192.168.10.102', netmask: '255.255.255.0' },
    ]

    expect(selectLanIPv4Address('127.0.0.1', interfaces)).toBe('192.168.10.102')
    expect(getLanBackendUrlForRequest(
      '127.0.0.1',
      'http://localhost:8648',
      8648,
      '',
      interfaces,
    )).toBe('http://192.168.10.102:8648')
  })

  it('ignores a VPN request origin when a physical LAN interface is available', () => {
    const interfaces = [
      { name: 'Tailscale Tunnel', address: '100.64.0.2', netmask: '255.255.255.255' },
      { name: 'Wi-Fi', address: '192.168.1.20', netmask: '255.255.255.0' },
    ]

    expect(getLanBackendUrlForRequest(
      '127.0.0.1',
      'http://100.64.0.2:8648',
      8648,
      '',
      interfaces,
    )).toBe('http://192.168.1.20:8648')
  })

  it('keeps an exact remote subnet match even when it uses a VPN interface', () => {
    const interfaces = [
      { name: 'WireGuard Tunnel', address: '10.8.0.2', netmask: '255.255.255.0' },
      { name: 'Ethernet', address: '192.168.1.20', netmask: '255.255.255.0' },
    ]

    expect(selectLanIPv4Address('10.8.0.50', interfaces)).toBe('10.8.0.2')
  })

  it('limits discovery responses to local/private IPv4 senders', () => {
    expect(isPrivateOrLoopbackIPv4('127.0.0.1')).toBe(true)
    expect(isPrivateOrLoopbackIPv4('192.168.1.20')).toBe(true)
    expect(isPrivateOrLoopbackIPv4('10.1.2.3')).toBe(true)
    expect(isPrivateOrLoopbackIPv4('172.16.0.1')).toBe(true)
    expect(isPrivateOrLoopbackIPv4('8.8.8.8')).toBe(false)
  })

  it('uses configured scan ports plus the active server port', () => {
    process.env.HERMES_LAN_DISCOVERY_HTTP_PORTS = '6060, 8748'

    expect(getDiscoveryHttpPorts(9999)).toEqual([6060, 8748, 9999])
  })

  it('discovers a local responder over UDP', async () => {
    const httpPort = 19001
    const socket = startLanDiscoveryResponder({
      httpPort,
      getSystemInfo: async () => fakeInfo,
    })
    if (!socket) throw new Error('expected discovery responder socket')
    await new Promise<void>(resolve => socket.once('listening', () => resolve()))

    const result = await scanLanDevices({
      httpPorts: [httpPort],
      targetAddresses: ['127.0.0.1'],
      timeoutMs: 300,
      includeSelf: true,
    })

    expect(result.scanning).toBe(false)
    const device = result.devices.find(item => item.device_id === fakeDeviceId && item.http_port === httpPort)
    expect(device).toMatchObject({
      id: fakeDeviceId,
      device_id: fakeDeviceId,
      ip: '127.0.0.1',
      http_port: httpPort,
      url: `http://127.0.0.1:${httpPort}`,
      endpoint_kind: 'custom',
      computer_name: 'test-machine',
      hermes_agent_version: 'v1.2.3',
      hermes_web_ui_version: '9.9.9',
    })
  })

  it('builds device URLs from the UDP source address instead of announced URLs', async () => {
    const httpPort = 19003
    const socket = startLanDiscoveryResponder({
      httpPort,
      getSystemInfo: async () => fakeInfo,
    })
    if (!socket) throw new Error('expected discovery responder socket')
    await new Promise<void>(resolve => socket.once('listening', () => resolve()))

    const originalSend = socket.send.bind(socket)
    socket.send = ((message: any, port: any, address: any, callback?: any) => {
      const announced = JSON.parse(Buffer.from(message).toString('utf8'))
      announced.url = 'http://127.0.0.1:1'
      return originalSend(Buffer.from(JSON.stringify(announced)), port, address, callback)
    }) as typeof socket.send

    const result = await scanLanDevices({
      httpPorts: [httpPort],
      targetAddresses: ['127.0.0.1'],
      timeoutMs: 300,
      includeSelf: true,
    })

    const device = result.devices.find(item => item.device_id === fakeDeviceId && item.http_port === httpPort)
    expect(device?.url).toBe(`http://127.0.0.1:${httpPort}`)
  })

  it('excludes the local machine from scan results by default', async () => {
    const httpPort = 19002
    const socket = startLanDiscoveryResponder({
      httpPort,
      getSystemInfo: async () => fakeInfo,
    })
    if (!socket) throw new Error('expected discovery responder socket')
    await new Promise<void>(resolve => socket.once('listening', () => resolve()))

    const result = await scanLanDevices({
      httpPorts: [httpPort],
      targetAddresses: ['127.0.0.1'],
      timeoutMs: 300,
    })

    expect(result.scanning).toBe(false)
    expect(result.devices).toEqual([])
  })

  it('registers device request routes before auth and device management routes behind super admin auth', () => {
    const source = readFileSync('packages/server/src/bootstrap/routes.ts', 'utf8')
    const deviceRoutesSource = readFileSync('packages/server/src/modules/studio/routes/devices.ts', 'utf8')
    const bootstrapSource = readFileSync('packages/server/src/bootstrap/http.ts', 'utf8')

    const authIndex = source.indexOf('authMiddleware.forEach')
    const publicDeviceIndex = source.indexOf('app.use(devicePublicRoutes.routes())')
    const deviceIndex = source.indexOf('app.use(deviceRoutes.routes())')

    expect(authIndex).toBeGreaterThanOrEqual(0)
    expect(publicDeviceIndex).toBeGreaterThanOrEqual(0)
    expect(deviceIndex).toBeGreaterThanOrEqual(0)
    expect(deviceRoutesSource).toContain("devicePublicRoutes.post('/api/studio/devices/link-status'")
    expect(deviceRoutesSource).toContain("devicePublicRoutes.get('/api/studio/devices/link-info'")
    expect(deviceRoutesSource).toContain("import { requireSuperAdmin }")
    expect(deviceRoutesSource).toContain('deviceRoutes.use(requireSuperAdmin)')
    expect(deviceRoutesSource).toContain("deviceRoutes.get('/api/studio/devices/pairing-link'")
    expect(deviceRoutesSource).toContain("deviceRoutes.post('/api/studio/devices/manual-request'")
    expect(deviceRoutesSource).toContain("deviceRoutes.delete('/api/studio/devices/:id/request-history'")
    expect(deviceRoutesSource).toContain("deviceRoutes.get('/api/studio/devices/peer-connections'")
    expect(deviceRoutesSource).toContain("deviceRoutes.post('/api/studio/devices/:id/connect'")
    expect(deviceRoutesSource).toContain("deviceRoutes.get('/api/studio/devices/peer-connections/:connectionId/terminals'")
    expect(bootstrapSource).toContain('getLanPeerSocketPath()')
    expect(publicDeviceIndex).toBeLessThan(authIndex)
    expect(deviceIndex).toBeGreaterThan(authIndex)
  })

  it('keeps LAN peer terminals bounded and idle-reclaimable', () => {
    const peerSocketSource = readFileSync('packages/server/src/modules/studio/services/network/lan-peer-socket.ts', 'utf8')

    expect(peerSocketSource).toContain("boundedEnvInt('HERMES_LAN_PEER_MAX_TERMINALS', 4")
    expect(peerSocketSource).toContain("boundedEnvInt('HERMES_LAN_PEER_TERMINAL_IDLE_MS', 10 * 60 * 1000")
    expect(peerSocketSource).toContain("boundedEnvInt('HERMES_LAN_PEER_TERMINAL_BUFFER_BYTES', 1024 * 1024")
    expect(peerSocketSource).toContain('Terminal limit reached')
    expect(peerSocketSource).toContain('[lan-peer] closing idle terminal')
    expect(peerSocketSource).toContain('this.disposeTerminalSession(session, { notify: false })')
  })

  it('exposes an MCP terminal list tool so agents can recover forgotten terminal ids', () => {
    const mcpSource = readFileSync('bin/ekko-studio-mcp.mjs', 'utf8')

    expect(mcpSource).toContain("name: 'ekko_studio_lan_devices_list'")
    expect(mcpSource).toContain('online status')
    expect(mcpSource).toContain('temporary profile token')
    expect(mcpSource).toContain("'X-Hermes-Profile': profile")
    expect(mcpSource).toContain('token: args.token')
    expect(mcpSource).toContain('profile: args.profile')
    expect(mcpSource).toContain("join(appHome(), 'profiles', segment, '.model-run-token')")
    expect(mcpSource).toContain("name: 'ekko_studio_lan_terminal_list'")
    expect(mcpSource).toContain('/terminals`, withAuthArgs(args))')
  })
})
