import { businessEvents } from '../services/webhooks/business-events'
import { ensureBusinessConsumers } from '../services/webhooks/business-consumers'
import { authorizeSessionShare, authorizeShareFile } from '../services/session-shares/access'
import { sessionShareService } from '../services/session-shares/service'
import { getSessionTaskPlans } from '../services/task-plans'
import {
  deleteHermesSessionForProfile,
  getHermesCliSession,
  getHermesModelContextLength,
  getHermesSessionDetail,
  getHermesSessionDetailForProfile,
  getHermesSessionDetailPaginatedForProfile,
  getExactHermesSessionDetailForProfile,
  getHermesUsageStats,
  listHermesSessionSummaries,
  listHermesSessionSummaryGroups,
  notifyHermesSessionModelChanged,
  stopCodingAgentSessionRun,
  invalidateCodingAgentSessionRuntime,
} from '../public/session-agent-runtime'
import {
  listSessions as localListSessions,
  countSessions as localCountSessions,
  searchSessions as localSearchSessions,
  getSession as localGetSession,
  getSessionDetail as localGetSessionDetail,
  deleteSession as localDeleteSession,
  renameSession as localRenameSession,
  setSessionArchived as localSetSessionArchived,
  setSessionPushEnabled as localSetSessionPushEnabled,
  setSessionPinned as localSetSessionPinned,
  createSession as localCreateSession,
  addMessages as localAddMessages,
  updateSession as localUpdateSession,
  updateSessionStats as localUpdateSessionStats,
} from '../public/sessions'
import { buildDbExportHistory, ExportCompressor } from '../services/context-compressor/export-compressor'
import { getLocalUsageStats, getRecordedUsageSessionIds, getUsage, getUsageBatch } from '../public/sessions'
import {
  SESSION_CATEGORY_NAME_MAX_LENGTH,
  createSessionCategory,
  deleteSessionCategory,
  findSessionCategoryByName,
  getSessionCategory,
  listSessionCategories,
  normalizeSessionCategoryName,
  renameSessionCategory,
  setSessionCategory,
} from '../public/sessions'
import type { UsageStatsAgentRow, UsageStatsModelRow, UsageStatsDailyRow } from '../public/sessions'
import { deleteWorkspaceRunChangesForSession, getWorkspaceRunChangeFile as getWorkspaceRunChangeFileFromDb, listWorkspaceRunChangesForAssistantMessages, listWorkspaceRunChangesForSession } from '../public/sessions'
import { getActiveProfileDir, getActiveProfileName, getProfileDir, listProfileNamesFromDisk, readConfigYamlForProfile } from '../public/profile-config'
import { isNearestExistingRealPathWithin, isPathWithin, relativePathFromBase } from '../services/files/path'
import {
  isWorkspaceListPathAllowed,
  normalizeWindowsWorkspacePath,
  useWindowsDriveWorkspaceMode,
} from '../services/files/workspace-path'
import { getGroupChatServer } from './group-chat'
import { logger } from '../public/logging'
import { isHermesAgentAvailable } from '../public/agent-status-registry'
import { listUserProfiles } from '../public/users'
import { ensureHermesRunWorkspace } from '../services/chat-run/workspace'
import {
  isAbsoluteWorkspacePath,
  resolveWorkspacePath,
  workspaceBaseDirectory,
  workspaceRelativePath,
} from '../services/workspace/manager'
import { getChatRunServer } from '../services/chat-run/server-registry'
import { reconcileHermesSessionHistory } from '../services/history/reconcile-hermes-history'
import { isSensitivePath, MAX_DOWNLOAD_SIZE, MAX_EDIT_SIZE } from '../services/files/file-policy'
import { buildFileContentHeaders, getFilePreviewDescriptor } from '../services/files/file-preview'
import { decorateWorkspaceEntries, getWorkspaceFileGitDiff } from '../services/files/workspace-git-status'
import { copyFile, mkdir, readFile, readdir, rename as fsRename, rm as fsRm, stat as fsStat, writeFile } from 'fs/promises'
import { normalize as pathNormalize, resolve as pathResolve } from 'path'

function getPendingDeletedSessionIds(): Set<string> {
  return getGroupChatServer()?.getStorage().getPendingDeletedSessionIds() || new Set<string>()
}

function filterPendingDeletedSessions<T extends { id: string }>(items: T[]): T[] {
  const pendingIds = getPendingDeletedSessionIds()
  if (pendingIds.size === 0) return items
  return items.filter(item => !pendingIds.has(item.id))
}

interface ConversationSummary {
  id: string
  [key: string]: any
}

function filterPendingDeletedConversationSummaries(items: ConversationSummary[]): ConversationSummary[] {
  return filterPendingDeletedSessions(items)
}

function isArchivedSession(session?: { is_archived?: number | boolean | null } | null): boolean {
  if (!session) return false
  if (typeof session.is_archived === 'boolean') return session.is_archived
  return Number(session.is_archived || 0) !== 0
}

function filterArchivedSessions<T extends { is_archived?: number | boolean | null }>(items: T[]): T[] {
  return items.filter(item => !isArchivedSession(item))
}

function requestedProfile(ctx: any): string | undefined {
  const value = ctx.state?.profile?.name || (typeof ctx.query?.profile === 'string' ? ctx.query.profile.trim() : '')
  return value || undefined
}

async function notifyBridgeSessionModelChanged(
  sessionId: string,
  model: string,
  provider: string,
  profile?: string,
): Promise<void> {
  try {
    await notifyHermesSessionModelChanged(sessionId, model, provider, profile)
  } catch (err) {
    logger.warn(err, '[sessions] failed to notify bridge of session model change')
  }
}

function explicitProfileFilter(ctx: any): string | undefined {
  const value = typeof ctx.query?.profile === 'string' ? ctx.query.profile.trim() : ''
  return value || undefined
}

function allowedProfileSet(ctx: any): Set<string> | null {
  const user = ctx.state?.user
  if (!user || user.role === 'super_admin') return null
  return new Set(listUserProfiles(user.id).map(profile => profile.profile_name))
}

function canAccessProfile(ctx: any, profile: string | null | undefined): boolean {
  const allowed = allowedProfileSet(ctx)
  return !allowed || allowed.has(profile || 'default')
}

function filterByAllowedProfiles<T>(ctx: any, items: T[]): T[] {
  const allowed = allowedProfileSet(ctx)
  if (!allowed) return items
  return items.filter(item => allowed.has(((item as any).profile as string | null | undefined) || 'default'))
}

function denySessionAccess(ctx: any, session: any | null | undefined): boolean {
  if (!session || canAccessProfile(ctx, session.profile)) return false
  ctx.status = 403
  ctx.body = { error: `Profile "${session.profile || 'default'}" is not available for this user` }
  return true
}

function isVisibleWebUiSessionSource(source?: string | null): boolean {
  return source === 'api_server' || source === 'cli' || source === 'coding_agent' || source === 'global_agent'
}

function isRequestedSessionSource(source: string | undefined, sessionSource?: string | null): boolean {
  if (source === 'global_agent') return sessionSource === 'global_agent'
  if (source === 'workflow') return sessionSource === 'workflow'
  if (source === 'group_chat') return sessionSource === 'group_chat'
  return isVisibleWebUiSessionSource(sessionSource)
}

function requestedSessionSources(source?: string): string[] {
  if (source === 'global_agent') return ['global_agent']
  if (source === 'workflow') return ['workflow']
  if (source === 'group_chat') return ['group_chat']
  return ['api_server', 'cli', 'coding_agent', 'global_agent']
}

function isHermesHistorySessionSource(source?: string | null): boolean {
  return source !== 'global_agent' && source !== 'workflow' && source !== 'group_chat'
}

async function reconcileLocalHermesHistory(sessionId: string, profile?: string): Promise<void> {
  const chatRunServer = getChatRunServer()
  await reconcileHermesSessionHistory(sessionId, {
    profile,
    isSessionActive: () => chatRunServer?.isSessionRunActive?.(sessionId) === true,
    invalidateCachedHistory: () => chatRunServer?.invalidateSessionHistory?.(sessionId),
  })
}

function sessionLastActive(session: any): number {
  return Number(session?.last_active || session?.ended_at || session?.started_at || 0)
}

function compareSessionsNewestFirst(a: any, b: any): number {
  const activityDelta = sessionLastActive(b) - sessionLastActive(a)
  if (activityDelta !== 0) return activityDelta
  return String(b?.id || '').localeCompare(String(a?.id || ''))
}

function mergeHermesHistorySessions(
  ctx: any,
  profile: string | undefined,
  hermesSessions: any[],
  localSessions: any[],
  source?: string,
): any[] {
  const importedIds = new Set(localSessions.map(session => session.id))
  const historySessionsById = new Map<string, any>()
  // Keep Hermes Agent state.db as the canonical summary when both stores have
  // the same id. Ekko Studio contributes import/archive state and local-only
  // coding-agent sessions without replacing the Agent-owned session fields.
  for (const session of hermesSessions) {
    historySessionsById.set(session.id, {
      ...(profile ? { ...session, profile } : session),
      webui_imported: importedIds.has(session.id),
    })
  }

  const localSessionsById = new Map(localSessions.map(session => [session.id, session]))
  for (const [id, session] of historySessionsById) {
    const localSession = localSessionsById.get(id)
    if (localSession?.is_archived != null) session.is_archived = localSession.is_archived
    session.is_pinned = Number(localSession?.is_pinned || 0)
    session.push_enabled = Number(localSession?.push_enabled || 0) !== 0 ? 1 : 0
  }

  for (const session of localSessions) {
    if (historySessionsById.has(session.id)) continue
    if (!isArchivedSession(session) && !isHermesHistorySessionSource(session.source)) continue
    historySessionsById.set(session.id, { ...session, webui_imported: true })
  }

  return filterPendingDeletedSessions(filterByAllowedProfiles(ctx, [...historySessionsById.values()]).filter(session =>
    (!source || session.source === source) &&
    (isHermesHistorySessionSource(session.source) || (isArchivedSession(session) && session.source !== 'global_agent')),
  ))
}

function isCodingAgentSession(session?: { source?: string | null; agent?: string | null; agent_session_id?: string | null } | null): boolean {
  return session?.source === 'coding_agent' ||
    session?.agent === 'claude' ||
    session?.agent === 'codex' ||
    session?.agent === 'pi' ||
    session?.agent === 'grok' ||
    session?.agent === 'opencode' ||
    Boolean(session?.agent_session_id)
}

