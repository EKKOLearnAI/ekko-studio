import { createHash } from 'node:crypto'
import { inspectAppUserToken } from '../../public/auth'
import { getAppRelayDeviceIdentity } from '../../public/system-info'
import { hashAppCredential, listAppConnections } from '../../repositories/app-connections-store'
import { removeConnectionPushDevices, saveUserPushDevice } from '../../repositories/user-push-store'
import { prepareRunPushSnapshot } from './push-registration'

export class PushRegistrationError extends Error {
  constructor(message: string, public status: number) { super(message) }
}

export async function updateUserPushRegistration(token: string, value: unknown, remove = false): Promise<void> {
  const app = await inspectAppUserToken(token)
  if (app?.status !== 'active' || !app.user) throw new PushRegistrationError('push_device_authentication_failed', 401)
  const connection = listAppConnections().find(row => row.user_id === app.user!.id
    && row.device_code === app.deviceCode && row.connection_type === app.connectionType
    && row.token_hash === hashAppCredential(token) && row.token_expires_at > Date.now() / 1000)
  if (!connection) throw new PushRegistrationError('push_device_authentication_failed', 401)
  if (remove) { removeConnectionPushDevices(connection.id); return }
  const body = value as Record<string, unknown> | null
  if (!body || body.platform !== 'ios' || (connection.cloud_user_id > 0 && body.cloud_user_id !== connection.cloud_user_id)) {
    throw new PushRegistrationError('invalid_push_registration', 400)
  }
  const actor = { userId: app.user.id, deviceId: app.deviceCode,
    studioDeviceId: (await getAppRelayDeviceIdentity()).device_id }
  const ciphertext = prepareRunPushSnapshot(actor, body)
  if (!ciphertext) throw new PushRegistrationError('invalid_push_registration', 400)
  saveUserPushDevice({ user_id: actor.userId, device_id: actor.deviceId, connection_id: connection.id,
    connection_token_hash: connection.token_hash, app_id: String(body.app_id), environment: String(body.apns_environment),
    recipient_hash: createHash('sha256').update(String(body.apns_token).trim().toLowerCase()).digest('hex'), ciphertext })
}
