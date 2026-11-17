import { randomUUID } from 'node:crypto'
import type { DatabaseSync, StatementSync, SQLInputValue } from 'node:sqlite'
import { EkkoDatabaseManager } from '../database'
import type { AgentMessageRole, AgentToolCall } from '../model/types'
import { EKKO_CONVERSATION_MIGRATIONS, EKKO_MESSAGES_TABLE, EKKO_SESSIONS_TABLE } from './schema'
import type {
  AddEkkoMessageInput,
  CreateEkkoSessionInput,
  EkkoMessage,
  EkkoSession,
  EkkoSessionDetail,
  EkkoSessionUsageUpdate,
  ListEkkoMessagesInput,
  ListEkkoSessionsInput,
  UpdateEkkoMessageInput,
  UpdateEkkoSessionInput,
} from './types'

type DatabaseRow = Record<string, unknown>

const SESSION_UPDATE_COLUMNS: Record<keyof UpdateEkkoSessionInput, string> = {
  source: 'source',
  agent: 'agent',
  agentMode: 'agent_mode',
  agentSessionId: 'agent_session_id',
  agentNativeSessionId: 'agent_native_session_id',
  userId: 'user_id',
  model: 'model',
  provider: 'provider',
  apiMode: 'api_mode',
  title: 'title',
  parentSessionId: 'parent_session_id',
  forkPointMessageId: 'fork_point_message_id',
  endedAt: 'ended_at',
  endReason: 'end_reason',
  billingProvider: 'billing_provider',
  estimatedCostUsd: 'estimated_cost_usd',
  actualCostUsd: 'actual_cost_usd',
  costStatus: 'cost_status',
  preview: 'preview',
  lastActive: 'last_active',
  isArchived: 'is_archived',
  workspace: 'workspace',
  categoryId: 'category_id',
}

const MESSAGE_UPDATE_COLUMNS: Record<keyof UpdateEkkoMessageInput, string> = {
  role: 'role',
  content: 'content',
  displayRole: 'display_role',
  displayContent: 'display_content',
  toolCallId: 'tool_call_id',
  toolCalls: 'tool_calls',
  toolName: 'tool_name',
  timestamp: 'timestamp',
  tokenCount: 'token_count',
  finishReason: 'finish_reason',
  reasoning: 'reasoning',
  reasoningDetails: 'reasoning_details',
  reasoningContent: 'reasoning_content',
}

/** SQLite-backed Session and Message ownership for standalone Ekko. */
export class EkkoConversationStore {
  constructor(readonly database: EkkoDatabaseManager) {
    this.database.migrate(EKKO_CONVERSATION_MIGRATIONS)
  }

  createSession(input: CreateEkkoSessionInput = {}): EkkoSession {
    const id = normalizedIdentifier(input.id || randomUUID(), 'session id')
    const startedAt = timestamp(input.startedAt)
    this.connection.prepare(`
      INSERT INTO ${EKKO_SESSIONS_TABLE} (
        id, profile, source, agent, agent_mode, agent_session_id,
        agent_native_session_id, user_id, model, provider, api_mode, title,
        parent_session_id, started_at, last_active, workspace, category_id, message_preview
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '')
    `).run(
      id,
      nonempty(input.profile, 'default'),
      nonempty(input.source, 'ekko-agent'),
      nonempty(input.agent, 'ekko-agent'),
      string(input.agentMode),
      string(input.agentSessionId),
      string(input.agentNativeSessionId),
      nullableString(input.userId),
      string(input.model),
      string(input.provider),
      string(input.apiMode),
      nullableString(input.title),
      nullableString(input.parentSessionId),
      startedAt,
      startedAt,
      nullableString(input.workspace),
      nullableInteger(input.categoryId),
    )
    return this.getSession(id)!
  }

  getSession(id: string): EkkoSession | null {
    const row = this.connection.prepare(
      `SELECT * FROM ${EKKO_SESSIONS_TABLE} WHERE id = ?`,
    ).get(normalizedIdentifier(id, 'session id')) as DatabaseRow | undefined
    return row ? mapSession(row) : null
  }