interface HermesDeleteResult {
  attempted: boolean
  deleted: boolean
  profile?: string
  error?: string
}

interface BatchDeleteTarget {
  id: string
  profile?: string | null
}

interface ProfileDefaultModel {
  model: string
  provider: string
}

interface LocalImportMessage {
  session_id: string
  role: string
  content: string
  tool_call_id?: string | null
  tool_calls?: any[] | null
  tool_name?: string | null
  timestamp?: number
  token_count?: number | null
  finish_reason?: string | null
  reasoning?: string | null
  reasoning_details?: string | null
  reasoning_content?: string | null
}

function hasProfileOnDisk(profile: string): boolean {
  return listProfileNamesFromDisk().includes(profile || 'default')
}

async function deleteHermesSessionIfPresent(sessionId: string, profile?: string | null): Promise<HermesDeleteResult> {
  const targetProfile = profile || 'default'
  if (!isHermesAgentAvailable()) {
    return { attempted: false, deleted: false, profile: targetProfile }
  }
  if (!hasProfileOnDisk(targetProfile)) {
    return { attempted: false, deleted: false, profile: targetProfile }
  }

  try {
    const hermesSession = await getExactHermesSessionDetailForProfile(sessionId, targetProfile)
    if (!hermesSession) {
      return { attempted: false, deleted: false, profile: targetProfile }
    }

    const deleted = await deleteHermesSessionForProfile(sessionId, targetProfile)
    return {
      attempted: true,
      deleted,
      profile: targetProfile,
      error: deleted ? undefined : 'Failed to delete Hermes session',
    }
  } catch (err: any) {
    const message = err?.message || 'Failed to inspect Hermes session'
    logger.warn({ err, sessionId, profile: targetProfile }, 'Hermes Session: profile delete skipped')
    return { attempted: true, deleted: false, profile: targetProfile, error: message }
  }
}

async function getProfileDefaultModel(profile: string): Promise<ProfileDefaultModel> {
  try {
    const config = await readConfigYamlForProfile(profile)
    const modelSection = config?.model
    if (modelSection && typeof modelSection === 'object' && !Array.isArray(modelSection)) {
      return {
        model: String(modelSection.default || '').trim(),
        provider: String(modelSection.provider || '').trim(),
      }
    }
    if (typeof modelSection === 'string') {
      return { model: modelSection.trim(), provider: '' }
    }
  } catch (err) {
    logger.warn({ err, profile }, 'Hermes Session: failed to read profile default model for import')
  }
  return { model: '', provider: '' }
}

