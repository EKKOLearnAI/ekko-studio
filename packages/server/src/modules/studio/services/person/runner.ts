import { executePersonAcceptance } from './acceptance'
import { executeBotVerification, keepsAcceptanceOpen, finishBotVerification, expireBotAcceptances, failBotVerification, interruptBotVerification, recoverBotVerifications } from './bot-acceptance'
import { getPersonAcceptance, setPersonAcceptance, interruptPersonAcceptance, personAcceptanceSessions, recoverPersonAcceptances } from '../../repositories/person-acceptance-store'
import { personUpdated } from '../../repositories/person-updates'
import { personRuntime } from '../../public/person-runtime'
import { personError } from '../../contracts/person'
import { personExecutionSessionId } from '../../contracts/person-session'
import type { PersonExecution, PersonInteraction } from '../../contracts/person'
import type { ContentBlock } from '../../contracts/runs/session'
import { personDb, personTransaction, personSettings, getPersonExecution, getPersonTask, setPersonExecution, personEvent,
  addPersonInteraction, answerPersonInteraction, promotePersonFollowups } from '../../repositories/person-store'
import { personUser, validatePersonSelection } from './catalog'
import { runPersonModel } from './model'
import { personTools, personTool } from './tools'
import { acknowledgePersonStop, personRunSignal, releasePersonRun } from './tasks'
import { tickPersonSchedules } from './schedules'
import { deliverPersonResults, readyPersonDelivery } from './delivery'
import { logger } from '../../public/logging'
import { requirePersonSession } from '../../repositories/person-session-store'
import { requirePersonWorkspace } from './workspace'
import { personRequirements } from '../../contracts/person-flow'
import { assertPersonStageTask } from '../../repositories/person-stage-store'
import { deliverPersonStages, recoverPersonStages } from './stage-flows'
import { personTaskPrompt } from './task-prompt'
import { dispatchPersonInsertion } from './task-queue'
import { advanceAutomaticAcceptances } from './automatic-acceptance'
import { advancePersonRedirects, assertPersonRedirectConversation } from './task-redirection'

const active = new Map<string, { run: PersonExecution; abort: AbortController }>()
const busyTasks = new Set<string>()
const coordinating = new Set<string>()
let timer: ReturnType<typeof setInterval> | undefined
let ticking = false

