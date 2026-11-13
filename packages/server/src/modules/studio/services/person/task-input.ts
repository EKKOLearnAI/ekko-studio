import { createHash } from 'node:crypto'
import { personError, personRevision, personText } from '../../contracts/person'
import { getPersonTask, replayPersonOperation } from '../../repositories/person-store'
import { requirePersonSession } from '../../repositories/person-session-store'
import { continuePersonTask, personTaskInput } from './task-chat'

/** Manual task-detail messages append directly. Bot task controls retain their own routing. */
export async function submitPersonTaskInput(userId: number, taskId: string, body: Record<string, unknown>) {
  const input = personTaskInput(body.input)
  const key = personText(body.idempotency_key, 'idempotency_key', 200)
  // Preserve the existing append receipt key so retries across upgrades stay idempotent.
  const dispatchKey = `input:${createHash('sha256').update(key).digest('hex')}`
  const dispatch = { ...body, input, idempotency_key: dispatchKey }
  const task = getPersonTask(userId, taskId)
  requirePersonSession(userId, task.session_id)
  if (replayPersonOperation(userId, `task-chat:${dispatchKey}`, { ...dispatch, task_id: taskId }) === undefined) {
    // Keep the manual endpoint's admission checks, including for linked verifier tasks.
    if (task.revision !== personRevision(body.expected_revision) || (Object.hasOwn(body, 'expected_execution_id') && body.expected_execution_id !== (task.execution_id || null))) throw personError('Task changed; query it again', 409)
    if (task.status === 'closed' || task.redirect_state === 'cancelling' || task.execution_state === 'stopping') throw personError('Task is unavailable; refresh it before sending', 409)
  }
  return continuePersonTask(userId, taskId, dispatch, undefined, input)
}