function normalizeImportText(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function normalizeImportNullableText(value: unknown): string | null {
  const text = normalizeImportText(value)
  return text ? text : null
}

function normalizeImportToolCalls(value: unknown): any[] | null {
  if (!Array.isArray(value)) return null
  const calls = value
    .map((call: any) => {
      const id = String(call?.id || '').trim()
      const fn = call?.function && typeof call.function === 'object' ? call.function : {}
      const name = String(fn.name || call?.name || '').trim()
      if (!id || !name) return null
      const rawArgs = fn.arguments ?? call?.arguments ?? {}
      const args = typeof rawArgs === 'string' ? rawArgs : normalizeImportText(rawArgs || {})
      return {
        id,
        type: String(call?.type || 'function'),
        function: { name, arguments: args || '{}' },
      }
    })
    .filter((call): call is { id: string; type: string; function: { name: string; arguments: string } } => Boolean(call))
  return calls.length > 0 ? calls : null
}

function buildImportMessages(sessionId: string, messages: any[]): LocalImportMessage[] {
  const result: LocalImportMessage[] = []
  const knownToolCallIds = new Set<string>()

  for (const message of messages) {
    const role = String(message?.role || '').trim()
    if (role !== 'user' && role !== 'assistant' && role !== 'tool') continue

    const toolCalls = role === 'assistant' ? normalizeImportToolCalls(message.tool_calls) : null
    if (toolCalls) {
      for (const call of toolCalls) knownToolCallIds.add(call.id)
    }

    if (role === 'tool') {
      const callId = String(message?.tool_call_id || '').trim()
      if (!callId || !knownToolCallIds.has(callId)) continue
      result.push({
        session_id: sessionId,
        role,
        content: normalizeImportText(message?.content),
        tool_call_id: callId,
        tool_calls: null,
        tool_name: normalizeImportNullableText(message?.tool_name),
        timestamp: Number(message?.timestamp || 0),
        token_count: message?.token_count == null ? null : Number(message.token_count),
        finish_reason: normalizeImportNullableText(message?.finish_reason),
        reasoning: null,
        reasoning_details: null,
        reasoning_content: null,
      })
      continue
    }

    const content = normalizeImportText(message?.content)
    if (role === 'assistant' && !content.trim() && !toolCalls) continue

    result.push({
      session_id: sessionId,
      role,
      content,
      tool_call_id: null,
      tool_calls: toolCalls,
      tool_name: null,
      timestamp: Number(message?.timestamp || 0),
      token_count: message?.token_count == null ? null : Number(message.token_count),
      finish_reason: normalizeImportNullableText(message?.finish_reason),
      reasoning: role === 'assistant' ? normalizeImportNullableText(message?.reasoning) : null,
      reasoning_details: role === 'assistant' ? normalizeImportNullableText(message?.reasoning_details) : null,
      reasoning_content: role === 'assistant' ? normalizeImportNullableText(message?.reasoning_content) : null,
    })
  }

  return result
}

export async function listConversations(ctx: any) {
  const source = (ctx.query.source as string) || undefined
  const limit = ctx.query.limit ? parseInt(ctx.query.limit as string, 10) : undefined

  const profile = explicitProfileFilter(ctx)
  const sessions = localListSessions(profile, source, limit && limit > 0 ? limit : 200)
  const summaries: ConversationSummary[] = sessions.map(s => ({
    id: s.id,
    profile: s.profile || null,
    source: s.source,
    agent: s.agent,
    agent_mode: s.agent_mode,
    agent_session_id: s.agent_session_id,
    agent_native_session_id: s.agent_native_session_id,
    agent_preset: s.agent_preset,
    model: s.model,
    provider: s.provider,
    api_mode: s.api_mode,
    title: s.title,
    started_at: s.started_at,
    ended_at: s.ended_at,
    last_active: s.last_active,
    message_count: s.message_count,
    tool_call_count: s.tool_call_count,
    input_tokens: s.input_tokens,
    output_tokens: s.output_tokens,
    cache_read_tokens: s.cache_read_tokens,
    cache_write_tokens: s.cache_write_tokens,
    reasoning_tokens: s.reasoning_tokens,
    billing_provider: s.billing_provider,
    estimated_cost_usd: s.estimated_cost_usd,
    actual_cost_usd: s.actual_cost_usd,
    cost_status: s.cost_status,
    preview: s.preview,
    workspace: s.workspace || null,
    is_archived: s.is_archived || 0,
    is_active: s.ended_at == null && (Date.now() / 1000 - s.last_active) <= 300,
    thread_session_count: 1,
  }))
  ctx.body = { sessions: filterPendingDeletedConversationSummaries(filterByAllowedProfiles(ctx, summaries)) }
}

export async function getConversationMessages(ctx: any) {
  const humanOnly = (ctx.query.humanOnly as string) !== 'false' && ctx.query.humanOnly !== '0'

  const detail = localGetSessionDetail(ctx.params.id)
  if (!detail) {
    ctx.status = 404
    ctx.body = { error: 'Conversation not found' }
    return
  }
  if (denySessionAccess(ctx, detail)) return
  const messages = (detail.messages || [])
    .filter(m => {
      if (humanOnly && m.role !== 'user' && m.role !== 'assistant') return false
      if (!m.content) return false
      return true
    })
    .map(m => ({
      id: m.id,
      session_id: m.session_id,
      role: m.role as 'user' | 'assistant',
      content: m.content,
      timestamp: m.timestamp,
    }))
  ctx.body = {
    session_id: ctx.params.id,
    messages,
    visible_count: messages.length,
    thread_session_count: 1,
  }
}

export async function list(ctx: any) {
  const source = (ctx.query.source as string) || undefined
  const limit = ctx.query.limit ? parseInt(ctx.query.limit as string, 10) : undefined
  const profile = explicitProfileFilter(ctx)
  const effectiveLimit = limit && limit > 0 ? limit : 2000
  const paginated = ctx.query.offset !== undefined
  const requestedOffset = Number(ctx.query.offset)
  const offset = Number.isSafeInteger(requestedOffset) && requestedOffset > 0 ? requestedOffset : 0
  const category = ctx.query.category
  const categoryId = category === 'none' ? null : category === undefined || category === 'pinned' ? undefined : Number(category)
  if (categoryId !== undefined && categoryId !== null && (!Number.isSafeInteger(categoryId) || categoryId <= 0)) {
    ctx.status = 400
    ctx.body = { error: 'category must be a positive integer, none, or pinned' }
    return
  }
  const readIds = (raw: unknown): string[] => (Array.isArray(raw) ? raw : raw ? [raw] : [])
    .map(value => String(value).trim()).filter(Boolean)
  const includedIds = ctx.query.include === undefined ? undefined : readIds(ctx.query.include)
  const excludedIds = readIds(ctx.query.exclude)

  const knownProfiles = profile ? null : new Set(listProfileNamesFromDisk())
  const allowedProfiles = allowedProfileSet(ctx)
  const visibleProfiles = knownProfiles
    ? [...knownProfiles].filter(name => !allowedProfiles || allowedProfiles.has(name))
    : undefined
  const listOptions = {
    ...(category === 'pinned' || ctx.query.pinned === 'true' ? { pinned: true } : ctx.query.pinned === 'false' ? { pinned: false } : {}),
    ...(categoryId !== undefined ? { categoryId } : {}),
    ...(includedIds !== undefined ? { includeSessionIds: includedIds } : {}),
    sources: source ? undefined : requestedSessionSources(),
    profiles: visibleProfiles,
    includeArchived: false,
    excludeSessionIds: [...getPendingDeletedSessionIds(), ...excludedIds],
  }
  const allSessions = localListSessions(profile, source, effectiveLimit + (paginated ? 1 : 0), {
    ...listOptions,
    ...(paginated ? { offset } : {}),
  })
  const sessions = filterPendingDeletedSessions(filterArchivedSessions(filterByAllowedProfiles(ctx, allSessions).filter(s =>
      isRequestedSessionSource(source, s.source) &&
      (!knownProfiles || knownProfiles.has(s.profile || 'default')),
    )))
  ctx.body = {
    sessions: paginated ? sessions.slice(0, effectiveLimit) : sessions,
    ...(paginated ? {
      hasMore: sessions.length > effectiveLimit, offset, limit: effectiveLimit,
      total: profile && allowedProfiles && !allowedProfiles.has(profile)
        ? 0 : localCountSessions(profile, source, listOptions),
    } : {}),
  }
}

export async function listCategories(ctx: any) {
  ctx.body = { categories: listSessionCategories() }
}

export async function createCategory(ctx: any) {
  const body = ctx.request.body as { name?: string }
  const name = normalizeSessionCategoryName(body?.name)
  if (!name) {
    ctx.status = 400
    ctx.body = { error: 'Category name is required' }
    return
  }
  if (name.length > SESSION_CATEGORY_NAME_MAX_LENGTH) {
    ctx.status = 400
    ctx.body = { error: `Category name must be ${SESSION_CATEGORY_NAME_MAX_LENGTH} characters or fewer` }
    return
  }
  ctx.body = { category: createSessionCategory(name) }
}

export async function renameCategory(ctx: any) {
  const categoryId = Number(ctx.params.id)
  if (!Number.isSafeInteger(categoryId) || categoryId <= 0 || !getSessionCategory(categoryId)) {
    ctx.status = 404
    ctx.body = { error: 'Category not found' }
    return
  }
  const body = ctx.request.body as { name?: string }
  const name = normalizeSessionCategoryName(body?.name)
  if (!name) {
    ctx.status = 400
    ctx.body = { error: 'Category name is required' }
    return
  }
  if (name.length > SESSION_CATEGORY_NAME_MAX_LENGTH) {
    ctx.status = 400
    ctx.body = { error: `Category name must be ${SESSION_CATEGORY_NAME_MAX_LENGTH} characters or fewer` }
    return
  }
  const duplicate = findSessionCategoryByName(name)
  if (duplicate && duplicate.id !== categoryId) {
    ctx.status = 409
    ctx.body = { error: 'A category with this name already exists' }
    return
  }
  const category = renameSessionCategory(categoryId, name)
  if (!category) {
    ctx.status = 404
    ctx.body = { error: 'Category not found' }
    return
  }
  ctx.body = { category }
}

export async function removeCategory(ctx: any) {
  const categoryId = Number(ctx.params.id)
  if (!Number.isSafeInteger(categoryId) || categoryId <= 0 || !getSessionCategory(categoryId)) {
    ctx.status = 404
    ctx.body = { error: 'Category not found' }
    return
  }
  if (!deleteSessionCategory(categoryId)) {
    ctx.status = 404
    ctx.body = { error: 'Category not found' }
    return
  }
  ctx.body = { ok: true }
}

export async function count(ctx: any) {
  const source = (ctx.query.source as string) || undefined
  const profile = explicitProfileFilter(ctx)
  const allSessions = localListSessions(profile, source, 2147483647)
  const knownProfiles = profile ? null : new Set(listProfileNamesFromDisk())
  const sessions = filterPendingDeletedSessions(filterArchivedSessions(filterByAllowedProfiles(ctx, allSessions).filter(s =>
    isRequestedSessionSource(source, s.source) &&
    (!knownProfiles || knownProfiles.has(s.profile || 'default')),
  )))
  ctx.body = { count: sessions.length }
}

/**
 * List Hermes History sessions, including Web UI/API Server sessions.
 * GET /api/studio/sessions/hermes?source=&limit=
 */
export async function listHermesSessions(ctx: any) {
  const source = (ctx.query.source as string) || undefined
  const limit = ctx.query.limit ? parseInt(ctx.query.limit as string, 10) : undefined
  const offset = ctx.query.offset ? parseInt(ctx.query.offset as string, 10) : 0
  const profile = requestedProfile(ctx)
  const effectiveLimit = limit && limit > 0 ? limit : 2000
  const normalizedOffset = Number.isFinite(offset) && offset > 0 ? offset : 0
  const paginated = Boolean(source) || normalizedOffset > 0
  const candidateLimit = paginated ? normalizedOffset + effectiveLimit + 1 : effectiveLimit
  const localSessions = localListSessions(profile, source, candidateLimit)
  const allSessions = isHermesAgentAvailable()
    ? await listHermesSessionSummaries(source, candidateLimit, profile)
    : []
  const merged = mergeHermesHistorySessions(ctx, profile, allSessions, localSessions, source)

  if (paginated) {
    const sorted = [...merged].sort(compareSessionsNewestFirst)
    const sessions = sorted.slice(normalizedOffset, normalizedOffset + effectiveLimit)
    ctx.body = {
      sessions,
      hasMore: sorted.length > normalizedOffset + sessions.length,
      offset: normalizedOffset,
      limit: effectiveLimit,
    }
    return
  }

  ctx.body = {
    sessions: merged,
  }
}

/**
 * List the first page of each Hermes History source group.
 * GET /api/studio/sessions/hermes/groups?limit=&include=&profile=
 */
export async function listHermesSessionGroups(ctx: any) {
  const requestedLimit = ctx.query.limit ? parseInt(ctx.query.limit as string, 10) : 20
  const limit = Number.isFinite(requestedLimit) ? Math.min(100, Math.max(1, requestedLimit)) : 20
  const profile = requestedProfile(ctx)
  const rawIncluded = ctx.query.include
  const includedIds = (Array.isArray(rawIncluded) ? rawIncluded : rawIncluded ? [rawIncluded] : [])
    .map(value => String(value || '').trim())
    .filter(Boolean)
    .slice(0, 100)

  const localSessions = localListSessions(profile, undefined, 2000)
  const hermesResult = isHermesAgentAvailable()
    ? await listHermesSessionSummaryGroups(limit, profile, includedIds)
    : { groups: [], included: [] }
  const hermesGroups = new Map<string, { source: string; sessions: any[]; hasMore: boolean }>(
    hermesResult.groups.map((group: any) => [group.source, group]),
  )
  const sources = new Set<string>([
    ...hermesGroups.keys(),
    ...localSessions
      .map(session => session.source)
      .filter((source): source is string => Boolean(source)),
  ])
  const groups: Array<{ source: string; sessions: any[]; hasMore: boolean }> = []

  for (const source of sources) {
    const hermesGroup = hermesGroups.get(source)
    const localSourceSessions = localSessions.filter(session => session.source === source)
    const merged = mergeHermesHistorySessions(
      ctx,
      profile,
      hermesGroup?.sessions || [],
      localSourceSessions,
      source,
    ).sort(compareSessionsNewestFirst)
    const sessions = merged.slice(0, limit)
    if (sessions.length === 0) continue
    groups.push({
      source,
      sessions,
      hasMore: Boolean(hermesGroup?.hasMore) || merged.length > sessions.length,
    })
  }

  const localIncluded = localSessions.filter(session => session.is_pinned || includedIds.includes(session.id))
  const included = mergeHermesHistorySessions(ctx, profile, hermesResult.included, localIncluded)
  ctx.body = { groups, included }
}

export async function search(ctx: any) {
  const q = typeof ctx.query.q === 'string' ? ctx.query.q : ''
  const source = (ctx.query.source as string) || undefined
  const limit = ctx.query.limit ? parseInt(ctx.query.limit as string, 10) : undefined
  const profile = explicitProfileFilter(ctx)
  const allowedProfiles = allowedProfileSet(ctx)
  if (profile && allowedProfiles && !allowedProfiles.has(profile)) {
    ctx.body = { results: [] }
    return
  }
  const searchableProfiles = profile
    ? undefined
    : listProfileNamesFromDisk().filter(name => !allowedProfiles || allowedProfiles.has(name))
  const pendingDeletedIds = [...getPendingDeletedSessionIds()]
  const results = localSearchSessions(profile, q, limit && limit > 0 ? limit : 20, {
    sources: requestedSessionSources(source),
    profiles: searchableProfiles,
    includeArchived: false,
    excludeSessionIds: pendingDeletedIds,
  })
  const knownProfiles = profile ? null : new Set(searchableProfiles)
  ctx.body = {
    results: filterPendingDeletedSessions(filterArchivedSessions(filterByAllowedProfiles(ctx, results).filter(s =>
      isRequestedSessionSource(source, s.source) &&
      (!knownProfiles || knownProfiles.has(s.profile || 'default')),
    ))),
  }
}

export async function get(ctx: any) {
  const session = localGetSessionDetail(ctx.params.id)
  if (!session) {
    ctx.status = 404
    ctx.body = { error: 'Session not found' }
    return
  }
  if (denySessionAccess(ctx, session)) return
  if (ctx.state?.sessionShare) {
    delete session.parent_title; delete session.parent_last_message; delete session.parent_last_message_role
  }
  ctx.body = { session }
}

export async function listWorkspaceRunChanges(ctx: any) {
  const session = localGetSession(ctx.params.id)
  if (!session) {
    ctx.status = 404
    ctx.body = { error: 'Session not found' }
    return
  }
  if (denySessionAccess(ctx, session)) return
  ctx.body = { changes: listWorkspaceRunChangesForSession(ctx.params.id) }
}

export async function getWorkspaceRunChangeFile(ctx: any) {
  const session = localGetSession(ctx.params.id)
  if (!session) {
    ctx.status = 404
    ctx.body = { error: 'Session not found' }
    return
  }
  if (denySessionAccess(ctx, session)) return
  const fileId = Number.parseInt(String(ctx.params.fileId || ''), 10)
  if (!Number.isFinite(fileId) || fileId <= 0) {
    ctx.status = 400
    ctx.body = { error: 'Invalid file id' }
    return
  }
  const file = getWorkspaceRunChangeFileFromDb(ctx.params.id, ctx.params.changeId, fileId)
  if (!file) {
    ctx.status = 404
    ctx.body = { error: 'Workspace change file not found' }
    return
  }
  if (ctx.state?.sessionShare) {
    const access = ctx.state.sessionShare
    const change = listWorkspaceRunChangesForSession(ctx.params.id).find(item => item.change_id === ctx.params.changeId)
    if (!change || pathResolve(change.workspace) !== access.share.workspace_root) { ctx.status = 403; ctx.body = { error: 'share_workspace_changed' }; return }
    await sessionShareService.authorizePath(access.token, access.actor, 'workspaceRead', file.path)
    if (file.old_path) await sessionShareService.authorizePath(access.token, access.actor, 'workspaceRead', file.old_path)
  }
  ctx.body = { file }
}

function normalizeWorkspaceRelativePath(value: unknown, options: { allowEmpty?: boolean } = {}): string {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw && options.allowEmpty) return ''
  if (!raw) throw Object.assign(new Error('Missing path parameter'), { code: 'missing_path', status: 400 })
  return isAbsoluteWorkspacePath(raw) ? raw : pathNormalize(raw).replace(/\\/g, '/')
}

