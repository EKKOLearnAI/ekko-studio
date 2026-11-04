import { randomUUID } from 'node:crypto'
import { mkdir, realpath } from 'node:fs/promises'
import { resolve, relative, isAbsolute } from 'node:path'
import type { PersonExecution, PersonTask, PersonTaskOrigin } from '../../contracts/person'
import { personError } from '../../contracts/person'
import { personRequirements } from '../../contracts/person-flow'
import type { PersonAcceptance, PersonAcceptanceAttempt, PersonAcceptanceConfig, PersonAcceptanceReport } from '../../contracts/person-acceptance'
import { createPersonTask, enqueuePersonExecution, getPersonTask, getPersonExecution, personDb, personEvent, personTransaction } from '../../repositories/person-store'
import { getPersonAcceptance, setPersonAcceptance } from '../../repositories/person-acceptance-store'
import { personRuntime } from '../../public/person-runtime'
import { validateAcceptanceDecision } from './acceptance'
import { botVerificationPrompt } from './acceptance-prompt'
import { validatePersonSelection } from './catalog'
import { savePersonTaskOrigin } from './delivery'
import { linkPersonStageTask } from '../../repositories/person-stage-store'
import { requirePersonSession } from '../../repositories/person-session-store'
import { normalizeBotAcceptanceDecision } from './acceptance-decision'

