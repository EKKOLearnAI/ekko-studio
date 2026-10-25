import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { AgentInstance } from './agent-execution-store'
import { StudioError } from '../contracts/plugins'
import type { AgentRunCommandOrigin } from './agent-run-command-origin'

/** Trusted application binding, never accepted as part of a plugin Run input. */
export interface AgentRunTarget { kind: 'chat'; sessionId: string; command?: AgentRunCommandOrigin }
interface Conversation { id: string; instance_id: string; profile_id: string; owner_id: string; session_id: string }

/** Logical conversations survive physical worker leases and keep native history
 * separate when several chats use the same configured Agent instance. */
export class AgentConversationStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS studio_agent_conversations (
      id TEXT PRIMARY KEY, instance_id TEXT NOT NULL, profile_id TEXT NOT NULL, owner_id TEXT NOT NULL,
      session_id TEXT NOT NULL, UNIQUE(instance_id, session_id)
    ); CREATE TABLE IF NOT EXISTS studio_agent_run_targets (
      run_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, session_id TEXT NOT NULL
    );`)
  }

  /** Called within the Run acceptance transaction, after target authorization. */
  bind(runId: string, instance: AgentInstance, target: AgentRunTarget): void {
    let conversation = this.db.prepare('SELECT * FROM studio_agent_conversations WHERE instance_id=? AND session_id=?')
      .get(instance.id, target.sessionId) as Conversation | undefined
    if (!conversation) {
      const id = randomUUID()
      this.db.prepare('INSERT INTO studio_agent_conversations VALUES (?, ?, ?, ?, ?)')
        .run(id, instance.id, instance.profileId, instance.ownerId, target.sessionId)
      conversation = { id, instance_id: instance.id, profile_id: instance.profileId, owner_id: instance.ownerId, session_id: target.sessionId }
    }
    if (conversation.owner_id !== instance.ownerId || conversation.profile_id !== instance.profileId) throw new StudioError('FORBIDDEN', 'Agent conversation binding changed')
    this.db.prepare('INSERT INTO studio_agent_run_targets VALUES (?, ?, ?)').run(runId, conversation.id, target.sessionId)
  }

  target(runId: string): { conversationId: string; sessionId: string } | undefined {
    const row = this.db.prepare('SELECT conversation_id, session_id FROM studio_agent_run_targets WHERE run_id=?')
      .get(runId) as { conversation_id: string; session_id: string } | undefined
    return row ? { conversationId: row.conversation_id, sessionId: row.session_id } : undefined
  }

  ids(instanceId: string): string[] {
    return (this.db.prepare('SELECT id FROM studio_agent_conversations WHERE instance_id=?').all(instanceId) as Array<{ id: string }>).map(row => row.id)
  }
  forSession(sessionId: string): string[] {
    return (this.db.prepare('SELECT id FROM studio_agent_conversations WHERE session_id=?').all(sessionId) as Array<{ id: string }>).map(row => row.id)
  }
}
