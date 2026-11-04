import { randomUUID } from 'node:crypto'
import type { PersonTaskOrigin } from '../../contracts/person'
import { personError, personRevision, personText } from '../../contracts/person'
import type { PersonStageContext, PersonStageDelivery } from '../../contracts/person-stage'
import { personDb, personOperation, personTransaction, getPersonTask } from '../../repositories/person-store'
import { assertPersonStage, enqueuePersonStage, getPersonFlow, getPersonStageDelivery, personFlowHasPendingWork, personStageSources, recordPersonStageFailure, stageDeliveryContext } from '../../repositories/person-stage-store'
import { requirePersonSession } from '../../repositories/person-session-store'
import { personUpdated } from '../../repositories/person-updates'
import { personRuntime } from '../../public/person-runtime'
import { personUser } from './catalog'
import { logger } from '../../public/logging'
import { personTurnWorkspace, requirePersonWorkspace } from './workspace'
import { personStageWait, savedStageReply, stageConfirmation, startPersonStageRun, stageReplyHash } from '../../repositories/person-stage-confirmations'

const activeTurns = new Map<string, Set<AbortController>>()
export function registerPersonStageTurn(context: PersonStageContext) {
  const abort = new AbortController()
  const turns = activeTurns.get(context.flowId) || new Set<AbortController>()
  turns.add(abort); activeTurns.set(context.flowId, turns)
  return { signal: abort.signal, release() { turns.delete(abort); if (!turns.size) activeTurns.delete(context.flowId) } }
}

export function createPersonFlow(userId: number, input: Record<string, unknown>, origin?: PersonTaskOrigin) {
  if (Object.hasOwn(input,'acceptance') || (Array.isArray(input.stages) && input.stages.some(stage => stage && Object.hasOwn(stage,'acceptance')))) throw personError('Direct stage acceptance is unavailable; enable acceptance on background subtasks')
  if (Object.keys(input).some(key => !['action','session_id','title','goal','stages','rounds','idempotency_key'].includes(key))) throw personError('Unknown flow field')
  if (origin && input.session_id && input.session_id !== origin.sessionId) throw personError('Creator is assigned by the host',403)
  const creator = requirePersonSession(userId, origin?.sessionId || personText(input.session_id, 'session_id',100)).id
  if (origin?.stage) throw personError('Continue this flow instead of creating a replacement',403)
  const title = personText(input.title,'title',200), goal = personText(input.goal,'goal',8000)
  const rounds = input.rounds === undefined ? 1 : input.rounds
  if (!Number.isSafeInteger(rounds) || Number(rounds) < 0 || Number(rounds) > 1000) throw personError('rounds must be an integer from 0 to 1000; 0 repeats until stopped')
  if (!Array.isArray(input.stages) || !input.stages.length || input.stages.length > 13 || JSON.stringify(input.stages).length > 32000) throw personError('Use 1 to 13 stages (at most 32000 characters)')
  const grouped = input.stages.some(raw => raw && typeof raw === 'object' && Object.hasOwn(raw,'group'))
  const steps = input.stages.map((raw, position) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(k => !['session_id','goal','return_expectation','group'].includes(k))) throw personError('Invalid stage')
    if (grouped && (!Number.isSafeInteger(raw.group) || raw.group < 0 || raw.group > 12)) throw personError('Set group on every stage, starting at 0; equal groups run in parallel')
    return { session_id: requirePersonSession(userId, personText(raw.session_id,'session_id',100)).id,
      goal: personText(raw.goal,'goal',8000), return_expectation: personText(raw.return_expectation,'return_expectation',4000), group: grouped ? Number(raw.group) : position }
  })
  const groups: typeof steps[] = []
  for (const step of steps) {
    const previous = groups.at(-1)?.[0].group ?? -1
    if (step.group !== previous && step.group !== previous + 1) throw personError('Groups must be ordered and contiguous, starting at 0')
    const group = groups[step.group] ||= []
    if (group.some(item => item.session_id === step.session_id)) throw personError('A role may appear only once in each parallel group')
    group.push(step)
  }
  for (let index=0;index<groups.length;index++) {
    const previous = index ? groups[index-1] : [{ session_id: creator }]
    if (groups[index].length === 1 && previous.length === 1 && groups[index][0].session_id === previous[0].session_id)
      throw Object.assign(personError('A role cannot hand off to itself. Finish your own work here, then route only to another role.'),{code:'SELF_HANDOFF'})
  }
  if (rounds !== 1 && groups[0].length === 1 && groups.at(-1)!.length === 1 && groups[0][0].session_id === groups.at(-1)![0].session_id)
    throw personError('A repeating route must hand off to a different role across the round boundary')
  const key = personText(input.idempotency_key,'idempotency_key',200)
  const workspace = personTurnWorkspace(userId, creator, origin)
  const result = personOperation(userId, `flow:${key}`, { ...input, creator }, () => {
    requirePersonSession(userId,creator)
    const db = personDb(), id = randomUUID(), now = Date.now()
    if (origin?.runId && db.prepare(`SELECT 1 FROM person_task_origins o JOIN session_tasks t ON t.id=o.task_id
      WHERE o.owner_user_id=? AND t.session_id=? AND json_extract(o.origin_json,'$.runId')=?
      AND t.status NOT IN ('completed','closed')`).get(userId,creator,origin.runId)) {
      throw Object.assign(personError('Wait for this turn\'s worker result before handing off its work.',409),{code:'WORK_PENDING'})
    }
    requirePersonWorkspace(workspace)
    db.prepare('INSERT INTO person_flows(id,owner_user_id,creator_session_id,title,goal,created_at,updated_at,workspace,round_limit) VALUES(?,?,?,?,?,?,?,?,?)').run(id,userId,creator,title,goal,now,now,workspace,Number(rounds))
    steps.forEach((step, position) => {
      requirePersonSession(userId,step.session_id)
      db.prepare('INSERT INTO person_stages(id,flow_id,position,group_position,session_id,goal,return_expectation,state) VALUES(?,?,?,?,?,?,?,?)')
        .run(randomUUID(), id, position, step.group, step.session_id, step.goal, step.return_expectation, step.group ? 'pending' : 'active')
    })
    const flow = getPersonFlow(userId,id)
    for (const stage of flow.stages.filter(item => item.state === 'active')) enqueuePersonStage(userId,stage,flow.generation)
    return flow
  })
  personUpdated(userId)
  return result
}