function sessionWorkspacePrefix(workspace: string, profile?: string | null): string {
  const profileDir = profile ? getProfileDir(profile) : getActiveProfileDir()
  return relativePathFromBase(workspace, profileDir) || ''
}

function normalizeSessionWorkspaceRelativePath(
  workspace: string,
  profile: string | null | undefined,
  value: unknown,
  options: { allowEmpty?: boolean } = {},
): string {
  const normalized = normalizeWorkspaceRelativePath(value, options)
  const prefix = sessionWorkspacePrefix(workspace, profile)
  if (!prefix) return normalized
  if (normalized === prefix) return ''
  return normalized.startsWith(`${prefix}/`) ? normalized.slice(prefix.length + 1) : normalized
}

async function resolveSessionWorkspacePath(
  ctx: any,
  relativePathValue: unknown,
  options: { allowEmpty?: boolean } = {},
): Promise<{ session: NonNullable<ReturnType<typeof localGetSession>>; relativePath: string; fullPath: string; workspace: string }> {
  const session = localGetSession(ctx.params.id)
  if (!session) throw Object.assign(new Error('Session not found'), { code: 'not_found', status: 404 })
  if (denySessionAccess(ctx, session)) throw Object.assign(new Error('Forbidden'), { code: 'forbidden', status: 403, handled: true })
  const workspace = String(session.workspace || '').trim()
  const shareAccess = ctx.state?.sessionShare
  if (shareAccess && typeof relativePathValue === 'string' && isAbsoluteWorkspacePath(relativePathValue)) {
    const fullPath = await authorizeShareFile(shareAccess, ctx.state.sessionShareFileAction || 'workspaceRead', relativePathValue)
    return { session, workspace, relativePath: relativePathValue, fullPath }
  }
  if (!workspace) throw Object.assign(new Error('Session workspace not found'), { code: 'workspace_not_found', status: 404 })
  const path = normalizeSessionWorkspaceRelativePath(workspace, session.profile, relativePathValue, options)
  const resolved = await resolveWorkspacePath(workspace, path, {
    access: 'unrestricted',
    allowAbsolute: true,
    allowEmpty: options.allowEmpty,
    missingWorkspaceMessage: 'Session workspace not found',
  })
  if (shareAccess) await authorizeShareFile(shareAccess, ctx.state.sessionShareFileAction || 'workspaceRead', resolved.fullPath)
  return { session, ...resolved }
}

async function resolveSessionWorkspaceFile(ctx: any, relativePathValue: unknown) {
  return resolveSessionWorkspacePath(ctx, relativePathValue)
}

async function resolveSessionPreviewFile(ctx: any, pathValue: unknown) {
  return resolveSessionWorkspaceFile(ctx, pathValue)
}

function handleWorkspaceFileError(ctx: any, err: any): void {
  if (err?.handled) return
  const status = Number(err?.status || 0)
  ctx.status = status >= 400 ? status : err?.code === 'ENOENT' ? 404 : 500
  ctx.body = { error: err?.message || 'Failed to access workspace file', code: err?.code || 'workspace_file_error' }
}

export async function listWorkspaceFiles(ctx: any) {
  try {
    const { relativePath, fullPath, workspace } = await resolveSessionWorkspacePath(ctx, ctx.query.path, { allowEmpty: true })
    const info = await fsStat(fullPath)
    if (!info.isDirectory()) {
      ctx.status = 400
      ctx.body = { error: 'Not a directory', code: 'not_a_directory' }
      return
    }
    const entries = await readdir(fullPath, { withFileTypes: true })
    const visibleEntries = ctx.state?.sessionShare ? (await Promise.all(entries.map(async entry => {
      const access = ctx.state.sessionShare
      try {
        await sessionShareService.authorizePath(access.token, access.actor, 'workspaceRead', pathResolve(fullPath, entry.name))
        return entry
      } catch { return null }
    }))).filter((entry): entry is typeof entries[number] => entry !== null) : entries
    const mapped = await Promise.all(visibleEntries.map(async entry => {
      const entryFullPath = pathResolve(fullPath, entry.name)
      const stat = await fsStat(entryFullPath)
      return {
        name: entry.name,
        path: workspaceRelativePath(workspace, entryFullPath),
        absolutePath: entryFullPath,
        isDir: stat.isDirectory(),
        size: stat.size,
        modTime: stat.mtime.toISOString(),
      }
    }))
    mapped.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    const decorated = await decorateWorkspaceEntries(workspace, relativePath, mapped)
    ctx.body = {
      entries: decorated.entries,
      path: relativePath,
      absolutePath: fullPath,
      ...decorated.directoryDecoration,
    }
  } catch (err: any) {
    handleWorkspaceFileError(ctx, err)
  }
}

export async function readWorkspaceFile(ctx: any) {
  try {
    const { relativePath, fullPath } = await resolveSessionWorkspaceFile(ctx, ctx.query.path)
    const info = await fsStat(fullPath)
    if (!info.isFile()) {
      ctx.status = 400
      ctx.body = { error: 'Not a file', code: 'not_a_file' }
      return
    }
    if (info.size > MAX_EDIT_SIZE) {
      ctx.status = 413
      ctx.body = { error: 'File too large to edit', code: 'file_too_large' }
      return
    }
    const data = await readFile(fullPath)
    ctx.body = { content: data.toString('utf-8'), path: relativePath, size: data.length }
  } catch (err: any) {
    handleWorkspaceFileError(ctx, err)
  }
}

export async function diffWorkspaceFile(ctx: any) {
  try {
    const { relativePath, fullPath, workspace } = await resolveSessionWorkspaceFile(ctx, ctx.query.path)
    const info = await fsStat(fullPath)
    if (!info.isFile()) {
      ctx.status = 400
      ctx.body = { error: 'Not a file', code: 'not_a_file' }
      return
    }
    ctx.body = await getWorkspaceFileGitDiff(workspace, relativePath)
  } catch (err: any) {
    handleWorkspaceFileError(ctx, err)
  }
}

export async function readWorkspaceFileContent(ctx: any) {
  try {
    const { relativePath, fullPath } = await resolveSessionPreviewFile(ctx, ctx.query.path)
    const info = await fsStat(fullPath)
    if (!info.isFile()) {
      ctx.status = 400
      ctx.body = { error: 'Not a file', code: 'not_a_file' }
      return
    }

    const download = String(ctx.query?.download || '') === '1'
    const textPreview = String(ctx.query?.text || '') === '1'
    const descriptor = getFilePreviewDescriptor(relativePath)
    if (!download && !textPreview && !descriptor) {
      ctx.status = 415
      ctx.body = { error: 'File type is not supported for preview', code: 'unsupported_preview' }
      return
    }
    const maxBytes = download ? MAX_DOWNLOAD_SIZE : textPreview ? MAX_EDIT_SIZE : descriptor!.maxBytes
    if (info.size > maxBytes) {
      ctx.status = 413
      ctx.body = {
        error: download ? 'File too large to download' : 'File too large to preview',
        code: 'file_too_large',
      }
      return
    }

    const data = await readFile(fullPath)
    if (data.length > maxBytes) {
      ctx.status = 413
      ctx.body = {
        error: download ? 'File too large to download' : 'File too large to preview',
        code: 'file_too_large',
      }
      return
    }
    const headers = buildFileContentHeaders({
      fileName: relativePath,
      mime: textPreview ? 'text/plain; charset=utf-8' : descriptor?.mime || 'application/octet-stream',
      size: data.length,
      download,
    })
    for (const [name, value] of Object.entries(headers)) ctx.set(name, value)
    ctx.body = data
  } catch (err: any) {
    handleWorkspaceFileError(ctx, err)
  }
}

export async function writeWorkspaceFile(ctx: any) {
  const body = ctx.request.body as { path?: unknown; content?: unknown }
  try {
    const { relativePath, fullPath } = await resolveSessionWorkspaceFile(ctx, body?.path)
    if (isSensitivePath(relativePath)) {
      ctx.status = 403
      ctx.body = { error: 'Cannot modify sensitive file', code: 'permission_denied' }
      return
    }
    const content = typeof body?.content === 'string' ? body.content : ''
    const data = Buffer.from(content, 'utf-8')
    if (data.length > MAX_EDIT_SIZE) {
      ctx.status = 413
      ctx.body = { error: 'Content too large', code: 'file_too_large' }
      return
    }
    await writeFile(fullPath, data)
    ctx.body = { ok: true, path: relativePath }
  } catch (err: any) {
    handleWorkspaceFileError(ctx, err)
  }
}

export async function mkdirWorkspaceFile(ctx: any) {
  const body = ctx.request.body as { path?: unknown }
  try {
    const { fullPath } = await resolveSessionWorkspaceFile(ctx, body?.path)
    await mkdir(fullPath, { recursive: true })
    ctx.body = { ok: true }
  } catch (err: any) {
    handleWorkspaceFileError(ctx, err)
  }
}

export async function deleteWorkspaceFile(ctx: any) {
  const body = ctx.request.body as { path?: unknown; recursive?: unknown }
  try {
    const { relativePath, fullPath } = await resolveSessionWorkspaceFile(ctx, body?.path)
    if (isSensitivePath(relativePath)) {
      ctx.status = 403
      ctx.body = { error: 'Cannot delete sensitive file', code: 'permission_denied' }
      return
    }
    const info = await fsStat(fullPath)
    if (info.isDirectory()) {
      await fsRm(fullPath, { recursive: Boolean(body?.recursive), force: false })
    } else {
      await fsRm(fullPath)
    }
    ctx.body = { ok: true }
  } catch (err: any) {
    handleWorkspaceFileError(ctx, err)
  }
}

export async function renameWorkspaceFile(ctx: any) {
  const body = ctx.request.body as { oldPath?: unknown; newPath?: unknown }
  try {
    const oldTarget = await resolveSessionWorkspaceFile(ctx, body?.oldPath)
    const newTarget = await resolveSessionWorkspaceFile(ctx, body?.newPath)
    if (isSensitivePath(oldTarget.relativePath) || isSensitivePath(newTarget.relativePath)) {
      ctx.status = 403
      ctx.body = { error: 'Cannot rename sensitive file', code: 'permission_denied' }
      return
    }
    await fsRename(oldTarget.fullPath, newTarget.fullPath)
    ctx.body = { ok: true }
  } catch (err: any) {
    handleWorkspaceFileError(ctx, err)
  }
}

