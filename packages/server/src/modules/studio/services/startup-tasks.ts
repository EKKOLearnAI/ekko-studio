import { join, resolve } from 'path'
import { config } from '../public/config'
import { logger } from '../public/logging'
import { safeFileStore } from '../public/safe-file-store'

export interface StartupTask {
  /** Permanent identifier. Add a new ID when introducing another operation. */
  id: string
  title: string
  /** Identifies the data being changed, e.g. the absolute Hermes home path. */
  scope: string
  /** Must tolerate retry after a crash between execution and saving completion. */
  run: () => Promise<void>
}

interface TaskRecord {
  id: string
  scope: string
  status: 'completed' | 'failed'
  attempts: number
  lastAttemptAt: string
  completedAt?: string
}

interface StartupTaskState {
  version: 1
  tasks: TaskRecord[]
}

function readState(raw: string | undefined): StartupTaskState {
  if (raw === undefined) return { version: 1, tasks: [] }
  let state: StartupTaskState
  try {
    state = JSON.parse(raw)
  } catch {
    throw new Error('Invalid startup task state; refusing to rerun recorded tasks')
  }
  if (!state || state.version !== 1 || !Array.isArray(state.tasks)) {
    throw new Error('Unsupported startup task state')
  }
  const seen = new Set<string>()
  for (const record of state.tasks) {
    if (!record || typeof record.id !== 'string' || !record.id || typeof record.scope !== 'string' || !record.scope
      || !['completed', 'failed'].includes(record.status)
      || !Number.isSafeInteger(record.attempts) || record.attempts < 1
      || typeof record.lastAttemptAt !== 'string' || !Number.isFinite(Date.parse(record.lastAttemptAt))
      || (record.status === 'completed' && (typeof record.completedAt !== 'string' || !Number.isFinite(Date.parse(record.completedAt))))) {
      throw new Error('Invalid startup task record')
    }
    const key = JSON.stringify([record.id, record.scope])
    if (seen.has(key)) throw new Error('Duplicate startup task record')
    seen.add(key)
  }
  return state
}

export async function runStartupTasks(
  tasks: readonly StartupTask[],
  stateFile = join(config.appHome, 'startup-tasks.json'),
): Promise<{ completed: string[]; skipped: string[]; failed: string[] }> {
  const ids = new Set<string>()
  for (const task of tasks) {
    if (!task.id.trim() || !task.scope.trim() || ids.has(task.id)) {
      throw new Error('Startup tasks require unique IDs and nonempty scopes')
    }
    ids.add(task.id)
  }
  const path = resolve(stateFile)
  const result = { completed: [] as string[], skipped: [] as string[], failed: [] as string[] }
  for (const task of tasks) {
    // Hold the state lock through execution and completion recording, so two
    // callers in this server cannot run the same pending task concurrently.
    const status = await safeFileStore.updateTexts([path], async current => {
      const state = readState(current[path])
      const index = state.tasks.findIndex(record => record.id === task.id && record.scope === task.scope)
      const previous = state.tasks[index]
      if (previous?.status === 'completed') return { files: {}, result: 'skipped' as const }

      const record: TaskRecord = {
        id: task.id,
        scope: task.scope,
        status: 'failed',
        attempts: (previous?.attempts || 0) + 1,
        lastAttemptAt: new Date().toISOString(),
      }
      try {
        await task.run()
        record.status = 'completed'
        record.completedAt = new Date().toISOString()
      } catch {
        // Task errors may contain configuration excerpts or credentials.
        logger.warn({ taskId: task.id }, '[startup-tasks] task failed; remaining tasks deferred until next startup')
      }
      if (index < 0) state.tasks.push(record)
      else state.tasks[index] = record
      return { files: { [path]: JSON.stringify(state, null, 2) + '\n' }, result: record.status }
    }, { backup: true })

    if (status === 'skipped') result.skipped.push(task.id)
    else if (status === 'completed') {
      result.completed.push(task.id)
      logger.info({ taskId: task.id, title: task.title }, '[startup-tasks] task completed')
    } else {
      result.failed.push(task.id)
      break
    }
  }
  return result
}