function stageHasWork(stageId: string) {
  return !!personDb().prepare(`SELECT 1 FROM person_stage_tasks l JOIN session_tasks t ON t.id=l.task_id
    JOIN person_stages s ON s.id=l.stage_id JOIN person_flows f ON f.id=s.flow_id WHERE l.stage_id=? AND l.generation>=f.round_generation AND
    (t.status NOT IN ('completed','closed') OR (json_extract(t.requirements_json,'$.acceptance.enabled')=1 AND NOT EXISTS(SELECT 1 FROM person_executions ae JOIN person_acceptance_passes a ON a.execution_id=ae.id WHERE ae.task_id=t.id AND ae.requirements_revision=t.requirements_revision AND ae.rowid=(SELECT MAX(last.rowid) FROM person_executions last WHERE last.task_id=t.id) AND ae.state='finished')) OR EXISTS(SELECT 1 FROM person_executions e WHERE e.task_id=t.id
      AND e.state IN ('pending','queued','starting','running','stopping','waiting_person','waiting_user','waiting_approval')))`).get(stageId)
}

export async function controlPersonFlow(userId: number, input: Record<string, unknown>, origin?: PersonTaskOrigin) {
  if (Object.keys(input).some(key => !['action','flow_id','expected_revision','idempotency_key'].includes(key))) throw personError('Flow route and creator are fixed',403)
  const action = personText(input.action,'action',30), id = personText(input.flow_id,'flow_id',100)
  if (!['complete','stop','resume'].includes(action)) throw personError('Unsupported flow action')
  const result = personOperation(userId,`flow:${personText(input.idempotency_key,'idempotency_key',200)}`, { ...input, actor: origin?.sessionId || null, stage: origin?.stage || null }, () => {
    const flow = getPersonFlow(userId,id)
    const active = flow.stages.filter(stage => stage.group_position === flow.current_position && ['active','failed'].includes(stage.state))
    const expectedRevision = personRevision(input.expected_revision)
    // Peers update the shared revision independently. Completing a branch is
    // fenced by its trusted stage/generation below, not by its peers' progress.
    // Flow-wide stop/resume still require the exact observed revision.
    if (expectedRevision > flow.revision || (action !== 'complete' && flow.revision !== expectedRevision)) throw personError('Flow changed; query it again',409)
    if (origin) {
      requirePersonSession(userId,origin.sessionId)
      if (origin.sessionId !== flow.creator_session_id && !active.some(stage => stage.session_id === origin.sessionId)) throw personError('Only the creator or current role may control this flow',403)
      if (origin.stage) {
        assertPersonStage(userId,origin.stage,origin.sessionId)
        if (origin.stage.flowId !== id) throw personError('Control only the assigned flow in this turn',403)
      }
    }
    const db = personDb(), now = Date.now()
    if (action === 'complete') {
      if (!origin?.stage || origin.stage.flowId !== id || !origin.runId) throw personError('Complete the stage from its assigned live turn',403)
      const { stage } = assertPersonStage(userId,origin.stage,origin.sessionId)
      const tracked = stageConfirmation(origin.stage)
      if (tracked && tracked.run_id !== origin.runId) throw personError('Stage turn was superseded; do not complete an older reply',409)
      if (stageHasWork(stage.id)) throw personError('Finish or explicitly close the stage subtask before completing; acceptance-enabled children must pass independent verification',409)
      if (stage.completion_run_id && stage.completion_run_id !== origin.runId) throw personError('Stage completion is already being saved',409)
      db.prepare('UPDATE person_stages SET completion_run_id=? WHERE id=?').run(origin.runId,stage.id)
    } else {
      if (flow.state === 'completed') throw personError('Flow is complete',409)
      if (action === 'resume') {
        if (origin && ['stopped','failed'].includes(flow.state) && origin.sessionId !== flow.creator_session_id) throw personError('Only the creator can resume a stopped or failed flow',403)
        if (flow.state === 'failed' && personFlowHasPendingWork(userId,id)) throw personError('Wait for the other roles and workers to finish before resuming',409)
        if (db.prepare(`SELECT 1 FROM person_stage_tasks l JOIN person_stages s ON s.id=l.stage_id JOIN person_executions e ON e.task_id=l.task_id
          WHERE s.flow_id=? AND s.group_position=? AND s.state='active'
          AND e.state IN ('pending','queued','starting','running','stopping','waiting_person','waiting_user','waiting_approval')`).get(id,flow.current_position)) throw personError('Wait for stage workers to finish stopping',409)
        for (const stage of active) requirePersonSession(userId,stage.session_id)
      } else {
        for (const stage of active) {
          const candidate = stageConfirmation({flowId:id,stageId:stage.id,generation:flow.generation})
          if (candidate?.message_id) db.prepare(`INSERT INTO person_stage_confirmations(stage_id,generation,run_id,message_id,source_hash,state,attempts,reason,updated_at)
            VALUES(?,?,?,?,?,'cancelled',?,?,?)`).run(stage.id,flow.generation+1,candidate.run_id,candidate.message_id,candidate.source_hash,candidate.attempts,candidate.reason,now)
        }
      }
      db.prepare("UPDATE person_stage_deliveries SET state='cancelled',updated_at=? WHERE flow_id=? AND state IN ('pending','queued')").run(now,id)
      db.prepare("UPDATE person_stages SET completion_run_id='' WHERE flow_id=? AND state='active'").run(id)
      db.prepare('UPDATE person_flows SET state=?,generation=generation+1 WHERE id=?').run(action === 'stop' ? 'stopped' : 'active', id)
      db.prepare("UPDATE person_stage_confirmations SET claim='',state='cancelled',updated_at=? WHERE stage_id IN (SELECT id FROM person_stages WHERE flow_id=?) AND generation=? AND state!='completed'").run(now,id,flow.generation)
      if (action === 'resume') {
        const updated = getPersonFlow(userId,id)
        for (const stage of active) {
          db.prepare("UPDATE person_stages SET state='active' WHERE id=?").run(stage.id)
          db.prepare('UPDATE person_stage_tasks SET generation=? WHERE stage_id=? AND generation>=?').run(updated.generation,stage.id,updated.round_generation)
          const candidate = stageConfirmation({flowId:id,stageId:stage.id,generation:flow.generation})
          if (candidate?.message_id) {
            // Explicit resume grants a fresh bounded confirmation budget, never a rerun of saved work.
            db.prepare(`INSERT INTO person_stage_confirmations(stage_id,generation,run_id,message_id,source_hash,state,updated_at)
              VALUES(?,?,?,?,?,'pending',?)`).run(stage.id,updated.generation,candidate.run_id,candidate.message_id,candidate.source_hash,now)
          } else enqueuePersonStage(userId,stage,updated.generation)
        }
      }
    }
    db.prepare('UPDATE person_flows SET revision=revision+1,updated_at=? WHERE id=?').run(now,id)
    return getPersonFlow(userId,id)
  })
  const latest = getPersonFlow(userId,id)
  if (latest.generation !== result.generation || latest.state !== result.state) return result
  if (action !== 'complete') {
    for (const abort of activeTurns.get(id) || []) abort.abort(new Error('Flow turn superseded or stopped'))
  }
  if (action === 'stop') await stopFlowWorkers(userId,id,'',result.generation)
  personUpdated(userId)
  return result
}

