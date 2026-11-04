import { personDb, personTransaction } from '../../repositories/person-store'
import { requirePersonSession } from '../../repositories/person-session-store'
import { assertPersonFlowReport, finishPersonFlowReport, getPersonFlowReport, recordFlowReportEvent, retryPersonFlowReport, type PersonFlowReportSnapshot } from '../../repositories/person-flow-report-store'
import { getPersonFlow } from '../../repositories/person-stage-store'
import type { PersonFlowReport, PersonFlowReportIdentity } from '../../contracts/person-stage'
import { personRuntime } from '../../public/person-runtime'
import { requirePersonWorkspace } from './workspace'
import { personUser } from './catalog'
import { personError } from '../../contracts/person'

/** Re-read originals under current ownership before every request; the snapshot grants no authority. */
function sourcePage(userId: number, snapshot: PersonFlowReportSnapshot, offset: number) {
  requirePersonWorkspace(snapshot.workspace)
  for (const sessionId of new Set(snapshot.sources.map(source=>source.session_id))) requirePersonSession(userId,sessionId)
  // Validate the entire manifest before a request, including sources outside this bounded page.
  const unavailable = personDb().prepare(`SELECT 1 FROM json_each(?) source LEFT JOIN messages m
    ON m.id=json_extract(source.value,'$.result_message_id') AND m.session_id=json_extract(source.value,'$.session_id')
    WHERE m.id IS NULL OR m.role!='assistant' OR COALESCE(m.finish_reason,'') NOT IN ('stop','end_turn','completed')
      OR length(trim(m.content))=0 OR COALESCE(m.tool_calls,'') NOT IN ('','[]','null') LIMIT 1`).get(JSON.stringify(snapshot.sources))
  if (unavailable) throw new Error('Flow result is unavailable')
  const selected = snapshot.sources.slice(offset,offset+10)
  const limit = Math.floor(6000/Math.max(1,selected.length))
  const sources = selected.map(source => {
    const expectation = source.return_expectation ?? snapshot.stage_expectations?.[source.stage_id || ''] ?? ''
    const message = personDb().prepare('SELECT substr(content,1,?) AS content,length(content) AS size FROM messages WHERE id=? AND session_id=?')
      .get(limit,source.result_message_id,source.session_id)!
    return { ...source,return_expectation:expectation.slice(0,300),return_expectation_truncated:expectation.length>300,
      round_number:source.round_number ?? 1,content:String(message.content),truncated:Number(message.size)>limit }
  })
  return { sources,total_sources:snapshot.sources.length,next_source_offset:offset+sources.length<snapshot.sources.length ? offset+sources.length : null }
}

export function personFlowReportContext(userId: number, identity: PersonFlowReportIdentity, sessionId: string) {
  const row = assertPersonFlowReport(userId,identity,sessionId)
  const {sources,stage_expectations,...snapshot} = JSON.parse(row.snapshot_json) as PersonFlowReportSnapshot
  return { ...snapshot,flow_id:row.flow_id,generation:row.generation,source_scope:'all_rounds',
    ...sourcePage(userId,{...snapshot,stage_expectations,sources},0) }
}

/** Flow query pagination keeps every original reference accessible without an unbounded tool result. */
export function personFlowReportSources(userId: number, flowId: string, offset: number) {
  if (!Number.isSafeInteger(offset) || offset<0) throw personError('Invalid source offset')
  const flow = getPersonFlow(userId,flowId)
  if (!flow.completion_report) return {sources:[],total_sources:0,next_source_offset:null}
  const row = getPersonFlowReport(userId,flow.completion_report.id)
  return sourcePage(userId,JSON.parse(row.snapshot_json),offset)
}

export async function deliverPersonFlowReports() {
  const db = personDb()
  const rows = db.prepare("SELECT * FROM person_flow_reports WHERE state='pending' AND next_attempt_at<=? ORDER BY created_at LIMIT 20")
    .all(Date.now()) as unknown as PersonFlowReport[]
  for (const candidate of rows) {
    const row = personTransaction(() => {
      // Paused admissions do not consume retry budget.
      const claim = db.prepare(`UPDATE person_flow_reports SET state='queued',attempts=attempts+1,run_id='',error='',updated_at=?
        WHERE id=? AND state='pending' AND next_attempt_at<=?`).run(Date.now(),candidate.id,Date.now())
      if (!claim.changes) return undefined
      const row = getPersonFlowReport(candidate.owner_user_id,candidate.id)
      recordFlowReportEvent(row,'creator_report_queued')
      return row
    })
    if (!row) continue
    const identity = { id:row.id,attempt:row.attempts }
    try {
      personFlowReportContext(row.owner_user_id,identity,row.session_id)
      const user = personUser(row.owner_user_id), deliver = personRuntime().deliverFlowReport
      if (!deliver) throw new Error('Flow completion report runtime unavailable')
      await deliver({ user,identity,sessionId:row.session_id })
    } catch (error) {
      // A synchronous runtime may already have settled the report.
      const latest = getPersonFlowReport(row.owner_user_id,row.id)
      if (latest.attempts !== row.attempts || !['queued','starting','running'].includes(latest.state)) continue
      try { assertPersonFlowReport(row.owner_user_id,identity,row.session_id) }
      catch { finishPersonFlowReport(row.owner_user_id,identity,undefined,false,String(error)); continue }
      const paused = (error as { code?: string }).code === 'FLOW_REPORT_PAUSED'
      if (paused) db.prepare('UPDATE person_flow_reports SET attempts=attempts-1 WHERE id=?').run(row.id)
      retryPersonFlowReport(getPersonFlowReport(row.owner_user_id,row.id),String(error),paused)
    }
  }
}
