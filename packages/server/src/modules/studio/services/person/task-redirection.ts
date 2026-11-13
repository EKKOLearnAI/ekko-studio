import type { PersonExecution, PersonTaskOrigin } from '../../contracts/person'
import { personError, personRevision, personText } from '../../contracts/person'
import { personRequirements } from '../../contracts/person-flow'
import type { ContentBlock } from '../../contracts/runs/session'
import { enqueuePersonExecution, getPersonExecution, getPersonTask, pendingPersonInputs, personDb, personEvent, personOperation, personTransaction, replayPersonOperation } from '../../repositories/person-store'
import { interruptPersonAcceptance } from '../../repositories/person-acceptance-store'
import { assertPersonStage, assertPersonStageTask } from '../../repositories/person-stage-store'
import { requirePersonSession } from '../../repositories/person-session-store'
import { personUpdated } from '../../repositories/person-updates'
import { validatePersonSelection } from './catalog'
import { cancelBotAcceptance, interruptBotVerification } from './bot-acceptance'
import { savePersonTaskOrigin, stopPersonTaskReturns } from './delivery'
import { assertPersonTaskActor } from './task-flow'
import { acknowledgePersonStop } from './tasks'
import { requirePersonWorkspace } from './workspace'

type Redirect = { task_id: string; owner_user_id: number; requirements_revision: number; execution_id: string; state: string }
const liveStates = "'pending','queued','starting','running','stopping','waiting_person','waiting_user','waiting_approval'"

/** Do not dispatch an empty split conversation persisted by the old implementation.
 * Actual historical native conversations are retained, never silently merged. */
export function assertPersonRedirectConversation(run: PersonExecution) {
  const db = personDb()
  const first = db.prepare('SELECT id,requirements_revision FROM person_executions WHERE task_id=? AND owner_user_id=? AND session_id=? ORDER BY created_at,rowid LIMIT 1')
    .get(run.task_id,run.owner_user_id,run.session_id)
  if (!first) throw personError('Task conversation is unavailable',409)
  const split = db.prepare("SELECT 1 FROM person_events WHERE execution_id=? AND kind='task.redirected' AND EXISTS(SELECT 1 FROM person_executions WHERE task_id=? AND requirements_revision<?)")
    .get(String(first.id),run.task_id,Number(first.requirements_revision))
  const started = db.prepare("SELECT 1 FROM person_events p JOIN person_executions e ON e.id=p.execution_id WHERE e.task_id=? AND e.session_id=? AND p.kind='run.started' LIMIT 1")
    .get(run.task_id,run.session_id)
  if (split && !started) throw personError('A previous correction created a separate empty conversation. The saved request is retained; restore its original conversation before resuming.',409)
}

/** Only the old direction and its linked verifier belong to this stop barrier. */
function obsoleteRuns(redirect: Redirect): PersonExecution[] {
  return personDb().prepare(`SELECT e.* FROM person_executions e WHERE e.owner_user_id=? AND e.state IN (${liveStates}) AND (
    (e.task_id=? AND e.requirements_revision!=?) OR e.task_id IN (SELECT verification_task_id FROM person_acceptance_tasks WHERE development_task_id=?))`)
    .all(redirect.owner_user_id, redirect.task_id, redirect.requirements_revision, redirect.task_id) as unknown as PersonExecution[]
}

