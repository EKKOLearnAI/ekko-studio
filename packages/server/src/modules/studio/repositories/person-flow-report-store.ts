import { randomUUID } from 'node:crypto'
import type { PersonConversationFlow, PersonFlowReportIdentity, PersonFlowReport } from '../contracts/person-stage'
import { personError } from '../contracts/person'
import { personDb, personTransaction } from './person-store'
import { requirePersonSession } from './person-session-store'
import { personUpdated } from './person-updates'

export const FLOW_REPORT_MAX_ATTEMPTS = 5

export function getPersonFlowReport(userId: number, id: string) {
  const row = personDb().prepare('SELECT * FROM person_flow_reports WHERE id=? AND owner_user_id=?').get(id,userId)
  if (!row) throw personError('Flow completion report not found',404)
  return row as unknown as PersonFlowReport
}

export function recordFlowReportEvent(row: PersonFlowReport, event: string) {
  personDb().prepare(`INSERT INTO person_flow_report_events(report_id,event,attempt,run_id,message_id,error,created_at)
    VALUES(?,?,?,?,?,?,?)`).run(row.id,event,row.attempts,row.run_id,row.result_message_id,row.error,Date.now())
  personUpdated(row.owner_user_id)
}

/** Called in the same transaction as flow completion. Originals remain the source of result text. */
export function enqueuePersonFlowReport(flow: PersonConversationFlow, finalSessionId: string, messageId: number, runId: string) {
  const db = personDb(), now = Date.now(), id = randomUUID()
  const sources = db.prepare('SELECT session_id,result_message_id,return_expectation FROM person_stages WHERE flow_id=? ORDER BY position').all(flow.id)
  // A creator in a parallel final group has only written its own branch result.
  const self = finalSessionId === flow.creator_session_id
    && flow.stages.filter(stage => stage.group_position === flow.current_position).length === 1
  const inserted = db.prepare(`INSERT OR IGNORE INTO person_flow_reports
    (id,owner_user_id,flow_id,generation,session_id,snapshot_json,state,run_id,result_message_id,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(id,flow.owner_user_id,flow.id,flow.generation,flow.creator_session_id,
      JSON.stringify({ title:flow.title,goal:flow.goal,workspace:flow.workspace,sources }),
      self ? 'delivered' : 'pending',self ? runId : '',self ? messageId : null,now,now)
  if (inserted.changes) {
    const row = getPersonFlowReport(flow.owner_user_id,id)
    recordFlowReportEvent(row,'flow_completed')
    recordFlowReportEvent(row,self ? 'creator_report_completed' : 'creator_report_pending')
  }
}

export function assertPersonFlowReport(userId: number, identity: PersonFlowReportIdentity, sessionId?: string) {
  const row = getPersonFlowReport(userId,identity.id), db = personDb()
  const flow = db.prepare('SELECT * FROM person_flows WHERE id=? AND owner_user_id=?').get(row.flow_id,userId)
  if (!flow || flow.state !== 'completed' || flow.generation !== row.generation || flow.creator_session_id !== row.session_id
    || row.attempts !== identity.attempt || !['queued','starting','running'].includes(row.state))
    throw personError('Flow completion report was handled or superseded',409)
  if (sessionId && row.session_id !== sessionId) throw personError('Flow report belongs to another conversation',403)
  requirePersonSession(userId,row.session_id)
  return row
}

/** Validate the saved message, never a runtime's success flag alone. */
function savedFinal(row: PersonFlowReport, messageId?: unknown) {
  if (!row.run_id) return undefined
  return personDb().prepare(`SELECT id FROM messages WHERE session_id=? AND run_marker=? AND role='assistant'
    AND finish_reason IN ('stop','end_turn','completed') AND COALESCE(tool_calls,'') IN ('','[]','null')
    AND length(trim(content))>0 AND (?='' OR CAST(id AS TEXT)=?) ORDER BY id DESC LIMIT 1`)
    .get(row.session_id,row.run_id,String(messageId || ''),String(messageId || ''))
}

export function startPersonFlowReport(userId: number, identity: PersonFlowReportIdentity, sessionId: string, runId: string) {
  personTransaction(() => {
    const row = assertPersonFlowReport(userId,identity,sessionId)
    if (row.state === 'running' && row.run_id === runId) return
    if (!runId || row.state !== 'starting') throw personError('Flow report run already started',409)
    personDb().prepare("UPDATE person_flow_reports SET state='running',run_id=?,updated_at=? WHERE id=?").run(runId,Date.now(),row.id)
    recordFlowReportEvent(getPersonFlowReport(userId,row.id),'creator_report_started')
  })
}

export function retryPersonFlowReport(row: PersonFlowReport, error: string, paused = false) {
  const state = paused ? 'paused' : row.attempts >= FLOW_REPORT_MAX_ATTEMPTS ? 'failed' : 'pending'
  personDb().prepare(`UPDATE person_flow_reports SET state=?,error=?,next_attempt_at=?,updated_at=? WHERE id=?`)
    .run(state,error.slice(0,1000),Date.now()+(paused ? 3000 : Math.min(60000,1000*2**row.attempts)),Date.now(),row.id)
  recordFlowReportEvent(getPersonFlowReport(row.owner_user_id,row.id),paused ? 'creator_report_paused' : 'creator_report_failed')
}

export function pausePersonFlowReport(userId: number, identity: PersonFlowReportIdentity) {
  personTransaction(() => {
    const row = getPersonFlowReport(userId,identity.id)
    if (row.attempts === identity.attempt && ['queued','starting','running'].includes(row.state))
      retryPersonFlowReport(row,'Background reporting is paused until the next user message',true)
  })
}

/** Persist Stop before waiting for an active model's terminal event. */
export function pausePersonFlowReportsForSession(userId: number, sessionId: string) {
  personTransaction(() => {
    const rows = personDb().prepare(`SELECT * FROM person_flow_reports WHERE owner_user_id=? AND session_id=?
      AND state IN ('pending','queued','starting','running')`).all(userId,sessionId) as unknown as PersonFlowReport[]
    for (const row of rows) retryPersonFlowReport(row,'Background reporting is paused until the next user message',true)
  })
}

export function resumePersonFlowReports(userId: number, sessionId: string) {
  requirePersonSession(userId,sessionId)
  personDb().prepare("UPDATE person_flow_reports SET state='pending',next_attempt_at=0,updated_at=? WHERE owner_user_id=? AND session_id=? AND state='paused'")
    .run(Date.now(),userId,sessionId)
}

export function cancelPersonFlowReport(userId: number, identity: PersonFlowReportIdentity) {
  personTransaction(() => {
    const row = getPersonFlowReport(userId,identity.id)
    if (row.attempts !== identity.attempt || !['queued','starting','running'].includes(row.state)) return
    personDb().prepare("UPDATE person_flow_reports SET state='cancelled',error='Queued flow report removed',updated_at=? WHERE id=?").run(Date.now(),row.id)
    recordFlowReportEvent(getPersonFlowReport(userId,row.id),'creator_report_cancelled')
  })
}

/** Caller owns the history-clear transaction. Never revive cleared conversations. */
export function cancelPersonFlowReportsForSession(userId: number, sessionId: string) {
  const db = personDb()
  const rows = db.prepare(`SELECT * FROM person_flow_reports WHERE owner_user_id=?
    AND state IN ('pending','paused','queued','starting','running') AND (session_id=? OR EXISTS(
      SELECT 1 FROM json_each(snapshot_json,'$.sources') source WHERE json_extract(source.value,'$.session_id')=?))`)
    .all(userId,sessionId,sessionId) as unknown as PersonFlowReport[]
  for (const row of rows) {
    db.prepare("UPDATE person_flow_reports SET state='cancelled',error='Conversation history cleared or removed',updated_at=? WHERE id=?").run(Date.now(),row.id)
    recordFlowReportEvent(getPersonFlowReport(userId,row.id),'creator_report_cancelled')
  }
}

/** A live creator querying this completed flow can fulfill its pending report now.
 * Incrementing the attempt fences any older process-local queue item. */
export function claimPersonFlowReportForRun(userId: number, flowId: string, sessionId: string, runId: string) {
  if (!runId) return false
  return personTransaction(() => {
    requirePersonSession(userId,sessionId)
    const row = personDb().prepare(`SELECT r.* FROM person_flow_reports r JOIN person_flows f ON f.id=r.flow_id
      WHERE r.owner_user_id=? AND r.flow_id=? AND r.session_id=? AND f.creator_session_id=r.session_id
      AND f.state='completed' AND f.generation=r.generation AND r.state IN ('pending','queued','paused','failed')`)
      .get(userId,flowId,sessionId) as unknown as PersonFlowReport | undefined
    if (!row) return false
    personDb().prepare("UPDATE person_flow_reports SET state='running',attempts=attempts+1,run_id=?,error='',updated_at=? WHERE id=?").run(runId,Date.now(),row.id)
    recordFlowReportEvent(getPersonFlowReport(userId,row.id),'creator_report_started')
    return true
  })
}

export function personFlowReportsForRun(userId: number, sessionId: string, runId: string) {
  return personDb().prepare("SELECT * FROM person_flow_reports WHERE owner_user_id=? AND session_id=? AND run_id=? AND state='running'")
    .all(userId,sessionId,runId) as unknown as PersonFlowReport[]
}

export function finishPersonFlowReport(userId: number, identity: PersonFlowReportIdentity, messageId: unknown, ok: boolean, error = '') {
  return personTransaction(() => {
    let row: PersonFlowReport
    try { row = assertPersonFlowReport(userId,identity) } catch (error) {
      const actual = getPersonFlowReport(userId,identity.id)
      if (actual.attempts === identity.attempt && ['queued','starting','running'].includes(actual.state)) {
        personDb().prepare("UPDATE person_flow_reports SET state='cancelled',error=?,updated_at=? WHERE id=?").run(String(error).slice(0,1000),Date.now(),actual.id)
        recordFlowReportEvent(getPersonFlowReport(userId,actual.id),'creator_report_cancelled')
      }
      return false
    }
    const message = ok ? savedFinal(row,messageId) : undefined
    if (!message) {
      retryPersonFlowReport(row,error || 'Flow summary has no saved final assistant reply')
      return false
    }
    personDb().prepare("UPDATE person_flow_reports SET state='delivered',result_message_id=?,error='',updated_at=? WHERE id=?")
      .run(message.id,Date.now(),row.id)
    recordFlowReportEvent(getPersonFlowReport(userId,row.id),'creator_report_completed')
    return true
  })
}

/** Startup only: process-local queued work was lost. Saved replies win over replay. */
export function recoverPersonFlowReports() {
  const rows = personDb().prepare("SELECT * FROM person_flow_reports WHERE state IN ('queued','starting','running')").all() as unknown as PersonFlowReport[]
  for (const row of rows) {
    const message = savedFinal(row)
    if (message) finishPersonFlowReport(row.owner_user_id,{ id:row.id,attempt:row.attempts },message.id,true)
    else finishPersonFlowReport(row.owner_user_id,{ id:row.id,attempt:row.attempts },undefined,false,'Studio stopped before the flow summary was saved')
  }
}

export const personFlowReportQueueId = (identity: PersonFlowReportIdentity) => `person-flow-report:${identity.id}:${identity.attempt}`
export function parsePersonFlowReportQueueId(value?: string): PersonFlowReportIdentity | undefined {
  const match = /^person-flow-report:([^:]+):([1-9]\d*)$/.exec(value || '')
  return match ? { id:match[1],attempt:Number(match[2]) } : undefined
}
