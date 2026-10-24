import type { BusinessEvent } from '../webhooks/business-events'
import type { EventEnvelope, JsonObject } from '../../contracts/plugins'

/** Only explicitly public identifiers cross the plugin boundary; never copy payload. */
export function projectPluginBusinessEvent(event: BusinessEvent, sequence: number): EventEnvelope | null {
  let type: string
  let data: JsonObject
  const runId = event.subject.run_id, sessionId = event.subject.session_id
  if (event.type === 'chat.run.completed' && runId) { type = 'run.completed'; data = { runId } }
  else if (event.type === 'chat.run.failed' && runId) { type = 'run.failed'; data = { runId } }
  else if (event.type === 'chat.session.removed' && event.payload.reason === 'deleted' && sessionId) { type = 'session.deleted'; data = { sessionId } }
  else return null
  const timestamp = Date.parse(event.occurred_at)
  if (!event.profile || !Number.isFinite(timestamp)) return null
  return {
    schemaVersion: 1, id: event.id, type, occurredAt: timestamp,
    partitionKey: `${event.profile}:${sessionId || runId}`, sequence,
    subject: { profileId: event.profile, ...(sessionId ? { sessionId } : {}), ...(runId ? { runId } : {}) },
    data, correlationId: runId || event.id,
  }
}
