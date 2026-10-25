import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { StudioError, type AgentManagementOperation, type AgentManagementOperationStatus, type AgentProviderRef, type ProcessExit } from '../contracts/plugins'

export interface ManagementOperationRecord extends AgentManagementOperation { ownerId: string; profileId: string; idempotencyKey: string; outputSequence: number }
interface Row {
  action: 'login' | 'install'
  id: string; instance_id: string; owner_id: string; profile_id: string; config_revision: number; provider_json: string; request_key: string
  status: AgentManagementOperationStatus; created_at: number; updated_at: number; expires_at: number; error_code: string | null; exit_json: string | null; output_sequence: number
}
/** Only operation metadata is durable. Terminal output and input never enter SQLite. */
export class AgentManagementStore {
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS studio_agent_management_operations (
      id TEXT PRIMARY KEY, instance_id TEXT NOT NULL, owner_id TEXT NOT NULL, profile_id TEXT NOT NULL,
      config_revision INTEGER NOT NULL, provider_json TEXT NOT NULL, request_key TEXT NOT NULL,
      status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      error_code TEXT, exit_json TEXT, output_sequence INTEGER NOT NULL DEFAULT 0,
      UNIQUE(owner_id, profile_id, request_key)
    ); CREATE INDEX IF NOT EXISTS studio_agent_management_instance ON studio_agent_management_operations(owner_id, profile_id, instance_id, created_at);`)
    if (!(db.prepare('PRAGMA table_info(studio_agent_management_operations)').all() as Array<{ name: string }>).some(column => column.name === 'action')) {
      db.exec("ALTER TABLE studio_agent_management_operations ADD COLUMN action TEXT NOT NULL DEFAULT 'login'")
    }
  }
  recoverInterrupted() {
    this.db.prepare(`UPDATE studio_agent_management_operations SET status='interrupted', error_code='RUNTIME_UNAVAILABLE', updated_at=? WHERE status IN ('starting','running')`).run(Date.now())
  }
  get(id: string): ManagementOperationRecord | null {
    const row = this.db.prepare('SELECT * FROM studio_agent_management_operations WHERE id=?').get(id) as Row | undefined
    return row ? this.decode(row) : null
  }
  find(ownerId: string, profileId: string, idempotencyKey: string, instanceId: string, revision: number, action: 'login' | 'install' = 'login'): ManagementOperationRecord | null {
    const row = this.db.prepare('SELECT * FROM studio_agent_management_operations WHERE owner_id=? AND profile_id=? AND request_key=?').get(ownerId, profileId, idempotencyKey) as Row | undefined
    if (!row) return null
    if (row.instance_id !== instanceId || row.config_revision !== revision || row.action !== action) throw new StudioError('REVISION_CONFLICT', 'Management request key belongs to different input')
    return this.decode(row)
  }
  create(input: { ownerId: string; profileId: string; instanceId: string; revision: number; provider: AgentProviderRef; idempotencyKey: string; action?: 'login' | 'install' }, lifetimeMs: number) {
    const id = randomUUID(), now = Date.now()
    this.db.prepare(`INSERT INTO studio_agent_management_operations
      (id, instance_id, owner_id, profile_id, config_revision, provider_json, request_key, status, created_at, updated_at, expires_at, action)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'starting', ?, ?, ?, ?)`).run(id, input.instanceId, input.ownerId, input.profileId, input.revision, JSON.stringify(input.provider), input.idempotencyKey, now, now, now + lifetimeMs, input.action || 'login')
    return this.get(id)!
  }
  list(ownerId: string, profileId: string, instanceId: string): ManagementOperationRecord[] {
    return (this.db.prepare('SELECT * FROM studio_agent_management_operations WHERE owner_id=? AND profile_id=? AND instance_id=? ORDER BY created_at DESC LIMIT 32')
      .all(ownerId, profileId, instanceId) as unknown as Row[]).map(row => this.decode(row))
  }
  running(id: string) { this.db.prepare(`UPDATE studio_agent_management_operations SET status='running', updated_at=? WHERE id=? AND status='starting'`).run(Date.now(), id) }
  finish(id: string, status: Exclude<AgentManagementOperationStatus, 'starting' | 'running'>, exit: ProcessExit | null, errorCode: string | null, outputSequence: number) {
    this.db.prepare(`UPDATE studio_agent_management_operations SET status=?, exit_json=?, error_code=?, output_sequence=?, updated_at=? WHERE id=? AND status IN ('starting','running')`)
      .run(status, exit ? JSON.stringify(exit) : null, errorCode, outputSequence, Date.now(), id)
  }
  private decode(row: Row): ManagementOperationRecord {
    return { id: row.id, instanceId: row.instance_id, ownerId: row.owner_id, profileId: row.profile_id, configRevision: row.config_revision,
      provider: JSON.parse(row.provider_json), idempotencyKey: row.request_key, action: row.action, status: row.status,
      createdAt: row.created_at, updatedAt: row.updated_at, expiresAt: row.expires_at, errorCode: row.error_code,
      exit: row.exit_json ? JSON.parse(row.exit_json) : null, outputSequence: row.output_sequence }
  }
}