export async function copyWorkspaceFile(ctx: any) {
  const body = ctx.request.body as { srcPath?: unknown; destPath?: unknown }
  try {
    const srcTarget = await resolveSessionWorkspaceFile(ctx, body?.srcPath)
    const destTarget = await resolveSessionWorkspaceFile(ctx, body?.destPath)
    if (isSensitivePath(destTarget.relativePath)) {
      ctx.status = 403
      ctx.body = { error: 'Cannot overwrite sensitive file', code: 'permission_denied' }
      return
    }
    const info = await fsStat(srcTarget.fullPath)
    if (!info.isFile()) {
      ctx.status = 400
      ctx.body = { error: 'Not a file', code: 'not_a_file' }
      return
    }
    await copyFile(srcTarget.fullPath, destTarget.fullPath)
    ctx.body = { ok: true }
  } catch (err: any) {
    handleWorkspaceFileError(ctx, err)
  }
}

function cleanSessionContextMessages(messages: any[]): Array<{
  id: number
  role: 'user' | 'assistant'
  content: string
  timestamp: number
  reasoning?: string | null
  reasoning_content?: string | null
}> {
  return messages
    .filter(message => message?.role === 'user' || message?.role === 'assistant')
    .map(message => {
      const content = typeof message.content === 'string'
        ? message.content
        : message.content == null ? '' : String(message.content)
      return {
        id: Number(message.id || 0),
        role: message.role,
        content,
        timestamp: Number(message.timestamp || 0),
        ...(message.reasoning != null ? { reasoning: message.reasoning } : {}),
        ...(message.reasoning_content != null ? { reasoning_content: message.reasoning_content } : {}),
      }
    })
    .filter(message => {
      if (message.role === 'user') return true
      return message.content.trim() || message.reasoning || message.reasoning_content
    })
}

export async function getContext(ctx: any) {
  const session = localGetSessionDetail(ctx.params.id)
  if (!session) {
    ctx.status = 404
    ctx.body = { error: 'Session not found' }
    return
  }
  if (denySessionAccess(ctx, session)) return

  const messages = cleanSessionContextMessages(session.messages || [])
  ctx.body = {
    session_id: session.id,
    profile: session.profile || null,
    source: session.source,
    title: session.title || null,
    messages,
    message_count: messages.length,
  }
}

/**
 * Get Hermes History session detail, including Web UI/API Server sessions.
 * GET /api/studio/sessions/hermes/:id
 */
export async function getHermesSession(ctx: any) {
  const profile = requestedProfile(ctx)

  // Prefer the Web UI local session store. Hermes state.db can lag behind or
  // miss messages for Bridge-backed runs, while the local store is the source
  // used by chat rendering and compression.
  let localSession = localGetSessionDetail(ctx.params.id)
  const localSessionProfile = (localSession?.profile || 'default') as string
  if (localSession && isHermesHistorySessionSource(localSession.source) && (!profile || localSessionProfile === profile)) {
    if (denySessionAccess(ctx, localSession)) return
    if (isHermesAgentAvailable()) {
      await reconcileLocalHermesHistory(ctx.params.id, profile || localSessionProfile)
      localSession = localGetSessionDetail(ctx.params.id) || localSession
    }
    ctx.body = { session: localSession }
    return
  }

  if (!isHermesAgentAvailable()) {
    ctx.status = 404
    ctx.body = { error: 'Session not found' }
    return
  }

  // Try Hermes state.db next (consistent with listHermesSessions)
  try {
    const session = profile
      ? await getHermesSessionDetailForProfile(ctx.params.id, profile)
      : await getHermesSessionDetail(ctx.params.id)
    if (session && isHermesHistorySessionSource(session.source)) {
      const matchingLocalSession = localSession && (!profile || localSessionProfile === profile)
        ? localSession
        : null
      const sessionWithProfile = {
        ...session,
        ...(profile ? { profile } : {}),
        push_enabled: Number(matchingLocalSession?.push_enabled || 0) !== 0 ? 1 : 0,
      }
      if (denySessionAccess(ctx, sessionWithProfile)) return
      ctx.body = { session: sessionWithProfile }
      return
    }
  } catch (err) {
    logger.warn(err, 'Hermes Session DB: detail query failed, falling back to CLI')
  }

  // Fallback to CLI only while a usable Hermes installation is selected.
  const session = await getHermesCliSession(ctx.params.id)
  if (!session) {
    ctx.status = 404
    ctx.body = { error: 'Session not found' }
    return
  }
  // Filter out Web UI-only session sources.
  if (!isHermesHistorySessionSource(session.source)) {
    ctx.status = 404
    ctx.body = { error: 'Session not found' }
    return
  }
  if (denySessionAccess(ctx, session)) return
  ctx.body = { session: { ...session, push_enabled: 0 } }
}

export async function importHermesSession(ctx: any) {
  const sessionId = ctx.params.id
  const profile = requestedProfile(ctx) || getActiveProfileName()
  if (!canAccessProfile(ctx, profile)) {
    ctx.status = 403
    ctx.body = { error: `Profile "${profile || 'default'}" is not available for this user` }
    return
  }

  const existing = localGetSessionDetail(sessionId)
  if (existing) {
    if (denySessionAccess(ctx, existing)) return
    if (isHermesAgentAvailable()) await reconcileLocalHermesHistory(sessionId, profile)
    ctx.body = { ok: true, imported: false, session: localGetSessionDetail(sessionId) || existing }
    return
  }

  if (!isHermesAgentAvailable()) {
    ctx.status = 404
    ctx.body = { error: 'Session not found' }
    return
  }

  let detail
  try {
    detail = await getHermesSessionDetailForProfile(sessionId, profile)
  } catch (err) {
    logger.warn({ err, sessionId, profile }, 'Hermes Session: import query failed')
    ctx.status = 500
    ctx.body = { error: 'Failed to read Hermes session' }
    return
  }

  if (!detail || detail.source === 'api_server') {
    ctx.status = 404
    ctx.body = { error: 'Session not found' }
    return
  }

  const profileDefault = await getProfileDefaultModel(profile)
  const importTimestamp = Math.floor(Date.now() / 1000)

  localCreateSession({
    id: detail.id,
    profile,
    source: 'cli',
    model: profileDefault.model,
    provider: profileDefault.provider,
    title: detail.title || undefined,
  })

  localUpdateSession(detail.id, {
    source: 'cli',
    user_id: detail.user_id,
    model: profileDefault.model,
    provider: profileDefault.provider,
    title: detail.title,
    started_at: detail.started_at,
    ended_at: detail.ended_at,
    end_reason: detail.end_reason,
    message_count: detail.message_count,
    tool_call_count: detail.tool_call_count,
    input_tokens: detail.input_tokens,
    output_tokens: detail.output_tokens,
    cache_read_tokens: detail.cache_read_tokens,
    cache_write_tokens: detail.cache_write_tokens,
    reasoning_tokens: detail.reasoning_tokens,
    billing_provider: detail.billing_provider,
    estimated_cost_usd: detail.estimated_cost_usd,
    actual_cost_usd: detail.actual_cost_usd,
    cost_status: detail.cost_status,
    preview: detail.preview,
    last_active: importTimestamp,
  })

  const importMessages = buildImportMessages(detail.id, Array.isArray(detail.messages) ? detail.messages : [])
  localAddMessages(importMessages)
  localUpdateSessionStats(detail.id)
  localUpdateSession(detail.id, {
    tool_call_count: detail.tool_call_count,
    input_tokens: detail.input_tokens,
    output_tokens: detail.output_tokens,
    cache_read_tokens: detail.cache_read_tokens,
    cache_write_tokens: detail.cache_write_tokens,
    reasoning_tokens: detail.reasoning_tokens,
    billing_provider: detail.billing_provider,
    estimated_cost_usd: detail.estimated_cost_usd,
    actual_cost_usd: detail.actual_cost_usd,
    cost_status: detail.cost_status,
    last_active: importTimestamp,
    ended_at: detail.ended_at,
  })

  ctx.body = { ok: true, imported: true, session: localGetSessionDetail(detail.id) }
}

export async function remove(ctx: any) {
  const sessionId = ctx.params.id
  const existing = localGetSession(sessionId)
  if (denySessionAccess(ctx, existing)) return
  const hermesProfile = requestedProfile(ctx) || existing?.profile || getActiveProfileName()
  const codingAgentSession = isCodingAgentSession(existing)
  if (codingAgentSession) stopCodingAgentSessionRun(sessionId, { reportClosed: false })
  const hermes = codingAgentSession
    ? { attempted: false, deleted: false, profile: hermesProfile }
    : await deleteHermesSessionIfPresent(sessionId, hermesProfile)
  const localDeleted = existing ? localDeleteSession(sessionId) : true
  if (!localDeleted) {
    ctx.status = 500
    ctx.body = { error: 'Failed to delete session' }
    return
  }
  deleteWorkspaceRunChangesForSession(sessionId)
  ctx.body = { ok: true, deleted: Boolean(existing), hermes }
}

