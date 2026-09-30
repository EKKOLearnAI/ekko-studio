import { getActiveProfileDir, getHermesBaseDir } from '../profiles/profile'
import { join } from 'path'
import { existsSync } from 'fs'
import type { LocalUsageStats } from '../../../studio/contracts/runs/usage'
import { emptyCostCoverage } from '../../../studio/public/usage'
import type { ExternalSkillUsageEvent } from '../../../studio/contracts/skills'

const SQLITE_AVAILABLE = (() => {
  const [major, minor] = process.versions.node.split('.').map(Number)
  return major > 22 || (major === 22 && minor >= 5)
})()

const COMPRESSION_END_REASONS = new Set(['compression', 'compressed'])
const SEARCH_CANDIDATE_MULTIPLIER = 20
const SEARCH_CANDIDATE_MIN = 100

export interface HermesSessionRow {
  id: string
  source: string
  user_id: string | null
  model: string
  title: string | null
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
}

export interface HermesSessionSearchRow extends HermesSessionRow {
  matched_message_id: number | null
  snippet: string
  rank: number
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
}

export interface HermesSessionDetailRow extends HermesSessionRow {
  messages: HermesMessageRow[]
  thread_session_count: number
}

export interface PaginatedHermesSessionDetailResult {
  session: HermesSessionDetailRow
  messages: HermesMessageRow[]
  total: number
  offset: number
  limit: number
  hasMore: boolean
}

export interface HermesSessionSummaryGroupPage {
  source: string
  sessions: HermesSessionRow[]
  total: number
  hasMore: boolean
}

export interface HermesSessionSummaryGroupsResult {
  groups: HermesSessionSummaryGroupPage[]
  included: HermesSessionRow[]
}

interface HermesSessionInternalRow extends HermesSessionRow {
  parent_session_id: string | null
}

function sessionDbPath(): string {
  return join(getActiveProfileDir(), 'state.db')
}

function sessionDbPathForProfile(profile?: string): string {
  const name = String(profile || '').trim()
  if (!name) return sessionDbPath()
  if (name === 'default') return join(getHermesBaseDir(), 'state.db')
  return join(getHermesBaseDir(), 'profiles', name, 'state.db')
}

function normalizeNumber(value: unknown, fallback = 0): number {
  if (value == null || value === '') return fallback
  const num = Number(value)
  return Number.isFinite(num) ? num : fallback
}

