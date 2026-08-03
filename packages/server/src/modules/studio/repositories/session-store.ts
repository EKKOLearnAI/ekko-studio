/**
 * Self-built session database — completely replaces Hermes CLI dependency.
 * Uses the same ensureTable/getDb pattern as usage-store.ts.
 */
import { isSqliteAvailable, getDb } from '../infrastructure/database'
import { TASK_PLANS_TABLE, COMPRESSION_SNAPSHOT_TABLE, SESSIONS_TABLE, MESSAGES_TABLE, SESSION_CATEGORIES_TABLE } from '../infrastructure/database/schemas'
import { normalizeMessageContentForStorageRole } from './message-content'
import { copyCompressionSnapshot } from './compression-snapshot'
import { recordSkillUsageMessage } from './skill-usage-store'
import { getRecordedUsageByRun } from './usage-store'

// Re-export types for compatibility with sessions-db.ts consumers
export interface HermesSessionRow {
  id: string
  profile: string
  source: string
  agent: string
  agent_mode: string
  agent_preset: string
  agent_session_id: string
  agent_native_session_id: string
  user_id: string | null
  model: string
  provider: string
  api_mode: string
  reasoning_effort: string
  title: string | null
  parent_session_id: string | null
  fork_point_message_id: string | null
  started_at: number
  ended_at: number | null
  end_reason: string | null
  message_count: number
  tool_call_count: number
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  reasoning_tokens: number
  billing_provider: string | null
  estimated_cost_usd: number
  actual_cost_usd: number | null
  cost_status: string
  preview: string
  last_active: number
  is_archived: number
  is_pinned: number
  push_enabled: number
  workspace: string | null
  category_id: number | null
  history_revision: number
  parent_title?: string | null
  parent_last_message?: string | null
  parent_last_message_role?: string | null
}

export interface HermesMessageRow {
  id: number | string
  session_id: string
  role: string
  content: string
  display_role: string | null
  display_content: string | null
  tool_call_id: string | null
  tool_calls: any[] | null
  tool_name: string | null
  run_marker: string | null
  timestamp: number
  token_count: number | null
  finish_reason: string | null
  reasoning: string | null
  reasoning_details?: string | null
  reasoning_content?: string | null
  /** Run id of the model run that produced this message (assistant/tool rows only). */
  run_id?: string | null
  /** Provider-recorded usage for this run; attached on read by
   *  {@link attachRunUsageToMessages}, not persisted in the messages table. */
  usage?: {
    input: number
    output: number
    cacheRead?: number
    cacheWrite?: number
    reasoning?: number
    apiCalls?: number
  } | null
}

export interface HermesSessionSearchRow extends HermesSessionRow {
  snippet: string
  matched_message_id: number | null
  rank: number
}

export interface SessionListOptions {
  offset?: number
  categoryId?: number | null
  pinned?: boolean
  includeSessionIds?: string[]
  sources?: string[]
  profiles?: string[]
  includeArchived?: boolean
  excludeSessionIds?: string[]
}

export type SessionSearchOptions = SessionListOptions

export interface HermesSessionDetailRow extends HermesSessionRow {
  messages: HermesMessageRow[]
  thread_session_count: number
}

// Note: Table schemas and initialization are now centralized in schemas.ts
// Tables are created automatically on bootstrap via initAllHermesTables()

// --- Helpers ---

