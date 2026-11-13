import type { PersonAcceptance, PersonAcceptanceState, PersonAcceptanceAttempt, PersonAcceptanceReport } from '../contracts/person-acceptance'
import type { PersonExecution } from '../contracts/person'
import { personDb, getPersonTask, personEvent } from './person-store'
import { personUpdated } from './person-updates'

export function getPersonAcceptance(executionId: string): PersonAcceptance | undefined {
  return personDb().prepare('SELECT * FROM person_acceptance WHERE execution_id=?').get(executionId) as unknown as PersonAcceptance | undefined
}
export function personAcceptanceDetail(userId: number, taskId: string, executionId?: string) {
  const task = getPersonTask(userId, taskId)
  const id = executionId || task.execution_id
  if (!id) return null
  const receipt = personDb().prepare('SELECT a.* FROM person_acceptance a JOIN person_executions e ON e.id=a.execution_id WHERE a.execution_id=? AND e.task_id=? AND e.owner_user_id=?').get(id,taskId,userId) as unknown as PersonAcceptance | undefined
  if (!receipt) return null
  return { ...receipt, verification_task_id: personDb().prepare('SELECT verification_task_id FROM person_acceptance_tasks WHERE development_task_id=?').get(taskId)?.verification_task_id || null,
    snapshot: JSON.parse(String(receipt.snapshot_json)), attempts: (personDb().prepare("SELECT v.* FROM person_acceptance_attempts v JOIN person_acceptance a ON a.execution_id=v.execution_id WHERE a.execution_id=? OR (?!='' AND a.cycle_id=?) ORDER BY ordinal").all(id,String(receipt.cycle_id || ''),String(receipt.cycle_id || '')) as unknown as PersonAcceptanceAttempt[])
    .map(row => ({ ...row, report: row.report_json ? JSON.parse(row.report_json) as PersonAcceptanceReport : null, evidence: JSON.parse(row.evidence_json) })) }
}
export function setPersonAcceptance(run: PersonExecution, state: PersonAcceptanceState, reason = '') {
  personDb().prepare('UPDATE person_acceptance SET state=?,reason=?,updated_at=? WHERE execution_id=?').run(state, reason, Date.now(),run.id)
  personEvent(run, `acceptance.${state}`, { reason })
  if(run.occurrence_id&&['blocked','failed','interrupted'].includes(state)&&getPersonAcceptance(run.id)?.orchestration==='bot_tasks')personDb().prepare('UPDATE person_occurrences SET state=? WHERE id=?').run(state==='interrupted'?'interrupted':'failed',run.occurrence_id)
  personUpdated(run.owner_user_id)
}
export function interruptPersonAcceptance(run: PersonExecution, reason: string) {
  const a = getPersonAcceptance(run.id)
  if (!a || ['failed','blocked','interrupted'].includes(a.state)) return
  if (a.state === 'passed' && personDb().prepare('SELECT state FROM person_executions WHERE id=?').get(run.id)?.state === 'finished') return
  setPersonAcceptance(run,'interrupted',reason)
  personDb().prepare("UPDATE person_acceptance_attempts SET state='interrupted',error=?,updated_at=? WHERE execution_id=? AND state='running'").run(reason,Date.now(),run.id)
}
export function personAcceptanceSessions(run: PersonExecution) {
  const current = getPersonAcceptance(run.id)?.active_session_id
  return [...new Set([run.session_id, ...(current ? [current] : [])])]
}
/** In-flight native work cannot safely be replayed. Fence it, retain receipts and require explicit continuation. */
export function recoverPersonAcceptances() {
  const runs = personDb().prepare("SELECT e.* FROM person_executions e JOIN person_acceptance a ON a.execution_id=e.id WHERE e.state IN ('starting','running','waiting_person','waiting_user','waiting_approval')").all() as unknown as PersonExecution[]
  for (const run of runs) {
    interruptPersonAcceptance(run,'Studio restarted during acceptance; inspect evidence and continue the original task explicitly')
    personDb().prepare("UPDATE person_executions SET state='stopping',generation=generation+1,error='Acceptance interrupted by restart',updated_at=? WHERE id=?").run(Date.now(),run.id)
  }
}
