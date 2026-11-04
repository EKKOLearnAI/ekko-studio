import { personDb, personTransaction } from '../../repositories/person-store'
import { requirePersonSession } from '../../repositories/person-session-store'
import { assertPersonFlowReport, finishPersonFlowReport, getPersonFlowReport, recordFlowReportEvent, retryPersonFlowReport } from '../../repositories/person-flow-report-store'
import type { PersonFlowReport, PersonFlowReportIdentity } from '../../contracts/person-stage'
import { personRuntime } from '../../public/person-runtime'
import { requirePersonWorkspace } from './workspace'
import { personUser } from './catalog'

/** Re-read originals under current ownership before every request; the snapshot grants no authority. */
export function personFlowReportContext(userId: number, identity: PersonFlowReportIdentity, sessionId: string) {
  const row = assertPersonFlowReport(userId,identity,sessionId)
  const snapshot = JSON.parse(row.snapshot_json) as {
    title: string; goal: string; workspace: string
    sources: Array<{ session_id: string; result_message_id: number; return_expectation: string }>
  }
  requirePersonWorkspace(snapshot.workspace)
  const limit = Math.floor(24000/Math.max(1,snapshot.sources.length))
  const sources = snapshot.sources.map(source => {
    requirePersonSession(userId,source.session_id)
    const message = personDb().prepare("SELECT content FROM messages WHERE id=? AND session_id=? AND role='assistant' AND finish_reason IN ('stop','end_turn','completed')")
      .get(source.result_message_id,source.session_id)
    if (!message || !String(message.content).trim()) throw new Error('Flow result is unavailable')
    return { ...source,content:String(message.content).slice(0,limit),truncated:String(message.content).length>limit }
  })
  return { ...snapshot,flow_id:row.flow_id,generation:row.generation,sources }
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
