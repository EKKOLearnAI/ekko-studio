import type { DatabaseSync } from 'node:sqlite'
import { getDb } from '../infrastructure/database'
import { StudioError } from '../contracts/plugins'

export interface WorkflowRequestIdentity { ownerId: string; profileId: string; key: string; hash: string }

/** The binding is committed with the existing workflow Run, never before it. */
export class WorkflowRequestStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS studio_workflow_requests (
      owner_id TEXT NOT NULL, profile_id TEXT NOT NULL, request_key TEXT NOT NULL,
      input_hash TEXT NOT NULL, run_id TEXT NOT NULL,
      PRIMARY KEY(owner_id, profile_id, request_key)
    )`)
  }
  find(request: WorkflowRequestIdentity): string | null {
    const row = this.db.prepare('SELECT input_hash, run_id FROM studio_workflow_requests WHERE owner_id=? AND profile_id=? AND request_key=?')
      .get(request.ownerId, request.profileId, request.key) as { input_hash: string; run_id: string } | undefined
    if (!row) return null
    if (row.input_hash !== request.hash) throw new StudioError('REVISION_CONFLICT', 'Workflow request key already identifies different input')
    return row.run_id
  }
  bind(request: WorkflowRequestIdentity, runId: string): void {
    this.db.prepare('INSERT INTO studio_workflow_requests VALUES (?, ?, ?, ?, ?)').run(request.ownerId, request.profileId, request.key, request.hash, runId)
  }
  transaction<T>(work: () => T): T {
    this.db.exec('SAVEPOINT studio_workflow_request')
    try { const result = work(); this.db.exec('RELEASE studio_workflow_request'); return result }
    catch (error) { this.db.exec('ROLLBACK TO studio_workflow_request; RELEASE studio_workflow_request'); throw error }
  }
}

export function workflowRequestStore(): WorkflowRequestStore {
  const db = getDb()
  if (!db) throw new StudioError('RUNTIME_UNAVAILABLE', 'Idempotent workflows require SQLite')
  return new WorkflowRequestStore(db)
}