/** Replacement input is persisted separately from the executions being stopped. */
export async function redirectPersonTask(userId: number, taskId: string, body: Record<string, unknown>, input: ContentBlock[], origin?: PersonTaskOrigin) {
  if (origin?.returnExecutionId) throw personError('Only a new user instruction can redirect a task; background results cannot change its direction',403)
  const key = `task-redirect:${personText(body.idempotency_key,'idempotency_key',200)}`
  const goal = personText(body.goal,'goal',8000)
  const title = body.title === undefined ? goal.split(/\r?\n/)[0].slice(0,200) : personText(body.title,'title',200)
  const request = { ...body, task_id: taskId, input }
  const observed = getPersonTask(userId,taskId)
  await validatePersonSelection(userId,JSON.parse(observed.selection_json))
  const replay = replayPersonOperation<{ execution: PersonExecution }>(userId,key,request)
  if (replay !== undefined) return { task:getPersonTask(userId,taskId),execution:getPersonExecution(userId,replay.execution.id),pending:pendingPersonInputs(userId,taskId) }
  const result = personOperation(userId,key,request,() => {
    const task = getPersonTask(userId,taskId), requirements = personRequirements(task)
    requirePersonSession(userId,task.session_id)
    requirePersonWorkspace(task.workspace)
    const stage = assertPersonStageTask(userId,taskId)
    if (origin?.stage) {
      assertPersonStage(userId,origin.stage,origin.sessionId)
      if (stage?.stageId !== origin.stage.stageId) throw personError('This stage may only redirect its own subtasks',403)
    }
    assertPersonTaskActor(task,origin)
    if (task.revision !== personRevision(body.expected_revision) || body.expected_execution_id !== (task.execution_id || null)) throw personError('Task changed; query it again',409)
    if (task.status === 'closed') throw personError('Reopen the task before redirecting',409)
    if (requirements.verification_for) throw personError('Redirect the development task, not its linked acceptance task',409)
    if (requirements.flow) throw personError('This task has a fixed role route; stop and revise the flow explicitly',409)
    const conversation = task.execution_id ? getPersonExecution(userId,task.execution_id).session_id : undefined
    cancelBotAcceptance(task,'Task direction superseded by the user')
    const db = personDb(), now = Date.now(), revision = task.requirements_revision + 1
    requirements.goal = goal
    if (requirements.acceptance) requirements.acceptance = { ...requirements.acceptance,initial_goal:goal }
    db.prepare("UPDATE session_tasks SET title=?,requirements_json=?,summary=?,status='open',completion_evidence='',completed_at=NULL,requirements_revision=?,revision=revision+1,updated_at=? WHERE id=?")
      .run(title,JSON.stringify(requirements),goal.slice(0,1000),revision,now,taskId)
    const redirect: Redirect = { task_id:taskId,owner_user_id:userId,requirements_revision:revision,execution_id:'',state:'waiting' }
    db.prepare(`INSERT INTO person_task_redirects(task_id,owner_user_id,requirements_revision,state,updated_at) VALUES(?,?,?,'waiting',?)
      ON CONFLICT(task_id) DO UPDATE SET requirements_revision=excluded.requirements_revision,execution_id='',state='waiting',error='',updated_at=excluded.updated_at`)
      .run(taskId,userId,revision,now)
    // Invalidate even finished-but-undelivered results, including cross-Bot reviews.
    db.prepare(`UPDATE person_deliveries SET state='cancelled',updated_at=? WHERE execution_id IN (
      SELECT id FROM person_executions WHERE task_id=? OR task_id IN (SELECT verification_task_id FROM person_acceptance_tasks WHERE development_task_id=?)) AND state IN ('waiting','pending','queued')`)
      .run(now,taskId,taskId)
    for (const run of obsoleteRuns(redirect)) {
      const unstarted = ['pending','queued'].includes(run.state)
      if (run.state !== 'stopping') db.prepare('UPDATE person_executions SET state=?,generation=generation+1,error=?,updated_at=? WHERE id=?')
        .run(unstarted?'interrupted':'stopping','Superseded by task direction correction',now,run.id)
      db.prepare("UPDATE person_interactions SET state='expired',revision=revision+1 WHERE execution_id=? AND state='pending'").run(run.id)
      if (run.occurrence_id) db.prepare('UPDATE person_occurrences SET state=? WHERE id=?').run(unstarted?'interrupted':'stopping',run.occurrence_id)
      interruptPersonAcceptance(run,'Task direction superseded by the user')
      interruptBotVerification(run,'Task direction superseded by the user')
    }
    savePersonTaskOrigin(userId,taskId,origin)
    // Save the next turn in the original conversation. The stop barrier, not a
    // new session, isolates it from the execution that is still unwinding.
    const execution = enqueuePersonExecution(getPersonTask(userId,taskId),null,input,false,conversation,true)
    db.prepare('UPDATE person_task_redirects SET execution_id=? WHERE task_id=?').run(execution.id,taskId)
    personEvent(execution,'task.redirected',{ requirements_revision:revision })
    return { task:getPersonTask(userId,taskId),execution,pending:pendingPersonInputs(userId,taskId,execution.session_id) }
  })
  advancePersonRedirects()
  personUpdated(userId)
  return { ...result,task:getPersonTask(userId,taskId),execution:getPersonExecution(userId,result.execution.id) }
}

/** Durable outbox: never release a replacement on a sent abort or a failed stop. */
export function advancePersonRedirects() {
  const db = personDb()
  const rows = db.prepare("SELECT * FROM person_task_redirects WHERE state IN ('waiting','cancelling')").all() as unknown as Redirect[]
  for (const redirect of rows) {
    const callbacks = stopPersonTaskReturns(redirect.owner_user_id,redirect.task_id,redirect.requirements_revision)
    const old = obsoleteRuns(redirect)
    for (const run of old) if (run.state === 'stopping') void acknowledgePersonStop(run).catch(error => {
      db.prepare("UPDATE person_task_redirects SET error=?,updated_at=? WHERE task_id=? AND requirements_revision=? AND state IN ('waiting','cancelling')")
        .run(String(error).slice(0,1000),Date.now(),redirect.task_id,redirect.requirements_revision)
      personUpdated(redirect.owner_user_id)
    })
    if (old.length || callbacks.length) continue
    try {
      personTransaction(() => {
        const current = db.prepare("SELECT * FROM person_task_redirects WHERE task_id=? AND requirements_revision=? AND state=?").get(redirect.task_id,redirect.requirements_revision,redirect.state)
        if (!current || obsoleteRuns(redirect).length) return
        if (redirect.state === 'waiting') {
          const task = getPersonTask(redirect.owner_user_id,redirect.task_id)
          requirePersonSession(redirect.owner_user_id,task.session_id)
          assertPersonStageTask(redirect.owner_user_id,redirect.task_id)
          requirePersonWorkspace(task.workspace)
          if (task.status !== 'open' || task.requirements_revision !== redirect.requirements_revision) throw personError('Task direction changed; inspect the task',409)
          assertPersonRedirectConversation(getPersonExecution(redirect.owner_user_id,redirect.execution_id))
          const changed = db.prepare("UPDATE person_executions SET state='queued',updated_at=? WHERE id=? AND requirements_revision=? AND state='pending'")
            .run(Date.now(),redirect.execution_id,redirect.requirements_revision)
          if (!changed.changes) throw personError('Correction execution changed; inspect the task',409)
        }
        db.prepare('UPDATE person_task_redirects SET state=?,error=\'\',updated_at=? WHERE task_id=? AND requirements_revision=?')
          .run(redirect.state === 'waiting'?'completed':'cancelled',Date.now(),redirect.task_id,redirect.requirements_revision)
        personUpdated(redirect.owner_user_id)
      })
    } catch (error) {
      db.prepare('UPDATE person_task_redirects SET error=? WHERE task_id=? AND requirements_revision=?').run(String(error).slice(0,1000),redirect.task_id,redirect.requirements_revision)
    }
  }
}
