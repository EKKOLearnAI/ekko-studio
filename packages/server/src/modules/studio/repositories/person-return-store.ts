import { isPersonSession, ownsPersonSession } from '../contracts/person-session'
import { getSession } from './session-store'
import { personDb, getPersonExecution, getPersonTask } from './person-store'

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
  const result = { taskId: task.id, executionId, assistantMessageId: String(messageId), title: task.title,
    summary: task.summary, agent: JSON.parse(execution.selection_json).runtime as string, state: execution.state }
  db.prepare('INSERT OR IGNORE INTO person_task_returns VALUES (?,?,?,?,?,?)')
    .run(sessionId, result.assistantMessageId, executionId, userId, task.title, execution.state)
  return result
}

export function withPersonTaskReturns<T extends { id?: unknown; role?: unknown; display_role?: unknown }>(sessionId: string, messages: T[]): T[] {
  if (!isPersonSession(sessionId)) return messages
  const session = getSession(sessionId)
  const userId = Number(session?.studio_user_id)
  if (!ownsPersonSession(userId, session)) return messages
  const ids = messages.filter(message => (message.display_role || message.role) === 'assistant').map(message => String(message.id || '')).filter(Boolean)
  if (!ids.length) return messages
  const rows = personDb().prepare(`SELECT r.assistant_message_id AS assistantMessageId, r.execution_id AS executionId,
    e.task_id AS taskId, r.title, r.state, t.summary, json_extract(e.selection_json, '$.runtime') AS agent FROM person_task_returns r
    JOIN person_executions e ON e.id=r.execution_id AND e.owner_user_id=r.owner_user_id
    JOIN session_tasks t ON t.id=e.task_id AND t.owner_user_id=r.owner_user_id
    WHERE r.session_id=? AND r.owner_user_id=? AND r.assistant_message_id IN (${ids.map(() => '?').join(',')})`)
    .all(sessionId, userId, ...ids) as Array<{ assistantMessageId: string }>
  const byMessage = new Map(rows.map(row => [row.assistantMessageId, row]))
  return messages.map(message => byMessage.has(String(message.id)) ? { ...message, person_task_return: byMessage.get(String(message.id)) } : message)
}
