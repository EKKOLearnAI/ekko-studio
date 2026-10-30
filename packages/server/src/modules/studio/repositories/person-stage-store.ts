import { randomUUID } from 'node:crypto'
import type { PersonConversationFlow, PersonStage, PersonStageContext, PersonStageDelivery } from '../contracts/person-stage'
import { personError } from '../contracts/person'
import { getPersonTask, personDb, personTransaction } from './person-store'
import { requirePersonSession } from './person-session-store'

/** Only an outstanding handoff keeps its recipient active, never the waiting creator. */
export function personCollaborationPendingCount(userId: number, sessionId: string): number {
  return Number(personDb().prepare(`SELECT COUNT(DISTINCT f.id) AS n FROM person_flows f
    JOIN person_stages s ON s.flow_id=f.id AND s.group_position=f.current_position
    JOIN person_stage_deliveries d ON d.stage_id=s.id AND d.generation=f.generation
    WHERE f.owner_user_id=? AND f.state IN ('active','failed') AND s.state='active'
      AND s.session_id=? AND d.state IN ('pending','queued') AND d.error=''`).get(userId, sessionId)!.n)
}

export function getPersonFlow(userId: number, id: string): PersonConversationFlow {
  const db = personDb()
  const row = db.prepare('SELECT * FROM person_flows WHERE id=? AND owner_user_id=?').get(id, userId)
  if (!row) throw personError('Flow not found', 404)
  const stages = db.prepare('SELECT s.*,c.title AS session_title,c.bot_type FROM person_stages s LEFT JOIN sessions c ON c.id=s.session_id WHERE flow_id=? ORDER BY position').all(id) as unknown as PersonStage[]
  for (const stage of stages) {
    const delivery = db.prepare('SELECT state,error FROM person_stage_deliveries WHERE stage_id=? AND generation=?').get(stage.id,row.generation)
    stage.delivery_state = delivery ? String(delivery.state) : undefined
    stage.delivery_error = delivery ? String(delivery.error) : undefined
    stage.tasks = db.prepare('SELECT t.id FROM person_stage_tasks l JOIN session_tasks t ON t.id=l.task_id WHERE l.stage_id=? ORDER BY t.created_at,t.id').all(stage.id).map(({ id }) => {
      const task = getPersonTask(userId,String(id))
      return { id:task.id,title:task.title,status:task.status,execution_state:task.execution_state || 'idle',agent:JSON.parse(task.selection_json).runtime }
    })
  }
  const error = db.prepare("SELECT error FROM person_stage_deliveries WHERE flow_id=? AND generation=? AND state IN ('pending','failed') AND error!='' ORDER BY updated_at DESC LIMIT 1").get(id,row.generation)?.error || ''
  return { ...row, stages, error } as unknown as PersonConversationFlow
}
export function listPersonFlows(userId: number, sessionId = '', offset = 0) {
  return personDb().prepare(`SELECT f.id FROM person_flows f WHERE owner_user_id=? AND
    (?='' OR creator_session_id=? OR EXISTS(SELECT 1 FROM person_stages s WHERE s.flow_id=f.id AND s.session_id=?))
    ORDER BY updated_at DESC,id LIMIT 50 OFFSET ?`).all(userId, sessionId, sessionId, sessionId, offset).map(row => getPersonFlow(userId, String(row.id)))
}
export function assertPersonStage(userId: number, context: PersonStageContext, sessionId?: string) {
  const flow = getPersonFlow(userId, context.flowId)
  const stage = flow.stages.find(item => item.id === context.stageId)
  if (!['active','failed'].includes(flow.state) || flow.generation !== context.generation || stage?.group_position !== flow.current_position || stage.state !== 'active') throw personError('Flow stage is no longer current', 409)
  if (sessionId && stage.session_id !== sessionId) throw personError('Stage belongs to another conversation', 403)
  requirePersonSession(userId, stage.session_id)
  if (context.deliveryId) {
    const delivery = personDb().prepare("SELECT 1 FROM person_stage_deliveries WHERE id=? AND stage_id=? AND generation=? AND state IN ('pending','queued')").get(context.deliveryId, stage.id, context.generation)
    if (!delivery) throw personError('Stage delivery was cancelled or already handled', 409)
  }
  return { flow, stage }
}
/** A failed branch settles until an explicit resume. Peers keep their generation. */
export function recordPersonStageFailure(userId: number, context: PersonStageContext, error: string) {
  return personTransaction(() => {
    let current: ReturnType<typeof assertPersonStage>
    try { current = assertPersonStage(userId,context) } catch { return false }
    const { flow,stage } = current, db = personDb(), now = Date.now()
    const detail = (error || 'Collaboration stage failed').slice(0,1000)
    db.prepare("UPDATE person_stages SET state='failed',completion_run_id='' WHERE id=?").run(stage.id)
    db.prepare("UPDATE person_stage_deliveries SET state='failed',error=?,updated_at=? WHERE stage_id=? AND generation=? AND state IN ('pending','queued','delivered')")
      .run(detail,now,stage.id,flow.generation)
    db.prepare(`UPDATE person_deliveries SET state='cancelled',updated_at=? WHERE state IN ('waiting','pending','queued')
      AND execution_id IN (SELECT e.id FROM person_executions e JOIN person_stage_tasks l ON l.task_id=e.task_id WHERE l.stage_id=?)`).run(now,stage.id)
    db.prepare("UPDATE person_flows SET state='failed',revision=revision+1,updated_at=? WHERE id=?").run(now,flow.id)
    db.prepare("UPDATE person_occurrences SET state='failed' WHERE flow_id=?").run(flow.id)
    return true
  })
}

