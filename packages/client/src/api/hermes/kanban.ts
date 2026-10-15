import { request, getApiKey, getBaseUrlValue } from '../client'

// ─── Types ──────────────────────────────────────────────────────

export type KanbanTaskStatus = 'triage' | 'todo' | 'scheduled' | 'ready' | 'running' | 'blocked' | 'review' | 'done' | 'archived'

export interface KanbanTask {
  id: string
  title: string
  body: string | null
  assignee: string | null
  status: KanbanTaskStatus
  priority: number
  created_by: string | null
  created_at: number
  started_at: number | null
  completed_at: number | null
  workspace_kind: string
  workspace_path: string | null
  tenant: string | null
  result: string | null
  skills: string[] | null
  goal_mode?: boolean
  current_run_id?: number | null
  latest_event_id?: number | string | null
}

export interface KanbanRun {
  id: number
  task_id: string
  profile: string | null
  status: string
  outcome: string | null
  summary: string | null
  error: string | null
  metadata: Record<string, unknown> | null
  worker_pid: number | null
  started_at: number
  ended_at: number | null
}

export interface KanbanComment {
  id: number | string
  task_id: string
  author: string
  body: string
  created_at: number
}

export interface KanbanEvent {
  id: number | string
  task_id: string
  kind: string
  payload: Record<string, unknown> | null
  created_at: number
  run_id: number | null
}

export interface KanbanTaskMessage {
  id: number | string
  session_id: string
  role: string
  content: string
  tool_call_id: string | null
  tool_calls: any[] | null
  tool_name: string | null
  timestamp: number
  token_count: number | null
  finish_reason: string | null
  reasoning: string | null
}

export interface KanbanTaskSession {
  id: string
  title: string | null
  source: string
  model: string
  started_at: number
  ended_at: number | null
  messages: KanbanTaskMessage[]
}

export interface KanbanTaskDetail {
  task: KanbanTask
  latest_summary: string | null
  session?: KanbanTaskSession
  comments: KanbanComment[]
  events: KanbanEvent[]
  runs: KanbanRun[]
  parents?: string[]
  children?: string[]
}

export interface KanbanAttachment {
  id: number
  filename: string
  content_type: string | null
  size: number
  uploaded_by: string | null
  created_at: number
}

export interface KanbanStats {
  by_status: Record<string, number>
  by_assignee: Record<string, number>
  total: number
}

export interface KanbanAssignee {
  name: string
  on_disk: boolean
  counts: Record<string, number> | null
}

export interface KanbanBoard {
  slug: string
  name: string
  description: string
  icon: string
  color: string
  created_at: number | null
  archived: boolean
  db_path?: string
  is_current?: boolean
  counts: Record<string, number>
  total: number
}

export interface KanbanBoardCreateRequest {
  slug: string
  name?: string
  description?: string
  icon?: string
  color?: string
  switchCurrent?: boolean
}

export interface KanbanCapabilityStatus {
  key: string
  status: 'supported' | 'partial' | 'missing'
  reason?: string
  canonicalRoute?: string
  canonicalCommand?: string
  requiresBoard: boolean
}

export interface KanbanCapabilities {
  source: 'hermes-cli'
  supports: Record<string, boolean>
  missing: string[]
  capabilities?: KanbanCapabilityStatus[]
}

export interface KanbanTaskLog {
  task_id: string
  path: string | null
  exists: boolean
  size_bytes: number
  content: string
  truncated: boolean
}

export interface KanbanCreateRequest {
  title: string
  body?: string
  assignee?: string
  priority?: number
  tenant?: string
  workspace?: string
  branch?: string
  triage?: boolean
  skills?: string[]
  maxRuntime?: string
  maxRetries?: number
  goalMode?: boolean
  goalMaxTurns?: number
}

export interface KanbanBoardOptions {
  board?: string
}

export interface KanbanListOptions extends KanbanBoardOptions {
  status?: string
  assignee?: string
  tenant?: string
  includeArchived?: boolean
}

export interface KanbanCommentCreateRequest {
  body: string
  author?: string
}

export interface KanbanTaskLogOptions extends KanbanBoardOptions {
  tail?: number
}

export interface KanbanDiagnosticsOptions extends KanbanBoardOptions {
  task?: string
  severity?: 'warning' | 'error' | 'critical'
}

export interface KanbanReclaimOptions extends KanbanBoardOptions {
  reason?: string
}

export interface KanbanReassignOptions extends KanbanBoardOptions {
  reclaim?: boolean
  reason?: string
}

export interface KanbanSpecifyOptions extends KanbanBoardOptions {
  author?: string
}

