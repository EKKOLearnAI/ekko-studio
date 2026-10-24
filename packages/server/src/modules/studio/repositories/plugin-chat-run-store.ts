import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { StudioError, type ChatRunRecord, type ChatRunStartInput, type ExecutionScope } from '../contracts/plugins'

export const chatRunTerminal = (status: ChatRunRecord['status']): boolean => ['completed', 'failed', 'cancelled', 'interrupted'].includes(status)

/** Receipts only. The existing chat engine remains the sole message/usage/event writer. */
export class PluginChatRunStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS studio_plugin_chat_runs (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, profile_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL, input_hash TEXT NOT NULL, record_json TEXT NOT NULL,
      UNIQUE(owner_id, profile_id, idempotency_key)
    )`)
  }

  find(scope: ExecutionScope, input: ChatRunStartInput): ChatRunRecord | null {
    const row = this.db.prepare('SELECT input_hash, record_json FROM studio_plugin_chat_runs WHERE owner_id=? AND profile_id=? AND idempotency_key=?')
      .get(scope.principal.id, scope.profileId, input.idempotencyKey) as { input_hash: string; record_json: string } | undefined
    if (!row) return null
    if (row.input_hash !== this.hash(input)) throw new StudioError('REVISION_CONFLICT', 'Idempotency key already identifies different input')
    return JSON.parse(row.record_json) as ChatRunRecord
  }

  accept(scope: ExecutionScope, input: ChatRunStartInput): ChatRunRecord {
    const now = Date.now()
    const record: ChatRunRecord = { id: randomUUID(), ownerId: scope.principal.id, profileId: scope.profileId,
      sessionId: input.sessionId, status: 'accepted', output: '', reasoning: '', truncated: false,
      revision: 1, createdAt: now, updatedAt: now, errorCode: null }
    this.db.prepare('INSERT INTO studio_plugin_chat_runs VALUES (?, ?, ?, ?, ?, ?)')
      .run(record.id, record.ownerId, record.profileId, input.idempotencyKey, this.hash(input), JSON.stringify(record))
    return record
  }

  get(id: string): ChatRunRecord | null {
    const row = this.db.prepare('SELECT record_json FROM studio_plugin_chat_runs WHERE id=?').get(id) as { record_json: string } | undefined
    return row ? JSON.parse(row.record_json) as ChatRunRecord : null
  }

  update(id: string, patch: Partial<Pick<ChatRunRecord, 'status' | 'output' | 'reasoning' | 'truncated' | 'errorCode'>>): ChatRunRecord {
    const record = this.get(id)
    if (!record) throw new StudioError('NOT_FOUND', 'Chat receipt not found')
    if (chatRunTerminal(record.status)) return record
    Object.assign(record, patch, { revision: record.revision + 1, updatedAt: Date.now() })
    this.db.prepare('UPDATE studio_plugin_chat_runs SET record_json=? WHERE id=?').run(JSON.stringify(record), id)
    return record
  }

  recover(): void {
    for (const row of this.db.prepare('SELECT id FROM studio_plugin_chat_runs').all() as Array<{ id: string }>) {
      this.update(row.id, { status: 'interrupted', errorCode: 'RUNTIME_UNAVAILABLE' })
    }
  }

  private hash(input: ChatRunStartInput): string {
    return createHash('sha256').update(JSON.stringify([input.sessionId, input.input])).digest('hex')
  }
}
