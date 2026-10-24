import { randomUUID } from 'node:crypto'
import { businessEvents } from '../webhooks/business-events'
import { studioSessionAccount } from '../../contracts/runs/usage'

/** Capture ownership before deletion; the session no longer exists at delivery. */
export function publishSessionRemoval(
  session: { id: string; profile?: string | null; user_id?: string | number | null; studio_user_id?: string | null; source?: string },
  reason: 'deleted' | 'archived',
  notification?: { id: string; occurredAt: number },
): void {
  const studioOwner = studioSessionAccount(session)
  const owner = Number(studioOwner ?? session.user_id)
  if (!Number.isSafeInteger(owner) || owner <= 0) return
  businessEvents.publish({
    schema_version: 1, id: notification?.id || randomUUID(), type: 'chat.session.removed',
    occurred_at: new Date(notification?.occurredAt ?? Date.now()).toISOString(), profile: session.profile || 'default', source: 'chat',
    subject: { session_id: session.id }, payload: { owner_user_id: owner, reason,
      ...(studioOwner ? { studio_owner_id: studioOwner } : {}) },
  })
}
