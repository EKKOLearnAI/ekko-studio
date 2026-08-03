import { request, getApiKey, getBaseUrlValue } from '../client'
import type { ProviderApiMode } from './provider-api-mode'
import { fetchAuthenticatedBlob, saveBlob } from './binary-content'

export interface SessionSummary {
  id: string
  profile?: string | null
  source: string
  agent?: string
  agent_mode?: 'global' | 'scoped' | string
  agent_session_id?: string
  agent_native_session_id?: string
  model: string
  provider?: string
  api_mode?: ProviderApiMode
  reasoning_effort?: string
  agent_preset?: string
  title: string | null
  parent_session_id?: string | null
  fork_point_message_id?: string | null
  parent_title?: string | null
  parent_last_message?: string | null
  parent_last_message_role?: string | null
  preview?: string
  started_at: number
  ended_at: number | null
  last_active?: number
  is_pinned?: number | boolean
  is_archived?: number | boolean
  push_enabled?: number | boolean
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
  workspace?: string | null
  category_id?: number | null
  webui_imported?: boolean
}

export interface SessionCategory {
  id: number
  name: string
  created_at: number
  updated_at: number
}

export interface SessionDetail extends SessionSummary {
  messages: HermesMessage[]
}

export interface SessionContextMessage {
  id: number
  role: 'user' | 'assistant'
  content: string
  timestamp: number
  reasoning?: string | null
  reasoning_content?: string | null
}

export interface SessionContext {
  session_id: string
  profile?: string | null
  source?: string
  title?: string | null
  messages: SessionContextMessage[]
  message_count: number
}

export interface PaginatedSessionMessages {
  session: SessionSummary
  messages: HermesMessage[]
  taskPlans?: import('@/utils/task-plan').TaskPlanSnapshot[]
  workspaceRunChanges: WorkspaceRunChangeSummary[]
  total: number
  offset: number
  limit: number
  hasMore: boolean
}

export interface SessionSearchResult extends SessionSummary {
  matched_message_id: number | null
  snippet: string
  rank: number
}

export interface HermesSessionGroupPage {
  source: string
  sessions: SessionSummary[]
  hasMore: boolean
}

export interface HermesSessionGroupsResult {
  groups: HermesSessionGroupPage[]
  included: SessionSummary[]
}

export interface HermesSessionPage {
  sessions: SessionSummary[]
  hasMore: boolean
  offset: number
  limit: number
}

export interface HermesMessage {
  id: number
  session_id: string
  role: 'user' | 'assistant' | 'system' | 'tool' | 'command' | 'moa'
  content: string
  display_role?: 'user' | 'assistant' | 'system' | 'tool' | 'command' | null
  display_content?: string | null
  tool_call_id: string | null
  tool_calls: any[] | null
  tool_name: string | null
  run_marker: string | null
  timestamp: number
  token_count: number | null
  finish_reason: string | null
  reasoning: string | null
  run_id?: string | null
  usage?: {
    input: number
    output: number
    cacheRead?: number
    cacheWrite?: number
    reasoning?: number
    apiCalls?: number
  } | null
}

export interface WorkspaceRunChangeFileSummary {
  id: number
  change_id: string
  session_id: string
  path: string
  old_path: string | null
  change_type: 'added' | 'modified' | 'deleted' | 'renamed'
  additions: number
  deletions: number
  size_before: number | null
  size_after: number | null
  patch_bytes: number
  truncated: boolean
  binary: boolean
  created_at: number
}

export interface WorkspaceRunChangeFileDetail extends WorkspaceRunChangeFileSummary {
  patch: string | null
}

export interface WorkspaceRunChangeSummary {
  change_id: string
  room_id?: string
  message_id?: string
  assistant_message_id?: string
  session_id: string
  run_id: string
  source: 'run'
  workspace: string
  workspace_kind: 'git' | 'filesystem'
  started_at: number
  finished_at: number
  files_changed: number
  additions: number
  deletions: number
  truncated: boolean
  total_patch_bytes: number
  created_at: number
  files: WorkspaceRunChangeFileSummary[]
}

export async function fetchSessions(source?: string, limit?: number, profile?: string): Promise<SessionSummary[]> {
  const params = new URLSearchParams()
  if (source) params.set('source', source)
  if (limit) params.set('limit', String(limit))
  if (profile) params.set('profile', profile)
  const query = params.toString()
  const res = await request<{ sessions: SessionSummary[] }>(`/api/studio/sessions${query ? `?${query}` : ''}`)
  return res.sessions
}

