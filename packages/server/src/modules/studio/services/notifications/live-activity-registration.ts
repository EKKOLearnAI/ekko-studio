import { catchUpLiveActivities } from './live-activity-catchup'
import { inspectAppUserToken } from '../../public/auth'
import { getAppRelayDeviceIdentity } from '../../public/system-info'
import { hashAppCredential, listAppConnections } from '../../repositories/app-connections-store'
import { removeConnectionLiveActivities, saveLiveActivityDestination } from '../../repositories/live-activity-store'
import { encryptPushSecret } from './push-registration'
import { PushRegistrationError } from './user-push-registration'

export async function updateLiveActivityDestination(token: string, value: unknown, remove = false): Promise<void> {
  const app = await inspectAppUserToken(token)
  if (app?.status !== 'active' || !app.user) throw new PushRegistrationError('live_activity_authentication_failed', 401)
  const connection = listAppConnections().find(row => row.user_id === app.user!.id && row.device_code === app.deviceCode
    && row.connection_type === app.connectionType && row.token_hash === hashAppCredential(token) && row.token_expires_at > Date.now() / 1000)
  if (!connection) throw new PushRegistrationError('live_activity_authentication_failed', 401)
  if (remove) { removeConnectionLiveActivities(connection.id); return }
  const body = value as Record<string, unknown> | null, studio = (await getAppRelayDeviceIdentity()).device_id
  if (body?.appearance !== undefined && !['light', 'dark'].includes(String(body.appearance))) throw new PushRegistrationError('invalid_live_activity_appearance', 400)
  if (!body || body.schema_version !== 1 || body.platform !== 'ios' || body.studio_device_id !== studio
    || body.installation_ref !== app.deviceCode || connection.cloud_user_id > 0 && body.cloud_user_id !== connection.cloud_user_id
    || !/^[A-Za-z0-9._:-]{1,128}$/.test(String(body.destination_id || '')) || body.enabled !== true
    || !/^[a-zA-Z0-9._-]{1,255}$/.test(String(body.app_id || '')) || !['development', 'production'].includes(String(body.apns_environment))
    || !/^push_[A-Za-z0-9_-]{43}$/.test(String(body.push_token || ''))) throw new PushRegistrationError('invalid_live_activity_registration', 400)
  const saved = { schema_version: 1, studio_device_id: studio, installation_ref: app.deviceCode,
    cloud_user_id: body.cloud_user_id, app_id: body.app_id, apns_environment: body.apns_environment,
    ...(body.appearance === undefined ? {} : { appearance: body.appearance }),
    grant_id: body.grant_id, push_token: body.push_token, destination_id: body.destination_id }
  saveLiveActivityDestination({ user_id: app.user.id, device_id: app.deviceCode, connection_id: connection.id,
    connection_token_hash: connection.token_hash, app_id: String(body.app_id), environment: String(body.apns_environment),
    destination_id: String(body.destination_id), ciphertext: encryptPushSecret(JSON.stringify(saved)), enabled: 1 })
  void catchUpLiveActivities(connection.id).catch(() => { console.warn('[live-activity] catchup_failed') })
}
