import { personError, personRevision, personText, type PersonExecution } from '../../contracts/person'
import { personRequirements } from '../../contracts/person-flow'
import { getPersonTask, getPersonExecution, personDb, personOperation, pendingPersonInputs } from '../../repositories/person-store'
import { requirePersonSession } from '../../repositories/person-session-store'
import { personUpdated } from '../../repositories/person-updates'
import { personRuntime } from '../../public/person-runtime'
import { assertPersonStageTask } from '../../repositories/person-stage-store'
import { personUser, validatePersonSelection } from './catalog'

const activeStates = ['starting', 'running', 'waiting_person', 'waiting_user', 'waiting_approval']
const dispatching = new Map<string, Promise<void>>()

export function personTaskQueue(userId: number, taskId: string, sessionId: string) {
  const task = getPersonTask(userId, taskId)
  const run = task.execution_id ? getPersonExecution(userId, task.execution_id) : undefined
  const current = run?.session_id === sessionId && activeStates.includes(run.state)
  return {
    canInsert: !!(current && task.status === 'open' && personRuntime().interruptForInsertion),
    canRemove: !!(run?.session_id === sessionId && task.status === 'open' && ['pending', 'queued', ...activeStates].includes(run.state)),
    insertion: current && run.insertion_queue_id && run.insertion_phase !== 'failed'
      ? { queueId: run.insertion_queue_id, phase: run.insertion_phase } : null,
    insertionError: current ? run.insertion_error || '' : '',
  }
}

/** Cancel one unstarted turn and its callback without stopping the active worker. */
export function removePersonTaskMessage(userId: number, taskId: string, body: Record<string, unknown>) {
  const task = getPersonTask(userId, taskId)
  const user = personUser(userId)
  if (user.role !== 'super_admin' && !user.profiles.includes(JSON.parse(task.selection_json).profile || 'default')) throw personError('Resource permission revoked', 403)
  const key = `task-remove:${personText(body.idempotency_key, 'idempotency_key', 200)}`
  return personOperation(userId, key, { ...body, task_id: taskId }, () => {
    assertPersonStageTask(userId, taskId)
    const current = getPersonTask(userId, taskId)
    requirePersonSession(userId, current.session_id)
    if (current.status !== 'open' || personRequirements(current).flow?.stopped) throw personError('Task is unavailable', 409)
    if (current.revision !== personRevision(body.expected_revision) || current.execution_id !== body.expected_execution_id) throw personError('Task changed; refresh and try again', 409)
    const active = getPersonExecution(userId, personText(body.expected_execution_id, 'expected_execution_id', 100))
    const target = getPersonExecution(userId, personText(body.queue_id, 'queue_id', 100))
    if (active.state === 'stopping' || !['pending', 'queued'].includes(target.state) || !target.input_json
      || target.task_id !== taskId || target.session_id !== active.session_id || target.requirements_revision !== current.requirements_revision) throw personError('Queued execution changed; refresh and try again', 409)
    if (active.insertion_queue_id === target.id && active.insertion_phase !== 'failed') throw personError('Another insertion is in progress', 409)
    const db = personDb(), now = Date.now()
    db.prepare("UPDATE person_executions SET state='interrupted',generation=generation+1,queue_priority=0,updated_at=? WHERE id=? AND state IN ('pending','queued')")
      .run(now, target.id)
    db.prepare("UPDATE person_deliveries SET state='cancelled',updated_at=? WHERE execution_id=? AND state IN ('waiting','pending','queued')").run(now, target.id)
    db.prepare("UPDATE person_interactions SET state='expired',revision=revision+1 WHERE execution_id=? AND state='pending'").run(target.id)
    db.prepare('UPDATE session_tasks SET revision=revision+1,updated_at=? WHERE id=?').run(now, taskId)
    return { task: getPersonTask(userId, taskId), pending: pendingPersonInputs(userId, taskId, target.session_id), ...personTaskQueue(userId, taskId, target.session_id) }
  })
}

