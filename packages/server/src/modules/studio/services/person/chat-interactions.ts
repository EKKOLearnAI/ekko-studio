import { personDb } from '../../repositories/person-store'
import type { PersonInteraction } from '../../contracts/person'
import { replyPersonQuestion } from './runner'

/** A task coordinator's questions stay private until it actually needs the human. */
export function personChatInteraction(userId: number, sessionId: string): { event: string; data: { event: string; session_id: string; approval_id?: string; clarify_id?: string; command?: string; description?: string; allow_permanent?: boolean; question?: string; choices: string[]; requested_at: number; durable: boolean } } | undefined {
  const question = personDb().prepare(`SELECT i.* FROM person_interactions i
    JOIN person_executions e ON e.id=i.execution_id JOIN session_tasks t ON t.id=i.task_id
    WHERE i.owner_user_id=? AND t.session_id=? AND i.state='pending' AND
      e.state IN ('waiting_user','waiting_approval')
    ORDER BY i.created_at LIMIT 1`).get(userId, sessionId) as PersonInteraction | undefined
  if (!question) return undefined
  const approval = question.kind === 'approval'
  const id = `person-interaction:${question.id}:${question.revision}`
  const event = approval ? 'approval.requested' : 'clarify.requested'
  return { event, data: { event, session_id: sessionId,
    ...(approval ? { approval_id: id, command: question.question, description: question.question, allow_permanent: false } : { clarify_id: id, question: question.question }),
    durable: true, choices: JSON.parse(question.choices_json), requested_at: question.created_at,
    // Durable task questions have no artificial UI countdown; execution expiry is authoritative.
  } }
}
export async function answerPersonChatInteraction(userId: number, id: string, response: string, approval: boolean, sessionId: string) {
  const match = /^person-interaction:([^:]+):(\d+)$/.exec(id)
  if (!match) return false
  const current = personChatInteraction(userId, sessionId)
  if (!current || (approval ? current.data.approval_id : current.data.clarify_id) !== id) throw new Error('Question expired or changed')
  await replyPersonQuestion(userId, match[1], Number(match[2]), response)
  return true
}

export async function answerPersonTaskInteraction(userId: number, sessionId: string, nativeId: string, response: string, approval: boolean) {
  const question = personDb().prepare(`SELECT i.* FROM person_interactions i JOIN person_executions e ON e.id=i.execution_id
    WHERE i.owner_user_id=? AND e.session_id=? AND i.native_id=? AND i.kind=? AND i.state='pending'
      AND e.state IN ('waiting_user','waiting_approval')`).get(userId, sessionId, nativeId, approval ? 'approval' : 'question') as PersonInteraction | undefined
  if (!question) throw new Error('Question expired or is being handled by Person')
  await replyPersonQuestion(userId, question.id, question.revision, response)
}
