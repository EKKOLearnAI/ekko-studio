import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { refreshCompletedRunUsage } from './run-usage-store'

export type RepairUsageRow = Record<string, SQLInputValue> & {
  id: number; session_id: string; run_id: string; parent_run_id: string; created_at: number
  source: string; agent: string; model: string; provider: string; profile: string
}
export function usageRepairSnapshot(db: DatabaseSync, sessionId: string): RepairUsageRow[] {
  return db.prepare('SELECT * FROM session_usage WHERE session_id = ? ORDER BY id').all(sessionId) as RepairUsageRow[]
}
export function usageRepairHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

/** Caller owns the backup. Recheck the complete session ledger under a write lock. */
export function applyUsageRepair(db: DatabaseSync, sessionId: string, before: RepairUsageRow[], replacements: Array<{ oldId: number; rows: RepairUsageRow[] }>) {
  db.exec('BEGIN IMMEDIATE')
  try {
    if (usageRepairHash(usageRepairSnapshot(db, sessionId)) !== usageRepairHash(before)) throw new Error('Usage changed after preview; generate a new preview')
    const parents = new Set<string>()
    for (const replacement of replacements) {
      const old = before.find(row => row.id === replacement.oldId)
      if (!old || !replacement.rows.length) throw new Error('Invalid replacement')
      db.prepare('DELETE FROM session_usage WHERE id = ? AND session_id = ?').run(old.id, sessionId)
      for (const row of replacement.rows) {
        if (row.session_id !== sessionId || row.parent_run_id !== old.parent_run_id) throw new Error('Invalid usage owner')
        const columns = Object.keys(old).filter(key => key !== 'id')
        db.prepare(`INSERT INTO session_usage (${columns.map(key => `"${key.replaceAll('"', '""')}"`).join(',')}) VALUES (${columns.map(() => '?').join(',')})`)
          .run(...columns.map(key => row[key]))
      }
      if (old.parent_run_id) parents.add(old.parent_run_id)
    }
    for (const parent of parents) refreshCompletedRunUsage(sessionId, parent, db)
    db.exec('COMMIT')
  } catch (error) { db.exec('ROLLBACK'); throw error }
}