type Input = Parameters<ReturnType<typeof personRuntime>['execute']>[0]
const terminal = new Set(['passed','failed','blocked','interrupted'])
export function botAcceptance(task: PersonTask) { return task.execution_id ? getPersonAcceptance(task.execution_id) : undefined }
export function automaticAcceptance(receipt?: PersonAcceptance) {
  return receipt?.orchestration === 'bot_tasks' && JSON.parse(receipt.snapshot_json).requirements.acceptance.progression === 'automatic'
}
/** Intermediate callbacks are consumed by the host transition, not sent as another Bot turn. */
export function consumeAcceptanceDelivery(executionId: string) {
  personDb().prepare("UPDATE person_deliveries SET state='handled',error='',updated_at=? WHERE execution_id=? AND state IN ('waiting','pending','queued')").run(Date.now(), executionId)
}
function link(taskId: string) { return personDb().prepare('SELECT * FROM person_acceptance_tasks WHERE development_task_id=?').get(taskId) }
function currentParent(userId: number, executionId: string) {
  const run=getPersonExecution(userId,executionId), task=getPersonTask(userId,run.task_id), receipt=getPersonAcceptance(run.id)
  if (!receipt || receipt.orchestration!=='bot_tasks' || task.execution_id!==run.id || task.status!=='open' || run.requirements_revision!==task.requirements_revision) throw personError('Acceptance result is no longer current',409)
  return {run,task,receipt,config:JSON.parse(receipt.snapshot_json).requirements.acceptance as PersonAcceptanceConfig}
}
export async function validateBotVerifier(userId: number, task: PersonTask) {
  const a=botAcceptance(task)
  if (!a || a.orchestration!=='bot_tasks') throw personError('This execution does not use Bot-dispatched acceptance',409)
  const {config}=currentParent(userId,a.execution_id)
  requirePersonSession(userId,config.reviewer_session_id || task.session_id)
  await validatePersonSelection(userId,config.verifier_selection)
}
/** Called inside the host operation transaction. First call creates a task; rechecks reuse it. */
export function queueBotVerification(userId: number, task: PersonTask, origin?: PersonTaskOrigin) {
  const a=botAcceptance(task)
  if (!a) throw personError('No development result to verify',409)
  const {run,receipt,config}=currentParent(userId,a.execution_id)
  if (run.state!=='finished' || !['awaiting_dispatch','awaiting_review'].includes(receipt.state)) throw personError('Wait for a development result, or repair the reported defects first',409)
  if (!receipt.deadline || receipt.deadline<=Date.now() || receipt.attempt>=config.max_attempts) throw personError('Acceptance budget exhausted; inspect and explicitly continue development',409)
  const db=personDb(), old=link(task.id)
  const reviewerSession=requirePersonSession(userId,config.reviewer_session_id || task.session_id).id
  let verifier: PersonTask
  if (old) {
    verifier=getPersonTask(userId,String(old.verification_task_id))
    if (verifier.session_id!==reviewerSession || verifier.workspace!==run.workspace || verifier.status==='closed') throw personError('Existing acceptance task is unavailable; do not replace it silently',409)
    if (db.prepare("SELECT 1 FROM person_executions WHERE task_id=? AND state NOT IN ('finished','failed','interrupted')").get(verifier.id)) throw personError('Acceptance task is already executing',409)
    db.prepare("UPDATE session_tasks SET status='open',revision=revision+1,completed_at=NULL,updated_at=? WHERE id=?").run(Date.now(),verifier.id)
    verifier=getPersonTask(userId,verifier.id)
  } else {
    verifier=createPersonTask(userId,`Acceptance: ${task.title}`.slice(0,200),'Independently verify the linked development result against its immutable criteria.',config.verifier_selection,run.workspace,reviewerSession)
    db.prepare('UPDATE session_tasks SET requirements_json=? WHERE id=?').run(JSON.stringify({goal:'Independently verify the linked development result.',creator_session_id:reviewerSession,verification_for:{task_id:task.id}}),verifier.id)
    db.prepare('INSERT INTO person_acceptance_tasks VALUES (?,?)').run(task.id,verifier.id)
    if (origin?.stage && reviewerSession===task.session_id) linkPersonStageTask(userId,verifier.id,origin.stage,task.session_id)
    verifier=getPersonTask(userId,verifier.id)
  }
  // A review report must not inherit permission to remember the developer's final deliverable.
  savePersonTaskOrigin(userId,verifier.id,reviewerSession===task.session_id?origin?{...origin,memoryRequest:undefined}:undefined:{sessionId:reviewerSession,runId:origin?.runId || '',messages:[]})
  // Same logical task and preset; each round has a separate execution and native receipt.
  const execution=enqueuePersonExecution(verifier)
  const ordinal=receipt.attempt+1, now=Date.now()
  db.prepare("INSERT INTO person_acceptance_attempts(id,execution_id,ordinal,session_id,selection_json,state,created_at,updated_at,verification_execution_id,report_protocol) VALUES (?,?,?,?,?,'queued',?,?,?,'bot_review')")
    .run(randomUUID(),run.id,ordinal,execution.session_id,JSON.stringify(config.verifier_selection),now,now,execution.id)
  db.prepare('UPDATE person_acceptance SET attempt=?,active_session_id=? WHERE execution_id=?').run(ordinal,execution.session_id,run.id)
  setPersonAcceptance(run,'verification_pending')
  if (automaticAcceptance(receipt)) consumeAcceptanceDelivery(run.id)
  db.prepare('UPDATE session_tasks SET revision=revision+1,updated_at=? WHERE id=?').run(now,task.id)
  personEvent(run,'acceptance.task_dispatched',{task_id:verifier.id,execution_id:execution.id,ordinal})
  return {task:getPersonTask(userId,verifier.id),execution}
}
async function bounded(run: PersonExecution,input: Input,deadline: number,check:()=>unknown,work:(input:Input)=>ReturnType<ReturnType<typeof personRuntime>['execute']>) {
  const controller=new AbortController(), signal=AbortSignal.any([input.signal,controller.signal])
  const timer=setTimeout(()=>controller.abort(new Error('Acceptance time budget exhausted')),Math.max(0,deadline-Date.now()));timer.unref()
  try {
    check();if (signal.aborted) throw signal.reason
    const result=await work({...input,signal,waitForTermination:true,taskTimeoutMinutes:Math.min(input.taskTimeoutMinutes===-1?Infinity:input.taskTimeoutMinutes,Math.max(0.001,(deadline-Date.now())/60_000))})
    check();if(signal.aborted)throw signal.reason
    return result
  } finally {clearTimeout(timer)}
}
export async function executeBotDevelopment(run: PersonExecution,input: Input,check:()=>unknown) {
  const a=getPersonAcceptance(run.id)!,config=JSON.parse(a.snapshot_json).requirements.acceptance as PersonAcceptanceConfig
  const deadline=a.deadline || Date.now()+config.timeout_minutes*60_000
  personDb().prepare('UPDATE person_acceptance SET deadline=?,active_session_id=? WHERE execution_id=?').run(deadline,run.session_id,run.id)
  setPersonAcceptance(run,'developing')
  try {
    const result=await bounded(run,input,deadline,check,i=>personRuntime().execute({...i,purpose:'development'}))
    if (!result.ok || result.interrupted || !result.output?.trim()) throw new Error(result.error || 'Development returned no usable result')
    personDb().prepare('UPDATE person_acceptance SET worker_output=? WHERE execution_id=?').run(result.output.slice(0,2_000_000),run.id)
    setPersonAcceptance(run,'awaiting_dispatch',automaticAcceptance(a)?'Development returned; host will dispatch the linked acceptance task':'Development returned; Bot must dispatch the linked acceptance task')
    return result
  } catch(error) {check();setPersonAcceptance(run,'blocked',String(error));throw error}
}
export async function executeBotVerification(run: PersonExecution,input: Input,check:()=>unknown): ReturnType<ReturnType<typeof personRuntime>['execute']> {
  const db=personDb(),attempt=db.prepare('SELECT * FROM person_acceptance_attempts WHERE verification_execution_id=?').get(run.id)
  if (!attempt) throw personError('Verification must be dispatched through its linked development task',409)
  const parent=()=>{
    check();const value=currentParent(run.owner_user_id,String(attempt.execution_id))
    if(value.receipt.state!=='verification_pending' || value.receipt.active_session_id!==run.session_id || value.receipt.attempt!==Number(attempt.ordinal))throw personError('Verification was stopped or superseded',409)
    return value
  }
  const {receipt}=parent(),root=getPersonExecution(run.owner_user_id,receipt.execution_id)
  try {
    const directory=resolve(input.workspace,'.studio-acceptance',root.id,String(attempt.ordinal));await mkdir(directory,{recursive:true})
    const local=relative(await realpath(input.workspace),await realpath(directory));if(isAbsolute(local)||local==='..'||local.startsWith('../')||local.startsWith('..\\'))throw new Error('Evidence directory escaped workspace')
    parent()
    const previous=db.prepare("SELECT v.ordinal,v.raw_output,v.report_json,v.error FROM person_acceptance_attempts v JOIN person_acceptance a ON a.execution_id=v.execution_id WHERE a.cycle_id=? AND v.id!=? ORDER BY v.ordinal").all(receipt.cycle_id,attempt.id)
    const prompt=botVerificationPrompt(JSON.parse(receipt.snapshot_json),receipt.worker_output,directory,previous)
    db.prepare("UPDATE person_acceptance_attempts SET state='running',report_protocol='bot_review',updated_at=? WHERE id=?").run(Date.now(),attempt.id)
    const result=await bounded(run,{...input,prompt,displayInput:prompt},receipt.deadline,parent,i=>personRuntime().execute({...i,purpose:'verification',onEvent(kind,payload){
      parent()
      if(kind==='run.started'&&typeof payload.run_id==='string'&&payload.run_id)db.prepare('UPDATE person_acceptance_attempts SET run_id=? WHERE id=?').run(payload.run_id,attempt.id)
      input.onEvent(kind,payload)
    }}))
    parent()
    const raw=(result.output||'').slice(0,2_000_000);db.prepare('UPDATE person_acceptance_attempts SET raw_output=? WHERE id=?').run(raw,attempt.id)
    if(!result.ok||result.interrupted||['max_steps','timeout','cancelled','error','queue_insertion'].includes(result.stop_reason||''))throw new Error(result.error||'Verifier execution failed')
    const native=db.prepare('SELECT run_id FROM person_acceptance_attempts WHERE id=?').get(attempt.id)?.run_id
    const developer=db.prepare("SELECT payload FROM person_events WHERE execution_id=? AND kind='run.started' ORDER BY id DESC LIMIT 1").get(root.id)
    if(!native||native===(developer?JSON.parse(String(developer.payload)).run_id:undefined)||db.prepare('SELECT 1 FROM person_acceptance_attempts WHERE run_id=? AND id!=?').get(native,attempt.id))throw new Error('Verifier native identity missing or reused')
    if (!raw.trim()) throw new Error('Verifier returned no usable report')
    db.prepare("UPDATE person_acceptance_attempts SET state='reported',updated_at=? WHERE id=?").run(Date.now(),attempt.id)
    setPersonAcceptance(root,'awaiting_review','Verification report returned; Bot must review it and record the decision')
    db.prepare('UPDATE session_tasks SET revision=revision+1,updated_at=? WHERE id=?').run(Date.now(),root.task_id)
    return {ok:true,output:raw}
  } catch(error){
    check()
    const a=getPersonAcceptance(root.id)
    if(a&&!terminal.has(a.state)&&getPersonTask(run.owner_user_id,root.task_id).execution_id===root.id)setPersonAcceptance(root,'blocked',String(error))
    db.prepare("UPDATE person_acceptance_attempts SET state='error',error=?,updated_at=? WHERE id=? AND state IN ('queued','running')").run(String(error),Date.now(),attempt.id)
    throw error
  }
}

