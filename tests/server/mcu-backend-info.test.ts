import Koa from 'koa'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Server } from 'node:http'

const info = {
  device_id: 'studio-backend', device_public_key: 'public-key', computer_name: 'Studio',
  os: { type: 'Linux', platform: 'linux', release: '1', arch: 'x64' },
  hermes_agent_version: '1', hermes_web_ui_version: '2',
}
vi.mock('../../packages/server/src/modules/studio/public/config', () => ({
  config: { port: 8748, remoteRelay: { url: 'https://relay.example.com' } },
}))
vi.mock('../../packages/server/src/modules/studio/public/system-info', () => ({ getPublicSystemInfo: async () => info }))
vi.mock('../../packages/server/src/modules/studio/public/global-agent', () => ({}))
vi.mock('../../packages/server/src/modules/studio/services/devices/mcu-devices', () => ({}))

describe('Small Box backend discovery compatibility', () => {
  let server: Server | undefined
  afterEach(async () => { if (server) await new Promise<void>(resolve => server!.close(() => resolve())) })

  it('keeps shipped firmware manual connections working without the old LAN pairing routes', async () => {
    const { mcuDevicePublicRoutes } = await import('../../packages/server/src/modules/studio/routes/mcu-devices')
    const app = new Koa()
    app.use(mcuDevicePublicRoutes.routes())
    server = app.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server!.once('listening', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('expected test server address')
    const response = await fetch(`http://127.0.0.1:${address.port}/api/devices/link-info`)
    expect(response.status).toBe(200)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*')
    expect(await response.json()).toEqual({
      ...info, http_port: 8748, endpoint_kind: 'desktop', relay_url: 'https://relay.example.com',
      app_relay: { protocol: 'socket.io', namespace: '/app-relay', direct: true },
    })
    expect(mcuDevicePublicRoutes.stack.map(route => route.path)).toEqual(['/api/devices/link-info'])
  })
})
