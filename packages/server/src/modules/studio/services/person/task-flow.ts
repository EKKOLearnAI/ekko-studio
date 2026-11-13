import type { PersonTask, PersonTaskOrigin } from '../../contracts/person'
import { personError, personText } from '../../contracts/person'
import { personRequirements, type PersonFlowStep } from '../../contracts/person-flow'
import { enqueuePersonExecution, getPersonExecution, getPersonTask, personDb, personEvent } from '../../repositories/person-store'
import { requirePersonSession } from '../../repositories/person-session-store'
import { savePersonTaskOrigin } from './delivery'

/** The first planner fixes the remaining route; later operations cannot replace it. */
export function plannedPersonFlow(userId: number, input: Record<string, unknown>) {
  const expectation = input.return_expectation === undefined ? '' : personText(input.return_expectation, 'return_expectation', 4000)
  if (input.next_steps === undefined && !expectation) return {}
  const steps = input.next_steps === undefined ? [] : input.next_steps
  if (!Array.isArray(steps) || steps.length > 12 || JSON.stringify(steps).length > 32000) throw personError('Invalid next_steps')
  const parsed = steps.map((step): PersonFlowStep => {
    if (!step || typeof step !== 'object' || Array.isArray(step) || Object.keys(step).some(key => !['session_id', 'goal', 'return_expectation'].includes(key))) throw personError('Invalid flow step')
    const sessionId = personText(step.session_id, 'session_id', 100)
    requirePersonSession(userId, sessionId)
    return { session_id: sessionId, goal: personText(step.goal, 'goal', 8000),
      return_expectation: personText(step.return_expectation, 'return_expectation', 4000) }
  })
  return { return_expectation: expectation, flow: { steps: parsed, index: 0, stopped: false, completed: false } }
}

export function assertPersonTaskActor(task: PersonTask, origin?: PersonTaskOrigin, creatorAllowed = false) {
  if (!origin) return // Authenticated account API, not a role pretending to be another role.
  requirePersonSession(task.owner_user_id, origin.sessionId)
  const creator = personRequirements(task).creator_session_id
  if (origin.sessionId !== task.session_id && (!creatorAllowed || origin.sessionId !== creator)) throw personError('Only the current role or task creator can perform this operation', 403)
}

/** Caller owns the transaction and has checked the observed task/execution revision. */
export function advancePersonFlow(task: PersonTask, message: unknown, origin?: PersonTaskOrigin) {
  assertPersonTaskActor(task, origin)
  const requirements = personRequirements(task), flow = requirements.flow
  if (!flow || flow.stopped || flow.completed || task.status === 'closed') throw personError('Flow is stopped, complete or unavailable', 409)
  const db = personDb(), now = Date.now()
  if (db.prepare("SELECT 1 FROM person_executions WHERE task_id=? AND state IN ('pending','queued','starting','running','stopping','waiting_person','waiting_user','waiting_approval')").get(task.id)) throw personError('Wait for current execution and follow-ups', 409)
  if (!task.execution_id) throw personError('Run the current stage first', 409)
  const run = getPersonExecution(task.owner_user_id, task.execution_id)
  if (run.state !== 'finished' || run.requirements_revision !== task.requirements_revision || (origin?.returnExecutionId && origin.returnExecutionId !== run.id)) throw personError('Current stage has not succeeded', 409)
  const evidence = personText(message, 'message', 4000)
  const next = flow.steps[flow.index]
  if (next) requirePersonSession(task.owner_user_id, next.session_id)
  // Retire old callbacks in the same commit that changes ownership, so retries cannot advance twice.
  db.prepare("UPDATE person_deliveries SET state='cancelled',updated_at=? WHERE execution_id IN (SELECT id FROM person_executions WHERE task_id=?) AND state IN ('waiting','pending','queued')").run(now, task.id)
  db.prepare("UPDATE person_deliveries SET state='delivered',updated_at=? WHERE execution_id=?").run(now, run.id)
  if (!next) {
    flow.completed = true
    db.prepare("UPDATE session_tasks SET requirements_json=?,status='completed',completion_evidence=?,completed_at=?,updated_at=?,revision=revision+1 WHERE id=?")
      .run(JSON.stringify(requirements), evidence, now, now, task.id)
    personEvent(run, 'flow.completed', { message: evidence, session_id: task.session_id })
    return { task: getPersonTask(task.owner_user_id, task.id) }
  }
  flow.index++
  requirements.goal = next.goal
  requirements.return_expectation = next.return_expectation
  requirements.handoff = { execution_id: run.id, output: run.output.slice(0,12000), message: evidence }
  db.prepare("UPDATE session_tasks SET session_id=?,summary=?,requirements_json=?,status='open',completion_evidence='',completed_at=NULL,revision=revision+1,requirements_revision=requirements_revision+1,updated_at=? WHERE id=?")
    .run(next.session_id, next.goal.slice(0,1000), JSON.stringify(requirements), now, task.id)
  const previous = db.prepare('SELECT origin_json FROM person_task_origins WHERE task_id=?').get(task.id)
  // Keep original user context, rather than recursively nesting previous callback transcripts.
  const saved = previous ? JSON.parse(String(previous.origin_json)) as PersonTaskOrigin : origin
  savePersonTaskOrigin(task.owner_user_id, task.id, saved ? { ...saved, sessionId: next.session_id, returnExecutionId: undefined } : undefined)
  personEvent(run, 'flow.transferred', { from_session_id: task.session_id, to_session_id: next.session_id, index: flow.index, message: evidence })
  const execution = enqueuePersonExecution(getPersonTask(task.owner_user_id, task.id))
  return { task: getPersonTask(task.owner_user_id, task.id), execution }
}

export function stopPersonFlow(task: PersonTask, origin?: PersonTaskOrigin) {
  assertPersonTaskActor(task, origin, true)
  const requirements = personRequirements(task)
  if (!requirements.flow) return
  requirements.flow.stopped = true
  const db = personDb(), now = Date.now()
  db.prepare('UPDATE session_tasks SET requirements_json=?,revision=revision+1,updated_at=? WHERE id=?').run(JSON.stringify(requirements), now, task.id)
  db.prepare("UPDATE person_deliveries SET state='cancelled',updated_at=? WHERE execution_id IN (SELECT id FROM person_executions WHERE task_id=?) AND state IN ('waiting','pending','queued')").run(now, task.id)
  db.prepare("UPDATE person_schedules SET state='paused',revision=revision+1 WHERE task_id=? AND state='active'").run(task.id)
}
