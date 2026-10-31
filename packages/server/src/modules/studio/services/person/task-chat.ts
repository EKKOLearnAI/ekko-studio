import { personError, personRevision, personText } from '../../contracts/person'
import type { ContentBlock } from '../../contracts/runs/session'
import type { PersonExecution, PersonTask, PersonTaskOrigin } from '../../contracts/person'
import { getPersonTask, getPersonExecution, taskPersonConversations, personDb, personOperation, enqueuePersonExecution, replayPersonOperation, pendingPersonInputs } from '../../repositories/person-store'
import { getSession } from '../../repositories/session-store'
import { personUpdated } from '../../repositories/person-updates'
import { personUser, validatePersonSelection } from './catalog'
import { savePersonTaskOrigin } from './delivery'
import { requirePersonSession } from '../../repositories/person-session-store'
import { personRequirements } from '../../contracts/person-flow'
import { assertPersonTaskActor } from './task-flow'
import { assertPersonStage, assertPersonStageTask } from '../../repositories/person-stage-store'
import { personTaskQueue } from './task-queue'

/** Hidden task conversations are account-owned, never shared by Profile. */
export function ownedPersonTaskSession(userId: number | undefined, sessionId: string) {
  if (userId === undefined || !sessionId.startsWith('person-task-')) throw personError('Session not found', 404)
  const execution = personDb().prepare('SELECT task_id FROM person_executions WHERE owner_user_id=? AND session_id=? LIMIT 1').get(userId, sessionId)
  if (!execution) throw personError('Session not found', 404)
  const task = getPersonTask(userId, String(execution.task_id))
  const user = personUser(userId)
  const session = getSession(sessionId)
  if (!session || String(session.studio_user_id) !== String(userId)) throw personError('Session not found', 404)
  if (user.role !== 'super_admin' && !user.profiles.includes(session.profile || 'default')) throw personError('Resource permission revoked', 403)
  return { task, session }
}

export async function personTaskChat(userId: number, taskId: string, executionId = '') {
  const task = getPersonTask(userId, taskId)
  const selection = JSON.parse(task.selection_json)
  const user = personUser(userId)
  if (user.role !== 'super_admin' && !user.profiles.includes(selection.profile || 'default')) throw personError('Resource permission revoked', 403)
  const selectedId = executionId || task.execution_id
  const read = (id: string) => personDb().prepare('SELECT id,session_id,state,created_at,occurrence_id FROM person_executions WHERE owner_user_id=? AND task_id=? AND id=?')
    .get(userId,taskId,id) as unknown as Pick<PersonExecution,'id'|'session_id'|'state'|'created_at'|'occurrence_id'> | undefined
  const execution = selectedId ? read(selectedId) : null
  if (selectedId && !execution) throw personError('Execution not found', 404)
  const session = execution ? ownedPersonTaskSession(userId, execution.session_id).session : null
  const executions = taskPersonConversations(userId, taskId)
  // Queued follow-ups can be newer than the active turn in the same conversation.
  const current = task.execution_id ? read(task.execution_id) : undefined
  if (current && !executions.some(run => run.id === current.id)) executions.unshift(current)
  // Include a selected older conversation even when it falls outside the recent page.
  if (execution && !executions.some(run => run.session_id === execution.session_id)) executions.push(execution)
  return { task: { ...task, running: !!task.running }, session, execution: execution || null, executions, pending: pendingPersonInputs(userId, taskId, session?.id), ...personTaskQueue(userId, taskId, session?.id || '') }
}

function chatInput(value: unknown): ContentBlock[] {
  if (!Array.isArray(value) || !value.length || value.length > 50 || JSON.stringify(value).length > 100_000) throw personError('Invalid input')
  return value.map(block => {
    if (!block || typeof block !== 'object') throw personError('Invalid input block')
    if (block.type === 'text') return { type: 'text', text: personText(block.text, 'text', 32000) }
    if (block.type !== 'file' && block.type !== 'image') throw personError('Invalid input block')
    return { type: block.type, name: personText(block.name, 'name', 1000), path: personText(block.path, 'path', 4000),
      ...(block.type === 'image' || block.media_type ? { media_type: personText(block.media_type, 'media_type', 200) } : {}),
      ...(block.context ? { context: personText(block.context, 'context', 32000) } : {}), ...(block.video_frame === true ? { video_frame: true } : {}) } as ContentBlock
  })
}

/** New turns still use the durable background runner and its original Person callback. */
export async function continuePersonTask(userId: number, taskId: string, body: Record<string, unknown>, origin?: PersonTaskOrigin) {
  const request = { ...body, task_id: taskId }
  const key = `task-chat:${personText(body.idempotency_key, 'idempotency_key', 200)}`
  const task = getPersonTask(userId, taskId)
  await validatePersonSelection(userId, JSON.parse(task.selection_json))
  const replay = replayPersonOperation<{ task: PersonTask; execution: PersonExecution; pending: ReturnType<typeof pendingPersonInputs> }>(userId, key, request)
  if (replay !== undefined) return replay
  const input = chatInput(body.input)
  const result = personOperation(userId, key, request, () => {
    const stage = assertPersonStageTask(userId,taskId)
    if (origin?.stage) {
      assertPersonStage(userId,origin.stage,origin.sessionId)
      if (stage?.stageId !== origin.stage.stageId) throw personError('This stage may only continue its own subtasks',403)
    }
    const current = getPersonTask(userId, taskId)
    const requirements = personRequirements(current)
    if (requirements.flow) {
      assertPersonTaskActor(current, origin)
      if (requirements.flow.stopped) throw personError('Flow is stopped; its creator must reopen it', 409)
      requirements.flow.completed = false
    }
    requirePersonSession(userId, current.session_id)
    if (current.revision !== personRevision(body.expected_revision)) throw personError('Task changed; query it again', 409)
    if (current.execution_state === 'stopping') throw personError('Task is stopping; wait for acknowledgement', 409)
    if (Object.hasOwn(body, 'expected_execution_id') && body.expected_execution_id !== (current.execution_id || null)) throw personError('Execution changed; query the task again', 409)
    if (current.status === 'closed') throw personError('Reopen the task before continuing', 409)
    if (requirements.flow) personDb().prepare('UPDATE session_tasks SET requirements_json=? WHERE id=?').run(JSON.stringify(requirements), taskId)
    personDb().prepare("UPDATE session_tasks SET status='open',completion_evidence='',completed_at=NULL,revision=revision+1,updated_at=? WHERE id=?")
      .run(Date.now(), taskId)
    savePersonTaskOrigin(userId, taskId, origin)
    const next = getPersonTask(userId, taskId)
    const target = body.execution_id ? getPersonExecution(userId, personText(body.execution_id, 'execution_id', 100)) : undefined
    if (target && target.task_id !== taskId) throw personError('Execution not found', 404)
    const execution = enqueuePersonExecution(next, null, input, true, target?.session_id)
    return { task: { ...getPersonTask(userId, taskId), running: true }, execution, pending: pendingPersonInputs(userId, taskId, execution.session_id) }
  })
  personUpdated(userId)
  return result
}
