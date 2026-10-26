import { describe, expect, it, vi } from 'vitest'
import { DesktopBrowserRelayRegistry } from '../../packages/server/src/modules/studio/services/browser/desktop-relay'

describe('remote Desktop browser isolation', () => {
  it('fails closed without a matching user and profile', async () => {
    const registry = new DesktopBrowserRelayRegistry()
    registry.register({ id: 'desktop', userId: 1, profile: 'default', request: vi.fn(), revoke: vi.fn() })
    await expect(registry.request(2, 'default', { method: 'tabs.list' })).rejects.toThrow('No authorized')
    await expect(registry.request(1, 'private', { method: 'tabs.list' })).rejects.toThrow('No authorized')
  })
  it('keeps the existing active owner while another desktop registers', async () => {
    const registry = new DesktopBrowserRelayRegistry()
    const request = vi.fn(async () => ({ result: { tabs: [] } }))
    registry.register({ id: 'one', userId: 1, profile: 'default', request, revoke: vi.fn() })
    await expect(registry.request(1, 'default', { method: 'tabs.list' })).resolves.toEqual({ result: { tabs: [] } })
    registry.register({ id: 'two', userId: 1, profile: 'default', request, revoke: vi.fn() })
    await expect(registry.request(1, 'default', { method: 'tabs.list' })).resolves.toEqual({ result: { tabs: [] } })
    expect(request).toHaveBeenCalledTimes(2)
  })
  it('revokes connection and discards late responses', async () => {
    const registry = new DesktopBrowserRelayRegistry()
    let finish!: (value: unknown) => void
    const revoke = vi.fn()
    const release = registry.register({ id: 'one', userId: 1, profile: 'default', request: () => new Promise(resolve => { finish = resolve }), revoke })
    const pending = registry.request(1, 'default', { method: 'snapshot', params: { tab_id: 'one' } })
    release(); finish({ result: 'private' })
    await expect(pending).rejects.toThrow('disconnected')
    expect(revoke).toHaveBeenCalledOnce()
    await expect(registry.request(1, 'default', { method: 'tabs.list' })).rejects.toThrow('No authorized')
  })
  it('rejects unsupported or oversized operations before forwarding', async () => {
    const registry = new DesktopBrowserRelayRegistry()
    await expect(registry.request(1, 'default', { method: 'eval' })).rejects.toThrow('Unsupported')
    await expect(registry.request(1, 'default', { method: 'navigate', params: { url: 'a'.repeat(1_000_001) } })).rejects.toThrow('1 MB')
    await expect(registry.request(1, 'default', { method: 'upload', params: { files: [{ data: 'A'.repeat(16_000_001) }] } })).rejects.toThrow('16 MB')
    await expect(registry.request(1, 'default', { method: 'upload', params: { files: [{ data: 'A'.repeat(2_000_000) }] } })).rejects.toThrow('No authorized active Desktop browser')
  })
})

describe('idle Desktop ownership', () => {
  it('transfers only after 10 minutes and a new user activity, without retargeting old runs', async () => {
    let now = 0
    const registry = new DesktopBrowserRelayRegistry(() => now)
    const a = vi.fn(async () => 'A'), b = vi.fn(async () => 'B')
    registry.register({ id: 'a', userId: 1, profile: 'default', request: a, revoke: vi.fn() })
    registry.register({ id: 'b', userId: 1, profile: 'default', request: b, revoke: vi.fn() })
    await expect(registry.request(1, 'default', { method: 'tabs.list' }, 'old-run')).resolves.toBe('A')
    now = 599999; registry.activity('b')
    await expect(registry.request(1, 'default', { method: 'tabs.list' })).resolves.toBe('A')
    now = 600000; registry.activity('b')
    await expect(registry.request(1, 'default', { method: 'tabs.list' }, 'new-run')).resolves.toBe('B')
    await expect(registry.request(1, 'default', { method: 'tabs.list' }, 'old-run')).rejects.toThrow('original Desktop')
    now = 1200001; registry.activity('a')
    await expect(registry.request(1, 'default', { method: 'tabs.list' }, 'old-run')).rejects.toThrow('original Desktop')
    now = 1800002; registry.activity('b')
    // Delayed A user activity cannot steal back from recently active B.
    registry.activity('a')
    await expect(registry.request(1, 'default', { method: 'tabs.list' })).resolves.toBe('B')
  })
  it('does not let Agent calls refresh human activity', async () => {
    let now = 0
    const registry = new DesktopBrowserRelayRegistry(() => now)
    registry.register({ id: 'a', userId: 1, profile: 'default', request: async () => 'A', revoke: vi.fn() })
    registry.register({ id: 'b', userId: 1, profile: 'default', request: async () => 'B', revoke: vi.fn() })
    now = 599999; await registry.request(1, 'default', { method: 'tabs.list' })
    now = 600001; registry.activity('b')
    await expect(registry.request(1, 'default', { method: 'tabs.list' })).resolves.toBe('B')
  })
  it('never transfers in flight and requires fresh activity after operation completion', async () => {
    let now = 0, finish!: (v: unknown) => void
    const registry = new DesktopBrowserRelayRegistry(() => now)
    registry.register({ id: 'a', userId: 1, profile: 'default', request: () => new Promise(resolve => { finish = resolve }), revoke: vi.fn() })
    const states = vi.fn()
    registry.register({ id: 'b', userId: 1, profile: 'default', request: async () => 'B', revoke: vi.fn(), ownerState: states })
    const pending = registry.request(1, 'default', { method: 'snapshot' }, 'run')
    now = 700000; registry.activity('b')
    expect(states).toHaveBeenLastCalledWith('busy')
    finish('A'); await expect(pending).resolves.toBe('A')
    expect(states).toHaveBeenLastCalledWith('standby')
    registry.activity('b')
    await expect(registry.request(1, 'default', { method: 'tabs.list' })).resolves.toBe('B')
  })
  it('preserves disconnected-run tombstones instead of routing to a replacement', async () => {
    const registry = new DesktopBrowserRelayRegistry()
    const release = registry.register({ id: 'a', userId: 1, profile: 'default', request: async () => 'A', revoke: vi.fn() })
    await registry.request(1, 'default', { method: 'tabs.list' }, 'run')
    release()
    registry.register({ id: 'b', userId: 1, profile: 'default', request: async () => 'B', revoke: vi.fn() })
    await expect(registry.request(1, 'default', { method: 'tabs.list' }, 'run')).rejects.toThrow('original Desktop')
  })
})