function pendingReview(userId: number, task: PersonTask, verificationExecutionId: unknown) {
  const {run,receipt,config}=currentParent(userId,task.execution_id || '')
  const db=personDb(), attempt=db.prepare('SELECT * FROM person_acceptance_attempts WHERE execution_id=? AND ordinal=?').get(run.id,receipt.attempt)
  if(run.state!=='finished' || receipt.state!=='awaiting_review' || receipt.deadline<=Date.now()
    || !attempt || attempt.state!=='reported' || attempt.report_protocol!=='bot_review'
    || typeof verificationExecutionId!=='string' || verificationExecutionId!==attempt.verification_execution_id) throw personError('Query the current returned verification report before recording a decision',409)
  const verification=getPersonExecution(userId,verificationExecutionId), reviewer=getPersonTask(userId,verification.task_id)
  if(verification.state!=='finished' || reviewer.status==='closed' || reviewer.execution_id!==verification.id
    || reviewer.session_id!==(config.reviewer_session_id || task.session_id)
    || verification.session_id!==attempt.session_id || receipt.active_session_id!==verification.session_id
    || link(task.id)?.verification_task_id!==reviewer.id) throw personError('Verification report is no longer current',409)
  return {run,receipt,config,attempt,verification}
}

/** File IO precedes the short operation transaction; commit rechecks every task identity. */
export async function prepareBotAcceptanceDecision(userId: number, task: PersonTask, input: Record<string,unknown>, origin?: PersonTaskOrigin) {
  const current=pendingReview(userId,task,input.verification_execution_id)
  const reviewerSession=current.config.reviewer_session_id || task.session_id
  requirePersonSession(userId,reviewerSession)
  if(origin && origin.sessionId!==reviewerSession) throw personError('Only the owning Bot assigned to review may record acceptance',403)
  if(origin?.returnExecutionId && origin.returnExecutionId!==current.verification.id) throw personError('This callback does not own the current verification report',409)
  const directory=resolve(current.run.workspace,'.studio-acceptance',current.run.id,String(current.receipt.attempt))
  let validated: Awaited<ReturnType<typeof validateAcceptanceDecision>>
  try { validated=await validateAcceptanceDecision(normalizeBotAcceptanceDecision(input.report),current.config,directory) }
  catch(error) {throw personError(`Cannot record acceptance: ${error instanceof Error ? error.message : String(error)}`)}
  return {...validated,verification_execution_id:current.verification.id,execution_id:current.run.id,
    decision:{version:2,session_id:reviewerSession,run_id:origin?.runId || '',verification_execution_id:current.verification.id,source:origin?.returnExecutionId?'bot_callback':origin?'bot':'api'}}
}