export async function batchRemove(ctx: any) {
  const { ids, sessions } = ctx.request.body as { ids?: string[]; sessions?: BatchDeleteTarget[] }
  const rawTargets = Array.isArray(sessions) && sessions.length > 0 ? sessions : ids
  if (!rawTargets || !Array.isArray(rawTargets) || rawTargets.length === 0) {
    ctx.status = 400
    ctx.body = { error: 'ids is required and must be a non-empty array' }
    return
  }

  const targets = rawTargets
    .map((target): BatchDeleteTarget | null => {
      if (typeof target === 'string') {
        const id = target.trim()
        return id ? { id } : null
      }
      if (!target || typeof target.id !== 'string') return null
      const id = target.id.trim()
      if (!id) return null
      const profile = typeof target.profile === 'string' && target.profile.trim()
        ? target.profile.trim()
        : undefined
      return { id, profile }
    })
    .filter((target): target is BatchDeleteTarget => Boolean(target))

  if (targets.length === 0) {
    ctx.status = 400
    ctx.body = { error: 'No valid session ids provided' }
    return
  }

  const results = {
    deleted: 0,
    failed: 0,
    hermesDeleted: 0,
    hermesFailed: 0,
    errors: [] as Array<{ id: string; error: string }>,
    hermesErrors: [] as Array<{ id: string; profile?: string; error: string }>
  }

  for (const target of targets) {
    const { id } = target
    const existing = localGetSession(id)
    const targetProfile = target.profile || existing?.profile
    if (targetProfile && !canAccessProfile(ctx, targetProfile)) {
      results.failed++
      results.errors.push({ id, error: `Profile "${targetProfile || 'default'}" is not available for this user` })
      continue
    }
    if (!targetProfile && existing && !canAccessProfile(ctx, existing.profile)) {
      results.failed++
      results.errors.push({ id, error: `Profile "${existing.profile || 'default'}" is not available for this user` })
      continue
    }

    const codingAgentSession = isCodingAgentSession(existing)
    if (codingAgentSession) stopCodingAgentSessionRun(id, { reportClosed: false })
    const hermes = codingAgentSession
      ? { attempted: false, deleted: false, profile: targetProfile || 'default' }
      : await deleteHermesSessionIfPresent(id, targetProfile)
    if (hermes.deleted) {
      results.hermesDeleted++
    } else if (hermes.attempted && hermes.error) {
      results.hermesFailed++
      results.hermesErrors.push({ id, profile: hermes.profile, error: hermes.error })
    }

    const shouldDeleteLocal = Boolean(existing && (!targetProfile || existing.profile === targetProfile))
    if (shouldDeleteLocal) {
      const ok = localDeleteSession(id)
      if (ok) {
        deleteWorkspaceRunChangesForSession(id)
        results.deleted++
      } else {
        results.failed++
        results.errors.push({ id, error: 'Failed to delete session' })
      }
    } else if (hermes.deleted) {
      results.deleted++
    } else {
      results.failed++
      results.errors.push({ id, error: 'Session not found' })
    }
  }

  ctx.body = { ...results, ok: true }
}

export async function usageBatch(ctx: any) {
  const ids = (ctx.query.ids as string)
  if (!ids) {
    ctx.body = {}
    return
  }
  const idList = ids.split(',').filter(Boolean)
  ctx.body = getUsageBatch(idList)
}

export async function usageSingle(ctx: any) {
  const session = localGetSession(ctx.params.id)
  if (denySessionAccess(ctx, session)) return
  const result = getUsage(ctx.params.id)
  if (!result) {
    ctx.body = { input_tokens: 0, output_tokens: 0 }
    return
  }
  ctx.body = result
}

export async function rename(ctx: any) {
  const { title } = ctx.request.body as { title?: string }
  if (!title || typeof title !== 'string') {
    ctx.status = 400
    ctx.body = { error: 'title is required' }
    return
  }
  const existing = localGetSession(ctx.params.id)
  if (denySessionAccess(ctx, existing)) return
  const ok = localRenameSession(ctx.params.id, title.trim())
  if (!ok) {
    ctx.status = 500
    ctx.body = { error: 'Failed to rename session' }
    return
  }
  ctx.body = { ok: true }
}

export async function archive(ctx: any) {
  const existing = localGetSession(ctx.params.id)
  if (!existing) {
    ctx.status = 404
    ctx.body = { error: 'Session not found' }
    return
  }
  if (denySessionAccess(ctx, existing)) return
  if (existing.source === 'global_agent') {
    ctx.status = 400
    ctx.body = { error: 'Global agent sessions cannot be archived' }
    return
  }
  const ok = localSetSessionArchived(ctx.params.id, true)
  if (!ok) {
    ctx.status = 500
    ctx.body = { error: 'Failed to archive session' }
    return
  }
  ctx.body = { ok: true }
}

export async function unarchive(ctx: any) {
  const existing = localGetSession(ctx.params.id)
  if (!existing) {
    ctx.status = 404
    ctx.body = { error: 'Session not found' }
    return
  }
  if (denySessionAccess(ctx, existing)) return
  const ok = localSetSessionArchived(ctx.params.id, false)
  if (!ok) {
    ctx.status = 500
    ctx.body = { error: 'Failed to unarchive session' }
    return
  }
  ctx.body = { ok: true }
}

export async function setPinned(ctx: any) {
  const existing = localGetSession(ctx.params.id)
  if (!existing) {
    ctx.status = 404
    ctx.body = { error: 'Session not found' }
    return
  }
  if (denySessionAccess(ctx, existing)) return
  const { is_pinned } = ctx.request.body || {}
  if (typeof is_pinned !== 'boolean') {
    ctx.status = 400
    ctx.body = { error: 'is_pinned must be a boolean' }
    return
  }
  if (!localSetSessionPinned(ctx.params.id, is_pinned)) {
    ctx.status = 500
    ctx.body = { error: 'Failed to update session pin' }
    return
  }
  ctx.body = { ok: true, is_pinned }
}

export async function setPushEnabled(ctx: any) {
  const existing = localGetSession(ctx.params.id)
  if (!existing) {
    ctx.status = 404
    ctx.body = { error: 'Session not found' }
    return
  }
  if (denySessionAccess(ctx, existing)) return

  const body = (ctx.request.body || {}) as { pushEnabled?: unknown; push_enabled?: unknown }
  const rawEnabled = body.pushEnabled ?? body.push_enabled
  if (typeof rawEnabled !== 'boolean') {
    ctx.status = 400
    ctx.body = { error: 'pushEnabled must be a boolean' }
    return
  }
  if (!localSetSessionPushEnabled(ctx.params.id, rawEnabled)) {
    ctx.status = 500
    ctx.body = { error: 'Failed to update session push setting' }
    return
  }
  if (!rawEnabled) {
    ensureBusinessConsumers()
    businessEvents.publish({ schema_version: 1, id: `push-disabled:${ctx.params.id}:${Date.now()}`,
      type: 'chat.push.disabled', source: 'chat', profile: existing.profile || 'default',
      occurred_at: new Date().toISOString(), subject: { session_id: ctx.params.id }, payload: {} })
  }
  getChatRunServer()?.emitSessionSettingsUpdated(ctx.params.id, {
    push_enabled: rawEnabled,
  })
  ctx.body = { ok: true, push_enabled: rawEnabled }
}

export async function setWorkspace(ctx: any) {
  const { workspace } = ctx.request.body as { workspace?: string }
  if (workspace !== undefined && workspace !== null && typeof workspace !== 'string') {
    ctx.status = 400
    ctx.body = { error: 'workspace must be a string or null' }
    return
  }
  const { updateSession, getSession, createSession } = await import('../public/sessions')
  const id = ctx.params.id
  const existing = getSession(id)
  if (denySessionAccess(ctx, existing)) return
  if (ctx.state?.sessionShare) sessionShareService.authorizeWorkspaceSwitch(ctx.state.sessionShare.token, ctx.state.sessionShare.actor, workspace)
  if (!existing) {
    createSession({ id, profile: requestedProfile(ctx) || 'default', title: '' })
  }
  updateSession(id, { workspace: workspace || null } as any)
  ctx.body = { ok: true }
}

export async function setCategory(ctx: any) {
  const existing = localGetSession(ctx.params.id)
  if (!existing) {
    ctx.status = 404
    ctx.body = { error: 'Session not found' }
    return
  }
  if (denySessionAccess(ctx, existing)) return

  const body = (ctx.request.body || {}) as { categoryId?: number | null; category_id?: number | null }
  const rawCategoryId = body.categoryId ?? body.category_id
  let categoryId: number | null = null
  if (rawCategoryId !== null && rawCategoryId !== undefined) {
    categoryId = Number(rawCategoryId)
    if (!Number.isSafeInteger(categoryId) || categoryId <= 0) {
      ctx.status = 400
      ctx.body = { error: 'categoryId must be a positive integer or null' }
      return
    }
    if (!getSessionCategory(categoryId)) {
      ctx.status = 404
      ctx.body = { error: 'Category not found' }
      return
    }
  }

  if (!setSessionCategory(ctx.params.id, categoryId)) {
    ctx.status = 500
    ctx.body = { error: 'Failed to update session category' }
    return
  }
  ctx.body = { ok: true, category_id: categoryId }
}

