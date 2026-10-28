import { randomUUID } from 'node:crypto'
import { personError, personRevision, personText } from '../../contracts/person'
import type { PersonExecution, PersonTask, PersonTaskOrigin } from '../../contracts/person'
import { personDb, personTransaction, getPersonExecution, replayPersonOperation, adoptPersonGoal, personOperation, getPersonTask, personTaskRunning, createPersonTask, updatePersonTask, enqueuePersonExecution } from '../../repositories/person-store'
import { personRuntime } from '../../public/person-runtime'
import { personUpdated } from '../../repositories/person-updates'
import { logger } from '../../public/logging'
import { personWorkspace } from './workspace'
import { ensureDirectory } from '../workspace/directory'
import { validatePersonSelection } from './catalog'
import { selectPersonExecutionAgent } from './agents'
import { savePersonTaskOrigin } from './delivery'

const running = new Map<string, AbortController>()
const stopping = new Map<string, Promise<void>>()
export function personRunSignal(run: PersonExecution) { const controller = new AbortController(); running.set(run.id, controller); return controller }
export function releasePersonRun(id: string) { running.delete(id) }

/** Called inside the operation transaction, before any native stop side effects. */
function requestStop(userId: number, taskId: string, executionId: string) {
  const run = getPersonExecution(userId, executionId)
  const task = getPersonTask(userId, taskId)
  if (run.task_id !== taskId || task.execution_id !== run.id) throw personError('Execution changed; query the task again', 409)
  if (!['queued','starting','running','waiting_person','waiting_user','waiting_approval','stopping'].includes(run.state)) throw personError('Execution is no longer running', 409)
  if (run.state !== 'stopping') {
    const now = Date.now()
    const db = personDb()
    db.prepare('UPDATE person_executions SET state=?,generation=generation+1,updated_at=? WHERE id=?')
      .run(run.state === 'queued' ? 'interrupted' : 'stopping', now, run.id)
    db.prepare('UPDATE session_tasks SET revision=revision+1,updated_at=? WHERE id=?').run(now, taskId)
    db.prepare("UPDATE person_interactions SET state='expired',revision=revision+1 WHERE execution_id=? AND state='pending'").run(run.id)
    db.prepare("UPDATE person_deliveries SET state='cancelled',updated_at=? WHERE execution_id=? AND state IN ('waiting','pending','queued')").run(now, run.id)
    if (run.occurrence_id) db.prepare('UPDATE person_occurrences SET state=? WHERE id=?').run(run.state === 'queued' ? 'interrupted' : 'stopping', run.occurrence_id)
  }
  return { task: getPersonTask(userId, taskId), execution: getPersonExecution(userId, executionId) }
}

