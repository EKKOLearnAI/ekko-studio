import { ownsPersonSession } from '../../contracts/person-session'
import { getSession } from '../../repositories/session-store'
import { buildResumeEvents } from '../chat-run/resume-payload'
import type { SessionState } from '../chat-run/types'
import type { BusinessEvent } from '../webhooks/business-events'
import { stateEvent } from '../webhooks/app-event-state'

/** Restore owner run state and pending interactions, never private workers or completion alerts. */
export function personNotificationSnapshot(userId: number, states: Iterable<[string, SessionState]>): BusinessEvent[] {
  const result: BusinessEvent[] = []
  for (const [sessionId, state] of states) {
    if (!sessionId.startsWith('person-main-') || !state.isWorking) continue
    const session = getSession(sessionId)
    if (!ownsPersonSession(userId, session) || session?.is_archived) continue
    const profile = session!.profile || 'default'
    const runId = state.activeRunMarker || state.responseRun?.runMarker || state.runId
    result.push({ ...stateEvent('person.run.updated', profile, { session_id: sessionId, run_id: runId },
      { state: { session_id: sessionId, status: 'running', timestamp: Date.now(), started_at: state.runStartedAt } }), source: 'person' })
    const pending = new Map<string, BusinessEvent>()
    for (const { event, data } of buildResumeEvents(state.events)) {
      if (!['approval.requested', 'approval.resolved', 'clarify.requested', 'clarify.resolved'].includes(event)) continue
      const approval = event.startsWith('approval.')
      const id = approval ? data?.approval_id : data?.clarify_id
      if (!id) continue
      const key = `${approval ? 'approval' : 'clarify'}:${id}`
      if (event.endsWith('.resolved')) {
        if (!data.stale && (data.resolved !== false || ['timeout', 'aborted', 'cancelled', 'canceled'].includes(data.reason))) pending.delete(key)
        continue
      }
      if (data.remaining_timeout_ms === 0) continue
      pending.set(key, { ...stateEvent(`person.${event.replace('clarify.', 'clarification.')}`, profile,
        { session_id: sessionId, run_id: runId, ...(approval ? { approval_id: id } : { clarification_id: id }) }, data), source: 'person' })
    }
    result.push(...pending.values())
  }
  return result
}
