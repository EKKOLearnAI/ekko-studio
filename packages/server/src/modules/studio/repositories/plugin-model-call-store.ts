import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { StudioError, type ExecutionScope, type ModelCallRecord, type ModelStreamInput } from '../contracts/plugins'

export class PluginModelCallStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS studio_plugin_model_calls (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, profile_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL, input_hash TEXT NOT NULL, status TEXT NOT NULL, record_json TEXT NOT NULL,
      UNIQUE(owner_id, profile_id, idempotency_key)
    ); CREATE INDEX IF NOT EXISTS studio_plugin_model_calls_status ON studio_plugin_model_calls(status)`)
  }
  find(scope: ExecutionScope, input: ModelStreamInput): ModelCallRecord | null {
    const row = this.db.prepare('SELECT input_hash, record_json FROM studio_plugin_model_calls WHERE owner_id=? AND profile_id=? AND idempotency_key=?')
      .get(scope.principal.id, scope.profileId, input.idempotencyKey) as { input_hash: string; record_json: string } | undefined
    if (!row) return null
    if (row.input_hash !== this.hash(scope, input)) throw new StudioError('REVISION_CONFLICT', 'Model key already identifies different input or scope')
    return JSON.parse(row.record_json)
  }
  accept(scope: ExecutionScope, input: ModelStreamInput, claim: (record: ModelCallRecord) => void): ModelCallRecord {
    const now = Date.now()
    const record: ModelCallRecord = { id: `model_${randomUUID()}`, profileId: scope.profileId, ownerId: scope.principal.id,
      sessionId: scope.sessionId || null, runId: scope.runId || null, model: input.model, status: 'running', output: [],
      usage: null, errorCode: null, revision: 1, createdAt: now, updatedAt: now }
    this.db.exec('SAVEPOINT studio_model_accept')
    try {
      this.db.prepare('INSERT INTO studio_plugin_model_calls VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(record.id, record.ownerId, record.profileId, input.idempotencyKey, this.hash(scope, input), record.status, JSON.stringify(record))
      claim(record)
      this.db.exec('RELEASE studio_model_accept')
    } catch (error) { this.db.exec('ROLLBACK TO studio_model_accept; RELEASE studio_model_accept'); throw error }
    return record
  }
  get(id: string): ModelCallRecord | null {
    const row = this.db.prepare('SELECT record_json FROM studio_plugin_model_calls WHERE id=?').get(id) as { record_json: string } | undefined
    return row ? JSON.parse(row.record_json) : null
  }
  update(id: string, patch: Partial<Pick<ModelCallRecord, 'status' | 'output' | 'usage' | 'errorCode'>>, project: (record: ModelCallRecord) => void = () => {}): ModelCallRecord {
    const record = this.get(id)
    if (!record) throw new StudioError('NOT_FOUND', 'Model call is unavailable')
    if (record.status !== 'running' && Object.keys(patch).some(key => key !== 'usage')) return record
    Object.assign(record, patch, { revision: record.revision + 1, updatedAt: Date.now() })
    this.db.exec('SAVEPOINT studio_model_update')
    try {
      this.db.prepare('UPDATE studio_plugin_model_calls SET status=?, record_json=? WHERE id=?').run(record.status, JSON.stringify(record), id)
      project(record)
      this.db.exec('RELEASE studio_model_update')
    } catch (error) { this.db.exec('ROLLBACK TO studio_model_update; RELEASE studio_model_update'); throw error }
    return record
  }
  recover(project: (record: ModelCallRecord) => void = () => {}): void {
    for (const row of this.db.prepare("SELECT id FROM studio_plugin_model_calls WHERE status='running'").all() as Array<{ id: string }>) {
      this.update(row.id, { status: 'interrupted', errorCode: 'RUNTIME_UNAVAILABLE' }, project)
    }
  }
  private hash(scope: ExecutionScope, input: ModelStreamInput): string {
    // JSON object key order must not turn an otherwise identical retry into another request.
    const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable)
      : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)])) : value
    return createHash('sha256').update(JSON.stringify(stable([scope.sessionId || null, scope.runId || null, input]))).digest('hex')
  }
}
