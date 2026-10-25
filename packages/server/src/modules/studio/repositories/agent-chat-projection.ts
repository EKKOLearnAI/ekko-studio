import type { DatabaseSync } from 'node:sqlite'
import { agentChatDisplayContent } from './agent-chat-content'
import { StudioError, type AgentOutputEvent, type AgentRunInput } from '../contracts/plugins'
import type { AgentExecution, AgentExecutionProjection, AgentInstance } from './agent-execution-store'
import { normalizeMessageContentForStorageRole, parseStoredToolCalls } from './message-content'
import type { SessionMessage } from '../contracts/runs/session'
import { MESSAGES_TABLE, SESSIONS_TABLE } from '../infrastructure/database/schemas'
import { BUILTIN_HISTORY_SOURCES } from '../contracts/history-source'
import { recordSkillUsageMessage } from './skill-usage-store'
import { readAgentChatRunSummaries, readAgentChatSummaries, readAgentChatUsageMessageId } from './agent-chat-summary'

type Source = typeof BUILTIN_HISTORY_SOURCES[number]
export interface AgentChatBinding { sessionId: string; instanceId: string; ownerId: string; profileId: string; source: Source }
type Kind = 'input' | 'message' | 'tool-call' | 'tool-result'
interface Message { id: number; content: string; reasoning: string | null }
const MAX_MESSAGE_BYTES = 8 * 1024 * 1024

/** One writer for chats backed by canonical Agent Runs. Every method is called
 * synchronously in the Run store's SQLite transaction; this class never emits
 * Socket events or records a second copy of model usage. */
