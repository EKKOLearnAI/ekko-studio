import { updateOwnDeviceNotificationPreference } from '../services/notifications/device-preference'
import { endDeviceLiveActivities } from '../services/notifications/live-activity-catchup'
import { ensureBusinessConsumers } from '../services/webhooks/business-consumers'
import type { Context } from 'koa'
import { PushRegistrationError, updateUserPushRegistration } from '../services/notifications/user-push-registration'
import { updateLiveActivityDestination } from '../services/notifications/live-activity-registration'

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

export async function liveActivityRegistrationController(ctx: Context): Promise<void> {
  ensureBusinessConsumers()
  const authorization = ctx.get('authorization')
  try {
    await updateLiveActivityDestination(authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '',
      ctx.request.body, ctx.method === 'DELETE')
    ctx.body = { ok: true }
  } catch (error) {
    ctx.status = error instanceof PushRegistrationError ? error.status : 503
    ctx.body = { ok: false, error: error instanceof PushRegistrationError ? error.message : 'live_activity_registration_unavailable' }
  }
}

export async function deviceNotificationPreferenceController(ctx: Context): Promise<void> {
  try {
    const auth=ctx.get('authorization')
    const connectionId=await updateOwnDeviceNotificationPreference(auth.startsWith('Bearer ')?auth.slice(7).trim():'',ctx.request.body)
    ensureBusinessConsumers()
    if ((ctx.request.body as any).enabled===false) void endDeviceLiveActivities(connectionId).catch(()=>console.warn('[live-activity] device_cleanup_failed'))
    ctx.body={ok:true,enabled:(ctx.request.body as any).enabled}
  } catch(error) {
    ctx.status=error instanceof PushRegistrationError?error.status:503
    ctx.body={ok:false,error:error instanceof PushRegistrationError?error.message:'notification_preference_unavailable'}
  }
}
