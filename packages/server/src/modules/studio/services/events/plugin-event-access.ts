import { randomUUID } from 'node:crypto'
import { StudioError, type EventEnvelope, type ExecutionScope } from '../../contracts/plugins'
import { studioSessionAccount } from '../../contracts/runs/usage'

/** Historical visibility is host metadata; event actor/payload never supplies authority. */
export function authorizePluginEvent(
  owner: { ownerId: string; profileId: string }, event: EventEnvelope,
  resources: {
    recordedOwner: string | null
    run: { ownerId: string; profileId: string } | null
    session: { profile?: string; studio_user_id?: unknown; user_id?: unknown; source?: string } | null
  },
): void {
  const deny = () => { throw new StudioError('FORBIDDEN', 'Event is outside the consumer owner scope') }
  if (event.subject.profileId !== owner.profileId) deny()
  if (!event.subject.runId && !event.subject.sessionId) return
  if (resources.recordedOwner && resources.recordedOwner !== owner.ownerId) deny()
  if (resources.run && (resources.run.ownerId !== owner.ownerId || resources.run.profileId !== owner.profileId)) deny()
  if (resources.session && (studioSessionAccount(resources.session) !== owner.ownerId || (resources.session.profile || 'default') !== owner.profileId)) deny()
  if (!resources.recordedOwner && !resources.run && !resources.session) deny()
}

/** Global plugins inherit authority from each event resource, never from installation or its administrator. */
export function pluginEventExecutionScope(event: EventEnvelope, resources: {
  recordedOwner: string | null
  run: { ownerId: string; profileId: string } | null
  session: { profile?: string; studio_user_id?: unknown; user_id?: unknown; source?: string } | null
}): ExecutionScope {
  const scope = { scopeId: randomUUID(), surface: 'event' as const, traceId: event.correlationId }
  if (!event.subject.runId && !event.subject.sessionId) {
    // Global notifications cannot query user data or start work without a caller.
    return { ...scope, principal: { kind: 'service', id: 'studio.plugins' }, profileId: '' }
  }
  const ownerId = resources.run?.ownerId || (resources.session ? studioSessionAccount(resources.session) : resources.recordedOwner)
  const profileId = event.subject.profileId
  if (!ownerId || !profileId) throw new StudioError('FORBIDDEN', 'Event resource authority is unavailable')
  authorizePluginEvent({ ownerId, profileId }, event, resources)
  return { ...scope, principal: { kind: 'user', id: ownerId }, profileId,
    ...(event.subject.sessionId ? { sessionId: event.subject.sessionId } : {}),
    ...(event.subject.runId ? { runId: event.subject.runId } : {}) }
}
