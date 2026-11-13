import { randomUUID } from 'node:crypto'
import { businessEvents } from '../webhooks/business-events'

/** Capture ownership before deletion; the session no longer exists at delivery. */
export function publishSessionRemoval(
  session: { id: string; profile?: string | null; user_id?: string | number | null },
  reason: 'deleted' | 'archived',
): void {
  const owner = Number(session.user_id)
  if (!Number.isSafeInteger(owner) || owner <= 0) return
  businessEvents.publish({
    schema_version: 1, id: randomUUID(), type: 'chat.session.removed',
    occurred_at: new Date().toISOString(), profile: session.profile || 'default', source: 'chat',
    subject: { session_id: session.id }, payload: { owner_user_id: owner, reason },
  })
}
