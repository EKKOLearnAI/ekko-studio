import type { PersonExecution, PersonTaskOrigin } from '../../contracts/person'
import { personDb, personTransaction, getPersonTask, getPersonExecution, personEvent } from '../../repositories/person-store'
import { getPersonAcceptance, setPersonAcceptance } from '../../repositories/person-acceptance-store'
import { applyPersonTask } from './tasks'
import { continuePersonTask } from './task-chat'
import { automaticAcceptance } from './bot-acceptance'
import { requirePersonWorkspace } from './workspace'

/** Persisted states are the outbox: a committed transition is never dispatched a second time. */
export async function advanceAutomaticAcceptances() {
  const rows=personDb().prepare(`SELECT e.* FROM person_executions e JOIN person_acceptance a ON a.execution_id=e.id
    JOIN session_tasks t ON t.id=e.task_id WHERE a.orchestration='bot_tasks'
    AND json_extract(a.snapshot_json,'$.requirements.acceptance.progression')='automatic'
    AND a.state IN ('awaiting_dispatch','repair_required') AND e.state='finished' AND t.status='open'
    AND t.requirements_revision=e.requirements_revision
    AND e.rowid=(SELECT MAX(rowid) FROM person_executions WHERE task_id=t.id) ORDER BY a.updated_at LIMIT 20`).all() as unknown as PersonExecution[]
  for (const run of rows) {
    const receipt=getPersonAcceptance(run.id)!,task=getPersonTask(run.owner_user_id,run.task_id)
    if (task.execution_id!==run.id) continue
    try {
      requirePersonWorkspace(run.workspace)
      const saved=personDb().prepare('SELECT origin_json FROM person_deliveries WHERE execution_id=?').get(run.id)
      const origin=saved ? JSON.parse(String(saved.origin_json)) as PersonTaskOrigin : undefined
      if (receipt.state==='awaiting_dispatch') {
        await applyPersonTask(run.owner_user_id,{action:'verify',task_id:task.id,expected_revision:task.revision,expected_execution_id:run.id,
          idempotency_key:`auto-verify:${run.id}:${receipt.attempt}`},undefined,origin)
      } else {
        await continuePersonTask(run.owner_user_id,task.id,{expected_revision:task.revision,expected_execution_id:run.id,
          idempotency_key:`auto-repair:${run.id}:${receipt.attempt}`,input:[{type:'text',text:'Fix the unresolved product defects in the recorded independent review. Preserve the original scope and deliver updated artifacts for independent re-verification.'}]},origin)
      }
      personEvent(run,'acceptance.automatic_advanced',{from:receipt.state})
    } catch (error) {
      // User stop, a manual transition or another scheduler already won the revision fence.
      const actual=getPersonTask(run.owner_user_id,run.task_id),current=getPersonAcceptance(run.id)
      if (actual.execution_id!==run.id || actual.status!=='open' || current?.state!==receipt.state || !automaticAcceptance(current)) continue
      personTransaction(() => {
        setPersonAcceptance(getPersonExecution(run.owner_user_id,run.id),'blocked',`Automatic acceptance could not advance: ${error instanceof Error ? error.message : String(error)}`)
        personDb().prepare("UPDATE person_deliveries SET state='pending',error='',updated_at=? WHERE execution_id=? AND state IN ('waiting','handled')").run(Date.now(),run.id)
      })
    }
  }
}
