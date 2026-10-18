import { EventEmitter } from 'events'
import { afterEach, describe, expect, it, vi } from 'vitest'

const originalEnv = { ...process.env }

class FakeChild extends EventEmitter {
  pid: number
  killSignals: string[] = []
  constructor(pid: number) {
    super()
    this.pid = pid
  }
  unref() { /* no-op */ }
  kill(signal?: string) {
    this.killSignals.push(signal || 'SIGTERM')
    return true
  }
}

let fakeChildren: FakeChild[] = []
let fakeSpawnOptions: any[] = []
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

vi.mock('../../packages/server/src/modules/hermes/services/runtime/process', () => ({
  resolveHermesInvocation: (bin: string) => ({ command: bin, argsPrefix: [] }),
  execHermesWithBin: vi.fn(),
  execHermes: vi.fn(),
  spawnHermesWithBin: vi.fn((_bin: string, _args: string[], options: any) => {
    fakeSpawnOptions.push(options)
    const pid = 10000 + fakeChildren.length
    const child = new FakeChild(pid)
    fakeChildren.push(child)
    return child
  }),
  spawnHermes: vi.fn(),
  resolveHermesBin: () => 'hermes',
}))

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.resetModules()
  process.env = { ...originalEnv }
  fakeChildren = []
  fakeSpawnOptions = []
  if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform)
})

