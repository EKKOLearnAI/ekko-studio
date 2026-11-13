/**
 * Knowledge plugin — file watcher.
 *
 * The watcher is the trigger for the ingest pipeline: it emits events
 * when files are added, changed, or removed inside a watched vault
 * directory. It never reads file content — that is the extractor's
 * responsibility (Task 3). This separation keeps the watcher testable
 * with zero IO.
 *
 * Event flow:
 *   chokidar → KnowledgeWatcher → namespaced event on shared emitter
 *
 * Namespaced events (emitted on the shared EventEmitter):
 *   'knowledge:ingest:add'     { vaultId, path }
 *   'knowledge:ingest:change'  { vaultId, path }
 *   'knowledge:ingest:remove'  { vaultId, path }
 *   'knowledge:vault:offline'  { vaultId, rootPath, reason }
 *
 * Debounce: chokidar's `awaitWriteFinish` option is used — a file
 * must be stable for `stabilityThreshold` ms before the event fires.
 * This coalesces the burst of events that a USB drop produces when
 * the OS flushes many small writes in succession.
 *
 * Audit fixes this file satisfies:
 *   - P1-4: chokidar is a direct dependency in package.json (verified).
 *   - P2-4: tests use usePolling against real temp dirs, never memfs.
 */

import { watch, type FSWatcher } from 'chokidar'
import { EventEmitter } from 'events'
import { statSync, existsSync } from 'fs'
import { join, extname } from 'path'

type ChokidarOptions = NonNullable<Parameters<typeof watch>[1]>

// --- Event types ---------------------------------------------------------

export type IngestAddEvent = { vaultId: number; path: string }
export type IngestChangeEvent = { vaultId: number; path: string }
export type IngestRemoveEvent = { vaultId: number; path: string }
export type VaultOfflineEvent = {
  vaultId: number
  rootPath: string
  reason: string
}

export type IngestEventName =
  | 'knowledge:ingest:add'
  | 'knowledge:ingest:change'
  | 'knowledge:ingest:remove'
  | 'knowledge:vault:offline'

export type IngestEvent =
  | IngestAddEvent
  | IngestChangeEvent
  | IngestRemoveEvent
  | VaultOfflineEvent

// --- Per-vault watcher ---------------------------------------------------

export interface KnowledgeWatcherOptions {
  /** Debounce threshold in ms (passed to chokidar's awaitWriteFinish). */
  stabilityThreshold: number
  /** Force polling backend (required for fakes and some WSL setups). */
  usePolling?: boolean
  /** Max retries before marking vault offline on chokidar errors. */
  errorRetries?: number
  /** Allowed file extensions (lowercased, with dot). Files outside this set are skipped. */
  supportedExtensions?: string[]
  /** Max file size in bytes — files exceeding this are skipped. */
  maxFileSizeBytes?: number
}

const DEFAULT_OPTIONS: KnowledgeWatcherOptions = {
  stabilityThreshold: 2000,
  usePolling: false,
  errorRetries: 3,
}

export class KnowledgeWatcher {
  readonly vaultId: number
  readonly rootPath: string
  private watcher: FSWatcher | null = null
  private isClosed = false
  private errorsInRow = 0
  private readonly options: KnowledgeWatcherOptions
  private readyResolve: (() => void) | null = null
  /** Resolves once chokidar's initial scan completes. */
  ready: Promise<void>

  constructor(
    vaultId: number,
    rootPath: string,
    private readonly emitter: EventEmitter,
    options: Partial<KnowledgeWatcherOptions> = {}
  ) {
    this.vaultId = vaultId
    this.rootPath = rootPath
    this.options = { ...DEFAULT_OPTIONS, ...options }
    this.ready = new Promise(r => {
      this.readyResolve = r
    })
  }