export function recordBotAcceptanceDecision(userId: number, task: PersonTask, decision: Awaited<ReturnType<typeof prepareBotAcceptanceDecision>>) {
  const {run,receipt,config,attempt,verification}=pendingReview(userId,task,decision.verification_execution_id)
  if(run.id!==decision.execution_id) throw personError('Development result changed during acceptance review',409)
  const {report,evidence}=decision, db=personDb()
  db.prepare('UPDATE person_acceptance_attempts SET state=?,report_json=?,evidence_json=?,decision_json=?,updated_at=? WHERE id=?')
    .run(report.verdict,JSON.stringify(report),JSON.stringify(evidence),JSON.stringify(decision.decision),Date.now(),attempt.id)
  const state=report.verdict==='passed'?'passed':report.verdict==='blocked'?'blocked':receipt.attempt>=config.max_attempts?'failed':'repair_required'
  setPersonAcceptance(run,state,JSON.stringify(report))
  db.prepare('UPDATE session_tasks SET revision=revision+1,updated_at=? WHERE id=?').run(Date.now(),task.id)
  finishBotVerification(verification)
  if((config.reviewer_session_id || task.session_id)!==task.session_id && (!automaticAcceptance(receipt) || state !== 'repair_required')) {
    db.prepare("UPDATE person_deliveries SET state='pending',error='',origin_json=json_set(origin_json,'$.acceptanceReturnId',?),updated_at=? WHERE execution_id=? AND state!='cancelled'").run(verification.id,Date.now(),run.id)
    personEvent(run,'acceptance.decision_returned',{reviewer_session_id:config.reviewer_session_id,verification_execution_id:verification.id})
  }
  return {task:getPersonTask(userId,task.id),execution:undefined}
}
export function keepsAcceptanceOpen(task:PersonTask,run:PersonExecution) {
  if(personRequirements(task).verification_for){const a=personDb().prepare('SELECT a.state FROM person_acceptance a JOIN person_acceptance_attempts v ON v.execution_id=a.execution_id WHERE v.verification_execution_id=?').get(run.id);return a?.state!=='passed'}
  const a=getPersonAcceptance(run.id);return a?.orchestration==='bot_tasks'&&a.state!=='passed'
}
export function finishBotVerification(run:PersonExecution) {
  const db=personDb(),a=db.prepare('SELECT a.* FROM person_acceptance a JOIN person_acceptance_attempts v ON v.execution_id=a.execution_id WHERE v.verification_execution_id=?').get(run.id)
  if(a?.state!=='passed')return
  const task=getPersonTask(run.owner_user_id,String(a.task_id))
  const root=getPersonExecution(run.owner_user_id,String(a.execution_id))
  db.prepare("UPDATE session_tasks SET status='completed',completion_evidence=?,completed_at=?,updated_at=?,revision=revision+1 WHERE id=? AND status='open'").run(String(a.reason).slice(0,2000),Date.now(),Date.now(),run.task_id)
  if(task.execution_id===root.id&&root.occurrence_id)db.prepare("UPDATE person_occurrences SET state='finished' WHERE id=?").run(root.occurrence_id)
  if(task.execution_id!==a.execution_id||task.status!=='open'||task.pending_count||personRequirements(task).flow||db.prepare("SELECT 1 FROM person_schedules WHERE task_id=? AND state IN ('active','paused')").get(task.id))return
  db.prepare("UPDATE session_tasks SET status='completed',completion_evidence=?,completed_at=?,updated_at=?,revision=revision+1 WHERE id=?").run(String(a.reason).slice(0,2000),Date.now(),Date.now(),task.id)
}
export function botAcceptanceContext(run:PersonExecution) {
  const task=getPersonTask(run.owner_user_id,run.task_id),verification=personRequirements(task).verification_for
  const attempt=verification?personDb().prepare('SELECT execution_id FROM person_acceptance_attempts WHERE verification_execution_id=?').get(run.id):undefined
  const a=getPersonAcceptance(attempt?String(attempt.execution_id):run.id)
  if(!a||a.orchestration!=='bot_tasks')return undefined
  const config=JSON.parse(a.snapshot_json).requirements.acceptance as PersonAcceptanceConfig
  const automatic=automaticAcceptance(a)
  const developer=getPersonTask(run.owner_user_id,a.task_id), reviewerSession=config.reviewer_session_id || developer.session_id
  const passed=!!personDb().prepare('SELECT 1 FROM person_acceptance_passes WHERE execution_id=?').get(a.execution_id)
  const latest=personDb().prepare('SELECT verification_execution_id,length(raw_output) AS report_length FROM person_acceptance_attempts WHERE execution_id=? AND ordinal=?').get(a.execution_id,a.attempt)
  let decision:PersonAcceptanceReport|undefined
  if(['repair_required','passed','failed','blocked'].includes(a.state)) try {const parsed=JSON.parse(a.reason);if(parsed?.checks)decision=parsed} catch { /* Runtime blockers have no decision report. */ }
  return {automatic,kind:verification?'verification':'development',development_task_id:a.task_id,development_execution_id:a.execution_id,verification_task_id:link(a.task_id)?.verification_task_id||null,
    developer_session_id:developer.session_id,reviewer_session_id:reviewerSession,
    decision,
    verification_execution_id:latest?.verification_execution_id||null,
    report_length:latest?.report_length || 0,
    state:a.state,criteria:config.criteria,attempt:a.attempt,max_attempts:config.max_attempts,reason:a.reason,
    next_action:verification&&reviewerSession!==developer.session_id&&['repair_required','passed','failed','blocked'].includes(a.state)?'return':automatic&&['awaiting_dispatch','repair_required'].includes(a.state)?'wait':a.state==='awaiting_dispatch'?'verify':a.state==='awaiting_review'?'review':a.state==='repair_required'?'repair':a.state==='passed'&&passed?'report':a.state==='verification_pending'?'wait':'blocked'}
}