function parseToolCalls(value: unknown): any[] | null {
  if (value == null || value === '') return null
  if (Array.isArray(value)) return value
  if (typeof value !== 'string') return null
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function mapSessionRow(row: Record<string, unknown>): HermesSessionRow {
  const rawTitle = row.title != null ? String(row.title) : null
  const preview = String(row.preview || '')
  const title = rawTitle || (preview ? (preview.length > 40 ? preview.slice(0, 40) + '...' : preview) : null)
  return {
    id: String(row.id || ''),
    profile: String(row.profile || 'default'),
    source: String(row.source || 'api_server'),
    agent: String(row.agent || ''),
    agent_mode: String(row.agent_mode || ''),
    agent_preset: String(row.agent_preset || ''),
    agent_session_id: String(row.agent_session_id || ''),
    agent_native_session_id: String(row.agent_native_session_id || ''),
    user_id: row.user_id != null ? String(row.user_id) : null,
    model: String(row.model || ''),
    provider: String(row.provider || ''),
    api_mode: String(row.api_mode || ''),
    reasoning_effort: String(row.reasoning_effort || ''),
    title,
    parent_session_id: row.parent_session_id != null ? String(row.parent_session_id) : null,
    fork_point_message_id: row.fork_point_message_id != null ? String(row.fork_point_message_id) : null,
    started_at: Number(row.started_at || 0),
    ended_at: row.ended_at != null ? Number(row.ended_at) : null,
    end_reason: row.end_reason != null ? String(row.end_reason) : null,
    message_count: Number(row.message_count || 0),
    tool_call_count: Number(row.tool_call_count || 0),
    input_tokens: Number(row.input_tokens || 0),
    output_tokens: Number(row.output_tokens || 0),
    cache_read_tokens: Number(row.cache_read_tokens || 0),
    cache_write_tokens: Number(row.cache_write_tokens || 0),
    reasoning_tokens: Number(row.reasoning_tokens || 0),
    billing_provider: row.billing_provider != null ? String(row.billing_provider) : null,
    estimated_cost_usd: Number(row.estimated_cost_usd || 0),
    actual_cost_usd: row.actual_cost_usd != null ? Number(row.actual_cost_usd) : null,
    cost_status: String(row.cost_status || ''),
    preview: String(row.preview || ''),
    last_active: Number(row.last_active || 0),
    is_archived: Number(row.is_archived || 0),
    is_pinned: Number(row.is_pinned || 0),
    push_enabled: Number(row.push_enabled || 0) !== 0 ? 1 : 0,
    workspace: row.workspace != null ? String(row.workspace) : null,
    category_id: row.category_id != null ? Number(row.category_id) : null,
    history_revision: Number(row.history_revision || 0),
    parent_title: row.parent_title != null ? String(row.parent_title) : null,
    parent_last_message: row.parent_last_message != null ? String(row.parent_last_message) : null,
    parent_last_message_role: row.parent_last_message_role != null ? String(row.parent_last_message_role) : null,
  }
}

function mapMessageRow(row: Record<string, unknown>): HermesMessageRow {
  return {
    id: typeof row.id === 'number' ? row.id : Number(row.id),
    session_id: String(row.session_id || ''),
    role: String(row.role || ''),
    content: row.content != null ? String(row.content) : '',
    display_role: row.display_role != null ? String(row.display_role) : null,
    display_content: row.display_content != null ? String(row.display_content) : null,
    tool_call_id: row.tool_call_id != null ? String(row.tool_call_id) : null,
    tool_calls: parseToolCalls(row.tool_calls),
    tool_name: row.tool_name != null ? String(row.tool_name) : null,
    run_marker: row.run_marker != null ? String(row.run_marker) : null,
    timestamp: Number(row.timestamp || 0),
    token_count: row.token_count != null ? Number(row.token_count) : null,
    finish_reason: row.finish_reason != null ? String(row.finish_reason) : null,
    reasoning: row.reasoning != null ? String(row.reasoning) : null,
    reasoning_details: row.reasoning_details != null ? String(row.reasoning_details) : null,
    reasoning_content: row.reasoning_content != null ? String(row.reasoning_content) : null,
    run_id: row.run_id != null && row.run_id !== '' ? String(row.run_id) : null,
  }
}


// --- Session CRUD ---

export function createSession(data: {
  id: string
  profile?: string
  source?: string
  agent?: string
  agent_mode?: string
  agent_preset?: string
  agent_session_id?: string
  agent_native_session_id?: string
  user_id?: string | number | null
  model?: string
  provider?: string
  api_mode?: string
  reasoning_effort?: string
  title?: string
  parent_session_id?: string | null
  workspace?: string
  category_id?: number | null
  push_enabled?: boolean | number
}): HermesSessionRow {
  const now = Math.floor(Date.now() / 1000)
  const source = data.source || 'api_server'
  const agent = data.agent || (source === 'cli' ? 'hermes' : '')
  if (!isSqliteAvailable()) {
    return {
      id: data.id, profile: data.profile || 'default', source, agent,
      agent_mode: data.agent_mode || '',
      agent_preset: data.agent_preset || '',
      agent_session_id: data.agent_session_id || '', agent_native_session_id: data.agent_native_session_id || '',
      user_id: data.user_id == null ? null : String(data.user_id), model: data.model || '', provider: data.provider || '', api_mode: data.api_mode || '', reasoning_effort: data.reasoning_effort || '', title: data.title || null,
      parent_session_id: data.parent_session_id || null,
      fork_point_message_id: null,
      started_at: now, ended_at: null, end_reason: null,
      message_count: 0, tool_call_count: 0,
      input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0,
      billing_provider: null, estimated_cost_usd: 0, actual_cost_usd: null,
      cost_status: '', preview: '', last_active: now, is_archived: 0, is_pinned: 0, push_enabled: data.push_enabled ? 1 : 0, workspace: data.workspace || null,
      category_id: data.category_id ?? null,
      history_revision: 0,
    }
  }
  const db = getDb()!
  db.prepare(
    `INSERT INTO ${SESSIONS_TABLE} (id, profile, source, agent, agent_mode, agent_preset, agent_session_id, agent_native_session_id, user_id, model, provider, api_mode, reasoning_effort, title, parent_session_id, started_at, last_active, workspace, category_id, push_enabled)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    data.id,
    data.profile || 'default',
    source,
    agent,
    data.agent_mode || '',
    data.agent_preset || '',
    data.agent_session_id || '',
    data.agent_native_session_id || '',
    data.user_id == null ? null : String(data.user_id),
    data.model || '',
    data.provider || '',
    data.api_mode || '',
    data.reasoning_effort || '',
    data.title || null,
    data.parent_session_id || null,
    now,
    now,
    data.workspace || null,
    data.category_id ?? null,
    data.push_enabled ? 1 : 0,
  )
  return getSession(data.id)!
}

export function createBranchedSession(data: {
  parent_session_id: string
  id: string
  profile?: string
  source?: string
  agent?: string
  agent_mode?: string
  agent_preset?: string
  agent_session_id?: string
  agent_native_session_id?: string
  user_id?: string | number | null
  model?: string
  provider?: string
  api_mode?: string
  reasoning_effort?: string
  title?: string
  workspace?: string | null
  category_id?: number | null
  ended_at: number
  last_active: number
  messages: Array<{
    role: string
    content: string
    display_role?: string | null
    display_content?: string | null
    tool_call_id?: string | null
    tool_calls?: any[] | null
    tool_name?: string | null
    run_marker?: string | null
    timestamp?: number
    token_count?: number | null
    finish_reason?: string | null
    reasoning?: string | null
    reasoning_details?: string | null
    reasoning_content?: string | null
  }>
}): HermesSessionRow | null {
  if (!isSqliteAvailable()) return null
  const db = getDb()!
  const source = data.source || 'api_server'
  const agent = data.agent || (source === 'cli' ? 'hermes' : '')
  const insertMessage = db.prepare(
    `INSERT INTO ${MESSAGES_TABLE} (session_id, role, content, display_role, display_content, tool_call_id, tool_calls, tool_name, run_marker, timestamp, token_count, finish_reason, reasoning, reasoning_details, reasoning_content)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )

  db.exec('BEGIN')
  try {
    db.prepare(
      `UPDATE ${SESSIONS_TABLE} SET ended_at = ?, end_reason = ? WHERE id = ?`,
    ).run(data.ended_at, 'branched', data.parent_session_id)

    db.prepare(
      `INSERT INTO ${SESSIONS_TABLE} (id, profile, source, agent, agent_mode, agent_preset, agent_session_id, agent_native_session_id, user_id, model, provider, api_mode, reasoning_effort, title, parent_session_id, started_at, last_active, workspace, category_id, message_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      data.id,
      data.profile || 'default',
      source,
      agent,
      data.agent_mode || '',
      data.agent_preset || '',
      data.agent_session_id || '',
      data.agent_native_session_id || '',
      data.user_id == null ? null : String(data.user_id),
      data.model || '',
      data.provider || '',
      data.api_mode || '',
      data.reasoning_effort || '',
      data.title || null,
      data.parent_session_id,
      data.ended_at,
      data.last_active,
      data.workspace || null,
      data.category_id ?? null,
      data.messages.length,
    )

    let forkPointMessageId: string | null = null
    for (const msg of data.messages) {
      const result = insertMessage.run(
        data.id,
        msg.role,
        normalizeMessageContentForStorageRole(msg.role, msg.content),
        msg.display_role ?? null,
        msg.display_content ?? null,
        msg.tool_call_id ?? null,
        msg.tool_calls ? JSON.stringify(msg.tool_calls) : null,
        msg.tool_name ?? null,
        msg.run_marker ?? null,
        msg.timestamp ?? data.last_active,
        msg.token_count ?? null,
        msg.finish_reason ?? null,
        msg.reasoning ?? null,
        msg.reasoning_details ?? null,
        msg.reasoning_content ?? null,
      )
      if (result.lastInsertRowid != null) {
        const messageId = Number(result.lastInsertRowid)
        forkPointMessageId = String(messageId)
        recordSkillUsageMessage(messageId, { ...msg, session_id: data.id })
      }
    }

    if (forkPointMessageId) {
      db.prepare(
        `UPDATE ${SESSIONS_TABLE} SET fork_point_message_id = ? WHERE id = ?`,
      ).run(forkPointMessageId, data.id)
    }

    // Preserve the parent's compressed runtime context when its boundary is in
    // the copied prefix. Cursor IDs are remapped to the child's new row IDs.
    copyCompressionSnapshot(data.parent_session_id, data.id)
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }

  return getSession(data.id)
}

export function getSession(id: string): HermesSessionRow | null {
  if (!isSqliteAvailable()) return null
  const db = getDb()!
  const row = db.prepare(
    `SELECT * FROM ${SESSIONS_TABLE} WHERE id = ?`,
  ).get(id) as Record<string, unknown> | undefined
  return row ? mapSessionRow(row) : null
}

/** Bounded notification text; never materialize full chat history or tool output. */
export function getSessionNotificationPreview(id: string): { title: string; preview: string } | null {
  if (!isSqliteAvailable()) return null
  const row = getDb()!.prepare(`
    SELECT SUBSTR(COALESCE(NULLIF(s.title, ''), NULLIF(s.preview, ''),
      (SELECT SUBSTR(m.content, 1, 63) FROM ${MESSAGES_TABLE} m
       WHERE m.session_id = s.id AND m.role = 'user' AND m.content != ''
       ORDER BY m.timestamp, m.id LIMIT 1), ''), 1, 120) AS title,
      COALESCE((SELECT SUBSTR(COALESCE(NULLIF(m.display_content, ''), m.content), 1, 240)
       FROM ${MESSAGES_TABLE} m WHERE m.session_id = s.id AND m.role = 'assistant' AND m.content != ''
       ORDER BY m.timestamp DESC, m.id DESC LIMIT 1), '') AS preview
    FROM ${SESSIONS_TABLE} s WHERE s.id = ?
  `).get(id) as { title: string; preview: string } | undefined
  return row || null
}

/** Session and branch metadata without loading this session's message bodies. */
export function getSessionMetadata(id: string): HermesSessionRow | null {
  if (!isSqliteAvailable()) return null
  const row = getDb()!.prepare(`
    SELECT s.*, p.title AS parent_title,
      (
        SELECT REPLACE(REPLACE(m.content, CHAR(10), ' '), CHAR(13), ' ')
        FROM ${MESSAGES_TABLE} m
        WHERE m.session_id = s.parent_session_id
          AND m.role IN ('user', 'assistant')
          AND m.content IS NOT NULL
          AND TRIM(m.content) <> ''
        ORDER BY m.timestamp DESC, m.id DESC
        LIMIT 1
      ) AS parent_last_message,
      (
        SELECT m.role
        FROM ${MESSAGES_TABLE} m
        WHERE m.session_id = s.parent_session_id
          AND m.role IN ('user', 'assistant')
          AND m.content IS NOT NULL
          AND TRIM(m.content) <> ''
        ORDER BY m.timestamp DESC, m.id DESC
        LIMIT 1
      ) AS parent_last_message_role
    FROM ${SESSIONS_TABLE} s
    LEFT JOIN ${SESSIONS_TABLE} p ON p.id = s.parent_session_id
    WHERE s.id = ?
  `).get(id) as Record<string, unknown> | undefined
  return row ? mapSessionRow(row) : null
}

export function updateSession(id: string, data: Partial<Omit<HermesSessionRow, 'id' | 'profile'>>): void {
  if (!isSqliteAvailable()) return
  const db = getDb()!
  const fields: string[] = []
  const values: any[] = []
  for (const [key, val] of Object.entries(data)) {
    if (key === 'id' || key === 'profile') continue
    // Skip last_active and ended_at - handle them separately below
    if (key === 'last_active' || key === 'ended_at') continue
    fields.push(`"${key}" = ?`)
    values.push(val)
  }

  // Handle ended_at - only update if provided, otherwise keep existing value
  if (data.ended_at !== undefined) {
    fields.push(`"ended_at" = ?`)
    values.push(data.ended_at)
  }

  // Handle last_active - use provided value or current time
  if (data.last_active !== undefined) {
    fields.push(`"last_active" = ?`)
    values.push(data.last_active)
  }

  if (fields.length === 0) return
  db.prepare(`UPDATE ${SESSIONS_TABLE} SET ${fields.join(', ')} WHERE id = ?`).run(...values, id)
}

export function deleteSession(id: string): boolean {
  if (!isSqliteAvailable()) return false
  const db = getDb()!
  db.exec('BEGIN')
  try {
    db.prepare(`DELETE FROM ${TASK_PLANS_TABLE} WHERE session_id = ?`).run(id)
    db.prepare(`DELETE FROM ${COMPRESSION_SNAPSHOT_TABLE} WHERE session_id = ?`).run(id)
    db.prepare(`DELETE FROM ${MESSAGES_TABLE} WHERE session_id = ?`).run(id)
    const result = db.prepare(`DELETE FROM ${SESSIONS_TABLE} WHERE id = ?`).run(id)
    db.exec('COMMIT')
    return result.changes > 0
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function clearSessionMessages(id: string): number {
  if (!isSqliteAvailable()) return 0
  const db = getDb()!
  db.exec('BEGIN')
  try {
    const result = db.prepare(`DELETE FROM ${MESSAGES_TABLE} WHERE session_id = ?`).run(id)
    db.prepare(`DELETE FROM ${TASK_PLANS_TABLE} WHERE session_id = ?`).run(id)
    db.prepare(`DELETE FROM ${COMPRESSION_SNAPSHOT_TABLE} WHERE session_id = ?`).run(id)
    db.prepare(
      `UPDATE ${SESSIONS_TABLE}
       SET history_revision = history_revision + 1,
           message_count = 0,
           last_active = started_at
       WHERE id = ?`,
    ).run(id)
    db.exec('COMMIT')
    return Number(result.changes)
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function renameSession(id: string, title: string): boolean {
  if (!isSqliteAvailable()) return false
  const db = getDb()!
  const result = db.prepare(`UPDATE ${SESSIONS_TABLE} SET title = ? WHERE id = ?`).run(title, id)
  return result.changes > 0
}

export function setSessionArchived(id: string, archived: boolean): boolean {
  if (!isSqliteAvailable()) return false
  const db = getDb()!
  const result = db.prepare(`UPDATE ${SESSIONS_TABLE} SET is_archived = ? WHERE id = ?`).run(archived ? 1 : 0, id)
  return result.changes > 0
}

export function setSessionPinned(id: string, pinned: boolean): boolean {
  if (!isSqliteAvailable()) return false
  const result = getDb()!.prepare(`UPDATE ${SESSIONS_TABLE} SET is_pinned = ? WHERE id = ?`)
    .run(pinned ? 1 : 0, id)
  return result.changes > 0
}

export function setSessionPushEnabled(id: string, enabled: boolean): boolean {
  if (!isSqliteAvailable()) return false
  const db = getDb()!
  const result = db.prepare(`UPDATE ${SESSIONS_TABLE} SET push_enabled = ? WHERE id = ?`).run(enabled ? 1 : 0, id)
  return result.changes > 0
}

export function listSessions(
  profile?: string,
  source?: string,
  limit = 2000,
  options: SessionListOptions = {},
): HermesSessionRow[] {
  if (!isSqliteAvailable()) return []
  const filters = sessionFilterSql(profile, source ? { ...options, sources: [source] } : options)
  if (!filters) return []
  const db = getDb()!

  // Use a subquery to generate preview from first user message if not set
  const sql = `
    SELECT
      s.*,
      COALESCE(
        NULLIF(s.preview, ''),
        (
          SELECT SUBSTR(REPLACE(REPLACE(m.content, CHAR(10), ' '), CHAR(13), ' '), 1, 63)
          FROM ${MESSAGES_TABLE} m
          WHERE m.session_id = s.id AND m.role = 'user' AND m.content IS NOT NULL
          ORDER BY m.timestamp, m.id
          LIMIT 1
        ),
        ''
      ) AS preview,
      p.title AS parent_title,
      (
        SELECT REPLACE(REPLACE(m.content, CHAR(10), ' '), CHAR(13), ' ')
        FROM ${MESSAGES_TABLE} m
        WHERE m.session_id = s.parent_session_id
          AND m.role IN ('user', 'assistant')
          AND m.content IS NOT NULL
          AND TRIM(m.content) <> ''
        ORDER BY m.timestamp DESC, m.id DESC
        LIMIT 1
      ) AS parent_last_message,
      (
        SELECT m.role
        FROM ${MESSAGES_TABLE} m
        WHERE m.session_id = s.parent_session_id
          AND m.role IN ('user', 'assistant')
          AND m.content IS NOT NULL
          AND TRIM(m.content) <> ''
        ORDER BY m.timestamp DESC, m.id DESC
        LIMIT 1
      ) AS parent_last_message_role
    FROM ${SESSIONS_TABLE} s
    LEFT JOIN ${SESSIONS_TABLE} p ON p.id = s.parent_session_id
    WHERE ${filters.sql}
    ORDER BY s.is_pinned DESC, s.last_active DESC, s.id DESC
    LIMIT ? OFFSET ?
  `

  const offset = Number.isSafeInteger(options.offset) && options.offset! > 0 ? options.offset! : 0
  const rows = db.prepare(sql).all(...filters.params, limit, offset) as Record<string, unknown>[]
  return rows.map(mapSessionRow)
}

export function countSessions(
  profile?: string,
  source?: string,
  options: SessionListOptions = {},
): number {
  if (!isSqliteAvailable()) return 0
  const filters = sessionFilterSql(profile, source ? { ...options, sources: [source] } : options)
  if (!filters) return 0
  const row = getDb()!.prepare(`SELECT COUNT(*) AS total FROM ${SESSIONS_TABLE} s WHERE ${filters.sql}`)
    .get(...filters.params) as { total: number }
  return Number(row.total)
}

function escapeSessionSearchLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&')
}

function sessionSearchTerms(query: string): string[] {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return []
  const splitTerms = normalized
    .split(/\s+/u)
    .filter(term => term && !/^[\p{P}\p{S}]+$/u.test(term))
  const terms = splitTerms.length > 0 ? splitTerms : [normalized]
  return [...new Set(terms)].slice(0, 20)
}

function sessionSearchMatchSql(column: string, termCount: number): string {
  return Array.from(
    { length: termCount },
    () => `LOWER(COALESCE(${column}, '')) LIKE ? ESCAPE '\\'`,
  ).join(' AND ')
}

function sessionSearchMessageMatchSql(alias: string, termCount: number): string {
  return Array.from(
    { length: termCount },
    () => `(LOWER(COALESCE(${alias}.content, '')) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(${alias}.tool_name, '')) LIKE ? ESCAPE '\\')`,
  ).join(' AND ')
}

function sessionFilterSql(
  profile: string | null | undefined,
  options: SessionListOptions,
): { sql: string; params: string[] } | null {
  const clauses: string[] = []
  const params: string[] = []
  const profileFilter = profile?.trim()
  if (profileFilter) {
    clauses.push('s.profile = ?')
    params.push(profileFilter)
  } else if (options.profiles !== undefined) {
    const profiles = [...new Set(options.profiles.map(value => value.trim()).filter(Boolean))]
    if (profiles.length === 0) return null
    clauses.push(`s.profile IN (${profiles.map(() => '?').join(', ')})`)
    params.push(...profiles)
  }

  if (options.sources !== undefined) {
    const sources = [...new Set(options.sources.map(value => value.trim()).filter(Boolean))]
    if (sources.length === 0) return null
    clauses.push(`s.source IN (${sources.map(() => '?').join(', ')})`)
    params.push(...sources)
  }
  if (options.includeArchived === false) {
    clauses.push('COALESCE(s.is_archived, 0) = 0')
  }
  if (options.pinned !== undefined) clauses.push(options.pinned ? 's.is_pinned = 1' : 's.is_pinned = 0')
  if (options.categoryId === null) {
    clauses.push(`(s.category_id IS NULL OR NOT EXISTS (SELECT 1 FROM ${SESSION_CATEGORIES_TABLE} c WHERE c.id = s.category_id))`)
  } else if (options.categoryId !== undefined) {
    clauses.push('s.category_id = ?')
    params.push(String(options.categoryId))
  }
  if (options.includeSessionIds !== undefined) {
    const includedIds = [...new Set(options.includeSessionIds.map(value => value.trim()).filter(Boolean))]
    if (!includedIds.length) return null
    clauses.push(`s.id IN (${includedIds.map(() => '?').join(', ')})`)
    params.push(...includedIds)
  }

  const excludedIds = [...new Set((options.excludeSessionIds || []).map(value => value.trim()).filter(Boolean))]
  if (excludedIds.length > 0) {
    clauses.push(`s.id NOT IN (${excludedIds.map(() => '?').join(', ')})`)
    params.push(...excludedIds)
  }

  return {
    sql: clauses.length > 0 ? clauses.join(' AND ') : '1 = 1',
    params,
  }
}

function firstSessionSearchTermIndex(value: string, terms: string[]): number {
  const lowered = value.toLowerCase()
  let first = -1
  for (const term of terms) {
    const index = lowered.indexOf(term)
    if (index >= 0 && (first < 0 || index < first)) first = index
  }
  return first
}

function matchesAllSessionSearchTerms(value: string, terms: string[]): boolean {
  const lowered = value.toLowerCase()
  return terms.every(term => lowered.includes(term))
}

export function searchSessions(
  profile: string | null | undefined,
  query: string,
  limit = 20,
  options: SessionSearchOptions = {},
): HermesSessionSearchRow[] {
  if (!isSqliteAvailable()) return []
  const trimmed = query.trim()
  const filters = sessionFilterSql(profile, options)
  if (!filters) return []
  const db = getDb()!
  if (!trimmed) {
    const rows = db.prepare(
      `SELECT s.* FROM ${SESSIONS_TABLE} s
       WHERE ${filters.sql}
       ORDER BY s.last_active DESC
       LIMIT ?`,
    ).all(...filters.params, limit) as Record<string, unknown>[]
    return rows.map(row => {
      const session = mapSessionRow(row)
      return { ...session, snippet: session.preview || '', matched_message_id: null, rank: 0 }
    })
  }
  const lowered = trimmed.toLowerCase()
  const terms = sessionSearchTerms(trimmed)
  const patterns = terms.map(term => `%${escapeSessionSearchLike(term)}%`)
  const titleMatchSql = sessionSearchMatchSql('s.title', terms.length)
  const previewMatchSql = sessionSearchMatchSql('s.preview', terms.length)
  const messageContentMatchSql = sessionSearchMatchSql('search_message.content', terms.length)
  const messageToolMatchSql = sessionSearchMatchSql('search_message.tool_name', terms.length)
  const rankParams: string[] = [
    lowered,
    ...patterns,
    ...patterns,
    ...patterns,
    ...patterns,
  ]

  // Rank exact and partial title matches ahead of message-body matches. Apply
  // visibility filters in the same query so hidden rows cannot consume LIMIT.
  const sessionRows = db.prepare(
    `WITH ranked_sessions AS (
       SELECT s.*,
         CASE
           WHEN LOWER(TRIM(COALESCE(s.title, ''))) = ? THEN 0
           WHEN ${titleMatchSql} THEN 1
           WHEN ${previewMatchSql} THEN 2
           WHEN EXISTS (
             SELECT 1 FROM ${MESSAGES_TABLE} search_message
             WHERE search_message.session_id = s.id AND ${messageContentMatchSql}
           ) THEN 3
           WHEN EXISTS (
             SELECT 1 FROM ${MESSAGES_TABLE} search_message
             WHERE search_message.session_id = s.id AND ${messageToolMatchSql}
           ) THEN 4
           ELSE 5
         END AS search_rank
       FROM ${SESSIONS_TABLE} s
       WHERE ${filters.sql}
     )
     SELECT * FROM ranked_sessions
     WHERE search_rank < 5
     ORDER BY search_rank, last_active DESC
     LIMIT ?`,
  ).all(...rankParams, ...filters.params, limit) as Record<string, unknown>[]

  if (sessionRows.length === 0) return []

  // Find the first message containing every meaningful query term. Splitting on
  // whitespace makes rendered Markdown such as "**task** — details" searchable
  // using the plain text that the user sees.
  const messageMatchSql = sessionSearchMessageMatchSql('search_message', terms.length)
  const messagePatterns = patterns.flatMap(pattern => [pattern, pattern])
  const msgQuery = db.prepare(
    `SELECT search_message.id, search_message.content, search_message.tool_name
     FROM ${MESSAGES_TABLE} search_message
     WHERE search_message.session_id = ? AND ${messageMatchSql}
     ORDER BY search_message.timestamp, search_message.id
     LIMIT 1`,
  )

  return sessionRows.map(row => {
    const session = mapSessionRow(row)
    let snippet = ''
    let matched_message_id: number | null = null
    const title = row.title != null ? String(row.title) : ''
    const preview = row.preview != null ? String(row.preview) : ''

    if (matchesAllSessionSearchTerms(title, terms)) {
      const titleIndex = firstSessionSearchTermIndex(title, terms)
      snippet = title.substring(Math.max(0, titleIndex - 20), titleIndex + terms[0].length + 60)
    } else if (matchesAllSessionSearchTerms(preview, terms)) {
      const previewIndex = firstSessionSearchTermIndex(preview, terms)
      snippet = preview.substring(Math.max(0, previewIndex - 20), previewIndex + terms[0].length + 60)
    } else {
      const msg = msgQuery.get(session.id, ...messagePatterns) as { id: number; content: string; tool_name: string | null } | undefined
      if (msg) {
        matched_message_id = msg.id
        const contentIndex = firstSessionSearchTermIndex(msg.content, terms)
        if (contentIndex >= 0) {
          snippet = msg.content.substring(Math.max(0, contentIndex - 20), contentIndex + terms[0].length + 60)
        } else {
          snippet = msg.tool_name || ''
        }
      }
    }

    return { ...session, snippet, matched_message_id, rank: Number(row.search_rank || 0) }
  })
}

export interface PaginatedSessionDetailResult {
  session: HermesSessionRow
  messages: HermesMessageRow[]
  total: number
  offset: number
  limit: number
  hasMore: boolean
}

export function getSessionDetail(id: string): HermesSessionDetailRow | null {
  if (!isSqliteAvailable()) return null
  const db = getDb()!
  const sessionRow = db.prepare(`
    SELECT s.*, p.title AS parent_title,
      (
        SELECT REPLACE(REPLACE(m.content, CHAR(10), ' '), CHAR(13), ' ')
        FROM ${MESSAGES_TABLE} m
        WHERE m.session_id = s.parent_session_id
          AND m.role IN ('user', 'assistant')
          AND m.content IS NOT NULL
          AND TRIM(m.content) <> ''
        ORDER BY m.timestamp DESC, m.id DESC
        LIMIT 1
      ) AS parent_last_message,
      (
        SELECT m.role
        FROM ${MESSAGES_TABLE} m
        WHERE m.session_id = s.parent_session_id
          AND m.role IN ('user', 'assistant')
          AND m.content IS NOT NULL
          AND TRIM(m.content) <> ''
        ORDER BY m.timestamp DESC, m.id DESC
        LIMIT 1
      ) AS parent_last_message_role
    FROM ${SESSIONS_TABLE} s
    LEFT JOIN ${SESSIONS_TABLE} p ON p.id = s.parent_session_id
    WHERE s.id = ?
  `).get(id) as Record<string, unknown> | undefined
  if (!sessionRow) return null
  const msgRows = db.prepare(
    `SELECT * FROM ${MESSAGES_TABLE} WHERE session_id = ? ORDER BY id`,
  ).all(id) as Record<string, unknown>[]
  const session = mapSessionRow(sessionRow)
  return {
    ...session,
    messages: msgRows.map(mapMessageRow),
    thread_session_count: 1,
  }
}

// --- Message CRUD ---

export function addMessage(msg: {
  session_id: string
  role: string
  content: string
  display_role?: string | null
  display_content?: string | null
  tool_call_id?: string | null
  tool_calls?: any[] | null
  tool_name?: string | null
  run_marker?: string | null
  timestamp?: number
  token_count?: number | null
  finish_reason?: string | null
  reasoning?: string | null
  reasoning_details?: string | null
  reasoning_content?: string | null
  /** Run id of the model run that produced this message (assistant/tool rows only). */
  run_id?: string | null
  /** Provider-recorded usage for this run; only attached on read-back in
   *  {@link attachRunUsageToMessages}, never persisted in the messages table. */
  usage?: {
    input: number
    output: number
    cacheRead?: number
    cacheWrite?: number
    reasoning?: number
    apiCalls?: number
  } | null
}): number | undefined {
  if (!isSqliteAvailable()) return undefined
  const db = getDb()!
  const toolCallsJson = msg.tool_calls ? JSON.stringify(msg.tool_calls) : null
  const result = db.prepare(
    `INSERT INTO ${MESSAGES_TABLE} (session_id, role, content, display_role, display_content, tool_call_id, tool_calls, tool_name, run_marker, timestamp, token_count, finish_reason, reasoning, reasoning_details, reasoning_content, run_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.session_id, msg.role, normalizeMessageContentForStorageRole(msg.role, msg.content),
    msg.display_role ?? null, msg.display_content ?? null,
    msg.tool_call_id ?? null, toolCallsJson, msg.tool_name ?? null,
    msg.run_marker ?? null,
    msg.timestamp ?? Math.floor(Date.now() / 1000),
    msg.token_count ?? null, msg.finish_reason ?? null,
    msg.reasoning ?? null, msg.reasoning_details ?? null,
    msg.reasoning_content ?? null,
    msg.run_id ?? '',
  )
  const messageId = Number(result.lastInsertRowid)
  recordSkillUsageMessage(messageId, msg)
  return messageId
}

export function addMessages(msgs: Array<{
  session_id: string
  role: string
  content: string
  display_role?: string | null
  display_content?: string | null
  tool_call_id?: string | null
  tool_calls?: any[] | null
  tool_name?: string | null
  run_marker?: string | null
  timestamp?: number
  token_count?: number | null
  finish_reason?: string | null
  reasoning?: string | null
  reasoning_details?: string | null
  reasoning_content?: string | null
  run_id?: string | null
}>): number[] {
  if (!isSqliteAvailable() || msgs.length === 0) return []
  const db = getDb()!
  const insert = db.prepare(
    `INSERT INTO ${MESSAGES_TABLE} (session_id, role, content, display_role, display_content, tool_call_id, tool_calls, tool_name, run_marker, timestamp, token_count, finish_reason, reasoning, reasoning_details, reasoning_content, run_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const ids: number[] = []
  db.exec('BEGIN')
  try {
    for (const msg of msgs) {
      const toolCallsJson = msg.tool_calls ? JSON.stringify(msg.tool_calls) : null
      const result = insert.run(
        msg.session_id, msg.role, normalizeMessageContentForStorageRole(msg.role, msg.content),
        msg.display_role ?? null, msg.display_content ?? null,
        msg.tool_call_id ?? null, toolCallsJson, msg.tool_name ?? null,
        msg.run_marker ?? null,
        msg.timestamp ?? Math.floor(Date.now() / 1000),
        msg.token_count ?? null, msg.finish_reason ?? null,
        msg.reasoning ?? null, msg.reasoning_details ?? null,
        msg.reasoning_content ?? null,
        msg.run_id ?? '',
      )
      const messageId = Number(result.lastInsertRowid)
      ids.push(messageId)
      recordSkillUsageMessage(messageId, msg)
    }
    db.exec('COMMIT')
    return ids
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

export function updateMessageDisplayContent(
  sessionId: string,
  messageId: number | string,
  displayContent: string | null,
): boolean {
  if (!isSqliteAvailable()) return false
  const db = getDb()!
  const result = db.prepare(
    `UPDATE ${MESSAGES_TABLE}
     SET display_content = ?
     WHERE session_id = ? AND id = ?`,
  ).run(displayContent, sessionId, messageId)
  return result.changes > 0
}

export function getMessageCount(sessionId: string): number {
  if (!isSqliteAvailable()) return 0
  const db = getDb()!
  const row = db.prepare(
    `SELECT COUNT(*) as cnt FROM ${MESSAGES_TABLE} WHERE session_id = ?`,
  ).get(sessionId) as { cnt: number } | undefined
  return row?.cnt ?? 0
}

export function getSessionContextMessages(
  sessionId: string,
  options: {
    afterId?: number
    throughId?: number
    limit?: number
  } = {},
): HermesMessageRow[] {
  if (!isSqliteAvailable()) return []
  const db = getDb()!
  const clauses = ['session_id = ?', `role IN ('user', 'assistant', 'tool')`]
  const params: Array<string | number> = [sessionId]
  if (Number.isSafeInteger(options.afterId)) {
    clauses.push('id > ?')
    params.push(options.afterId!)
  }
  if (Number.isSafeInteger(options.throughId)) {
    clauses.push('id <= ?')
    params.push(options.throughId!)
  }
  const limit = Number.isSafeInteger(options.limit) && options.limit! >= 0
    ? Math.floor(options.limit!)
    : undefined
  const rows = db.prepare(
    `SELECT * FROM ${MESSAGES_TABLE}
     WHERE ${clauses.join(' AND ')}
     ORDER BY id${limit != null ? ' LIMIT ?' : ''}`,
  ).all(...params, ...(limit != null ? [limit] : [])) as Record<string, unknown>[]
  return rows.map(mapMessageRow)
}

export function getSessionContextMessage(sessionId: string, messageId: number): HermesMessageRow | null {
  if (!isSqliteAvailable() || !Number.isSafeInteger(messageId)) return null
  const row = getDb()!.prepare(
    `SELECT * FROM ${MESSAGES_TABLE}
     WHERE session_id = ? AND id = ? AND role IN ('user', 'assistant', 'tool')`,
  ).get(sessionId, messageId) as Record<string, unknown> | undefined
  return row ? mapMessageRow(row) : null
}

export function getSessionContextMessageCount(sessionId: string, throughId?: number): number {
  if (!isSqliteAvailable()) return 0
  const hasBoundary = Number.isSafeInteger(throughId)
  const row = getDb()!.prepare(
    `SELECT COUNT(*) AS count FROM ${MESSAGES_TABLE}
     WHERE session_id = ? AND role IN ('user', 'assistant', 'tool')${hasBoundary ? ' AND id <= ?' : ''}`,
  ).get(sessionId, ...(hasBoundary ? [throughId!] : [])) as { count: number } | undefined
  return Number(row?.count || 0)
}

export function getFirstSessionMessageByRole(sessionId: string, role: string): HermesMessageRow | null {
  if (!isSqliteAvailable()) return null
  const row = getDb()!.prepare(
    `SELECT * FROM ${MESSAGES_TABLE}
     WHERE session_id = ? AND role = ?
       AND content IS NOT NULL AND TRIM(content) <> ''
     ORDER BY id
     LIMIT 1`,
  ).get(sessionId, role) as Record<string, unknown> | undefined
  return row ? mapMessageRow(row) : null
}

export function getSessionMessageCountByRole(sessionId: string, role: string): number {
  if (!isSqliteAvailable()) return 0
  const row = getDb()!.prepare(
    `SELECT COUNT(*) AS count FROM ${MESSAGES_TABLE} WHERE session_id = ? AND role = ?`,
  ).get(sessionId, role) as { count: number } | undefined
  return Number(row?.count || 0)
}

export function updateSessionStats(id: string): void {
  if (!isSqliteAvailable()) return
  const db = getDb()!
  db.prepare(
    `UPDATE ${SESSIONS_TABLE}
     SET message_count = (SELECT COUNT(*) FROM ${MESSAGES_TABLE} WHERE session_id = ?),
         last_active = COALESCE((SELECT MAX(timestamp) FROM ${MESSAGES_TABLE} WHERE session_id = ?), started_at)
     WHERE id = ?`,
  ).run(id, id, id)
  console.log(`Updated session ${id} stats`)
}

export function getSessionDetailPaginated(
  id: string,
  offset = 0,
  limit = 150,
): PaginatedSessionDetailResult | null {
  if (!isSqliteAvailable()) {
    return null
  }

  const db = getDb()!

  // Get session info
  const sessionRow = db.prepare(`
    SELECT s.*, p.title AS parent_title,
      (
        SELECT REPLACE(REPLACE(m.content, CHAR(10), ' '), CHAR(13), ' ')
        FROM ${MESSAGES_TABLE} m
        WHERE m.session_id = s.parent_session_id
          AND m.role IN ('user', 'assistant')
          AND m.content IS NOT NULL
          AND TRIM(m.content) <> ''
        ORDER BY m.timestamp DESC, m.id DESC
        LIMIT 1
      ) AS parent_last_message,
      (
        SELECT m.role
        FROM ${MESSAGES_TABLE} m
        WHERE m.session_id = s.parent_session_id
          AND m.role IN ('user', 'assistant')
          AND m.content IS NOT NULL
          AND TRIM(m.content) <> ''
        ORDER BY m.timestamp DESC, m.id DESC
        LIMIT 1
      ) AS parent_last_message_role
    FROM ${SESSIONS_TABLE} s
    LEFT JOIN ${SESSIONS_TABLE} p ON p.id = s.parent_session_id
    WHERE s.id = ?
  `).get(id) as Record<string, unknown> | undefined
  if (!sessionRow) return null

  // Get total message count
  const countResult = db.prepare(
    `SELECT COUNT(*) as total FROM ${MESSAGES_TABLE} WHERE session_id = ?`,
  ).get(id) as { total: number } | undefined
  const total = countResult?.total || 0

  // Get paginated messages (newest first from DB, then reverse).
  // Timestamp precision is mixed across message sources; id is insertion order.
  const msgRows = db.prepare(
    `SELECT * FROM ${MESSAGES_TABLE} WHERE session_id = ? ORDER BY id DESC LIMIT ? OFFSET ?`,
  ).all(id, limit, offset) as Record<string, unknown>[]

  const session = mapSessionRow(sessionRow)
  const messages = msgRows.map(mapMessageRow).reverse()  // Reverse to show oldest first

  return {
    session,
    messages,
    total,
    offset,
    limit,
    hasMore: offset + messages.length < total,
  }
}

/**
 * Attach provider-recorded usage to each assistant message that carries a `run_id`.
 *
 * Called on read-back (see controllers/hermes/sessions.ts) so that token usage
 * survives session reload / page refresh. Non-assistant messages are returned
 * unchanged — only assistant rows that already have a `run_id` get a `usage`
 * field attached.
 *
 * Uses {@link getRecordedUsageByRun} to aggregate from `session_usage` rows.
 * Multiple sources are tried because usage may have been recorded under
 * `hermes`, `ekko_agent`, or `coding_agent` depending on which runtime path
 * produced the run. Failures are swallowed conservatively (run-level usage must
 * never break the history-loading path); a missing run id simply leaves the
 * row without usage.
 */
export function attachRunUsageToMessages(
  sessionId: string,
  messages: HermesMessageRow[],
): HermesMessageRow[] {
  if (!messages.length) return messages
  const seen = new Set<string>()
  const cache = new Map<string, HermesMessageRow['usage'] | null>()
  const sources = ['hermes', 'ekko_agent', 'coding_agent'] as const
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue
    const runId = msg.run_id
    if (!runId || seen.has(runId)) continue
    seen.add(runId)
    try {
      let usage: HermesMessageRow['usage'] | null = null
      for (const source of sources) {
        const u = getRecordedUsageByRun(sessionId, source, runId)
        const candidate: HermesMessageRow['usage'] = {
          input: u.inputTokens,
          output: u.outputTokens,
          ...(u.cacheReadTokens > 0 ? { cacheRead: u.cacheReadTokens } : {}),
          ...(u.cacheWriteTokens > 0 ? { cacheWrite: u.cacheWriteTokens } : {}),
          ...(u.reasoningTokens > 0 ? { reasoning: u.reasoningTokens } : {}),
          ...(u.apiCalls > 0 ? { apiCalls: u.apiCalls } : {}),
        }
        // Skip zero-only payloads so we don't push a useless `{ input:0, output:0 }`
        // onto every legacy assistant row that lacks a run_id.
        if (candidate.input <= 0 && candidate.output <= 0) continue
        usage = candidate
        break
      }
      cache.set(runId, usage)
    } catch {
      cache.set(runId, null)
    }
  }
  if (!cache.size) return messages
  return messages.map(msg => {
    if (msg.role !== 'assistant') return msg
    const runId = msg.run_id
    if (!runId) return msg
    const usage = cache.get(runId)
    if (!usage) return msg
    return { ...msg, usage }
  })
}
