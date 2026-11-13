import type { Context } from 'koa'
import { extractIp } from '../services/auth/login-limiter'
import { logger } from '../public/logging'
import {
  clearAllLoginLocksInProcess,
  resetDefaultAdminPassword,
  getRecoveryPassword,
  verifyRecoveryPassword,
} from '../services/recovery'

interface RecoveryRequestBody {
  recoveryPassword?: unknown
}

function readRecoveryPassword(ctx: Context): string | null {
  const body = (ctx.request.body ?? {}) as RecoveryRequestBody
  if (typeof body.recoveryPassword !== 'string') return null
  const trimmed = body.recoveryPassword.trim()
  return trimmed.length > 0 ? trimmed : null
}

/**
 * POST /api/auth/recovery/clear-locks
 *
 * Clears in-process and on-disk login locks after verifying the operator-configured
 * recovery secret. The endpoint is disabled when no separate secret is set.
 */
export async function clearLocksHandler(ctx: Context) {
  if (!getRecoveryPassword()) { ctx.status = 404; return }
  const password = readRecoveryPassword(ctx)
  if (!password || !verifyRecoveryPassword(password)) {
    logger.warn({ ip: extractIp(ctx), action: 'clear-locks' }, 'recovery: rejected clear-locks attempt')
    ctx.status = 401
    ctx.body = { error: 'Invalid recovery password' }
    return
  }

  const result = clearAllLoginLocksInProcess()
  ctx.status = 200
  ctx.body = { success: true, action: result.action, clearedCount: result.clearedCount }
}

/**
 * POST /api/auth/recovery/reset-password
 *
 * Resets the default admin password back to `DEFAULT_PASSWORD` and ensures super-admin /
 * active status. See clearLocksHandler for the trust model.
 */
export async function resetPasswordHandler(ctx: Context) {
  if (!getRecoveryPassword()) { ctx.status = 404; return }
  const password = readRecoveryPassword(ctx)
  if (!password || !verifyRecoveryPassword(password)) {
    logger.warn({ ip: extractIp(ctx), action: 'reset-password' }, 'recovery: rejected reset-password attempt')
    ctx.status = 401
    ctx.body = { error: 'Invalid recovery password' }
    return
  }

  const result = resetDefaultAdminPassword()
  if (!result.ok) {
    ctx.status = result.reason === 'user_missing' ? 404 : 500
    ctx.body = { error: result.reason }
    return
  }
  ctx.status = 200
  ctx.body = { success: true, action: result.action, username: result.username }
}
