import { getDb, isSqliteAvailable } from '../infrastructure/database'
import { TASK_PLANS_TABLE } from '../infrastructure/database/schemas'
import type { TaskPlanSnapshot } from '../contracts/task-plan'

export function saveTaskPlan(plan: TaskPlanSnapshot): void {
  if (!isSqliteAvailable()) throw new Error('Task plan storage is unavailable.')
  const result = getDb()!.prepare(`
    INSERT INTO ${TASK_PLANS_TABLE} (session_id, plan_id, run_id, revision, execution_state, snapshot, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id, plan_id) DO UPDATE SET
      revision = excluded.revision, execution_state = excluded.execution_state, snapshot = excluded.snapshot
    WHERE excluded.revision > ${TASK_PLANS_TABLE}.revision
  `).run(plan.session_id, plan.plan_id, plan.run_id, plan.revision, plan.execution_state, JSON.stringify(plan), plan.created_at)
  if (!result.changes) throw new Error('Task plan update has an outdated revision.')
}

export function listTaskPlansForPage(
  sessionId: string,
  messages: Array<{ run_marker?: string | null; runMarker?: string | null }>,
  includeLatest = false,
  activeRunId?: string,
): TaskPlanSnapshot[] {
  if (!isSqliteAvailable()) return []
  const runs = new Set(messages.map(message => message.run_marker || message.runMarker).filter((run): run is string => !!run))
  if (activeRunId) runs.add(activeRunId)
  const db = getDb()!
  const snapshots: TaskPlanSnapshot[] = []
  const byRun = db.prepare(`SELECT snapshot FROM ${TASK_PLANS_TABLE} WHERE session_id = ? AND run_id = ?`)
  for (const run of runs) {
    for (const row of byRun.all(sessionId, run) as Array<{ snapshot: string }>) snapshots.push(JSON.parse(row.snapshot))
  }
  if (includeLatest) {
    const row = db.prepare(`SELECT snapshot FROM ${TASK_PLANS_TABLE} WHERE session_id = ? ORDER BY created_at DESC, plan_id DESC LIMIT 1`)
      .get(sessionId) as { snapshot: string } | undefined
    if (row) {
      const latest: TaskPlanSnapshot = JSON.parse(row.snapshot)
      if (!snapshots.some(plan => plan.plan_id === latest.plan_id)) snapshots.push(latest)
    }
  }
  return snapshots.sort((a, b) => a.created_at - b.created_at)
}

/** Native runs and MCP plan contexts cannot survive a Studio process restart. Bootstrap only. */
export function interruptOrphanedTaskPlans(): void {
  if (!isSqliteAvailable()) return
  const db = getDb()!
  db.exec('BEGIN')
  try {
    const rows = db.prepare(`SELECT snapshot FROM ${TASK_PLANS_TABLE} WHERE execution_state = 'running'`).all() as Array<{ snapshot: string }>
    for (const row of rows) {
      const plan: TaskPlanSnapshot = JSON.parse(row.snapshot)
      saveTaskPlan({
        ...plan, revision: plan.revision + 1, execution_state: 'interrupted', updated_at: Date.now(),
        plan: plan.plan.map(step => ({ ...step, status: step.status === 'in_progress' ? 'pending' : step.status })),
      })
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
