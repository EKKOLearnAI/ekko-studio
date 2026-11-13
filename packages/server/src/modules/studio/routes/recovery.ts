import Router from '@koa/router'
import { clearLocksHandler, resetPasswordHandler } from '../controllers/recovery'

/**
 * Public recovery endpoints. Mounted BEFORE auth middleware so locked-out users
 * (and unauthenticated visitors on LAN devices) can recover access without
 * needing a valid JWT.
 *
 * Both endpoints require a shared recovery password. See services/recovery.ts
 * for configuration and trust assumptions.
 */
export const recoveryPublicRoutes = new Router()
recoveryPublicRoutes.post('/api/auth/recovery/clear-locks', clearLocksHandler)
recoveryPublicRoutes.post('/api/auth/recovery/reset-password', resetPasswordHandler)