export async function fetchSessionCategories(): Promise<SessionCategory[]> {
  const res = await request<{ categories: SessionCategory[] }>('/api/studio/session-categories')
  return res.categories
}

export async function createSessionCategory(name: string): Promise<SessionCategory> {
  const res = await request<{ category: SessionCategory }>('/api/studio/session-categories', {
    method: 'POST',
    body: JSON.stringify({ name }),
  })
  return res.category
}

export async function renameSessionCategory(id: number, name: string): Promise<SessionCategory> {
  const res = await request<{ category: SessionCategory }>(
    `/api/studio/session-categories/${encodeURIComponent(String(id))}`,
    {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    },
  )
  return res.category
}

export async function deleteSessionCategory(id: number): Promise<void> {
  await request(`/api/studio/session-categories/${encodeURIComponent(String(id))}`, {
    method: 'DELETE',
  })
}

export async function fetchWorkspaceRunChangesForSession(id: string): Promise<WorkspaceRunChangeSummary[]> {
  try {
    const res = await request<{ changes: WorkspaceRunChangeSummary[] }>(
      `/api/studio/sessions/${encodeURIComponent(id)}/workspace-run-changes`,
    )
    return Array.isArray(res.changes) ? res.changes : []
  } catch {
    return []
  }
}

export async function fetchWorkspaceRunChangeFile(
  sessionId: string,
  changeId: string,
  fileId: number,
): Promise<WorkspaceRunChangeFileDetail | null> {
  try {
    const res = await request<{ file: WorkspaceRunChangeFileDetail }>(
      `/api/studio/sessions/${encodeURIComponent(sessionId)}/workspace-run-changes/${encodeURIComponent(changeId)}/files/${encodeURIComponent(String(fileId))}`,
    )
    return res.file
  } catch {
    return null
  }
}

export async function readSessionWorkspaceFile(
  sessionId: string,
  path: string,
): Promise<{ content: string; path: string; size: number }> {
  const params = new URLSearchParams({ path })
  return request<{ content: string; path: string; size: number }>(
    `/api/studio/sessions/${encodeURIComponent(sessionId)}/workspace-file/read?${params}`,
  )
}

export async function fetchSessionWorkspaceFileDiff(
  sessionId: string,
  path: string,
): Promise<import('./workspace-files').WorkspaceFileDiff> {
  const params = new URLSearchParams({ path })
  return request(
    `/api/studio/sessions/${encodeURIComponent(sessionId)}/workspace-file/diff?${params}`,
  )
}

export async function fetchSessionWorkspaceFileBlob(
  sessionId: string,
  path: string,
  signal?: AbortSignal,
): Promise<Blob> {
  const params = new URLSearchParams({ path })
  return fetchAuthenticatedBlob(
    `/api/studio/sessions/${encodeURIComponent(sessionId)}/workspace-file/content?${params}`,
    { signal },
  )
}

export async function fetchSessionWorkspaceAttachmentBlob(
  sessionId: string,
  path: string,
  signal?: AbortSignal,
): Promise<Blob> {
  const params = new URLSearchParams({ path, download: '1' })
  return fetchAuthenticatedBlob(
    `/api/studio/sessions/${encodeURIComponent(sessionId)}/workspace-file/content?${params}`,
    { signal },
  )
}

export async function fetchSessionWorkspaceFileText(
  sessionId: string,
  path: string,
): Promise<{ content: string; size: number }> {
  const params = new URLSearchParams({ path, text: '1' })
  const blob = await fetchAuthenticatedBlob(
    `/api/studio/sessions/${encodeURIComponent(sessionId)}/workspace-file/content?${params}`,
  )
  return { content: await blob.text(), size: blob.size }
}

export async function downloadSessionWorkspaceFile(
  sessionId: string,
  path: string,
  fileName: string,
): Promise<void> {
  const params = new URLSearchParams({ path, download: '1' })
  const blob = await fetchAuthenticatedBlob(
    `/api/studio/sessions/${encodeURIComponent(sessionId)}/workspace-file/content?${params}`,
  )
  saveBlob(blob, fileName)
}

