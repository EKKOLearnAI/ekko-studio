import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'

describe('Device connections permissions', () => {
  it('keeps App, Small Box and desktop remote connections available after retiring LAN pairing', () => {
    const router = readFileSync('packages/client/src/router/index.ts', 'utf8')
    const panel = readFileSync('packages/client/src/components/hermes/connections/ConnectionsPanel.vue', 'utf8')
    const appRoutes = readFileSync('packages/server/src/modules/studio/routes/app-connections.ts', 'utf8')
    const mcuRoutes = readFileSync('packages/server/src/modules/studio/routes/mcu-devices.ts', 'utf8')
    const connectionsRoute = router.slice(
      router.indexOf("path: '/hermes/connections'"),
      router.indexOf("path: '/studio/agents'"),
    )
    expect(connectionsRoute).not.toContain('requiresSuperAdmin')
    expect(router).not.toContain("path: '/hermes/devices'")
    expect(panel).not.toContain('DevicesView')
    expect(panel).not.toContain('name="devices"')
    expect(panel).toContain('<AppConnectionsPanel />')
    expect(panel).toContain('<McuDevicesPanel />')
    expect(panel).toContain('<RemoteDevicesPanel />')
    expect(appRoutes).not.toContain('requireSuperAdmin')
    expect(mcuRoutes).not.toContain('requireSuperAdmin')
  })
})