async function stopFlowWorkers(userId: number, flowId: string, stageId = '', generation?: number) {
  const { applyPersonTask } = await import('./tasks')
  const current = () => generation === undefined || getPersonFlow(userId,flowId).generation === generation
  if (!current()) return
  const rows = personDb().prepare(`SELECT l.task_id FROM person_stage_tasks l JOIN person_stages s ON s.id=l.stage_id JOIN person_flows f ON f.id=s.flow_id
    JOIN session_tasks t ON t.id=l.task_id WHERE s.flow_id=? AND l.generation>=f.round_generation AND (?='' OR s.id=?)`).all(flowId,stageId,stageId)
  for (const row of rows) {
    if (!current()) return
    const task = getPersonTask(userId,String(row.task_id))
    if (task.execution_id && ['pending','queued','starting','running','stopping','waiting_person','waiting_user','waiting_approval'].includes(task.execution_state || ''))
      await applyPersonTask(userId,{ action:'stop',task_id:task.id,execution_id:task.execution_id,expected_revision:task.revision,idempotency_key:`flow-stop:${flowId}:${task.execution_id}:${task.revision}` })
    if (current()) personDb().prepare("UPDATE person_deliveries SET state='cancelled' WHERE execution_id IN (SELECT id FROM person_executions WHERE task_id=?) AND state IN ('waiting','pending','queued')").run(task.id)
  }
}

