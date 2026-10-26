import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

async function loadLimiter() {
  vi.resetModules()
  vi.doMock('fs/promises', () => ({
    readFile: vi.fn().mockRejectedValue(new Error('ENOENT')),
    writeFile: vi.fn(),
    mkdir: vi.fn(),
  }))
  vi.doMock('fs', () => ({ writeFileSync: vi.fn() }))
  vi.doMock('../../packages/server/src/modules/studio/public/config', () => ({
    config: { appHome: '/tmp/hermes-web-ui-test' },
  }))
  return import('../../packages/server/src/modules/studio/services/auth/login-limiter')
}

describe('login limiter', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-24T00:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.doUnmock('fs/promises')
    vi.doUnmock('fs')
    vi.doUnmock('../../packages/server/src/modules/studio/public/config')
    vi.resetModules()
  })

  it('locks password login on the tenth failed attempt from the same IP', async () => {
    const limiter = await loadLimiter()
    const ip = '192.0.2.10'

    for (let i = 0; i < 9; i++) {
      expect(limiter.checkPassword(ip)).toEqual({ allowed: true })
      limiter.recordPasswordFailure(ip)
    }

    expect(limiter.checkPassword(ip)).toEqual({ allowed: true })
    limiter.recordPasswordFailure(ip)

    expect(limiter.checkPassword(ip)).toEqual({ allowed: false, status: 429 })
    expect(limiter.getLockedIps()).toEqual([
      expect.objectContaining({ ip, type: 'password', failures: 10 }),
    ])
  })

  it('locks token auth on the tenth failed attempt from the same IP', async () => {
    const limiter = await loadLimiter()
    const ip = '192.0.2.20'

    for (let i = 0; i < 9; i++) {
      expect(limiter.checkToken(ip)).toEqual({ allowed: true })
      limiter.recordTokenFailure(ip)
    }

    expect(limiter.checkToken(ip)).toEqual({ allowed: true })
    limiter.recordTokenFailure(ip)

    expect(limiter.checkToken(ip)).toEqual({ allowed: false, status: 429 })
    expect(limiter.getLockedIps()).toEqual([
      expect.objectContaining({ ip, type: 'token', failures: 10 }),
    ])
  })

  it('allows password login to recover an IP locked only by stale token failures', async () => {
    const limiter = await loadLimiter()
    const ip = '192.0.2.21'

    for (let i = 0; i < 10; i++) {
      expect(limiter.checkToken(ip)).toEqual({ allowed: true })
      limiter.recordTokenFailure(ip)
    }

    expect(limiter.checkToken(ip)).toEqual({ allowed: false, status: 429 })
    expect(limiter.getLockedIps()).toEqual([
      expect.objectContaining({ ip, type: 'token', failures: 10 }),
    ])

    expect(limiter.checkPassword(ip)).toEqual({ allowed: true })
    limiter.recordPasswordSuccess(ip)

    const { writeFileSync } = await import('fs')
    expect(writeFileSync).toHaveBeenCalled()
    const persistedState = JSON.parse((writeFileSync as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1] as string)
    expect(persistedState.tokenIpMap).toEqual({})

    expect(limiter.getLockedIps()).toEqual([])
    expect(limiter.checkToken(ip)).toEqual({ allowed: true })
  })

  it('ignores historical device-pairing locks while retaining password and token protections', async () => {
    const limiter = await loadLimiter()
    const { readFile } = await import('fs/promises')
    vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify({
      pairingIpMap: { '192.0.2.30': { failures: 10, lockedUntil: Date.now() + 60_000 } },
    }))
    await limiter.initLoginLimiter()
    expect(limiter.checkToken('192.0.2.30')).toEqual({ allowed: true })
    expect(limiter.checkPassword('192.0.2.30')).toEqual({ allowed: true })
    expect(limiter.getLockedIps()).toEqual([])
  })

  it('keeps password locks authoritative for protected API attempts', async () => {
    const limiter = await loadLimiter()
    const ip = '192.0.2.22'

    for (let i = 0; i < 10; i++) {
      expect(limiter.checkPassword(ip)).toEqual({ allowed: true })
      limiter.recordPasswordFailure(ip)
    }

    expect(limiter.checkPassword(ip)).toEqual({ allowed: false, status: 429 })
    expect(limiter.checkToken(ip)).toEqual({ allowed: false, status: 429 })
  })

})
