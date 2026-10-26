import { createServer } from 'node:http'
import { Server } from 'socket.io'
import { io, type Socket } from 'socket.io-client'
import { afterEach, describe, expect, it, vi } from 'vitest'
const auth = vi.hoisted(() => ({ allowed: true }))
vi.mock('../../packages/server/src/modules/studio/public/auth', () => ({ authenticateUserToken: async (token: string) => auth.allowed && token === 'account' ? { id: 42, role: 'admin' } : null }))
vi.mock('../../packages/server/src/modules/studio/public/users', () => ({ userCanAccessProfile: (_id: number, profile: string) => profile === 'research' }))
import { registerDesktopBrowserRelay } from '../../packages/server/src/modules/studio/sockets/desktop-browser'
import { desktopBrowserRelays } from '../../packages/server/src/modules/studio/services/browser/desktop-relay'

let server: Server | null = null
const clients: Socket[] = []
afterEach(async () => { for (const client of clients.splice(0)) client.disconnect(); await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve()); server = null; auth.allowed = true })
async function setup(token = 'account', profile = 'research') {
  const http = createServer()
  server = new Server(http)
  registerDesktopBrowserRelay(server)
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))
  const port = (http.address() as { port: number }).port
  const client = io(`http://127.0.0.1:${port}/desktop-browser`, { auth: { token, profile }, transports: ['websocket'], reconnection: false })
  clients.push(client)
  return client
}
describe('authenticated Desktop reverse connection', () => {
  it('routes browser request and ack over the authenticated reverse socket', async () => {
    const client = await setup()
    await new Promise<void>((resolve, reject) => { client.on('connect', resolve); client.on('connect_error', reject) })
    client.on('browser.request', (body, ack) => ack({ envelope: { operation_id: body.operation_id, result: { tabs: [{ id: 'desktop-tab' }] } } }))
    const result = await desktopBrowserRelays.request(42, 'research', { method: 'tabs.list' }) as any
    expect(result.result.tabs[0].id).toBe('desktop-tab')
    await expect(desktopBrowserRelays.request(43, 'research', { method: 'tabs.list' })).rejects.toThrow('No authorized')
    auth.allowed = false
    await expect(desktopBrowserRelays.request(42, 'research', { method: 'tabs.list' })).rejects.toThrow('expired')
  })
  it.each([['bad', 'research'], ['account', 'private']])('rejects token/profile %s %s', async (token, profile) => {
    const client = await setup(token, profile)
    const error = await new Promise<Error>(resolve => client.on('connect_error', resolve))
    expect(error.message).toContain('denied')
    await expect(desktopBrowserRelays.request(42, profile, { method: 'tabs.list' })).rejects.toThrow('No authorized')
  })
})