export function failPersonStage(userId: number, context: PersonStageContext, error: string) {
  if (!recordPersonStageFailure(userId,context,error)) return false
  // Stop only this branch's children; independent roles keep their live turns.
  void stopFlowWorkers(userId,context.flowId,context.stageId,context.generation).catch(error => logger.warn(error,'Failed Person stage worker cleanup'))
  personUpdated(userId)
  return true
}

/** Commit only after the final assistant message exists. No handoff transcript is stored. */
export function finishPersonStageTurn(userId: number, context: PersonStageContext, runId: string, messageId: unknown, ok: boolean, error = '', confirmationClaim?: string) {
  const tracked = stageConfirmation(context)
  if (tracked && tracked.run_id !== runId) return
  if (!ok) { failPersonStage(userId,context,error || 'Collaboration stage reply failed'); return }
  try { personTransaction(() => {
    let current: ReturnType<typeof assertPersonStage>
    try { current = assertPersonStage(userId,context) } catch { return }
    const { flow, stage } = current
    const db = personDb()
    let candidate = stageConfirmation(context)
    if (candidate && candidate.run_id !== runId) return
    if (!candidate) { startPersonStageRun(userId,context,runId); candidate = stageConfirmation(context)! }
    if (confirmationClaim && (candidate.state !== 'confirming' || candidate.claim !== confirmationClaim || candidate.lease_until < Date.now() || candidate.message_id !== Number(messageId))) return
    const message = savedStageReply(stage.session_id,runId,messageId)
    if (!message || !String(message.content).trim()) {
      throw personError('No saved final stage reply is available; inspect the conversation and resume.',409)
    }
    if (confirmationClaim && candidate.source_hash !== stageReplyHash(message.content)) throw personError('Saved reply changed during confirmation; inspect the original result before resuming.',409)
    if (stage.completion_run_id !== runId || confirmationClaim) {
      const waiting = personStageWait(context)
      if (confirmationClaim && waiting) {
        db.prepare("UPDATE person_stage_confirmations SET state='waiting',claim='',reason=?,updated_at=? WHERE stage_id=? AND generation=?").run(waiting,Date.now(),stage.id,context.generation)
        return
      }
      if (!confirmationClaim) {
        if (candidate.state !== 'running') return
        db.prepare("UPDATE person_stages SET result_message_id=? WHERE id=?").run(message.id,stage.id)
        db.prepare("UPDATE person_stage_confirmations SET message_id=?,source_hash=?,state=?,reason=?,updated_at=? WHERE stage_id=? AND generation=?")
          .run(message.id,stageReplyHash(message.content),waiting ? 'waiting' : 'pending',waiting,Date.now(),stage.id,context.generation)
        db.prepare('UPDATE person_flows SET revision=revision+1,updated_at=? WHERE id=?').run(Date.now(),flow.id)
        return
      }
    }
    if (stageHasWork(stage.id)) throw personError('Stage still has unfinished work',409)
    db.prepare("UPDATE person_stage_confirmations SET state='completed',claim='',message_id=?,reason='',updated_at=? WHERE stage_id=? AND generation=?")
      .run(message.id,Date.now(),stage.id,context.generation)
    // Save the result even if the destination was removed. Delivery reports that blocker.
    db.prepare("UPDATE person_stages SET state='completed',result_message_id=?,completion_run_id='' WHERE id=?").run(message.id,stage.id)
    db.prepare('INSERT INTO person_stage_results(stage_id,round_number,result_message_id) VALUES(?,?,?)').run(stage.id,flow.round_number,message.id)
    db.prepare("UPDATE person_stage_deliveries SET state='delivered',error='',updated_at=? WHERE stage_id=? AND state IN ('pending','queued')").run(Date.now(),stage.id)
    if (flow.stages.some(item => item.group_position === stage.group_position && item.id !== stage.id && item.state !== 'completed')) {
      db.prepare('UPDATE person_flows SET revision=revision+1,updated_at=? WHERE id=?').run(Date.now(),flow.id)
      return
    }
    const next = flow.stages.filter(item => item.group_position === stage.group_position + 1)
    if (next.length) {
      db.prepare('UPDATE person_flows SET current_position=?,revision=revision+1,updated_at=? WHERE id=?').run(stage.group_position + 1,Date.now(),flow.id)
      for (const item of next) {
        db.prepare("UPDATE person_stages SET state='active' WHERE id=? AND state='pending'").run(item.id)
        enqueuePersonStage(userId,item,flow.generation)
      }
    } else if (flow.round_limit === 0 || flow.round_number < flow.round_limit) {
      // The saved result and next round's durable dispatch commit together. A new
      // generation fences every late completion/worker callback from the old round.
      db.prepare('UPDATE person_flows SET round_number=round_number+1,generation=generation+1,round_generation=generation+1,current_position=0,revision=revision+1,updated_at=? WHERE id=?').run(Date.now(),flow.id)
      db.prepare("UPDATE person_stages SET state=CASE WHEN group_position=0 THEN 'active' ELSE 'pending' END,result_message_id=NULL,completion_run_id='' WHERE flow_id=?").run(flow.id)
      for (const item of flow.stages.filter(item => item.group_position === 0)) enqueuePersonStage(userId,item,flow.generation+1)
    } else {
      db.prepare("UPDATE person_flows SET state='completed',revision=revision+1,updated_at=? WHERE id=?").run(Date.now(),flow.id)
      db.prepare("UPDATE person_occurrences SET state='finished' WHERE flow_id=?").run(flow.id)
    }
  }) } catch (failure) { failPersonStage(userId,{...context,deliveryId:undefined},String(failure)) }
  personUpdated(userId)
}

