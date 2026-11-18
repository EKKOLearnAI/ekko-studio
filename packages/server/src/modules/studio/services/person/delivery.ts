import { randomUUID } from 'node:crypto'
import type { PersonExecution, PersonTaskOrigin } from '../../contracts/person'
import type { PersonDeliveryClaim } from '../../contracts/person-session'
import type { ContentBlock } from '../../contracts/runs/session'
import type { PersonResultDelivery } from '../../public/person-runtime'
import { personError } from '../../contracts/person'
import { ownsPersonSession } from '../../contracts/person-session'
import { getSession, getSessionDetail } from '../../repositories/session-store'
import { personDb, getPersonExecution, getPersonTask, personTransaction } from '../../repositories/person-store'
import { hasCommittedPersonTaskReturn, savePersonTaskReturn } from '../../repositories/person-return-store'
import { personUpdated } from '../../repositories/person-updates'
import { personRuntime } from '../../public/person-runtime'
import { personUser } from './catalog'
import { personFlowSummary, personRequirements } from '../../contracts/person-flow'
import { assertPersonStage, personTaskStage } from '../../repositories/person-stage-store'
import { failPersonStage } from './stage-flows'
import { botAcceptanceContext, claimAutomaticReview, deferAutomaticReview, finishAutomaticReview } from './bot-acceptance'

type ReturnTurn = { userId: number; executionId: string; controller: AbortController; finished: Promise<void> }
const activeReturns = new Set<ReturnTurn>()

/** A cancelled callback must unwind; a cancelled row or sent abort alone is not termination. */
export function registerPersonReturnTurn(userId: number, executionId: string) {
  if (!personDeliveryCurrent(userId,executionId)) throw personError('Result callback is no longer current',409)
  let finish!: () => void
  const turn: ReturnTurn = {userId,executionId,controller:new AbortController(),finished:new Promise(resolve=>{finish=resolve})}
  activeReturns.add(turn)
  return {signal:turn.controller.signal,release(){activeReturns.delete(turn);finish()}}
}
export function stopPersonTaskReturns(userId: number, taskId: string, currentRevision?: number): Promise<void>[] {
  const stopped: Promise<void>[] = []
  for (const turn of activeReturns) {
    if (turn.userId !== userId) continue
    const run = getPersonExecution(userId,turn.executionId)
    const affected = run.task_id === taskId ? currentRevision === undefined || run.requirements_revision !== currentRevision
      : !!personDb().prepare('SELECT 1 FROM person_acceptance_tasks WHERE development_task_id=? AND verification_task_id=?').get(taskId,run.task_id)
    if (!affected) continue
    turn.controller.abort(new Error('Task result superseded'))
    stopped.push(turn.finished)
  }
  return stopped
}

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
  // A callback origin may carry per-execution metadata; never inherit it on the task.
  personDb().prepare("INSERT INTO person_task_origins VALUES (?,?,json_remove(?,'$.manualFollowup')) ON CONFLICT(task_id) DO UPDATE SET origin_json=excluded.origin_json")
    .run(taskId, userId, JSON.stringify(origin))
}
/** Only the trusted task-detail entry supplies this input, inside the admission transaction. */
export function savePersonManualFollowup(executionId: string, input: ContentBlock[]) {
  personDb().prepare("UPDATE person_deliveries SET origin_json=json_set(origin_json,'$.manualFollowup',json(?)) WHERE execution_id=?")
    .run(JSON.stringify({ executionId, input }), executionId)
}
export function readyPersonDelivery(run: PersonExecution) {
  personDb().prepare("UPDATE person_deliveries SET state='pending',updated_at=? WHERE execution_id=? AND state='waiting'").run(Date.now(), run.id)
  personUpdated(run.owner_user_id)
}
function claimedPersonDelivery({ userId, executionId, claimId, acceptanceReturnId = '' }: PersonDeliveryClaim) {
  const row = personDb().prepare(`SELECT origin_json,state FROM person_deliveries
    WHERE execution_id=? AND owner_user_id=? AND claim_id=? AND claim_id!=''`).get(executionId,userId,claimId)
  if (!row) return
  const origin = JSON.parse(String(row.origin_json)) as PersonTaskOrigin
  if ((origin.acceptanceReturnId || '') === acceptanceReturnId) return { origin, state: row.state }
}

