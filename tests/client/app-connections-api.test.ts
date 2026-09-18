import { beforeEach, describe, expect, it, vi } from 'vitest'

const request = vi.hoisted(() => vi.fn())

vi.mock('@/api/client', () => ({ request }))

describe('App connections API', () => {
  beforeEach(() => {
    request.mockReset()
    request.mockResolvedValue({})
  })

  it('uses the connection-specific authorization endpoints', async () => {
    const api = await import('@/api/studio/app-connections')

    await api.fetchAppConnections()
    await api.createLanAppAuthorization()
    await api.createCloudAppAuthorization(true, 'cloudflare')
    await api.deleteAppConnection(12)
    await api.updateAppConnectionPush(12, false)

    expect(request.mock.calls).toEqual([
      ['/api/app-connections'],
      ['/api/app-connections/authorization-codes/lan', { method: 'POST' }],
      ['/api/app-connections/authorization-codes/cloud', { method: 'POST', body: JSON.stringify({ refresh: true, route: 'cloudflare' }) }],
      ['/api/app-connections/12', { method: 'DELETE' }],
      ['/api/studio/app-connections/12/push', { method: 'PATCH', body: JSON.stringify({ push_enabled: false }) }],
    ])
  })
})