/** Replayed requests and scheduler ticks share one dispatch for a fenced execution. */
export function dispatchPersonInsertion(run: PersonExecution): Promise<void> {
  const key = `${run.id}:${run.generation}`
  const pending = dispatching.get(key)
  if (pending) return pending
  const work = Promise.resolve().then(async () => {
    const actual = getPersonExecution(run.owner_user_id, run.id)
    if (actual.generation !== run.generation || !activeStates.includes(actual.state) || actual.insertion_phase !== 'requesting' || !actual.insertion_queue_id) return
    const task = getPersonTask(run.owner_user_id, run.task_id)
    if (task.status !== 'open' || task.execution_id !== actual.id || personRequirements(task).flow?.stopped) return
    const target = getPersonExecution(run.owner_user_id, actual.insertion_queue_id)
    if (target.state !== 'pending' || target.session_id !== actual.session_id || target.task_id !== actual.task_id) return
    const started = personDb().prepare("SELECT payload FROM person_events WHERE execution_id=? AND kind='run.started' ORDER BY id DESC LIMIT 1").get(run.id)
    const nativeId = started ? String(JSON.parse(String(started.payload)).run_id || '') : ''
    if (!nativeId) return // Initialization has not published its native run identity yet.
    const interrupt = personRuntime().interruptForInsertion
    if (!interrupt) throw personError('Task insertion is unavailable', 503)
    const result = await interrupt(actual.session_id, nativeId)
    if (result.status === 'not_running') return // The natural terminal event or lease recovery owns completion.
    if (!['accepted', 'already_pending', 'interrupted'].includes(result.status)) {
      const changed = personDb().prepare("UPDATE person_executions SET insertion_phase='failed',insertion_error=? WHERE id=? AND generation=? AND insertion_phase='requesting'")
        .run(`Task insertion unavailable: ${result.status}`, actual.id, actual.generation)
      if (changed.changes) personDb().prepare('UPDATE person_executions SET queue_priority=0 WHERE id=? AND state=\'pending\'').run(target.id)
      personUpdated(run.owner_user_id)
      throw personError(`Task insertion unavailable: ${result.status}`, 409)
    }
    personDb().prepare("UPDATE person_executions SET insertion_phase=?,insertion_error='' WHERE id=? AND generation=? AND insertion_phase='requesting'")
      .run(result.phase === 'tool_batch' ? 'waiting_for_tool_batch' : 'stopping_current_turn', actual.id, actual.generation)
    personUpdated(run.owner_user_id)
  }).finally(() => dispatching.delete(key))
  dispatching.set(key, work)
  return work
}

export async function insertPersonTaskMessage(userId: number, taskId: string, body: Record<string, unknown>) {
  const task = getPersonTask(userId, taskId)
  await validatePersonSelection(userId, JSON.parse(task.selection_json))
  if (!personRuntime().interruptForInsertion) throw personError('Task insertion is unavailable', 503)
  const key = `task-insert:${personText(body.idempotency_key, 'idempotency_key', 200)}`
  const request = { ...body, task_id: taskId }
  const run = personOperation(userId, key, request, () => {
    assertPersonStageTask(userId, taskId)
    const current = getPersonTask(userId, taskId)
    requirePersonSession(userId, current.session_id)
    if (current.status !== 'open' || personRequirements(current).flow?.stopped) throw personError('Task is unavailable', 409)
    if (current.revision !== personRevision(body.expected_revision) || current.execution_id !== body.expected_execution_id) throw personError('Task changed; refresh and try again', 409)
    const active = getPersonExecution(userId, personText(body.expected_execution_id, 'expected_execution_id', 100))
    const target = getPersonExecution(userId, personText(body.queue_id, 'queue_id', 100))
    if (!activeStates.includes(active.state) || target.state !== 'pending' || target.task_id !== taskId || target.session_id !== active.session_id || target.requirements_revision !== current.requirements_revision) throw personError('Queued execution changed; refresh and try again', 409)
    if (active.insertion_queue_id && active.insertion_phase !== 'failed') {
      if (active.insertion_queue_id !== target.id) throw personError('Another insertion is in progress', 409)
      return active
    }
    const db = personDb()
    db.prepare('UPDATE person_executions SET queue_priority=(SELECT COALESCE(MAX(queue_priority),0)+1 FROM person_executions WHERE task_id=?) WHERE id=?').run(taskId, target.id)
    db.prepare("UPDATE person_executions SET insertion_queue_id=?,insertion_phase='requesting',insertion_error='' WHERE id=? AND generation=?")
      .run(target.id, active.id, active.generation)
    db.prepare('UPDATE session_tasks SET revision=revision+1,updated_at=? WHERE id=?').run(Date.now(), taskId)
    return getPersonExecution(userId, active.id)
  })
  await dispatchPersonInsertion(run)
  return { task: getPersonTask(userId, taskId), pending: pendingPersonInputs(userId, taskId, run.session_id), ...personTaskQueue(userId, taskId, run.session_id) }
}
