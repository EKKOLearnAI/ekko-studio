import { exportSessionsRaw, type HermesSessionFull } from '../runtime/cli'
import type {
  ConversationDetail,
  ConversationListOptions,
  ConversationMessage,
  ConversationSummary,
} from '../../contracts/conversations'

export type {
  ConversationDetail,
  ConversationListOptions,
  ConversationMessage,
  ConversationSummary,
} from '../../contracts/conversations'

const LINEAGE_TOLERANCE_SECONDS = 3
const LIVE_WINDOW_SECONDS = 300
const EXPORT_CACHE_TTL_MS = 30000
const DEFAULT_CONVERSATION_LIMIT = 200
const SYNTHETIC_USER_PREFIXES = [
  '[system:',
  "you've reached the maximum number of tool-calling iterations allowed.",
  'you have reached the maximum number of tool-calling iterations allowed.',
]

type HermesMessageLike = {
  id?: number | string
  session_id?: string
  role?: string
  content?: unknown
  timestamp?: number
}

type ConversationSession = HermesSessionFull & {
  parent_session_id?: string | null
  preview: string
  last_active: number
  is_active: boolean
}

type CachedExport = {
  expires_at_ms: number
  sessions: HermesSessionFull[]
}

const exportCache = new Map<string, CachedExport>()

function cacheKey(source?: string): string {
  return source || '__all__'
}

function safeText(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

function textFromContent(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    return value
      .map(item => textFromContent(item).trim())
      .filter(Boolean)
      .join('\n')
  }
  if (!value || typeof value !== 'object') return ''

  const record = value as Record<string, unknown>
  const directKeys = ['text', 'content', 'value'] as const
  for (const key of directKeys) {
    const direct = record[key]
    if (typeof direct === 'string') return direct
    if (Array.isArray(direct)) {
      const nested = textFromContent(direct)
      if (nested) return nested
    }
  }

  const nestedKeys = ['parts', 'children', 'items'] as const
  for (const key of nestedKeys) {
    if (Array.isArray(record[key])) {
      const nested = textFromContent(record[key])
      if (nested) return nested
    }
  }

  const flattened = Object.values(record)
    .map(entry => textFromContent(entry).trim())
    .filter(Boolean)
    .join('\n')
  if (flattened) return flattened

  try {
    return JSON.stringify(record)
  } catch {
    return ''
  }
}

function normalizeText(value: unknown): string {
  return textFromContent(value).replace(/\s+/g, ' ').trim().toLowerCase()
}

function excerpt(value: unknown, width = 80): string {
  const text = textFromContent(value).replace(/\s+/g, ' ').trim()
  if (!text) return ''
  return text.length > width ? `${text.slice(0, width)}…` : text
}

function isSyntheticUserText(content: unknown): boolean {
  const text = normalizeText(content)
  return SYNTHETIC_USER_PREFIXES.some(prefix => text.startsWith(prefix))
}

function visibleHumanMessage(message: HermesMessageLike): boolean {
  const role = safeText(message.role)
  const content = textFromContent(message.content).trim()
  if (!content) return false
  if (role !== 'user' && role !== 'assistant') return false
  if (role === 'user' && isSyntheticUserText(content)) return false
  return true
}

function firstVisibleHumanText(messages: HermesMessageLike[]): string {
  const firstVisible = messages.find(visibleHumanMessage)
  return firstVisible ? textFromContent(firstVisible.content).trim() : ''
}

function maxMessageTimestamp(messages: HermesMessageLike[]): number {
  return messages.reduce((max, message) => {
    const timestamp = Number(message.timestamp || 0)
    return Number.isFinite(timestamp) && timestamp > max ? timestamp : max
  }, 0)
}

function enrichSession(session: HermesSessionFull, nowSeconds: number): ConversationSession {
  const messages = Array.isArray(session.messages) ? session.messages : []
  const preview = excerpt(firstVisibleHumanText(messages))
  const lastActive = maxMessageTimestamp(messages) || Number(session.ended_at || session.started_at || 0)
  const endedAt = session.ended_at ?? null
  return {
    ...session,
    parent_session_id: (session.parent_session_id as string | null | undefined) ?? null,
    preview,
    last_active: lastActive,
    is_active: endedAt == null && nowSeconds - lastActive <= LIVE_WINDOW_SECONDS,
  }
}

function sortByRecency<T extends { last_active: number; started_at: number; id: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    if (b.last_active !== a.last_active) return b.last_active - a.last_active
    if (b.started_at !== a.started_at) return b.started_at - a.started_at
    return a.id.localeCompare(b.id)
  })
}

function timingMatchesParent(parent: ConversationSession | undefined, child: ConversationSession | undefined): boolean {
  if (!parent || !child || parent.ended_at == null) return false
  return Math.abs(Number(child.started_at || 0) - Number(parent.ended_at || 0)) <= LINEAGE_TOLERANCE_SECONDS
}

