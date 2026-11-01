import { randomUUID } from 'node:crypto'
import { personError, personRevision, personText } from '../../contracts/person'
import type { PersonExecution, PersonTask, PersonTaskOrigin } from '../../contracts/person'
import { personDb, personTransaction, getPersonExecution, replayPersonOperation, adoptPersonGoal, personOperation, getPersonTask, personTaskRunning, createPersonTask, updatePersonTask, enqueuePersonExecution } from '../../repositories/person-store'
import { personRuntime } from '../../public/person-runtime'
import { personUpdated } from '../../repositories/person-updates'
import { logger } from '../../public/logging'
import { personTurnWorkspace } from './workspace'
import { validatePersonSelection } from './catalog'
import { selectPersonExecutionAgent } from './agents'
import { savePersonTaskOrigin } from './delivery'
import { requirePersonSession } from '../../repositories/person-session-store'
import { personRequirements } from '../../contracts/person-flow'
import { advancePersonFlow, assertPersonTaskActor, plannedPersonFlow, stopPersonFlow } from './task-flow'
import { assertPersonStage, assertPersonStageTask, linkPersonStageTask, personTaskStage } from '../../repositories/person-stage-store'

const running = new Map<string, AbortController>()
const stopping = new Map<string, Promise<void>>()
export function personRunSignal(run: PersonExecution) { const controller = new AbortController(); running.set(run.id, controller); return controller }
export function releasePersonRun(id: string) { running.delete(id) }