function current(run: PersonExecution) {
  assertPersonStageTask(run.owner_user_id,run.task_id)
  const actual = getPersonExecution(run.owner_user_id, run.id)
  const task = getPersonTask(run.owner_user_id, run.task_id)
  requirePersonSession(run.owner_user_id, task.session_id)
  if (actual.generation !== run.generation || ['stopping','interrupted','failed','finished'].includes(actual.state)
    || task.status !== 'open' || task.requirements_revision !== run.requirements_revision) throw personError('Execution is no longer current', 409)
  return actual
}
async function deliver(run: PersonExecution, question: PersonInteraction, answer: string, actor: 'user' | 'person') {
  current(run)
  const accepted = answerPersonInteraction(run.owner_user_id, question.id, question.revision, answer, actor)
  if (!await personRuntime().answer(run.session_id, question.native_id, answer, question.kind === 'approval')) {
    personEvent(run, 'answer.undelivered', { interaction_id: question.id })
    throw personError('Original question expired; resume from the saved answer', 409)
  }
  current(run)
  personDb().prepare("UPDATE person_executions SET state='running',updated_at=? WHERE id=? AND generation=? AND state IN ('waiting_person','waiting_user','waiting_approval')").run(Date.now(),run.id,run.generation)
  personEvent(run, 'answer.delivered', { interaction_id: question.id, actor, answer: accepted.answer })
}
export async function replyPersonQuestion(userId: number, id: string, revision: number, answer: string) {
  const question = personDb().prepare('SELECT * FROM person_interactions WHERE id=? AND owner_user_id=?').get(id, userId) as unknown as PersonInteraction | undefined
  if (!question || question.revision !== revision || question.state !== 'pending') throw personError('Question expired or changed', 409)
  if (question.kind === 'approval') {
    const choices = JSON.parse(question.choices_json) as string[]
    if (!choices.includes(answer) || !['once','session','deny'].includes(answer)) throw personError('Unsupported approval choice')
  }
  const run = getPersonExecution(userId, question.execution_id)
  await deliver(run, question, answer, 'user')
  return { delivered: true }
}
async function coordinate(run: PersonExecution, nativeId: string, questionText: string, choices: string[], signal: AbortSignal) {
  current(run)
  const question = addPersonInteraction(run.owner_user_id, run, nativeId, questionText.slice(0,4000), choices.slice(0,5), 'question')
  if (question.state !== 'pending') return
  setPersonExecution(current(run), 'waiting_person')
  let decision: { answer?: string; escalation?: string } | undefined
  const tools = personTools(run.owner_user_id, 'coordinator', run.task_id)
  tools.push(personTool('bot_interaction_reply', 'Answer this worker question from existing requirements or retrieved facts; escalate only missing user intent or expanded scope.', {
    answer: { type: 'string' }, escalation: { type: 'string' }, basis: { type: 'string' },
  }, ['basis'], async args => {
    current(run)
    const answer = typeof args.answer === 'string' ? args.answer.trim().slice(0,4000) : ''
    const escalation = typeof args.escalation === 'string' ? args.escalation.trim().slice(0,2000) : ''
    if ((!answer && !escalation) || (answer && escalation)) throw personError('Provide either answer or escalation')
    decision = { answer, escalation }; personEvent(run, 'person.decision', { ...decision, basis: String(args.basis || '').slice(0,2000) })
    return { recorded: true }
  }))
  const task = getPersonTask(run.owner_user_id, run.task_id)
  const decisions = personDb().prepare("SELECT substr(question,1,300) AS question,substr(answer,1,600) AS answer,answered_by FROM person_interactions WHERE execution_id IN (SELECT id FROM person_executions WHERE task_id=? AND session_id=? AND requirements_revision=?) AND state='answered' ORDER BY created_at DESC LIMIT 6").all(task.id,run.session_id,run.requirements_revision)
  await runPersonModel(run.owner_user_id, 'coordinator', [{ role: 'user', content: JSON.stringify({ task: { title: task.title, requirements: JSON.parse(task.requirements_json) }, question: question.question, current_input: run.input_json ? JSON.parse(run.input_json) : undefined, choices, decisions }) }], tools, signal,
    'You answer a delegated agent on behalf of Person within the existing task scope. Use bot_interaction_reply once. Read relevant evidence when needed. Do not ask the human about routine implementation choices.',
    event => personEvent(run, 'coordinator.event', event), () => { current(run); requirePersonWorkspace(run.workspace) }, task.session_id, run.workspace)
  current(run)
  const pending = personDb().prepare("SELECT id FROM person_interactions WHERE id=? AND revision=? AND state='pending'").get(question.id,question.revision)
  if (!pending) return
  if (decision?.answer) await deliver(run, question, decision.answer, 'person')
  else {
    if (decision?.escalation) personDb().prepare("UPDATE person_interactions SET question=? WHERE id=? AND state='pending'").run(decision.escalation, question.id)
    setPersonExecution(current(run), 'waiting_user')
  }
}

