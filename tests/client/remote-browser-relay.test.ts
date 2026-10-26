// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const fixture = vi.hoisted(() => ({ grantListener: null as ((enabled: boolean) => void) | null, token: 'account', mode: true, allow: true, connected: true, callbacks: new Map<string, (...args: any[]) => void>(), revoke: vi.fn(), request: vi.fn(async () => ({ result: { tabs: [] } })), emitted: [] as string[], invalidated: null as (() => void) | null }))
vi.mock('socket.io-client', () => ({ io: vi.fn(() => ({ get connected() { return fixture.connected }, on: (event: string, cb: (...args: any[]) => void) => fixture.callbacks.set(event, cb), removeAllListeners: vi.fn(), disconnect: vi.fn(), emit: (name: string) => fixture.emitted.push(name) })) }))
vi.mock('@/api/client', () => ({ getApiKey: () => fixture.token, getBaseUrlValue: () => 'https://nas.example', getActiveProfileName: () => 'default' }))
vi.mock('@/api/auth-invalidation', () => ({ onAuthInvalidated: (cb: () => void) => { fixture.invalidated = cb; return () => { fixture.invalidated = null } } }))
vi.mock('@/utils/desktop-bridge', () => ({ desktopBridge: () => ({ remoteMode: fixture.mode, browser: { onRemoteControlState: (cb: (enabled: boolean) => void) => { fixture.grantListener = cb; return () => { fixture.grantListener = null } }, remoteRequest: fixture.request, setRemoteControl: async (enabled: boolean) => { if (!enabled) fixture.revoke(); return enabled && fixture.allow } } }) }))

describe('remote browser consent lifecycle', () => {
  afterEach(async () => { const relay = await import('../../packages/client/src/composables/useRemoteBrowserRelay'); await relay.stopRemoteBrowserRelay() })
  beforeEach(() => { fixture.emitted.splice(0); vi.resetModules(); fixture.callbacks.clear(); fixture.request.mockClear(); fixture.revoke.mockClear(); fixture.token = 'account'; fixture.mode = true; fixture.allow = true; fixture.connected = true })
  it('requires Desktop consent and an authenticated remote session', async () => {
    const relay = await import('../../packages/client/src/composables/useRemoteBrowserRelay')
    fixture.allow = false
    await relay.startRemoteBrowserRelay()
    expect(relay.remoteBrowserEnabled.value).toBe(false)
    fixture.token = ''
    await expect(relay.startRemoteBrowserRelay()).rejects.toThrow('login')
  })
  it('forwards only while enabled and revokes on auth loss', async () => {
    const relay = await import('../../packages/client/src/composables/useRemoteBrowserRelay')
    await relay.startRemoteBrowserRelay()
    expect(relay.remoteBrowserEnabled.value).toBe(true)
    const handler = fixture.callbacks.get('browser.request')!
    const ack = vi.fn()
    await handler({ method: 'tabs.list' }, ack)
    expect(ack).toHaveBeenCalledWith({ envelope: { result: { tabs: [] } } })
    fixture.invalidated!()
    expect(relay.remoteBrowserEnabled.value).toBe(false)
    await handler({ method: 'snapshot' }, ack)
    expect(fixture.request).toHaveBeenCalledTimes(1)
  })
  it('revokes the grant on disconnect before reconnecting', async () => {
    const relay = await import('../../packages/client/src/composables/useRemoteBrowserRelay')
    await relay.startRemoteBrowserRelay()
    fixture.callbacks.get('disconnect')!()
    expect(relay.remoteBrowserEnabled.value).toBe(false)
    expect(fixture.revoke).toHaveBeenCalled()
  })
  it('does not treat synthetic input or Agent calls as user activity and displays owner state', async () => {
    const relay = await import('../../packages/client/src/composables/useRemoteBrowserRelay')
    await relay.startRemoteBrowserRelay()
    window.dispatchEvent(new Event('pointerdown'))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }))
    expect(fixture.emitted).toEqual([])
    fixture.callbacks.get('browser.owner-state')!('standby')
    expect(relay.remoteBrowserOwnerState.value).toBe('standby')
    fixture.callbacks.get('browser.owner-state')!('active')
    expect(relay.remoteBrowserOwnerState.value).toBe('active')
  })

  it('does not report sharing enabled until the server accepts the connection', async () => {
    fixture.connected = false
    const relay = await import('../../packages/client/src/composables/useRemoteBrowserRelay')
    const pending = relay.startRemoteBrowserRelay()
    await vi.waitFor(() => expect(fixture.callbacks.has('connect')).toBe(true))
    expect(relay.remoteBrowserEnabled.value).toBe(false)
    fixture.connected = true
    fixture.callbacks.get('connect')!()
    await pending
    expect(relay.remoteBrowserEnabled.value).toBe(true)
    await relay.stopRemoteBrowserRelay()
  })
  it('returns connection errors to the caller and revokes the grant', async () => {
    fixture.connected = false
    const relay = await import('../../packages/client/src/composables/useRemoteBrowserRelay')
    const pending = relay.startRemoteBrowserRelay()
    const rejected = expect(pending).rejects.toThrow('authentication/profile access denied')
    await vi.waitFor(() => expect(fixture.callbacks.has('connect_error')).toBe(true))
    fixture.callbacks.get('connect_error')!(new Error('authentication/profile access denied'))
    await rejected
    expect(relay.remoteBrowserEnabled.value).toBe(false)
    expect(fixture.revoke).toHaveBeenCalledTimes(2)
  })
  it('settles a pending connection when sharing is stopped', async () => {
    fixture.connected = false
    const relay = await import('../../packages/client/src/composables/useRemoteBrowserRelay')
    const pending = relay.startRemoteBrowserRelay()
    const rejected = expect(pending).rejects.toThrow('cancelled')
    await vi.waitFor(() => expect(fixture.callbacks.has('connect')).toBe(true))
    await relay.stopRemoteBrowserRelay()
    await rejected
    expect(relay.remoteBrowserEnabled.value).toBe(false)
  })
  it('revokes and reports a connection timeout', async () => {
    vi.useFakeTimers()
    try {
      fixture.connected = false
      const relay = await import('../../packages/client/src/composables/useRemoteBrowserRelay')
      const pending = relay.startRemoteBrowserRelay()
      const rejected = expect(pending).rejects.toThrow('timed out')
      await vi.advanceTimersByTimeAsync(299_999)
      expect(relay.remoteBrowserEnabled.value).toBe(false)
      expect(fixture.revoke).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(2)
      await rejected
      expect(relay.remoteBrowserEnabled.value).toBe(false)
      expect(fixture.revoke).toHaveBeenCalledTimes(2)
    } finally { vi.useRealTimers() }
  })
})