export function finishPersonStageDelivery(userId: number, id: string, ok: boolean, error = '') {
  if (!ok) {
    const row = getPersonStageDelivery(userId,id)
    if (row.state === 'queued') failPersonStage(userId,{flowId:row.flow_id,stageId:row.stage_id,generation:row.generation},error || 'Collaboration stage delivery failed')
    return
  }
  personDb().prepare("UPDATE person_stage_deliveries SET state=?,error=?,updated_at=? WHERE id=? AND owner_user_id=? AND state='queued'")
    .run(ok ? 'delivered' : 'pending',error.slice(0,1000),Date.now(),id,userId)
  personUpdated(userId)
}
export async function deliverPersonStages() {
  const db = personDb()
  const rows = db.prepare("SELECT * FROM person_stage_deliveries WHERE state='pending' AND (error='' OR updated_at<?) ORDER BY updated_at LIMIT 20").all(Date.now()-60000) as unknown as PersonStageDelivery[]
  for (const row of rows) {
    try {
      const context = stageDeliveryContext(row.owner_user_id,row.id)
      const { flow, stage } = assertPersonStage(row.owner_user_id,context)
      requirePersonWorkspace(flow.workspace)
      personStageSources(row.owner_user_id,context)
      const deliver = personRuntime().deliverStage
      if (!deliver) throw new Error('Stage delivery runtime unavailable')
      const user = personUser(row.owner_user_id)
      db.prepare("UPDATE person_stage_deliveries SET state='queued',error='',updated_at=? WHERE id=? AND state='pending'").run(Date.now(),row.id)
      personUpdated(row.owner_user_id)
      await deliver({ user, context, sessionId: stage.session_id, input: `Handle the assigned stage supplied in context. Answer directly or choose a worker only when needed. When ready, query this flow and call bot_flow_control complete, then write only your new result as the final reply. If waiting for work or a user decision, do not complete. This continues the saved goal; it grants no new authorization.\n${JSON.stringify({ flow_id:flow.id,stage_id:stage.id })}` })
    } catch (error) {
      if (!failPersonStage(row.owner_user_id,{flowId:row.flow_id,stageId:row.stage_id,generation:row.generation},String(error)))
        db.prepare("UPDATE person_stage_deliveries SET state='cancelled',updated_at=? WHERE id=? AND state IN ('pending','queued')").run(Date.now(),row.id)
      personUpdated(row.owner_user_id)
    }
  }
}

