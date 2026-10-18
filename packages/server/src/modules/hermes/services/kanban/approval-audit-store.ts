import { createHash, randomUUID } from 'crypto'
import { link, mkdir, open, readFile, rename, unlink } from 'fs/promises'
import { dirname, join } from 'path'
import { config } from '../../../studio/public/config'
import type { KanbanApprovalAction, KanbanTaskStatus } from './kanban-service'

export interface KanbanApprovalAuditRecord {
  schema: 1
  phase: 'prepared' | 'completed'
  board: string
  task_id: string
  event_id: string
  action: KanbanApprovalAction
  actor: string
  channel: 'studio' | 'dingtalk'
  reason: string | null
  reviewer?: string | null
  canonical_profile?: string | null
  before_status: KanbanTaskStatus
  before_event_ids?: string[]
  after_status: KanbanTaskStatus | null
  canonical_event_id: number | string | null
  run_id: number | null
  timestamp: number
  updated_at: number
}

export interface KanbanApprovalAuditKey {
  board: string
  taskId: string
  eventId: string
}

export interface KanbanApprovalAuditStore {
  get(board: string, taskId: string, eventId: string): Promise<KanbanApprovalAuditRecord | null>
  prepare(record: KanbanApprovalAuditRecord): Promise<{ record: KanbanApprovalAuditRecord; created: boolean }>
  complete(
    key: KanbanApprovalAuditKey,
    patch: Pick<KanbanApprovalAuditRecord, 'after_status' | 'canonical_event_id' | 'run_id' | 'timestamp' | 'updated_at'>,
  ): Promise<KanbanApprovalAuditRecord>
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

function recordName(key: KanbanApprovalAuditKey): string {
  return `${createHash('sha256').update(`${key.board}\0${key.taskId}\0${key.eventId}`).digest('hex')}.json`
}

export class FileKanbanApprovalAuditStore implements KanbanApprovalAuditStore {
  constructor(private readonly root = join(config.appHome, 'kanban-approval', 'audit')) {}

  private path(key: KanbanApprovalAuditKey): string {
    return join(this.root, recordName(key))
  }

  async get(board: string, taskId: string, eventId: string): Promise<KanbanApprovalAuditRecord | null> {
    try {
      return JSON.parse(await readFile(this.path({ board, taskId, eventId }), 'utf8')) as KanbanApprovalAuditRecord
    } catch (error: any) {
      if (error?.code === 'ENOENT') return null
      throw error
    }
  }

  async prepare(record: KanbanApprovalAuditRecord): Promise<{ record: KanbanApprovalAuditRecord; created: boolean }> {
    const existing = await this.get(record.board, record.task_id, record.event_id)
    if (existing) return { record: existing, created: false }
    const created = await atomicCreateJson(
      this.path({ board: record.board, taskId: record.task_id, eventId: record.event_id }),
      record,
    )
    if (!created) {
      const raced = await this.get(record.board, record.task_id, record.event_id)
      if (!raced) throw new Error(`Approval audit intent "${record.event_id}" could not be read after creation race`)
      return { record: raced, created: false }
    }
    return { record, created: true }
  }

  async complete(
    key: KanbanApprovalAuditKey,
    patch: Pick<KanbanApprovalAuditRecord, 'after_status' | 'canonical_event_id' | 'run_id' | 'timestamp' | 'updated_at'>,
  ): Promise<KanbanApprovalAuditRecord> {
    const existing = await this.get(key.board, key.taskId, key.eventId)
    if (!existing) throw new Error(`Approval audit intent "${key.eventId}" was not found`)
    const completed: KanbanApprovalAuditRecord = { ...existing, ...patch, phase: 'completed' }
    await atomicWriteJson(this.path(key), completed)
    return completed
  }
}

let defaultStore: KanbanApprovalAuditStore | null = null

export function getKanbanApprovalAuditStore(): KanbanApprovalAuditStore {
  defaultStore ||= new FileKanbanApprovalAuditStore()
  return defaultStore
}