function isBranchRoot(session: ConversationSession | undefined, byId: Map<string, ConversationSession>): boolean {
  if (!session?.parent_session_id) return false
  const parent = byId.get(session.parent_session_id)
  return !!parent && parent.end_reason === 'branched' && timingMatchesParent(parent, session)
}

function isVisibleRoot(session: ConversationSession | undefined, byId: Map<string, ConversationSession>): boolean {
  if (!session || session.source === 'tool') return false
  return session.parent_session_id == null || isBranchRoot(session, byId)
}

function continuationCandidates(parent: ConversationSession, byId: Map<string, ConversationSession>, childrenByParent: Map<string | null, string[]>): ConversationSession[] {
  const childIds = childrenByParent.get(parent.id) || []
  return childIds
    .map(childId => byId.get(childId))
    .filter((child): child is ConversationSession => !!child)
    .filter(child => child.source !== 'tool')
    .filter(child => child.source === parent.source)
    .filter(child => timingMatchesParent(parent, child))
    .sort((a, b) => {
      const aDelta = Math.abs(Number(a.started_at || 0) - Number(parent.ended_at || 0))
      const bDelta = Math.abs(Number(b.started_at || 0) - Number(parent.ended_at || 0))
      if (aDelta !== bDelta) return aDelta - bDelta
      return a.id.localeCompare(b.id)
    })
}

function nextContinuationChild(parent: ConversationSession, byId: Map<string, ConversationSession>, childrenByParent: Map<string | null, string[]>): ConversationSession | null {
  if (parent.end_reason !== 'compression') return null
  const candidates = continuationCandidates(parent, byId, childrenByParent)
  if (candidates.length === 1) return candidates[0]

  const exactPreviewMatches = candidates.filter(child => {
    const childPreview = normalizeText(child.preview)
    const parentPreview = normalizeText(parent.preview)
    return !!childPreview && childPreview === parentPreview
  })

  if (exactPreviewMatches.length === 1) return exactPreviewMatches[0]
  return null
}

function collectConversationChain(rootId: string, byId: Map<string, ConversationSession>, childrenByParent: Map<string | null, string[]>): ConversationSession[] {
  const chain: ConversationSession[] = []
  const seen = new Set<string>()
  let current = byId.get(rootId) || null
  while (current && !seen.has(current.id)) {
    chain.push(current)
    seen.add(current.id)
    current = nextContinuationChild(current, byId, childrenByParent)
  }
  return chain
}

function sessionMessages(session: HermesSessionFull): HermesMessageLike[] {
  return Array.isArray(session.messages) ? session.messages as HermesMessageLike[] : []
}

function normalizeVisibleMessage(message: HermesMessageLike, session: HermesSessionFull, index: number): ConversationMessage | null {
  if (!visibleHumanMessage(message)) return null
  const role = safeText(message.role)
  const content = textFromContent(message.content).trim()
  if (role !== 'user' && role !== 'assistant') return null
  if (!content) return null

  const rawTimestamp = Number(message.timestamp)
  const timestamp = Number.isFinite(rawTimestamp) && rawTimestamp > 0
    ? rawTimestamp
    : Number(session.ended_at || session.started_at || 0)
  const id = message.id ?? `${session.id}:${index}:${timestamp}`

  return {
    id,
    session_id: safeText(message.session_id || session.id),
    role,
    content,
    timestamp,
  }
}

function visibleMessagesForSessions(sessions: HermesSessionFull[]): ConversationMessage[] {
  return sessions
    .flatMap(session => sessionMessages(session).map((message, index) => normalizeVisibleMessage({ ...message, session_id: safeText(message.session_id || session.id) }, session, index)))
    .filter((message): message is ConversationMessage => !!message)
    .sort((a, b) => {
      if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp
      return String(a.id).localeCompare(String(b.id))
    })
}

function hasVisibleHumanMessages(sessions: HermesSessionFull[]): boolean {
  return visibleMessagesForSessions(sessions).length > 0
}

function toSummary(session: ConversationSession): ConversationSummary {
  return {
    id: session.id,
    source: safeText(session.source),
    model: safeText(session.model),
    title: session.title ?? null,
    started_at: Number(session.started_at || 0),
    ended_at: session.ended_at ?? null,
    last_active: session.last_active,
    message_count: Number(session.message_count || 0),
    tool_call_count: Number(session.tool_call_count || 0),
    input_tokens: Number(session.input_tokens || 0),
    output_tokens: Number(session.output_tokens || 0),
    cache_read_tokens: Number(session.cache_read_tokens || 0),
    cache_write_tokens: Number(session.cache_write_tokens || 0),
    reasoning_tokens: Number(session.reasoning_tokens || 0),
    billing_provider: session.billing_provider ?? null,
    estimated_cost_usd: Number(session.estimated_cost_usd || 0),
    actual_cost_usd: session.actual_cost_usd ?? null,
    cost_status: safeText(session.cost_status),
    preview: session.preview,
    is_active: session.is_active,
    thread_session_count: 1,
  }
}