export interface KanbanDispatchOptions extends KanbanBoardOptions {
  dryRun?: boolean
  max?: number
  failureLimit?: number
}

export type KanbanApprovalAction = 'claim' | 'request_review' | 'approve' | 'request_changes' | 'archive'

export interface KanbanApprovalCapabilities {
  can_approve: boolean
  allowed_boards: string[]
  dingtalk_configured: boolean
}

export interface KanbanApprovalReceipt {
  ok: true
  duplicate: boolean
  action: KanbanApprovalAction
  actor: string
  channel: 'studio' | 'dingtalk'
  reason: string | null
  event_id: string
  canonical_event_id: number | string | null
  timestamp: number
  before_status: KanbanTaskStatus
  after_status: KanbanTaskStatus
  run_id: number | null
  task: KanbanTask
}

export interface KanbanApprovalResult {
  receipt: KanbanApprovalReceipt
  notification?: {
    configured: boolean
    api_accepted: boolean
    attempts: number
    recipient_confirmed: boolean
  }
}

export interface KanbanLinkRequest {
  parent_id: string
  child_id: string
}

export interface KanbanBulkUpdateRequest {
  ids: string[]
  status?: KanbanTaskStatus
  assignee?: string | null
  archive?: boolean
  summary?: string
  reason?: string
}

export interface KanbanBulkTaskResult {
  id: string
  ok: boolean
  error?: string
}

function normalizedBoard(board?: string): string {
  const trimmed = board?.trim()
  return trimmed || 'default'
}

function activeProfileName(): string | null {
  try {
    return localStorage.getItem('hermes_active_profile_name')
  } catch {
    return null
  }
}

function appendQuery(path: string, params: URLSearchParams): string {
  const qs = params.toString()
  return qs ? `${path}?${qs}` : path
}

function boardParams(board?: string): URLSearchParams {
  const params = new URLSearchParams()
  params.set('board', normalizedBoard(board))
  return params
}

function websocketProtocol(base?: string): string {
  if (base) return base.startsWith('https') ? 'wss:' : 'ws:'
  return location.protocol === 'https:' ? 'wss:' : 'ws:'
}

function formatHostForPort(hostname: string, port: number): string {
  if (hostname.startsWith('[') && hostname.endsWith(']')) return `${hostname}:${port}`
  return hostname.includes(':') ? `[${hostname}]:${port}` : `${hostname}:${port}`
}

export function buildKanbanEventsWebSocketUrl(opts?: KanbanBoardOptions): string {
  const base = getBaseUrlValue()
  const params = boardParams(opts?.board)
  const token = getApiKey()
  if (token) params.set('token', token)
  const profile = activeProfileName()
  if (profile) params.set('profile', profile)
  const path = `/api/hermes/kanban/events?${params.toString()}`

  if (base) {
    return `${websocketProtocol(base)}//${new URL(base).host}${path}`
  }

  const directDevPort = import.meta.env.VITE_HERMES_DIRECT_WS_PORT
  const host = import.meta.env.DEV && directDevPort
    ? formatHostForPort(location.hostname, Number(directDevPort))
    : location.host
  return `${websocketProtocol()}//${host}${path}`
}

export function openKanbanEventStream(opts?: KanbanBoardOptions): WebSocket {
  return new WebSocket(buildKanbanEventsWebSocketUrl(opts))
}

// ─── API functions ───────────────────────────────────────────────

export async function listBoards(opts?: { includeArchived?: boolean }): Promise<KanbanBoard[]> {
  const params = new URLSearchParams()
  if (opts?.includeArchived) params.set('includeArchived', 'true')
  const res = await request<{ boards: KanbanBoard[] }>(appendQuery('/api/hermes/kanban/boards', params))
  return res.boards
}

export async function createBoard(data: KanbanBoardCreateRequest): Promise<KanbanBoard> {
  const res = await request<{ board: KanbanBoard }>('/api/hermes/kanban/boards', {
    method: 'POST',
    body: JSON.stringify(data),
  })
  return res.board
}