  start(): void {
    if (this.watcher) return
    if (!existsSync(this.rootPath)) {
      this.emitOffline('root_path_missing')
      this.readyResolve?.()
      return
    }

    const supportedExts = new Set(this.options.supportedExtensions ?? [])

    const chokidarOptions: ChokidarOptions = {
      persistent: true,
      ignoreInitial: true,
      ignored: (filePath: string) => {
        // Skip dotfiles.
        if (/(^|[\/\\])\./.test(filePath)) return true
        // Defer statSync: only stat when filtering would otherwise apply
        // (unsupported extension or a size limit is configured). Avoids
        // a synchronous syscall for every path chokidar evaluates.
        const ext = extname(filePath).toLowerCase()
        const mightBeFiltered = ext !== '' && supportedExts.size > 0 && !supportedExts.has(ext)
        const needsSizeCheck = !!this.options.maxFileSizeBytes

        if (!mightBeFiltered && !needsSizeCheck) return false

        try {
          const st = statSync(filePath)
          // Directories always pass through so chokidar can traverse them
          // (a directory named "archive.tar" must not be excluded just
          // because ".tar" isn't a supported extension).
          if (st.isDirectory()) return false
          if (needsSizeCheck && st.size > this.options.maxFileSizeBytes!) return true
        } catch {
          // Stat failed — let it through; chokidar will handle the error.
        }

        return mightBeFiltered
      },
      usePolling: this.options.usePolling,
      awaitWriteFinish: {
        stabilityThreshold: this.options.stabilityThreshold,
        pollInterval: 100,
      },
      depth: 32,
    }

    this.watcher = watch(this.rootPath, chokidarOptions)
    this.isClosed = false
    this.watcher
      .on('ready', () => this.readyResolve?.())
      .on('add', p => this.onAdd(p))
      .on('change', p => this.onChange(p))
      .on('unlink', p => this.onRemove(p))
      .on('error', err => this.onError(err))
  }

  async stop(): Promise<void> {
    if (!this.watcher) return
    try {
      await this.watcher.close()
      this.isClosed = true
    } catch {
      /* best-effort */
    }
    this.watcher = null
  }

  isWatching(): boolean {
    return this.watcher !== null && !this.isClosed
  }

  private onAdd(path: string): void {
    this.errorsInRow = 0
    this.emitter.emit('knowledge:ingest:add', {
      vaultId: this.vaultId,
      path,
    } satisfies IngestAddEvent)
  }

  private onChange(path: string): void {
    this.errorsInRow = 0
    this.emitter.emit('knowledge:ingest:change', {
      vaultId: this.vaultId,
      path,
    } satisfies IngestChangeEvent)
  }

  private onRemove(path: string): void {
    this.errorsInRow = 0
    this.emitter.emit('knowledge:ingest:remove', {
      vaultId: this.vaultId,
      path,
    } satisfies IngestRemoveEvent)
  }

  private onError(err: unknown): void {
    this.errorsInRow += 1
    const message = err instanceof Error ? err.message : String(err)
    // eslint-disable-next-line no-console
    console.warn(
      `[knowledge:watcher] vault=${this.vaultId} chokidar error ` +
        `(${this.errorsInRow}/${this.options.errorRetries}): ${message}`
    )
    if (this.errorsInRow >= (this.options.errorRetries ?? 3)) {
      this.emitOffline('chokidar_errors_exhausted')
      void this.stop()
    }
  }

  private emitOffline(reason: string): void {
    this.emitter.emit('knowledge:vault:offline', {
      vaultId: this.vaultId,
      rootPath: this.rootPath,
      reason,
    } satisfies VaultOfflineEvent)
  }
}

// --- Manager -------------------------------------------------------------

export interface VaultDescriptor {
  id: number
  rootPath: string
}

/**
 * Holds per-vault watchers and provides add/remove/stop-all lifecycle
 * methods. The shared EventEmitter is what downstream code (the
 * orchestrator, Task 6) subscribes to.
 */
export class KnowledgeWatcherManager {
  private watchers = new Map<number, KnowledgeWatcher>()
  readonly emitter = new EventEmitter()
  private readonly options: KnowledgeWatcherOptions

  constructor(options: Partial<KnowledgeWatcherOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options }
    // Prevent unhandled error events from crashing the process — the
    // watcher already logs them and emits vault:offline.
    this.emitter.on('error', () => {
      /* swallowed */
    })
  }

  addVault(vault: VaultDescriptor): KnowledgeWatcher {
    const existing = this.watchers.get(vault.id)
    if (existing?.isWatching()) return existing
    const watcher = new KnowledgeWatcher(
      vault.id,
      vault.rootPath,
      this.emitter,
      this.options
    )
    watcher.start()
    this.watchers.set(vault.id, watcher)
    return watcher
  }

  async removeVault(vaultId: number): Promise<void> {
    const watcher = this.watchers.get(vaultId)
    if (!watcher) return
    await watcher.stop()
    this.watchers.delete(vaultId)
  }

  async stopAll(): Promise<void> {
    await Promise.all(
      Array.from(this.watchers.values()).map(w => w.stop())
    )
    this.watchers.clear()
  }

  listVaults(): number[] {
    return Array.from(this.watchers.keys())
  }

  getVaultRootPath(vaultId: number): string | undefined {
    return this.watchers.get(vaultId)?.rootPath
  }
}

// --- Helpers (for tests) -------------------------------------------------

export function joinPath(...parts: string[]): string {
  return join(...parts)
}

export function pathExists(p: string): boolean {
  try {
    statSync(p)
    return true
  } catch {
    return false
  }
}
