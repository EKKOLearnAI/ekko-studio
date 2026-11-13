import type { AgentRuntimeRunInput } from '../../../../../../ekko-agent/src/runtime/types'
import type { PersonTaskMemoryRequest, PersonTaskOrigin } from '../../contracts/person'
import { getPersonExecution, getPersonTask, personDb } from '../../repositories/person-store'
import { requirePersonSession } from '../../repositories/person-session-store'

/** The boundary is captured before transport persists this turn's real user message. */
export function capturePersonMemoryRequest(userId: number, sessionId: string, afterId: number): PersonTaskMemoryRequest | undefined {
  const session = requirePersonSession(userId, sessionId)
  const row = personDb().prepare("SELECT id,content FROM messages WHERE session_id=? AND role='user' AND id>? ORDER BY id DESC LIMIT 1")
    .get(sessionId, afterId)
  if (!row || !String(row.content).trim()) return undefined
  return { sessionId, messageId: Number(row.id), historyRevision: session.history_revision || 0, content: String(row.content) }
}

/** Re-read persisted authority on every use; queue data and worker output cannot grant it. */
export function personReturnMemoryInput(userId: number, sessionId: string, executionId: string): AgentRuntimeRunInput['memoryInput'] {
  const db = personDb()
  const delivery = db.prepare("SELECT origin_json FROM person_deliveries WHERE execution_id=? AND owner_user_id=? AND state IN ('pending','queued')")
    .get(executionId, userId)
  if (!delivery) return undefined
  const origin = JSON.parse(String(delivery.origin_json)) as PersonTaskOrigin
  const request = origin.memoryRequest
  if (!request || request.sessionId !== sessionId || origin.sessionId !== sessionId) return undefined
  const session = requirePersonSession(userId, sessionId)
  const run = getPersonExecution(userId, executionId), task = getPersonTask(userId, run.task_id)
  if (run.state !== 'finished' || run.occurrence_id || task.session_id !== sessionId || task.status === 'closed'
    || task.execution_id !== executionId || task.requirements_revision !== run.requirements_revision
    || session.history_revision !== request.historyRevision) return undefined
  const source = db.prepare("SELECT content FROM messages WHERE id=? AND session_id=? AND role='user'").get(request.messageId, sessionId)
  if (!source || source.content !== request.content) return undefined
  return { messages: [
    { role: 'user', content: request.content, metadata: {
      // Keep execution data separate from user-authored text, including in write review.
      authorizedContext: { kind: 'task_result', taskId: task.id, executionId, content: run.output.slice(0, 12000) },
    } },
    { role: 'assistant', content: run.output.slice(0, 12000) },
  ] }
}
