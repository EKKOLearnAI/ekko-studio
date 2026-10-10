import type { ChildProcess, ExecFileOptions } from 'child_process'
import { randomUUID } from 'crypto'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { logger } from '../../../studio/public/logging'
import { detectHermesRootHome } from '../runtime/path'
import { execHermes, spawnHermes } from '../runtime/process'
import {
  getKanbanApprovalAuditStore,
  type KanbanApprovalAuditRecord,
  type KanbanApprovalAuditStore,
} from './approval-audit-store'

const execOpts = { windowsHide: true }
const BOARD_SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/
const NO_WORKER_LOG_PATTERNS = [
  /^\(no log for [^)]+?\s+—\s+task may not have spawned yet\)$/i,
  /^no worker log(?: for [^\n]+)?$/i,
]

export function normalizeBoardSlug(board?: string | null): string {
  if (board === undefined || board === null) return 'default'
  const trimmed = board.trim().toLowerCase()
  if (!trimmed) throw new Error('Invalid kanban board slug')
  if (!BOARD_SLUG_RE.test(trimmed)) {
    throw new Error('Invalid kanban board slug')
  }
  return trimmed
}

function boardArgs(board?: string | null): string[] {
  return ['kanban', '--board', normalizeBoardSlug(board)]
}

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
}