  listSessions(input: ListEkkoSessionsInput = {}): EkkoSession[] {
    const clauses: string[] = ['1 = 1']
    const values: SQLInputValue[] = []
    if (input.profile?.trim()) {
      clauses.push('s.profile = ?')
      values.push(input.profile.trim())
    }
    if (input.source?.trim()) {
      clauses.push('s.source = ?')
      values.push(input.source.trim())
    }
    if (input.agent?.trim()) {
      clauses.push('s.agent = ?')
      values.push(input.agent.trim())
    }
    if (input.includeArchived === false) clauses.push('s.is_archived = 0')
    if (input.search?.trim()) {
      const pattern = `%${escapeLike(input.search.trim())}%`
      clauses.push(`(
        s.title LIKE ? ESCAPE '\\' OR
        s.preview LIKE ? ESCAPE '\\' OR
        EXISTS (
          SELECT 1 FROM ${EKKO_MESSAGES_TABLE} search_message
          WHERE search_message.session_id = s.id
            AND search_message.content LIKE ? ESCAPE '\\'
        )
      )`)
      values.push(pattern, pattern, pattern)
    }
    const limit = boundedInteger(input.limit, 200, 1, 2_000)
    const offset = boundedInteger(input.offset, 0, 0, Number.MAX_SAFE_INTEGER)
    values.push(limit, offset)
    const rows = this.connection.prepare(`
      SELECT s.*
      FROM ${EKKO_SESSIONS_TABLE} s
      WHERE ${clauses.join(' AND ')}
      ORDER BY s.last_active DESC, s.id DESC
      LIMIT ? OFFSET ?
    `).all(...values) as DatabaseRow[]
    return rows.map(mapSession)
  }

  updateSession(id: string, patch: UpdateEkkoSessionInput): EkkoSession | null {
    const sessionId = normalizedIdentifier(id, 'session id')
    const assignments: string[] = []
    const values: SQLInputValue[] = []
    for (const [key, value] of Object.entries(patch) as Array<[keyof UpdateEkkoSessionInput, unknown]>) {
      if (value === undefined) continue
      assignments.push(`${SESSION_UPDATE_COLUMNS[key]} = ?`)
      values.push(sessionUpdateValue(key, value))
    }
    if (assignments.length === 0) return this.getSession(sessionId)
    values.push(sessionId)
    const result = this.connection.prepare(
      `UPDATE ${EKKO_SESSIONS_TABLE} SET ${assignments.join(', ')} WHERE id = ?`,
    ).run(...values)
    return Number(result.changes) > 0 ? this.getSession(sessionId) : null
  }

  renameSession(id: string, title: string | null): EkkoSession | null {
    return this.updateSession(id, { title: nullableString(title) })
  }

  setSessionArchived(id: string, archived: boolean): EkkoSession | null {
    return this.updateSession(id, { isArchived: archived })
  }

  endSession(id: string, reason = 'completed', endedAt?: number): EkkoSession | null {
    const ended = timestamp(endedAt)
    return this.updateSession(id, {
      endedAt: ended,
      endReason: reason.trim() || 'completed',
      lastActive: ended,
    })
  }

  reopenSession(id: string): EkkoSession | null {
    return this.updateSession(id, { endedAt: null, endReason: null, lastActive: timestamp() })
  }

  deleteSession(id: string): boolean {
    const sessionId = normalizedIdentifier(id, 'session id')
    return this.database.transaction(() => {
      this.connection.prepare(`DELETE FROM ${EKKO_MESSAGES_TABLE} WHERE session_id = ?`).run(sessionId)
      const result = this.connection.prepare(`DELETE FROM ${EKKO_SESSIONS_TABLE} WHERE id = ?`).run(sessionId)
      return Number(result.changes) > 0
    })
  }

  getSessionDetail(id: string, messages: ListEkkoMessagesInput = {}): EkkoSessionDetail | null {
    const session = this.getSession(id)
    return session ? { ...session, messages: this.listMessages(session.id, messages) } : null
  }

