import type { DatabaseSync } from 'node:sqlite'
import { StudioError, type ExecutionScope, type JsonObject } from '../contracts/plugins'
import { SESSIONS_TABLE } from '../infrastructure/database/schemas'
import type { AgentChatCreation } from './agent-chat-store'
import { createHash } from 'node:crypto'

const requestHash = (request: JsonObject) => createHash('sha256').update(JSON.stringify(request)).digest('hex')

/** A draft id is an idempotent creation key, never permission to adopt history. */
export class OrdinaryAgentChatStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS studio_ordinary_agent_chats (
      session_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, profile_id TEXT NOT NULL,
      request_json TEXT NOT NULL, selection_json TEXT NOT NULL, receipt_json TEXT NOT NULL
    )`)
  }

  selection(sessionId: string): JsonObject | undefined {
    const row = this.db.prepare('SELECT selection_json FROM studio_ordinary_agent_chats WHERE session_id=?').get(sessionId)
    return row ? JSON.parse(String(row.selection_json)) : undefined
  }

  previous(scope: ExecutionScope, id: string, request: JsonObject): AgentChatCreation | undefined {
    const row = this.db.prepare('SELECT * FROM studio_ordinary_agent_chats WHERE session_id=?').get(id)
    if (!row) {
      if (this.db.prepare(`SELECT 1 FROM ${SESSIONS_TABLE} WHERE id=?`).get(id)) throw new StudioError('REVISION_CONFLICT', 'Existing chat requires an explicit migration')
      return
    }
    if (row.owner_id !== scope.principal.id || row.profile_id !== scope.profileId) throw new StudioError('NOT_FOUND', 'Agent chat is unavailable')
    if (row.request_json !== requestHash(request)) throw new StudioError('REVISION_CONFLICT', 'Draft identifies different chat settings')
    return JSON.parse(String(row.receipt_json))
  }

  create(scope: ExecutionScope, id: string, request: JsonObject, accept: () => AgentChatCreation): AgentChatCreation {
    const previous = this.previous(scope, id, request)
    if (previous) return previous
    this.db.exec('SAVEPOINT studio_ordinary_chat')
    try {
      const receipt = accept()
      this.db.prepare('INSERT INTO studio_ordinary_agent_chats VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, scope.principal.id, scope.profileId, requestHash(request), JSON.stringify(request), JSON.stringify(receipt))
      this.db.exec('RELEASE studio_ordinary_chat')
      return receipt
    } catch (error) { this.db.exec('ROLLBACK TO studio_ordinary_chat; RELEASE studio_ordinary_chat'); throw error }
  }

  update(id: string, selection: JsonObject): void {
    this.db.prepare('UPDATE studio_ordinary_agent_chats SET selection_json=? WHERE session_id=?').run(JSON.stringify(selection), id)
  }

  retire(id: string): void {
    const selection = this.selection(id)
    if (selection) this.update(id, { ...selection, apiKey: '', baseUrl: '', apiMode: '' })
  }
}
