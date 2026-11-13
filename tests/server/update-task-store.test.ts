import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { UpdateTaskStore, updateTaskStore } from '../../packages/server/src/modules/studio/services/update/task-store'

describe('update task store', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    updateTaskStore.clear()
    while (tempDirs.length) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true })
    }
  })

  function createStore() {
    const dir = mkdtempSync(join(tmpdir(), 'hermes-update-task-store-'))
    tempDirs.push(dir)
    return new UpdateTaskStore(join(dir, 'update-task-state.json'))
  }

  it('creates a queued task and exposes it as the current task', () => {
    const store = createStore()
    const task = store.createTask('source-deploy', 'accepted')

    expect(task.id).toContain('update-')
    expect(store.getStatus()).toEqual({
      currentTask: expect.objectContaining({
        id: task.id,
        status: 'queued',
        stage: 'queued',
        message: 'accepted',
      }),
      lastTask: null,
    })
  })

  it('persists the current task to disk and restores it in a new store instance', () => {
    const store = createStore()
    const stateFile = store.getStateFilePath()

    store.createTask('npm-package', 'accepted')
    store.updateCurrentStage('installing', 'installing package', {
      targetVersion: '0.6.13',
      warning: 'compat layout',
    })

    expect(existsSync(stateFile)).toBe(true)
    expect(JSON.parse(readFileSync(stateFile, 'utf-8'))).toEqual(expect.objectContaining({
      currentTask: expect.objectContaining({
        status: 'running',
        stage: 'installing',
        targetVersion: '0.6.13',
        warning: 'compat layout',
      }),
    }))

    const restoredStore = new UpdateTaskStore(stateFile)
    expect(restoredStore.getStatus().currentTask).toEqual(expect.objectContaining({
      status: 'running',
      stage: 'installing',
      targetVersion: '0.6.13',
      warning: 'compat layout',
    }))
  })

  it('moves the completed task into lastTask and restores it from disk', () => {
    const store = createStore()
    const stateFile = store.getStateFilePath()

    store.createTask('source-deploy', 'accepted')
    store.completeCurrentTask('failed', 'update failed', 'engine mismatch')

    expect(store.getStatus()).toEqual({
      currentTask: null,
      lastTask: expect.objectContaining({
        status: 'failed',
        stage: 'failed',
        message: 'update failed',
        error: 'engine mismatch',
        finishedAt: expect.any(String),
      }),
    })

    const restoredStore = new UpdateTaskStore(stateFile)
    expect(restoredStore.getStatus()).toEqual({
      currentTask: null,
      lastTask: expect.objectContaining({
        status: 'failed',
        stage: 'failed',
        error: 'engine mismatch',
      }),
    })
  })

  it('marks the task as rolled back and clears the active task', () => {
    const store = createStore()

    store.createTask('device-package', 'accepted')
    store.markRolledBack('update failed and was rolled back', 'restored previous deploy')

    expect(store.getStatus()).toEqual({
      currentTask: null,
      lastTask: expect.objectContaining({
        status: 'failed',
        stage: 'rolled_back',
        message: 'update failed and was rolled back',
        rollbackMessage: 'restored previous deploy',
        finishedAt: expect.any(String),
      }),
    })
  })

  it('recovers an interrupted running task into lastTask', () => {
    const store = createStore()

    store.createTask('device-package', 'accepted')
    store.updateCurrentStage('downloading', 'downloading package', {
      targetVersion: '0.6.17',
    })

    const recoveredTask = store.recoverInterruptedTask()

    expect(recoveredTask).toEqual(expect.objectContaining({
      status: 'failed',
      stage: 'failed',
      targetVersion: '0.6.17',
      error: 'Previous update task was interrupted during downloading.',
      finishedAt: expect.any(String),
    }))
    expect(store.getStatus()).toEqual({
      currentTask: null,
      lastTask: expect.objectContaining({
        status: 'failed',
        stage: 'failed',
        error: 'Previous update task was interrupted during downloading.',
      }),
    })
  })

  it('keeps a runtime-owned running task active while its heartbeat is fresh', () => {
    const store = createStore()

    store.createTask('device-package', 'accepted')
    store.handoffCurrentTaskToRuntime({
      stage: 'downloading',
      message: 'downloading package',
      targetVersion: '0.6.17',
    })

    const recoveredTask = store.recoverInterruptedTaskIfStale(60_000)

    expect(recoveredTask).toBeNull()
    expect(store.getStatus()).toEqual({
      currentTask: expect.objectContaining({
        owner: 'runtime',
        status: 'running',
        stage: 'downloading',
      }),
      lastTask: null,
    })
  })

  it('recovers a stale runtime-owned task after the heartbeat times out', () => {
    const store = createStore()

    store.createTask('device-package', 'accepted')
    store.handoffCurrentTaskToRuntime({
      stage: 'downloading',
      message: 'downloading package',
      targetVersion: '0.6.17',
    })
    store.patchCurrentTask({ heartbeatAt: '2026-01-01T00:00:00.000Z' })

    const recoveredTask = store.recoverInterruptedTaskIfStale(1)

    expect(recoveredTask).toEqual(expect.objectContaining({
      owner: 'runtime',
      status: 'failed',
      stage: 'failed',
      error: 'Previous update task was interrupted during downloading.',
    }))
    expect(store.getStatus()).toEqual({
      currentTask: null,
      lastTask: expect.objectContaining({
        owner: 'runtime',
        status: 'failed',
      }),
    })
  })

  it('clears only recovered interrupted history', () => {
    const store = createStore()

    store.createTask('device-package', 'accepted')
    store.updateCurrentStage('downloading', 'downloading package')
    store.recoverInterruptedTask()

    const clearedTask = store.clearRecoveredInterruptedTask()

    expect(clearedTask).toEqual(expect.objectContaining({
      error: 'Previous update task was interrupted during downloading.',
    }))
    expect(store.getStatus()).toEqual({
      currentTask: null,
      lastTask: null,
    })
    expect(existsSync(store.getStateFilePath())).toBe(false)
  })
})
