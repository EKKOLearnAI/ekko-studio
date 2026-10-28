import { personError } from '../contracts/person'
import { ownsPersonSession, personSessionId } from '../contracts/person-session'
import { COMPRESSION_SNAPSHOT_TABLE, TASK_PLANS_TABLE, RUN_USAGE_TABLE, SESSION_UPLOADS_TABLE,
  WORKSPACE_RUN_CHANGES_TABLE, WORKSPACE_RUN_CHANGE_FILES_TABLE } from '../infrastructure/database/schemas'
import { personDb, personTransaction } from './person-store'
import { getSession } from './session-store'

export function personHasPendingWork(userId: number): boolean {
  return !!personDb().prepare(`SELECT 1 FROM person_executions e WHERE e.owner_user_id=? AND
    (e.state IN ('queued','starting','running','stopping','waiting_person','waiting_user','waiting_approval')
    OR EXISTS(SELECT 1 FROM person_deliveries d WHERE d.execution_id=e.id AND d.state IN ('pending','queued'))) LIMIT 1`).get(userId)
}

export function personHistorySessions(userId: number) {
  return personDb().prepare(`SELECT id FROM sessions WHERE CAST(studio_user_id AS TEXT)=? AND
    (id=? OR id IN (SELECT session_id FROM person_executions WHERE owner_user_id=?)
    OR id IN (SELECT 'person-task-' || id FROM session_tasks WHERE owner_user_id=? AND bot_id=?))`)
    .all(String(userId), personSessionId(userId), userId, userId, `person:${userId}`) as { id: string }[]
}

/** Clear one account atomically. Files, preferences, memories and the usage ledger remain. */
export function clearPersonHistory(userId: number, historyRevision: number) {
  return personTransaction(() => {
    const db = personDb()
    const mainId = personSessionId(userId)
    const main = getSession(mainId)
    if (!ownsPersonSession(userId, main)) throw personError('Session not found', 404)
    if (main!.history_revision !== historyRevision) throw personError('Conversation changed; reload and retry', 409)
    if (personHasPendingWork(userId)) throw personError('Wait for Person tasks and result delivery to finish', 409)
    const rows = personHistorySessions(userId)
    for (const { id } of rows) {
      for (const table of ['messages', TASK_PLANS_TABLE, 'session_tasks', COMPRESSION_SNAPSHOT_TABLE, RUN_USAGE_TABLE,
        SESSION_UPLOADS_TABLE, WORKSPACE_RUN_CHANGE_FILES_TABLE, WORKSPACE_RUN_CHANGES_TABLE,
        'person_context_chunks', 'person_context_summaries', 'person_context_progress']) {
        db.prepare(`DELETE FROM ${table} WHERE session_id=?`).run(id)
      }
      if (id !== mainId) db.prepare('DELETE FROM sessions WHERE id=?').run(id)
    }
    db.prepare('DELETE FROM person_occurrences WHERE schedule_id IN (SELECT id FROM person_schedules WHERE owner_user_id=?)').run(userId)
    for (const table of ['person_task_returns', 'person_deliveries', 'person_interactions', 'person_events', 'person_schedules',
      'person_task_origins', 'person_executions', 'person_operations']) db.prepare(`DELETE FROM ${table} WHERE owner_user_id=?`).run(userId)
    const deleted = db.prepare('DELETE FROM session_tasks WHERE owner_user_id=? AND bot_id=?').run(userId, `person:${userId}`)
    db.prepare(`UPDATE sessions SET history_revision=history_revision+1,history_cleared_at=?,
      task_summary_revision=task_summary_revision+1,task_summary_updated_at=0,
      message_count=0,tool_call_count=0,preview='',last_active=started_at WHERE id=?`).run(Date.now(), mainId)
    return { sessionIds: rows.map(row => row.id), deletedTasks: Number(deleted.changes) }
  })
}
