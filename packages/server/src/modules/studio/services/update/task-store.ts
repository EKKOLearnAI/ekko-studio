import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { config } from '../../public/config'
import type {
  UpdateTaskOwner,
  UpdateTaskRecord,
  UpdateTaskStage,
  UpdateTaskStatus,
  UpdateTaskStatusResponse,
  UpdateStrategy,
} from './types'

export const INTERRUPTED_UPDATE_TASK_ERROR_PREFIX = 'Previous update task was interrupted'

export const MAX_TASK_ERROR_CHARS = 600
const TRUNCATED_TASK_ERROR_NOTE = '\n…[truncated, see run log for full output]'

export function summarizeTaskError(error: string | null | undefined): string {
  const raw = (error ?? '').trim()
  if (!raw) return ''
  if (raw.length <= MAX_TASK_ERROR_CHARS) return raw
  return raw.slice(0, MAX_TASK_ERROR_CHARS).trimEnd() + TRUNCATED_TASK_ERROR_NOTE
}

type UpdateTaskPatch = Partial<Pick<
  UpdateTaskRecord,
  'owner' | 'status' | 'stage' | 'message' | 'targetVersion' | 'warning' | 'error' | 'logPath' | 'rollbackMessage' | 'healthcheckUrl' | 'heartbeatAt' | 'finishedAt'
>>

interface PersistedUpdateTaskState {
  currentTask: UpdateTaskRecord | null
  lastTask: UpdateTaskRecord | null
}

function isTaskRecord(value: unknown): value is UpdateTaskRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.id === 'string'
    && typeof record.strategy === 'string'
    && (record.owner === undefined || typeof record.owner === 'string')
    && typeof record.status === 'string'
    && typeof record.stage === 'string'
    && typeof record.message === 'string'
    && typeof record.targetVersion === 'string'
    && typeof record.warning === 'string'
    && typeof record.error === 'string'
    && typeof record.logPath === 'string'
    && typeof record.rollbackMessage === 'string'
    && typeof record.healthcheckUrl === 'string'
    && (record.heartbeatAt === undefined || typeof record.heartbeatAt === 'string')
    && typeof record.startedAt === 'string'
    && (typeof record.finishedAt === 'string' || record.finishedAt === null)
}

function normalizeTaskOwner(value: unknown): UpdateTaskOwner {
  return value === 'runtime' ? 'runtime' : 'controller'
}

function normalizeTaskRecord(record: UpdateTaskRecord): UpdateTaskRecord {
  return {
    ...record,
    owner: normalizeTaskOwner(record.owner),
    heartbeatAt: typeof record.heartbeatAt === 'string' && record.heartbeatAt
      ? record.heartbeatAt
      : record.startedAt,
  }
}

function normalizePersistedState(payload: unknown): PersistedUpdateTaskState {
  if (!payload || typeof payload !== 'object') {
    return { currentTask: null, lastTask: null }
  }
  const candidate = payload as Record<string, unknown>
  return {
    currentTask: isTaskRecord(candidate.currentTask) ? normalizeTaskRecord(candidate.currentTask) : null,
    lastTask: isTaskRecord(candidate.lastTask) ? normalizeTaskRecord(candidate.lastTask) : null,
  }
}

function isRunningTask(task: UpdateTaskRecord | null): task is UpdateTaskRecord {
  return Boolean(task && (task.status === 'queued' || task.status === 'running'))
}

function interruptedTaskMessage(stage: UpdateTaskStage): string {
  return `Previous update task was interrupted during ${stage}.`
}

function isRuntimeOwnedTask(task: UpdateTaskRecord | null): task is UpdateTaskRecord {
  return Boolean(task && task.owner === 'runtime')
}

function isTaskHeartbeatStale(task: UpdateTaskRecord, timeoutMs: number): boolean {
  const heartbeatAt = Date.parse(task.heartbeatAt || task.startedAt)
  if (!Number.isFinite(heartbeatAt)) return true
  return (Date.now() - heartbeatAt) > timeoutMs
}

function isInterruptedTaskRecord(task: UpdateTaskRecord | null): task is UpdateTaskRecord {
  return Boolean(task && task.error.startsWith(INTERRUPTED_UPDATE_TASK_ERROR_PREFIX))
}

export class UpdateTaskStore {
  private currentTask: UpdateTaskRecord | null = null
  private lastTask: UpdateTaskRecord | null = null
  private readonly stateFilePath: string

  constructor(stateFilePath = config.update.stateFile) {
    this.stateFilePath = stateFilePath
    this.syncFromDisk()
  }

  getStateFilePath(): string {
    return this.stateFilePath
  }

