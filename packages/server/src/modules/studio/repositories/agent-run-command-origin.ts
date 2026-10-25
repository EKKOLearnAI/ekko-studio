import type { DatabaseSync } from 'node:sqlite'
import { StudioError } from '../contracts/plugins'
import { MESSAGES_TABLE } from '../infrastructure/database/schemas'
import type { AgentInstance } from './agent-execution-store'

/** Host-only command provenance; never part of an SDK/HTTP Run request. */
export interface AgentRunCommandOrigin { callId: string; messageId: number }
export class AgentRunCommandOrigins {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS studio_agent_run_command_origins (
      run_id TEXT PRIMARY KEY, command_call_id TEXT NOT NULL UNIQUE, input_message_id INTEGER NOT NULL UNIQUE
    )`)
  }
  bind(runId: string, instance: AgentInstance, sessionId: string, origin: AgentRunCommandOrigin): void {
    if (!origin || typeof origin !== 'object' || Array.isArray(origin) || Object.keys(origin).some(key => !['callId', 'messageId'].includes(key))
      || typeof origin.callId !== 'string' || !origin.callId || origin.callId.length > 256
      || !Number.isSafeInteger(origin.messageId) || origin.messageId < 1) throw new StudioError('INVALID_ARGUMENT', 'Invalid command provenance')
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='studio_plugin_command_calls'").get()) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Command admission is unavailable')
    const row = this.db.prepare('SELECT record_json FROM studio_plugin_command_calls WHERE id=? AND owner_id=? AND profile_id=?')
      .get(origin.callId, instance.ownerId, instance.profileId)
    let call: { status?: string; sessionId?: string; inputMessageId?: number } | undefined
    try { call = row ? JSON.parse(String(row.record_json)) : undefined } catch {}
    const message = this.db.prepare(`SELECT session_id, role, run_marker FROM ${MESSAGES_TABLE} WHERE id=?`).get(origin.messageId)
    if (!call || call.status !== 'running' || call.sessionId !== sessionId || call.inputMessageId !== origin.messageId
      || message?.session_id !== sessionId || message.role !== 'command') throw new StudioError('FORBIDDEN', 'Command input is outside the active invocation')
    if (this.db.prepare('SELECT 1 FROM studio_agent_run_command_origins WHERE command_call_id=? OR input_message_id=?').get(origin.callId, origin.messageId)) throw new StudioError('REVISION_CONFLICT', 'Command already started its Agent Run')
    if (message.run_marker) throw new StudioError('FORBIDDEN', 'Command input is already owned by another Run')
    this.db.prepare('INSERT INTO studio_agent_run_command_origins VALUES (?, ?, ?)').run(runId, origin.callId, origin.messageId)
  }
  runs(callId: string): string[] {
    return this.db.prepare('SELECT run_id FROM studio_agent_run_command_origins WHERE command_call_id=?').all(callId).map(row => String(row.run_id))
  }
}
