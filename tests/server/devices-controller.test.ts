import { createHash, generateKeyPairSync, sign } from 'crypto'
import { createServer, type Server } from 'http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LanDeviceInfo } from '../../packages/server/src/modules/studio/services/network/lan-pairing-discovery'

const keyPair = generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})
const deviceId = `hwui_${createHash('sha256').update(keyPair.publicKey).digest('base64url').slice(0, 32)}`

const device: LanDeviceInfo = {
  id: deviceId,
  device_id: deviceId,
  device_public_key: keyPair.publicKey,
  computer_name: 'paired-device',
  endpoint_kind: 'web',
  ip: '192.168.1.20',
  http_port: 8648,
  url: 'http://192.168.1.20:8648',
  os: {
    type: 'Linux',
    platform: 'linux',
    release: '1',
    arch: 'x64',
  },
  hermes_agent_version: 'v1',
  hermes_web_ui_version: '1',
  response_ms: 12,
  last_seen_at: new Date().toISOString(),
}

describe('devices controller', () => {
  let db: any = null

  beforeEach(async () => {
    vi.resetModules()
    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(':memory:')
    vi.doMock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({
      getDb: () => db,
      getStoragePath: () => ':memory:',
    }))
    const { initAllHermesTables } = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
    initAllHermesTables()
  })

  afterEach(() => {
    db?.close()
    db = null
    vi.unstubAllGlobals()
    vi.doUnmock('../../packages/server/src/modules/studio/infrastructure/database/index')
    vi.doUnmock('../../packages/server/src/modules/studio/services/auth/login-limiter')
    vi.resetModules()
  })

  it('allows cross-origin reads of public device link info', async () => {
    vi.doMock('../../packages/server/src/modules/studio/public/system-info', async () => {
      const actual = await vi.importActual<typeof import('../../packages/server/src/modules/studio/public/system-info')>(
        '../../packages/server/src/modules/studio/public/system-info',
      )
      return {
        ...actual,
        getPublicSystemInfo: async () => ({
          device_id: 'hwui_local',
          device_public_key: keyPair.publicKey,
          computer_name: 'local',
          os: { type: 'TestOS', platform: 'linux', release: '1', arch: 'x64' },
          hermes_agent_version: 'v1',
          hermes_web_ui_version: '1',
        }),
      }
    })

    const set = vi.fn()
    const ctx: any = { set }
    const { deviceLinkInfoController } = await import('../../packages/server/src/modules/studio/controllers/devices')

    await deviceLinkInfoController(ctx)

    expect(set).toHaveBeenCalledWith('Access-Control-Allow-Origin', '*')
    expect(ctx.body).toEqual(expect.objectContaining({
      device_id: 'hwui_local',
      http_port: expect.any(Number),
      app_relay: {
        protocol: 'socket.io',
        namespace: '/app-relay',
        direct: true,
      },
    }))
  })

  it('returns the inbound pairing status for a signed device status request', async () => {
    const { requestInboundDeviceLink, updateInboundStatus } = await import('../../packages/server/src/modules/studio/repositories/devices-store')
    requestInboundDeviceLink(device)
    updateInboundStatus(device.id, 'approved')

    const timestamp = Date.now()
    const nonce = 'status-nonce-1'
    const signature = sign(null, Buffer.from(`${device.id}.${nonce}.${timestamp}`), keyPair.privateKey).toString('base64url')
    const ctx: any = {
      request: {
        body: {
          device_id: device.id,
          device_public_key: device.device_public_key,
          timestamp,
          nonce,
          signature,
        },
      },
    }

    const { requestDeviceLinkStatusController } = await import('../../packages/server/src/modules/studio/controllers/devices')
    await requestDeviceLinkStatusController(ctx)

    expect(ctx.status).toBeUndefined()
    expect(ctx.body).toEqual({ status: 'approved' })
  })

  it('keeps LAN pairing requests code-free and derives the device URL from the request source', async () => {
    const timestamp = Date.now()
    const nonce = 'lan-request-nonce-1'
    const signature = sign(null, Buffer.from(`${device.id}.${nonce}.${timestamp}`), keyPair.privateKey).toString('base64url')
    const ctx: any = {
      ip: '192.168.1.99',
      request: {
        ip: '192.168.1.99',
        body: {
          ...device,
          http_port: 8648,
          url: 'javascript:alert(1)',
          timestamp,
          nonce,
          signature,
        },
      },
    }

    const { getDeviceRelation } = await import('../../packages/server/src/modules/studio/repositories/devices-store')
    const { requestDeviceLinkController } = await import('../../packages/server/src/modules/studio/controllers/devices')
    await requestDeviceLinkController(ctx)

    expect(ctx.status).toBeUndefined()
    expect(ctx.body).toEqual({ status: 'pending' })
    expect(getDeviceRelation(device.id)?.url).toBe('http://192.168.1.99:8648')
  })

  it('requires the startup pairing code before public requests enter the approval list', async () => {
    const timestamp = Date.now()
    const nonce = 'public-request-nonce-1'
    const signature = sign(null, Buffer.from(`${device.id}.${nonce}.${timestamp}`), keyPair.privateKey).toString('base64url')
    const ctx: any = {
      ip: '8.8.8.8',
      request: {
        ip: '8.8.8.8',
        body: {
          ...device,
          http_port: 8648,
          timestamp,
          nonce,
          signature,
        },
      },
    }

    const { getDeviceRelation } = await import('../../packages/server/src/modules/studio/repositories/devices-store')
    const { requestDeviceLinkController } = await import('../../packages/server/src/modules/studio/controllers/devices')
    await requestDeviceLinkController(ctx)

    expect(ctx.status).toBe(403)
    expect(ctx.body).toEqual({ error: 'Invalid pairing code' })
    expect(getDeviceRelation(device.id)).toBeNull()
  })

  it('does not trust forged forwarded private IPs for public pairing requests', async () => {
    const recordPairingFailure = vi.fn()
    vi.doMock('../../packages/server/src/modules/studio/services/auth/login-limiter', () => ({
      checkPairing: (ip: string) => {
        expect(ip).toBe('8.8.8.8')
        return { allowed: true }
      },
      recordPairingFailure,
    }))

    const timestamp = Date.now()
    const nonce = 'forged-forwarded-private-request-nonce-1'
    const signature = sign(null, Buffer.from(`${device.id}.${nonce}.${timestamp}`), keyPair.privateKey).toString('base64url')
    const ctx: any = {
      ip: '8.8.8.8',
      get: (name: string) => name.toLowerCase() === 'x-forwarded-for' ? '192.168.1.44' : '',
      request: {
        ip: '8.8.8.8',
        body: {
          ...device,
          http_port: 8648,
          timestamp,
          nonce,
          signature,
        },
      },
    }

    const { getDeviceRelation } = await import('../../packages/server/src/modules/studio/repositories/devices-store')
    const { requestDeviceLinkController } = await import('../../packages/server/src/modules/studio/controllers/devices')
    await requestDeviceLinkController(ctx)

    expect(ctx.status).toBe(403)
    expect(ctx.body).toEqual({ error: 'Invalid pairing code' })
    expect(recordPairingFailure).toHaveBeenCalledWith('8.8.8.8')
    expect(getDeviceRelation(device.id)).toBeNull()
  })

  it('requires the startup pairing code for public clients forwarded through loopback proxies', async () => {
    const timestamp = Date.now()
    const nonce = 'forwarded-public-request-nonce-1'
    const signature = sign(null, Buffer.from(`${device.id}.${nonce}.${timestamp}`), keyPair.privateKey).toString('base64url')
    const ctx: any = {
      ip: '127.0.0.1',
      get: (name: string) => name.toLowerCase() === 'x-forwarded-for' ? '203.0.113.10' : '',
      request: {
        ip: '127.0.0.1',
        body: {
          ...device,
          http_port: 8648,
          timestamp,
          nonce,
          signature,
        },
      },
    }

    const { getDeviceRelation } = await import('../../packages/server/src/modules/studio/repositories/devices-store')
    const { requestDeviceLinkController } = await import('../../packages/server/src/modules/studio/controllers/devices')
    await requestDeviceLinkController(ctx)

    expect(ctx.status).toBe(403)
    expect(ctx.body).toEqual({ error: 'Invalid pairing code' })
    expect(getDeviceRelation(device.id)).toBeNull()
  })

  it('stores public pairing requests as pending when the startup pairing code is valid', async () => {
    vi.doMock('../../packages/server/src/modules/studio/services/network/device-pairing-code', () => ({
      getDevicePairingCode: () => 'pair-secret',
      verifyDevicePairingCode: (value: unknown) => value === 'pair-secret',
    }))
    const timestamp = Date.now()
    const nonce = 'public-request-nonce-2'
    const signature = sign(null, Buffer.from(`${device.id}.${nonce}.${timestamp}`), keyPair.privateKey).toString('base64url')
    const ctx: any = {
      ip: '8.8.4.4',
      request: {
        ip: '8.8.4.4',
        body: {
          ...device,
          http_port: 8648,
          pairing_code: 'pair-secret',
          timestamp,
          nonce,
          signature,
        },
      },
    }

    const { getDeviceRelation } = await import('../../packages/server/src/modules/studio/repositories/devices-store')
    const { requestDeviceLinkController } = await import('../../packages/server/src/modules/studio/controllers/devices')
    await requestDeviceLinkController(ctx)

    expect(ctx.status).toBeUndefined()
    expect(ctx.body).toEqual({ status: 'pending' })
    expect(getDeviceRelation(device.id)?.inbound_status).toBe('pending')
    expect(getDeviceRelation(device.id)?.url).toBe('http://8.8.4.4:8648')
  })

  it('prefers public request hosts when building copyable pairing links', async () => {
    vi.doMock('../../packages/server/src/modules/studio/services/network/device-pairing-code', () => ({
      getDevicePairingCode: () => 'pair-secret',
      verifyDevicePairingCode: () => false,
    }))

    const { getDevicePairingLink } = await import('../../packages/server/src/modules/studio/controllers/devices')
    const ctx: any = {
      protocol: 'http',
      host: 'studio.example.com',
      get: (name: string) => name.toLowerCase() === 'x-forwarded-proto' ? 'https' : '',
    }

    await getDevicePairingLink(ctx)

    expect(ctx.body).toEqual({
      code: 'pair-secret',
      link: 'https://studio.example.com/#/hermes/devices?pairing_code=pair-secret',
    })
  })

  it('falls back from localhost to LAN addresses when building copyable pairing links', async () => {
    vi.doMock('os', async () => {
      const actual = await vi.importActual<typeof import('os')>('os')
      return {
        ...actual,
        networkInterfaces: () => ({
          lo0: [{ family: 'IPv4', internal: true, address: '127.0.0.1', netmask: '255.0.0.0' }],
          en0: [{ family: 'IPv4', internal: false, address: '192.168.1.88', netmask: '255.255.255.0' }],
        }),
      }
    })
    vi.doMock('../../packages/server/src/modules/studio/services/network/device-pairing-code', () => ({
      getDevicePairingCode: () => 'pair-secret',
      verifyDevicePairingCode: () => false,
    }))

    const { getDevicePairingLink } = await import('../../packages/server/src/modules/studio/controllers/devices')
    const ctx: any = {
      protocol: 'http',
      host: 'localhost:8648',
      get: () => '',
    }

    await getDevicePairingLink(ctx)

    expect(ctx.body).toEqual({
      code: 'pair-secret',
      link: 'http://192.168.1.88:6060/#/hermes/devices?pairing_code=pair-secret',
    })
  })

  it('uses a private request host instead of a Docker container interface for pairing links', async () => {
    vi.doMock('../../packages/server/src/modules/studio/services/network/device-pairing-code', () => ({
      getDevicePairingCode: () => 'pair-secret',
      verifyDevicePairingCode: () => false,
    }))

    const { getDevicePairingLink } = await import('../../packages/server/src/modules/studio/controllers/devices')
    const ctx: any = {
      protocol: 'http',
      host: '192.168.10.102:6060',
      ip: '172.19.0.1',
      req: { socket: { remoteAddress: '172.19.0.1' } },
      get: () => '',
    }

    await getDevicePairingLink(ctx)

    expect(ctx.body).toEqual({
      code: 'pair-secret',
      link: 'http://192.168.10.102:6060/#/hermes/devices?pairing_code=pair-secret',
    })
  })

  it('rejects peer socket connections until outbound pairing is approved locally', async () => {
    vi.doMock('../../packages/server/src/modules/studio/services/network/lan-pairing-discovery', async () => {
      const actual = await vi.importActual<typeof import('../../packages/server/src/modules/studio/services/network/lan-pairing-discovery')>(
        '../../packages/server/src/modules/studio/services/network/lan-pairing-discovery',
      )
      return {
        ...actual,
        getLanDiscoveryCache: () => ({
          scanning: false,
          last_scanned_at: new Date().toISOString(),
          devices: [device],
        }),
      }
    })

    const { connectPeerDevice } = await import('../../packages/server/src/modules/studio/controllers/devices')
    const ctx: any = {
      params: { id: device.id },
      request: { body: {} },
    }

    await connectPeerDevice(ctx)

    expect(ctx.status).toBe(403)
    expect(ctx.body).toEqual({ error: 'Device pairing has not been approved' })
  })

  it('records outbound status when requesting pairing from a device with inbound history', async () => {
    vi.doMock('../../packages/server/src/modules/studio/services/network/lan-pairing-discovery', async () => {
      const actual = await vi.importActual<typeof import('../../packages/server/src/modules/studio/services/network/lan-pairing-discovery')>(
        '../../packages/server/src/modules/studio/services/network/lan-pairing-discovery',
      )
      return {
        ...actual,
        getLanDiscoveryCache: () => ({
          scanning: false,
          last_scanned_at: new Date().toISOString(),
          devices: [device],
        }),
      }
    })
    vi.doMock('../../packages/server/src/modules/studio/public/system-info', async () => {
      const actual = await vi.importActual<typeof import('../../packages/server/src/modules/studio/public/system-info')>(
        '../../packages/server/src/modules/studio/public/system-info',
      )
      return {
        ...actual,
        getPublicSystemInfo: async () => ({
          device_id: 'hwui_local',
          device_public_key: keyPair.publicKey,
          computer_name: 'local',
          os: { type: 'TestOS', platform: 'linux', release: '1', arch: 'x64' },
          hermes_agent_version: 'v1',
          hermes_web_ui_version: '1',
        }),
        createDeviceSignature: async () => 'signature',
      }
    })

    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ status: 'pending' }),
    }))
    vi.stubGlobal('fetch', fetchMock)

    const { requestInboundDeviceLink, updateInboundStatus, getDeviceRelation } = await import('../../packages/server/src/modules/studio/repositories/devices-store')
    requestInboundDeviceLink(device)
    updateInboundStatus(device.id, 'approved')

    const { requestDevicePairing } = await import('../../packages/server/src/modules/studio/controllers/devices')
    const ctx: any = {
      params: { id: device.id },
      request: { body: {} },
    }

    await requestDevicePairing(ctx)

    const relation = getDeviceRelation(device.id)
    expect(ctx.status).toBeUndefined()
    expect(relation?.inbound_status).toBe('approved')
    expect(relation?.outbound_status).toBe('pending')
    expect(relation?.outbound_requested_at).toBeGreaterThan(0)
    expect(fetchMock).toHaveBeenCalledWith(
      'http://192.168.1.20:8648/api/devices/link-request',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('falls back to the native HTTP client when fetch cannot reach a LAN peer', async () => {
    let receivedRequest: any = null
    let server: Server | null = null

    await new Promise<void>((resolve) => {
      server = createServer((req, res) => {
        const chunks: Buffer[] = []
        req.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
        req.on('end', () => {
          if (req.url === '/api/devices/link-request') {
            receivedRequest = JSON.parse(Buffer.concat(chunks).toString('utf-8'))
          }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ status: 'pending' }))
        })
      })
      server.listen(0, '127.0.0.1', resolve)
    })

    const address = server!.address()
    const port = typeof address === 'object' && address ? address.port : 0
    const fallbackDevice: LanDeviceInfo = {
      ...device,
      ip: '127.0.0.1',
      http_port: port,
      url: `http://127.0.0.1:${port}`,
    }

    try {
      vi.doMock('../../packages/server/src/modules/studio/services/network/lan-pairing-discovery', async () => {
        const actual = await vi.importActual<typeof import('../../packages/server/src/modules/studio/services/network/lan-pairing-discovery')>(
          '../../packages/server/src/modules/studio/services/network/lan-pairing-discovery',
        )
        return {
          ...actual,
          getLanDiscoveryCache: () => ({
            scanning: false,
            last_scanned_at: new Date().toISOString(),
            devices: [fallbackDevice],
          }),
        }
      })
      vi.doMock('../../packages/server/src/modules/studio/public/system-info', async () => {
        const actual = await vi.importActual<typeof import('../../packages/server/src/modules/studio/public/system-info')>(
          '../../packages/server/src/modules/studio/public/system-info',
        )
        return {
          ...actual,
          getPublicSystemInfo: async () => ({
            device_id: 'hwui_local',
            device_public_key: keyPair.publicKey,
            computer_name: 'local',
            os: { type: 'TestOS', platform: 'darwin', release: '1', arch: 'arm64' },
            hermes_agent_version: 'v1',
            hermes_web_ui_version: '1',
          }),
          createDeviceSignature: async () => 'signature',
        }
      })

      const fetchMock = vi.fn(async () => {
        throw Object.assign(new Error(`connect EHOSTUNREACH ${fallbackDevice.ip}:${fallbackDevice.http_port}`), {
          code: 'EHOSTUNREACH',
          syscall: 'connect',
          address: fallbackDevice.ip,
          port: fallbackDevice.http_port,
        })
      })
      vi.stubGlobal('fetch', fetchMock)

      const { getDeviceRelation } = await import('../../packages/server/src/modules/studio/repositories/devices-store')
      const { requestDevicePairing } = await import('../../packages/server/src/modules/studio/controllers/devices')
      const ctx: any = {
        params: { id: fallbackDevice.id },
        request: { body: {} },
      }

      await requestDevicePairing(ctx)

      const relation = getDeviceRelation(fallbackDevice.id)
      expect(ctx.status).toBeUndefined()
      expect(relation?.outbound_status).toBe('pending')
      expect(receivedRequest).toEqual(expect.objectContaining({
        device_id: 'hwui_local',
        signature: 'signature',
      }))
      expect(fetchMock).toHaveBeenCalledWith(
        `http://127.0.0.1:${port}/api/devices/link-request`,
        expect.objectContaining({ method: 'POST' }),
      )
    } finally {
      await new Promise<void>((resolve, reject) => {
        server!.close(err => err ? reject(err) : resolve())
      })
    }
  })

  it('requests pairing from a manually entered remote URL', async () => {
    vi.doMock('../../packages/server/src/modules/studio/services/network/lan-pairing-discovery', async () => {
      const actual = await vi.importActual<typeof import('../../packages/server/src/modules/studio/services/network/lan-pairing-discovery')>(
        '../../packages/server/src/modules/studio/services/network/lan-pairing-discovery',
      )
      return {
        ...actual,
        getLanDiscoveryCache: () => ({
          scanning: false,
          last_scanned_at: new Date().toISOString(),
          devices: [],
        }),
      }
    })
    vi.doMock('../../packages/server/src/modules/studio/public/system-info', async () => {
      const actual = await vi.importActual<typeof import('../../packages/server/src/modules/studio/public/system-info')>(
        '../../packages/server/src/modules/studio/public/system-info',
      )
      return {
        ...actual,
        getPublicSystemInfo: async () => ({
          device_id: 'hwui_local',
          device_public_key: keyPair.publicKey,
          computer_name: 'local',
          os: { type: 'TestOS', platform: 'linux', release: '1', arch: 'x64' },
          hermes_agent_version: 'v1',
          hermes_web_ui_version: '1',
        }),
        createDeviceSignature: async () => 'signature',
      }
    })

    const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
      if (url === 'https://remote.example.com/api/devices/link-info') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            device_id: device.id,
            device_public_key: device.device_public_key,
            computer_name: 'remote-device',
            endpoint_kind: 'web',
            http_port: 443,
            os: { type: 'Linux', platform: 'linux', release: '1', arch: 'x64' },
            hermes_agent_version: 'v1',
            hermes_web_ui_version: '1',
          }),
        }
      }
      if (url === 'https://remote.example.com/api/devices/link-request' && options?.method === 'POST') {
        expect(JSON.parse(String(options.body))).toEqual(expect.objectContaining({
          pairing_code: 'pair-secret',
        }))
        return {
          ok: true,
          status: 200,
          json: async () => ({ status: 'pending' }),
        }
      }
      if (url === 'https://remote.example.com/api/devices/link-status' && options?.method === 'POST') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ status: 'pending' }),
        }
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const { getDeviceRelation } = await import('../../packages/server/src/modules/studio/repositories/devices-store')
    const { requestManualDevicePairing } = await import('../../packages/server/src/modules/studio/controllers/devices')
    const ctx: any = {
      request: {
        body: {
          url: 'https://remote.example.com/#/hermes/devices?pairing_code=pair-secret',
        },
      },
    }

    await requestManualDevicePairing(ctx)

    const relation = getDeviceRelation(device.id)
    expect(ctx.status).toBeUndefined()
    expect(relation?.outbound_status).toBe('pending')
    expect(relation?.url).toBe('https://remote.example.com')
    expect(ctx.body.devices).toEqual([
      expect.objectContaining({
        id: device.id,
        computer_name: 'remote-device',
        online: true,
        outbound_status: 'pending',
        url: 'https://remote.example.com',
      }),
    ])
    expect(fetchMock).toHaveBeenCalledWith(
      'https://remote.example.com/api/devices/link-info',
      expect.objectContaining({ method: 'GET' }),
    )
    expect(fetchMock).toHaveBeenCalledWith(
      'https://remote.example.com/api/devices/link-request',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('keeps a manually paired remote device in the list when it is offline', async () => {
    vi.doMock('../../packages/server/src/modules/studio/services/network/lan-pairing-discovery', async () => {
      const actual = await vi.importActual<typeof import('../../packages/server/src/modules/studio/services/network/lan-pairing-discovery')>(
        '../../packages/server/src/modules/studio/services/network/lan-pairing-discovery',
      )
      return {
        ...actual,
        getLanDiscoveryCache: () => ({
          scanning: false,
          last_scanned_at: new Date().toISOString(),
          devices: [],
        }),
      }
    })
    vi.doMock('../../packages/server/src/modules/studio/public/system-info', async () => {
      const actual = await vi.importActual<typeof import('../../packages/server/src/modules/studio/public/system-info')>(
        '../../packages/server/src/modules/studio/public/system-info',
      )
      return {
        ...actual,
        getPublicSystemInfo: async () => ({
          device_id: 'hwui_local',
          device_public_key: keyPair.publicKey,
          computer_name: 'local',
          os: { type: 'TestOS', platform: 'linux', release: '1', arch: 'x64' },
          hermes_agent_version: 'v1',
          hermes_web_ui_version: '1',
        }),
        createDeviceSignature: async () => 'signature',
      }
    })

    const fetchMock = vi.fn(async () => {
      throw new Error('offline')
    })
    vi.stubGlobal('fetch', fetchMock)

    const { updateOutboundStatus } = await import('../../packages/server/src/modules/studio/repositories/devices-store')
    const { listDevices } = await import('../../packages/server/src/modules/studio/controllers/devices')
    updateOutboundStatus(device.id, 'approved', {
      ...device,
      ip: 'remote.example.com',
      http_port: 443,
      url: 'https://remote.example.com',
    })

    const ctx: any = {}
    await listDevices(ctx)

    expect(ctx.body.devices).toEqual([
      expect.objectContaining({
        id: device.id,
        online: false,
        outbound_status: 'approved',
        url: 'https://remote.example.com',
      }),
    ])
    expect(fetchMock).toHaveBeenCalledWith(
      'https://remote.example.com/api/devices/link-status',
      expect.objectContaining({ method: 'POST' }),
    )
  })
})
