import { getSessionTasks as readSessionTasks } from '../repositories/session-task-store'
import { commitSessionTasks, commitSessionTaskStatus, getSessionTasksState } from '../repositories/session-task-store'
import type { SessionTasksUpdate } from '../contracts/session-task'
import { publishSessionTaskEvents } from './webhooks'
export { listSessionTaskItems } from '../repositories/session-task-store'

export class SessionTasksError extends Error {
  constructor(message: string, public readonly status = 400) { super(message) }
}

export function getSessionTasks(sessionId: string) {
  return readSessionTasks(sessionId)
}

export function parseSessionTasksUpdate(input: Record<string, unknown>): SessionTasksUpdate {
  if (Object.keys(input).some(key => !['revision', 'changes', 'context_id'].includes(key))) {
    throw new SessionTasksError('Only revision and changes are accepted; session scope is supplied by the host')
  }
  if (!Number.isSafeInteger(input.revision) || (input.revision as number) < 0) throw new SessionTasksError('revision must be a non-negative integer from list_session_tasks')
  if (!Array.isArray(input.changes) || !input.changes.length || input.changes.length > 30) throw new SessionTasksError('changes must contain 1 to 30 goals')
  const changes = input.changes.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => !['id', 'title', 'summary', 'status', 'completion_evidence'].includes(key))) throw new SessionTasksError('Invalid session goal')
    const { id, title, summary, status, completion_evidence } = value
    if (id !== undefined && (typeof id !== 'string' || !id.trim() || id.length > 100)) throw new SessionTasksError('Invalid session goal id')
    if (typeof title !== 'string' || !title.trim() || title.length > 200) throw new SessionTasksError('Goal title must contain 1 to 200 characters')
    if (typeof summary !== 'string' || !summary.trim() || summary.length > 1000) throw new SessionTasksError('Goal summary must contain 1 to 1000 characters')
    if (status !== 'open' && status !== 'completed') throw new SessionTasksError('Goal status must be open or completed')
    if (completion_evidence !== undefined && (typeof completion_evidence !== 'string' || completion_evidence.length > 1000)) throw new SessionTasksError('Invalid completion_evidence')
    return { ...(id !== undefined ? { id: id.trim() } : {}), title: title.trim(), summary: summary.trim(), status,
      ...(completion_evidence !== undefined ? { completion_evidence: completion_evidence.trim() } : {}) }
  })
  return { revision: input.revision as number, changes }
}

export function updateSessionTasks(sessionId: string, profile: string, input: Record<string, unknown>, historyRevision?: number) {
  const update = parseSessionTasksUpdate(input)
  const state = getSessionTasksState(sessionId)
  if (!state || state.profile !== profile || ['group_chat', 'workflow', 'global_agent'].includes(state.source)) {
    throw new SessionTasksError('The current session goal ledger is unavailable', 409)
  }
  if (state.revision !== update.revision || (historyRevision !== undefined && state.history_revision !== historyRevision)) {
    throw new SessionTasksError('Session goals or history changed; read list_session_tasks again before updating', 409)
  }
  try {
    const previous = readSessionTasks(sessionId).tasks
    const snapshot = commitSessionTasks(state, update.changes)
    if (!snapshot) throw new SessionTasksError('Session goals changed; read list_session_tasks again before updating', 409)
    publishSessionTaskEvents({ profile: state.profile, source: state.source, previous, snapshot })
    return snapshot
  } catch (error) {
    if (error instanceof SessionTasksError) throw error
    throw new SessionTasksError(error instanceof Error ? error.message : String(error))
  }
}

/** Account-authorized task-list actions are separate from the model's turn tools. */
export function setSessionTaskStatus(sessionId: string, profile: string, taskId: string, input: Record<string, unknown>) {
  const { status, expected_updated_at: expectedUpdatedAt } = input
  if (Object.keys(input).some(key => !['status', 'expected_updated_at'].includes(key))
    || (status !== 'open' && status !== 'completed' && status !== 'closed')
    || !Number.isSafeInteger(expectedUpdatedAt) || (expectedUpdatedAt as number) < 0) {
    throw new SessionTasksError('A valid status and expected_updated_at from the task list are required')
  }
  const state = getSessionTasksState(sessionId)
  if (!state || state.profile !== profile || !['api_server', 'cli', 'desktop', 'builtin_agent', 'coding_agent'].includes(state.source)) {
    throw new SessionTasksError('The current session goal ledger is unavailable', 409)
  }
  const previous = readSessionTasks(sessionId).tasks
  if (!previous.some(task => task.id === taskId)) throw new SessionTasksError('Session task not found', 404)
  const snapshot = commitSessionTaskStatus(state, taskId, status, expectedUpdatedAt as number)
  if (!snapshot) throw new SessionTasksError('Session task changed; refresh the task list before retrying', 409)
  publishSessionTaskEvents({ profile: state.profile, source: state.source, previous, snapshot })
  return snapshot
}