export async function listSessionWorkspaceFiles(
  sessionId: string,
  path: string = '',
): Promise<import('./workspace-files').FileListResult> {
  const params = new URLSearchParams()
  if (path) params.set('path', path)
  const query = params.toString()
  return request(`/api/studio/sessions/${encodeURIComponent(sessionId)}/workspace-files/list${query ? `?${query}` : ''}`)
}

export async function writeSessionWorkspaceFile(
  sessionId: string,
  path: string,
  content: string,
): Promise<void> {
  await request<{ ok: boolean }>(
    `/api/studio/sessions/${encodeURIComponent(sessionId)}/workspace-file/write`,
    {
      method: 'PUT',
      body: JSON.stringify({ path, content }),
    },
  )
}

export async function mkdirSessionWorkspaceFile(sessionId: string, path: string): Promise<void> {
  await request<{ ok: boolean }>(
    `/api/studio/sessions/${encodeURIComponent(sessionId)}/workspace-file/mkdir`,
    { method: 'POST', body: JSON.stringify({ path }) },
  )
}

export async function deleteSessionWorkspaceFile(sessionId: string, path: string, recursive = false): Promise<void> {
  await request<{ ok: boolean }>(
    `/api/studio/sessions/${encodeURIComponent(sessionId)}/workspace-file/delete`,
    { method: 'DELETE', body: JSON.stringify({ path, recursive }) },
  )
}

export async function renameSessionWorkspaceFile(sessionId: string, oldPath: string, newPath: string): Promise<void> {
  await request<{ ok: boolean }>(
    `/api/studio/sessions/${encodeURIComponent(sessionId)}/workspace-file/rename`,
    { method: 'POST', body: JSON.stringify({ oldPath, newPath }) },
  )
}

export async function copySessionWorkspaceFile(sessionId: string, srcPath: string, destPath: string): Promise<void> {
  await request<{ ok: boolean }>(
    `/api/studio/sessions/${encodeURIComponent(sessionId)}/workspace-file/copy`,
    { method: 'POST', body: JSON.stringify({ srcPath, destPath }) },
  )
}

/**
 * Fetch Hermes History sessions, including API Server source.
 */
export async function fetchHermesSessions(source?: string, limit?: number, profile?: string | null): Promise<SessionSummary[]> {
  const params = new URLSearchParams()
  if (source) params.set('source', source)
  if (limit) params.set('limit', String(limit))
  if (profile) params.set('profile', profile)
  const query = params.toString()
  const res = await request<{ sessions: SessionSummary[] }>(`/api/studio/sessions/hermes${query ? `?${query}` : ''}`)
  return res.sessions
}

export async function fetchHermesSessionGroups(
  limit: number,
  profile?: string | null,
  includedSessionIds: string[] = [],
): Promise<HermesSessionGroupsResult> {
  const params = new URLSearchParams({ limit: String(limit) })
  if (profile) params.set('profile', profile)
  for (const sessionId of includedSessionIds) params.append('include', sessionId)
  return request<HermesSessionGroupsResult>(`/api/studio/sessions/hermes/groups?${params}`)
}

export async function fetchHermesSessionPage(
  source: string,
  offset: number,
  limit: number,
  profile?: string | null,
): Promise<HermesSessionPage> {
  const params = new URLSearchParams({
    source,
    offset: String(offset),
    limit: String(limit),
  })
  if (profile) params.set('profile', profile)
  return request<HermesSessionPage>(`/api/studio/sessions/hermes?${params}`)
}

export async function searchSessions(q: string, source?: string, limit?: number, profile?: string): Promise<SessionSearchResult[]> {
  const params = new URLSearchParams()
  params.set('q', q)
  if (source) params.set('source', source)
  if (limit) params.set('limit', String(limit))
  if (profile) params.set('profile', profile)
  const query = params.toString()
  const res = await request<{ results: SessionSearchResult[] }>(`/api/studio/search/sessions?${query}`)
  return res.results
}

export async function fetchSession(id: string, profile?: string | null): Promise<SessionDetail | null> {
  try {
    const params = new URLSearchParams()
    if (profile) params.set('profile', profile)
    const query = params.toString()
    const res = await request<{ session: SessionDetail }>(`/api/studio/sessions/${id}${query ? `?${query}` : ''}`)
    return res.session
  } catch {
    return null
  }
}