function normalizeNullableNumber(value: unknown): number | null {
  if (value == null || value === '') return null
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

function normalizeNullableString(value: unknown): string | null {
  if (value == null || value === '') return null
  return String(value)
}

function titleFromPreview(preview: string): string | null {
  if (!preview) return null
  return preview.length > 40 ? `${preview.slice(0, 40)}...` : preview
}

function mapRow(row: Record<string, unknown>): HermesSessionRow {
  const startedAt = normalizeNumber(row.started_at)
  return {
    id: String(row.id || ''),
    source: String(row.source || ''),
    user_id: normalizeNullableString(row.user_id),
    model: String(row.model || ''),
    title: normalizeNullableString(row.title),
    started_at: startedAt,
    ended_at: normalizeNullableNumber(row.ended_at),
    end_reason: normalizeNullableString(row.end_reason),
    message_count: normalizeNumber(row.message_count),
    tool_call_count: normalizeNumber(row.tool_call_count),
    input_tokens: normalizeNumber(row.input_tokens),
    output_tokens: normalizeNumber(row.output_tokens),
    cache_read_tokens: normalizeNumber(row.cache_read_tokens),
    cache_write_tokens: normalizeNumber(row.cache_write_tokens),
    reasoning_tokens: normalizeNumber(row.reasoning_tokens),
    billing_provider: normalizeNullableString(row.billing_provider),
    estimated_cost_usd: normalizeNumber(row.estimated_cost_usd),
    actual_cost_usd: normalizeNullableNumber(row.actual_cost_usd),
    cost_status: String(row.cost_status || ''),
    preview: String(row.preview || ''),
    last_active: normalizeNumber(row.last_active, startedAt),
  }
}

const SESSION_SELECT = `
  s.id,
  s.source,
  COALESCE(s.user_id, '') AS user_id,
  COALESCE(s.model, '') AS model,
  COALESCE(s.title, '') AS title,
  COALESCE(s.started_at, 0) AS started_at,
  s.ended_at AS ended_at,
  COALESCE(s.end_reason, '') AS end_reason,
  COALESCE(s.message_count, 0) AS message_count,
  COALESCE(s.tool_call_count, 0) AS tool_call_count,
  COALESCE(s.input_tokens, 0) AS input_tokens,
  COALESCE(s.output_tokens, 0) AS output_tokens,
  COALESCE(s.cache_read_tokens, 0) AS cache_read_tokens,
  COALESCE(s.cache_write_tokens, 0) AS cache_write_tokens,
  COALESCE(s.reasoning_tokens, 0) AS reasoning_tokens,
  COALESCE(s.billing_provider, '') AS billing_provider,
  COALESCE(s.estimated_cost_usd, 0) AS estimated_cost_usd,
  s.actual_cost_usd AS actual_cost_usd,
  COALESCE(s.cost_status, '') AS cost_status,
  COALESCE(
    (
      SELECT SUBSTR(REPLACE(REPLACE(m.content, CHAR(10), ' '), CHAR(13), ' '), 1, 63)
      FROM messages m
      WHERE m.session_id = s.id AND m.role = 'user' AND m.content IS NOT NULL
      ORDER BY m.timestamp, m.id
      LIMIT 1
    ),
    ''
  ) AS preview,
  COALESCE((SELECT MAX(m2.timestamp) FROM messages m2 WHERE m2.session_id = s.id), s.started_at) AS last_active
`

function containsCjk(text: string): boolean {
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0
    if (
      (cp >= 0x4E00 && cp <= 0x9FFF) ||
      (cp >= 0x3400 && cp <= 0x4DBF) ||
      (cp >= 0x20000 && cp <= 0x2A6DF) ||
      (cp >= 0x3000 && cp <= 0x303F) ||
      (cp >= 0x3040 && cp <= 0x309F) ||
      (cp >= 0x30A0 && cp <= 0x30FF) ||
      (cp >= 0xAC00 && cp <= 0xD7AF)
    ) {
      return true
    }
  }
  return false
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`)
}

function buildLikePattern(value: string): string {
  return `%${escapeLikePattern(value)}%`
}

function normalizeTitleLikeQuery(query: string): string {
  const tokens = query.match(/"[^"]*"\*?|\S+/g)
  if (!tokens) return query

  const normalizedTokens = tokens
    .map((token) => {
      let value = token.endsWith('*') ? token.slice(0, -1) : token
      if (value.startsWith('"') && value.endsWith('"')) {
        value = value.slice(1, -1)
      }
      return value
    })
    .filter(Boolean)

  return normalizedTokens.join(' ').trim() || query
}

function shouldUseLiteralContentSearch(query: string): boolean {
  const trimmed = query.trim()
  if (!trimmed) return false
  if (/[^\p{L}\p{N}\s"*.-]/u.test(trimmed)) return true

  const tokens = trimmed.match(/"[^"]*"\*?|\S+/g)
  if (!tokens) return true

  for (const token of tokens) {
    if (/^(AND|OR|NOT)$/i.test(token)) continue

    const raw = token.endsWith('*') ? token.slice(0, -1) : token
    if (!raw) return true

    if (raw.startsWith('"') && raw.endsWith('"')) {
      const inner = raw.slice(1, -1)
      if (!inner.trim()) return true
      if (!/^[\p{L}\p{N}\s.-]+$/u.test(inner)) return true
      if ((inner.includes('.') || inner.includes('-')) && !/^[\p{L}\p{N}]+(?:[.-][\p{L}\p{N}]+)*(?:\s+[\p{L}\p{N}]+(?:[.-][\p{L}\p{N}]+)*)*$/u.test(inner)) return true
      continue
    }

    if (raw.includes('.') || raw.includes('-')) {
      if (!/^[\p{L}\p{N}]+(?:[.-][\p{L}\p{N}]+)*$/u.test(raw)) return true
      continue
    }

    if (!/^[\p{L}\p{N}]+$/u.test(raw)) return true
  }

  return false
}

function runLiteralContentSearch(
  db: { prepare: (sql: string) => { all: (...params: any[]) => Record<string, unknown>[] } },
  source: string | undefined,
  query: string,
  limit: number,
): Record<string, unknown>[] {
  const loweredQuery = query.toLowerCase()
  const likePattern = buildLikePattern(loweredQuery)
  const sourceClause = source ? 'AND s.source = ?' : ''
  const sourceParams = source ? [source] : []
  const likeSql = `
    WITH base AS (
      SELECT
        ${SESSION_SELECT},
        s.parent_session_id AS parent_session_id
      FROM sessions s
      WHERE s.source != 'tool' AND s.id NOT LIKE 'compress_%'
        ${sourceClause}
    )
    SELECT
      base.*,
      m.id AS matched_message_id,
      substr(
        m.content,
        max(1, instr(LOWER(m.content), ?) - 40),
        120
      ) AS snippet,
      0 AS rank
    FROM base
    JOIN messages m ON m.session_id = base.id
    WHERE LOWER(m.content) LIKE ? ESCAPE '\\'
    ORDER BY base.last_active DESC, m.timestamp DESC
    LIMIT ?
  `
  return db.prepare(likeSql).all(...sourceParams, loweredQuery, likePattern, limit) as Record<string, unknown>[]
}

function sanitizeFtsQuery(query: string): string {
  const quotedParts: string[] = []

  const preserved = query.replace(/"[^"]*"/g, (match) => {
    quotedParts.push(match)
    return `\u0000Q${quotedParts.length - 1}\u0000`
  })

  let sanitized = preserved.replace(/[+{}()"^]/g, ' ')
  sanitized = sanitized.replace(/\*+/g, '*')
  sanitized = sanitized.replace(/(^|\s)\*/g, '$1')
  sanitized = sanitized.trim().replace(/^(AND|OR|NOT)\b\s*/i, '')
  sanitized = sanitized.trim().replace(/\s+(AND|OR|NOT)\s*$/i, '')
  sanitized = sanitized.replace(/\b([\p{L}\p{N}]+(?:[.-][\p{L}\p{N}]+)+)\b/gu, '"$1"')

  for (let i = 0; i < quotedParts.length; i += 1) {
    sanitized = sanitized.replace(`\u0000Q${i}\u0000`, quotedParts[i])
  }

  return sanitized.trim()
}

function toPrefixQuery(query: string): string {
  const tokens = query.match(/"[^"]*"\*?|\S+/g)
  if (!tokens) return ''
  return tokens
    .map((token) => {
      if (token === 'AND' || token === 'OR' || token === 'NOT') return token
      if (token.startsWith('"') && token.endsWith('"')) return token
      if (token.endsWith('*')) return token
      return `${token}*`
    })
    .join(' ')
}

function mapSearchRow(row: Record<string, unknown>): HermesSessionSearchRow {
  return {
    ...mapRow(row),
    matched_message_id: normalizeNullableNumber(row.matched_message_id),
    snippet: String(row.snippet || row.preview || ''),
    rank: Number.isFinite(Number(row.rank)) ? Number(row.rank) : 0,
  }
}

function mapInternalSessionRow(row: Record<string, unknown>): HermesSessionInternalRow {
  return {
    ...mapRow(row),
    parent_session_id: normalizeNullableString(row.parent_session_id),
  }
}

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

function normalizeMessageId(value: unknown): number | string {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'bigint') return Number(value)
  const asNumber = Number(value)
  if (Number.isInteger(asNumber)) return asNumber
  return String(value || '')
}

function mapMessageRow(row: Record<string, unknown>): HermesMessageRow {
  const reasoning = normalizeNullableString(row.reasoning) || normalizeNullableString(row.reasoning_content)
  return {
    id: normalizeMessageId(row.id),
    session_id: String(row.session_id || ''),
    role: String(row.role || ''),
    content: row.content == null ? '' : String(row.content),
    display_role: normalizeNullableString(row.display_role),
    display_content: normalizeNullableString(row.display_content),
    tool_call_id: normalizeNullableString(row.tool_call_id),
    tool_calls: parseToolCalls(row.tool_calls),
    tool_name: normalizeNullableString(row.tool_name),
    run_marker: normalizeNullableString(row.run_marker),
    timestamp: normalizeNumber(row.timestamp),
    token_count: normalizeNullableNumber(row.token_count),
    finish_reason: normalizeNullableString(row.finish_reason),
    reasoning,
    reasoning_details: normalizeNullableString(row.reasoning_details),
    reasoning_content: normalizeNullableString(row.reasoning_content),
  }
}

function isCompressionEnded(session: HermesSessionInternalRow | undefined): boolean {
  return !!session && COMPRESSION_END_REASONS.has(String(session.end_reason || ''))
}

function isCompressionContinuation(parent: HermesSessionInternalRow | undefined, child: HermesSessionInternalRow | undefined): boolean {
  if (!parent || !child || !isCompressionEnded(parent) || parent.ended_at == null) return false
  return child.source !== 'tool' && Number(child.started_at || 0) >= Number(parent.ended_at || 0)
}

function latestSessionInChain(chain: HermesSessionInternalRow[]): HermesSessionInternalRow {
  return chain.reduce((latest, session) => {
    const latestStarted = Number(latest.started_at || 0)
    const sessionStarted = Number(session.started_at || 0)
    if (sessionStarted !== latestStarted) return sessionStarted > latestStarted ? session : latest
    return session.id.localeCompare(latest.id) > 0 ? session : latest
  }, chain[0])
}

function compareSessionSummariesNewestFirst(a: HermesSessionRow, b: HermesSessionRow): number {
  const activityDelta = Number(b.last_active || b.started_at || 0) - Number(a.last_active || a.started_at || 0)
  if (activityDelta !== 0) return activityDelta
  return b.id.localeCompare(a.id)
}

function projectSessionSummary(root: HermesSessionInternalRow, chain: HermesSessionInternalRow[]): HermesSessionRow {
  const latest = latestSessionInChain(chain)
  const firstPreview = chain.map(session => session.preview).find(Boolean) || root.preview
  const { parent_session_id: _parentSessionId, ...rootRow } = root
  return {
    ...rootRow,
    id: latest.id,
    model: latest.model || root.model,
    title: latest.title || root.title || titleFromPreview(firstPreview),
    ended_at: latest.ended_at,
    end_reason: latest.end_reason,
    message_count: latest.message_count,
    tool_call_count: latest.tool_call_count,
    input_tokens: latest.input_tokens,
    output_tokens: latest.output_tokens,
    cache_read_tokens: latest.cache_read_tokens,
    cache_write_tokens: latest.cache_write_tokens,
    reasoning_tokens: latest.reasoning_tokens,
    billing_provider: latest.billing_provider ?? root.billing_provider,
    estimated_cost_usd: latest.estimated_cost_usd,
    actual_cost_usd: latest.actual_cost_usd,
    cost_status: latest.cost_status,
    preview: latest.preview || root.preview || firstPreview || '',
    last_active: latest.last_active || root.last_active,
  }
}

// --- In-memory session index for chain traversal ---

interface SessionIndex {
  byId: Map<string, HermesSessionInternalRow>
  childrenByParent: Map<string, string[]>
}

function loadAllSessions(db: { prepare: (sql: string) => { all: (...params: any[]) => Record<string, unknown>[] } }): SessionIndex {
  const rows = db.prepare(`
    SELECT
      ${SESSION_SELECT},
      s.parent_session_id AS parent_session_id
    FROM sessions s
    WHERE s.source != 'tool' AND s.id NOT LIKE 'compress_%'
  `).all() as Record<string, unknown>[]
  const sessions = rows.map(mapInternalSessionRow)
  const byId = new Map(sessions.map(s => [s.id, s]))
  const childrenByParent = new Map<string, string[]>()
  for (const s of sessions) {
    const key = s.parent_session_id ?? ''
    const list = childrenByParent.get(key) || []
    list.push(s.id)
    childrenByParent.set(key, list)
  }
  return { byId, childrenByParent }
}

type SessionLookupDb = {
  prepare: (sql: string) => {
    get: (...params: any[]) => Record<string, unknown> | undefined
    all: (...params: any[]) => Record<string, unknown>[]
  }
}

function loadSessionById(db: SessionLookupDb, sessionId: string): HermesSessionInternalRow | null {
  const row = db.prepare(`
    SELECT
      ${SESSION_SELECT},
      s.parent_session_id AS parent_session_id
    FROM sessions s
    WHERE s.id = ?
      AND s.source != 'tool'
      AND s.id NOT LIKE 'compress_%'
  `).get(sessionId)
  return row ? mapInternalSessionRow(row) : null
}

function loadContinuationChildren(db: SessionLookupDb, parentSessionId: string): HermesSessionInternalRow[] {
  const rows = db.prepare(`
    SELECT
      ${SESSION_SELECT},
      s.parent_session_id AS parent_session_id
    FROM sessions s
    WHERE s.parent_session_id = ?
      AND s.source != 'tool'
      AND s.id NOT LIKE 'compress_%'
  `).all(parentSessionId)
  return rows.map(mapInternalSessionRow)
}

function selectCompressionContinuationChild(
  parent: HermesSessionInternalRow,
  candidates: HermesSessionInternalRow[],
): HermesSessionInternalRow | null {
  if (!isCompressionEnded(parent) || parent.ended_at == null) return null
  return candidates
    .filter(candidate => Number(candidate.started_at || 0) >= Number(parent.ended_at || 0))
    .sort((a, b) => {
      const aDelta = Number(a.started_at || 0) - Number(parent.ended_at || 0)
      const bDelta = Number(b.started_at || 0) - Number(parent.ended_at || 0)
      if (aDelta !== bDelta) return aDelta - bDelta
      return b.id.localeCompare(a.id)
    })[0] || null
}

function loadSessionChain(db: SessionLookupDb, sessionId: string): HermesSessionInternalRow[] {
  const requested = loadSessionById(db, sessionId)
  if (!requested) return []

  const reversed: HermesSessionInternalRow[] = [requested]
  const ancestorIds = new Set<string>()
  let current: HermesSessionInternalRow | null = requested
  for (let depth = 0; current?.parent_session_id && depth < 100 && !ancestorIds.has(current.id); depth += 1) {
    ancestorIds.add(current.id)
    const parent = loadSessionById(db, current.parent_session_id)
    if (!parent || !isCompressionContinuation(parent, current)) break
    reversed.push(parent)
    current = parent
  }

  const chain = reversed.reverse()
  const chainIds = new Set(chain.map(session => session.id))
  current = chain[chain.length - 1] || null
  for (let depth = 0; current && depth < 100; depth += 1) {
    if (!isCompressionEnded(current) || current.ended_at == null) break
    const next = selectCompressionContinuationChild(current, loadContinuationChildren(db, current.id))
    if (!next || chainIds.has(next.id)) break
    chain.push(next)
    chainIds.add(next.id)
    current = next
  }
  return chain
}

function getLatestContinuationChild(
  parent: HermesSessionInternalRow,
  idx: SessionIndex,
): HermesSessionInternalRow | null {
  const candidates = (idx.childrenByParent.get(parent.id) || [])
    .map(id => idx.byId.get(id))
    .filter((c): c is HermesSessionInternalRow => !!c)
  return selectCompressionContinuationChild(parent, candidates)
}

function isCompressionContinuationChild(session: HermesSessionInternalRow, idx: SessionIndex): boolean {
  if (!session.parent_session_id) return false
  const parent = idx.byId.get(session.parent_session_id)
  return !!parent && getLatestContinuationChild(parent, idx)?.id === session.id
}

function collectCompressionPath(
  session: HermesSessionInternalRow,
  idx: SessionIndex,
): HermesSessionInternalRow[] {
  const reversed: HermesSessionInternalRow[] = [session]
  const seen = new Set<string>()
  let current: HermesSessionInternalRow | null = session

  for (let depth = 0; current && current.parent_session_id && depth < 100 && !seen.has(current.id); depth += 1) {
    seen.add(current.id)
    const parent = idx.byId.get(current.parent_session_id)
    if (!parent || !isCompressionContinuation(parent, current)) break
    reversed.push(parent)
    current = parent
  }

  return reversed.reverse()
}

function extendCompressionChain(
  chain: HermesSessionInternalRow[],
  idx: SessionIndex,
): HermesSessionInternalRow[] {
  const result = [...chain]
  const seen = new Set(result.map(s => s.id))
  let current: HermesSessionInternalRow | null = result[result.length - 1] || null

  for (let depth = 0; current && depth < 100; depth += 1) {
    const next = getLatestContinuationChild(current, idx)
    if (!next || seen.has(next.id)) break
    result.push(next)
    seen.add(next.id)
    current = next
  }

  return result
}

function collectSessionChain(
  root: HermesSessionInternalRow,
  idx: SessionIndex,
): HermesSessionInternalRow[] {
  return extendCompressionChain([root], idx)
}

function collectSessionChainForMatchedSession(
  session: HermesSessionInternalRow,
  idx: SessionIndex,
): HermesSessionInternalRow[] {
  return extendCompressionChain(collectCompressionPath(session, idx), idx)
}

type SessionDbLike = {
  prepare: (sql: string) => { all: (...params: any[]) => Record<string, unknown>[] }
}

function searchCandidateLimit(limit: number): number {
  return Math.max(limit * SEARCH_CANDIDATE_MULTIPLIER, SEARCH_CANDIDATE_MIN)
}

function projectSearchRow(
  row: Record<string, unknown>,
  idx: SessionIndex,
  source?: string,
): HermesSessionSearchRow | null {
  const matchedSession = mapInternalSessionRow(row)
  if (!matchedSession.id) return null

  const chain = collectSessionChainForMatchedSession(matchedSession, idx)
  const root = chain[0]
  if (!root) return null
  if (source && matchedSession.source !== source) return null

  const projected = projectSessionSummary(root, chain)
  return {
    ...projected,
    matched_message_id: normalizeNullableNumber(row.matched_message_id),
    snippet: String(row.snippet || row.preview || ''),
    rank: Number.isFinite(Number(row.rank)) ? Number(row.rank) : 0,
  }
}

function aggregateSessionDetail(
  chain: HermesSessionInternalRow[],
  messages: HermesMessageRow[],
  requestedSessionId: string,
): HermesSessionDetailRow {
  const root = chain[0]
  const latest = latestSessionInChain(chain)
  const costStatuses = Array.from(new Set(chain.map(session => String(session.cost_status || '')).filter(Boolean)))
  const actualCosts = chain
    .map(session => session.actual_cost_usd)
    .filter((value): value is number => value != null)
  const firstPreview = chain.map(session => session.preview).find(Boolean) || root.preview

  const { parent_session_id: _parentSessionId, ...rootRow } = root

  return {
    ...rootRow,
    id: requestedSessionId,
    source: latest.source || root.source,
    title: latest.title || root.title || titleFromPreview(firstPreview),
    preview: latest.preview || root.preview || firstPreview || '',
    model: latest.model || root.model,
    ended_at: latest.ended_at,
    end_reason: latest.end_reason,
    last_active: Math.max(...chain.map(session => session.last_active || session.started_at || 0)),
    message_count: chain.reduce((sum, session) => sum + Number(session.message_count || 0), 0),
    tool_call_count: chain.reduce((sum, session) => sum + Number(session.tool_call_count || 0), 0),
    input_tokens: chain.reduce((sum, session) => sum + Number(session.input_tokens || 0), 0),
    output_tokens: chain.reduce((sum, session) => sum + Number(session.output_tokens || 0), 0),
    cache_read_tokens: chain.reduce((sum, session) => sum + Number(session.cache_read_tokens || 0), 0),
    cache_write_tokens: chain.reduce((sum, session) => sum + Number(session.cache_write_tokens || 0), 0),
    reasoning_tokens: chain.reduce((sum, session) => sum + Number(session.reasoning_tokens || 0), 0),
    billing_provider: latest.billing_provider ?? root.billing_provider,
    estimated_cost_usd: chain.reduce((sum, session) => sum + Number(session.estimated_cost_usd || 0), 0),
    actual_cost_usd: actualCosts.length ? actualCosts.reduce((sum, value) => sum + Number(value || 0), 0) : null,
    cost_status: costStatuses.length === 1 ? costStatuses[0] : (costStatuses.length > 1 ? 'mixed' : ''),
    messages,
    thread_session_count: chain.length,
  }
}

function chainOrderSql(ids: string[]): string {
  return ids.map((_, index) => `WHEN ? THEN ${index}`).join(' ')
}

async function openSessionDb(profile?: string) {
  if (!SQLITE_AVAILABLE) {
    throw new Error(`node:sqlite requires Node >= 22.5, current: ${process.versions.node}`)
  }
  const { DatabaseSync } = await import('node:sqlite')
  const dbPath = profile ? sessionDbPathForProfile(profile) : sessionDbPath()
  try {
    return new DatabaseSync(dbPath, { open: true, readOnly: true })
  } catch (err: any) {
    console.error(`[sessions-db] Failed to open session db at ${dbPath}:`, err.message)
    throw err
  }
}

/**
 * Lightweight alternative: get messages + session row for a single session ID
 * without chain traversal. Used by syncFromHermes for ephemeral sessions.
 */
export async function getSessionMessagesFromDb(sessionId: string): Promise<{
  messages: HermesMessageRow[]
  session: HermesSessionRow | null
} | null> {
  const db = await openSessionDb()
  try {
    const sessionRow = db.prepare(`
      SELECT ${SESSION_SELECT}
      FROM sessions s
      WHERE s.id = ?
    `).get(sessionId) as Record<string, unknown> | undefined

    const messageRows = db.prepare(`
      SELECT * FROM messages
      WHERE session_id = ?
      ORDER BY id
    `).all(sessionId) as Record<string, unknown>[]

    return {
      messages: messageRows.map(mapMessageRow),
      session: sessionRow ? mapRow(sessionRow) : null,
    }
  } finally {
    db.close()
  }
}

export async function getSessionDetailFromDb(sessionId: string): Promise<HermesSessionDetailRow | null> {
  const db = await openSessionDb()
  try {
    const chain = loadSessionChain(db, sessionId)
    if (!chain.length) return null

    const ids = chain.map(session => session.id)
    const placeholders = ids.map(() => '?').join(', ')
    const orderSql = chainOrderSql(ids)
    const messageRows = db.prepare(`
      SELECT * FROM messages
      WHERE session_id IN (${placeholders})
      ORDER BY CASE session_id ${orderSql} ELSE ${ids.length} END, id
    `).all(...ids, ...ids) as Record<string, unknown>[]
    const messages = messageRows.map(mapMessageRow)
    return aggregateSessionDetail(chain, messages, sessionId)
  } finally {
    db.close()
  }
}

export async function getSessionDetailFromDbWithProfile(sessionId: string, profile: string): Promise<HermesSessionDetailRow | null> {
  const { DatabaseSync } = await import('node:sqlite')
  const dbPath = sessionDbPathForProfile(profile)
  const db = new DatabaseSync(dbPath, { open: true, readOnly: true })
  try {
    const chain = loadSessionChain(db, sessionId)
    if (!chain.length) return null

    const ids = chain.map(session => session.id)
    const placeholders = ids.map(() => '?').join(', ')
    const orderSql = chainOrderSql(ids)
    const messageRows = db.prepare(`
      SELECT * FROM messages
      WHERE session_id IN (${placeholders})
      ORDER BY CASE session_id ${orderSql} ELSE ${ids.length} END, id
    `).all(...ids, ...ids) as Record<string, unknown>[]
    const messages = messageRows.map(mapMessageRow)
    return aggregateSessionDetail(chain, messages, sessionId)
  } finally {
    db.close()
  }
}

export async function getSessionDetailPaginatedFromDbWithProfile(
  sessionId: string,
  profile: string,
  offset = 0,
  limit = 150,
): Promise<PaginatedHermesSessionDetailResult | null> {
  const db = await openSessionDb(profile)
  try {
    const chain = loadSessionChain(db, sessionId)
    if (!chain.length) return null

    const ids = chain.map(session => session.id)
    const placeholders = ids.map(() => '?').join(', ')
    const orderSql = chainOrderSql(ids)
    const totalRow = db.prepare(`
      SELECT COUNT(*) AS total
      FROM messages
      WHERE session_id IN (${placeholders})
    `).get(...ids) as { total: number } | undefined
    const total = Number(totalRow?.total || 0)

    const messageRows = db.prepare(`
      SELECT * FROM messages
      WHERE session_id IN (${placeholders})
      ORDER BY CASE session_id ${orderSql} ELSE ${ids.length} END DESC, id DESC
      LIMIT ? OFFSET ?
    `).all(...ids, ...ids, limit, offset) as Record<string, unknown>[]
    const messages = messageRows.map(mapMessageRow).reverse()

    return {
      session: aggregateSessionDetail(chain, messages, sessionId),
      messages,
      total,
      offset,
      limit,
      hasMore: offset + messages.length < total,
    }
  } finally {
    db.close()
  }
}

export async function getExactSessionDetailFromDbWithProfile(sessionId: string, profile: string): Promise<HermesSessionDetailRow | null> {
  const { DatabaseSync } = await import('node:sqlite')
  const dbPath = sessionDbPathForProfile(profile)
  const db = new DatabaseSync(dbPath, { open: true, readOnly: true })
  try {
    const requested = loadSessionById(db, sessionId)
    if (!requested) return null

    const messageRows = db.prepare(`
      SELECT * FROM messages
      WHERE session_id = ?
      ORDER BY id
    `).all(sessionId) as Record<string, unknown>[]
    const messages = messageRows.map(mapMessageRow)
    return aggregateSessionDetail([requested], messages, sessionId)
  } finally {
    db.close()
  }
}

export async function findLatestExactSessionIdWithProfile(
  query: string,
  profile: string,
  source?: string,
): Promise<string | null> {
  if (!SQLITE_AVAILABLE) {
    throw new Error(`node:sqlite requires Node >= 22.5, current: ${process.versions.node}`)
  }

  const trimmed = query.trim()
  if (!trimmed) return null

  const { DatabaseSync } = await import('node:sqlite')
  const dbPath = sessionDbPathForProfile(profile)
  const db = new DatabaseSync(dbPath, { open: true, readOnly: true })
  const loweredQuery = trimmed.toLowerCase()
  const likePattern = buildLikePattern(loweredQuery)
  const kanbanPrompt = `work kanban task ${trimmed}`.toLowerCase()
  const taskJsonNeedle = `"task_id": "${trimmed}"`.toLowerCase()

  try {
    const sourceClause = source ? 'AND s.source = ?' : ''
    const sourceParams = source ? [source] : []
    const exactPromptSql = `
      WITH base AS (
        SELECT
          ${SESSION_SELECT},
          s.parent_session_id AS parent_session_id
        FROM sessions s
        WHERE s.source != 'tool' AND s.id NOT LIKE 'compress_%'
          ${sourceClause}
      )
      SELECT base.id
      FROM base
      JOIN messages m ON m.session_id = base.id
      WHERE m.role = 'user'
        AND LOWER(TRIM(m.content)) = ?
      ORDER BY base.last_active DESC, m.timestamp DESC
      LIMIT 1
    `
    const exactPromptMatch = db.prepare(exactPromptSql).get(...sourceParams, kanbanPrompt) as Record<string, unknown> | undefined
    if (exactPromptMatch?.id) return String(exactPromptMatch.id)

    const taskJsonSql = `
      WITH base AS (
        SELECT
          ${SESSION_SELECT},
          s.parent_session_id AS parent_session_id
        FROM sessions s
        WHERE s.source != 'tool' AND s.id NOT LIKE 'compress_%'
          ${sourceClause}
      )
      SELECT base.id
      FROM base
      JOIN messages m ON m.session_id = base.id
      WHERE LOWER(m.content) LIKE ? ESCAPE '\\'
      ORDER BY base.last_active DESC, m.timestamp DESC
      LIMIT 1
    `
    const taskJsonMatch = db.prepare(taskJsonSql).get(...sourceParams, buildLikePattern(taskJsonNeedle)) as Record<string, unknown> | undefined
    if (taskJsonMatch?.id) return String(taskJsonMatch.id)

    const contentSql = `
      WITH base AS (
        SELECT
          ${SESSION_SELECT},
          s.parent_session_id AS parent_session_id
        FROM sessions s
        WHERE s.source != 'tool' AND s.id NOT LIKE 'compress_%'
          ${sourceClause}
      )
      SELECT base.id
      FROM base
      JOIN messages m ON m.session_id = base.id
      WHERE LOWER(m.content) LIKE ? ESCAPE '\\'
      ORDER BY base.last_active DESC, m.timestamp DESC
      LIMIT 1
    `
    const contentMatch = db.prepare(contentSql).get(...sourceParams, likePattern) as Record<string, unknown> | undefined
    if (contentMatch?.id) return String(contentMatch.id)

    const titleSql = `
      SELECT s.id
      FROM sessions s
      WHERE s.source != 'tool' AND s.id NOT LIKE 'compress_%'
        ${sourceClause}
        AND LOWER(COALESCE(s.title, '')) LIKE ? ESCAPE '\\'
      ORDER BY s.started_at DESC
      LIMIT 1
    `
    const titleMatch = db.prepare(titleSql).get(...sourceParams, likePattern) as Record<string, unknown> | undefined
    return titleMatch?.id ? String(titleMatch.id) : null
  } finally {
    db.close()
  }
}

export interface HermesUsageStats extends LocalUsageStats {
  cost: number
  total_api_calls: number
  cost_fallbacks?: Array<{ session_id: string; date: string; cost: number; source: 'reported' | 'estimated' }>
}

export interface HermesSkillUsageRow {
  skill: string
  view_count: number
  manage_count: number
  total_count: number
  percentage: number
  last_used_at: number | null
}

export interface HermesSkillUsageDailySkillRow {
  skill: string
  view_count: number
  manage_count: number
  total_count: number
}

export interface HermesSkillUsageDailyRow {
  date: string
  view_count: number
  manage_count: number
  total_count: number
  skills: HermesSkillUsageDailySkillRow[]
}

export interface HermesSkillUsageStats {
  period_days: number
  summary: {
    total_skill_loads: number
    total_skill_edits: number
    total_skill_actions: number
    distinct_skills_used: number
  }
  by_day: HermesSkillUsageDailyRow[]
  top_skills: HermesSkillUsageRow[]
}

function tableHasColumn(
  db: { prepare: (sql: string) => { all: (...params: any[]) => Record<string, unknown>[] } },
  tableName: string,
  columnName: string,
): boolean {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all()
  return columns.some(column => String(column.name || '') === columnName)
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value !== 'string') return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

type SkillUsageAction = 'view' | 'manage'

type SqliteDbLike = {
  prepare(sql: string): {
    get(...params: unknown[]): unknown
    all(...params: unknown[]): unknown[]
  }
}

interface RawSkillUsageEvent {
  skill: string
  action: SkillUsageAction
  timestamp: number | null
}

function extractSkillNameFromViewContent(content: string): string {
  const match = content.match(/^\[skill_view\]\s+name=(.+?)(?:\s+\(|\s*$)/)
  if (match?.[1]) return match[1].trim()

  const parsed = parseJsonObject(content)
  if (typeof parsed?.name === 'string') return parsed.name.trim()

  const jsonNameMatch = content.match(/"name"\s*:\s*"((?:\\.|[^"\\])*)"/)
  if (jsonNameMatch?.[1]) {
    try {
      return JSON.parse(`"${jsonNameMatch[1]}"`).trim()
    } catch {
      return jsonNameMatch[1].replace(/\\"/g, '"').trim()
    }
  }

  return ''
}

function extractSkillNameFromManageContent(content: string): string {
  const bracketMatch = content.match(/^\[skill_manage\]\s+name=(.+?)(?:\s+|\(|$)/)
  if (bracketMatch?.[1]) return bracketMatch[1].trim()

  const parsed = parseJsonObject(content)
  const message = typeof parsed?.message === 'string' ? parsed.message : content
  const quotedMatch = message.match(/skill ['"]([^'"]+)['"]/i)
  if (quotedMatch?.[1]) return quotedMatch[1].trim()

  const namedMatch = message.match(/\bname=([^\s)]+)/i)
  return namedMatch?.[1]?.trim() || ''
}

function extractSkillToolCall(row: Record<string, unknown>): { action: SkillUsageAction; skill: string } | null {
  const toolCallId = typeof row.tool_call_id === 'string' ? row.tool_call_id : ''
  const rawToolCalls = typeof row.assistant_tool_calls === 'string' ? row.assistant_tool_calls : ''
  if (!toolCallId || !rawToolCalls) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(rawToolCalls)
  } catch {
    return null
  }

  const calls = Array.isArray(parsed) ? parsed : [parsed]
  for (const call of calls) {
    if (!call || typeof call !== 'object') continue
    const record = call as Record<string, unknown>
    if (!toolCallRecordIds(record).includes(toolCallId)) continue

    const functionRecord = record.function && typeof record.function === 'object'
      ? record.function as Record<string, unknown>
      : {}
    const name = typeof functionRecord.name === 'string'
      ? functionRecord.name
      : typeof record.name === 'string'
        ? record.name
        : ''
    const action: SkillUsageAction | null = name === 'skill_view'
      ? 'view'
      : name === 'skill_manage'
        ? 'manage'
        : null
    if (!action) return null

    const args = parseJsonObject(functionRecord.arguments ?? record.arguments)
    const skill = typeof args?.name === 'string' ? args.name.trim() : ''
    return { action, skill }
  }

  return null
}

function toolCallRecordIds(record: Record<string, unknown>): string[] {
  const functionRecord = record.function && typeof record.function === 'object'
    ? record.function as Record<string, unknown>
    : {}
  return [record.id, record.call_id, record.tool_call_id, functionRecord.call_id]
    .filter((value): value is string => typeof value === 'string')
}

function buildAssistantToolCallLookup(rows: Record<string, unknown>[]): Map<string, string> {
  const lookup = new Map<string, string>()
  for (const row of rows) {
    const sessionId = typeof row.session_id === 'string' ? row.session_id : ''
    const rawToolCalls = typeof row.tool_calls === 'string' ? row.tool_calls : ''
    if (!sessionId || !rawToolCalls) continue

    let parsed: unknown
    try {
      parsed = JSON.parse(rawToolCalls)
    } catch {
      continue
    }

    const calls = Array.isArray(parsed) ? parsed : [parsed]
    for (const call of calls) {
      if (!call || typeof call !== 'object') continue
      const record = call as Record<string, unknown>
      const functionRecord = record.function && typeof record.function === 'object'
        ? record.function as Record<string, unknown>
        : {}
      const name = typeof functionRecord.name === 'string'
        ? functionRecord.name
        : typeof record.name === 'string'
          ? record.name
          : ''
      if (name !== 'skill_view' && name !== 'skill_manage') continue
      const serialized = JSON.stringify([record])
      for (const id of toolCallRecordIds(record)) {
        lookup.set(`${sessionId}\u0000${id}`, serialized)
      }
    }
  }
  return lookup
}

function attachAssistantToolCalls(
  candidateRows: Record<string, unknown>[],
  assistantRows: Record<string, unknown>[],
): Record<string, unknown>[] {
  const lookup = buildAssistantToolCallLookup(assistantRows)
  return candidateRows.map(row => {
    const sessionId = typeof row.session_id === 'string' ? row.session_id : ''
    const toolCallId = typeof row.tool_call_id === 'string' ? row.tool_call_id : ''
    if (!sessionId || !toolCallId) return row
    const assistantToolCalls = lookup.get(`${sessionId}\u0000${toolCallId}`)
    return assistantToolCalls ? { ...row, assistant_tool_calls: assistantToolCalls } : row
  })
}

function chunkValues<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size))
  }
  return chunks
}

function sqliteIndexHint(db: SqliteDbLike, indexName: 'idx_sessions_started' | 'idx_messages_session'): string {
  try {
    const row = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(indexName)
    return row ? ` INDEXED BY ${indexName}` : ''
  } catch {
    return ''
  }
}

function mapSkillUsageEvent(row: Record<string, unknown>): RawSkillUsageEvent | null {
  const content = typeof row.content === 'string' ? row.content : ''
  const toolName = typeof row.tool_name === 'string' ? row.tool_name : ''
  let toolCall: { action: SkillUsageAction; skill: string } | null = null
  let action: SkillUsageAction | null = toolName === 'skill_view' || content.startsWith('[skill_view]')
    ? 'view'
    : toolName === 'skill_manage' || content.startsWith('[skill_manage]')
      ? 'manage'
      : null

  if (!action) {
    toolCall = extractSkillToolCall(row)
    action = toolCall?.action ?? null
  }

  if (!action) return null

  let skill = action === 'view'
    ? extractSkillNameFromViewContent(content)
    : extractSkillNameFromManageContent(content)
  if (!skill) {
    toolCall = toolCall || extractSkillToolCall(row)
    skill = toolCall?.skill || ''
  }

  if (!skill) return null

  return {
    skill,
    action,
    timestamp: normalizeNullableNumber(row.timestamp),
  }
}

function formatUnixDate(timestamp: number | null): string {
  if (timestamp == null) return ''
  return new Date(timestamp * 1000).toISOString().slice(0, 10)
}

function emptySkillUsageStats(periodDays: number): HermesSkillUsageStats {
  return {
    period_days: periodDays,
    summary: {
      total_skill_loads: 0,
      total_skill_edits: 0,
      total_skill_actions: 0,
      distinct_skills_used: 0,
    },
    by_day: [],
    top_skills: [],
  }
}

export interface SkillUsageEventSyncPage {
  events: ExternalSkillUsageEvent[]
  cursor: number
  reset: boolean
}

/** Incrementally read only new Hermes skill events for Studio's indexed ledger. */
export async function listSkillUsageEventsAfterMessageId(
  afterMessageId = 0,
  profile?: string,
): Promise<SkillUsageEventSyncPage> {
  const dbPath = profile ? sessionDbPathForProfile(profile) : sessionDbPath()
  if (!existsSync(dbPath)) return { events: [], cursor: 0, reset: afterMessageId > 0 }
  const db = await openSessionDb(profile)
  try {
    const maxRow = db.prepare('SELECT COALESCE(MAX(id), 0) AS max_id FROM messages').get() as Record<string, unknown> | undefined
    const cursor = Number(maxRow?.max_id || 0)
    const reset = cursor < afterMessageId
    const effectiveAfter = reset ? 0 : Math.max(0, afterMessageId)
    if (cursor <= effectiveAfter) return { events: [], cursor, reset }

    const rows = db.prepare(`
      SELECT m.id AS message_id, m.session_id, m.tool_name, m.tool_call_id,
        SUBSTR(m.content, 1, 500) AS content, COALESCE(m.timestamp, s.started_at) AS timestamp
      FROM sessions s
      JOIN messages m ON m.session_id = s.id
      WHERE m.id > ? AND m.id <= ? AND m.role = 'tool'
        AND (
          COALESCE(m.tool_name, '') IN ('skill_view', 'skill_manage')
          OR COALESCE(m.content, '') LIKE '[skill_view]%'
          OR COALESCE(m.content, '') LIKE '[skill_manage]%'
          OR m.tool_call_id IS NOT NULL
        )
    `).all(effectiveAfter, cursor) as Record<string, unknown>[]
    const sessionIds = [...new Set(rows.map(row => String(row.session_id || '')).filter(Boolean))]
    const assistantRows: Record<string, unknown>[] = []
    for (const chunk of chunkValues(sessionIds, 500)) {
      const placeholders = chunk.map(() => '?').join(', ')
      assistantRows.push(...db.prepare(`
        SELECT session_id, tool_calls
        FROM messages
        WHERE role = 'assistant'
          AND tool_calls IS NOT NULL
          AND (tool_calls LIKE '%skill_view%' OR tool_calls LIKE '%skill_manage%')
          AND session_id IN (${placeholders})
      `).all(...chunk) as Record<string, unknown>[])
    }
    const attached = attachAssistantToolCalls(rows, assistantRows)
    const events: ExternalSkillUsageEvent[] = []
    const counted = new Set<number>()
    for (const row of attached) {
      const messageId = Number(row.message_id)
      if (!Number.isFinite(messageId) || counted.has(messageId)) continue
      const event = mapSkillUsageEvent(row)
      if (!event) continue
      counted.add(messageId)
      events.push({
        messageId,
        sessionId: String(row.session_id || ''),
        skill: event.skill,
        action: event.action,
        timestamp: event.timestamp ?? Math.floor(Date.now() / 1000),
      })
    }
    return { events, cursor, reset }
  } finally {
    db.close()
  }
}

export async function getSkillUsageStatsFromDb(
  days = 7,
  nowSeconds = Math.floor(Date.now() / 1000),
  profile?: string,
  excludedSessionIds: Iterable<string> = [],
): Promise<HermesSkillUsageStats> {
  const normalizedDays = Number.isFinite(days) ? days : 7
  const safeDays = Math.max(1, Math.floor(normalizedDays))
  const since = nowSeconds - safeDays * 24 * 60 * 60
  const dbPath = profile ? sessionDbPathForProfile(profile) : sessionDbPath()
  if (!existsSync(dbPath)) return emptySkillUsageStats(safeDays)

  const db = await openSessionDb(profile)

  const sessionsIndexHint = sqliteIndexHint(db, 'idx_sessions_started')
  const messagesIndexHint = sqliteIndexHint(db, 'idx_messages_session')
  const compactToolPredicate = `
    COALESCE(m.tool_name, '') IN ('skill_view', 'skill_manage')
    OR COALESCE(m.content, '') LIKE '[skill_view]%'
    OR COALESCE(m.content, '') LIKE '[skill_manage]%'
  `
  const excludedIds = [...new Set([...excludedSessionIds].map(id => String(id || '').trim()).filter(Boolean))]
  const exclusionClause = excludedIds.length > 0
    ? ' AND s.id NOT IN (SELECT value FROM json_each(?))'
    : ''
  const exclusionParams = excludedIds.length > 0 ? [JSON.stringify(excludedIds)] : []
  const eventTimeExpression = 'COALESCE(m.timestamp, s.started_at)'
  const rowSelect = `
    SELECT
      m.id AS message_id,
      m.session_id,
      m.tool_name,
      m.tool_call_id,
      SUBSTR(m.content, 1, 300) AS content,
      ${eventTimeExpression} AS timestamp
    FROM sessions s${sessionsIndexHint}
    JOIN messages m${messagesIndexHint} ON m.session_id = s.id
  `
  let rawRows: Record<string, unknown>[]
  try {
    const selectCandidateRows = (predicate: string): Record<string, unknown>[] => {
      const recentRows = db.prepare(`
        ${rowSelect}
        WHERE m.role = 'tool'
          AND (${predicate})
          AND s.started_at > ?
          AND ${eventTimeExpression} > ?
          ${exclusionClause}
      `).all(since, since, ...exclusionParams) as Record<string, unknown>[]
      const lateRows = db.prepare(`
        ${rowSelect}
        WHERE m.role = 'tool'
          AND (${predicate})
          AND s.started_at <= ?
          AND ${eventTimeExpression} > ?
          ${exclusionClause}
      `).all(since, since, ...exclusionParams) as Record<string, unknown>[]
      return [...recentRows, ...lateRows]
    }

    const compactRows = selectCandidateRows(compactToolPredicate)
    const toolCallRows = selectCandidateRows('m.tool_call_id IS NOT NULL')
    const toolCallSessionIds = [...new Set(
      toolCallRows
        .map(row => typeof row.session_id === 'string' ? row.session_id : '')
        .filter(Boolean),
    )]
    const assistantRows: Record<string, unknown>[] = []
    for (const chunk of chunkValues(toolCallSessionIds, 500)) {
      const placeholders = chunk.map(() => '?').join(', ')
      assistantRows.push(...db.prepare(`
        SELECT session_id, tool_calls
        FROM messages${messagesIndexHint}
        WHERE role = 'assistant'
          AND tool_calls IS NOT NULL
          AND (tool_calls LIKE '%skill_view%' OR tool_calls LIKE '%skill_manage%')
          AND session_id IN (${placeholders})
      `).all(...chunk) as Record<string, unknown>[])
    }
    rawRows = [...compactRows, ...attachAssistantToolCalls(toolCallRows, assistantRows)]
  } finally {
    db.close()
  }

  const skillMap = new Map<string, { skill: string; view_count: number; manage_count: number; last_used_at: number | null }>()
  const dayMap = new Map<string, { date: string; view_count: number; manage_count: number }>()
  const daySkillMap = new Map<string, Map<string, { skill: string; view_count: number; manage_count: number }>>()
  const countedMessageIds = new Set<string>()

  for (const row of rawRows) {
    const event = mapSkillUsageEvent(row)
    if (!event) continue
    const messageId = normalizeNullableNumber(row.message_id)
    if (messageId != null) {
      const messageKey = String(messageId)
      if (countedMessageIds.has(messageKey)) continue
      countedMessageIds.add(messageKey)
    }

    const entry = skillMap.get(event.skill) || {
      skill: event.skill,
      view_count: 0,
      manage_count: 0,
      last_used_at: null,
    }
    if (event.action === 'view') entry.view_count += 1
    else entry.manage_count += 1
    if (event.timestamp != null && (entry.last_used_at == null || event.timestamp > entry.last_used_at)) {
      entry.last_used_at = event.timestamp
    }
    skillMap.set(event.skill, entry)

    const date = formatUnixDate(event.timestamp)
    if (date) {
      const day = dayMap.get(date) || { date, view_count: 0, manage_count: 0 }
      if (event.action === 'view') day.view_count += 1
      else day.manage_count += 1
      dayMap.set(date, day)

      const skillsForDay = daySkillMap.get(date) || new Map<string, { skill: string; view_count: number; manage_count: number }>()
      const skillForDay = skillsForDay.get(event.skill) || { skill: event.skill, view_count: 0, manage_count: 0 }
      if (event.action === 'view') skillForDay.view_count += 1
      else skillForDay.manage_count += 1
      skillsForDay.set(event.skill, skillForDay)
      daySkillMap.set(date, skillsForDay)
    }
  }

  const totalLoads = [...skillMap.values()].reduce((sum, skill) => sum + skill.view_count, 0)
  const totalEdits = [...skillMap.values()].reduce((sum, skill) => sum + skill.manage_count, 0)
  const totalActions = totalLoads + totalEdits
  const byDay = [...dayMap.values()]
    .map(day => ({
      ...day,
      total_count: day.view_count + day.manage_count,
      skills: [...(daySkillMap.get(day.date)?.values() || [])]
        .map(skill => ({
          ...skill,
          total_count: skill.view_count + skill.manage_count,
        }))
        .sort((a, b) => b.total_count - a.total_count || a.skill.localeCompare(b.skill)),
    }))
    .sort((a, b) => a.date.localeCompare(b.date))
  const topSkills = [...skillMap.values()]
    .map(skill => ({
      ...skill,
      total_count: skill.view_count + skill.manage_count,
      percentage: totalActions > 0 ? (skill.view_count + skill.manage_count) / totalActions * 100 : 0,
    }))
    .sort((a, b) =>
      b.total_count - a.total_count ||
      b.view_count - a.view_count ||
      b.manage_count - a.manage_count ||
      (b.last_used_at || 0) - (a.last_used_at || 0) ||
      a.skill.localeCompare(b.skill),
    )

  return {
    period_days: safeDays,
    summary: {
      total_skill_loads: totalLoads,
      total_skill_edits: totalEdits,
      total_skill_actions: totalActions,
      distinct_skills_used: skillMap.size,
    },
    by_day: byDay,
    top_skills: topSkills,
  }
}

export async function getUsageStatsFromDb(
  days = 30,
  nowSeconds = Math.floor(Date.now() / 1000),
  profile?: string,
  excludedSessionIds: Iterable<string> = [],
  unpricedSessionIds: Iterable<string> = [],
): Promise<HermesUsageStats> {
  const empty: HermesUsageStats = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    sessions: 0,
    by_model: [],
    by_agent: [],
    by_day: [],
    cost: 0,
    cost_coverage: emptyCostCoverage(),
    total_api_calls: 0,
  }

  const normalizedDays = Number.isFinite(days) ? days : 30
  const safeDays = Math.max(1, Math.floor(normalizedDays))
  const since = nowSeconds - safeDays * 24 * 60 * 60
  const excludedIds = [...new Set([...excludedSessionIds].map(id => String(id || '').trim()).filter(Boolean))]
  const exclusionClause = excludedIds.length > 0
    ? ` AND id NOT IN (SELECT value FROM json_each(?))`
    : ''
  const queryParams = excludedIds.length > 0 ? [since, JSON.stringify(excludedIds)] : [since]
  const db = await openSessionDb(profile)

  try {
    // Legacy estimated_cost_usd defaults to zero even when no pricing exists.
    const hasCostStatus = tableHasColumn(db, 'sessions', 'cost_status')
    const actualCost = `CASE WHEN actual_cost_usd >= 0 THEN actual_cost_usd END`
    const estimatedCost = `CASE WHEN estimated_cost_usd > 0${hasCostStatus ? " OR (estimated_cost_usd = 0 AND cost_status IN ('estimated', 'free'))" : ''} THEN estimated_cost_usd END`
    const costExpr = `COALESCE(${actualCost}, ${estimatedCost})`
    const costColumns = `COALESCE(SUM(${costExpr}), 0) AS cost,
      COALESCE(SUM(CASE WHEN ${actualCost} IS NOT NULL THEN 1 ELSE 0 END), 0) AS cost_reported,
      COALESCE(SUM(CASE WHEN ${actualCost} IS NULL AND ${estimatedCost} IS NOT NULL THEN 1 ELSE 0 END), 0) AS cost_estimated,
      COALESCE(SUM(CASE WHEN ${costExpr} IS NULL THEN 1 ELSE 0 END), 0) AS cost_unknown`
    const coverage = (row: Record<string, unknown>) => ({ reported: Number(row.cost_reported || 0), estimated: Number(row.cost_estimated || 0), unknown: Number(row.cost_unknown || 0) })
    const fallbackIds = [...new Set(unpricedSessionIds)].filter(id => excludedIds.includes(id))
    const costFallbacks = fallbackIds.length ? db.prepare(`SELECT id AS session_id, date(started_at, 'unixepoch') AS date,
      ${costExpr} AS cost, CASE WHEN ${actualCost} IS NOT NULL THEN 'reported' ELSE 'estimated' END AS source
      FROM sessions WHERE started_at > ? AND id IN (SELECT value FROM json_each(?)) AND ${costExpr} IS NOT NULL
    `).all(since, JSON.stringify(fallbackIds)) as NonNullable<HermesUsageStats['cost_fallbacks']> : []
    const apiCallsExpr = tableHasColumn(db, 'sessions', 'api_call_count')
      ? 'COALESCE(SUM(api_call_count), 0)'
      : '0'
    const totals = db.prepare(`
      SELECT
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
        COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
        COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
        ${costColumns},
        COUNT(*) AS sessions,
        ${apiCallsExpr} AS total_api_calls
      FROM sessions
      WHERE started_at > ?${exclusionClause}
    `).get(...queryParams) as Record<string, unknown> | undefined

    if (!totals) return empty

    const byModel = db.prepare(`
      SELECT
        COALESCE(model, '') AS model,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
        COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
        COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
        COUNT(*) AS sessions
      FROM sessions
      WHERE started_at > ? AND model IS NOT NULL${exclusionClause}
      GROUP BY model
      ORDER BY COALESCE(SUM(input_tokens), 0) + COALESCE(SUM(output_tokens), 0) DESC
    `).all(...queryParams).map(row => ({
      model: String(row.model || ''),
      input_tokens: normalizeNumber(row.input_tokens),
      output_tokens: normalizeNumber(row.output_tokens),
      cache_read_tokens: normalizeNumber(row.cache_read_tokens),
      cache_write_tokens: normalizeNumber(row.cache_write_tokens),
      reasoning_tokens: normalizeNumber(row.reasoning_tokens),
      sessions: normalizeNumber(row.sessions),
    }))

    const byDay = db.prepare(`
      SELECT
        date(started_at, 'unixepoch') AS date,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
        COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
        COUNT(*) AS sessions,
        ${costColumns}
      FROM sessions
      WHERE started_at > ?${exclusionClause}
      GROUP BY date
      ORDER BY date ASC
    `).all(...queryParams).map(row => ({
      date: String(row.date || ''),
      input_tokens: normalizeNumber(row.input_tokens),
      output_tokens: normalizeNumber(row.output_tokens),
      cache_read_tokens: normalizeNumber(row.cache_read_tokens),
      cache_write_tokens: normalizeNumber(row.cache_write_tokens),
      sessions: normalizeNumber(row.sessions),
      errors: 0,
      cost: normalizeNumber(row.cost),
      cost_coverage: coverage(row),
    }))

    return {
      input_tokens: normalizeNumber(totals.input_tokens),
      output_tokens: normalizeNumber(totals.output_tokens),
      cache_read_tokens: normalizeNumber(totals.cache_read_tokens),
      cache_write_tokens: normalizeNumber(totals.cache_write_tokens),
      reasoning_tokens: normalizeNumber(totals.reasoning_tokens),
      sessions: normalizeNumber(totals.sessions),
      by_model: byModel,
      by_agent: normalizeNumber(totals.sessions) > 0
        ? [{
            agent: 'hermes',
            input_tokens: normalizeNumber(totals.input_tokens),
            output_tokens: normalizeNumber(totals.output_tokens),
            cache_read_tokens: normalizeNumber(totals.cache_read_tokens),
            cache_write_tokens: normalizeNumber(totals.cache_write_tokens),
            reasoning_tokens: normalizeNumber(totals.reasoning_tokens),
            sessions: normalizeNumber(totals.sessions),
          }]
        : [],
      by_day: byDay,
      cost: normalizeNumber(totals.cost),
      cost_coverage: coverage(totals),
      cost_fallbacks: costFallbacks,
      total_api_calls: normalizeNumber(totals.total_api_calls),
    }
  } finally {
    db.close()
  }
}

export async function listSessionSummaries(source?: string, limit = 2000, profile?: string): Promise<HermesSessionRow[]> {
  if (!SQLITE_AVAILABLE) {
    throw new Error(`node:sqlite requires Node >= 22.5, current: ${process.versions.node}`)
  }

  const { DatabaseSync } = await import('node:sqlite')
  const dbPath = profile ? sessionDbPathForProfile(profile) : sessionDbPath()
  const db = new DatabaseSync(dbPath, { open: true, readOnly: true })

  try {
    const idx = loadAllSessions(db)
    return [...idx.byId.values()]
      .filter(session => !source || session.source === source)
      .filter(session => !isCompressionContinuationChild(session, idx))
      .map(session => projectSessionSummary(session, collectSessionChain(session, idx)))
      .sort(compareSessionSummariesNewestFirst)
      .slice(0, limit)
  } finally {
    db.close()
  }
}

export async function listSessionSummaryGroups(
  limitPerSource = 20,
  profile?: string,
  includedSessionIds: string[] = [],
): Promise<HermesSessionSummaryGroupsResult> {
  if (!SQLITE_AVAILABLE) {
    throw new Error(`node:sqlite requires Node >= 22.5, current: ${process.versions.node}`)
  }

  const db = await openSessionDb(profile)
  try {
    const idx = loadAllSessions(db)
    const grouped = new Map<string, HermesSessionRow[]>()
    const includedIds = new Set(includedSessionIds)
    const included = new Map<string, HermesSessionRow>()

    for (const root of idx.byId.values()) {
      if (isCompressionContinuationChild(root, idx)) continue
      const summary = projectSessionSummary(root, collectSessionChain(root, idx))
      const sessions = grouped.get(summary.source) || []
      sessions.push(summary)
      grouped.set(summary.source, sessions)
      if (includedIds.has(summary.id)) included.set(summary.id, summary)
    }

    const normalizedLimit = Math.max(1, limitPerSource)
    const groups = [...grouped.entries()].map(([source, sessions]) => {
      sessions.sort(compareSessionSummariesNewestFirst)
      return {
        source,
        sessions: sessions.slice(0, normalizedLimit),
        total: sessions.length,
        hasMore: sessions.length > normalizedLimit,
      }
    })

    return { groups, included: [...included.values()] }
  } finally {
    db.close()
  }
}

export async function searchSessionSummariesWithProfile(
  query: string,
  profile: string,
  source?: string,
  limit = 20,
): Promise<HermesSessionSearchRow[]> {
  if (!SQLITE_AVAILABLE) {
    throw new Error(`node:sqlite requires Node >= 22.5, current: ${process.versions.node}`)
  }

  const trimmed = query.trim()
  if (!trimmed) return []

  const { DatabaseSync } = await import('node:sqlite')
  const dbPath = sessionDbPathForProfile(profile)
  const db = new DatabaseSync(dbPath, { open: true, readOnly: true })
  const normalized = sanitizeFtsQuery(trimmed)
  const prefixQuery = toPrefixQuery(normalized)
  const titlePattern = buildLikePattern(normalizeTitleLikeQuery(trimmed).toLowerCase())
  const useLiteralContentSearch = containsCjk(trimmed) || shouldUseLiteralContentSearch(trimmed)
  const candidateLimit = searchCandidateLimit(limit)

  try {
    const sourceClause = source ? 'AND s.source = ?' : ''
    const sourceParams = source ? [source] : []
    const titleSql = `
      WITH base AS (
        SELECT
          ${SESSION_SELECT},
          s.parent_session_id AS parent_session_id
        FROM sessions s
        WHERE s.source != 'tool' AND s.id NOT LIKE 'compress_%'
          ${sourceClause}
      )
      SELECT
        base.*,
        NULL AS matched_message_id,
        CASE
          WHEN base.title IS NOT NULL AND base.title != '' THEN base.title
          ELSE base.preview
        END AS snippet,
        0 AS rank
      FROM base
      WHERE LOWER(COALESCE(base.title, '')) LIKE ? ESCAPE '\\'
      ORDER BY base.last_active DESC
      LIMIT ?
    `
    const titleRows = db.prepare(titleSql).all(...sourceParams, titlePattern, candidateLimit) as Record<string, unknown>[]

    const contentSql = `
      WITH base AS (
        SELECT
          ${SESSION_SELECT},
          s.parent_session_id AS parent_session_id
        FROM sessions s
        WHERE s.source != 'tool' AND s.id NOT LIKE 'compress_%'
          ${sourceClause}
      )
      SELECT
        base.*,
        m.id AS matched_message_id,
        snippet(messages_fts, 0, '>>>', '<<<', '...', 40) AS snippet,
        bm25(messages_fts) AS rank
      FROM messages_fts
      JOIN messages m ON m.id = messages_fts.rowid
      JOIN base ON base.id = m.session_id
      WHERE messages_fts MATCH ?
      ORDER BY rank, base.last_active DESC
      LIMIT ?
    `

    const contentRows = useLiteralContentSearch
      ? runLiteralContentSearch(db, source, trimmed, candidateLimit)
      : prefixQuery
        ? (db.prepare(contentSql).all(...sourceParams, prefixQuery, candidateLimit) as Record<string, unknown>[])
        : []

    const idx = loadAllSessions(db)
    const merged = new Map<string, HermesSessionSearchRow>()
    for (const row of titleRows) {
      const mapped = projectSearchRow(row, idx, source)
      if (mapped) merged.set(mapped.id, mapped)
    }
    for (const row of contentRows) {
      const mapped = projectSearchRow(row, idx, source)
      if (mapped && !merged.has(mapped.id)) merged.set(mapped.id, mapped)
    }

    const items = [...merged.values()]
    items.sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank
      return b.last_active - a.last_active
    })
    return items.slice(0, limit)
  } catch (_err) {
    return []
  } finally {
    db.close()
  }
}

export async function searchSessionSummaries(
  query: string,
  source?: string,
  limit = 20,
): Promise<HermesSessionSearchRow[]> {
  if (!SQLITE_AVAILABLE) {
    throw new Error(`node:sqlite requires Node >= 22.5, current: ${process.versions.node}`)
  }

  const trimmed = query.trim()
  if (!trimmed) {
    const recent = await listSessionSummaries(source, limit)
    return recent.map(row => ({
      ...row,
      matched_message_id: null,
      snippet: row.preview,
      rank: 0,
    }))
  }

  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(sessionDbPath(), { open: true, readOnly: true })
  const normalized = sanitizeFtsQuery(trimmed)
  const prefixQuery = toPrefixQuery(normalized)
  const titlePattern = buildLikePattern(normalizeTitleLikeQuery(trimmed).toLowerCase())
  const useLiteralContentSearch = containsCjk(trimmed) || shouldUseLiteralContentSearch(trimmed)
  const candidateLimit = searchCandidateLimit(limit)
  let titleRows: Record<string, unknown>[] = []

  try {
    const sourceClause = source ? 'AND s.source = ?' : ''
    const sourceParams = source ? [source] : []
    const allSessionsBaseSql = `
      SELECT
        ${SESSION_SELECT},
        s.parent_session_id AS parent_session_id
      FROM sessions s
      WHERE s.source != 'tool' AND s.id NOT LIKE 'compress_%'
        ${sourceClause}
    `

    const titleSql = `
      WITH base AS (
        ${allSessionsBaseSql}
      )
      SELECT
        base.*,
        NULL AS matched_message_id,
        CASE
          WHEN base.title IS NOT NULL AND base.title != '' THEN base.title
          ELSE base.preview
        END AS snippet,
        0 AS rank
      FROM base
      WHERE LOWER(COALESCE(base.title, '')) LIKE ? ESCAPE '\\'
      ORDER BY base.last_active DESC
      LIMIT ?
    `

    const titleStatement = db.prepare(titleSql)
    titleRows = titleStatement.all(...sourceParams, titlePattern, candidateLimit) as Record<string, unknown>[]

    const contentSql = `
      WITH base AS (
        ${allSessionsBaseSql}
      )
      SELECT
        base.*,
        m.id AS matched_message_id,
        snippet(messages_fts, 0, '>>>', '<<<', '...', 40) AS snippet,
        bm25(messages_fts) AS rank
      FROM messages_fts
      JOIN messages m ON m.id = messages_fts.rowid
      JOIN base ON base.id = m.session_id
      WHERE messages_fts MATCH ?
      ORDER BY rank, base.last_active DESC
      LIMIT ?
    `

    const contentRows = useLiteralContentSearch
      ? runLiteralContentSearch(db, source, trimmed, candidateLimit)
      : prefixQuery
        ? (db.prepare(contentSql).all(...sourceParams, prefixQuery, candidateLimit) as Record<string, unknown>[])
        : []

    const idx = loadAllSessions(db)
    const merged = new Map<string, HermesSessionSearchRow>()
    for (const row of titleRows) {
      const mapped = projectSearchRow(row, idx, source)
      if (mapped) merged.set(mapped.id, mapped)
    }
    for (const row of contentRows) {
      const mapped = projectSearchRow(row, idx, source)
      if (mapped && !merged.has(mapped.id)) {
        merged.set(mapped.id, mapped)
      }
    }

    const items = [...merged.values()]
    items.sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank
      return b.last_active - a.last_active
    })
    return items.slice(0, limit)
  } catch (_err) {
    // FTS queries can fail for various inputs (pure numbers, special syntax, etc.)
    // Fall back to title-only LIKE results + literal content search for CJK
    const likeRows = containsCjk(normalized)
      ? runLiteralContentSearch(db, source, trimmed, candidateLimit)
      : []
    const idx2 = loadAllSessions(db)
    const merged = new Map<string, HermesSessionSearchRow>()
    for (const row of titleRows) {
      const mapped = projectSearchRow(row, idx2, source)
      if (mapped) merged.set(mapped.id, mapped)
    }
    for (const row of likeRows) {
      const mapped = projectSearchRow(row, idx2, source)
      if (mapped && !merged.has(mapped.id)) {
        merged.set(mapped.id, mapped)
      }
    }
    const items = [...merged.values()]
    items.sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank
      return b.last_active - a.last_active
    })
    return items.slice(0, limit)
  } finally {
    db.close()
  }
}