/** Called inside the operation transaction, before any native stop side effects. */
function requestStop(userId: number, taskId: string, executionId: string) {
  const run = getPersonExecution(userId, executionId)
  const task = getPersonTask(userId, taskId)
  if (run.task_id !== taskId || task.execution_id !== run.id) throw personError('Execution changed; query the task again', 409)
  if (!['pending','queued','starting','running','waiting_person','waiting_user','waiting_approval','stopping'].includes(run.state)) throw personError('Execution is no longer running', 409)
  if (run.state !== 'stopping') {
    const now = Date.now()
    const db = personDb()
    db.prepare('UPDATE person_executions SET state=?,generation=generation+1,updated_at=? WHERE id=?')
      .run(['pending','queued'].includes(run.state) ? 'interrupted' : 'stopping', now, run.id)
    db.prepare("UPDATE person_deliveries SET state='cancelled',updated_at=? WHERE execution_id IN (SELECT id FROM person_executions WHERE task_id=? AND state='pending')").run(now, taskId)
    db.prepare("UPDATE person_executions SET state='interrupted',generation=generation+1,updated_at=? WHERE task_id=? AND state='pending'").run(now, taskId)
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
  if (!['create','adopt','update','start','stop','close','reopen','advance'].includes(action)) throw personError('Unsupported task action')
  if (Object.hasOwn(input, 'creator_session_id')) throw personError('Creator is assigned by the host')
  if (!['create','adopt'].includes(action) && (Object.hasOwn(input, 'next_steps') || Object.hasOwn(input, 'return_expectation'))) throw personError('Flow is fixed at creation')
  if (action === 'advance' && ['session_id','goal','agent_id','start'].some(key => Object.hasOwn(input, key))) throw personError('Advance uses the saved next step')
  const key = personText(input.idempotency_key, 'idempotency_key', 200)
  if (boundTask && (input.task_id !== boundTask || action === 'create' || action === 'adopt')) throw personError('Task is outside this coordinator scope', 403)
  const targetSession = ['create', 'adopt'].includes(action) ? String(input.session_id || origin?.sessionId || '') : getPersonTask(userId, String(input.task_id)).session_id
  if (action !== 'stop') requirePersonSession(userId, targetSession)
  if (origin && ['create','adopt'].includes(action) && targetSession !== origin.sessionId) {
    throw Object.assign(personError('Background work must belong to the current role. Use bot_flow_create to hand off to another conversation.',403), { code:'ROLE_HANDOFF_REQUIRED' })
  }
  const operationInput = ['create', 'adopt'].includes(action) ? { ...input, session_id: targetSession } : input
  const replay = replayPersonOperation<PersonTaskResult>(userId, `task:${key}`, operationInput)
  if (replay !== undefined) return replay
  const selection = ['create','adopt'].includes(action) ? await selectPersonExecutionAgent(userId, input.agent_id) : null
  if (selection) await validatePersonSelection(userId, selection)
  if (action === 'start') await validatePersonSelection(userId, JSON.parse(getPersonTask(userId, String(input.task_id)).selection_json))
  if (action === 'advance') {
    const task = getPersonTask(userId, String(input.task_id)), flow = personRequirements(task).flow
    if (flow?.steps[flow.index]) await validatePersonSelection(userId, JSON.parse(task.selection_json))
  }
  const taskWorkspace = ['create','adopt'].includes(action) ? personTurnWorkspace(userId, targetSession, origin) : getPersonTask(userId, String(input.task_id)).workspace
  if (input.workspace && input.workspace !== taskWorkspace) throw personError('Task workspace is managed by Person settings')
  const result = personOperation(userId, `task:${key}`, operationInput, () => {
    if (origin?.stage) {
      const { stage } = assertPersonStage(userId,origin.stage,origin.sessionId)
      if (targetSession !== stage.session_id || ['adopt','advance'].includes(action)) throw personError('Stage workers must belong to the receiving role',403)
      if (stage.completion_run_id) throw personError('Finish the prepared stage reply first',409)
    }
    if (!['create','adopt','stop'].includes(action)) assertPersonStageTask(userId,String(input.task_id))
    if (action !== 'stop') requirePersonSession(userId, targetSession)
    const plan = ['create','adopt'].includes(action) ? plannedPersonFlow(userId, input) : undefined
    if (action === 'adopt') {
      const task = adoptPersonGoal(userId, personText(input.task_id,'task_id',100),personRevision(input.expected_revision),selection!,taskWorkspace,personText(input.goal,'goal',8000),targetSession)
      personDb().prepare('UPDATE session_tasks SET requirements_json=? WHERE id=?').run(JSON.stringify({ ...personRequirements(task), ...plan,
        creator_session_id: requirePersonSession(userId, origin?.sessionId || targetSession).id }), task.id)
      savePersonTaskOrigin(userId, task.id, origin)
      const execution = input.start === false ? undefined : enqueuePersonExecution(getPersonTask(userId, task.id))
      return { task: getPersonTask(userId, task.id), execution }
    }
    if (action === 'create') {
      const task = createPersonTask(userId, personText(input.title, 'title', 200), personText(input.goal, 'goal', 8000), selection!, taskWorkspace, targetSession)
      if (origin?.stage) {
        if (input.next_steps !== undefined || input.return_expectation !== undefined) throw personError('Use the current stage; nested worker flows are unavailable')
        linkPersonStageTask(userId,task.id,origin.stage,targetSession)
      }
      personDb().prepare('UPDATE session_tasks SET requirements_json=? WHERE id=?').run(JSON.stringify({ ...personRequirements(task), ...plan,
        creator_session_id: requirePersonSession(userId, origin?.sessionId || targetSession).id }), task.id)
      savePersonTaskOrigin(userId, task.id, origin)
      const execution = input.start === false ? undefined : enqueuePersonExecution(getPersonTask(userId, task.id))
      return { task: getPersonTask(userId, task.id), execution }
    }
    const task = getPersonTask(userId, personText(input.task_id, 'task_id', 100))
    if (task.revision !== personRevision(input.expected_revision)) throw personError('Task changed; query it again', 409)
    // Schedules can enqueue a new execution without changing the task revision.
    // Check the observed execution in the same transaction as the mutation.
    if (input.expected_execution_id !== undefined && input.expected_execution_id !== (task.execution_id || null)) throw personError('Execution changed; query the task again', 409)
    const requirements = personRequirements(task)
    if (requirements.flow) {
      assertPersonTaskActor(task, origin, ['stop','reopen'].includes(action))
      if (action === 'stop') {
        stopPersonFlow(task, origin)
        const active = personDb().prepare("SELECT id FROM person_executions WHERE task_id=? AND id=? AND state IN ('pending','queued','starting','running','stopping','waiting_person','waiting_user','waiting_approval')").get(task.id, task.execution_id || '')
        return active ? requestStop(userId, task.id, String(active.id)) : { task: getPersonTask(userId, task.id) }
      }
      if (requirements.flow.stopped && action !== 'reopen') throw personError('Flow is stopped; its creator must reopen it', 409)
    }
    if (action === 'advance') return advancePersonFlow(task, input.message, origin)
    if (action === 'stop') return requestStop(userId, task.id, personText(input.execution_id, 'execution_id', 100))
    const closingReturnedStageChild = action === 'close' && personTaskStage(userId,task.id)
      && ['finished','failed','interrupted'].includes(task.execution_state || '') && !task.pending_count
      && !personDb().prepare("SELECT 1 FROM person_executions WHERE task_id=? AND state IN ('pending','queued','starting','running','stopping','waiting_person','waiting_user','waiting_approval')").get(task.id)
    if (personTaskRunning(task.id) && !closingReturnedStageChild) throw personError('Task is running; wait for it to finish', 409)
    const db = personDb()
    if (action === 'reopen') {
      if (requirements.flow?.stopped) {
        if (origin && origin.sessionId !== requirements.creator_session_id) throw personError('Only the creator can resume a stopped flow', 403)
      } else if (task.status === 'open') throw personError('Task is already open',409)
      if (requirements.flow) {
        requirements.flow.stopped = false
        requirements.flow.completed = false
        db.prepare('UPDATE session_tasks SET requirements_json=? WHERE id=?').run(JSON.stringify(requirements), task.id)
      }
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

/** Deletion cancels every occurrence and follow-up, and waits for native exit before removing records. */
export async function stopPersonSessionTasks(userId: number, sessionId: string) {
  const runs = personTransaction(() => {
    personDb().prepare("UPDATE person_schedules SET state='cancelled',revision=revision+1 WHERE task_id IN (SELECT id FROM session_tasks WHERE owner_user_id=? AND session_id=?)").run(userId, sessionId)
    personDb().prepare("UPDATE person_deliveries SET state='cancelled' WHERE execution_id IN (SELECT e.id FROM person_executions e JOIN session_tasks t ON t.id=e.task_id WHERE t.owner_user_id=? AND t.session_id=?)").run(userId, sessionId)
    const tasks = personDb().prepare('SELECT id FROM session_tasks WHERE owner_user_id=? AND session_id=?').all(userId, sessionId)
    const stopping: PersonExecution[] = []
    for (const task of tasks) {
      const current = getPersonTask(userId, String(task.id))
      if (current.execution_id && ['pending','queued','starting','running','stopping','waiting_person','waiting_user','waiting_approval'].includes(current.execution_state || '')) {
        const result = requestStop(userId, current.id, current.execution_id)
        if (result.execution.state === 'stopping') stopping.push(result.execution)
      }
    }
    return stopping
  })
  await Promise.all(runs.map(acknowledgePersonStop))
}