export interface KanbanRun {
  id: number
  task_id: string
  profile: string | null
  status: string
  started_at: number
  ended_at: number | null
  outcome: string | null
  summary: string | null
  error: string | null
  metadata?: Record<string, unknown> | string | null
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

export interface KanbanTaskDetail {
  task: KanbanTask
  comments: KanbanComment[]
  events: KanbanEvent[]
  runs: KanbanRun[]
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

export interface KanbanAttachment {
  id: number
  filename: string
  content_type: string | null
  size: number
  uploaded_by: string | null
  stored_path: string
  created_at: number
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

export interface KanbanBoardCreateOptions {
  slug: string
  name?: string
  description?: string
  icon?: string
  color?: string
  switchCurrent?: boolean
}

export interface KanbanCapabilities {
  source: 'hermes-cli'
  supports: Record<string, boolean>
  missing: string[]
  capabilities: KanbanCapabilityStatus[]
}

export interface KanbanTaskLog {
  task_id: string
  path: string | null
  exists: boolean
  size_bytes: number
  content: string
  truncated: boolean
}

export interface KanbanCapabilityStatus {
  key: string
  status: 'supported' | 'partial' | 'missing'
  reason?: string
  canonicalRoute?: string
  canonicalCommand?: string
  requiresBoard: boolean
}

export interface KanbanBoardOptions {
  board?: string
}

export interface KanbanWatchOptions extends KanbanBoardOptions {
  interval?: number
  kinds?: string[]
}

export interface KanbanBulkTaskUpdateOptions extends KanbanBoardOptions {
  ids: string[]
  status?: KanbanTaskStatus
  assignee?: string | null
  archive?: boolean
  summary?: string
  reason?: string
  operatorOverride?: boolean
}

export interface KanbanBulkTaskResult {
  id: string
  ok: boolean
  error?: string
}

export interface KanbanBulkTaskUpdateResult {
  results: KanbanBulkTaskResult[]
}

export type KanbanApprovalAction = 'claim' | 'request_review' | 'approve' | 'request_changes' | 'archive'

export interface KanbanApprovalActionOptions extends KanbanBoardOptions {
  actor: string
  channel?: 'studio' | 'dingtalk'
  eventId?: string
  reason?: string
  reviewer?: string
  auditStore?: KanbanApprovalAuditStore
}

export interface KanbanApprovalReceipt {
  ok: true
  duplicate: boolean
  action: KanbanApprovalAction
  actor: string
  channel: 'studio' | 'dingtalk'
  event_id: string
  canonical_event_id: number | string | null
  run_id: number | null
  before_status: KanbanTaskStatus
  after_status: KanbanTaskStatus
  timestamp: number
  reason: string | null
  task: KanbanTask
}

// ─── CLI wrappers ───────────────────────────────────────────────

export async function listBoards(opts?: { includeArchived?: boolean }): Promise<KanbanBoard[]> {
  const args = ['kanban', 'boards', 'list', '--json']
  if (opts?.includeArchived) args.push('--all')

  try {
    const { stdout } = await execHermes(args, {
      maxBuffer: 50 * 1024 * 1024,
      timeout: 30000,
      ...execOpts,
    })
    return JSON.parse(stdout)
  } catch (err: any) {
    logger.error(err, 'Hermes CLI: kanban boards list failed')
    throw new Error(`Failed to list kanban boards: ${err.message}`)
  }
}

async function findBoard(slug: string, includeArchived = true): Promise<KanbanBoard | null> {
  const boards = await listBoards({ includeArchived })
  return boards.find(board => board.slug === slug) || null
}

export async function createBoard(opts: KanbanBoardCreateOptions): Promise<KanbanBoard> {
  const slug = normalizeBoardSlug(opts.slug)
  const args = ['kanban', 'boards', 'create', slug]
  if (opts.name?.trim()) args.push('--name', opts.name.trim())
  if (opts.description?.trim()) args.push('--description', opts.description.trim())
  if (opts.icon?.trim()) args.push('--icon', opts.icon.trim())
  if (opts.color?.trim()) args.push('--color', opts.color.trim())
  if (opts.switchCurrent) args.push('--switch')

  try {
    await execHermes(args, {
      maxBuffer: 50 * 1024 * 1024,
      timeout: 30000,
      ...execOpts,
    })
    const board = await findBoard(slug)
    if (!board) throw new Error('created board was not returned by boards list')
    return board
  } catch (err: any) {
    logger.error(err, 'Hermes CLI: kanban boards create failed')
    throw new Error(`Failed to create kanban board: ${err.message}`)
  }
}

export async function archiveBoard(slugInput: string): Promise<void> {
  const slug = normalizeBoardSlug(slugInput)
  if (slug === 'default') throw new Error('Cannot archive the default kanban board')

  try {
    await execHermes(['kanban', 'boards', 'rm', slug], {
      maxBuffer: 50 * 1024 * 1024,
      timeout: 30000,
      ...execOpts,
    })
  } catch (err: any) {
    logger.error(err, 'Hermes CLI: kanban boards archive failed')
    throw new Error(`Failed to archive kanban board: ${err.message}`)
  }
}

export async function getCapabilities(): Promise<KanbanCapabilities> {
  const capabilities: KanbanCapabilityStatus[] = [
    { key: 'explicitBoard', status: 'supported', canonicalCommand: '--board', requiresBoard: true },
    { key: 'boardsList', status: 'supported', canonicalRoute: '/boards', canonicalCommand: 'boards list', requiresBoard: false },
    { key: 'boardCreate', status: 'supported', canonicalRoute: '/boards', canonicalCommand: 'boards create', requiresBoard: false },
    { key: 'boardArchive', status: 'supported', canonicalRoute: '/boards/{slug}', canonicalCommand: 'boards rm', requiresBoard: false },
    { key: 'cliCurrentSwitch', status: 'partial', reason: 'Backend keeps explicit board context and does not expose a WUI route for mutating canonical CLI current board', canonicalRoute: '/boards/{slug}/switch', canonicalCommand: 'boards switch', requiresBoard: false },
    { key: 'taskCrudLite', status: 'supported', canonicalRoute: '/tasks', canonicalCommand: 'list/show/create/complete/block/unblock/assign', requiresBoard: true },
    { key: 'commentsWrite', status: 'supported', canonicalRoute: '/tasks/{task_id}/comments', canonicalCommand: 'comment', requiresBoard: true },
    { key: 'commentsRead', status: 'supported', reason: 'Comments are returned on task detail responses', canonicalRoute: '/tasks/{task_id}', canonicalCommand: 'show --json', requiresBoard: true },
    { key: 'taskLog', status: 'supported', canonicalRoute: '/tasks/{task_id}/log', canonicalCommand: 'log', requiresBoard: true },
    { key: 'attachments', status: 'supported', canonicalRoute: '/tasks/{task_id}/attachments', canonicalCommand: 'attachments --json', requiresBoard: true },
    { key: 'diagnostics', status: 'supported', canonicalRoute: '/diagnostics', canonicalCommand: 'diagnostics', requiresBoard: true },
    { key: 'reclaim', status: 'supported', canonicalRoute: '/tasks/{task_id}/reclaim', canonicalCommand: 'reclaim', requiresBoard: true },
    { key: 'reassign', status: 'supported', canonicalRoute: '/tasks/{task_id}/reassign', canonicalCommand: 'reassign', requiresBoard: true },
    { key: 'specify', status: 'supported', canonicalRoute: '/tasks/{task_id}/specify', canonicalCommand: 'specify', requiresBoard: true },
    { key: 'dispatch', status: 'supported', canonicalRoute: '/dispatch', canonicalCommand: 'dispatch', requiresBoard: true },
    { key: 'links', status: 'supported', canonicalRoute: '/links', canonicalCommand: 'link/unlink', requiresBoard: true },
    { key: 'bulk', status: 'partial', reason: 'WUI applies supported bulk-equivalent CLI transitions per id and returns per-task outcomes; direct priority/status patch parity remains deferred', canonicalRoute: '/tasks/bulk', canonicalCommand: 'bulk-equivalent via complete/block/unblock/archive/assign', requiresBoard: true },
    { key: 'events', status: 'partial', reason: 'WUI exposes a board-scoped WebSocket bridge backed by the canonical `kanban watch` stream; payload is currently a refresh invalidation signal, not a typed event model', canonicalRoute: '/events', canonicalCommand: 'watch', requiresBoard: true },
    { key: 'homeSubscriptions', status: 'missing', reason: 'Deferred from current WUI parity batch', canonicalRoute: '/home-channels and subscription routes', canonicalCommand: 'notify-*', requiresBoard: true },
  ]
  const supports = Object.fromEntries(capabilities.map(capability => [capability.key, capability.status === 'supported'])) as Record<string, boolean>
  const missing = capabilities
    .filter(capability => capability.status !== 'supported')
    .map(capability => capability.key)
  return { source: 'hermes-cli', supports, missing, capabilities }
}

function parseJsonPayload(stdout: string): unknown[] {
  const trimmed = stdout.trim()
  if (!trimmed) return []
  const parsed = JSON.parse(trimmed)
  if (Array.isArray(parsed)) return parsed
  return [parsed]
}

function isNoWorkerLogError(err: any): boolean {
  const lines = [err?.stderr, err?.stdout, err?.message]
    .filter(Boolean)
    .flatMap(value => String(value).split(/\r?\n/).map(line => line.trim()).filter(Boolean))
  return lines.some(line => NO_WORKER_LOG_PATTERNS.some(pattern => pattern.test(line)))
}

function pushOptional(args: string[], flag: string, value?: string | number | null): void {
  if (value !== undefined && value !== null && String(value).trim() !== '') args.push(flag, String(value))
}

function textFromExecValue(value: unknown): string {
  if (Buffer.isBuffer(value)) return value.toString('utf8')
  return value === undefined || value === null ? '' : String(value)
}

async function execKanbanMutation(
  args: string[],
  logMessage: string,
  errorPrefix: string,
  options: ExecFileOptions = {},
): Promise<string> {
  try {
    const { stdout, stderr } = await execHermes(args, {
      maxBuffer: 50 * 1024 * 1024,
      timeout: 30000,
      ...execOpts,
      ...options,
    })
    const stderrText = textFromExecValue(stderr).trim()
    if (stderrText) throw new Error(stderrText)
    return textFromExecValue(stdout)
  } catch (err: any) {
    logger.error(err, logMessage)
    throw new Error(`${errorPrefix}: ${err.message}`)
  }
}

const APPROVAL_AUDIT_PREFIX = '[KANBAN_APPROVAL_AUDIT] '
const APPROVAL_EVENT_KINDS: Record<KanbanApprovalAction, ReadonlySet<string>> = {
  claim: new Set(['claimed']),
  request_review: new Set(['review_requested']),
  approve: new Set(['completed']),
  request_changes: new Set(['changes_requested', 'review_reopened']),
  archive: new Set(['archived']),
}

function approvalError(action: KanbanApprovalAction, taskId: string, status: KanbanTaskStatus): Error {
  return new Error(`Cannot ${action} task "${taskId}" from status "${status}"`)
}

function assertApprovalTransition(detail: KanbanTaskDetail, action: KanbanApprovalAction, reason?: string): void {
  const status = detail.task.status
  const allowed: Record<KanbanApprovalAction, KanbanTaskStatus[]> = {
    claim: ['ready'],
    request_review: ['running', 'ready'],
    approve: ['review'],
    request_changes: ['review', 'running'],
    archive: ['done'],
  }
  if (!allowed[action].includes(status)) throw approvalError(action, detail.task.id, status)
  if ((action === 'approve' || action === 'request_changes') && !reason?.trim()) {
    throw new Error(`Reason is required to ${action} task "${detail.task.id}"`)
  }
  if (action === 'request_changes' && status === 'running') {
    const activeRunId = detail.task.current_run_id
    const claimed = [...detail.events].reverse().find(event => (
      event.kind === 'claimed'
      && (activeRunId == null || event.run_id === activeRunId)
      && event.payload?.source_status === 'review'
    ))
    if (!claimed) throw approvalError(action, detail.task.id, status)
  }
}

function hasApprovalEvent(detail: KanbanTaskDetail, eventId: string): boolean {
  const safeEventId = eventId.replace(/["\\]/g, '')
  return detail.comments.some(comment => comment.body.startsWith(APPROVAL_AUDIT_PREFIX)
    && comment.body.includes(`"event_id":"${safeEventId}"`))
}

function expectedApprovalStatuses(action: KanbanApprovalAction): KanbanTaskStatus[] {
  const statuses: Record<KanbanApprovalAction, KanbanTaskStatus[]> = {
    claim: ['running'],
    request_review: ['review'],
    approve: ['done'],
    request_changes: ['ready', 'todo'],
    archive: ['archived'],
  }
  return statuses[action]
}

function latestCanonicalApprovalEvent(
  detail: KanbanTaskDetail,
  action: KanbanApprovalAction,
  excludedEventIds: Iterable<string> = [],
): KanbanEvent | undefined {
  const excluded = new Set(excludedEventIds)
  return [...detail.events].reverse().find(event => (
    APPROVAL_EVENT_KINDS[action].has(event.kind) && !excluded.has(String(event.id))
  ))
}

function parsedRunMetadata(run: KanbanRun | undefined): Record<string, unknown> | null {
  if (!run?.metadata) return null
  if (typeof run.metadata === 'object') return run.metadata
  try {
    const parsed = JSON.parse(run.metadata)
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

function canonicalEventMatchesPreparedAudit(
  detail: KanbanTaskDetail,
  event: KanbanEvent,
  audit: KanbanApprovalAuditRecord,
): boolean {
  const run = detail.runs.find(candidate => candidate.id === event.run_id)
  const approval = parsedRunMetadata(run)?.approval
  if (approval && typeof approval === 'object') {
    const identity = approval as Record<string, unknown>
    return identity.event_id === audit.event_id && identity.action === audit.action
  }
  return audit.action === 'claim'
    && Boolean(audit.canonical_profile)
    && run?.profile === audit.canonical_profile
}

function assertMatchingAuditRecord(
  record: KanbanApprovalAuditRecord,
  taskId: string,
  action: KanbanApprovalAction,
  board: string,
  actor: string,
  channel: 'studio' | 'dingtalk',
  reason: string | null,
  reviewer: string | null,
): void {
  if (
    record.task_id !== taskId
    || record.action !== action
    || record.board !== board
    || record.actor !== actor
    || record.channel !== channel
    || record.reason !== reason
    || (record.reviewer !== undefined && record.reviewer !== reviewer)
  ) {
    throw new Error(`Approval event ID "${record.event_id}" is already bound to another action`)
  }
}

function receiptFromAudit(
  record: KanbanApprovalAuditRecord,
  task: KanbanTask,
  duplicate: boolean,
): KanbanApprovalReceipt {
  return {
    ok: true,
    duplicate,
    action: record.action,
    actor: record.actor,
    channel: record.channel,
    event_id: record.event_id,
    canonical_event_id: record.canonical_event_id,
    run_id: record.run_id,
    before_status: record.before_status,
    after_status: record.after_status || task.status,
    timestamp: record.timestamp,
    reason: record.reason,
    task,
  }
}

function scrubAuditText(value?: string): string | null {
  const trimmed = value?.trim()
  if (!trimmed) return null
  return trimmed
    .slice(0, 2_000)
    .replace(/\b(?:sk|key|token|secret|password)[-_:=\s]+[A-Za-z0-9_./+=-]{8,}\b/gi, '[REDACTED]')
}

function actionMetadata(
  action: KanbanApprovalAction,
  opts: Required<Pick<KanbanApprovalActionOptions, 'actor' | 'channel' | 'eventId'>>,
  reason: string | null,
) {
  return {
    approval: {
      action,
      actor: opts.actor,
      channel: opts.channel,
      event_id: opts.eventId,
      reason,
    },
  }
}

async function executeApprovalTransition(
  taskId: string,
  action: KanbanApprovalAction,
  before: KanbanTaskDetail,
  opts: Required<Pick<KanbanApprovalActionOptions, 'board' | 'actor' | 'channel' | 'eventId'>> & KanbanApprovalActionOptions,
  reason: string | null,
): Promise<void> {
  const args = boardArgs(opts.board)
  const metadata = JSON.stringify(actionMetadata(action, opts, reason))
  switch (action) {
    case 'claim':
      args.push('claim', taskId)
      break
    case 'request_review':
      args.push('request-review', taskId)
      if (reason) args.push('--summary', reason)
      if (opts.reviewer?.trim()) args.push('--reviewer', opts.reviewer.trim())
      args.push('--metadata', metadata, '--force')
      break
    case 'approve':
      args.push('complete', taskId, '--summary', reason!, '--metadata', metadata)
      break
    case 'request_changes':
      if (before.task.status === 'review') args.push('reopen-review', taskId, '--reason', reason!)
      else args.push('request-changes', taskId, reason!)
      break
    case 'archive':
      args.push('archive', taskId)
      break
  }
  await execKanbanMutation(
    args,
    `Hermes CLI: kanban approval action ${action} failed`,
    `Failed to ${action} kanban task`,
  )
}

async function performApprovalActionUnlocked(
  taskId: string,
  action: KanbanApprovalAction,
  options: KanbanApprovalActionOptions,
): Promise<KanbanApprovalReceipt> {
  const board = normalizeBoardSlug(options.board)
  const actor = options.actor.trim()
  if (!actor) throw new Error('Approval actor is required')
  const channel = options.channel || 'studio'
  const eventId = options.eventId?.trim() || randomUUID()
  const reason = scrubAuditText(options.reason)
  const auditStore = options.auditStore || getKanbanApprovalAuditStore()
  const before = await getTask(taskId, { board })
  if (!before) throw new Error(`Kanban task "${taskId}" was not found`)

  const existingAudit = await auditStore.get(board, taskId, eventId)
  if (existingAudit) {
    assertMatchingAuditRecord(
      existingAudit,
      taskId,
      action,
      board,
      actor,
      channel,
      reason,
      options.reviewer?.trim() || null,
    )
    if (existingAudit.phase === 'completed') {
      if (!hasApprovalEvent(before, eventId)) {
        await addComment(taskId, `${APPROVAL_AUDIT_PREFIX}${JSON.stringify(existingAudit)}`, {
          board,
          author: `${existingAudit.channel}:${existingAudit.actor}`,
        })
      }
      return receiptFromAudit(existingAudit, before.task, true)
    }
    const expectedStatuses = expectedApprovalStatuses(action)
    const canonicalEvent = latestCanonicalApprovalEvent(before, action, existingAudit.before_event_ids || [])
    if (canonicalEvent && !canonicalEventMatchesPreparedAudit(before, canonicalEvent, existingAudit)) {
      throw new Error(`Cannot recover approval event "${eventId}" without matching canonical identity`)
    }
    if (canonicalEvent || (!existingAudit.before_event_ids && expectedStatuses.includes(before.task.status))) {
      const payloadStatus = canonicalEvent?.payload && typeof canonicalEvent.payload === 'object'
        ? [canonicalEvent.payload.after_status, canonicalEvent.payload.status, canonicalEvent.payload.to_status]
            .find(value => typeof value === 'string' && expectedStatuses.includes(value as KanbanTaskStatus))
        : undefined
      const recoveredStatus = expectedStatuses.includes(before.task.status)
        ? before.task.status
        : typeof payloadStatus === 'string'
          ? payloadStatus as KanbanTaskStatus
          : expectedStatuses[0]
      const recovered = await auditStore.complete(
        { board, taskId, eventId },
        {
          after_status: recoveredStatus,
          canonical_event_id: canonicalEvent?.id ?? null,
          run_id: canonicalEvent?.run_id ?? before.task.current_run_id ?? null,
          timestamp: canonicalEvent?.created_at || Math.floor(Date.now() / 1000),
          updated_at: Math.floor(Date.now() / 1000),
        },
      )
      await addComment(taskId, `${APPROVAL_AUDIT_PREFIX}${JSON.stringify(recovered)}`, {
        board,
        author: `${recovered.channel}:${recovered.actor}`,
      })
      return receiptFromAudit(recovered, before.task, true)
    }
    if (expectedStatuses.includes(before.task.status) && existingAudit.before_event_ids) {
      throw new Error(`Cannot recover approval event "${eventId}" without a new canonical ${action} event`)
    }
    if (before.task.status !== existingAudit.before_status) {
      throw new Error(`Cannot recover approval event "${eventId}" from status "${before.task.status}"`)
    }
  }

  if (hasApprovalEvent(before, eventId)) {
    return {
      ok: true,
      duplicate: true,
      action,
      actor,
      channel,
      event_id: eventId,
      canonical_event_id: null,
      run_id: before.task.current_run_id ?? null,
      before_status: before.task.status,
      after_status: before.task.status,
      timestamp: Math.floor(Date.now() / 1000),
      reason,
      task: before.task,
    }
  }

  assertApprovalTransition(before, action, reason || undefined)
  if (!existingAudit) {
    const timestamp = Math.floor(Date.now() / 1000)
    const prepared = await auditStore.prepare({
      schema: 1,
      phase: 'prepared',
      board,
      task_id: taskId,
      event_id: eventId,
      action,
      actor,
      channel,
      reason,
      reviewer: options.reviewer?.trim() || null,
      canonical_profile: process.env.HERMES_PROFILE?.trim() || 'default',
      before_status: before.task.status,
      before_event_ids: before.events.map(event => String(event.id)),
      after_status: null,
      canonical_event_id: null,
      run_id: before.task.current_run_id ?? null,
      timestamp,
      updated_at: timestamp,
    })
    if (!prepared.created) {
      assertMatchingAuditRecord(
        prepared.record,
        taskId,
        action,
        board,
        actor,
        channel,
        reason,
        options.reviewer?.trim() || null,
      )
      const persistedBeforeIds = [...(prepared.record.before_event_ids || [])].sort()
      const requestedBeforeIds = before.events.map(event => String(event.id)).sort()
      if (
        prepared.record.before_status !== before.task.status
        || persistedBeforeIds.length !== requestedBeforeIds.length
        || persistedBeforeIds.some((id, index) => id !== requestedBeforeIds[index])
      ) {
        throw new Error(`Approval event ID "${eventId}" is already bound to another action`)
      }
    }
  }
  await executeApprovalTransition(taskId, action, before, {
    ...options,
    board,
    actor,
    channel,
    eventId,
  }, reason)

  const after = await getTask(taskId, { board })
  if (!after) throw new Error(`Kanban task "${taskId}" disappeared after ${action}`)
  const expected = expectedApprovalStatuses(action)
  if (!expected.includes(after.task.status)) {
    throw new Error(`Kanban ${action} readback failed: expected ${expected.join('/')} but got ${after.task.status}`)
  }
  const canonicalEvent = latestCanonicalApprovalEvent(after, action, before.events.map(event => String(event.id)))
  if (!canonicalEvent) {
    throw new Error(`Kanban ${action} readback failed: canonical transition event was not found`)
  }
  const timestamp = canonicalEvent?.created_at || Math.floor(Date.now() / 1000)
  const durableAudit = await auditStore.complete(
    { board, taskId, eventId },
    {
      after_status: after.task.status,
      canonical_event_id: canonicalEvent?.id ?? null,
      run_id: canonicalEvent?.run_id ?? after.task.current_run_id ?? null,
      timestamp,
      updated_at: Math.floor(Date.now() / 1000),
    },
  )
  await addComment(taskId, `${APPROVAL_AUDIT_PREFIX}${JSON.stringify(durableAudit)}`, {
    board,
    author: `${channel}:${actor}`,
  })
  return {
    ok: true,
    duplicate: false,
    action,
    actor,
    channel,
    event_id: eventId,
    canonical_event_id: canonicalEvent?.id ?? null,
    run_id: canonicalEvent?.run_id ?? after.task.current_run_id ?? null,
    before_status: before.task.status,
    after_status: after.task.status,
    timestamp,
    reason,
    task: after.task,
  }
}

const approvalTaskLocks = new Map<string, Promise<void>>()

export function performApprovalAction(
  taskId: string,
  action: KanbanApprovalAction,
  options: KanbanApprovalActionOptions,
): Promise<KanbanApprovalReceipt> {
  const lockKey = `${normalizeBoardSlug(options.board)}\0${taskId}`
  const previous = approvalTaskLocks.get(lockKey) || Promise.resolve()
  const result = previous
    .catch(() => undefined)
    .then(() => performApprovalActionUnlocked(taskId, action, options))
  const barrier = result.then(() => undefined, () => undefined)
  approvalTaskLocks.set(lockKey, barrier)
  return result.finally(() => {
    if (approvalTaskLocks.get(lockKey) === barrier) approvalTaskLocks.delete(lockKey)
  })
}

export function buildWatchArgs(opts?: KanbanWatchOptions): string[] {
  const args = [...boardArgs(opts?.board), 'watch']
  if (opts?.kinds?.length) args.push('--kinds', opts.kinds.join(','))
  pushOptional(args, '--interval', opts?.interval ?? 0.5)
  return args
}

export function watchEvents(opts?: KanbanWatchOptions): ChildProcess {
  return spawnHermes(buildWatchArgs(opts), {
    stdio: ['ignore', 'pipe', 'pipe'],
    ...execOpts,
  })
}

export async function linkTasks(parentId: string, childId: string, opts?: KanbanBoardOptions): Promise<{ ok: boolean; output: string }> {
  const output = await execKanbanMutation(
    [...boardArgs(opts?.board), 'link', parentId, childId],
    'Hermes CLI: kanban link failed',
    'Failed to link kanban tasks',
  )
  return { ok: true, output }
}

export async function unlinkTasks(parentId: string, childId: string, opts?: KanbanBoardOptions): Promise<{ ok: boolean; output: string }> {
  const output = await execKanbanMutation(
    [...boardArgs(opts?.board), 'unlink', parentId, childId],
    'Hermes CLI: kanban unlink failed',
    'Failed to unlink kanban tasks',
  )
  return { ok: true, output }
}

export async function addComment(taskId: string, body: string, opts?: KanbanBoardOptions & { author?: string }): Promise<{ ok: boolean; output: string }> {
  const args = [...boardArgs(opts?.board), 'comment', taskId, body]
  pushOptional(args, '--author', opts?.author)
  try {
    const { stdout } = await execHermes(args, {
      maxBuffer: 50 * 1024 * 1024,
      timeout: 30000,
      ...execOpts,
    })
    return { ok: true, output: stdout }
  } catch (err: any) {
    logger.error(err, 'Hermes CLI: kanban comment failed')
    throw new Error(`Failed to comment on kanban task: ${err.message}`)
  }
}

export async function getTaskLog(taskId: string, opts?: KanbanBoardOptions & { tail?: number }): Promise<KanbanTaskLog> {
  const args = [...boardArgs(opts?.board), 'log', taskId]
  pushOptional(args, '--tail', opts?.tail)
  try {
    const { stdout } = await execHermes(args, {
      maxBuffer: 50 * 1024 * 1024,
      timeout: 30000,
      ...execOpts,
    })
    const sizeBytes = Buffer.byteLength(stdout, 'utf8')
    return {
      task_id: taskId,
      path: null,
      exists: true,
      size_bytes: sizeBytes,
      content: stdout,
      truncated: opts?.tail !== undefined && sizeBytes >= opts.tail,
    }
  } catch (err: any) {
    const detail = await getTask(taskId, opts)
    if (!detail) throw new Error('Kanban task not found')
    if ((err.code === 1 || err.status === 1) && isNoWorkerLogError(err)) {
      return {
        task_id: taskId,
        path: null,
        exists: false,
        size_bytes: 0,
        content: '',
        truncated: false,
      }
    }
    logger.error(err, 'Hermes CLI: kanban log failed')
    throw new Error(`Failed to read kanban task log: ${err.message}`)
  }
}

export async function getDiagnostics(opts?: KanbanBoardOptions & { task?: string; severity?: string }): Promise<unknown[]> {
  const args = [...boardArgs(opts?.board), 'diagnostics', '--json']
  pushOptional(args, '--task', opts?.task)
  pushOptional(args, '--severity', opts?.severity)
  try {
    const { stdout } = await execHermes(args, {
      maxBuffer: 50 * 1024 * 1024,
      timeout: 30000,
      ...execOpts,
    })
    return JSON.parse(stdout)
  } catch (err: any) {
    logger.error(err, 'Hermes CLI: kanban diagnostics failed')
    throw new Error(`Failed to get kanban diagnostics: ${err.message}`)
  }
}

export async function reclaimTask(taskId: string, opts?: KanbanBoardOptions & { reason?: string }): Promise<{ ok: boolean; output: string }> {
  const args = [...boardArgs(opts?.board), 'reclaim', taskId]
  pushOptional(args, '--reason', opts?.reason)
  try {
    const { stdout } = await execHermes(args, {
      maxBuffer: 50 * 1024 * 1024,
      timeout: 30000,
      ...execOpts,
    })
    return { ok: true, output: stdout }
  } catch (err: any) {
    logger.error(err, 'Hermes CLI: kanban reclaim failed')
    throw new Error(`Failed to reclaim kanban task: ${err.message}`)
  }
}

export async function reassignTask(taskId: string, profile: string, opts?: KanbanBoardOptions & { reclaim?: boolean; reason?: string }): Promise<{ ok: boolean; output: string }> {
  const args = [...boardArgs(opts?.board), 'reassign', taskId, profile]
  if (opts?.reclaim) args.push('--reclaim')
  pushOptional(args, '--reason', opts?.reason)
  try {
    const { stdout } = await execHermes(args, {
      maxBuffer: 50 * 1024 * 1024,
      timeout: 30000,
      ...execOpts,
    })
    return { ok: true, output: stdout }
  } catch (err: any) {
    logger.error(err, 'Hermes CLI: kanban reassign failed')
    throw new Error(`Failed to reassign kanban task: ${err.message}`)
  }
}

export async function specifyTask(taskId: string, opts?: KanbanBoardOptions & { author?: string }): Promise<unknown[]> {
  const args = [...boardArgs(opts?.board), 'specify', taskId, '--json']
  pushOptional(args, '--author', opts?.author)
  try {
    const { stdout } = await execHermes(args, {
      maxBuffer: 50 * 1024 * 1024,
      timeout: 30000,
      ...execOpts,
    })
    return parseJsonPayload(stdout)
  } catch (err: any) {
    logger.error(err, 'Hermes CLI: kanban specify failed')
    throw new Error(`Failed to specify kanban task: ${err.message}`)
  }
}

export async function dispatch(opts?: KanbanBoardOptions & { dryRun?: boolean; max?: number; failureLimit?: number }): Promise<unknown> {
  const args = [...boardArgs(opts?.board), 'dispatch', '--json']
  if (opts?.dryRun) args.push('--dry-run')
  pushOptional(args, '--max', opts?.max)
  pushOptional(args, '--failure-limit', opts?.failureLimit)
  try {
    const { stdout } = await execHermes(args, {
      maxBuffer: 50 * 1024 * 1024,
      timeout: 30000,
      ...execOpts,
    })
    return JSON.parse(stdout)
  } catch (err: any) {
    logger.error(err, 'Hermes CLI: kanban dispatch failed')
    throw new Error(`Failed to dispatch kanban tasks: ${err.message}`)
  }
}

export async function listTasks(opts?: {
  board?: string
  status?: string
  assignee?: string
  tenant?: string
  includeArchived?: boolean
}): Promise<KanbanTask[]> {
  const args = [...boardArgs(opts?.board), 'list', '--json']
  if (opts?.includeArchived) args.push('--archived')
  if (opts?.status) args.push('--status', opts.status)
  if (opts?.assignee) args.push('--assignee', opts.assignee)
  if (opts?.tenant) args.push('--tenant', opts.tenant)

  try {
    const { stdout } = await execHermes(args, {
      maxBuffer: 50 * 1024 * 1024,
      timeout: 30000,
      ...execOpts,
    })
    return JSON.parse(stdout)
  } catch (err: any) {
    logger.error(err, 'Hermes CLI: kanban list failed')
    throw new Error(`Failed to list kanban tasks: ${err.message}`)
  }
}

export async function getTask(taskId: string, opts?: KanbanBoardOptions): Promise<KanbanTaskDetail | null> {
  try {
    const { stdout } = await execHermes([...boardArgs(opts?.board), 'show', taskId, '--json'], {
      maxBuffer: 50 * 1024 * 1024,
      timeout: 30000,
      ...execOpts,
    })
    const detail = JSON.parse(stdout) as KanbanTaskDetail
    const resolvedTaskId = detail.task?.id || taskId
    detail.comments = (detail.comments || []).map((comment, index) => ({
      ...comment,
      id: comment.id ?? `${resolvedTaskId}:comment:${index}`,
      task_id: comment.task_id || resolvedTaskId,
    }))
    detail.events = (detail.events || []).map((event, index) => ({
      ...event,
      id: event.id ?? `${resolvedTaskId}:event:${index}`,
      task_id: event.task_id || resolvedTaskId,
    }))
    return detail
  } catch (err: any) {
    if (err.code === 1 || err.status === 1) return null
    logger.error(err, 'Hermes CLI: kanban show failed')
    throw new Error(`Failed to get kanban task: ${err.message}`)
  }
}

export async function createTask(
  title: string,
  opts?: {
    board?: string
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
  },
): Promise<KanbanTask> {
  const args = [...boardArgs(opts?.board), 'create', title, '--json']
  if (opts?.body) args.push('--body', opts.body)
  if (opts?.assignee) args.push('--assignee', opts.assignee)
  if (opts?.priority !== undefined) args.push('--priority', String(opts.priority))
  if (opts?.tenant) args.push('--tenant', opts.tenant)
  if (opts?.workspace) args.push('--workspace', opts.workspace)
  if (opts?.branch) args.push('--branch', opts.branch)
  if (opts?.triage) args.push('--triage')
  if (opts?.maxRuntime) args.push('--max-runtime', opts.maxRuntime)
  if (opts?.maxRetries !== undefined) args.push('--max-retries', String(opts.maxRetries))
  if (opts?.goalMode) args.push('--goal')
  if (opts?.goalMaxTurns !== undefined) args.push('--goal-max-turns', String(opts.goalMaxTurns))
  for (const skill of opts?.skills || []) {
    if (skill.trim()) args.push('--skill', skill.trim())
  }

  try {
    const { stdout } = await execHermes(args, {
      maxBuffer: 50 * 1024 * 1024,
      timeout: 30000,
      ...execOpts,
    })
    return JSON.parse(stdout)
  } catch (err: any) {
    logger.error(err, 'Hermes CLI: kanban create failed')
    throw new Error(`Failed to create kanban task: ${err.message}`)
  }
}

export async function completeTasks(
  taskIds: string[],
  summary?: string,
  opts?: KanbanBoardOptions & { operatorOverride?: boolean },
): Promise<void> {
  const args = [...boardArgs(opts?.board), 'complete', ...taskIds]
  if (summary) args.push('--summary', summary)

  if (!opts?.operatorOverride) {
    await execKanbanMutation(args, 'Hermes CLI: kanban complete failed', 'Failed to complete kanban tasks')
    return
  }

  // The canonical dashboard treats a human completion as an explicit
  // operator override. The CLI applies the goal judge to every goal-mode
  // completion, so run it with an isolated config that disables only the
  // auxiliary judge while keeping the real shared kanban home.
  const isolatedHome = await mkdtemp(join(tmpdir(), 'hermes-kanban-operator-'))
  try {
    await writeFile(
      join(isolatedHome, 'config.yaml'),
      'auxiliary:\n  goal_judge:\n    provider: __operator_override_disabled__\n',
      'utf8',
    )
    const kanbanHome = process.env.HERMES_KANBAN_HOME?.trim() || detectHermesRootHome()
    await execKanbanMutation(
      args,
      'Hermes CLI: kanban operator completion failed',
      'Failed to complete kanban tasks',
      {
        env: {
          ...process.env,
          HERMES_HOME: isolatedHome,
          HERMES_KANBAN_HOME: kanbanHome,
        },
      },
    )
  } finally {
    await rm(isolatedHome, { recursive: true, force: true }).catch(err => {
      logger.error(err, 'Hermes CLI: failed to clean up operator completion config')
    })
  }
}

export async function blockTask(taskId: string, reason: string, opts?: KanbanBoardOptions): Promise<void> {
  await execKanbanMutation(
    [...boardArgs(opts?.board), 'block', taskId, reason],
    'Hermes CLI: kanban block failed',
    'Failed to block kanban task',
  )
}

export async function unblockTasks(taskIds: string[], opts?: KanbanBoardOptions): Promise<void> {
  await execKanbanMutation(
    [...boardArgs(opts?.board), 'unblock', ...taskIds],
    'Hermes CLI: kanban unblock failed',
    'Failed to unblock kanban tasks',
  )
}

export async function assignTask(taskId: string, profile: string, opts?: KanbanBoardOptions): Promise<void> {
  await execKanbanMutation(
    [...boardArgs(opts?.board), 'assign', taskId, profile],
    'Hermes CLI: kanban assign failed',
    'Failed to assign kanban task',
  )
}

export async function archiveTasks(taskIds: string[], opts?: KanbanBoardOptions): Promise<void> {
  await execKanbanMutation(
    [...boardArgs(opts?.board), 'archive', ...taskIds],
    'Hermes CLI: kanban archive failed',
    'Failed to archive kanban tasks',
  )
}

async function applyBulkStatus(taskId: string, opts: KanbanBulkTaskUpdateOptions): Promise<void> {
  switch (opts.status) {
    case undefined:
      return
    case 'done':
      return completeTasks([taskId], opts.summary, opts)
    case 'blocked':
      return blockTask(taskId, opts.reason?.trim() || 'Bulk update', opts)
    case 'ready':
      return unblockTasks([taskId], opts)
    case 'archived':
      return archiveTasks([taskId], opts)
    default:
      throw new Error(`Bulk status ${opts.status} is not supported by the CLI bridge`)
  }
}

export async function bulkUpdateTasks(opts: KanbanBulkTaskUpdateOptions): Promise<KanbanBulkTaskUpdateResult> {
  const ids = opts.ids.map(id => id.trim()).filter(Boolean)
  const results: KanbanBulkTaskResult[] = []
  for (const id of ids) {
    try {
      if (opts.archive) await archiveTasks([id], opts)
      else await applyBulkStatus(id, opts)
      if (opts.assignee !== undefined) await assignTask(id, opts.assignee?.trim() || 'none', opts)
      results.push({ id, ok: true })
    } catch (err: any) {
      results.push({ id, ok: false, error: err?.message || String(err) })
    }
  }
  return { results }
}

export async function getStats(opts?: KanbanBoardOptions): Promise<KanbanStats> {
  try {
    const { stdout } = await execHermes([...boardArgs(opts?.board), 'stats', '--json'], {
      maxBuffer: 50 * 1024 * 1024,
      timeout: 30000,
      ...execOpts,
    })
    const raw = JSON.parse(stdout) as {
      by_status?: Record<string, unknown>
      by_assignee?: Record<string, unknown>
    }
    const byStatus: Record<string, number> = {}
    for (const [status, value] of Object.entries(raw.by_status || {})) {
      const count = Number(value)
      if (Number.isFinite(count) && count >= 0) byStatus[status] = count
    }
    const byAssignee: Record<string, number> = {}
    for (const [assignee, value] of Object.entries(raw.by_assignee || {})) {
      if (typeof value === 'number' && Number.isFinite(value)) {
        byAssignee[assignee] = value
        continue
      }
      if (value && typeof value === 'object') {
        byAssignee[assignee] = Object.values(value as Record<string, unknown>)
          .reduce<number>((total, count) => total + (Number.isFinite(Number(count)) ? Number(count) : 0), 0)
      }
    }
    const archivedTasks = await listTasks({ board: opts?.board, status: 'archived', includeArchived: true })
    byStatus.archived = archivedTasks.length
    for (const task of archivedTasks) {
      const assignee = task.assignee?.trim() || 'default'
      byAssignee[assignee] = (byAssignee[assignee] || 0) + 1
    }
    return {
      by_status: byStatus,
      by_assignee: byAssignee,
      total: Object.values(byStatus).reduce((total, count) => total + count, 0),
    }
  } catch (err: any) {
    logger.error(err, 'Hermes CLI: kanban stats failed')
    throw new Error(`Failed to get kanban stats: ${err.message}`)
  }
}

export async function listAttachments(taskId: string, opts?: KanbanBoardOptions): Promise<KanbanAttachment[]> {
  try {
    const { stdout } = await execHermes([...boardArgs(opts?.board), 'attachments', taskId, '--json'], {
      maxBuffer: 50 * 1024 * 1024,
      timeout: 30000,
      ...execOpts,
    })
    const attachments = JSON.parse(stdout)
    return Array.isArray(attachments) ? attachments : []
  } catch (err: any) {
    logger.error(err, 'Hermes CLI: kanban attachments failed')
    throw new Error(`Failed to list kanban attachments: ${err.message}`)
  }
}

export async function getAssignees(opts?: KanbanBoardOptions): Promise<KanbanAssignee[]> {
  try {
    const { stdout } = await execHermes([...boardArgs(opts?.board), 'assignees', '--json'], {
      maxBuffer: 50 * 1024 * 1024,
      timeout: 30000,
      ...execOpts,
    })
    return JSON.parse(stdout)
  } catch (err: any) {
    logger.error(err, 'Hermes CLI: kanban assignees failed')
    throw new Error(`Failed to get kanban assignees: ${err.message}`)
  }
}