  addMessage(input: AddEkkoMessageInput): EkkoMessage {
    return this.addMessages([input])[0]
  }

  addMessages(inputs: AddEkkoMessageInput[]): EkkoMessage[] {
    if (inputs.length === 0) return []
    return this.database.transaction(() => {
      const insert = this.messageInsertStatement()
      const read = this.connection.prepare('SELECT * FROM ' + EKKO_MESSAGES_TABLE + ' WHERE id = ?')
      const lookup = this.connection.prepare('SELECT message_preview FROM ' + EKKO_SESSIONS_TABLE + ' WHERE id = ?')
      const totals = new Map<string, { count: number; calls: number; preview: string; legacy: boolean }>()
      const messages: EkkoMessage[] = []
      for (const input of inputs) {
        const id = normalizedIdentifier(input.sessionId, 'session id')
        let total = totals.get(id)
        if (!total) {
          const session = lookup.get(id)
          if (!session) throw new Error('Ekko session not found: ' + id)
          total = { count: 0, calls: 0, preview: String(session.message_preview ?? ''), legacy: session.message_preview == null }
          totals.set(id, total)
        }
        const message = insertMessage(insert, input)
        const saved = mapMessage(read.get(message.id) as DatabaseRow)
        messages.push(saved)
        total.count++
        total.calls += saved.toolCalls?.length ?? 0
        if (!total.preview && saved.role === 'user') total.preview = compactPreview(saved.content)
      }
      const update = this.connection.prepare(`
        UPDATE ${EKKO_SESSIONS_TABLE}
        SET message_count = message_count + ?, tool_call_count = tool_call_count + ?,
            preview = ?, message_preview = ?,
            last_active = (SELECT MAX(timestamp) FROM ${EKKO_MESSAGES_TABLE} WHERE session_id = ?)
        WHERE id = ?
      `)
      for (const [id, total] of totals) {
        if (total.legacy) this.recomputeSessionMessageStats(id, false)
        else update.run(total.count, total.calls, total.preview, total.preview, id, id)
      }
      return messages
    })
  }

  getMessage(id: number): EkkoMessage | null {
    const messageId = boundedInteger(id, 0, 1, Number.MAX_SAFE_INTEGER)
    const row = this.connection.prepare(
      `SELECT * FROM ${EKKO_MESSAGES_TABLE} WHERE id = ?`,
    ).get(messageId) as DatabaseRow | undefined
    return row ? mapMessage(row) : null
  }

  listMessages(sessionId: string, input: ListEkkoMessagesInput = {}): EkkoMessage[] {
    const id = normalizedIdentifier(sessionId, 'session id')
    const clauses = ['session_id = ?']
    const values: SQLInputValue[] = [id]
    if (input.afterId !== undefined) {
      clauses.push('id > ?')
      values.push(boundedInteger(input.afterId, 0, 0, Number.MAX_SAFE_INTEGER))
    }
    if (input.beforeId !== undefined) {
      clauses.push('id < ?')
      values.push(boundedInteger(input.beforeId, 0, 1, Number.MAX_SAFE_INTEGER))
    }
    const roles = [...new Set(input.roles || [])]
    if (roles.length > 0) {
      clauses.push(`role IN (${roles.map(() => '?').join(', ')})`)
      values.push(...roles)
    }
    const limit = boundedInteger(input.limit, 500, 1, 10_000)
    const offset = boundedInteger(input.offset, 0, 0, Number.MAX_SAFE_INTEGER)
    values.push(limit, offset)
    const rows = this.connection.prepare(`
      SELECT * FROM ${EKKO_MESSAGES_TABLE}
      WHERE ${clauses.join(' AND ')}
      ORDER BY id ASC
      LIMIT ? OFFSET ?
    `).all(...values) as DatabaseRow[]
    return rows.map(mapMessage)
  }

