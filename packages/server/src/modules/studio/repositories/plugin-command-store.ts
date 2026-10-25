import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { StudioError, type ExecutionScope, type CommandResult } from '../contracts/plugins'

export interface CommandStart { sessionId: string; commandId: string; revision: string; text: string; idempotencyKey: string }
export type CommandEvent = CommandResult & { event: 'session.command'; session_id: string; commandCallId: string; commandSequence: number; messageId?: number }
export interface CommandCall {
  id: string; ownerId: string; profileId: string; sessionId: string; commandId: string
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
  results: CommandEvent[]; errorCode: string | null
  inputMessageId?: number
}
export class PluginCommandStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS studio_plugin_command_calls (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, profile_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
      input_hash TEXT NOT NULL, record_json TEXT NOT NULL, UNIQUE(owner_id, profile_id, idempotency_key)
    )`)
  }
  find(scope: ExecutionScope, input: CommandStart): CommandCall | null {
    const row = this.db.prepare('SELECT input_hash, record_json FROM studio_plugin_command_calls WHERE owner_id=? AND profile_id=? AND idempotency_key=?')
      .get(scope.principal.id, scope.profileId, input.idempotencyKey) as { input_hash: string; record_json: string } | undefined
    if (!row) return null
    if (row.input_hash !== this.hash(input)) throw new StudioError('REVISION_CONFLICT', 'Command idempotency key identifies different input')
    return JSON.parse(row.record_json)
  }
  accept(scope: ExecutionScope, input: CommandStart, persistInput: () => number | undefined | void): CommandCall {
    const record: CommandCall = { id: randomUUID(), ownerId: scope.principal.id, profileId: scope.profileId,
      sessionId: input.sessionId, commandId: input.commandId, status: 'running', results: [], errorCode: null }
    this.transaction(() => {
      this.db.prepare('INSERT INTO studio_plugin_command_calls VALUES (?, ?, ?, ?, ?, ?)')
        .run(record.id, record.ownerId, record.profileId, input.idempotencyKey, this.hash(input), JSON.stringify(record))
      const messageId = persistInput()
      if (messageId !== undefined) { record.inputMessageId = messageId; this.save(record) }
    })
    return record
  }
  get(id: string): CommandCall | null {
    const row = this.db.prepare('SELECT record_json FROM studio_plugin_command_calls WHERE id=?').get(id) as { record_json: string } | undefined
    return row ? JSON.parse(row.record_json) : null
  }
  append(id: string, result: CommandResult, persist: () => number | undefined): CommandEvent {
    const record = this.get(id)
    if (!record || record.status !== 'running') throw new StudioError('CANCELLED', 'Command has ended')
    if (record.results.length >= 32) throw new StudioError('RESOURCE_EXHAUSTED', 'Command result limit reached')
    const event: CommandEvent = { ...result, event: 'session.command', session_id: record.sessionId, commandCallId: id, commandSequence: record.results.length }
    this.transaction(() => {
      const messageId = persist()
      if (messageId !== undefined) event.messageId = messageId
      record.results.push(event); this.save(record)
    })
    return event
  }
  finish(id: string, status: CommandCall['status'], errorCode: string | null = null): void {
    const record = this.get(id)
    if (!record || record.status !== 'running') return
    this.save({ ...record, status, errorCode })
  }
  recover(): void {
    for (const row of this.db.prepare('SELECT id FROM studio_plugin_command_calls').all() as Array<{ id: string }>) this.finish(row.id, 'interrupted', 'RUNTIME_UNAVAILABLE')
  }
  private save(record: CommandCall): void { this.db.prepare('UPDATE studio_plugin_command_calls SET record_json=? WHERE id=?').run(JSON.stringify(record), record.id) }
  private hash(input: CommandStart): string { return createHash('sha256').update(JSON.stringify([input.sessionId, input.commandId, input.revision, input.text])).digest('hex') }
  private transaction<T>(fn: () => T): T {
    this.db.exec('SAVEPOINT plugin_command_write')
    try { const value = fn(); this.db.exec('RELEASE plugin_command_write'); return value }
    catch (error) { this.db.exec('ROLLBACK TO plugin_command_write'); this.db.exec('RELEASE plugin_command_write'); throw error }
  }
}