export function personDeliveryClaimIsCurrent(claim: PersonDeliveryClaim) {
  return claimedPersonDelivery(claim)?.state === 'queued'
    && personDeliveryCurrent(claim.userId,claim.executionId,claim.acceptanceReturnId || '')
}

/** A result reply and its receipt must commit together before releasing the durable claim. */
export function persistPersonDeliveryReply<T extends { messageId: number | undefined }>(
  claim: PersonDeliveryClaim, sessionId: string, writeReply: () => T, waitFor?: string[],
) {
  const {userId,executionId,acceptanceReturnId = ''} = claim
  const persisted = personTransaction(() => {
    const delivery = claimedPersonDelivery(claim)
    if (delivery?.origin.sessionId !== sessionId || !ownsPersonSession(userId,getSession(sessionId))) {
      throw personError('Result callback is no longer current',409)
    }
    // Explicit host transitions (such as a task handoff) consume the result themselves.
    if (delivery.state === 'handled') return {reply:writeReply(),receipt:undefined}
    if (delivery.state !== 'queued' || !personDeliveryCurrent(userId,executionId,acceptanceReturnId)) {
      throw personError('Result callback is no longer current',409)
    }
    const db = personDb(), run = getPersonExecution(userId,executionId)
    if (waitFor !== undefined) {
      const reply = writeReply()
      if (!reply.messageId) throw Error('Could not persist the task waiting reply')
      deferAutomaticReview(run)
      db.prepare("UPDATE person_deliveries SET state='pending',error='',wait_for_json=?,updated_at=? WHERE execution_id=?")
        .run(JSON.stringify(waitFor),Date.now(),executionId)
      return {reply,receipt:undefined}
    }
    if (finishAutomaticReview(run,'')) return {reply:undefined,receipt:undefined}
    const reply = writeReply()
    const receipt = savePersonTaskReturn(userId,executionId,sessionId,reply.messageId,acceptanceReturnId)
    if (!receipt) throw Error('Could not persist the task result receipt')
    db.prepare("UPDATE person_deliveries SET state='delivered',error='',updated_at=? WHERE execution_id=?").run(Date.now(),executionId)
    return {reply,receipt}
  })
  personUpdated(userId)
  return persisted
}

