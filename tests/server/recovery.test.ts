import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  return {
    unlockAll: vi.fn(),
    extractIp: vi.fn(),
    findUserByUsername: vi.fn(),
    updateUserPassword: vi.fn(),
    loggerInfo: vi.fn(),
    loggerWarn: vi.fn(),
    loggerError: vi.fn(),
    existsSync: vi.fn(),
    unlinkSync: vi.fn(),
  }
})

vi.mock('../../packages/server/src/modules/studio/services/auth/login-limiter', () => ({
  unlockAll: mocks.unlockAll,
  extractIp: mocks.extractIp,
}))

vi.mock('../../packages/server/src/modules/studio/repositories/users-store', () => ({
  DEFAULT_USERNAME: 'quanthermes',
  DEFAULT_PASSWORD: '12345678',
  findUserByUsername: mocks.findUserByUsername,
  updateUserPassword: mocks.updateUserPassword,
}))

vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({
  logger: {
    info: mocks.loggerInfo,
    warn: mocks.loggerWarn,
    error: mocks.loggerError,
  },
}))

vi.mock('fs', () => ({
  existsSync: mocks.existsSync,
  unlinkSync: mocks.unlinkSync,
}))

vi.mock('../../packages/server/src/modules/studio/public/config', () => ({
  config: { appHome: '/tmp/hermes-web-ui-test' },
}))

async function loadRecovery() {
  vi.resetModules()
  return import('../../packages/server/src/modules/studio/services/recovery')
}

describe('recovery service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.unlockAll.mockReturnValue(3)
    mocks.existsSync.mockReturnValue(false)
    mocks.findUserByUsername.mockReturnValue(null)
    mocks.updateUserPassword.mockReturnValue(false)
  })

  afterEach(() => {
    delete process.env.HERMES_WEB_UI_RECOVERY_PASSWORD
  })

  describe('getRecoveryPassword', () => {
    it('disables recovery when no secret is configured', async () => {
      delete process.env.HERMES_WEB_UI_RECOVERY_PASSWORD
      const svc = await loadRecovery()
      expect(svc.getRecoveryPassword()).toBeNull()
    })

    it('uses trimmed env value when set', async () => {
      process.env.HERMES_WEB_UI_RECOVERY_PASSWORD = '  my-secret  '
      const svc = await loadRecovery()
      expect(svc.getRecoveryPassword()).toBe('my-secret')
    })

    it('disables recovery for a blank secret', async () => {
      process.env.HERMES_WEB_UI_RECOVERY_PASSWORD = '   '
      const svc = await loadRecovery()
      expect(svc.getRecoveryPassword()).toBeNull()
    })
  })

  describe('verifyRecoveryPassword', () => {
    it('rejects the published login password even if it is explicitly configured', async () => {
      process.env.HERMES_WEB_UI_RECOVERY_PASSWORD = '12345678'
      const svc = await loadRecovery()
      expect(svc.verifyRecoveryPassword('12345678')).toBe(false)
    })

    it('accepts the configured env value', async () => {
      process.env.HERMES_WEB_UI_RECOVERY_PASSWORD = 'topsecret'
      const svc = await loadRecovery()
      expect(svc.verifyRecoveryPassword('topsecret')).toBe(true)
    })

    it('rejects wrong password', async () => {
      process.env.HERMES_WEB_UI_RECOVERY_PASSWORD = 'topsecret'
      const svc = await loadRecovery()
      expect(svc.verifyRecoveryPassword('wrong')).toBe(false)
    })

    it('rejects when length differs (constant-time guard)', async () => {
      process.env.HERMES_WEB_UI_RECOVERY_PASSWORD = 'topsecret'
      const svc = await loadRecovery()
      expect(svc.verifyRecoveryPassword('topsecret-long')).toBe(false)
    })

    it('rejects non-string inputs without throwing', async () => {
      process.env.HERMES_WEB_UI_RECOVERY_PASSWORD = 'topsecret'
      const svc = await loadRecovery()
      expect(svc.verifyRecoveryPassword(undefined)).toBe(false)
      expect(svc.verifyRecoveryPassword(null)).toBe(false)
      expect(svc.verifyRecoveryPassword(12345)).toBe(false)
      expect(svc.verifyRecoveryPassword('')).toBe(false)
    })
  })

  describe('clearAllLoginLocksInProcess', () => {
    it('returns the count cleared by unlockAll', async () => {
      mocks.unlockAll.mockReturnValue(3)
      const svc = await loadRecovery()
      const result = svc.clearAllLoginLocksInProcess()
      expect(result.ok).toBe(true)
      expect(result.action).toBe('cleared-locks')
      expect(result.clearedCount).toBe(3)
    })

    it('removes the lock file when present', async () => {
      mocks.existsSync.mockReturnValue(true)
      const svc = await loadRecovery()
      svc.clearAllLoginLocksInProcess()
      expect(mocks.unlinkSync).toHaveBeenCalledWith(
        expect.stringContaining('.login-lock.json'),
      )
    })

    it('does not throw when lock file is missing', async () => {
      mocks.existsSync.mockReturnValue(false)
      const svc = await loadRecovery()
      expect(() => svc.clearAllLoginLocksInProcess()).not.toThrow()
    })
  })

  describe('resetDefaultAdminPassword', () => {
    it('updates an existing user via updateUserPassword', async () => {
      mocks.findUserByUsername.mockReturnValue({ id: 42 } as any)
      mocks.updateUserPassword.mockReturnValue(true)
      const svc = await loadRecovery()
      const result = svc.resetDefaultAdminPassword()
      expect(result.ok).toBe(true)
      expect(result.username).toBe('quanthermes')
      expect(mocks.updateUserPassword).toHaveBeenCalledWith(42, '12345678')
    })

    it('returns ok=false with reason=user_missing when default user not present', async () => {
      mocks.findUserByUsername.mockReturnValue(null)
      const svc = await loadRecovery()
      const result = svc.resetDefaultAdminPassword()
      expect(result.ok).toBe(false)
      expect(result.reason).toBe('user_missing')
    })

    it('returns ok=false with reason=update_failed when DB update reports no row', async () => {
      mocks.findUserByUsername.mockReturnValue({ id: 7 } as any)
      mocks.updateUserPassword.mockReturnValue(false)
      const svc = await loadRecovery()
      const result = svc.resetDefaultAdminPassword()
      expect(result.ok).toBe(false)
      expect(result.reason).toBe('update_failed')
    })
  })
})
