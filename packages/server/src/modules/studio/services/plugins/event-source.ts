import { randomUUID } from 'node:crypto'
import { businessEvents, type BusinessEvent } from '../webhooks/business-events'

/** Plugin-only observations do not become mobile notifications or HTTP webhooks. */
export function publishPluginObservation(type: string, profile: string, source: string, subject: BusinessEvent['subject'], payload: Record<string, unknown>): void {
  businessEvents.publish({ schema_version: 1, id: randomUUID(), type, occurred_at: new Date().toISOString(), profile, source, subject, payload })
}
