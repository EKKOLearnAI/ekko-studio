import type { ChildProcess } from 'child_process'
import { createHash, randomUUID } from 'crypto'
import { link, mkdir, open, readdir, readFile, rename, unlink } from 'fs/promises'
import { dirname, join } from 'path'
import { config } from '../../../studio/public/config'
import { logger } from '../../../studio/public/logging'
import { killOwnedProcessTree } from '../../../studio/public/process-tree'
import {
  buildDingTalkApprovalPayload,
  DingTalkNotificationError,
  sendDingTalkApprovalNotification,
  type DingTalkApprovalPayload,
  type DingTalkNotificationResult,
} from './dingtalk-approval'
import {
  getTask,
  listTasks,
  normalizeBoardSlug,
  watchEvents,
  type KanbanEvent,
  type KanbanTask,
  type KanbanTaskDetail,
} from './kanban-service'

export interface DingTalkApprovalOutboxRecord {
  schema: 1
  event_id: string
  canonical_event_key: string
  canonical_kind: 'review_requested'
  canonical_run_id: number | null
  canonical_created_at: number
  board: string
  task_id: string
  payload: DingTalkApprovalPayload
  status: 'pending' | 'accepted' | 'failed'
  configured: boolean
  api_accepted: boolean
  attempts: number
  recipient_confirmed: false
  retryable: boolean
  error: string | null
  created_at: number
  updated_at: number
}

export interface DingTalkApprovalOutboxStore {
  get(eventId: string): Promise<DingTalkApprovalOutboxRecord | null>
  list(): Promise<DingTalkApprovalOutboxRecord[]>
  enqueue(record: DingTalkApprovalOutboxRecord): Promise<{ record: DingTalkApprovalOutboxRecord; created: boolean }>
  save(record: DingTalkApprovalOutboxRecord): Promise<void>
}

export interface DingTalkApprovalDiscoveryCursor {
  get(board: string): Promise<number | null>
  save(board: string, timestamp: number): Promise<void>
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporaryPath = `${path}.tmp.${process.pid}.${randomUUID()}`
  const handle = await open(temporaryPath, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await handle.sync()
    await handle.close()
    await rename(temporaryPath, path)
  } catch (error) {
    await handle.close().catch(() => {})
    await unlink(temporaryPath).catch(() => {})
    throw error
  }
}

async function atomicCreateJson(path: string, value: unknown): Promise<boolean> {
  await mkdir(dirname(path), { recursive: true })
  const temporaryPath = `${path}.tmp.${process.pid}.${randomUUID()}`
  const handle = await open(temporaryPath, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await handle.sync()
    await handle.close()
    try {
      await link(temporaryPath, path)
      return true
    } catch (error: any) {
      if (error?.code === 'EEXIST') return false
      throw error
    }
  } finally {
    await handle.close().catch(() => {})
    await unlink(temporaryPath).catch(() => {})
  }
}

function outboxFilename(eventId: string): string {
  return `${createHash('sha256').update(eventId).digest('hex')}.json`
}

export class FileDingTalkApprovalOutboxStore implements DingTalkApprovalOutboxStore {
  constructor(private readonly root = join(config.appHome, 'kanban-approval', 'dingtalk-outbox')) {}

  private path(eventId: string): string {
    return join(this.root, outboxFilename(eventId))
  }

  async get(eventId: string): Promise<DingTalkApprovalOutboxRecord | null> {
    try {
      return JSON.parse(await readFile(this.path(eventId), 'utf8')) as DingTalkApprovalOutboxRecord
    } catch (error: any) {
      if (error?.code === 'ENOENT') return null
      throw error
    }
  }

  async list(): Promise<DingTalkApprovalOutboxRecord[]> {
    let filenames: string[]
    try {
      filenames = await readdir(this.root)
    } catch (error: any) {
      if (error?.code === 'ENOENT') return []
      throw error
    }
    const records = await Promise.all(filenames
      .filter(filename => filename.endsWith('.json'))
      .map(async filename => JSON.parse(await readFile(join(this.root, filename), 'utf8')) as DingTalkApprovalOutboxRecord))
    return records.sort((left, right) => left.created_at - right.created_at)
  }

