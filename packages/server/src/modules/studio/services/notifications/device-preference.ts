import { inspectAppUserToken } from '../../public/auth'
import { hashAppCredential, listAppConnections } from '../../repositories/app-connections-store'
import { saveDeviceSystemNotifications } from '../../repositories/device-notification-preferences'
import { PushRegistrationError } from './user-push-registration'

export async function updateOwnDeviceNotificationPreference(token: string, value: unknown): Promise<number> {
  const body=value as {enabled?:unknown}|null
  if (!body || typeof body.enabled !== 'boolean' || Object.keys(body).some(k=>k!=='enabled')) throw new PushRegistrationError('invalid_notification_preference',400)
  const app=await inspectAppUserToken(token)
  if (app?.status!=='active'||!app.user) throw new PushRegistrationError('notification_authentication_failed',401)
  const row=listAppConnections().find(c=>c.user_id===app.user!.id && c.device_code===app.deviceCode
    && c.connection_type===app.connectionType && c.token_hash===hashAppCredential(token)
    && c.revoked_at==null && c.token_expires_at>Date.now()/1000)
  if (!row) throw new PushRegistrationError('notification_authentication_failed',401)
  saveDeviceSystemNotifications(row.user_id,row.device_code,body.enabled)
  return row.id
}
