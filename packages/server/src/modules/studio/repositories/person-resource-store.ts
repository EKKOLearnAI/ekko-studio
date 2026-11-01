import { personDb, personTransaction, getPersonTask, personSettings } from './person-store'
import { personRequirements } from '../contracts/person-flow'
import type { PersonExecution } from '../contracts/person'
import { relative, isAbsolute, sep } from 'node:path'
import { realpathSync } from 'node:fs'

function contains(root: string, value: string) {
  const local = relative(root, value)
  return !isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`)
}
function conflicts(a: string, b: string) {
  if (a.startsWith('path:') && b.startsWith('path:')) return contains(a.slice(5), b.slice(5)) || contains(b.slice(5), a.slice(5))
  return a === b
}
/** Claims are not time-expired. Only acknowledged process termination releases them. */
export function claimPersonResources(run: PersonExecution, start = false) {
  return personTransaction(() => {
    const db = personDb()
    if (start && !db.prepare("SELECT 1 FROM person_executions WHERE id=? AND state='queued' AND generation=?").get(run.id, run.generation)) return false
    if (start) {
      const busy = "state IN ('starting','running','waiting_person','waiting_user','waiting_approval','stopping')"
      const account = Number(db.prepare(`SELECT COUNT(*) AS n FROM person_executions WHERE owner_user_id=? AND ${busy}`).get(run.owner_user_id)!.n)
      const total = Number(db.prepare(`SELECT COUNT(*) AS n FROM person_executions WHERE ${busy}`).get()!.n)
      if (account >= personSettings(run.owner_user_id).settings.maxConcurrentTasks || total >= 12) return false
    }
    const task = getPersonTask(run.owner_user_id, run.task_id)
    const contract = personRequirements(task).contract
    for (const id of contract?.dependencies || []) {
      const dependency = getPersonTask(run.owner_user_id, id)
      if (dependency.status !== 'completed' || !dependency.completion_evidence) return false
    }
    const mode = contract?.access_mode || 'write'
    let workspace = task.workspace
    try { workspace = realpathSync(workspace) } catch { /* Execution preflight reports missing directories. */ }
    const keys = [`path:${workspace}`, ...(contract?.resources || []).map(key => `resource:${key}`)]
    if (contract?.git) keys.push(`branch:${contract.git.common_directory}:${contract.git.branch}`)
    const claims = db.prepare('SELECT execution_id,resource,mode FROM person_resource_claims WHERE execution_id!=?').all(run.id)
    if (claims.some(claim => (claim.mode === 'write' || mode === 'write') && keys.some(key => conflicts(key, String(claim.resource))))) return false
    for (const key of keys) db.prepare('INSERT OR IGNORE INTO person_resource_claims VALUES (?,?,?)').run(run.id, key, mode)
    if (start) db.prepare("UPDATE person_executions SET state='starting',generation=generation+1,lease_until=?,updated_at=? WHERE id=?")
      .run(Date.now() + 90_000, Date.now(), run.id)
    return true
  })
}
export function releasePersonResources(executionId: string) {
  personDb().prepare('DELETE FROM person_resource_claims WHERE execution_id=?').run(executionId)
}
