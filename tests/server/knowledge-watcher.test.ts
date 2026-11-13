/**
 * Watcher test — real filesystem with polling.
 *
 * Why no memfs
 * ------------
 * chokidar's native backends are incompatible with in-memory filesystem
 * fakes (memfs / mock-fs). Tests must use real temp directories with
 * `usePolling: true` to ensure we exercise the actual watch path.
 * Audit fix P2-4.
 *
 * Why short stabilityThreshold
 * ----------------------------
 * Production default is 2000ms. Tests shorten it to 200ms so we don't
 * wait 2s per event. The debounce invariant (burst → batch) is the
 * property we assert, not the exact threshold value.
 */

import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KnowledgeWatcherManager } from '../../packages/server/src/modules/studio/services/knowledge/watcher'

const STABILITY_MS = 200
const BATCH_WAIT_MS = 1500

describe('KnowledgeWatcherManager — real filesystem', () => {
  let tempDir: string
  let manager: KnowledgeWatcherManager

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'knowledge-watcher-'))
    manager = new KnowledgeWatcherManager({
      stabilityThreshold: STABILITY_MS,
      usePolling: true,
    })
  })

  afterEach(async () => {
    await manager.stopAll()
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  })

  it('emits ingest:add when a file is created', async () => {
    const events: Array<{ vaultId: number; path: string }> = []
    manager.emitter.on('knowledge:ingest:add', e => events.push(e))

    const watcher = manager.addVault({ id: 1, rootPath: tempDir })
    await watcher.ready
    // Polling starts on the next stat cycle after the initial ready event.
    await new Promise(resolve => setTimeout(resolve, 250))

    const filePath = join(tempDir, 'a.md')
    writeFileSync(filePath, 'hello')

    // Wait for awaitWriteFinish to flush.
    await vi.waitFor(() => expect(events).toHaveLength(1), { timeout: 3000, interval: 50 })
    expect(events[0].vaultId).toBe(1)
    expect(events[0].path).toBe(filePath)
  })

  it('debounces a burst: 10 rapid writes → 10 events (not 10×)', async () => {
    const events: Array<{ vaultId: number; path: string }> = []
    manager.emitter.on('knowledge:ingest:add', e => events.push(e))

    const watcher = manager.addVault({ id: 1, rootPath: tempDir })
    await watcher.ready
    // Polling starts on the next stat cycle after the initial ready event.
    await new Promise(resolve => setTimeout(resolve, 250))

    // Write 10 files synchronously in a tight loop.
    for (let i = 0; i < 10; i++) {
      writeFileSync(join(tempDir, `file-${i}.md`), `content-${i}`)
    }

    await new Promise(r => setTimeout(r, BATCH_WAIT_MS))

    // Each of the 10 distinct files produces exactly one event.
    // (If debounce were broken at the chokidar level we might see
    // duplicate events per file; the assertion below catches both.)
    expect(events).toHaveLength(10)
    const uniquePaths = new Set(events.map(e => e.path))
    expect(uniquePaths.size).toBe(10)
  })

  it('emits ingest:change when an existing file is modified', async () => {
    const filePath = join(tempDir, 'existing.md')
    writeFileSync(filePath, 'v1')

    const events: Array<{ vaultId: number; path: string }> = []
    manager.emitter.on('knowledge:ingest:change', e => events.push(e))

    const watcher = manager.addVault({ id: 1, rootPath: tempDir })
    await watcher.ready
    // Polling starts on the next stat cycle after the initial ready event.
    await new Promise(resolve => setTimeout(resolve, 250))

    // Modify after the polling backend captured the initial stat.
    writeFileSync(filePath, 'v2 with changed length')

    await vi.waitFor(() => expect(events).toHaveLength(1), { timeout: 3000, interval: 50 })
    expect(events[0].path).toBe(filePath)
  })

  it('emits ingest:remove when a file is deleted', async () => {
    const filePath = join(tempDir, 'to-remove.md')
    writeFileSync(filePath, 'content')

    const events: Array<{ vaultId: number; path: string }> = []
    manager.emitter.on('knowledge:ingest:remove', e => events.push(e))

    const watcher = manager.addVault({ id: 1, rootPath: tempDir })
    await watcher.ready
    // Polling starts on the next stat cycle after the initial ready event.
    await new Promise(resolve => setTimeout(resolve, 250))

    unlinkSync(filePath)

    await vi.waitFor(() => expect(events).toHaveLength(1), { timeout: 3000, interval: 50 })
    expect(events[0].path).toBe(filePath)
  })

  it('stop() releases the watcher', async () => {
    const watcher = manager.addVault({ id: 1, rootPath: tempDir })
    await watcher.ready
    // Polling starts on the next stat cycle after the initial ready event.
    await new Promise(resolve => setTimeout(resolve, 250))
    expect(manager.listVaults()).toEqual([1])

    await manager.stopAll()

    expect(manager.listVaults()).toEqual([])

    // Writing after stop should not emit anything.
    const events: unknown[] = []
    manager.emitter.on('knowledge:ingest:add', e => events.push(e))

    writeFileSync(join(tempDir, 'after-stop.md'), 'content')
    await new Promise(r => setTimeout(r, BATCH_WAIT_MS))
    expect(events).toHaveLength(0)
  })

  it('vault:offline when root_path is missing', async () => {
    const offlineEvents: Array<{
      vaultId: number
      rootPath: string
      reason: string
    }> = []
    manager.emitter.on('knowledge:vault:offline', e => offlineEvents.push(e))

    manager.addVault({ id: 1, rootPath: join(tempDir, 'nonexistent') })

    // The check happens synchronously in start().
    expect(offlineEvents).toHaveLength(1)
    expect(offlineEvents[0].reason).toBe('root_path_missing')
  })

  it('removeVault stops watching that vault only', async () => {
    const secondDir = mkdtempSync(join(tmpdir(), 'knowledge-watcher-2-'))
    manager.addVault({ id: 1, rootPath: tempDir })
    manager.addVault({ id: 2, rootPath: secondDir })

    await manager.removeVault(1)

    expect(manager.listVaults().sort()).toEqual([2])

    try {
      rmSync(secondDir, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  })
})