type SessionProviderApiMode = 'chat_completions' | 'codex_responses' | 'anthropic_messages'
const SESSION_REASONING_EFFORTS = new Set(['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

function normalizeSessionApiMode(value: unknown): SessionProviderApiMode | undefined {
  const mode = typeof value === 'string' ? value.trim() : ''
  return mode === 'chat_completions' || mode === 'codex_responses' || mode === 'anthropic_messages'
    ? mode
    : undefined
}

export async function setModel(ctx: any) {
  const { model, provider, apiMode, api_mode } = ctx.request.body as { model?: string; provider?: string; apiMode?: SessionProviderApiMode; api_mode?: SessionProviderApiMode }
  if (!model || typeof model !== 'string') {
    ctx.status = 400
    ctx.body = { error: 'model is required' }
    return
  }
  if (provider !== undefined && provider !== null && typeof provider !== 'string') {
    ctx.status = 400
    ctx.body = { error: 'provider must be a string' }
    return
  }
  const { updateSession, getSession, createSession } = await import('../public/sessions')
  const id = ctx.params.id
  const existing = getSession(id)
  if (denySessionAccess(ctx, existing)) return
  const profile = existing?.profile || requestedProfile(ctx) || 'default'
  const cleanModel = model.trim()
  const cleanProvider = (provider || '').trim()
  const cleanApiMode = normalizeSessionApiMode(apiMode ?? api_mode)
  const codingAgentSession = isCodingAgentSession(existing)
  const workspace = !codingAgentSession
    ? await ensureHermesRunWorkspace(profile, existing?.workspace)
    : undefined
  if (!existing) {
    createSession({ id, profile, title: '', model: cleanModel, provider: cleanProvider, api_mode: cleanApiMode || '', reasoning_effort: '', workspace })
  }
  const updates: Record<string, string> = { model: cleanModel, provider: cleanProvider }
  // A model-only share grant must never overwrite a concurrent reasoning update.
  if (!ctx.state?.sessionShare) updates.reasoning_effort = ''
  if (cleanApiMode) updates.api_mode = cleanApiMode
  else if (codingAgentSession && existing && existing.provider !== cleanProvider) updates.api_mode = ''
  if (!codingAgentSession && existing && !existing.workspace && workspace) updates.workspace = workspace
  if (
    codingAgentSession &&
    existing &&
    (existing.model !== cleanModel || existing.provider !== cleanProvider || (cleanApiMode && existing.api_mode !== cleanApiMode))
  ) {
    updates.agent_native_session_id = ''
  }
  if (ctx.state?.sessionShare) authorizeSessionShare(ctx.state.sessionShare, 'switchModel', id)
  updateSession(id, updates as any)
  getChatRunServer()?.emitSessionSettingsUpdated(id, {
    model: cleanModel,
    provider: cleanProvider,
    api_mode: updates.api_mode ?? existing?.api_mode ?? '',
    reasoning_effort: updates.reasoning_effort ?? getSession(id)?.reasoning_effort ?? '',
  })
  if (!codingAgentSession) {
    await notifyBridgeSessionModelChanged(id, cleanModel, cleanProvider, profile)
  }
  ctx.body = { ok: true }
}

export async function setReasoningEffort(ctx: any) {
  const id = ctx.params.id
  const existing = localGetSession(id)
  if (!existing) {
    ctx.status = 404
    ctx.body = { error: 'Session not found' }
    return
  }
  if (denySessionAccess(ctx, existing)) return

  const body = (ctx.request.body || {}) as { reasoningEffort?: unknown; reasoning_effort?: unknown }
  const rawEffort = body.reasoningEffort ?? body.reasoning_effort
  if (typeof rawEffort !== 'string') {
    ctx.status = 400
    ctx.body = { error: 'reasoningEffort must be a string' }
    return
  }
  const reasoningEffort = rawEffort.trim()
  if (!SESSION_REASONING_EFFORTS.has(reasoningEffort)) {
    ctx.status = 400
    ctx.body = { error: 'Invalid reasoningEffort' }
    return
  }

  localUpdateSession(id, { reasoning_effort: reasoningEffort })
  if (existing.agent === 'grok') invalidateCodingAgentSessionRuntime(id)
  getChatRunServer()?.emitSessionSettingsUpdated(id, {
    reasoning_effort: reasoningEffort,
  })
  ctx.body = { ok: true, reasoning_effort: reasoningEffort }
}

export async function contextLength(ctx: any) {
  const profile = requestedProfile(ctx)
  const model = typeof ctx.query.model === 'string' ? ctx.query.model : undefined
  const provider = typeof ctx.query.provider === 'string' ? ctx.query.provider : undefined
  ctx.body = { context_length: getHermesModelContextLength({ profile, model, provider }) }
}

export async function usageStats(ctx: any) {
  const rawDays = parseInt(String(ctx.query?.days ?? '30'), 10)
  const days = Number.isFinite(rawDays) && rawDays > 0 ? Math.min(rawDays, 365) : 30
  const profile = requestedProfile(ctx) || getActiveProfileName()

  const local = getLocalUsageStats(profile, days)
  const localSessionIds = getRecordedUsageSessionIds(profile)

  let hermes = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    sessions: 0,
    by_model: [] as UsageStatsModelRow[],
    by_agent: [] as UsageStatsAgentRow[],
    by_day: [] as UsageStatsDailyRow[],
    cost: 0,
    total_api_calls: 0,
  }

  try {
    hermes = await getHermesUsageStats(days, undefined, profile, localSessionIds)
  } catch (err) {
    logger.warn(err, 'usageStats: failed to load Hermes usage analytics from state.db')
  }

  const modelMap = new Map<string, UsageStatsModelRow>()
  for (const row of [...local.by_model, ...hermes.by_model]) {
    const model = row.model.trim()
    const current = modelMap.get(model) || {
      model,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      sessions: 0,
    }
    current.input_tokens += row.input_tokens
    current.output_tokens += row.output_tokens
    current.cache_read_tokens += row.cache_read_tokens
    current.cache_write_tokens += row.cache_write_tokens
    current.reasoning_tokens += row.reasoning_tokens
    current.sessions += row.sessions
    modelMap.set(model, current)
  }

  const agentMap = new Map<string, UsageStatsAgentRow>()
  for (const row of [...(local.by_agent || []), ...(hermes.by_agent || [])]) {
    const agent = row.agent.trim() || 'hermes'
    const current = agentMap.get(agent) || {
      agent,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      sessions: 0,
    }
    current.input_tokens += row.input_tokens
    current.output_tokens += row.output_tokens
    current.cache_read_tokens += row.cache_read_tokens
    current.cache_write_tokens += row.cache_write_tokens
    current.reasoning_tokens += row.reasoning_tokens
    current.sessions += row.sessions
    agentMap.set(agent, current)
  }

  const dayMap = new Map<string, UsageStatsDailyRow>()
  const now = new Date()
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now)
    d.setDate(d.getDate() - i)
    const key = d.toISOString().slice(0, 10)
    dayMap.set(key, { date: key, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, sessions: 0, errors: 0, cost: 0 })
  }
  for (const d of [...local.by_day, ...hermes.by_day]) {
    const existing = dayMap.get(d.date)
    if (existing) {
      existing.input_tokens += d.input_tokens; existing.output_tokens += d.output_tokens
      existing.cache_read_tokens += d.cache_read_tokens; existing.cache_write_tokens += d.cache_write_tokens
      existing.sessions += d.sessions; existing.errors += d.errors; existing.cost += d.cost
    }
  }

  ctx.body = {
    total_input_tokens: local.input_tokens + hermes.input_tokens,
    total_output_tokens: local.output_tokens + hermes.output_tokens,
    total_cache_read_tokens: local.cache_read_tokens + hermes.cache_read_tokens,
    total_cache_write_tokens: local.cache_write_tokens + hermes.cache_write_tokens,
    total_reasoning_tokens: local.reasoning_tokens + hermes.reasoning_tokens,
    total_sessions: local.sessions + hermes.sessions,
    total_cost: local.cost + hermes.cost,
    total_api_calls: local.total_api_calls + hermes.total_api_calls,
    period_days: days,
    model_usage: [...modelMap.values()].sort((a, b) => (b.input_tokens + b.output_tokens) - (a.input_tokens + a.output_tokens)),
    agent_usage: [...agentMap.values()].sort((a, b) => (b.input_tokens + b.output_tokens) - (a.input_tokens + a.output_tokens)),
    daily_usage: [...dayMap.values()],
  }
}

async function listWindowsWorkspaceDrives() {
  const { existsSync } = await import('fs')
  const drives = []
  for (let code = 65; code <= 90; code += 1) {
    const root = `${String.fromCharCode(code)}:\\`
    if (!existsSync(root)) continue
    drives.push({
      name: root,
      path: root,
      fullPath: root,
      readonly: true,
    })
  }
  return drives
}

async function isSafeWorkspaceFolderEntry(entry: any, fullPath: string, basePath: string, statFn: any, options?: { trustWindowsJunctions?: boolean }): Promise<boolean> {
  if (!entry.isDirectory() && !(typeof entry.isSymbolicLink === 'function' && entry.isSymbolicLink())) {
    return false
  }

  return isWorkspaceListPathAllowed(fullPath, basePath, statFn, options)
}

/**
 * List folders for the workspace folder picker.
 * GET /api/studio/workspace/folders?path=<path>
 *
 * By default this is rooted at the current user's home directory, or at
 * WORKSPACE_BASE when configured. On native Windows without WORKSPACE_BASE, the
 * picker can browse any available drive letter, while each request remains
 * constrained to the selected drive root.
 */