export function retryPersonDelivery(claim: PersonDeliveryClaim, error: string) {
  const {userId,executionId} = claim
  const stage = personTransaction(() => {
    const delivery = claimedPersonDelivery(claim)
    if (delivery?.state !== 'queued') return
    if (finishAutomaticReview(getPersonExecution(userId,executionId),error)) return
    const stage = delivery.origin.stage
    personDb().prepare("UPDATE person_deliveries SET state=?,error=?,updated_at=? WHERE execution_id=?")
      .run(stage ? 'failed' : 'pending',error.slice(0,1000),Date.now(),executionId)
    return stage
  })
  if (stage) failPersonStage(userId,stage,error)
  personUpdated(userId)
}
export function cancelPersonDelivery({userId,executionId,claimId,acceptanceReturnId = ''}: PersonDeliveryClaim) {
  personDb().prepare(`UPDATE person_deliveries SET state='cancelled',updated_at=?
    WHERE execution_id=? AND owner_user_id=? AND claim_id=? AND state='queued' AND COALESCE(json_extract(origin_json,'$.acceptanceReturnId'),'')=?`)
    .run(Date.now(),executionId,userId,claimId,acceptanceReturnId)
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
  return !flow?.stopped && !flow?.completed && ownsPersonSession(userId, getSession(task.session_id)) && ['finished','failed','interrupted'].includes(run.state) && task.status !== 'closed' && task.requirements_revision === run.requirements_revision
}
/** Recheck under the mutation transaction, after any model/resource validation awaits. */
export function assertPersonDeliveryOrigin(userId: number, origin?: PersonTaskOrigin) {
  if (origin?.returnExecutionId && !personDeliveryCurrent(userId,origin.returnExecutionId,origin.acceptanceReturnId || '')) throw personError('Result callback is no longer current',409)
}
export async function deliverPersonResults() {
  const db = personDb()
  const runnable = `d.state='pending' AND (d.error='' OR d.updated_at<?)
    AND NOT EXISTS (
      SELECT 1 FROM json_each(d.wait_for_json) w JOIN person_deliveries dependency ON dependency.execution_id=w.value
      WHERE dependency.owner_user_id=d.owner_user_id AND dependency.state IN ('waiting','pending','queued')
    )`
  const candidates = db.prepare(`SELECT d.execution_id FROM person_deliveries d WHERE ${runnable}
    ORDER BY d.updated_at LIMIT 20`).all(Date.now() - 60_000)
  for (const {execution_id} of candidates) {
    const delivery = personTransaction(() => {
      // Another admission or workflow transition can run while an earlier result joins its session.
      const row = db.prepare(`SELECT * FROM person_deliveries d WHERE ${runnable} AND d.execution_id=?`)
        .get(Date.now() - 60_000,String(execution_id)) as {execution_id:string;owner_user_id:number;origin_json:string} | undefined
      if (!row) return
      const {owner_user_id: userId, execution_id: executionId} = row
      if (!personDeliveryCurrent(userId,executionId)) {
        db.prepare("UPDATE person_deliveries SET state='cancelled' WHERE execution_id=?").run(executionId)
        return
      }
      const run = getPersonExecution(userId,executionId)
      const task = getPersonTask(userId,run.task_id)
      const {manualFollowup:ownFollowup,...origin} = JSON.parse(row.origin_json) as PersonTaskOrigin & Pick<PersonResultDelivery, 'manualFollowup'>
      // Deleting the source conversation must not recreate it or replay private history.
      if (origin.sessionId !== task.session_id || !ownsPersonSession(userId,getSession(origin.sessionId))) {
        db.prepare("UPDATE person_deliveries SET state='cancelled' WHERE execution_id=?").run(executionId)
        return
      }
      if (hasCommittedPersonTaskReturn(userId,executionId,origin.acceptanceReturnId || '')) {
        db.prepare("UPDATE person_deliveries SET state='delivered',error='',updated_at=? WHERE execution_id=?").run(Date.now(),executionId)
        personUpdated(userId)
        return
      }
      const claimId = randomUUID()
      db.prepare("UPDATE person_deliveries SET state='queued',error='',claim_id=?,wait_for_json='[]',updated_at=? WHERE execution_id=?")
        .run(claimId,Date.now(),executionId)
      if (claimAutomaticReview(run)) return {run,task,origin,ownFollowup,userId,claimId}
    })
    if (!delivery) continue
    const {run,task,origin,ownFollowup,userId,claimId} = delivery
    try {
      const user = personUser(userId)
      const context = personFlowSummary(task)
      const acceptance = botAcceptanceContext(run)
      // A linked review reports on the developer's request, without marking future Bot turns manual.
      const development = acceptance?.kind === 'verification' ? db.prepare('SELECT origin_json FROM person_deliveries WHERE execution_id=? AND owner_user_id=?')
        .get(String(acceptance.development_execution_id), userId) : undefined
      const manualFollowup = ownFollowup || (development ? JSON.parse(String(development.origin_json)).manualFollowup as PersonResultDelivery['manualFollowup'] : undefined)
      await personRuntime().deliver({ user, origin, executionId: run.id, claimId, taskId: task.id, title: task.title,
        status: run.state, output: run.output.slice(0,12000), error: run.error.slice(0,2000),
        acceptance, ...(manualFollowup ? { manualFollowup } : {}),
        ...(context.flow ? { returnExpectation: context.return_expectation, flow: context.flow } : {}) })
    } catch (error) { retryPersonDelivery({userId,executionId:run.id,claimId,acceptanceReturnId:origin.acceptanceReturnId},String(error)) }
  }
}