export async function fetchSessionContext(id: string, profile?: string | null): Promise<SessionContext | null> {
  try {
    const params = new URLSearchParams()
    if (profile) params.set('profile', profile)
    const query = params.toString()
    return await request<SessionContext>(`/api/studio/sessions/${encodeURIComponent(id)}/context${query ? `?${query}` : ''}`)
  } catch {
    return null
  }
}

export async function fetchSessionMessagesPage(
  id: string,
  offset: number,
  limit = 150,
  profile?: string | null,
): Promise<PaginatedSessionMessages | null> {
  try {
    const params = new URLSearchParams()
    params.set('offset', String(offset))
    params.set('limit', String(limit))
    if (profile) params.set('profile', profile)
    const res = await request<PaginatedSessionMessages>(
      `/api/studio/sessions/conversations/${encodeURIComponent(id)}/messages/paginated?${params}`,
    )
    return res
  } catch {
    return null
  }
}

/**
 * Fetch Hermes History session detail, including API Server source.
 */
export async function fetchHermesSession(id: string, profile?: string | null): Promise<SessionDetail | null> {
  try {
    const params = new URLSearchParams()
    if (profile) params.set('profile', profile)
    const query = params.toString()
    const res = await request<{ session: SessionDetail }>(`/api/studio/sessions/hermes/${id}${query ? `?${query}` : ''}`)
    return res.session
  } catch {
    return null
  }
}

export async function deleteSession(id: string, profile?: string | null): Promise<boolean> {
  try {
    const params = new URLSearchParams()
    if (profile) params.set('profile', profile)
    const query = params.toString()
    await request(`/api/studio/sessions/${id}${query ? `?${query}` : ''}`, { method: 'DELETE' })
    return true
  } catch {
    return false
  }
}

export async function importHermesSession(id: string, profile?: string | null): Promise<{ ok: boolean; imported: boolean; session?: SessionDetail }> {
  const params = new URLSearchParams()
  if (profile) params.set('profile', profile)
  const query = params.toString()
  return request<{ ok: boolean; imported: boolean; session?: SessionDetail }>(
    `/api/studio/sessions/hermes/${encodeURIComponent(id)}/import${query ? `?${query}` : ''}`,
    { method: 'POST' },
  )
}

export interface BatchDeleteSessionTarget {
  id: string
  profile?: string | null
}

export async function batchDeleteSessions(targets: Array<string | BatchDeleteSessionTarget>): Promise<{ deleted: number; failed: number; errors: Array<{ id: string; error: string }> }> {
  try {
    const sessions = targets.map(target =>
      typeof target === 'string'
        ? { id: target }
        : { id: target.id, profile: target.profile || undefined },
    )
    const res = await request<{ deleted: number; failed: number; errors: Array<{ id: string; error: string }> }>(
      '/api/studio/sessions/batch-delete',
      {
        method: 'POST',
        body: JSON.stringify({
          ids: sessions.map(session => session.id),
          sessions,
        }),
      }
    )
    return res
  } catch (err: any) {
    throw err
  }
}

export async function renameSession(id: string, title: string): Promise<boolean> {
  try {
    await request(`/api/studio/sessions/${id}/rename`, {
      method: 'POST',
      body: JSON.stringify({ title }),
    })
    return true
  } catch {
    return false
  }
}

export async function archiveSession(id: string): Promise<boolean> {
  try {
    await request(`/api/studio/sessions/${id}/archive`, { method: 'POST' })
    return true
  } catch {
    return false
  }
}

export async function unarchiveSession(id: string): Promise<boolean> {
  try {
    await request(`/api/studio/sessions/${id}/unarchive`, { method: 'POST' })
    return true
  } catch {
    return false
  }
}

export function setSessionPinned(id: string, is_pinned: boolean): Promise<{ ok: boolean; is_pinned: boolean }> {
  return request(`/api/studio/sessions/${encodeURIComponent(id)}/pin`, {
    method: 'POST',
    body: JSON.stringify({ is_pinned }),
  })
}

export async function setSessionPushEnabled(id: string, pushEnabled: boolean): Promise<boolean> {
  try {
    await request(`/api/studio/sessions/${encodeURIComponent(id)}/push-enabled`, {
      method: 'POST',
      body: JSON.stringify({ pushEnabled }),
    })
    return true
  } catch {
    return false
  }
}

