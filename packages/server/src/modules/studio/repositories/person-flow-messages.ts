import { personError } from '../contracts/person'
import { personDb } from './person-store'
import { getPersonFlow } from './person-stage-store'
import { requirePersonSession } from './person-session-store'
import type { HermesMessageRow } from './session-store'

export interface PersonFlowMessageRow extends HermesMessageRow {
  session_title: string
  bot_type: string | null
  stage_id: string
  round_number: number | null
}

/** Correlate original turns, never the entire history of a participating Bot. */
export function readPersonFlowMessages(userId: number, flowId: string, beforeId: number, limit: number) {
  const flow = getPersonFlow(userId,flowId)
  const creator = requirePersonSession(userId,flow.creator_session_id)
  if ((creator.history_cleared_at || 0) > flow.created_at) throw personError('Flow history was cleared',404)
  const db = personDb()
  // Older flows retain exact run identities in confirmations and saved results.
  // A missing identity is never reconstructed from a time window or Bot name.
  const rows = db.prepare(`WITH known_runs AS (
    SELECT session_id,run_id,stage_id,round_number FROM person_flow_runs WHERE flow_id=?
    UNION ALL
    SELECT s.session_id,c.run_id,s.id,NULL FROM person_stage_confirmations c
      JOIN person_stages s ON s.id=c.stage_id WHERE s.flow_id=?
    UNION ALL
    SELECT s.session_id,m.run_marker,s.id,r.round_number FROM person_stage_results r
      JOIN person_stages s ON s.id=r.stage_id JOIN messages m ON m.id=r.result_message_id AND m.session_id=s.session_id
      WHERE s.flow_id=? AND COALESCE(m.run_marker,'')!=''
    UNION ALL
    SELECT s.session_id,m.run_marker,s.id,NULL FROM person_stages s
      JOIN messages m ON m.id=s.result_message_id AND m.session_id=s.session_id
      WHERE s.flow_id=? AND COALESCE(m.run_marker,'')!=''
  ), runs AS (
    SELECT session_id,run_id,MAX(stage_id) AS stage_id,MAX(round_number) AS round_number
      FROM known_runs WHERE run_id!='' GROUP BY session_id,run_id
  ), linked_messages AS (
    SELECT m.id,r.stage_id,r.round_number FROM runs r JOIN messages m ON m.session_id=r.session_id AND m.run_marker=r.run_id
    UNION ALL
    SELECT m.id,s.id,r.round_number FROM person_stage_results r JOIN person_stages s ON s.id=r.stage_id
      JOIN messages m ON m.id=r.result_message_id AND m.session_id=s.session_id WHERE s.flow_id=?
    UNION ALL
    SELECT m.id,s.id,NULL FROM person_stages s JOIN messages m ON m.id=s.result_message_id AND m.session_id=s.session_id WHERE s.flow_id=?
  ), unique_messages AS (
    SELECT id,MAX(stage_id) AS stage_id,MAX(round_number) AS round_number FROM linked_messages GROUP BY id
  ) SELECT m.*,c.title AS session_title,c.bot_type,r.stage_id,r.round_number
    FROM unique_messages r JOIN messages m ON m.id=r.id
    JOIN sessions c ON c.id=m.session_id AND CAST(c.studio_user_id AS TEXT)=?
    WHERE (?=0 OR m.id<?) AND m.role IN ('user','assistant')
    ORDER BY m.id DESC LIMIT ?`).all(flowId,flowId,flowId,flowId,flowId,flowId,String(userId),beforeId,beforeId,limit+1) as unknown as PersonFlowMessageRow[]
  const revisions = db.prepare(`SELECT id,history_revision FROM sessions WHERE id=? OR id IN
    (SELECT session_id FROM person_stages WHERE flow_id=?) ORDER BY id`).all(flow.creator_session_id,flowId)
  return { flow, rows:rows.slice(0,limit).reverse(), hasMore:rows.length>limit, historyKey:JSON.stringify(revisions) }
}
