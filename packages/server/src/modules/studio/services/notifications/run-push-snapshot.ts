import { getRunPushTarget, type PushRunRef } from '../../repositories/run-push-store'
import { decryptPushSecret } from './push-secrets'

/** Read only this run's snapshot. Never replace it with another device's latest grant. */
export function readRunPushNotification(ref: PushRunRef) {
  const run = getRunPushTarget(ref)
  if (!run?.studio_device_id || !run.push_snapshot_ciphertext) return null
  try {
    const snapshot = JSON.parse(decryptPushSecret(run.push_snapshot_ciphertext))
    if (snapshot.studio_device_id !== run.studio_device_id || snapshot.installation_ref !== run.device_id) return null
    return {
      credential: snapshot.push_token as string,
      recipient: { platform: snapshot.platform, app_id: snapshot.app_id,
        apns_environment: snapshot.apns_environment, apns_token: snapshot.apns_token },
      route: { schema_version: 1, studio_device_id: run.studio_device_id, cloud_user_id: snapshot.cloud_user_id,
        run_kind: run.kind, run_id: run.run_id, profile: run.profile,
        ...(run.kind === 'chat' ? { session_id: run.subject_id }
          : run.kind === 'group' ? { room_id: run.subject_id } : { workflow_id: run.subject_id }) },
    }
  } catch { return null }
}
