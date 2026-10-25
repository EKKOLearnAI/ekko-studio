import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { StudioError, type ExecutionScope } from '../contracts/plugins'
import type { AgentInstance } from './agent-execution-store'
import type { AgentChatBinding } from './agent-chat-projection'

export interface AgentChatCreationInput { revision: number; idempotencyKey: string }
export interface AgentChatCreation {
  sessionId: string; instanceId: string; profileId: string; configurationRevision: number; createdAt: number
}
interface CreationRow { session_id: string; instance_id: string; profile_id: string; configuration_revision: number; created_at: number }

/** Creation receipts do not contain transcript or instance configuration. */
export class AgentChatStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS studio_agent_chat_creations (
      owner_id TEXT NOT NULL, profile_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
      instance_id TEXT NOT NULL, configuration_revision INTEGER NOT NULL, session_id TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL,
      PRIMARY KEY(owner_id, profile_id, idempotency_key)
    );`)
  }

  find(scope: ExecutionScope, instance: AgentInstance, input: AgentChatCreationInput): AgentChatCreation | undefined {
    const row = this.db.prepare('SELECT * FROM studio_agent_chat_creations WHERE owner_id=? AND profile_id=? AND idempotency_key=?')
      .get(scope.principal.id, scope.profileId, input.idempotencyKey) as unknown as CreationRow | undefined
    if (!row) return undefined
    if (row.instance_id !== instance.id || row.configuration_revision !== input.revision) throw new StudioError('REVISION_CONFLICT', 'Chat creation key identifies a different request')
    return this.decode(row)
  }

  /** The callback creates the owned session and binding on this same connection. */
  accept(scope: ExecutionScope, instance: AgentInstance, input: AgentChatCreationInput, create: (binding: AgentChatBinding) => void, source: AgentChatBinding['source'], sessionId?: string): AgentChatCreation {
    const previous = this.find(scope, instance, input)
    if (previous) return previous
    this.db.exec('SAVEPOINT studio_agent_chat_creation')
    try {
      const id = sessionId ?? randomUUID(), createdAt = Date.now()
      this.db.prepare('INSERT INTO studio_agent_chat_creations VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(scope.principal.id, scope.profileId, input.idempotencyKey, instance.id, input.revision, id, createdAt)
      create({ sessionId: id, instanceId: instance.id, ownerId: instance.ownerId, profileId: instance.profileId, source })
      this.db.exec('RELEASE studio_agent_chat_creation')
      return { sessionId: id, instanceId: instance.id, profileId: instance.profileId, configurationRevision: input.revision, createdAt }
    } catch (error) { this.db.exec('ROLLBACK TO studio_agent_chat_creation; RELEASE studio_agent_chat_creation'); throw error }
  }

  private decode(row: CreationRow): AgentChatCreation {
    return { sessionId: row.session_id, instanceId: row.instance_id, profileId: row.profile_id, configurationRevision: row.configuration_revision, createdAt: row.created_at }
  }
}