  updateMessage(id: number, patch: UpdateEkkoMessageInput): EkkoMessage | null {
    const message = this.getMessage(id)
    if (!message) return null
    const assignments: string[] = []
    const values: SQLInputValue[] = []
    for (const [key, value] of Object.entries(patch) as Array<[keyof UpdateEkkoMessageInput, unknown]>) {
      if (value === undefined) continue
      assignments.push(`${MESSAGE_UPDATE_COLUMNS[key]} = ?`)
      values.push(messageUpdateValue(key, value))
    }
    if (assignments.length === 0) return message
    values.push(message.id)
    return this.database.transaction(() => {
      this.connection.prepare(
        `UPDATE ${EKKO_MESSAGES_TABLE} SET ${assignments.join(', ')} WHERE id = ?`,
      ).run(...values)
      this.recomputeSessionMessageStats(message.sessionId, true)
      return this.getMessage(message.id)
    })
  }

  deleteMessage(id: number): boolean {
    const message = this.getMessage(id)
    if (!message) return false
    return this.database.transaction(() => {
      const result = this.connection.prepare(`DELETE FROM ${EKKO_MESSAGES_TABLE} WHERE id = ?`).run(message.id)
      this.recomputeSessionMessageStats(message.sessionId, true)
      return Number(result.changes) > 0
    })
  }

  clearMessages(sessionId: string): number {
    const id = normalizedIdentifier(sessionId, 'session id')
    return this.database.transaction(() => {
      const result = this.connection.prepare(
        `DELETE FROM ${EKKO_MESSAGES_TABLE} WHERE session_id = ?`,
      ).run(id)
      this.recomputeSessionMessageStats(id, true)
      return Number(result.changes)
    })
  }

  recordSessionUsage(sessionId: string, usage: EkkoSessionUsageUpdate): EkkoSession | null {
    const id = normalizedIdentifier(sessionId, 'session id')
    const actualCost = usage.actualCostUsd
    const result = this.connection.prepare(`
      UPDATE ${EKKO_SESSIONS_TABLE}
      SET input_tokens = input_tokens + ?,
          output_tokens = output_tokens + ?,
          cache_read_tokens = cache_read_tokens + ?,
          cache_write_tokens = cache_write_tokens + ?,
          reasoning_tokens = reasoning_tokens + ?,
          billing_provider = COALESCE(?, billing_provider),
          estimated_cost_usd = estimated_cost_usd + ?,
          actual_cost_usd = CASE
            WHEN ? IS NULL THEN actual_cost_usd
            ELSE COALESCE(actual_cost_usd, 0) + ?
          END,
          cost_status = COALESCE(?, cost_status),
          last_active = ?
      WHERE id = ?
    `).run(
      nonnegativeInteger(usage.inputTokens),
      nonnegativeInteger(usage.outputTokens),
      nonnegativeInteger(usage.cacheReadTokens),
      nonnegativeInteger(usage.cacheWriteTokens),
      nonnegativeInteger(usage.reasoningTokens),
      nullableString(usage.billingProvider),
      nonnegativeNumber(usage.estimatedCostUsd),
      actualCost == null ? null : nonnegativeNumber(actualCost),
      actualCost == null ? null : nonnegativeNumber(actualCost),
      nullableString(usage.costStatus),
      timestamp(),
      id,
    )
    return Number(result.changes) > 0 ? this.getSession(id) : null
  }

  private get connection(): DatabaseSync {
    return this.database.connection
  }

