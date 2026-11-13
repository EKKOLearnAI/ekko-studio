import { isPersonSession, ownsPersonSession } from '../contracts/person-session'
import { getSession } from './session-store'
import { personDb, getPersonExecution, getPersonTask } from './person-store'

interface TaskReturn {
  taskId: string; executionId: string; assistantMessageId: string; title: string
  summary: string; agent: string; state: 'finished' | 'failed'; relatedTasks?: TaskReturn[]
}

/** The optional development link is captured at callback completion, never inferred from a later verdict. */
function readTaskReturns(userId: number, sessionId: string, ids: string[]): TaskReturn[] {
  const rows = personDb().prepare(`SELECT r.assistant_message_id AS assistantMessageId, r.execution_id AS executionId,
    e.task_id AS taskId, r.title, r.state, t.summary, json_extract(e.selection_json, '$.runtime') AS agent,
    CASE WHEN dt.id IS NOT NULL THEN json_object('taskId',dt.id,'executionId',de.id,
      'assistantMessageId',r.assistant_message_id,'title',dt.title,'summary',dt.summary,
      'agent',json_extract(de.selection_json,'$.runtime'),'state',de.state) END AS development
    FROM person_task_returns r
    JOIN person_executions e ON e.id=r.execution_id AND e.owner_user_id=r.owner_user_id
    JOIN session_tasks t ON t.id=e.task_id AND t.owner_user_id=r.owner_user_id
    LEFT JOIN person_executions de ON de.id=r.development_execution_id AND de.owner_user_id=r.owner_user_id
    LEFT JOIN session_tasks dt ON dt.id=de.task_id AND dt.owner_user_id=r.owner_user_id AND dt.session_id=r.session_id
    WHERE r.session_id=? AND r.owner_user_id=? AND r.assistant_message_id IN (${ids.map(() => '?').join(',')})`)
    .all(sessionId, userId, ...ids) as unknown as Array<TaskReturn & { development: string | null }>
  return rows.map(({ development, ...receipt }) => development ? { ...JSON.parse(development) as TaskReturn, relatedTasks: [receipt] } : receipt)
}

/** Bind a return receipt to its persisted reply, never to the latest conversation turn. */
export function savePersonTaskReturn(userId: number, executionId: string, sessionId: string, messageId: unknown) {
  if (!ownsPersonSession(userId, getSession(sessionId)) || !messageId) return undefined
  const db = personDb()
  const message = db.prepare("SELECT id FROM messages WHERE session_id=? AND id=? AND role='assistant'").get(sessionId, String(messageId))
  if (!message) return undefined
  const execution = getPersonExecution(userId, executionId)
  if (execution.state !== 'finished' && execution.state !== 'failed') return undefined
  const task = getPersonTask(userId, execution.task_id)
  if (execution.requirements_revision !== task.requirements_revision) return undefined
  const delivery = db.prepare('SELECT origin_json,state FROM person_deliveries WHERE execution_id=? AND owner_user_id=?').get(executionId, userId)
  if (delivery?.state === 'cancelled') return undefined
  if (task.session_id !== sessionId && (!delivery || JSON.parse(String(delivery.origin_json)).sessionId !== sessionId)) return undefined
  // A same-Bot acceptance pass settles both tasks in this one reply. Keep the exact
  // accepted development execution alongside the verifier, without another model turn.
  const development = db.prepare(`SELECT e.id FROM person_acceptance_attempts v
    JOIN person_acceptance_passes a ON a.execution_id=v.execution_id
    JOIN person_executions e ON e.id=a.execution_id AND e.owner_user_id=? AND e.state='finished'
    JOIN session_tasks t ON t.id=e.task_id AND t.owner_user_id=e.owner_user_id AND t.session_id=?
    WHERE v.verification_execution_id=? AND v.state='passed'`).get(userId, sessionId, executionId)
  db.prepare(`INSERT OR IGNORE INTO person_task_returns
    (session_id,assistant_message_id,execution_id,owner_user_id,title,state,development_execution_id) VALUES (?,?,?,?,?,?,?)`)
    .run(sessionId, String(messageId), executionId, userId, task.title, execution.state, development?.id ?? null)
  return readTaskReturns(userId, sessionId, [String(messageId)])[0]
}

export function withPersonTaskReturns<T extends { id?: unknown; role?: unknown; display_role?: unknown }>(sessionId: string, messages: T[]): Array<T & { person_task_return?: TaskReturn }> {
  if (!isPersonSession(sessionId)) return messages
  const session = getSession(sessionId)
  const userId = Number(session?.studio_user_id)
  if (!ownsPersonSession(userId, session)) return messages
  const ids = messages.filter(message => (message.display_role || message.role) === 'assistant').map(message => String(message.id || '')).filter(Boolean)
  if (!ids.length) return messages
  const rows = readTaskReturns(userId, sessionId, ids)
  const byMessage = new Map(rows.map(row => [row.assistantMessageId, row]))
  return messages.map(message => byMessage.has(String(message.id)) ? { ...message, person_task_return: byMessage.get(String(message.id)) } : message)
}