  async enqueue(record: DingTalkApprovalOutboxRecord): Promise<{ record: DingTalkApprovalOutboxRecord; created: boolean }> {
    const existing = await this.get(record.event_id)
    if (existing) return { record: existing, created: false }
    const created = await atomicCreateJson(this.path(record.event_id), record)
    if (!created) {
      const raced = await this.get(record.event_id)
      if (!raced) throw new Error(`DingTalk approval outbox event "${record.event_id}" could not be read after creation race`)
      return { record: raced, created: false }
    }
    return { record, created: true }
  }

  async save(record: DingTalkApprovalOutboxRecord): Promise<void> {
    await atomicWriteJson(this.path(record.event_id), record)
  }

  readonly cursor: DingTalkApprovalDiscoveryCursor = {
    get: async board => {
      try {
        const value = JSON.parse(await readFile(join(this.root, 'cursors', outboxFilename(board)), 'utf8'))
        return Number.isFinite(value?.timestamp) ? Number(value.timestamp) : null
      } catch (error: any) {
        if (error?.code === 'ENOENT') return null
        throw error
      }
    },
    save: async (board, timestamp) => {
      await atomicWriteJson(join(this.root, 'cursors', outboxFilename(board)), { timestamp })
    },
  }
}

const deliveryLocks = new Map<string, Promise<DingTalkApprovalOutboxRecord>>()

function stableEventIdentity(board: string, taskId: string, event: KanbanEvent, index: number): string {
  return JSON.stringify([board, taskId, String(event.id || index)])
}

function notificationEventId(canonicalEventKey: string): string {
  return `kanban-review-${createHash('sha256').update(canonicalEventKey).digest('hex').slice(0, 24)}`
}

function latestActiveReviewEvent(detail: KanbanTaskDetail): { event: KanbanEvent; index: number } | null {
  let reviewIndex = -1
  for (let index = detail.events.length - 1; index >= 0; index -= 1) {
    if (detail.events[index].kind === 'review_requested') {
      reviewIndex = index
      break
    }
  }
  if (reviewIndex < 0) return null
  const supersedingKinds = new Set(['completed', 'changes_requested', 'review_reopened', 'archived'])
  if (detail.events.slice(reviewIndex + 1).some(event => supersedingKinds.has(event.kind))) return null
  return { event: detail.events[reviewIndex], index: reviewIndex }
}

function notificationResultFromError(error: unknown): DingTalkNotificationResult {
  if (error instanceof DingTalkNotificationError) return error.result
  const message = error instanceof Error ? error.message : String(error)
  return {
    configured: Boolean(process.env.DINGTALK_APPROVAL_WEBHOOK_URL?.trim()),
    api_accepted: false,
    attempts: 0,
    recipient_confirmed: false,
    retryable: true,
    error: message,
  }
}

async function deliverOutboxRecord(
  eventId: string,
  store: DingTalkApprovalOutboxStore,
  send: typeof sendDingTalkApprovalNotification,
  now: () => number,
): Promise<DingTalkApprovalOutboxRecord> {
  const active = deliveryLocks.get(eventId)
  if (active) return active

  const delivery = (async () => {
    const current = await store.get(eventId)
    if (!current) throw new Error(`DingTalk approval outbox event "${eventId}" was not found`)
    if (current.status === 'accepted') return current

    let result: DingTalkNotificationResult
    try {
      result = await send(current.payload)
    } catch (error) {
      result = notificationResultFromError(error)
    }
    const updated: DingTalkApprovalOutboxRecord = {
      ...current,
      status: result.api_accepted ? 'accepted' : result.retryable === false ? 'failed' : 'pending',
      configured: result.configured,
      api_accepted: result.api_accepted,
      attempts: current.attempts + result.attempts,
      recipient_confirmed: false,
      retryable: result.retryable !== false,
      error: result.error || null,
      updated_at: now(),
    }
    await store.save(updated)
    return updated
  })()
  deliveryLocks.set(eventId, delivery)
  try {
    return await delivery
  } finally {
    if (deliveryLocks.get(eventId) === delivery) deliveryLocks.delete(eventId)
  }
}

export interface ReconcileDingTalkApprovalOutboxOptions {
  store?: DingTalkApprovalOutboxStore
  cursor?: DingTalkApprovalDiscoveryCursor
  listTasks?: typeof listTasks
  getTask?: typeof getTask
  send?: typeof sendDingTalkApprovalNotification
  studioUrl?: string
  now?: () => number
}