export async function setSessionWorkspace(id: string, workspace: string | null): Promise<boolean> {
  try {
    await request(`/api/studio/sessions/${id}/workspace`, {
      method: 'POST',
      body: JSON.stringify({ workspace: workspace || '' }),
    })
    return true
  } catch {
    return false
  }
}

export async function setSessionCategory(id: string, categoryId: number | null): Promise<void> {
  await request(`/api/studio/sessions/${encodeURIComponent(id)}/category`, {
    method: 'POST',
    body: JSON.stringify({ categoryId }),
  })
}

export async function setSessionModel(id: string, model: string, provider: string, apiMode?: ProviderApiMode): Promise<boolean> {
  try {
    await request(`/api/studio/sessions/${id}/model`, {
      method: 'POST',
      body: JSON.stringify({ model, provider, apiMode }),
    })
    return true
  } catch {
    return false
  }
}

export async function setSessionReasoningEffort(id: string, reasoningEffort: string): Promise<boolean> {
  try {
    await request(`/api/studio/sessions/${encodeURIComponent(id)}/reasoning-effort`, {
      method: 'POST',
      body: JSON.stringify({ reasoningEffort }),
    })
    return true
  } catch {
    return false
  }
}

export async function exportSession(id: string, mode: 'full' | 'compressed' = 'full', ext: 'json' | 'txt' = 'json'): Promise<void> {
  const baseUrl = getBaseUrlValue()
  const token = getApiKey()
  const url = `${baseUrl}/api/studio/sessions/${id}/export?mode=${mode}&ext=${ext}&token=${encodeURIComponent(token)}`
  const res = await fetch(url)
  if (!res.ok) throw new Error('Export failed')
  const blob = await res.blob()
  const contentDisposition = res.headers.get('Content-Disposition') || ''
  let filename = `session_${id}.${ext}`
  const match = contentDisposition.match(/filename\*?=(?:UTF-8'')?([^;\n]+)/i)
  if (match) {
    const dispositionFilename = match[1].replace(/"/g, '')
    try {
      filename = decodeURIComponent(dispositionFilename)
    } catch {
      filename = dispositionFilename
    }
  }
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  a.click()
  URL.revokeObjectURL(a.href)
}

export interface UsageStatsResponse {
  total_input_tokens: number
  total_output_tokens: number
  total_cache_read_tokens: number
  total_cache_write_tokens: number
  total_reasoning_tokens: number
  total_sessions: number
  total_cost: number
  total_api_calls?: number
  period_days?: number
  model_usage: Array<{
    model: string
    input_tokens: number
    output_tokens: number
    cache_read_tokens: number
    cache_write_tokens: number
    reasoning_tokens: number
    sessions: number
  }>
  agent_usage?: Array<{
    agent: string
    input_tokens: number
    output_tokens: number
    cache_read_tokens: number
    cache_write_tokens: number
    reasoning_tokens: number
    sessions: number
  }>
  daily_usage: Array<{
    date: string
    input_tokens: number
    output_tokens: number
    cache_read_tokens: number
    cache_write_tokens: number
    sessions: number
    errors: number
    cost: number
  }>
}

export async function fetchUsageStats(days = 30): Promise<UsageStatsResponse> {
  const safeDays = Number.isFinite(days) ? Math.max(1, Math.floor(days)) : 30
  const params = new URLSearchParams()
  params.set('days', String(safeDays))
  return request<UsageStatsResponse>(`/api/studio/usage/stats?${params}`)
}

export async function fetchSessionUsage(ids: string[]): Promise<Record<string, { input_tokens: number; output_tokens: number }>> {
  if (ids.length === 0) return {}
  const params = new URLSearchParams()
  params.set('ids', ids.join(','))
  return request(`/api/studio/sessions/usage?${params}`)
}

export async function fetchSessionUsageSingle(id: string): Promise<{ input_tokens: number; output_tokens: number } | null> {
  try {
    return await request<{ input_tokens: number; output_tokens: number }>(`/api/studio/sessions/${id}/usage`)
  } catch {
    return null
  }
}

export async function fetchContextLength(profile?: string, provider?: string, model?: string): Promise<number> {
  const params = new URLSearchParams()
  if (profile) params.set('profile', profile)
  if (provider) params.set('provider', provider)
  if (model) params.set('model', model)
  const query = params.toString()
  const res = await request<{ context_length: number }>(`/api/studio/sessions/context-length${query ? `?${query}` : ''}`)
  return res.context_length
}