describe('native grant invalidation', () => {
  beforeEach(() => { fixture.connected = true; fixture.token = 'account'; fixture.mode = true; fixture.allow = true; fixture.callbacks.clear() })
  it('stops advertising remote control immediately after Desktop revocation', async () => {
    const relay = await import('../../packages/client/src/composables/useRemoteBrowserRelay')
    await relay.startRemoteBrowserRelay()
    expect(relay.remoteBrowserEnabled.value).toBe(true)
    fixture.grantListener?.(false)
    expect(relay.remoteBrowserEnabled.value).toBe(false)
    expect(fixture.grantListener).toBeNull()
    await relay.stopRemoteBrowserRelay()
  })
  it('stops stale sharing on permission failure from an older Desktop', async () => {
    const relay = await import('../../packages/client/src/composables/useRemoteBrowserRelay')
    await relay.startRemoteBrowserRelay()
    fixture.request.mockRejectedValueOnce(new Error('Desktop browser remote control has not been authorized'))
    const ack = vi.fn()
    await fixture.callbacks.get('browser.request')!({}, ack)
    expect(ack).toHaveBeenCalledWith({ error: 'Desktop browser remote control has not been authorized' })
    expect(relay.remoteBrowserEnabled.value).toBe(false)
    await relay.stopRemoteBrowserRelay()
  })
})

describe('automatic remote control', () => {
  beforeEach(() => { vi.resetModules(); fixture.callbacks.clear(); fixture.connected = true; fixture.token = 'account'; fixture.mode = true; fixture.allow = true })
  afterEach(async () => { const relay = await import('../../packages/client/src/composables/useRemoteBrowserRelay'); await relay.stopRemoteBrowserRelay() })

  it('connects without any user action in remote mode', async () => {
    const relay = await import('../../packages/client/src/composables/useRemoteBrowserRelay')
    await relay.ensureRemoteBrowserRelay()
    expect(relay.remoteBrowserEnabled.value).toBe(true)
    await relay.ensureRemoteBrowserRelay()
    expect(relay.remoteBrowserEnabled.value).toBe(true)
  })

  it('stays off outside remote mode, when logged out or when Desktop declines', async () => {
    const relay = await import('../../packages/client/src/composables/useRemoteBrowserRelay')
    fixture.mode = false
    await relay.ensureRemoteBrowserRelay()
    expect(fixture.callbacks.size).toBe(0)
    fixture.mode = true
    fixture.token = ''
    await relay.ensureRemoteBrowserRelay()
    expect(fixture.callbacks.size).toBe(0)
    fixture.token = 'account'
    fixture.allow = false
    await relay.ensureRemoteBrowserRelay()
    expect(relay.remoteBrowserEnabled.value).toBe(false)
  })

  it('reconnects after a dropped connection, but not after logout', async () => {
    vi.useFakeTimers()
    try {
      const relay = await import('../../packages/client/src/composables/useRemoteBrowserRelay')
      await relay.ensureRemoteBrowserRelay()
      fixture.callbacks.get('disconnect')!()
      expect(relay.remoteBrowserEnabled.value).toBe(false)
      fixture.callbacks.clear()
      await vi.advanceTimersByTimeAsync(5000)
      expect(relay.remoteBrowserEnabled.value).toBe(true)
      fixture.callbacks.get('disconnect')!()
      await relay.stopRemoteBrowserRelay()
      fixture.callbacks.clear()
      await vi.advanceTimersByTimeAsync(10_000)
      expect(fixture.callbacks.size).toBe(0)
      await relay.ensureRemoteBrowserRelay()
      fixture.callbacks.get('disconnect')!()
      fixture.token = ''
      fixture.callbacks.clear()
      await vi.advanceTimersByTimeAsync(10_000)
      expect(relay.remoteBrowserEnabled.value).toBe(false)
      expect(fixture.callbacks.size).toBe(0)
    } finally { vi.useRealTimers() }
  })
})
