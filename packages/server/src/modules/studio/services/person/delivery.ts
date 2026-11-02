import type { PersonExecution, PersonTaskOrigin } from '../../contracts/person'
import { personError } from '../../contracts/person'
import { ownsPersonSession } from '../../contracts/person-session'
import { getSession, getSessionDetail } from '../../repositories/session-store'
import { personDb, getPersonExecution, getPersonTask, personTransaction } from '../../repositories/person-store'
import { personUpdated } from '../../repositories/person-updates'
import { personRuntime } from '../../public/person-runtime'
import { personUser } from './catalog'
import { personFlowSummary, personRequirements } from '../../contracts/person-flow'
import { assertPersonStage, personTaskStage } from '../../repositories/person-stage-store'
import { failPersonStage } from './stage-flows'
import { botAcceptanceContext, claimAutomaticReview, finishAutomaticReview } from './bot-acceptance'

export function savePersonTaskOrigin(userId: number, taskId: string, supplied?: PersonTaskOrigin) {
  const sessionId = getPersonTask(userId, taskId).session_id
  if (!ownsPersonSession(userId, getSession(sessionId))) throw personError('Task conversation not found', 404)
  if (supplied && !ownsPersonSession(userId, getSession(supplied.sessionId))) throw personError('Invalid background task origin', 403)
  // UI actions and schedules use a bounded snapshot of the same account conversation.
  const origin: PersonTaskOrigin = supplied ? { ...supplied, sessionId, returnExecutionId: undefined,acceptanceReturnId:undefined } : { sessionId, runId: '', messages: (getSessionDetail(sessionId)?.messages || [])
    .filter(message => ['user','assistant'].includes(message.role) && !message.tool_calls?.length)
    .slice(-20).map(message => ({ role: message.role as 'user' | 'assistant', content: String(message.content || '').slice(0,6000) })) }
  const stage = personTaskStage(userId,taskId)
  if (stage) { origin.stage = stage; origin.messages = [] }
  personDb().prepare('INSERT INTO person_task_origins VALUES (?,?,?) ON CONFLICT(task_id) DO UPDATE SET origin_json=excluded.origin_json')
    .run(taskId, userId, JSON.stringify(origin))
}
export function readyPersonDelivery(run: PersonExecution) {
  personDb().prepare("UPDATE person_deliveries SET state='pending',updated_at=? WHERE execution_id=? AND state='waiting'").run(Date.now(), run.id)
  personUpdated(run.owner_user_id)
}
export function finishPersonDelivery(userId: number, executionId: string, ok: boolean, error = '', acceptanceReturnId = '') {
  const db = personDb()
  const row = db.prepare("SELECT origin_json FROM person_deliveries WHERE execution_id=? AND owner_user_id=? AND state='queued'").get(executionId,userId)
  if(!row || (JSON.parse(String(row.origin_json)).acceptanceReturnId || '')!==acceptanceReturnId) return
  if (finishAutomaticReview(getPersonExecution(userId,executionId),error)) { personUpdated(userId); return }
  const stage = row ? (JSON.parse(String(row.origin_json)) as PersonTaskOrigin).stage : undefined
  if (!ok && stage) {
    const detail = error || 'Stage worker result delivery failed'
    db.prepare("UPDATE person_deliveries SET state='failed',error=?,updated_at=? WHERE execution_id=? AND owner_user_id=? AND state='queued'").run(detail.slice(0,1000),Date.now(),executionId,userId)
    failPersonStage(userId,stage,detail)
    personUpdated(userId)
    return
  }
  personDb().prepare("UPDATE person_deliveries SET state=?,error=?,updated_at=? WHERE execution_id=? AND owner_user_id=? AND state='queued'")
    .run(ok ? 'delivered' : 'pending', error.slice(0,1000), Date.now(), executionId, userId)
  personUpdated(userId)
}
export function cancelPersonDelivery(userId: number, executionId: string, acceptanceReturnId = '') {
  personDb().prepare("UPDATE person_deliveries SET state='cancelled',updated_at=? WHERE execution_id=? AND owner_user_id=? AND state='queued' AND COALESCE(json_extract(origin_json,'$.acceptanceReturnId'),'')=?")
    .run(Date.now(), executionId, userId,acceptanceReturnId)
}
export function personDeliveryCurrent(userId: number, executionId: string, expectedReturnId?: string) {
  const run = getPersonExecution(userId, executionId)
  const task = getPersonTask(userId, run.task_id)
  const acceptance=botAcceptanceContext(run)
  if(acceptance?.kind==='verification' && (getPersonTask(userId,String(acceptance.development_task_id)).execution_id!==acceptance.development_execution_id || acceptance.verification_execution_id!==run.id))return false
  const flow = personRequirements(task).flow
  const row = personDb().prepare('SELECT origin_json,state FROM person_deliveries WHERE execution_id=?').get(executionId)
  if (row && ['handled','cancelled','failed'].includes(String(row.state))) return false
  if(expectedReturnId!==undefined && (!row || (JSON.parse(String(row.origin_json)).acceptanceReturnId || '')!==expectedReturnId))return false
  const stage = row ? (JSON.parse(String(row.origin_json)) as PersonTaskOrigin).stage : undefined
  if (stage) {
    if (!['pending','queued'].includes(String(row!.state))) return false
    try { assertPersonStage(userId,stage,task.session_id) } catch { return false }
  }
  if (flow && !personDb().prepare("SELECT 1 FROM person_deliveries WHERE execution_id=? AND state IN ('pending','queued')").get(executionId)) return false
  return !flow?.stopped && !flow?.completed && ownsPersonSession(userId, getSession(task.session_id)) && ['finished','failed'].includes(run.state) && task.status !== 'closed' && task.requirements_revision === run.requirements_revision
}
export async function deliverPersonResults() {
  const db = personDb()
  const rows = db.prepare("SELECT * FROM person_deliveries WHERE state='pending' AND (error='' OR updated_at<?) ORDER BY updated_at LIMIT 20")
    .all(Date.now() - 60_000) as { execution_id: string; owner_user_id: number; origin_json: string }[]
  for (const row of rows) {
    if (!personDeliveryCurrent(row.owner_user_id, row.execution_id)) {
      db.prepare("UPDATE person_deliveries SET state='cancelled' WHERE execution_id=?").run(row.execution_id)
      continue
    }
    const run = getPersonExecution(row.owner_user_id, row.execution_id)
    const task = getPersonTask(row.owner_user_id, run.task_id)
    const origin = JSON.parse(row.origin_json) as PersonTaskOrigin
    if (origin.sessionId !== task.session_id) {
      db.prepare("UPDATE person_deliveries SET state='cancelled' WHERE execution_id=?").run(run.id)
      continue
    }
    // Deleting the source conversation must not recreate it or replay private history.
    if (!ownsPersonSession(row.owner_user_id, getSession(origin.sessionId))) {
      db.prepare("UPDATE person_deliveries SET state='cancelled' WHERE execution_id=?").run(run.id)
      continue
    }
    try {
      const admitted=personTransaction(() => {
        const claimed=db.prepare("UPDATE person_deliveries SET state='queued',error='',updated_at=? WHERE execution_id=? AND state='pending'").run(Date.now(),run.id)
        return !!claimed.changes && claimAutomaticReview(run)
      })
      if (!admitted) continue
      const user = personUser(row.owner_user_id)
      const context = personFlowSummary(task)
      await personRuntime().deliver({ user, origin, executionId: run.id, taskId: task.id, title: task.title,
        status: run.state, output: run.output.slice(0,12000), error: run.error.slice(0,2000),
        acceptance: botAcceptanceContext(run),
        ...(context.flow ? { returnExpectation: context.return_expectation, flow: context.flow } : {}) })
    } catch (error) { finishPersonDelivery(row.owner_user_id, run.id, false, String(error),origin.acceptanceReturnId) }
  }
}
