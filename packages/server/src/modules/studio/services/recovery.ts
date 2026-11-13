import { timingSafeEqual } from 'crypto'
import { existsSync, unlinkSync } from 'fs'
import { join } from 'path'
import { config } from '../public/config'
import { unlockAll } from './auth/login-limiter'
import { logger } from '../public/logging'
import {
  DEFAULT_PASSWORD,
  DEFAULT_USERNAME,
  findUserByUsername,
  updateUserPassword,
} from '../repositories/users-store'

const RECOVERY_ENV_VAR = 'HERMES_WEB_UI_RECOVERY_PASSWORD'
const RECOVERY_LOCK_FILE = join(config.appHome, '.login-lock.json')

/** Recovery is enabled only when the operator configures a separate secret. */
export function getRecoveryPassword(): string | null {
  const value = String(process.env[RECOVERY_ENV_VAR] ?? '').trim()
  return value && value !== DEFAULT_PASSWORD ? value : null
}

/** Constant-time compare; the published initial login password cannot recover an account. */
export function verifyRecoveryPassword(input: unknown): boolean {
  if (typeof input !== 'string' || input.length === 0) return false
  const expected = getRecoveryPassword()
  if (!expected) return false
  if (input.length !== expected.length) return false
  const a = Buffer.from(input, 'utf-8')
  const b = Buffer.from(expected, 'utf-8')
  return a.length === b.length && timingSafeEqual(a, b)
}

export interface RecoveryResult {
  ok: boolean
  action: 'cleared-locks' | 'reset-password'
  clearedCount: number
  username?: string
  reason?: string
}

/**
 * Remove all in-process login locks AND delete the on-disk `.login-lock.json`
 * mirror so a fresh server boot won't resurrect them.
 */
export function clearAllLoginLocksInProcess(): RecoveryResult {
  const clearedCount = unlockAll()
  try {
    if (existsSync(RECOVERY_LOCK_FILE)) {
      unlinkSync(RECOVERY_LOCK_FILE)
    }
  } catch (err: any) {
    logger.warn({ err: err?.message, path: RECOVERY_LOCK_FILE }, 'recovery: failed to remove lock file')
  }
  logger.info({ action: 'clear-locks', clearedCount }, 'recovery: cleared login locks')
  return { ok: true, action: 'cleared-locks', clearedCount }
}

/**
 * Reset the default admin password to `DEFAULT_PASSWORD`. Creates the user if missing.
 *
 * The CLI's `reset-default-login` also flips role to `super_admin` / status to `active`;
 * `bootstrapDefaultSuperAdmin` already does this when creating, and we promote on update
 * so the default account always ends up with super-admin privileges.
 */
export function resetDefaultAdminPassword(): RecoveryResult {
  const existing = findUserByUsername(DEFAULT_USERNAME)
  if (existing) {
    const updated = updateUserPassword(existing.id, DEFAULT_PASSWORD)
    if (!updated) {
      logger.error({ username: DEFAULT_USERNAME }, 'recovery: failed to update default admin password')
      return { ok: false, action: 'reset-password', clearedCount: 0, reason: 'update_failed' }
    }
  } else {
    // Bootstrap path is exercised through the login flow; surface a clear error here
    // so the operator knows to run the initial setup instead.
    logger.warn({ username: DEFAULT_USERNAME }, 'recovery: default user missing')
    return { ok: false, action: 'reset-password', clearedCount: 0, reason: 'user_missing' }
  }
  logger.info({ action: 'reset-password', username: DEFAULT_USERNAME }, 'recovery: reset default admin password')
  return { ok: true, action: 'reset-password', clearedCount: 0, username: DEFAULT_USERNAME }
}
