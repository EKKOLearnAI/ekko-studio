import { notificationPreview } from './notification-preview'
import { listAppConnections } from '../../repositories/app-connections-store'
import { findUserById } from '../../repositories/users-store'
import { listUserPushDevices, removeUserPushDevice } from '../../repositories/user-push-store'
import type { BusinessEvent } from '../webhooks/business-events'
import { appRelayUrlForRoute, getAppRelayRoute } from '../app-relay/route'
import { appEventEnvelope, canReceiveAppEvent } from '../webhooks/app-events'
import { decryptPushSecret } from './push-secrets'

const PUSH_EVENTS: Record<string, 'completion' | 'failure' | 'approval' | 'interaction'> = {
  'chat.run.completed': 'completion', 'chat.run.failed': 'failure',
  'chat.approval.requested': 'approval', 'chat.clarification.requested': 'interaction',
  'group.message.created': 'completion', 'group.run.failed': 'failure',
  'group.approval.requested': 'approval', 'group.clarification.requested': 'interaction',
  'workflow.run.completed': 'completion', 'workflow.run.failed': 'failure',
}

/** Event-driven delivery to current devices of the same owner used by Android. */
export function createRunPushConsumer(send: typeof fetch = (...args) => fetch(...args)) {
  const attempted = new Set<string>()
  return async (event: BusinessEvent): Promise<void> => {
    const kind = PUSH_EVENTS[event.type], payload = event.payload
    if (!kind || payload.replayed === true || payload.restored === true || payload.background_snapshot === true) return
    if (event.type.startsWith('chat.') && ['group_chat', 'workflow'].includes(event.source)) return
    if (payload.interrupted === true || ['queue_insertion', 'aborted', 'cancelled', 'canceled'].includes(String(payload.stop_reason))) return
    if (kind === 'approval' && !event.subject.approval_id || kind === 'interaction' && !event.subject.clarification_id) return
    try {
      const envelope = appEventEnvelope(event)
      if (!envelope || ('notify' in envelope && envelope.notify === false)) return
      const runKind = event.source === 'group_chat' ? 'group' : event.source === 'workflow' ? 'workflow' : 'chat'
      const subjectId = runKind === 'group' ? event.subject.room_id : runKind === 'workflow' ? event.subject.workflow_id : event.subject.session_id
      if (!subjectId) return
      const pushUrl = new URL('/push/v1/send', appRelayUrlForRoute(await getAppRelayRoute()))
      const connections = listAppConnections()
      await Promise.allSettled(listUserPushDevices().map(async device => {
        const connection = connections.find(row => row.id === device.connection_id && row.user_id === device.user_id
          && row.device_code === device.device_id && row.token_hash === device.connection_token_hash
          && row.revoked_at == null && row.token_expires_at > Date.now() / 1000)
        if (!connection) { removeUserPushDevice(device.id); return }
        if (connection.push_enabled === 0) return
        const user = findUserById(device.user_id)
        if (!user || user.status !== 'active' || !canReceiveAppEvent(user, event)) return
        let registration: Record<string, any>
        try { registration = JSON.parse(decryptPushSecret(device.ciphertext)) } catch { return }
        if (registration.platform !== 'ios' || registration.installation_ref !== device.device_id) return
        // Runtime IDs may span chat turns. Timestamp distinguishes separate completion events.
        const interaction = event.subject.approval_id || event.subject.clarification_id
        const occurrence = interaction ? `${kind}:${interaction}` : `${event.id}:${event.occurred_at}`
        const key = `${device.device_id}:${device.app_id}:${device.environment}:${subjectId}:${occurrence}`
        if (attempted.has(key)) return
        attempted.add(key)
        if (attempted.size > 5000) attempted.delete(attempted.values().next().value!)
        const response = await send(pushUrl, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${registration.push_token}` },
          body: JSON.stringify({ schema_version: 1, event_id: event.id, event_type: kind,
            recipient: { platform: 'ios', app_id: registration.app_id,
              apns_environment: registration.apns_environment, apns_token: registration.apns_token },
            // Explicit server opt-in; default retains the existing privacy boundary.
            // Custom content requires a gateway that honors notification title/body.
            notification: process.env.STUDIO_PUSH_CONTENT_PREVIEW === '1'
              ? notificationPreview('display' in envelope ? envelope.display : undefined, kind === 'completion')
              : { title: '', body: '' },
            ekko_run: { schema_version: 1, studio_device_id: registration.studio_device_id, cloud_user_id: registration.cloud_user_id,
              run_kind: runKind, run_id: event.subject.run_id || event.subject.message_id || event.id, profile: event.profile,
              [runKind === 'chat' ? 'session_id' : runKind === 'group' ? 'room_id' : 'workflow_id']: subjectId } }),
        })
        if (response.status === 410 || response.status === 422) {
          const result = await response.json().catch(() => null) as { error?: string } | null
          if (['apns_recipient_unregistered', 'apns_invalid_recipient'].includes(result?.error || '')) removeUserPushDevice(device.id)
        } else await response.body?.cancel()
      }))
    } catch { /* Notification failures never change task outcomes. */ }
  }
}