function automaticReview(run: PersonExecution) {
  const attempt=personDb().prepare('SELECT * FROM person_acceptance_attempts WHERE verification_execution_id=?').get(run.id) as unknown as PersonAcceptanceAttempt | undefined
  const receipt=attempt ? getPersonAcceptance(attempt.execution_id) : undefined
  if (!attempt || !receipt || !automaticAcceptance(receipt) || receipt.state!=='awaiting_review' || attempt.state!=='reported' || receipt.attempt!==attempt.ordinal) return
  const root=getPersonExecution(run.owner_user_id, receipt.execution_id),task=getPersonTask(run.owner_user_id,root.task_id)
  if (task.execution_id!==root.id || task.status!=='open' || task.requirements_revision!==root.requirements_revision) return
  return {attempt,root}
}
function blockAutomaticReview(run: PersonExecution, root: PersonExecution, reason: string) {
  setPersonAcceptance(root,'blocked',reason)
  personDb().prepare("UPDATE person_deliveries SET state='failed',error=?,updated_at=? WHERE execution_id=?").run(reason,Date.now(),run.id)
  // The review turn cannot finish the decision; report the blocker to the original owner.
  personDb().prepare("UPDATE person_deliveries SET state='pending',error='',origin_json=json_set(origin_json,'$.acceptanceReturnId',?),updated_at=? WHERE execution_id=? AND state!='cancelled'").run(run.id,Date.now(),root.id)
}
/** Count actual Bot decision turns, separately from native verification attempts. Caller owns the transaction. */
export function claimAutomaticReview(run: PersonExecution) {
  const review=automaticReview(run)
  if (!review) return true
  if (review.attempt.decision_attempts>=3) {
    blockAutomaticReview(run,review.root,'Acceptance decision could not be recorded after 3 Bot turns; inspect the saved report and continue explicitly')
    return false
  }
  personDb().prepare('UPDATE person_acceptance_attempts SET decision_attempts=decision_attempts+1 WHERE id=?').run(review.attempt.id)
  return true
}
/** A Bot reply without its decision is not workflow completion. Retry boundedly, then expose a blocker. */
export function finishAutomaticReview(run: PersonExecution, error: string) {
  const review=automaticReview(run)
  if (!review) return false
  personTransaction(() => {
    const reason=error || 'Bot returned without recording an acceptance decision; retrying the saved report'
    if (review.attempt.decision_attempts>=3) blockAutomaticReview(run,review.root,`Acceptance decision could not be recorded after 3 Bot turns: ${reason}`.slice(0,2000))
    else personDb().prepare("UPDATE person_deliveries SET state='pending',error=?,updated_at=? WHERE execution_id=? AND state='queued'").run(reason,Date.now(),run.id)
  })
  return true
}
export function interruptBotVerification(run:PersonExecution,reason:string) {
  const db=personDb(),row=db.prepare('SELECT execution_id,id FROM person_acceptance_attempts WHERE verification_execution_id=?').get(run.id)
  if(!row)return
  const a=getPersonAcceptance(String(row.execution_id))
  if(a&&a.orchestration==='bot_tasks'&&!terminal.has(a.state))setPersonAcceptance(getPersonExecution(run.owner_user_id,a.execution_id),'interrupted',reason)
  db.prepare("UPDATE person_acceptance_attempts SET state='interrupted',error=?,updated_at=? WHERE id=? AND state IN ('queued','running')").run(reason,Date.now(),row.id)
}
export function failBotVerification(run:PersonExecution,reason:string) {
  const db=personDb(),row=db.prepare('SELECT execution_id FROM person_acceptance_attempts WHERE verification_execution_id=?').get(run.id)
  if(!row)return
  const a=getPersonAcceptance(String(row.execution_id))
  if(a&&['verification_pending','awaiting_review','passed'].includes(a.state)&&!db.prepare('SELECT 1 FROM person_acceptance_passes WHERE execution_id=?').get(a.execution_id))setPersonAcceptance(getPersonExecution(run.owner_user_id,a.execution_id),'blocked',reason)
  if(automaticAcceptance(a) && getPersonAcceptance(a!.execution_id)?.state==='blocked') {
    const root=getPersonExecution(run.owner_user_id,a!.execution_id)
    if(getPersonTask(run.owner_user_id,root.task_id).execution_id===root.id)db.prepare("UPDATE person_deliveries SET state='pending',error='',origin_json=json_set(origin_json,'$.acceptanceReturnId',?),updated_at=? WHERE execution_id=? AND state IN ('handled','waiting')").run(run.id,Date.now(),root.id)
  }
}
export function recoverBotVerifications() {
  const db=personDb(),rows=db.prepare("SELECT e.* FROM person_executions e JOIN person_acceptance_attempts v ON v.verification_execution_id=e.id WHERE e.state IN ('starting','running','waiting_person','waiting_user','waiting_approval')").all() as unknown as PersonExecution[]
  for(const run of rows){interruptBotVerification(run,'Studio restarted during verification; inspect and explicitly resume');db.prepare("UPDATE person_executions SET state='stopping',generation=generation+1 WHERE id=?").run(run.id)}
}
export function cancelBotAcceptance(task:PersonTask,reason:string) {
  const a=botAcceptance(task);if(!a||a.orchestration!=='bot_tasks'||terminal.has(a.state))return false
  const db=personDb(),root=getPersonExecution(task.owner_user_id,a.execution_id)
  setPersonAcceptance(root,'interrupted',reason)
  db.prepare("UPDATE person_executions SET state='stopping',generation=generation+1,error=?,updated_at=? WHERE id IN (SELECT verification_execution_id FROM person_acceptance_attempts WHERE execution_id=?) AND state NOT IN ('finished','failed','interrupted')").run(reason,Date.now(),root.id)
  db.prepare("UPDATE person_acceptance_attempts SET state='interrupted',error=? WHERE execution_id=? AND state IN ('queued','running')").run(reason,root.id)
  return true
}
export function expireBotAcceptances() {
  const db=personDb(),rows=db.prepare("SELECT a.* FROM person_acceptance a JOIN person_executions e ON e.id=a.execution_id WHERE a.orchestration='bot_tasks' AND a.deadline>0 AND a.deadline<=? AND a.state NOT IN ('passed','failed','blocked','interrupted') AND e.rowid=(SELECT MAX(rowid) FROM person_executions WHERE task_id=a.task_id)").all(Date.now())
  for(const a of rows){
    const task=getPersonTask(Number(db.prepare('SELECT owner_user_id FROM person_executions WHERE id=?').get(a.execution_id)!.owner_user_id),String(a.task_id))
    cancelBotAcceptance(task,'Acceptance time budget exhausted; inspect and explicitly continue')
    setPersonAcceptance(getPersonExecution(task.owner_user_id,String(a.execution_id)),'blocked','Acceptance time budget exhausted; Bot did not finish the bounded workflow')
    db.prepare("UPDATE person_deliveries SET state='cancelled' WHERE execution_id=? AND state IN ('waiting','pending','queued')").run(a.execution_id)
    db.prepare("UPDATE person_executions SET state='stopping',generation=generation+1 WHERE id=? AND state NOT IN ('finished','failed','interrupted','stopping')").run(a.execution_id)
    if (automaticAcceptance(a as unknown as PersonAcceptance) && getPersonExecution(task.owner_user_id,String(a.execution_id)).state==='finished') {
      db.prepare("UPDATE person_deliveries SET state='cancelled' WHERE execution_id IN (SELECT verification_execution_id FROM person_acceptance_attempts WHERE execution_id=?) AND state IN ('pending','queued')").run(a.execution_id)
      db.prepare("UPDATE person_deliveries SET state='pending',error='',updated_at=? WHERE execution_id=?").run(Date.now(),a.execution_id)
    }
  }
}