/** A durable stopping intent blocks new work until the native runtime acknowledges it. */
export function acknowledgePersonStop(run: PersonExecution): Promise<void> {
  const pending = stopping.get(run.id)
  if (pending) return pending
  const actual = getPersonExecution(run.owner_user_id, run.id)
  if (actual.state !== 'stopping' || actual.generation !== run.generation) return Promise.resolve()
  const result = Promise.resolve().then(async () => {
    running.get(run.id)?.abort(new Error('Person task stopped'))
    await personRuntime().stop(run.session_id)
    personTransaction(() => {
      const changed = personDb().prepare("UPDATE person_executions SET state='interrupted',lease_until=0,updated_at=? WHERE id=? AND generation=? AND state='stopping'")
        .run(Date.now(), run.id, run.generation)
      if (changed.changes && run.occurrence_id) personDb().prepare("UPDATE person_occurrences SET state='interrupted' WHERE id=?").run(run.occurrence_id)
    })
    personUpdated(run.owner_user_id)
  }).finally(() => stopping.delete(run.id))
  stopping.set(run.id, result)
  return result
}
export interface PersonTaskResult { task: PersonTask; execution?: PersonExecution }
export async function applyPersonTask(userId: number, input: Record<string, unknown>, boundTask?: string, origin?: PersonTaskOrigin): Promise<PersonTaskResult> {
  const action = personText(input.action, 'action', 30)
  if (!['create','adopt','update','start','stop','close','reopen'].includes(action)) throw personError('Unsupported task action')
  const key = personText(input.idempotency_key, 'idempotency_key', 200)
  if (boundTask && (input.task_id !== boundTask || action === 'create' || action === 'adopt')) throw personError('Task is outside this coordinator scope', 403)
  const replay = replayPersonOperation<PersonTaskResult>(userId, `task:${key}`, input)
  if (replay !== undefined) return replay
  const selection = ['create','adopt'].includes(action) ? await selectPersonExecutionAgent(userId, input.agent_id) : null
  if (selection) await validatePersonSelection(userId, selection)
  if (action === 'start') await validatePersonSelection(userId, JSON.parse(getPersonTask(userId, String(input.task_id)).selection_json))
  const taskWorkspace = personWorkspace(userId)
  if (input.workspace && input.workspace !== taskWorkspace) throw personError('Task workspace is managed by Person settings')
  if (['create','adopt'].includes(action)) await ensureDirectory(taskWorkspace)
  const result = personOperation(userId, `task:${key}`, input, () => {
    if (action === 'adopt') {
      const task = adoptPersonGoal(userId, personText(input.task_id,'task_id',100),personRevision(input.expected_revision),selection!,taskWorkspace,personText(input.goal,'goal',8000))
      savePersonTaskOrigin(userId, task.id, origin)
      const execution = input.start === false ? undefined : enqueuePersonExecution(task)
      return { task: getPersonTask(userId, task.id), execution }
    }
    if (action === 'create') {
      const task = createPersonTask(userId, personText(input.title, 'title', 200), personText(input.goal, 'goal', 8000), selection!, taskWorkspace)
      savePersonTaskOrigin(userId, task.id, origin)
      const execution = input.start === false ? undefined : enqueuePersonExecution(task)
      return { task: getPersonTask(userId, task.id), execution }
    }
    const task = getPersonTask(userId, personText(input.task_id, 'task_id', 100))
    if (task.revision !== personRevision(input.expected_revision)) throw personError('Task changed; query it again', 409)
    // Schedules can enqueue a new execution without changing the task revision.
    // Check the observed execution in the same transaction as the mutation.
    if (input.expected_execution_id !== undefined && input.expected_execution_id !== (task.execution_id || null)) throw personError('Execution changed; query the task again', 409)
    if (action === 'stop') return requestStop(userId, task.id, personText(input.execution_id, 'execution_id', 100))
    if (personTaskRunning(task.id)) throw personError('Task is running; wait for it to finish', 409)
    const db = personDb()
    if (action === 'reopen') {
      if (task.status === 'open') throw personError('Task is already open',409)
      db.prepare("UPDATE session_tasks SET status='open',completion_evidence='',completed_at=NULL,revision=revision+1,updated_at=? WHERE id=?").run(Date.now(),task.id)
    } else if (action === 'update') {
      savePersonTaskOrigin(userId, task.id, origin)
      return { task: updatePersonTask(userId, task.id, task.revision, personText(input.goal, 'goal', 8000)) }
    } else if (action === 'start') {
      savePersonTaskOrigin(userId, task.id, origin)
      const execution = enqueuePersonExecution(task)
      db.prepare('UPDATE session_tasks SET revision=revision+1,updated_at=? WHERE id=?').run(Date.now(), task.id)
      return { task: getPersonTask(userId, task.id), execution }
    } else if (action === 'close') {
      if (boundTask) throw personError('Only the user-facing controller can close a goal', 403)
      db.prepare("UPDATE session_tasks SET status='closed',revision=revision+1,updated_at=? WHERE id=?").run(Date.now(),task.id)
      db.prepare("UPDATE person_schedules SET state='cancelled',revision=revision+1 WHERE task_id=? AND state IN ('active','paused')").run(task.id)
    }
    return { task: getPersonTask(userId, task.id) }
  })
  if (action === 'stop' && result.execution?.state === 'stopping') {
    void acknowledgePersonStop(result.execution).catch(error => logger.warn(error, 'Person stop acknowledgement failed; intent retained'))
  }
  return result
}
export function personOperationKey() { return randomUUID() }