export class AgentChatProjection implements AgentExecutionProjection {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS studio_agent_chat_bindings (
      session_id TEXT PRIMARY KEY, instance_id TEXT NOT NULL, owner_id TEXT NOT NULL, profile_id TEXT NOT NULL, source TEXT NOT NULL
    ); CREATE TABLE IF NOT EXISTS studio_agent_chat_messages (
      run_id TEXT NOT NULL, kind TEXT NOT NULL, logical_id TEXT NOT NULL, message_id INTEGER NOT NULL,
      PRIMARY KEY(run_id, kind, logical_id), UNIQUE(message_id)
    );`)
  }

  binding(sessionId: string): AgentChatBinding | undefined {
    const row = this.db.prepare('SELECT instance_id, owner_id, profile_id, source FROM studio_agent_chat_bindings WHERE session_id=?')
      .get(sessionId) as { instance_id: string; owner_id: string; profile_id: string; source: Source } | undefined
    return row ? { sessionId, instanceId: row.instance_id, ownerId: row.owner_id, profileId: row.profile_id, source: row.source } : undefined
  }
  hasSession(sessionId: string): boolean { return !!this.db.prepare(`SELECT 1 FROM ${SESSIONS_TABLE} WHERE id=?`).get(sessionId) }
  summary(sessionId: string) { return readAgentChatSummaries(this.db, [sessionId])[sessionId] }

  /** Bounded SDK receipt view of the current snapshots. It never appends text
   * from transport packets or creates another transcript copy. */
  text(runId: string) {
    let truncated = false
    const field = (name: 'content' | 'reasoning') => {
      let text = '', count = 0
      for (const row of this.db.prepare(`SELECT substr(m.${name},1,65537) AS text FROM studio_agent_chat_messages p
        JOIN ${MESSAGES_TABLE} m ON m.id=p.message_id WHERE p.run_id=? AND m.role='assistant'
          AND p.kind IN ('message','tool-call') AND coalesce(m.${name},'')!='' ORDER BY m.id LIMIT 1025`).iterate(runId)) {
        if (++count > 1024) { truncated = true; break }
        const value = (text ? '\n\n' : '') + String(row.text)
        const remaining = 65_536 - text.length
        text += value.slice(0, Math.max(0, remaining))
        if (value.length > remaining) { truncated = true; break }
      }
      return text
    }
    const output = field('content'), reasoning = field('reasoning')
    const sequence = this.db.prepare('SELECT max(sequence) AS sequence FROM studio_agent_run_outputs WHERE run_id=?').get(runId)?.sequence
    return { output, reasoning, truncated, producerSequence: typeof sequence === 'number' ? sequence : -1 }
  }

  assertBinding(sessionId: string, instance: AgentInstance): AgentChatBinding {
    const binding = this.binding(sessionId)
    if (!binding || binding.instanceId !== instance.id || binding.ownerId !== instance.ownerId || binding.profileId !== instance.profileId) throw new StudioError('FORBIDDEN', 'Chat is outside the Agent binding')
    this.check(binding)
    return binding
  }

  /** Only a new owned chat can be attached. Existing native history needs an
   * explicit migration instead of silently starting a different conversation. */
  attach(sessionId: string, instance: AgentInstance, source: Source = 'coding_agent'): void {
    if (!BUILTIN_HISTORY_SOURCES.includes(source)) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Chat surface requires a dedicated binding adapter')
    this.db.exec('SAVEPOINT studio_agent_chat_binding')
    try { this.attachNew(sessionId, instance, source); this.db.exec('RELEASE studio_agent_chat_binding') }
    catch (error) { this.db.exec('ROLLBACK TO studio_agent_chat_binding; RELEASE studio_agent_chat_binding'); throw error }
  }

  private attachNew(sessionId: string, instance: AgentInstance, source: Source): void {
    const previous = this.binding(sessionId)
    if (previous) {
      if (previous.instanceId !== instance.id || previous.ownerId !== instance.ownerId || previous.profileId !== instance.profileId || previous.source !== source) throw new StudioError('REVISION_CONFLICT', 'Chat is bound to another Agent instance')
      this.check(previous)
      return
    }
    const binding = { sessionId, instanceId: instance.id, ownerId: instance.ownerId, profileId: instance.profileId, source }
    this.check(binding)
    const native = this.db.prepare(`SELECT agent_native_session_id FROM ${SESSIONS_TABLE} WHERE id=?`).get(sessionId)
    if (native?.agent_native_session_id || this.db.prepare(`SELECT 1 FROM ${MESSAGES_TABLE} WHERE session_id=? LIMIT 1`).get(sessionId)) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Existing chat history requires explicit migration')
    this.db.prepare('INSERT INTO studio_agent_chat_bindings VALUES (?, ?, ?, ?, ?)').run(sessionId, instance.id, instance.ownerId, instance.profileId, source)
  }

  accepted(run: AgentExecution, _input: AgentRunInput): void {
    if (!run.sessionId) return
    this.forRun(run)
  }

  started(run: AgentExecution, input: AgentRunInput): void {
    if (!run.sessionId) return
    this.forRun(run)
    if (this.message(run.id, 'input', 'input')) return
    // Canonical admission already persists queued input. Materialize its chat
    // row only when dispatched, after the previous Run's last assistant row.
    const content = agentChatDisplayContent(run.sessionId, input)
    const origin = this.db.prepare('SELECT input_message_id FROM studio_agent_run_command_origins WHERE run_id=?').get(run.id)
    if (origin) {
      const message = this.db.prepare(`SELECT session_id, role, run_marker FROM ${MESSAGES_TABLE} WHERE id=?`).get(origin.input_message_id)
      if (message?.session_id !== run.sessionId || message.role !== 'command' || (message.run_marker && message.run_marker !== run.id)) throw new StudioError('FORBIDDEN', 'Command input is outside the Run target')
      this.db.prepare(`UPDATE ${MESSAGES_TABLE} SET run_marker=? WHERE id=?`).run(run.id, origin.input_message_id)
      this.db.prepare('INSERT INTO studio_agent_chat_messages VALUES (?, ?, ?, ?)').run(run.id, 'input', 'input', origin.input_message_id)
    } else this.insert(run, 'input', 'input', 'user', content)
    this.db.prepare(`UPDATE ${SESSIONS_TABLE} SET ended_at=NULL, end_reason=NULL WHERE id=?`).run(run.sessionId)
    this.stats(run.sessionId)
  }

  output(run: AgentExecution, event: AgentOutputEvent): void {
    if (!run.sessionId) return
    this.forRun(run)
    if (event.type === 'message.delta' || event.type === 'message.snapshot' || event.type === 'reasoning.delta') {
      const message = this.message(run.id, 'message', event.messageId) ?? this.insert(run, 'message', event.messageId, 'assistant', '')
      const field = event.type === 'reasoning.delta' ? 'reasoning' : 'content'
      const text = (event.type === 'message.snapshot' ? '' : message[field] || '') + event.text
      this.bound(text)
      this.db.prepare(`UPDATE ${MESSAGES_TABLE} SET ${field}=? WHERE id=?`).run(normalizeMessageContentForStorageRole('assistant', text), message.id)
    } else if (event.type === 'tool.started') {
      const message = this.message(run.id, 'tool-call', event.callId) ?? this.insert(run, 'tool-call', event.callId, 'assistant', '')
      const calls = JSON.stringify([{ id: event.callId, type: 'function', function: { name: event.name, arguments: JSON.stringify(event.data) } }])
      this.bound(calls)
      this.db.prepare(`UPDATE ${MESSAGES_TABLE} SET tool_calls=? WHERE id=?`).run(calls, message.id)
    } else if (event.type === 'tool.completed' || event.type === 'tool.failed') {
      const text = typeof event.data === 'string' ? event.data : JSON.stringify(event.data)
      this.bound(text)
      const message = this.message(run.id, 'tool-result', event.callId) ?? this.insert(run, 'tool-result', event.callId, 'tool', '')
      this.db.prepare(`UPDATE ${MESSAGES_TABLE} SET content=?, tool_call_id=?, tool_name=?, finish_reason=? WHERE id=?`)
        .run(normalizeMessageContentForStorageRole('tool', text), event.callId, event.name, event.type === 'tool.failed' ? 'error' : null, message.id)
      recordSkillUsageMessage(message.id, { session_id: run.sessionId, role: 'tool', content: text, tool_call_id: event.callId,
        tool_name: event.name, run_marker: run.id, timestamp: Math.floor(run.createdAt / 1000) }, this.db)
    } else return
    this.stats(run.sessionId)
  }

  finished(run: AgentExecution): void {
    if (!run.sessionId) return
    // A deleted/transferred chat must not strand the canonical Run in an active
    // state, and its new owner must not receive the previous owner's metadata.
    try { this.forRun(run) }
    catch (error) { if (error instanceof StudioError && error.code === 'FORBIDDEN') return; throw error }
    const other = this.db.prepare(`SELECT 1 FROM studio_agent_runs r JOIN studio_agent_run_targets t ON t.run_id=r.id
      WHERE t.session_id=? AND r.status NOT IN ('completed','failed','cancelled','interrupted') LIMIT 1`).get(run.sessionId)
    if (!other && this.message(run.id, 'input', 'input')) this.db.prepare(`UPDATE ${SESSIONS_TABLE} SET ended_at=?, end_reason=? WHERE id=?`)
      .run(Math.floor(run.updatedAt / 1000), run.status, run.sessionId)
    this.stats(run.sessionId)
  }

  message(runId: string, kind: Kind, logicalId: string): Message | undefined {
    return this.db.prepare(`SELECT m.id, m.content, m.reasoning FROM studio_agent_chat_messages p JOIN ${MESSAGES_TABLE} m ON m.id=p.message_id
      WHERE p.run_id=? AND p.kind=? AND p.logical_id=?`).get(runId, kind, logicalId) as unknown as Message | undefined
  }

  /** Read committed rows for delivery. Transport never rewrites the transcript. */
  rows(runId: string, events: AgentOutputEvent[], includeInput = false, refreshUsage = false): SessionMessage[] {
    const ids = new Set<number>()
    const add = (kind: Kind, id: string) => { const row = this.message(runId, kind, id); if (row) ids.add(row.id) }
    if (includeInput) add('input', 'input')
    for (const event of events) {
      if (['message.delta', 'message.snapshot', 'reasoning.delta'].includes(event.type)) add('message', (event as { messageId: string }).messageId)
      else if (event.type === 'tool.started') add('tool-call', event.callId)
      else if (event.type === 'tool.completed' || event.type === 'tool.failed') add('tool-result', event.callId)
    }
    if (refreshUsage || events.some(event => event.type === 'usage.reported')) {
      const target = readAgentChatUsageMessageId(this.db, runId)
      if (target !== undefined) ids.add(target)
    }
    const rows = [...ids].sort((a, b) => a - b).map(id => {
      const row = this.db.prepare(`SELECT * FROM ${MESSAGES_TABLE} WHERE id=?`).get(id)!
      return { ...row, tool_calls: parseStoredToolCalls(row.tool_calls) } as unknown as SessionMessage
    })
    const sessionId = rows[0]?.session_id
    const summaries = new Map(sessionId ? readAgentChatRunSummaries(this.db, sessionId, rows.filter(row => row.role === 'assistant').map(row => String(row.id))).map(summary => [summary.assistantMessageId, summary]) : [])
    return rows.map(row => summaries.has(String(row.id)) ? { ...row, run_usage: summaries.get(String(row.id)) } : row)
  }

  private check(binding: AgentChatBinding): void {
    const session = this.db.prepare(`SELECT s.profile, s.studio_user_id, s.source, s.agent, i.agent_type_id, i.owner_id, i.profile_id
      FROM ${SESSIONS_TABLE} s JOIN studio_agent_instances i ON i.id=? WHERE s.id=?`).get(binding.instanceId, binding.sessionId) as {
        profile: string; studio_user_id: string | null; source: string; agent: string; agent_type_id: string; owner_id: string; profile_id: string
      } | undefined
    if (!session || session.source !== binding.source || (session.profile || 'default') !== binding.profileId || session.studio_user_id !== binding.ownerId
      || session.agent !== session.agent_type_id || session.owner_id !== binding.ownerId || session.profile_id !== binding.profileId) throw new StudioError('FORBIDDEN', 'Chat is outside the Agent binding')
  }

  private forRun(run: AgentExecution): void {
    const binding = run.sessionId ? this.binding(run.sessionId) : undefined
    if (!binding || binding.instanceId !== run.instanceId || binding.ownerId !== run.ownerId || binding.profileId !== run.profileId) throw new StudioError('FORBIDDEN', 'Agent Run has no matching chat binding')
    this.check(binding)
  }

  private insert(run: AgentExecution, kind: Kind, logicalId: string, role: string, content: string): Message {
    this.bound(content)
    const inserted = this.db.prepare(`INSERT INTO ${MESSAGES_TABLE} (session_id, role, content, run_marker, timestamp) VALUES (?, ?, ?, ?, ?)`)
      .run(run.sessionId!, role, content, run.id, Math.floor(run.createdAt / 1000))
    const id = Number(inserted.lastInsertRowid)
    this.db.prepare('INSERT INTO studio_agent_chat_messages VALUES (?, ?, ?, ?)').run(run.id, kind, logicalId, id)
    return { id, content, reasoning: null }
  }

  private stats(sessionId: string): void {
    this.db.prepare(`UPDATE ${SESSIONS_TABLE} SET message_count=(SELECT count(*) FROM ${MESSAGES_TABLE} WHERE session_id=?),
      tool_call_count=(SELECT count(*) FROM studio_agent_chat_messages p JOIN ${MESSAGES_TABLE} m ON p.message_id=m.id WHERE m.session_id=? AND p.kind='tool-call'), last_active=? WHERE id=?`)
      .run(sessionId, sessionId, Math.floor(Date.now() / 1000), sessionId)
  }

  private bound(text: string): void { if (Buffer.byteLength(text) > MAX_MESSAGE_BYTES) throw new StudioError('RESOURCE_EXHAUSTED', 'Chat message exceeds 8 MiB') }
}