/** SQL predicate for stage alias s; failed work itself never holds a lock. */
export const PERSON_STAGE_PENDING_WORK_SQL = `(s.completion_run_id!='' OR EXISTS(
  SELECT 1 FROM person_stage_deliveries d WHERE d.stage_id=s.id AND d.generation=f.generation AND d.state IN ('pending','queued') AND d.error='') OR EXISTS(
  SELECT 1 FROM person_stage_tasks l JOIN person_executions e ON e.task_id=l.task_id WHERE l.stage_id=s.id AND
    (e.state IN ('pending','queued','starting','running','stopping','waiting_person','waiting_user','waiting_approval') OR EXISTS(
      SELECT 1 FROM person_deliveries d WHERE d.execution_id=e.id AND d.state IN ('pending','queued')))))`

export function personFlowHasPendingWork(userId: number, flowId: string) {
  return !!personDb().prepare(`SELECT 1 FROM person_flows f JOIN person_stages s ON s.flow_id=f.id
    WHERE f.id=? AND f.owner_user_id=? AND s.group_position=f.current_position AND ${PERSON_STAGE_PENDING_WORK_SQL} LIMIT 1`).get(flowId,userId)
}

export function personTaskStage(userId: number, taskId: string): PersonStageContext | undefined {
  const row = personDb().prepare(`SELECT s.flow_id,s.id,l.generation FROM person_stage_tasks l JOIN person_stages s ON s.id=l.stage_id
    JOIN person_flows f ON f.id=s.flow_id WHERE l.task_id=? AND f.owner_user_id=?`).get(taskId, userId)
  return row ? { flowId: String(row.flow_id), stageId: String(row.id), generation: Number(row.generation) } : undefined
}
export function assertPersonStageTask(userId: number, taskId: string) {
  const context = personTaskStage(userId, taskId)
  if (context && assertPersonStage(userId, context).stage.completion_run_id) throw personError('Finish the prepared stage reply first',409)
  return context
}
export function linkPersonStageTask(userId: number, taskId: string, context: PersonStageContext, sessionId: string) {
  const { stage } = assertPersonStage(userId, context, sessionId)
  if (stage.completion_run_id) throw personError('Stage completion was requested; finish the reply first', 409)
  personDb().prepare('INSERT INTO person_stage_tasks VALUES(?,?,?)').run(taskId, stage.id, context.generation)
}
export function enqueuePersonStage(userId: number, stage: PersonStage, generation: number) {
  personDb().prepare('INSERT OR IGNORE INTO person_stage_deliveries(id,owner_user_id,flow_id,stage_id,generation,updated_at) VALUES(?,?,?,?,?,?)')
    .run(randomUUID(), userId, stage.flow_id, stage.id, generation, Date.now())
}

/** A saved timer starts its own role turn, rather than a role handing off to itself.
 * Caller owns the occurrence transaction. The usual stage lifecycle lets the role
 * answer directly or wait for its optional workers before completing. */
export function enqueuePersonScheduledStage(userId: number, sessionId: string, title: string, goal: string) {
  requirePersonSession(userId, sessionId)
  const db = personDb(), id = randomUUID(), now = Date.now()
  db.prepare('INSERT INTO person_flows(id,owner_user_id,creator_session_id,title,goal,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
    .run(id, userId, sessionId, title, goal, now, now)
  db.prepare("INSERT INTO person_stages(id,flow_id,position,session_id,goal,return_expectation,state) VALUES(?,?,0,?,?,?,'active')")
    .run(randomUUID(), id, sessionId, goal, 'Complete the saved scheduled goal and report the new result. Use a background worker only when needed.')
  const flow = getPersonFlow(userId, id)
  enqueuePersonStage(userId, flow.stages[0], flow.generation)
  return id
}
export function getPersonStageDelivery(userId: number, id: string): PersonStageDelivery {
  const row = personDb().prepare('SELECT * FROM person_stage_deliveries WHERE id=? AND owner_user_id=?').get(id,userId)
  if (!row) throw personError('Stage delivery not found',404)
  return row as unknown as PersonStageDelivery
}
export function stageDeliveryContext(userId: number, id: string): PersonStageContext {
  const row = getPersonStageDelivery(userId, id)
  const context = { flowId: row.flow_id, stageId: row.stage_id, generation: row.generation, deliveryId: row.id }
  assertPersonStage(userId,context)
  return context
}

/** Required inputs are read from originals, never copied into recipient history. */
export function personStageSources(userId: number, context: PersonStageContext) {
  const { flow, stage } = assertPersonStage(userId, context)
  const previous = flow.stages.filter(item => item.group_position === stage.group_position - 1)
  // Share the context budget across every upstream branch, retaining all original references.
  const limit = Math.floor(6000 / Math.max(1, previous.length))
  return previous.map(source => {
    requirePersonSession(userId, source.session_id)
    const row = source.state === 'completed' && personDb().prepare("SELECT id,session_id,content FROM messages WHERE id=? AND session_id=? AND role='assistant' AND COALESCE(finish_reason,'')!='streaming'").get(source.result_message_id, source.session_id)
    if (!row) throw personError('Previous stage result is unavailable', 409)
    return { id: Number(row.id), session_id: String(row.session_id), content: String(row.content).slice(0,limit), truncated: String(row.content).length > limit }
  })
}