export async function listWorkspaceFolders(ctx: any) {
  const { resolve, join, win32 } = await import('path')
  const { readdir, stat } = await import('fs/promises')
  const { existsSync } = await import('fs')

  const subPath = (ctx.query.path as string) || ''
  if (useWindowsDriveWorkspaceMode()) {
    if (!subPath) {
      const drives = await listWindowsWorkspaceDrives()
      ctx.body = { base: '', current: '', roots: drives, folders: drives }
      return
    }

    const resolved = normalizeWindowsWorkspacePath(subPath)
    if (!resolved) {
      ctx.status = 403
      ctx.body = { error: 'Access denied' }
      return
    }

    if (!existsSync(resolved.fullPath)) {
      ctx.status = 404
      ctx.body = { error: 'Path not found', folders: [] }
      return
    }

    if (!await isWorkspaceListPathAllowed(resolved.fullPath, resolved.base, stat)) {
      ctx.status = 403
      ctx.body = { error: 'Access denied' }
      return
    }

    try {
      const entries = await readdir(resolved.fullPath, { withFileTypes: true })
      const folders = (await Promise.all(entries.map(async (entry) => {
        const fullPath = win32.join(resolved.fullPath, entry.name)
        if (!await isSafeWorkspaceFolderEntry(entry, fullPath, resolved.base, stat)) return null
        return {
          name: entry.name,
          path: fullPath,
          fullPath,
        }
      })))
        .filter((entry): entry is { name: string; path: string; fullPath: string } => !!entry)
        .sort((a, b) => a.name.localeCompare(b.name))

      ctx.body = { base: resolved.base, current: resolved.fullPath, folders }
    } catch (err: any) {
      ctx.status = 500
      ctx.body = { error: err.message }
    }
    return
  }

  const WORKSPACE_BASE = workspaceBaseDirectory()

  // Security: prevent path traversal
  const fullPath = resolve(join(WORKSPACE_BASE, subPath))
  if (!isPathWithin(fullPath, WORKSPACE_BASE)) {
    ctx.status = 403
    ctx.body = { error: 'Access denied' }
    return
  }

  if (!existsSync(fullPath)) {
    ctx.status = 404
    ctx.body = { error: 'Path not found', folders: [] }
    return
  }

  if (!await isWorkspaceListPathAllowed(fullPath, WORKSPACE_BASE, stat)) {
    ctx.status = 403
    ctx.body = { error: 'Access denied' }
    return
  }

  try {
    const entries = await readdir(fullPath, { withFileTypes: true })
    const folders = (await Promise.all(entries.map(async (entry) => {
      const entryFullPath = join(fullPath, entry.name)
      if (!await isSafeWorkspaceFolderEntry(entry, entryFullPath, WORKSPACE_BASE, stat)) return null
      return {
        name: entry.name,
        path: subPath ? `${subPath}/${entry.name}` : entry.name,
        fullPath: entryFullPath,
      }
    })))
      .filter((entry): entry is { name: string; path: string; fullPath: string } => !!entry)
      .sort((a, b) => a.name.localeCompare(b.name))

    ctx.body = { base: WORKSPACE_BASE, current: subPath, folders }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

function invalidWorkspaceFolderName(name: string): boolean {
  return !name ||
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    name.includes('\\') ||
    name.includes('\0')
}

async function resolveWorkspaceFolderPath(ctx: any, inputPath: string) {
  const { resolve, join } = await import('path')
  if (useWindowsDriveWorkspaceMode()) {
    const resolved = normalizeWindowsWorkspacePath(inputPath)
    if (!resolved) {
      ctx.status = 403
      ctx.body = { error: 'Access denied' }
      return null
    }
    return resolved
  }

  const WORKSPACE_BASE = workspaceBaseDirectory()
  const fullPath = resolve(join(WORKSPACE_BASE, inputPath || ''))
  if (!isPathWithin(fullPath, WORKSPACE_BASE)) {
    ctx.status = 403
    ctx.body = { error: 'Access denied' }
    return null
  }
  return { base: WORKSPACE_BASE, fullPath }
}

export async function createWorkspaceFolder(ctx: any) {
  const { join } = await import('path')
  const { mkdir } = await import('fs/promises')
  const { parentPath, name } = ctx.request.body as { parentPath?: string; name?: string }
  const folderName = String(name || '').trim()
  if (invalidWorkspaceFolderName(folderName)) {
    ctx.status = 400
    ctx.body = { error: 'Invalid folder name' }
    return
  }

  const resolvedParent = await resolveWorkspaceFolderPath(ctx, String(parentPath || ''))
  if (!resolvedParent) return
  const targetPath = join(resolvedParent.fullPath, folderName)
  if (!isPathWithin(targetPath, resolvedParent.base)) {
    ctx.status = 403
    ctx.body = { error: 'Access denied' }
    return
  }
  if (!await isNearestExistingRealPathWithin(targetPath, resolvedParent.base)) {
    ctx.status = 403
    ctx.body = { error: 'Access denied' }
    return
  }

  try {
    await mkdir(targetPath)
    ctx.body = { ok: true }
  } catch (err: any) {
    ctx.status = err?.code === 'EEXIST' ? 409 : 500
    ctx.body = { error: err.message || 'Failed to create folder' }
  }
}

export async function renameWorkspaceFolder(ctx: any) {
  const { dirname, join } = await import('path')
  const { rename, stat } = await import('fs/promises')
  const { path, name } = ctx.request.body as { path?: string; name?: string }
  const folderName = String(name || '').trim()
  const currentPath = String(path || '').trim()
  if (!currentPath) {
    ctx.status = 400
    ctx.body = { error: 'Path is required' }
    return
  }
  if (invalidWorkspaceFolderName(folderName)) {
    ctx.status = 400
    ctx.body = { error: 'Invalid folder name' }
    return
  }

  const resolvedCurrent = await resolveWorkspaceFolderPath(ctx, currentPath)
  if (!resolvedCurrent) return
  const parentPath = dirname(resolvedCurrent.fullPath)
  const targetPath = join(parentPath, folderName)
  if (!isPathWithin(targetPath, resolvedCurrent.base)) {
    ctx.status = 403
    ctx.body = { error: 'Access denied' }
    return
  }
  if (!await isNearestExistingRealPathWithin(resolvedCurrent.fullPath, resolvedCurrent.base) ||
    !await isNearestExistingRealPathWithin(targetPath, resolvedCurrent.base)) {
    ctx.status = 403
    ctx.body = { error: 'Access denied' }
    return
  }

  try {
    const info = await stat(resolvedCurrent.fullPath)
    if (!info.isDirectory()) {
      ctx.status = 400
      ctx.body = { error: 'Path is not a directory' }
      return
    }
    await fsRename(resolvedCurrent.fullPath, targetPath)
    ctx.body = { ok: true }
  } catch (err: any) {
    ctx.status = err?.code === 'EEXIST' ? 409 : err?.code === 'ENOENT' ? 404 : 500
    ctx.body = { error: err.message || 'Failed to rename folder' }
  }
}

export async function deleteWorkspaceFolder(ctx: any) {
  const { rm, stat } = await import('fs/promises')
  const { path } = ctx.request.body as { path?: string }
  const currentPath = String(path || '').trim()
  if (!currentPath) {
    ctx.status = 400
    ctx.body = { error: 'Path is required' }
    return
  }

  const resolvedCurrent = await resolveWorkspaceFolderPath(ctx, currentPath)
  if (!resolvedCurrent) return
  if (resolvedCurrent.fullPath === resolvedCurrent.base) {
    ctx.status = 400
    ctx.body = { error: 'Cannot delete workspace root' }
    return
  }
  if (!await isNearestExistingRealPathWithin(resolvedCurrent.fullPath, resolvedCurrent.base)) {
    ctx.status = 403
    ctx.body = { error: 'Access denied' }
    return
  }

  try {
    const info = await stat(resolvedCurrent.fullPath)
    if (!info.isDirectory()) {
      ctx.status = 400
      ctx.body = { error: 'Path is not a directory' }
      return
    }
    await fsRm(resolvedCurrent.fullPath, { recursive: true })
    ctx.body = { ok: true }
  } catch (err: any) {
    ctx.status = err?.code === 'ENOENT' ? 404 : 500
    ctx.body = { error: err.message || 'Failed to delete folder' }
  }
}

const exportCompressor = new ExportCompressor()

export async function exportSession(ctx: any) {
  const mode = (ctx.query.mode as string) || 'full'
  const session = mode === 'compressed'
    ? localGetSession(ctx.params.id)
    : localGetSessionDetail(ctx.params.id)

  if (!session) {
    ctx.status = 404
    ctx.body = { error: 'Session not found' }
    return
  }
  if (denySessionAccess(ctx, session)) return

  if (ctx.state?.sessionShare) {
    delete session.parent_title; delete session.parent_last_message; delete session.parent_last_message_role
    if (mode === 'compressed') {
      const access = ctx.state.sessionShare
      sessionShareService.authorize(access.token, access.actor, 'input', session.id)
    }
  }

  const ext = (ctx.query.ext as string) || (mode === 'compressed' ? 'txt' : 'json')
  const title = session.title || 'session'
  const safeName = title.replace(/[^a-zA-Z0-9一-鿿_-]/g, '_').slice(0, 50)
  const filename = `${safeName}_${ctx.params.id.slice(0, 8)}.${ext}`

  if (mode === 'compressed') {
    const result = await compressSession(session)
    if (ext === 'json') {
      ctx.set('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`)
      ctx.set('Content-Type', 'application/json')
      ctx.body = JSON.stringify({ id: session.id, title: session.title, ...result.meta, messages: result.messages }, null, 2)
    } else {
      ctx.set('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`)
      ctx.set('Content-Type', 'text/plain; charset=utf-8')
      ctx.body = serializeAsText(session.title, result.messages)
    }
  } else {
    if (ext === 'txt') {
      ctx.set('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`)
      ctx.set('Content-Type', 'text/plain; charset=utf-8')
      ctx.body = serializeAsText(session.title, (session as any).messages || [])
    } else {
      ctx.set('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`)
      ctx.set('Content-Type', 'application/json')
      ctx.body = JSON.stringify(session, null, 2)
    }
  }
}

async function compressSession(session: any) {
  const profile = session.profile || getActiveProfileName()
  const upstream = ''
  const apiKey = undefined
  const messages = buildDbExportHistory(session.id)

  return exportCompressor.compress(messages, upstream, apiKey, session.id, {
    profile,
    model: session.model,
    provider: session.provider,
  })
}

function serializeAsText(title: string | null, messages: any[]): string {
  const lines: string[] = [`# ${title || 'Untitled'}`, '']
  for (const msg of messages) {
    const role = msg.role || 'unknown'
    const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
    const ts = msg.timestamp ? new Date(msg.timestamp * 1000).toISOString() : ''
    lines.push(`[${role}]${ts ? ' ' + ts : ''}`)
    lines.push(content || '')
    lines.push('')
  }
  return lines.join('\n')
}

export async function getConversationMessagesPaginated(ctx: any) {
  const offset = ctx.query.offset ? parseInt(ctx.query.offset as string, 10) : 0
  const limit = ctx.query.limit ? parseInt(ctx.query.limit as string, 10) : 150
  const profile = requestedProfile(ctx)

  const { getSessionDetailPaginated } = await import('../public/sessions')
  const localDetail = localGetSessionDetail(ctx.params.id)
  const localProfile = String(localDetail?.profile || 'default')
  if (
    localDetail
    && isHermesHistorySessionSource(localDetail.source)
    && (!profile || profile === localProfile)
    && isHermesAgentAvailable()
  ) {
    if (denySessionAccess(ctx, localDetail)) return
    await reconcileLocalHermesHistory(ctx.params.id, profile || localProfile)
  }
  const localResult = getSessionDetailPaginated(ctx.params.id, offset, limit)
  const result = localResult && (!profile || localResult.session.profile === profile)
    ? localResult
    : isHermesAgentAvailable()
      ? await getHermesSessionDetailPaginatedForProfile(ctx.params.id, profile || 'default', offset, limit)
      : null

  if (!result) {
    ctx.status = 404
    ctx.body = { error: 'Conversation not found' }
    return
  }
  const session = { ...result.session, profile: (result.session as any).profile || profile || 'default' }
  if (denySessionAccess(ctx, session)) return
  const assistantMessageIds = result.messages
    .filter((message: any) => String(message.display_role || message.role || '') === 'assistant')
    .map((message: any) => message.id)

  ctx.body = {
    session: {
      id: session.id,
      profile: session.profile,
      source: session.source,
      model: session.model,
      agent: (session as any).agent,
      agent_mode: (session as any).agent_mode,
      coding_agent_id: (session as any).coding_agent_id,
      workspace: (session as any).workspace || null,
      title: session.title,
      parent_session_id: (session as any).parent_session_id,
      fork_point_message_id: (session as any).fork_point_message_id,
      parent_title: ctx.state?.sessionShare ? undefined : (session as any).parent_title,
      parent_last_message: ctx.state?.sessionShare ? undefined : (session as any).parent_last_message,
      parent_last_message_role: ctx.state?.sessionShare ? undefined : (session as any).parent_last_message_role,
      started_at: session.started_at,
      ended_at: session.ended_at,
      last_active: session.last_active,
      is_archived: (session as any).is_archived || 0,
      message_count: session.message_count,
      input_tokens: session.input_tokens,
      output_tokens: session.output_tokens,
    },
    messages: result.messages,
    taskPlans: getSessionTaskPlans(ctx.params.id, result.messages, offset === 0),
    workspaceRunChanges: listWorkspaceRunChangesForAssistantMessages(ctx.params.id, assistantMessageIds),
    total: result.total,
    offset: result.offset,
    limit: result.limit,
    hasMore: result.hasMore,
  }
}
