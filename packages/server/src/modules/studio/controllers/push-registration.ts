import type { Context } from 'koa'
import { PushRegistrationError, updateUserPushRegistration } from '../services/notifications/user-push-registration'

export async function pushRegistrationController(ctx: Context): Promise<void> {
  const authorization = ctx.get('authorization')
  try {
    await updateUserPushRegistration(authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '',
      ctx.request.body, ctx.method === 'DELETE')
    ctx.body = { ok: true }
  } catch (error) {
    ctx.status = error instanceof PushRegistrationError ? error.status : 503
    ctx.body = { ok: false, error: error instanceof PushRegistrationError ? error.message : 'push_registration_unavailable' }
  }
}