export async function archiveBoard(slug: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/hermes/kanban/boards/${encodeURIComponent(slug)}`, {
    method: 'DELETE',
  })
}

export async function getCapabilities(): Promise<KanbanCapabilities> {
  const res = await request<{ capabilities: KanbanCapabilities }>('/api/hermes/kanban/capabilities')
  return res.capabilities
}

export async function getApprovalCapabilities(): Promise<KanbanApprovalCapabilities> {
  const res = await request<{ approval: KanbanApprovalCapabilities }>('/api/hermes/kanban/approval/capabilities')
  return res.approval
}

const volatileApprovalEventIds = new Map<string, string>()

function approvalEventStorageKey(board: string, taskId: string, action: KanbanApprovalAction): string {
  return `hermes:kanban:approval:${board}:${taskId}:${action}`
}

function readOrCreateApprovalEventId(key: string): string {
  try {
    const stored = globalThis.localStorage?.getItem(key)
    if (stored) return stored
    const eventId = globalThis.crypto.randomUUID()
    globalThis.localStorage?.setItem(key, eventId)
    return eventId
  } catch {
    const stored = volatileApprovalEventIds.get(key)
    if (stored) return stored
    const eventId = globalThis.crypto.randomUUID()
    volatileApprovalEventIds.set(key, eventId)
    return eventId
  }
}

function clearApprovalEventId(key: string) {
  volatileApprovalEventIds.delete(key)
  try {
    globalThis.localStorage?.removeItem(key)
  } catch {
    // Volatile fallback was already cleared.
  }
}

export async function performApprovalAction(
  taskId: string,
  action: KanbanApprovalAction,
  data: { reason?: string; reviewer?: string; event_id?: string } = {},
  opts?: KanbanBoardOptions,
): Promise<KanbanApprovalResult> {
  const actionPath = action.replace('_', '-')
  const board = opts?.board || 'default'
  const storageKey = approvalEventStorageKey(board, taskId, action)
  const generatedEventId = !data.event_id
  const payload = generatedEventId
    ? { ...data, event_id: readOrCreateApprovalEventId(storageKey) }
    : data
  const result = await request<KanbanApprovalResult>(
    appendQuery(`/api/hermes/kanban/${encodeURIComponent(taskId)}/${actionPath}`, boardParams(opts?.board)),
    { method: 'POST', body: JSON.stringify(payload) },
  )
  if (generatedEventId) clearApprovalEventId(storageKey)
  return result
}

export async function listTasks(opts?: KanbanListOptions): Promise<KanbanTask[]> {
  const params = boardParams(opts?.board)
  if (opts?.status) params.set('status', opts.status)
  if (opts?.assignee) params.set('assignee', opts.assignee)
  if (opts?.tenant) params.set('tenant', opts.tenant)
  if (opts?.includeArchived) params.set('includeArchived', 'true')
  const res = await request<{ tasks: KanbanTask[] }>(appendQuery('/api/hermes/kanban', params))
  return res.tasks
}

export async function getTask(id: string, opts?: KanbanBoardOptions): Promise<KanbanTaskDetail> {
  return request<KanbanTaskDetail>(appendQuery(`/api/hermes/kanban/${encodeURIComponent(id)}`, boardParams(opts?.board)))
}

export async function listAttachments(taskId: string, opts?: KanbanBoardOptions): Promise<KanbanAttachment[]> {
  const res = await request<{ attachments: KanbanAttachment[] }>(
    appendQuery(`/api/hermes/kanban/${encodeURIComponent(taskId)}/attachments`, boardParams(opts?.board)),
  )
  return res.attachments
}

export function getAttachmentContentPath(taskId: string, attachmentId: number, opts?: KanbanBoardOptions): string {
  return appendQuery(
    `/api/hermes/kanban/${encodeURIComponent(taskId)}/attachments/${encodeURIComponent(String(attachmentId))}`,
    boardParams(opts?.board),
  )
}

export async function createTask(data: KanbanCreateRequest, opts?: KanbanBoardOptions): Promise<KanbanTask> {
  const res = await request<{ task: KanbanTask }>(appendQuery('/api/hermes/kanban', boardParams(opts?.board)), {
    method: 'POST',
    body: JSON.stringify(data),
  })
  return res.task
}

export async function completeTasks(taskIds: string[], summary?: string, opts?: KanbanBoardOptions): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(appendQuery('/api/hermes/kanban/complete', boardParams(opts?.board)), {
    method: 'POST',
    body: JSON.stringify({ task_ids: taskIds, summary }),
  })
}

export async function blockTask(taskId: string, reason: string, opts?: KanbanBoardOptions): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(appendQuery(`/api/hermes/kanban/${encodeURIComponent(taskId)}/block`, boardParams(opts?.board)), {
    method: 'POST',
    body: JSON.stringify({ reason }),
  })
}

export async function unblockTasks(taskIds: string[], opts?: KanbanBoardOptions): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(appendQuery('/api/hermes/kanban/unblock', boardParams(opts?.board)), {
    method: 'POST',
    body: JSON.stringify({ task_ids: taskIds }),
  })
}

export async function assignTask(taskId: string, profile: string, opts?: KanbanBoardOptions): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(appendQuery(`/api/hermes/kanban/${encodeURIComponent(taskId)}/assign`, boardParams(opts?.board)), {
    method: 'POST',
    body: JSON.stringify({ profile }),
  })
}

export async function addComment(taskId: string, data: KanbanCommentCreateRequest, opts?: KanbanBoardOptions): Promise<{ ok: boolean; output?: string }> {
  return request<{ ok: boolean; output?: string }>(appendQuery(`/api/hermes/kanban/${encodeURIComponent(taskId)}/comments`, boardParams(opts?.board)), {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function linkTasks(data: KanbanLinkRequest, opts?: KanbanBoardOptions): Promise<{ ok: boolean; output?: string }> {
  return request<{ ok: boolean; output?: string }>(appendQuery('/api/hermes/kanban/links', boardParams(opts?.board)), {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function unlinkTasks(data: KanbanLinkRequest, opts?: KanbanBoardOptions): Promise<{ ok: boolean; output?: string }> {
  const params = boardParams(opts?.board)
  params.set('parent_id', data.parent_id)
  params.set('child_id', data.child_id)
  return request<{ ok: boolean; output?: string }>(appendQuery('/api/hermes/kanban/links', params), {
    method: 'DELETE',
  })
}

export async function bulkUpdateTasks(data: KanbanBulkUpdateRequest, opts?: KanbanBoardOptions): Promise<{ results: KanbanBulkTaskResult[] }> {
  return request<{ results: KanbanBulkTaskResult[] }>(appendQuery('/api/hermes/kanban/tasks/bulk', boardParams(opts?.board)), {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function getTaskLog(taskId: string, opts?: KanbanTaskLogOptions): Promise<KanbanTaskLog> {
  const params = boardParams(opts?.board)
  if (opts?.tail !== undefined) params.set('tail', String(opts.tail))
  return request<KanbanTaskLog>(appendQuery(`/api/hermes/kanban/${encodeURIComponent(taskId)}/log`, params))
}

export async function getDiagnostics(opts?: KanbanDiagnosticsOptions): Promise<unknown[]> {
  const params = boardParams(opts?.board)
  if (opts?.task) params.set('task', opts.task)
  if (opts?.severity) params.set('severity', opts.severity)
  const res = await request<{ diagnostics: unknown[] }>(appendQuery('/api/hermes/kanban/diagnostics', params))
  return res.diagnostics
}

export async function reclaimTask(taskId: string, opts?: KanbanReclaimOptions): Promise<{ ok: boolean; output?: string }> {
  return request<{ ok: boolean; output?: string }>(appendQuery(`/api/hermes/kanban/${encodeURIComponent(taskId)}/reclaim`, boardParams(opts?.board)), {
    method: 'POST',
    body: JSON.stringify({ reason: opts?.reason }),
  })
}

export async function reassignTask(taskId: string, profile: string, opts?: KanbanReassignOptions): Promise<{ ok: boolean; output?: string }> {
  return request<{ ok: boolean; output?: string }>(appendQuery(`/api/hermes/kanban/${encodeURIComponent(taskId)}/reassign`, boardParams(opts?.board)), {
    method: 'POST',
    body: JSON.stringify({ profile, reclaim: opts?.reclaim, reason: opts?.reason }),
  })
}

export async function specifyTask(taskId: string, opts?: KanbanSpecifyOptions): Promise<unknown[]> {
  const res = await request<{ results: unknown[] }>(appendQuery(`/api/hermes/kanban/${encodeURIComponent(taskId)}/specify`, boardParams(opts?.board)), {
    method: 'POST',
    body: JSON.stringify({ author: opts?.author }),
  })
  return res.results
}

export async function dispatch(opts?: KanbanDispatchOptions): Promise<unknown> {
  const params = boardParams(opts?.board)
  const res = await request<{ result: unknown }>(appendQuery('/api/hermes/kanban/dispatch', params), {
    method: 'POST',
    body: JSON.stringify({ dryRun: opts?.dryRun, max: opts?.max, failureLimit: opts?.failureLimit }),
  })
  return res.result
}

export async function getStats(opts?: KanbanBoardOptions): Promise<KanbanStats> {
  const res = await request<{ stats: KanbanStats }>(appendQuery('/api/hermes/kanban/stats', boardParams(opts?.board)))
  return res.stats
}

export async function getAssignees(opts?: KanbanBoardOptions): Promise<KanbanAssignee[]> {
  const res = await request<{ assignees: KanbanAssignee[] }>(appendQuery('/api/hermes/kanban/assignees', boardParams(opts?.board)))
  return res.assignees
}
