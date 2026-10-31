import { personError } from '../contracts/person'
import { ownsPersonSession } from '../contracts/person-session'
import { COMPRESSION_SNAPSHOT_TABLE, TASK_PLANS_TABLE, RUN_USAGE_TABLE, SESSION_UPLOADS_TABLE,
  WORKSPACE_RUN_CHANGES_TABLE, WORKSPACE_RUN_CHANGE_FILES_TABLE } from '../infrastructure/database/schemas'
import { personDb, personTransaction } from './person-store'
import { getSession } from './session-store'
import { PERSON_STAGE_PENDING_WORK_SQL } from './person-stage-store'

export function personHasPendingWork(userId: number, sessionId = ''): boolean {
  if (personDb().prepare(`SELECT 1 FROM person_flows f JOIN person_stages member ON member.flow_id=f.id
    WHERE f.owner_user_id=? AND f.state IN ('active','failed') AND (?='' OR member.session_id=? OR f.creator_session_id=?)
    AND (f.state='active' OR EXISTS(SELECT 1 FROM person_stages s WHERE s.flow_id=f.id AND s.group_position=f.current_position
      AND (?='' OR s.session_id=? OR (member.session_id=? AND member.group_position<f.current_position AND member.result_message_id IS NOT NULL))
      AND ${PERSON_STAGE_PENDING_WORK_SQL})) LIMIT 1`)
    .get(userId,sessionId,sessionId,sessionId,sessionId,sessionId,sessionId)) return true
  return !!personDb().prepare(`SELECT 1 FROM person_executions e JOIN session_tasks t ON t.id=e.task_id WHERE e.owner_user_id=? AND (?='' OR t.session_id=?) AND
    (e.state IN ('pending','queued','starting','running','stopping','waiting_person','waiting_user','waiting_approval')
    OR EXISTS(SELECT 1 FROM person_deliveries d WHERE d.execution_id=e.id AND d.state IN ('pending','queued'))) LIMIT 1`).get(userId, sessionId, sessionId)
}

export function personHistorySessions(userId: number, sessionId: string) {
  return personDb().prepare(`SELECT id FROM sessions WHERE CAST(studio_user_id AS TEXT)=? AND
    (id=? OR id IN (SELECT e.session_id FROM person_executions e JOIN session_tasks t ON t.id=e.task_id WHERE t.owner_user_id=? AND t.session_id=?))`)
    .all(String(userId), sessionId, userId, sessionId) as { id: string }[]
}

/** Remove one conversation's task graph atomically; account resources and other conversations remain. */
export function clearPersonHistory(userId: number, mainId: string, historyRevision: number, remove = false) {
  return personTransaction(() => {
    const db = personDb()
    const main = getSession(mainId)
    if (!ownsPersonSession(userId, main)) throw personError('Session not found', 404)
    if (main!.history_revision !== historyRevision) throw personError('Conversation changed; reload and retry', 409)
    if (personHasPendingWork(userId, mainId)) throw personError('Wait for Person tasks and result delivery to finish', 409)
    const rows = personHistorySessions(userId, mainId)
    db.prepare('DELETE FROM person_occurrences WHERE schedule_id IN (SELECT id FROM person_schedules WHERE owner_user_id=? AND session_id=?)').run(userId, mainId)
    db.prepare('DELETE FROM person_schedules WHERE owner_user_id=? AND session_id=?').run(userId, mainId)
    const tasks = db.prepare('SELECT id FROM session_tasks WHERE owner_user_id=? AND session_id=?').all(userId, mainId)
    for (const task of tasks) {
      db.prepare('DELETE FROM person_occurrences WHERE schedule_id IN (SELECT id FROM person_schedules WHERE task_id=?)').run(task.id)
      for (const table of ['person_task_returns', 'person_deliveries', 'person_events'])
        db.prepare(`DELETE FROM ${table} WHERE execution_id IN (SELECT id FROM person_executions WHERE task_id=?)`).run(task.id)
      db.prepare("DELETE FROM person_operations WHERE owner_user_id=? AND (json_extract(result_json,'$.task.id')=? OR json_extract(result_json,'$.task_id')=?)").run(userId, task.id, task.id)
      for (const table of ['person_interactions', 'person_schedules', 'person_task_origins', 'person_executions', 'person_stage_tasks'])
        db.prepare(`DELETE FROM ${table} WHERE task_id=?`).run(task.id)
    }
    for (const { id } of rows) {
      for (const table of ['messages', TASK_PLANS_TABLE, 'session_tasks', COMPRESSION_SNAPSHOT_TABLE, RUN_USAGE_TABLE,
        SESSION_UPLOADS_TABLE, WORKSPACE_RUN_CHANGE_FILES_TABLE, WORKSPACE_RUN_CHANGES_TABLE,
        'person_context_chunks', 'person_context_summaries', 'person_context_progress']) {
        db.prepare(`DELETE FROM ${table} WHERE session_id=?`).run(id)
      }
      if (remove || id !== mainId) {
        db.prepare('DELETE FROM person_conversation_settings WHERE session_id=?').run(id)
        db.prepare('DELETE FROM sessions WHERE id=?').run(id)
      }
    }
    if (!remove) db.prepare(`UPDATE sessions SET history_revision=history_revision+1,history_cleared_at=?,
      task_summary_revision=task_summary_revision+1,task_summary_updated_at=0,
      message_count=0,tool_call_count=0,preview='',last_active=started_at WHERE id=?`).run(Date.now(), mainId)
    return { sessionIds: rows.map(row => row.id), deletedTasks: tasks.length }
  })
}