function aggregateSummary(rootId: string, byId: Map<string, ConversationSession>, childrenByParent: Map<string | null, string[]>): ConversationSummary | null {
  const chain = collectConversationChain(rootId, byId, childrenByParent)
  if (!chain.length || !hasVisibleHumanMessages(chain)) return null
  const root = chain[0]
  const last = chain[chain.length - 1]
  const title = root.title || excerpt(firstVisibleHumanText(chain.flatMap(sessionMessages)), 72) || null
  const preview = root.preview || excerpt(firstVisibleHumanText(chain.flatMap(sessionMessages)))
  const costStatuses = Array.from(new Set(chain.map(session => safeText(session.cost_status)).filter(Boolean)))

  return {
    ...toSummary(root),
    title,
    preview,
    model: safeText(last?.model || root.model),
    ended_at: last?.ended_at ?? null,
    last_active: Math.max(...chain.map(session => session.last_active)),
    is_active: chain.some(session => session.is_active),
    billing_provider: last?.billing_provider ?? root.billing_provider ?? null,
    cost_status: costStatuses.length === 1 ? costStatuses[0] : 'mixed',
    thread_session_count: chain.length,
    message_count: chain.reduce((sum, session) => sum + Number(session.message_count || 0), 0),
    tool_call_count: chain.reduce((sum, session) => sum + Number(session.tool_call_count || 0), 0),
    input_tokens: chain.reduce((sum, session) => sum + Number(session.input_tokens || 0), 0),
    output_tokens: chain.reduce((sum, session) => sum + Number(session.output_tokens || 0), 0),
    cache_read_tokens: chain.reduce((sum, session) => sum + Number(session.cache_read_tokens || 0), 0),
    cache_write_tokens: chain.reduce((sum, session) => sum + Number(session.cache_write_tokens || 0), 0),
    reasoning_tokens: chain.reduce((sum, session) => sum + Number(session.reasoning_tokens || 0), 0),
    estimated_cost_usd: chain.reduce((sum, session) => sum + Number(session.estimated_cost_usd || 0), 0),
    actual_cost_usd: chain.reduce<number | null>((sum, session) => {
      const actual = session.actual_cost_usd
      if (actual == null) return sum
      return (sum || 0) + Number(actual)
    }, null),
  }
}

async function loadSessions(source?: string): Promise<ConversationSession[]> {
  const key = cacheKey(source)
  const nowMs = Date.now()
  const cached = exportCache.get(key)
  const raws = cached && cached.expires_at_ms > nowMs
    ? cached.sessions
    : await exportSessionsRaw(source)

  if (!cached || cached.expires_at_ms <= nowMs) {
    exportCache.set(key, {
      expires_at_ms: nowMs + EXPORT_CACHE_TTL_MS,
      sessions: raws,
    })
  }

  const nowSeconds = nowMs / 1000
  return raws.map(raw => enrichSession(raw, nowSeconds))
}

export async function listConversationSummaries(options: ConversationListOptions = {}): Promise<ConversationSummary[]> {
  const humanOnly = options.humanOnly !== false
  const limit = options.limit && options.limit > 0 ? options.limit : DEFAULT_CONVERSATION_LIMIT
  const sessions = await loadSessions(options.source)
  const byId = new Map(sessions.map(session => [session.id, session]))
  const childrenByParent = new Map<string | null, string[]>()
  for (const session of sessions) {
    const key = session.parent_session_id ?? null
    const siblings = childrenByParent.get(key) || []
    siblings.push(session.id)
    childrenByParent.set(key, siblings)
  }

  if (!humanOnly) {
    return sortByRecency(
      sessions
        .filter(session => session.source !== 'tool')
        .map(toSummary),
    ).slice(0, limit)
  }

  const summaries = sessions
    .filter(session => isVisibleRoot(session, byId))
    .map(session => aggregateSummary(session.id, byId, childrenByParent))
    .filter((summary): summary is ConversationSummary => !!summary)

  return sortByRecency(summaries).slice(0, limit)
}

export async function getConversationDetail(sessionId: string, options: ConversationListOptions = {}): Promise<ConversationDetail | null> {
  const humanOnly = options.humanOnly !== false
  const sessions = await loadSessions(options.source)
  const byId = new Map(sessions.map(session => [session.id, session]))
  const childrenByParent = new Map<string | null, string[]>()
  for (const session of sessions) {
    const key = session.parent_session_id ?? null
    const siblings = childrenByParent.get(key) || []
    siblings.push(session.id)
    childrenByParent.set(key, siblings)
  }

  if (!humanOnly) {
    const session = byId.get(sessionId)
    if (!session || session.source === 'tool') return null
    const messages = visibleMessagesForSessions([session])
    return {
      session_id: sessionId,
      messages,
      visible_count: messages.length,
      thread_session_count: 1,
    }
  }

  const root = byId.get(sessionId)
  if (!isVisibleRoot(root, byId)) return null
  const chain = collectConversationChain(sessionId, byId, childrenByParent)
  const messages = visibleMessagesForSessions(chain)
  if (!messages.length) return null
  return {
    session_id: sessionId,
    messages,
    visible_count: messages.length,
    thread_session_count: chain.length,
  }
}