export async function reconcileDingTalkApprovalEvent(
  boardInput: string,
  taskId: string,
  canonicalEventId: string,
  options: ReconcileDingTalkApprovalOutboxOptions = {},
): Promise<DingTalkApprovalOutboxRecord | null> {
  const board = normalizeBoardSlug(boardInput)
  const store = options.store || new FileDingTalkApprovalOutboxStore()
  const read = options.getTask || getTask
  const send = options.send || sendDingTalkApprovalNotification
  const now = options.now || (() => Math.floor(Date.now() / 1000))
  const detail = await read(taskId, { board })
  if (!detail) return null
  const timestampMatch = canonicalEventId.match(/^minute:(\d+)$/)
  const eventIndex = timestampMatch
    ? detail.events.findLastIndex(event => (
        event.kind === 'review_requested'
        && event.created_at >= Number(timestampMatch[1])
        && event.created_at < Number(timestampMatch[1]) + 60
      ))
    : detail.events.findIndex(event => String(event.id) === canonicalEventId)
  const event = eventIndex >= 0 ? detail.events[eventIndex] : null
  if (!event || event.kind !== 'review_requested') return null

  const canonicalEventKey = stableEventIdentity(board, taskId, event, eventIndex)
  const eventId = notificationEventId(canonicalEventKey)
  const timestamp = now()
  const studioBaseUrl = (options.studioUrl || process.env.HERMES_STUDIO_PUBLIC_URL || `http://127.0.0.1:${config.port}`).replace(/\/$/, '')
  const studioUrl = `${studioBaseUrl}/#/hermes/kanban?board=${encodeURIComponent(board)}&task=${encodeURIComponent(taskId)}`
  const queued = await store.enqueue({
    schema: 1,
    event_id: eventId,
    canonical_event_key: canonicalEventKey,
    canonical_kind: 'review_requested',
    canonical_run_id: event.run_id ?? null,
    canonical_created_at: event.created_at,
    board,
    task_id: taskId,
    payload: buildDingTalkApprovalPayload({ task: detail.task, board, eventId, studioUrl }),
    status: 'pending',
    configured: false,
    api_accepted: false,
    attempts: 0,
    recipient_confirmed: false,
    retryable: true,
    error: null,
    created_at: timestamp,
    updated_at: timestamp,
  })
  if (queued.record.status !== 'pending') return queued.record
  return deliverOutboxRecord(eventId, store, send, now)
}

export async function reconcileDingTalkApprovalOutbox(
  boardInput: string,
  options: ReconcileDingTalkApprovalOutboxOptions = {},
): Promise<DingTalkApprovalOutboxRecord[]> {
  const board = normalizeBoardSlug(boardInput)
  const store = options.store || new FileDingTalkApprovalOutboxStore()
  const cursor = options.cursor || (store instanceof FileDingTalkApprovalOutboxStore ? store.cursor : undefined)
  const list = options.listTasks || listTasks
  const read = options.getTask || getTask
  const send = options.send || sendDingTalkApprovalNotification
  const now = options.now || (() => Math.floor(Date.now() / 1000))
  const studioBaseUrl = (options.studioUrl || process.env.HERMES_STUDIO_PUBLIC_URL || `http://127.0.0.1:${config.port}`).replace(/\/$/, '')
  const results: DingTalkApprovalOutboxRecord[] = []
  const processed = new Set<string>()
  const reconciliationStartedAt = now()
  const discoverySince = cursor ? await cursor.get(board) : null

  for (const pending of (await store.list()).filter(record => record.board === board && record.status === 'pending')) {
    results.push(await deliverOutboxRecord(pending.event_id, store, send, now))
    processed.add(pending.event_id)
  }

  const tasks = await list({ board, includeArchived: true })
  for (const task of tasks) {
    const detail = await read(task.id, { board })
    if (!detail) continue
    const activeReview = latestActiveReviewEvent(detail)
    const candidates = new Set<string>()
    if (activeReview) candidates.add(String(activeReview.event.id))
    if (discoverySince !== null) {
      for (const event of detail.events) {
        if (event.kind === 'review_requested' && event.created_at >= discoverySince) {
          candidates.add(String(event.id))
        }
      }
    }
    for (const canonicalEventId of candidates) {
      const delivered = await reconcileDingTalkApprovalEvent(board, task.id, canonicalEventId, {
        ...options,
        store,
        getTask: read,
        send,
        studioUrl: studioBaseUrl,
        now,
      })
      if (delivered && !processed.has(delivered.event_id)) {
        results.push(delivered)
        processed.add(delivered.event_id)
      }
    }
  }
  if (cursor) await cursor.save(board, reconciliationStartedAt)
  return results
}