describe('gateway-runner supervision', () => {
  it('keeps the managed gateway attached and hidden on Windows', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    vi.resetModules()
    const { startGatewayRunManaged } = await import(
      '../../packages/server/src/modules/hermes/services/gateway/runner'
    )

    startGatewayRunManaged('C:\\runtime\\hermes.exe', { profileDir: 'C:\\runtime\\profile' })

    expect(fakeSpawnOptions[0]).toMatchObject({
      detached: false,
      stdio: 'ignore',
      windowsHide: true,
    })
  })

  it('respawns the gateway when the spawned child dies unexpectedly', async () => {
    vi.useFakeTimers()
    vi.resetModules()
    const { startGatewayRunManaged } = await import(
      '../../packages/server/src/modules/hermes/services/gateway/runner'
    )

    const first = startGatewayRunManaged('/usr/bin/hermes', { profileDir: '/tmp/fake-a' })
    expect(first.pid).toBe(10000)
    expect(fakeChildren).toHaveLength(1)

    // Simulate unexpected exit
    fakeChildren[0].emit('exit', 1, null)

    // No respawn yet — timer is pending
    expect(fakeChildren).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(2500)

    // A new spawn should have been issued
    expect(fakeChildren.length).toBeGreaterThanOrEqual(2)
    const newPid = fakeChildren[fakeChildren.length - 1].pid
    expect(newPid).not.toBe(10000)
  })

  it('handles a missing Hermes executable without an uncaught error or respawn loop', async () => {
    vi.useFakeTimers()
    vi.resetModules()
    const { startGatewayRunManaged } = await import(
      '../../packages/server/src/modules/hermes/services/gateway/runner'
    )

    startGatewayRunManaged('hermes', { profileDir: '/tmp/missing-hermes' })

    expect(() => fakeChildren[0].emit('error', Object.assign(new Error('spawn hermes ENOENT'), {
      code: 'ENOENT',
    }))).not.toThrow()
    await vi.advanceTimersByTimeAsync(5000)
    expect(fakeChildren).toHaveLength(1)
  })

  it('stops respawning after three consecutive quick failures', async () => {
    vi.useFakeTimers()
    vi.resetModules()
    const { startGatewayRunManaged } = await import(
      '../../packages/server/src/modules/hermes/services/gateway/runner'
    )

    startGatewayRunManaged('/usr/bin/hermes', { profileDir: '/tmp/flapping' })
    expect(fakeChildren).toHaveLength(1)

    for (let i = 0; i < 3; i += 1) {
      fakeChildren[fakeChildren.length - 1].emit('exit', 1, null)
      await vi.advanceTimersByTimeAsync(2500)
    }

    expect(fakeChildren).toHaveLength(4)

    fakeChildren[fakeChildren.length - 1].emit('exit', 1, null)
    await vi.advanceTimersByTimeAsync(5000)

    expect(fakeChildren).toHaveLength(4)
  })

  it('resets the respawn limit after a stable run', async () => {
    vi.useFakeTimers()
    vi.resetModules()
    const { startGatewayRunManaged } = await import(
      '../../packages/server/src/modules/hermes/services/gateway/runner'
    )

    startGatewayRunManaged('/usr/bin/hermes', { profileDir: '/tmp/recovered' })

    fakeChildren[0].emit('exit', 1, null)
    await vi.advanceTimersByTimeAsync(2500)
    fakeChildren[1].emit('exit', 1, null)
    await vi.advanceTimersByTimeAsync(2500)
    expect(fakeChildren).toHaveLength(3)

    await vi.advanceTimersByTimeAsync(31000)
    fakeChildren[2].emit('exit', 1, null)
    await vi.advanceTimersByTimeAsync(2500)
    expect(fakeChildren).toHaveLength(4)

    fakeChildren[3].emit('exit', 1, null)
    await vi.advanceTimersByTimeAsync(2500)
    fakeChildren[4].emit('exit', 1, null)
    await vi.advanceTimersByTimeAsync(2500)
    expect(fakeChildren).toHaveLength(6)

    fakeChildren[5].emit('exit', 1, null)
    await vi.advanceTimersByTimeAsync(5000)
    expect(fakeChildren).toHaveLength(6)
  })

  it('cancels a pending respawn when a fresh start is issued for the same profile (the /restart case)', async () => {
    vi.useFakeTimers()
    vi.resetModules()
    const { startGatewayRunManaged } = await import(
      '../../packages/server/src/modules/hermes/services/gateway/runner'
    )

    // First start: a gateway is running
    const first = startGatewayRunManaged('/usr/bin/hermes', { profileDir: '/tmp/fake-b' })
    expect(first.pid).toBe(10000)

    // Simulate `/restart`: old gateway dies, then a new start happens before
    // the respawn timer fires.
    fakeChildren[0].emit('exit', 1, null)
    expect(fakeChildren).toHaveLength(1) // respawn not yet fired

    // New start (the `/restart` second phase) for the same profile. The
    // pending respawn timer should be cancelled.
    const second = startGatewayRunManaged('/usr/bin/hermes', { profileDir: '/tmp/fake-b' })
    expect(second.pid).toBe(10001)
    expect(fakeChildren).toHaveLength(2)

    // Now advance timers past the original respawn delay. The cancelled
    // respawn must NOT fire — otherwise we'd have a third gateway racing
    // with the second.
    await vi.advanceTimersByTimeAsync(5000)
    expect(fakeChildren).toHaveLength(2)
  })

  it('tracks respawns independently per profile', async () => {
    vi.useFakeTimers()
    vi.resetModules()
    const { startGatewayRunManaged } = await import(
      '../../packages/server/src/modules/hermes/services/gateway/runner'
    )

    startGatewayRunManaged('/usr/bin/hermes', { profileDir: '/tmp/profile-x' })
    startGatewayRunManaged('/usr/bin/hermes', { profileDir: '/tmp/profile-y' })
    expect(fakeChildren).toHaveLength(2)

    // profile-x's gateway dies — only its respawn timer should fire
    fakeChildren[0].emit('exit', 1, null)

    await vi.advanceTimersByTimeAsync(2500)

    // profile-x was respawned (3rd child), profile-y was untouched
    expect(fakeChildren).toHaveLength(3)
    expect(fakeChildren[2].pid).toBe(10002)
  })

  it('does not respawn if a new start for the same profile has already replaced the dead child', async () => {
    vi.useFakeTimers()
    vi.resetModules()
    const { startGatewayRunManaged } = await import(
      '../../packages/server/src/modules/hermes/services/gateway/runner'
    )

    const first = startGatewayRunManaged('/usr/bin/hermes', { profileDir: '/tmp/fake-c' })
    fakeChildren[0].emit('exit', 0, 'SIGTERM')

    // Issue a fresh start BEFORE the respawn timer fires — this clears the
    // pending respawn. The old child's exit handler then becomes a no-op
    // because `state.current?.pid !== oldPid` after the new start.
    const second = startGatewayRunManaged('/usr/bin/hermes', { profileDir: '/tmp/fake-c' })
    expect(second.pid).not.toBe(first.pid)

    // Now the original (now-orphaned) exit listener fires after the timer
    // window. It should detect the mismatch and not schedule another spawn.
    await vi.advanceTimersByTimeAsync(5000)

    // Exactly two children total: the original, and the replacement
    expect(fakeChildren).toHaveLength(2)
  })

  it('retires one managed profile gateway without scheduling a respawn', async () => {
    vi.useFakeTimers()
    vi.resetModules()
    const { retireManagedGatewayForProfile, startGatewayRunManaged } = await import(
      '../../packages/server/src/modules/hermes/services/gateway/runner'
    )

    startGatewayRunManaged('/usr/bin/hermes', { profileDir: '/tmp/delete-me' })
    expect(fakeChildren).toHaveLength(1)

    const retired = retireManagedGatewayForProfile('/tmp/delete-me', { timeoutMs: 5000, platform: 'linux' })
    expect(fakeChildren[0].killSignals).toEqual(['SIGTERM'])

    fakeChildren[0].emit('exit', 0, 'SIGTERM')
    await expect(retired).resolves.toEqual({ signaled: 1, forced: 0, errors: 0 })
    await vi.advanceTimersByTimeAsync(6000)

    expect(fakeChildren).toHaveLength(1)
  })

  it('stops managed gateways on shutdown without respawning them', async () => {
    vi.useFakeTimers()
    vi.resetModules()
    const { shutdownManagedGateways, startGatewayRunManaged } = await import(
      '../../packages/server/src/modules/hermes/services/gateway/runner'
    )

    startGatewayRunManaged('/usr/bin/hermes', { profileDir: '/tmp/shutdown-a' })
    startGatewayRunManaged('/usr/bin/hermes', { profileDir: '/tmp/shutdown-b' })
    expect(fakeChildren).toHaveLength(2)

    const shutdown = shutdownManagedGateways({ timeoutMs: 5000, platform: 'linux' })

    expect(fakeChildren[0].killSignals).toEqual(['SIGTERM'])
    expect(fakeChildren[1].killSignals).toEqual(['SIGTERM'])

    fakeChildren[0].emit('exit', 0, 'SIGTERM')
    fakeChildren[1].emit('exit', 0, 'SIGTERM')

    await expect(shutdown).resolves.toEqual({ signaled: 2, forced: 0, errors: 0 })
    await vi.advanceTimersByTimeAsync(6000)

    expect(fakeChildren).toHaveLength(2)
  })

  it('refuses a late managed gateway start after shutdown begins', async () => {
    vi.resetModules()
    const { shutdownManagedGateways, startGatewayRunManaged } = await import(
      '../../packages/server/src/modules/hermes/services/gateway/runner'
    )

    await expect(shutdownManagedGateways()).resolves.toEqual({ signaled: 0, forced: 0, errors: 0 })

    expect(startGatewayRunManaged('/usr/bin/hermes', { profileDir: '/tmp/late-start' })).toEqual({
      pid: null,
      reused: false,
    })
    expect(fakeChildren).toHaveLength(0)
  })

  it('kills the owned descendant snapshot when the gateway root exits first', async () => {
    vi.useFakeTimers()
    vi.resetModules()
    const listPosixDescendantPids = vi.fn(() => [20002, 20001])
    const killPosixPid = vi.fn()
    const { shutdownManagedGateways, startGatewayRunManaged } = await import(
      '../../packages/server/src/modules/hermes/services/gateway/runner'
    )

    startGatewayRunManaged('/usr/bin/hermes', { profileDir: '/tmp/descendants' })
    const shutdown = shutdownManagedGateways({
      timeoutMs: 5000,
      platform: 'linux',
      listPosixDescendantPids,
      killPosixPid,
    })

    fakeChildren[0].emit('exit', 0, 'SIGTERM')

    await expect(shutdown).resolves.toEqual({ signaled: 1, forced: 1, errors: 0 })
    expect(listPosixDescendantPids).toHaveBeenCalledWith(10000)
    expect(killPosixPid.mock.calls).toEqual([
      [20002, 'SIGKILL'],
      [20001, 'SIGKILL'],
    ])
  })

  it('force-stops only gateway trees recorded in this process', async () => {
    vi.resetModules()
    const listPosixDescendantPids = vi.fn(() => [21001, 21002])
    const killPosixPid = vi.fn()
    const { forceStopManagedGateways, startGatewayRunManaged } = await import(
      '../../packages/server/src/modules/hermes/services/gateway/runner'
    )

    startGatewayRunManaged('/usr/bin/hermes', { profileDir: '/tmp/force-owned' })

    expect(forceStopManagedGateways({
      platform: 'linux',
      listPosixDescendantPids,
      killPosixPid,
    })).toBe(1)
    expect(killPosixPid.mock.calls).toEqual([
      [21001, 'SIGKILL'],
      [21002, 'SIGKILL'],
      [-10000, 'SIGKILL'],
    ])

    killPosixPid.mockClear()
    expect(forceStopManagedGateways({
      platform: 'linux',
      listPosixDescendantPids,
      killPosixPid,
    })).toBe(0)
    expect(killPosixPid).not.toHaveBeenCalled()
  })

  it('cancels pending respawn timers during managed gateway shutdown', async () => {
    vi.useFakeTimers()
    vi.resetModules()
    const { shutdownManagedGateways, startGatewayRunManaged } = await import(
      '../../packages/server/src/modules/hermes/services/gateway/runner'
    )

    startGatewayRunManaged('/usr/bin/hermes', { profileDir: '/tmp/shutdown-c' })
    fakeChildren[0].emit('exit', 1, null)

    const result = await shutdownManagedGateways({ timeoutMs: 5000 })
    expect(result).toEqual({ signaled: 0, forced: 0, errors: 0 })

    await vi.advanceTimersByTimeAsync(6000)
    expect(fakeChildren).toHaveLength(1)
  })

  it('forces managed gateway shutdown when children do not exit', async () => {
    vi.useFakeTimers()
    vi.resetModules()
    const { shutdownManagedGateways, startGatewayRunManaged } = await import(
      '../../packages/server/src/modules/hermes/services/gateway/runner'
    )

    startGatewayRunManaged('/usr/bin/hermes', { profileDir: '/tmp/shutdown-d' })

    const shutdown = shutdownManagedGateways({ timeoutMs: 1000, platform: 'linux' })
    expect(fakeChildren[0].killSignals).toEqual(['SIGTERM'])

    await vi.advanceTimersByTimeAsync(1000)

    await expect(shutdown).resolves.toEqual({ signaled: 1, forced: 1, errors: 0 })
    expect(fakeChildren[0].killSignals).toEqual(['SIGTERM', 'SIGKILL'])
  })

  it('kills the managed gateway process tree on Windows shutdown', async () => {
    vi.resetModules()
    const killWindowsProcessTree = vi.fn().mockResolvedValue(undefined)
    const { shutdownManagedGateways, startGatewayRunManaged } = await import(
      '../../packages/server/src/modules/hermes/services/gateway/runner'
    )

    startGatewayRunManaged('/usr/bin/hermes', { profileDir: '/tmp/shutdown-win' })

    await expect(shutdownManagedGateways({
      platform: 'win32',
      killWindowsProcessTree,
    })).resolves.toEqual({ signaled: 1, forced: 1, errors: 0 })

    expect(killWindowsProcessTree).toHaveBeenCalledWith(10000)
    expect(fakeChildren[0].killSignals).toEqual([])
  })
})
