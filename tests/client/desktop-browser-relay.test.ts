import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const ports = vi.hoisted(() => ({ token: 'account-token', profile: 'default', bridge: undefined as any, sockets: [] as any[], authInvalidated: undefined as (() => void) | undefined }))
vi.mock('@/api/client', () => ({ getApiKey: () => ports.token, getActiveProfileName: () => ports.profile, getBaseUrlValue: () => '' }))
vi.mock('@/utils/desktop-bridge', () => ({ desktopBridge: () => ports.bridge }))
vi.mock('@/utils/deployment-url', () => ({ socketEndpoint: () => ({ url: 'http://localhost/desktop-browser', path: '/socket.io' }) }))
vi.mock('@/api/auth-invalidation', () => ({ onAuthInvalidated: (callback: () => void) => { ports.authInvalidated = callback; return vi.fn() } }))
vi.mock('socket.io-client', () => ({ io: vi.fn((_url, options) => {
  const handlers = new Map<string, Function>()
  const socket = { connected: true, options, handlers, on: vi.fn((event, fn) => { handlers.set(event, fn); return socket }), emit: vi.fn(), removeAllListeners: vi.fn(() => handlers.clear()), disconnect: vi.fn() }
  ports.sockets.push(socket); return socket
}) }))
import { ensureRemoteBrowserRelay, startRemoteBrowserRelay, stopRemoteBrowserRelay, remoteBrowserEnabled } from '../../packages/client/src/composables/useRemoteBrowserRelay'

beforeEach(() => {
  ports.token = 'account-token'; ports.profile = 'default'; ports.sockets.length = 0
  ports.bridge = { remoteMode: false, browser: { setRemoteControl: vi.fn(async () => true), remoteRequest: vi.fn(async body => ({ result: body.method })), onRemoteControlState: vi.fn(() => vi.fn()) } }
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() })
  vi.stubGlobal('document', { visibilityState: 'visible' })
})
afterEach(async () => { await stopRemoteBrowserRelay(); vi.unstubAllGlobals() })

it('registers a local Desktop and forwards plugin CDP requests under its account/Profile', async () => {
  await ensureRemoteBrowserRelay()
  expect(remoteBrowserEnabled.value).toBe(true)
  expect(ports.sockets[0].options.auth).toEqual({ token: 'account-token', profile: 'default' })
  const acknowledge = vi.fn(), input = { method: 'cdp.send', params: { tab_id: 'tab', method: 'Runtime.evaluate', params: { expression: 'document.title' } } }
  await ports.sockets[0].handlers.get('browser.request')(input, acknowledge)
  expect(ports.bridge.browser.remoteRequest).toHaveBeenCalledWith(input)
  expect(acknowledge).toHaveBeenCalledWith({ envelope: { result: 'cdp.send' } })
})
it('continues to register remote Desktop connections', async () => {
  ports.bridge.remoteMode = true
  await ensureRemoteBrowserRelay()
  expect(remoteBrowserEnabled.value).toBe(true)
  expect(ports.bridge.browser.setRemoteControl).toHaveBeenCalledWith(true)
})
it('does not advertise a browser without a logged-in account or when the grant is refused', async () => {
  ports.token = ''
  await ensureRemoteBrowserRelay()
  expect(ports.sockets).toHaveLength(0)
  ports.token = 'account-token'; ports.bridge.browser.setRemoteControl.mockResolvedValue(false)
  await ensureRemoteBrowserRelay()
  expect(ports.sockets).toHaveLength(0)
  expect(remoteBrowserEnabled.value).toBe(false)
})
it('rejects a stale socket callback after changing Profile and binds the new connection', async () => {
  await startRemoteBrowserRelay()
  const original = ports.sockets[0], callback = original.handlers.get('browser.request')
  await stopRemoteBrowserRelay(); ports.profile = 'work'; await startRemoteBrowserRelay()
  const acknowledge = vi.fn()
  await callback({ method: 'tabs.list' }, acknowledge)
  expect(acknowledge).toHaveBeenCalledWith({ error: 'Desktop browser relay revoked' })
  expect(ports.bridge.browser.remoteRequest).not.toHaveBeenCalled()
  expect(ports.sockets[1].options.auth.profile).toBe('work')
})
it('revokes the local grant when authentication is invalidated', async () => {
  await ensureRemoteBrowserRelay()
  ports.authInvalidated?.()
  await vi.waitFor(() => expect(remoteBrowserEnabled.value).toBe(false))
  expect(ports.sockets[0].disconnect).toHaveBeenCalled()
  expect(ports.bridge.browser.setRemoteControl).toHaveBeenLastCalledWith(false)
})