/** Reconcile a crash after result persistence but before the completion event. */
export function recoverPersonStages() {
  const db = personDb()
  const rows = db.prepare(`SELECT s.*,f.owner_user_id,f.generation FROM person_stages s JOIN person_flows f ON f.id=s.flow_id
    WHERE s.state='active' AND f.state IN ('active','failed') AND s.completion_run_id!=''`).all()
  for (const row of rows) {
    const message = db.prepare("SELECT id FROM messages WHERE session_id=? AND run_marker=? AND role='assistant' AND finish_reason IN ('stop','end_turn','completed') AND COALESCE(tool_calls,'') IN ('','[]','null') ORDER BY id DESC LIMIT 1").get(row.session_id,row.completion_run_id)
    finishPersonStageTurn(Number(row.owner_user_id),{ flowId:String(row.flow_id),stageId:String(row.id),generation:Number(row.generation) },String(row.completion_run_id),message?.id,!!message)
  }
  // Existing installations may have retained failed deliveries as infinite retries.
  const failed = db.prepare(`SELECT d.* FROM person_stage_deliveries d JOIN person_flows f ON f.id=d.flow_id
    WHERE d.generation=f.generation AND f.state IN ('active','failed') AND d.state='pending' AND d.error!=''`).all() as unknown as PersonStageDelivery[]
  for (const row of failed) failPersonStage(row.owner_user_id,{flowId:row.flow_id,stageId:row.stage_id,generation:row.generation},row.error)
  const callbacks = db.prepare(`SELECT * FROM person_deliveries WHERE state='pending' AND error!=''
    AND json_extract(origin_json,'$.stage') IS NOT NULL`).all()
  for (const row of callbacks) {
    const stage = (JSON.parse(String(row.origin_json)) as PersonTaskOrigin).stage!
    db.prepare("UPDATE person_deliveries SET state='failed',updated_at=? WHERE execution_id=? AND state='pending'").run(Date.now(),row.execution_id)
    failPersonStage(Number(row.owner_user_id),stage,String(row.error))
  }
  db.prepare("UPDATE person_stage_deliveries SET state='pending',error='' WHERE state='queued'").run()
}

export async function stopPersonSessionFlows(userId: number, sessionId: string) {
  const rows = personDb().prepare(`SELECT DISTINCT f.id FROM person_flows f JOIN person_stages s ON s.flow_id=f.id
    WHERE f.owner_user_id=? AND f.state IN ('active','failed') AND (f.creator_session_id=? OR s.session_id=?)`).all(userId,sessionId,sessionId)
  for (const row of rows) {
    const flow = getPersonFlow(userId,String(row.id))
    await controlPersonFlow(userId,{ action:'stop',flow_id:flow.id,expected_revision:flow.revision,idempotency_key:`delete:${sessionId}:${flow.id}:${flow.revision}` })
  }
}
