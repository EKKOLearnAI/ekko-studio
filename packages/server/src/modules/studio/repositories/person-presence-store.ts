import { getDb } from '../infrastructure/database'
import { personError } from '../contracts/person'
import { personUpdated } from './person-updates'

function personDb() {
  const db = getDb()
  if (!db) throw personError('Person requires SQLite', 503)
  return db
}

export type PersonFeedbackState = 'done' | 'error'
const feedbackDuration = { done: 2000, error: 3000 } as const
export interface PersonFeedback { event_id: string; state: PersonFeedbackState; started_at: number; expires_at: number }

/** Outcome feedback never counts as user input or resets the sleep deadline. */
export function recordPersonOutcome(userId: number, eventId: string, state: PersonFeedbackState, now = Date.now()): void {
  personDb().prepare(`INSERT INTO person_presence_feedback(user_id,event_id,state,started_at,expires_at) VALUES (?,?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET event_id=excluded.event_id,state=excluded.state,
      started_at=excluded.started_at,expires_at=excluded.expires_at
    WHERE person_presence_feedback.event_id<>excluded.event_id`).run(userId, eventId, state, now, now + feedbackDuration[state])
  personUpdated(userId)
}

export function personFeedback(userId: number, now: number): PersonFeedback | undefined {
  return personDb().prepare('SELECT event_id,state,started_at,expires_at FROM person_presence_feedback WHERE user_id=? AND started_at<=? AND expires_at>?')
    .get(userId, now, now) as unknown as PersonFeedback | undefined
}

export function personLastActivity(userId: number, now = Date.now()): number {
  const db = personDb()
  db.prepare('INSERT OR IGNORE INTO person_presence(user_id,last_activity_at) VALUES (?,?)').run(userId, now)
  return Number(db.prepare('SELECT last_activity_at FROM person_presence WHERE user_id=?').get(userId)!.last_activity_at)
}

export function touchPersonActivity(userId: number, now = Date.now()): void {
  personDb().prepare(`INSERT INTO person_presence(user_id,last_activity_at) VALUES (?,?)
    ON CONFLICT(user_id) DO UPDATE SET last_activity_at=MAX(last_activity_at,excluded.last_activity_at)`).run(userId, now)
}

export function personHasExecutingTask(userId: number): boolean {
  // Queued, waiting, finished and merely open goals are not executing work.
  return !!personDb().prepare(`SELECT 1 FROM person_executions e
    JOIN session_tasks t ON t.id=e.task_id
    WHERE e.owner_user_id=? AND t.owner_user_id=? AND t.bot_id=?
      AND e.state IN ('starting','running','stopping') LIMIT 1`).get(userId, userId, `person:${userId}`)
}

/** Shared by activity rows and counts, including completed tasks still reporting. Alias: t. */
export const PERSON_TASK_RUNNING_SQL = `EXISTS(SELECT 1 FROM person_executions e WHERE e.owner_user_id=t.owner_user_id AND e.task_id=t.id AND e.state IN ('pending','queued','starting','running','stopping','waiting_person','waiting_user','waiting_approval'))
  OR EXISTS(SELECT 1 FROM person_task_redirects r WHERE r.task_id=t.id AND r.state IN ('waiting','cancelling'))
  OR EXISTS(SELECT 1 FROM person_deliveries d JOIN person_executions e ON e.id=d.execution_id WHERE e.owner_user_id=t.owner_user_id AND e.task_id=t.id AND d.owner_user_id=t.owner_user_id AND d.state IN ('pending','queued'))
  OR EXISTS(SELECT 1 FROM person_acceptance_tasks l JOIN person_executions v ON v.task_id=l.verification_task_id
    WHERE l.development_task_id=t.id AND v.owner_user_id=t.owner_user_id AND v.state IN ('pending','queued','starting','running','stopping','waiting_person','waiting_user','waiting_approval'))
  OR (t.status='open' AND EXISTS(SELECT 1 FROM person_acceptance a JOIN person_executions e ON e.id=a.execution_id WHERE e.owner_user_id=t.owner_user_id AND e.task_id=t.id
    AND json_extract(a.snapshot_json,'$.requirements.acceptance.progression')='automatic'
    AND a.state IN ('pending','developing','awaiting_dispatch','verification_pending','awaiting_review','repair_required')
    AND e.rowid=(SELECT MAX(rowid) FROM person_executions WHERE task_id=t.id)))`

/** Count tasks across the account, including queued/waiting work and pending reports. */
export function personBackgroundTaskCount(userId: number, sessionId?: string): number {
  return Number(personDb().prepare(`SELECT COUNT(*) AS n FROM session_tasks t
    WHERE t.owner_user_id=? AND t.bot_id=? AND (? IS NULL OR t.session_id=?) AND (${PERSON_TASK_RUNNING_SQL})`)
    .get(userId, `person:${userId}`, sessionId ?? null, sessionId ?? null)!.n)
}