export function dingtalkApprovalBoards(env: Record<string, string | undefined> = process.env): string[] {
  const raw = env.HERMES_STUDIO_KANBAN_APPROVAL_BOARDS
  const values = (raw === undefined ? ['codex-tech'] : raw.split(','))
    .map(value => value.trim().toLowerCase())
    .filter(Boolean)
  if (values.includes('*')) return []
  return [...new Set(values)].map(normalizeBoardSlug)
}

export interface DingTalkApprovalOutboxDispatcher {
  close(): void
}

export function startDingTalkApprovalOutboxDispatcher(options: {
  boards?: string[]
  reconcileIntervalMs?: number
  watch?: typeof watchEvents
  reconcile?: typeof reconcileDingTalkApprovalOutbox
  reconcileEvent?: typeof reconcileDingTalkApprovalEvent
} = {}): DingTalkApprovalOutboxDispatcher {
  const boards = options.boards || dingtalkApprovalBoards()
  const reconcile = options.reconcile || reconcileDingTalkApprovalOutbox
  const reconcileEvent = options.reconcileEvent || reconcileDingTalkApprovalEvent
  const watch = options.watch || watchEvents
  const children: ChildProcess[] = []
  let closed = false
  let reconciling: Promise<void> | null = null
  let reconcileRequested = false

  const reconcileAll = () => {
    if (closed) return Promise.resolve()
    if (reconciling) {
      reconcileRequested = true
      return reconciling
    }
    reconciling = (async () => {
      do {
        reconcileRequested = false
        await Promise.all(boards.map(board => reconcile(board)))
      } while (reconcileRequested && !closed)
    })()
      .catch(error => logger.error(error, 'DingTalk approval outbox reconciliation failed'))
      .finally(() => { reconciling = null })
    return reconciling
  }

  for (const board of boards) {
    try {
      const child = watch({ board, interval: 0.5, kinds: ['review_requested'] })
      children.push(child)
      let stdoutBuffer = ''
      child.stdout?.on('data', chunk => {
        stdoutBuffer += String(chunk)
        const lines = stdoutBuffer.split(/\r?\n/)
        stdoutBuffer = lines.pop() || ''
        for (const line of lines) {
          const match = line.match(/^\[([^\]]+)]\s+(\S+)\s+review_requested\b/)
          if (!match) continue
          const minuteStart = Math.floor(new Date(match[1].replace(' ', 'T')).getTime() / 60_000) * 60
          if (!Number.isFinite(minuteStart)) continue
          void reconcileEvent(board, match[2], `minute:${minuteStart}`)
            .catch(error => logger.error(error, 'DingTalk canonical review event reconciliation failed'))
        }
        void reconcileAll()
      })
      child.on('error', error => logger.error(error, 'DingTalk approval event watcher failed'))
    } catch (error) {
      logger.error(error, 'DingTalk approval event watcher failed to start')
    }
  }
  void reconcileAll()
  const timer = setInterval(() => { void reconcileAll() }, options.reconcileIntervalMs ?? 60_000)
  timer.unref?.()

  return {
    close() {
      if (closed) return
      closed = true
      clearInterval(timer)
      for (const child of children) {
        killOwnedProcessTree(child.pid, () => {
          if (!child.killed) child.kill()
        })
      }
    },
  }
}

export function notificationResultFromOutboxRecord(record: DingTalkApprovalOutboxRecord): DingTalkNotificationResult {
  return {
    configured: record.configured,
    api_accepted: record.api_accepted,
    attempts: record.attempts,
    recipient_confirmed: false,
    retryable: record.retryable,
    ...(record.error ? { error: record.error } : {}),
  }
}
