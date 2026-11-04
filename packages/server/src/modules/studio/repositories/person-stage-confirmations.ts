import type { PersonStageContext } from '../contracts/person-stage'
import { createHash } from 'node:crypto'
import { personDb } from './person-store'
import { assertPersonStage } from './person-stage-store'

export const STAGE_CONFIRMATION_LIMIT = 2
export interface StageConfirmation {
  stage_id: string; generation: number; run_id: string; message_id: number | null; source_hash: string
  state: 'running' | 'pending' | 'confirming' | 'waiting' | 'blocked' | 'completed' | 'cancelled'
  attempts: number; claim: string; lease_until: number; decision_pending: number; reason: string; updated_at: number
}
export function stageConfirmation(context: PersonStageContext): StageConfirmation | undefined {
  return personDb().prepare('SELECT * FROM person_stage_confirmations WHERE stage_id=? AND generation=?')
    .get(context.stageId,context.generation) as unknown as StageConfirmation | undefined
}

/** Only genuine admitted turns replace a candidate. Confirmation calls never enter chat. */
export function startPersonStageRun(userId: number, context: PersonStageContext, runId: string) {
  assertPersonStage(userId,context)
  personDb().prepare(`INSERT INTO person_stage_confirmations(stage_id,generation,run_id,updated_at) VALUES(?,?,?,?)
    ON CONFLICT(stage_id,generation) DO UPDATE SET run_id=excluded.run_id,message_id=NULL,source_hash='',state='running',attempts=0,
    claim='',lease_until=0,decision_pending=0,reason='',updated_at=excluded.updated_at WHERE run_id!=excluded.run_id`)
    .run(context.stageId,context.generation,runId,Date.now())
}

export function stageDecisionEvent(context: PersonStageContext, runId: string, pending: boolean) {
  personDb().prepare("UPDATE person_stage_confirmations SET decision_pending=?,updated_at=? WHERE stage_id=? AND generation=? AND run_id=? AND state IN ('running','waiting','pending')")
    .run(Number(pending),Date.now(),context.stageId,context.generation,runId)
}

/** Includes acceptance, outstanding callback receipts and real user questions. */
export function personStageWait(context: PersonStageContext): string {
  const db = personDb()
  if (stageConfirmation(context)?.decision_pending) return 'Waiting for the existing user decision; no completion was inferred.'
  if (db.prepare(`SELECT 1 FROM person_stage_tasks l JOIN session_tasks t ON t.id=l.task_id
    JOIN person_stages s ON s.id=l.stage_id JOIN person_flows f ON f.id=s.flow_id WHERE l.stage_id=? AND l.generation>=f.round_generation AND
    (t.status NOT IN ('completed','closed') OR (json_extract(t.requirements_json,'$.acceptance.enabled')=1 AND NOT EXISTS(SELECT 1 FROM person_executions ae JOIN person_acceptance_passes a ON a.execution_id=ae.id WHERE ae.task_id=t.id AND ae.requirements_revision=t.requirements_revision AND ae.rowid=(SELECT MAX(last.rowid) FROM person_executions last WHERE last.task_id=t.id) AND ae.state='finished')) OR EXISTS(SELECT 1 FROM person_executions e WHERE e.task_id=t.id
      AND (e.state IN ('pending','queued','starting','running','stopping','waiting_person','waiting_user','waiting_approval') OR EXISTS(SELECT 1 FROM person_deliveries d WHERE d.execution_id=e.id AND d.state IN ('waiting','pending','queued')))))`).get(context.stageId))
    return 'Waiting for existing stage work, verification or its result callback.'
  return ''
}

export function savedStageReply(sessionId: string, runId: string, messageId: unknown) {
  return personDb().prepare(`SELECT id,content FROM messages WHERE id=? AND session_id=? AND run_marker=? AND role='assistant'
    AND finish_reason IN ('stop','end_turn','completed') AND COALESCE(tool_calls,'') IN ('','[]','null')`)
    .get(String(messageId || ''),sessionId,runId)
}
export const stageReplyHash = (content: unknown) => createHash('sha256').update(String(content)).digest('hex')