async function execute(run: PersonExecution, abort: AbortController) {
  const userId = run.owner_user_id
  let workspaceError: Error | undefined
  const heartbeat = setInterval(() => {
    try {
      current(run)
      try { requirePersonWorkspace(run.workspace) }
      catch (error) { workspaceError = error as Error; throw error }
      const account = personUser(userId)
      const selection = JSON.parse(run.selection_json)
      if (account.role !== 'super_admin' && (!account.profiles.includes(selection.profile) || selection.mode === 'global')) throw personError('Execution permission revoked', 403)
      personDb().prepare('UPDATE person_executions SET lease_until=? WHERE id=? AND generation=?').run(Date.now() + 90_000, run.id, run.generation)
    } catch (error) { abort.abort(error) }
  }, 15000)
  heartbeat.unref()
  try {
    const selection = JSON.parse(run.selection_json)
    await validatePersonSelection(userId, selection)
    const task = getPersonTask(userId, run.task_id)
    const workspace = requirePersonWorkspace(run.workspace)
    current(run)
    // Legacy bindings may be symlinks. Artifact authorization must retain the
    // physical directory admitted for this execution even if that link moves.
    if (run.workspace !== workspace) {
      personDb().prepare('UPDATE person_executions SET workspace=? WHERE id=? AND generation=?').run(workspace, run.id, run.generation)
      run.workspace = workspace
    }
    personDb().prepare('UPDATE sessions SET workspace=? WHERE id=? AND CAST(studio_user_id AS TEXT)=?').run(workspace, run.session_id, String(userId))
    const decisions = personDb().prepare("SELECT question,answer,answered_by FROM person_interactions WHERE execution_id IN (SELECT id FROM person_executions WHERE task_id=? AND session_id=? AND requirements_revision=?) AND state='answered' ORDER BY created_at DESC LIMIT 10").all(task.id,run.session_id,run.requirements_revision) as unknown as Pick<PersonInteraction, 'question' | 'answer' | 'answered_by'>[]
    const requirements = personRequirements(task)
    const description = personTaskPrompt(task, decisions)
    const input = run.input_json ? JSON.parse(run.input_json) as ContentBlock[] : undefined
    const corrected = !!personDb().prepare("SELECT 1 FROM person_task_redirects WHERE task_id=? AND execution_id=? AND requirements_revision=? AND state='completed'")
      .get(task.id,run.id,run.requirements_revision)
    if (corrected) assertPersonRedirectConversation(run)
    // A new conversation needs its task brief; an existing one already has that context.
    const prompt = input
      ? corrected ? [{ type:'text' as const,text:`The user has replaced the previous requirements for this same task. Continue in this conversation using the complete current brief below. Earlier conflicting goals and decisions are superseded; preserve applicable context and artifacts.\n\n${personTaskPrompt(task,[])}` },...input]
        : run.session_id === personExecutionSessionId(run.id) ? [{ type: 'text' as const, text: description }, ...input] : input
      : description
    current(run)
    const executeTask = requirements.verification_for ? executeBotVerification : executePersonAcceptance
    const result = await executeTask(run, { user: personUser(userId), selection, sessionId: run.session_id, workspace, prompt, displayInput: corrected ? input : input ? undefined : description, signal: abort.signal,
      taskTimeoutMinutes: personSettings(userId).settings.taskTimeoutMinutes,
      onEvent: (kind, payload) => {
        try { requirePersonWorkspace(workspace) }
        catch (error) { workspaceError = error as Error; abort.abort(error); return }
        try {
          current(run)
          if (!kind.endsWith('.delta')) personEvent(run, kind, payload)
          if (kind === 'run.started') setPersonExecution(current(run), 'running')
          // The runtime automatically handles approvals; only real questions need coordination.
          if (kind === 'clarify.requested') {
            const id = String(payload.clarify_id || '')
            const questionKey = `${run.id}:${id}`
            if (!id || coordinating.has(questionKey)) return
            coordinating.add(questionKey)
            void coordinate(run, id, String(payload.question || payload.description || 'Input required'), Array.isArray(payload.choices) ? payload.choices.map(String) : [], abort.signal)
              .catch(error => {
                try {
                  const actual = current(run)
                  if (actual.state === 'waiting_person') setPersonExecution(actual, 'waiting_user')
                  personEvent(run, 'coordinator.failed', { error: String(error) })
                } catch { /* stale run */ }
              }).finally(() => coordinating.delete(questionKey))
          }
        } catch { /* Late native events must not revive a cancelled run. */ }
      },
    }, () => { current(run); requirePersonWorkspace(workspace) })
    if (workspaceError) throw workspaceError
    current(run)
    const latestRun = current(run)
    if (result.interrupted && latestRun.insertion_queue_id) {
      personTransaction(() => {
        setPersonExecution(current(run), 'interrupted', { output: result.output || '', error: '' })
        personDb().prepare("UPDATE person_deliveries SET state='cancelled',updated_at=? WHERE execution_id=? AND state IN ('waiting','pending','queued')").run(Date.now(), run.id)
        if (run.occurrence_id) personDb().prepare("UPDATE person_occurrences SET state='interrupted' WHERE id=?").run(run.occurrence_id)
      })
      return // The selected durable follow-up owns the next run and its result delivery.
    }
    if (!result.ok) {
      if (result.output) personDb().prepare('UPDATE person_executions SET output=? WHERE id=? AND generation=?').run(result.output,run.id,run.generation)
      throw new Error(result.error || 'Execution failed')
    }
    const output = (result.output || '').slice(0,2_000_000)
    personTransaction(() => {
      setPersonExecution(current(run), 'finished', { output })
      const scheduled = personDb().prepare("SELECT id FROM person_schedules WHERE task_id=? AND state IN ('active','paused')").get(task.id)
      const pending = getPersonTask(userId, task.id).pending_count
      const needsAcceptance = keepsAcceptanceOpen(task,run)
      personDb().prepare("UPDATE session_tasks SET status=?,completion_evidence=?,completed_at=?,updated_at=?,revision=revision+1 WHERE id=?")
        .run(scheduled || pending || needsAcceptance || (requirements.flow && !requirements.flow.completed) ? 'open' : 'completed', output.slice(0,2000), scheduled || pending || needsAcceptance || (requirements.flow && !requirements.flow.completed) ? null : Date.now(), Date.now(), task.id)
      finishBotVerification(run)
      if (run.occurrence_id) personDb().prepare('UPDATE person_occurrences SET state=? WHERE id=?').run(needsAcceptance?'awaiting_acceptance':'finished',run.occurrence_id)
    })
  } catch (error) {
    try {
      const actual = current(run)
      const reason = error instanceof Error ? error.message : 'Task failed'
      failBotVerification(run,reason)
      const acceptance = getPersonAcceptance(run.id)
      if (acceptance && !['passed','failed','blocked','interrupted'].includes(acceptance.state)) setPersonAcceptance(run,'blocked',reason)
      setPersonExecution(actual, 'failed', { error: reason })
    } catch { /* cancellation wins */ }
  } finally {
    const latest = personDb().prepare('SELECT * FROM person_executions WHERE owner_user_id=? AND id=?').get(userId, run.id) as unknown as PersonExecution | undefined
    if (latest && ['failed','finished','interrupted'].includes(latest.state)) personDb().prepare("UPDATE person_interactions SET state='expired',revision=revision+1 WHERE execution_id=? AND state='pending'").run(run.id)
    if (latest && ['failed','finished'].includes(latest.state)) readyPersonDelivery(latest)
    personUpdated(userId)
    clearInterval(heartbeat); active.delete(run.id); busyTasks.delete(run.task_id); releasePersonRun(run.id)
  }
}

