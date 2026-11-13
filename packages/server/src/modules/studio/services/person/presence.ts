import { isPersonSession } from '../../contracts/person-session'
import { personDb } from '../../repositories/person-store'
import { personSessionIds } from '../../repositories/person-session-store'
import { getChatRunServer } from '../../public/chat-run'
import { personHasExecutingTask, personBackgroundTaskCount, personLastActivity, touchPersonActivity, personFeedback, recordPersonOutcome } from '../../repositories/person-presence-store'

export const PERSON_SLEEP_AFTER_MS = 10 * 60 * 1000
export type PersonPresenceState = 'idle' | 'thinking' | 'searching' | 'done' | 'error' | 'sleeping'
export interface PersonPresenceSnapshot { state: PersonPresenceState; backgroundTaskCount: number; lastActivityAt: number; sleepAt: number; feedbackId?: string; feedbackUntil?: number }
interface MainActivity { runId?: string; tools: Set<string>; waiting: Set<string> }
const mainActivity = new Map<string, MainActivity>()

/** Track current main-run tools independently of the bounded chat event replay buffer. */
export function observePersonPresenceEvent(sessionId: string, event: string, payload: Record<string, any>): void {
  if (!isPersonSession(sessionId)) return
  const owner = personDb().prepare('SELECT studio_user_id FROM sessions WHERE id=?').get(sessionId)
  if (!owner) return
  const userId = Number(owner.studio_user_id)
  let activity = mainActivity.get(sessionId)
  const runId = typeof payload.run_id === 'string' ? payload.run_id : undefined
  if (event === 'run.started') {
    mainActivity.set(sessionId, { runId, tools: new Set(), waiting: new Set() })
    return
  }
  if (activity?.runId && runId && activity.runId !== runId) return
  if (['run.completed', 'run.failed', 'abort.completed'].includes(event)) {
    if (activity && event !== 'abort.completed') recordPersonOutcome(userId, `main:${activity.runId || runId}`, event === 'run.completed' ? 'done' : 'error')
    mainActivity.delete(sessionId)
    return
  }
  if (!['tool.started', 'tool.completed', 'tool.failed', 'clarify.requested', 'clarify.resolved', 'approval.requested', 'approval.resolved'].includes(event)) return
  if (!activity) { activity = { runId, tools: new Set(), waiting: new Set() }; mainActivity.set(sessionId, activity) }
  if (event.startsWith('tool.')) {
    const id = String(payload.tool_call_id || payload.id || payload.tool || 'tool')
    if (event === 'tool.started') activity.tools.add(id)
    else activity.tools.delete(id)
  } else {
    const id = `${event.split('.')[0]}:${payload.clarify_id || payload.approval_id || ''}`
    if (event.endsWith('.requested')) activity.waiting.add(id)
    else if (!payload.stale && (payload.resolved !== false || ['timeout', 'aborted', 'cancelled', 'canceled'].includes(payload.reason))) activity.waiting.delete(id)
  }
}

export function personPresenceSnapshot(userId: number, now = Date.now()): PersonPresenceSnapshot {
  const lastActivityAt = personLastActivity(userId, now)
  const sleepAt = lastActivityAt + PERSON_SLEEP_AFTER_MS
  const backgroundTaskCount = personBackgroundTaskCount(userId)
  const feedback = personFeedback(userId, now)
  if (feedback) return { state: feedback.state, backgroundTaskCount, lastActivityAt, sleepAt, feedbackId: feedback.event_id, feedbackUntil: feedback.expires_at }
  const server = getChatRunServer()
  const activities = personSessionIds(userId).filter(id => server?.isSessionRunning?.(id)).map(id => mainActivity.get(id))
  let state: PersonPresenceState
  if (personHasExecutingTask(userId) || activities.some(activity => !activity?.waiting.size && !!activity?.tools.size)) state = 'searching'
  else if (activities.some(activity => !activity?.waiting.size)) state = 'thinking'
  else state = now >= sleepAt ? 'sleeping' : 'idle'
  return { state, backgroundTaskCount, lastActivityAt, sleepAt }
}

export function recordPersonActivity(userId: number): void { touchPersonActivity(userId) }
export function clearPersonPresenceRuntime(): void { mainActivity.clear() }