  private messageInsertStatement(): StatementSync {
    return this.connection.prepare(`
      INSERT INTO ${EKKO_MESSAGES_TABLE} (
        session_id, role, content, display_role, display_content, tool_call_id,
        tool_calls, tool_name, timestamp, token_count, finish_reason, reasoning,
        reasoning_details, reasoning_content
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
  }

  private recomputeSessionMessageStats(sessionId: string, incrementRevision: boolean): void {
    const rows = this.connection.prepare(`
      SELECT id, role, content, tool_calls, timestamp
      FROM ${EKKO_MESSAGES_TABLE}
      WHERE session_id = ?
      ORDER BY id ASC
    `).all(sessionId) as DatabaseRow[]
    const toolCallCount = rows.reduce((total, row) => total + (parseToolCalls(row.tool_calls)?.length || 0), 0)
    const previewRow = rows.find(row => row.role === 'user' && String(row.content || '').trim())
    const preview = previewRow ? compactPreview(String(previewRow.content)) : ''
    const lastActive = rows.length > 0
      ? rows.reduce((latest, row) => Math.max(latest, Number(row.timestamp)), -Infinity)
      : Number((this.connection.prepare(
          `SELECT started_at FROM ${EKKO_SESSIONS_TABLE} WHERE id = ?`,
        ).get(sessionId) as DatabaseRow | undefined)?.started_at || timestamp())
    this.connection.prepare(`
      UPDATE ${EKKO_SESSIONS_TABLE}
      SET message_count = ?,
          tool_call_count = ?,
          preview = ?, message_preview = ?,
          last_active = ?,
          history_revision = history_revision + ?
      WHERE id = ?
    `).run(rows.length, toolCallCount, preview, preview, lastActive, incrementRevision ? 1 : 0, sessionId)
  }
}

function insertMessage(statement: StatementSync, input: AddEkkoMessageInput): { id: number } {
  const sessionId = normalizedIdentifier(input.sessionId, 'session id')
  const result = statement.run(
    sessionId,
    input.role,
    string(input.content),
    nullableString(input.displayRole),
    nullableString(input.displayContent),
    nullableString(input.toolCallId),
    input.toolCalls == null ? null : JSON.stringify(input.toolCalls),
    nullableString(input.toolName),
    timestamp(input.timestamp),
    nullableNonnegativeInteger(input.tokenCount),
    nullableString(input.finishReason),
    nullableString(input.reasoning),
    serializeJson(input.reasoningDetails),
    nullableString(input.reasoningContent),
  )
  return { id: Number(result.lastInsertRowid) }
}

function mapSession(row: DatabaseRow): EkkoSession {
  return {
    id: String(row.id),
    profile: String(row.profile || 'default'),
    source: String(row.source || 'ekko-agent'),
    agent: String(row.agent || 'ekko-agent'),
    agentMode: String(row.agent_mode || ''),
    agentSessionId: String(row.agent_session_id || ''),
    agentNativeSessionId: String(row.agent_native_session_id || ''),
    userId: nullableString(row.user_id),
    model: String(row.model || ''),
    provider: String(row.provider || ''),
    apiMode: String(row.api_mode || ''),
    title: nullableString(row.title),
    parentSessionId: nullableString(row.parent_session_id),
    forkPointMessageId: nullableString(row.fork_point_message_id),
    startedAt: Number(row.started_at || 0),
    endedAt: nullableNumber(row.ended_at),
    endReason: nullableString(row.end_reason),
    messageCount: Number(row.message_count || 0),
    toolCallCount: Number(row.tool_call_count || 0),
    inputTokens: Number(row.input_tokens || 0),
    outputTokens: Number(row.output_tokens || 0),
    cacheReadTokens: Number(row.cache_read_tokens || 0),
    cacheWriteTokens: Number(row.cache_write_tokens || 0),
    reasoningTokens: Number(row.reasoning_tokens || 0),
    billingProvider: nullableString(row.billing_provider),
    estimatedCostUsd: Number(row.estimated_cost_usd || 0),
    actualCostUsd: nullableNumber(row.actual_cost_usd),
    costStatus: String(row.cost_status || ''),
    preview: String(row.preview || ''),
    lastActive: Number(row.last_active || 0),
    isArchived: Number(row.is_archived || 0) === 1,
    workspace: nullableString(row.workspace),
    categoryId: nullableNumber(row.category_id),
    historyRevision: Number(row.history_revision || 0),
  }
}

function mapMessage(row: DatabaseRow): EkkoMessage {
  return {
    id: Number(row.id),
    sessionId: String(row.session_id),
    role: String(row.role) as AgentMessageRole,
    content: String(row.content || ''),
    displayRole: nullableString(row.display_role),
    displayContent: nullableString(row.display_content),
    toolCallId: nullableString(row.tool_call_id),
    toolCalls: parseToolCalls(row.tool_calls),
    toolName: nullableString(row.tool_name),
    timestamp: Number(row.timestamp || 0),
    tokenCount: nullableNumber(row.token_count),
    finishReason: nullableString(row.finish_reason),
    reasoning: nullableString(row.reasoning),
    reasoningDetails: parseJson(row.reasoning_details),
    reasoningContent: nullableString(row.reasoning_content),
  }
}

function sessionUpdateValue(key: keyof UpdateEkkoSessionInput, value: unknown): SQLInputValue {
  if (key === 'isArchived') return value ? 1 : 0
  if (['endedAt', 'lastActive', 'categoryId'].includes(key)) return nullableInteger(value)
  if (['estimatedCostUsd', 'actualCostUsd'].includes(key)) return nullableNumber(value)
  if ([
    'userId',
    'title',
    'parentSessionId',
    'forkPointMessageId',
    'endReason',
    'billingProvider',
    'workspace',
  ].includes(key)) return nullableString(value)
  return string(value)
}

function messageUpdateValue(key: keyof UpdateEkkoMessageInput, value: unknown): SQLInputValue {
  if (key === 'toolCalls') return value == null ? null : JSON.stringify(value)
  if (key === 'reasoningDetails') return serializeJson(value)
  if (key === 'timestamp') return timestamp(Number(value))
  if (key === 'tokenCount') return nullableNonnegativeInteger(value)
  if (['displayRole', 'displayContent', 'toolCallId', 'toolName', 'finishReason', 'reasoning', 'reasoningContent'].includes(key)) {
    return nullableString(value)
  }
  return string(value)
}

function parseToolCalls(value: unknown): AgentToolCall[] | null {
  const parsed = parseJson(value)
  return Array.isArray(parsed) ? parsed as AgentToolCall[] : null
}

function parseJson(value: unknown): unknown {
  if (value == null || value === '') return null
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function serializeJson(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value)
}

function normalizedIdentifier(value: unknown, label: string): string {
  const normalized = String(value || '').trim()
  if (!normalized) throw new Error(`Ekko ${label} is required.`)
  return normalized
}

function string(value: unknown): string {
  return value == null ? '' : String(value)
}

function nonempty(value: unknown, fallback: string): string {
  return String(value || '').trim() || fallback
}

function nullableString(value: unknown): string | null {
  if (value == null) return null
  const normalized = String(value).trim()
  return normalized || null
}

function nullableNumber(value: unknown): number | null {
  if (value == null || value === '') return null
  const normalized = Number(value)
  if (!Number.isFinite(normalized)) throw new Error('Expected a finite number.')
  return normalized
}

function nullableInteger(value: unknown): number | null {
  const normalized = nullableNumber(value)
  if (normalized === null) return null
  if (!Number.isInteger(normalized)) throw new Error('Expected an integer.')
  return normalized
}

function nullableNonnegativeInteger(value: unknown): number | null {
  const normalized = nullableInteger(value)
  if (normalized !== null && normalized < 0) throw new Error('Expected a non-negative integer.')
  return normalized
}

function nonnegativeInteger(value: unknown): number {
  return nullableNonnegativeInteger(value) || 0
}

function nonnegativeNumber(value: unknown): number {
  const normalized = nullableNumber(value) || 0
  if (normalized < 0) throw new Error('Expected a non-negative number.')
  return normalized
}

function timestamp(value?: number): number {
  if (value === undefined) return Math.floor(Date.now() / 1_000)
  if (!Number.isInteger(value) || value < 0) throw new Error('Timestamp must be a non-negative integer.')
  return value
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback
  const normalized = Number(value)
  if (!Number.isInteger(normalized)) throw new Error('Expected an integer.')
  return Math.min(maximum, Math.max(minimum, normalized))
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, match => `\\${match}`)
}

function compactPreview(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim().slice(0, 63)
}
