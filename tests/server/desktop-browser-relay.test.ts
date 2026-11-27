import { describe, expect, it, vi } from 'vitest'
import { DesktopBrowserRelayRegistry } from '../../packages/server/src/modules/studio/services/browser/desktop-relay'

function peer(id: string, request = vi.fn(async () => ({ id }))) {
  const ownerStates: string[] = []
  return {
    id,
    userId: 1,
    profile: 'default',
    request,
    revoke: vi.fn(),
    ownerState: vi.fn((state: string) => ownerStates.push(state)),
    ownerStates,
  }
}

describe('DesktopBrowserRelayRegistry', () => {
  it('promotes the most recently active connected Desktop when the owner disconnects', async () => {
    let now = 100
    const registry = new DesktopBrowserRelayRegistry(() => now)
    const first = peer('first')
    const second = peer('second')
    const releaseFirst = registry.register(first)
    now = 200
    const releaseSecond = registry.register(second)

    await registry.request(1, 'default', { method: 'state' })
    expect(first.request).toHaveBeenCalledOnce()
    expect(second.request).not.toHaveBeenCalled()
    expect(first.ownerStates.at(-1)).toBe('active')
    expect(second.ownerStates.at(-1)).toBe('standby')

    releaseFirst()
    await registry.request(1, 'default', { method: 'state' })
    expect(second.request).toHaveBeenCalledOnce()
    expect(second.ownerStates.at(-1)).toBe('active')
    expect(first.revoke).toHaveBeenCalledOnce()
  })

  it('keeps a bound browser run invalid after automatic takeover', async () => {
    const registry = new DesktopBrowserRelayRegistry(() => 100)
    const first = peer('first')
    const second = peer('second')
    const releaseFirst = registry.register(first)
    registry.register(second)
    const bindingId = 'run-1'

    await registry.request(1, 'default', { method: 'state' }, bindingId)
    releaseFirst()

    await expect(registry.request(1, 'default', { method: 'state' }, bindingId))
      .rejects.toThrow('lost its original Desktop target')
  })
})
