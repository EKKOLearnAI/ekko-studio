import { StudioError, type EventEnvelope } from '../../contracts/plugins'
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