  private snapshot(): PersistedUpdateTaskState {
    return {
      currentTask: this.getCurrentTask(),
      lastTask: this.getLastTask(),
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.stateFilePath), { recursive: true })
    const tempPath = `${this.stateFilePath}.tmp`
    writeFileSync(tempPath, JSON.stringify(this.snapshot(), null, 2), 'utf-8')
    renameSync(tempPath, this.stateFilePath)
  }

  syncFromDisk(): void {
    if (!existsSync(this.stateFilePath)) {
      return
    }
    try {
      const payload = JSON.parse(readFileSync(this.stateFilePath, 'utf-8'))
      const restored = normalizePersistedState(payload)
      this.currentTask = restored.currentTask
      this.lastTask = restored.lastTask
    } catch (error) {
      console.warn('[update] failed to load persisted task state:', error)
      this.currentTask = null
    }
  }

  recoverInterruptedTask(): UpdateTaskRecord | null {
    if (!isRunningTask(this.currentTask)) {
      return null
    }

    const message = interruptedTaskMessage(this.currentTask.stage)
    const recoveredTask: UpdateTaskRecord = {
      ...this.currentTask,
      status: 'failed',
      stage: 'failed',
      message,
      error: message,
      finishedAt: new Date().toISOString(),
    }
    this.lastTask = recoveredTask
    this.currentTask = null
    this.persist()
    return this.getLastTask()
  }

  recoverInterruptedTaskIfStale(timeoutMs = config.update.taskHeartbeatTimeoutMs): UpdateTaskRecord | null {
    if (!isRunningTask(this.currentTask)) {
      return null
    }
    if (isRuntimeOwnedTask(this.currentTask) && !isTaskHeartbeatStale(this.currentTask, timeoutMs)) {
      return null
    }
    return this.recoverInterruptedTask()
  }

  clearRecoveredInterruptedTask(): UpdateTaskRecord | null {
    if (this.currentTask || !isInterruptedTaskRecord(this.lastTask)) {
      return null
    }

    const clearedTask = this.getLastTask()
    this.lastTask = null
    if (existsSync(this.stateFilePath)) {
      unlinkSync(this.stateFilePath)
    }
    return clearedTask
  }

  clearStaleFinishedTask(): UpdateTaskRecord | null {
    if (this.currentTask || !this.lastTask?.finishedAt) {
      return null
    }

    const clearedTask = this.getLastTask()
    this.lastTask = null
    if (existsSync(this.stateFilePath)) {
      unlinkSync(this.stateFilePath)
    }
    return clearedTask
  }

  createTask(strategy: UpdateStrategy, initialMessage: string): UpdateTaskRecord {
    const task: UpdateTaskRecord = {
      id: `update-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      strategy,
      owner: 'controller',
      status: 'queued',
      stage: 'queued',
      message: initialMessage,
      targetVersion: '',
      warning: '',
      error: '',
      logPath: '',
      rollbackMessage: '',
      healthcheckUrl: '',
      heartbeatAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      finishedAt: null,
    }
    this.currentTask = task
    this.persist()
    return task
  }

  getCurrentTask(): UpdateTaskRecord | null {
    return this.currentTask ? { ...this.currentTask } : null
  }

  getLastTask(): UpdateTaskRecord | null {
    return this.lastTask ? { ...this.lastTask } : null
  }

  getStatus(webuiVersion?: string, webuiLatest?: string, webuiUpdateAvailable?: boolean): UpdateTaskStatusResponse {
    return {
      currentTask: this.getCurrentTask(),
      lastTask: this.getLastTask(),
      webui_version: webuiVersion,
      webui_latest: webuiLatest,
      webui_update_available: webuiUpdateAvailable,
    }
  }

  patchCurrentTask(patch: UpdateTaskPatch): UpdateTaskRecord | null {
    if (!this.currentTask) return null
    const sanitizedPatch = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    ) as UpdateTaskPatch
    const nextHeartbeatAt = sanitizedPatch.heartbeatAt ?? new Date().toISOString()
    this.currentTask = {
      ...this.currentTask,
      ...sanitizedPatch,
      heartbeatAt: nextHeartbeatAt,
    }
    this.persist()
    return this.getCurrentTask()
  }

  updateCurrentStage(
    stage: UpdateTaskStage,
    message: string,
    overrides: Partial<Pick<UpdateTaskRecord, 'status' | 'targetVersion' | 'warning' | 'error' | 'logPath' | 'rollbackMessage' | 'healthcheckUrl'>> = {},
  ): UpdateTaskRecord | null {
    return this.patchCurrentTask({
      stage,
      message,
      status: overrides.status ?? 'running',
      targetVersion: overrides.targetVersion,
      warning: overrides.warning,
      error: overrides.error,
      logPath: overrides.logPath,
      rollbackMessage: overrides.rollbackMessage,
      healthcheckUrl: overrides.healthcheckUrl,
    })
  }

  handoffCurrentTaskToRuntime(
    overrides: Partial<Pick<UpdateTaskRecord, 'message' | 'stage' | 'targetVersion' | 'warning' | 'logPath' | 'healthcheckUrl'>> = {},
  ): UpdateTaskRecord | null {
    return this.patchCurrentTask({
      owner: 'runtime',
      status: 'running',
      stage: overrides.stage,
      message: overrides.message,
      targetVersion: overrides.targetVersion,
      warning: overrides.warning,
      logPath: overrides.logPath,
      healthcheckUrl: overrides.healthcheckUrl,
    })
  }

  completeCurrentTask(stage: Extract<UpdateTaskStage, 'succeeded' | 'failed'>, message: string, error = ''): UpdateTaskRecord | null {
    const status: UpdateTaskStatus = stage === 'succeeded' ? 'succeeded' : 'failed'
    const finishedTask = this.patchCurrentTask({
      status,
      stage,
      message,
      error,
      finishedAt: new Date().toISOString(),
    })
    if (!finishedTask) return null
    this.lastTask = finishedTask
    this.currentTask = null
    this.persist()
    return finishedTask
  }

  markRolledBack(message: string, rollbackMessage: string): UpdateTaskRecord | null {
    const finishedTask = this.patchCurrentTask({
      status: 'failed',
      stage: 'rolled_back',
      message,
      rollbackMessage,
      finishedAt: new Date().toISOString(),
    })
    if (!finishedTask) return null
    this.lastTask = finishedTask
    this.currentTask = null
    this.persist()
    return finishedTask
  }

  clear(): void {
    this.currentTask = null
    this.lastTask = null
    if (existsSync(this.stateFilePath)) {
      unlinkSync(this.stateFilePath)
    }
  }
}

export const updateTaskStore = new UpdateTaskStore()
