import dgram from 'node:dgram'
import { createHash, generateKeyPairSync } from 'crypto'
import { afterEach, describe, expect, it } from 'vitest'
import {
  HERMES_DISCOVERY_PORT,
  discoveryPortForHttpPort,
  getLanBackendUrl,
  getLanBackendUrlForRequest,
  getLanEndpointKind,
  isPrivateOrLoopbackIPv4,
  resetLanDiscoveryState,
  selectLanIPv4Address,
  startLanDiscoveryResponder,
} from '../../packages/server/src/modules/studio/services/network/lan-discovery'
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
  afterEach(() => {
    resetLanDiscoveryState()
  })

  it('maps HTTP ports to UDP discovery ports', () => {
    expect(HERMES_DISCOVERY_PORT).toBe(48640)
    expect(discoveryPortForHttpPort(8648)).toBe(48648)
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
    expect(getLanEndpointKind(8648)).toBe('web')
    expect(getLanEndpointKind(8748)).toBe('desktop')
    expect(getLanEndpointKind(19001)).toBe('custom')
  })

  it('builds an App backend URL on a private local interface', () => {
    const url = new URL(getLanBackendUrl('::ffff:127.0.0.1', 19004))

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

  it('still answers the UDP discovery request used by shipped Small Box firmware', async () => {
    const socket = startLanDiscoveryResponder({ httpPort: 19001, getSystemInfo: async () => fakeInfo })
    if (!socket) throw new Error('expected discovery responder socket')
    await new Promise<void>(resolve => socket.once('listening', resolve))
    const client = dgram.createSocket('udp4')
    try {
      const response = new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('discovery response timed out')), 1500)
        client.once('message', message => { clearTimeout(timer); resolve(JSON.parse(message.toString())) })
        client.once('error', error => { clearTimeout(timer); reject(error) })
      })
      client.send(Buffer.from(JSON.stringify({ type: 'hermes.discover', version: 1, request_id: 'mcu-1' })), discoveryPortForHttpPort(19001), '127.0.0.1')
      expect(await response).toMatchObject({
        ...fakeInfo, type: 'hermes.announce', version: 1, request_id: 'mcu-1',
        http_port: 19001, endpoint_kind: 'custom', url: `http://${selectLanIPv4Address('127.0.0.1')}:19001`,
      })
    } finally { client.close() }
  })
})