export async function tickPersonWork() {
  if (ticking) return
  ticking = true
  try {
    advancePersonRedirects()
    expireBotAcceptances()
    await advanceAutomaticAcceptances()
    await deliverPersonResults()
    await deliverPersonStages()
    promotePersonFollowups()
    tickPersonSchedules()
    const db = personDb()
    const inserting = db.prepare("SELECT * FROM person_executions WHERE insertion_phase='requesting' AND state IN ('starting','running','waiting_person','waiting_user','waiting_approval')").all() as unknown as PersonExecution[]
    for (const run of inserting) void dispatchPersonInsertion(run).catch(error => logger.warn(error, 'Person queue insertion dispatch failed'))
    const stopping = db.prepare("SELECT * FROM person_executions WHERE state='stopping' LIMIT 30").all() as unknown as PersonExecution[]
    for (const run of stopping) {
      // A slow native acknowledgement must not block unrelated tasks or schedules.
      void acknowledgePersonStop(run).catch(error => logger.warn(error, 'Person stop acknowledgement failed; intent retained'))
    }
    // Lost workers are visible as interrupted, never silently counted as running.
    const expired = db.prepare("SELECT * FROM person_executions WHERE state IN ('starting','running','waiting_person','waiting_user','waiting_approval') AND lease_until<?").all(Date.now()) as unknown as PersonExecution[]
    for (const run of expired) {
      if (active.has(run.id)) continue
      interruptPersonAcceptance(run,'Execution lease expired; inspect and explicitly continue')
      const fenced = db.prepare("UPDATE person_executions SET state='stopping',generation=generation+1,error='Execution interrupted; inspect and resume',updated_at=? WHERE id=? AND generation=? AND lease_until<?").run(Date.now(), run.id, run.generation, Date.now())
      if (!fenced.changes) continue
      db.prepare("UPDATE person_interactions SET state='expired',revision=revision+1 WHERE execution_id=? AND state='pending'").run(run.id)
    }
    const queued = db.prepare(`SELECT e.* FROM person_executions e JOIN session_tasks t ON t.id=e.task_id
      WHERE e.state='queued' AND e.requirements_revision=t.requirements_revision
      AND NOT EXISTS(SELECT 1 FROM person_task_redirects r WHERE r.task_id=t.id AND r.state IN ('waiting','cancelling')) ORDER BY e.created_at`).all() as unknown as PersonExecution[]
    for (const next of queued) {
      if (active.size >= 12) break
      if (busyTasks.has(next.task_id)) continue
      const count = Number((db.prepare("SELECT COUNT(*) AS n FROM person_executions WHERE owner_user_id=? AND state IN ('starting','running','waiting_person','waiting_user','waiting_approval','stopping')").get(next.owner_user_id) as { n: number }).n)
      if (count >= personSettings(next.owner_user_id).settings.maxConcurrentTasks) continue
      const claim = db.prepare("UPDATE person_executions SET state='starting',generation=generation+1,lease_until=?,updated_at=? WHERE id=? AND state='queued'").run(Date.now() + 90_000, Date.now(), next.id)
      if (!claim.changes) continue
      const run = getPersonExecution(next.owner_user_id, next.id)
      const abort = personRunSignal(run)
      active.set(run.id, { run, abort }); busyTasks.add(run.task_id)
      void execute(run, abort)
    }
  } finally { ticking = false }
}
export function startPersonWork() {
  if (timer) return
  recoverPersonAcceptances()
  recoverBotVerifications()
  recoverPersonStages()
  // Queue entries are process-local; recover delivery receipts after restart.
  personDb().prepare("UPDATE person_deliveries SET state='pending',error='' WHERE state='queued'").run()
  personDb().prepare("UPDATE person_deliveries SET state='pending' WHERE state='waiting' AND execution_id IN (SELECT id FROM person_executions WHERE state IN ('finished','failed'))").run()
  timer = setInterval(() => { void tickPersonWork().catch(error => logger.warn(error, 'Person scheduler failed')) }, 3000)
  timer.unref()
}
export async function stopPersonWork() {
  if (timer) clearInterval(timer); timer = undefined
  for (const { run, abort } of active.values()) {
    personDb().prepare("UPDATE person_executions SET state='interrupted',generation=generation+1 WHERE id=? AND generation=?").run(run.id, run.generation)
    interruptPersonAcceptance(run,'Studio stopped during acceptance; inspect and explicitly continue')
    interruptBotVerification(run,'Studio stopped during verification; inspect and explicitly continue')
    abort.abort(); for (const session of personAcceptanceSessions(run)) await personRuntime().stop(session)
  }
}
