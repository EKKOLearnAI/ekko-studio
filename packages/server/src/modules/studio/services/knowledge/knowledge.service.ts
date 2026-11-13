/**
 * Knowledge plugin — orchestrator service.
 *
 * Stitches the watcher, extractor, chunker, embedder, and search
 * together. Owns:
 *   - Single-writer coroutine (one async worker, bounded FIFO queue).
 *   - Atomic ingest pipeline (extract → chunk → embed → write).
 *   - Atomic delete pipeline (FTS5 + vec0 + chunks in one txn).
 *   - Search dispatch (hybrid or pure-vector via search.ts).
 *
 * Hard invariants:
 *   - `getDb()` is the only connection — never open a second one.
 *   - FTS5 + vec0 deletes are explicit (FK cascades don't apply
 *     to virtual tables — audit P0-1).
 *   - One writer, serialized. Never concurrent writes.
 */

import { createHash } from 'crypto'
import { statSync } from 'fs'
import { extname, join } from 'path'
import { EventEmitter } from 'events'
import type { DatabaseSync } from 'node:sqlite'
import {
  ensureKnowledgeSchema,
  type KnowledgeSchemaBootstrapStatus,
} from '../../infrastructure/database/knowledge-schema'
import { extract, type ExtractError } from './extractors/index'
import { chunkText, type Chunk } from './chunker'
import {
  createEmbedder,
  createTongyiProvider,
  KnowledgeEmbedError,
  type Embedder,
  type EmbedConfig,
} from './embedder'
import { search as searchFn, QueryTooLongError, type SearchParams, type SearchResponse } from './search'
import { tokenizeForFts } from './fts-tokenizer'
import type { KnowledgeConfig } from './config'
import { computeKnowledgeQuota, type KnowledgeQuota } from './quota'
import {
  bootstrapDefaultVaults,
  type BootstrapResult,
  type DefaultVaultsMode,
} from './bootstrap'

// --- Public types ---------------------------------------------------------

export { QueryTooLongError }

export type IngestStatus =
  | 'pending'
  | 'indexing'
  | 'indexed'
  | 'failed'
  | 'metadata_only'
  | 'fts_only'
  | 'unmounted'

/** Flat ceiling across all vault kinds (task-12 § "Extending beyond the four defaults"). */
export const MAX_KNOWLEDGE_VAULTS = 8

/** Thrown when creating a vault would exceed `MAX_KNOWLEDGE_VAULTS`. Maps to 409. */
export class VaultLimitError extends Error {
  readonly code = 'vault_quota_exceeded'
  constructor(message: string) {
    super(message)
    this.name = 'VaultLimitError'
  }
}

/** Thrown when a vault's root_path already exists. Maps to 409. */
export class VaultPathInUseError extends Error {
  readonly code = 'vault_path_in_use'
  constructor(message: string) {
    super(message)
    this.name = 'VaultPathInUseError'
  }
}

export interface KnowledgeHealthReport {
  vaults: { total: number; watching: number; offline: number }
  documents: { total: number; pending: number; indexed: number; failed: number; indexing: number; metadataOnly: number }
  chunks: { total: number }
  vecIndex: { vectorCount: number }
  ftsIndex: { sizeBytes: number; termCount: number }
  ingestion: {
    inFlight: number
    queued: number
    lastSuccessAt: number | null
    lastFailureAt: number | null
    lastError: string | null
  }
  embedder: {
    requestsLastHour: number
    tokensLastHour: number
    failuresLastHour: number
    avgLatencyMs: number
  }
}

export interface KnowledgeDocument {
  id: number
  source_path: string
  source_hash: string
  vault_id: number
  mime_type: string
  size_bytes: number
  mtime: number
  indexed_at: number
  status: IngestStatus
  error: string | null
}

/** Who/why performed a search — persisted as the citation audit trail. */
export interface ReferenceContext {
  /** 'chat' (web UI search box / chat citations), 'agent-tool' (MCP knowledge_search). */
  source: 'chat' | 'agent-tool'
  /** Optional conversation/session id tying citations to a task run. */
  sessionId?: string | null
}

export interface ReferenceEntry {
  id: number
  document_id: number
  chunk_id: number
  source: string
  session_id: string | null
  distance: number | null
  rank: number
  created_at: number
}

export interface KnowledgeChunk {
  id: number
  document_id: number
  position: number
  content: string
  token_count: number
}

/**
 * Vault kinds (task-11):
 *   'auto'   — bootstrap-created (upload dir, agent workspace…); ingest
 *              records metadata_only only, full index is user-triggered.
 *   'manual' — user-created via POST /vaults; full ingest (v0.8.7 behavior).
 *   'usb'    — on-demand mount vault (wired in task-12; FTS5-only).
 */
export type KnowledgeVaultKind = 'auto' | 'manual' | 'usb'

export const ALLOWED_VAULT_KINDS: readonly KnowledgeVaultKind[] = ['auto', 'manual', 'usb']

export function isVaultKind(value: unknown): value is KnowledgeVaultKind {
  return typeof value === 'string' && (ALLOWED_VAULT_KINDS as readonly string[]).includes(value)
}

export interface KnowledgeVault {
  id: number
  root_path: string
  name: string
  kind: KnowledgeVaultKind
  watch: number
  created_at: number
}

interface QueueItem {
  path: string
  vaultId: number
  forceFull: boolean
  resolve: (result: IngestResult) => void
  reject: (err: Error) => void
}

export interface IngestResult {
  documentId: number
  status: IngestStatus
  chunks: number
  error?: string
}

export interface KnowledgeServiceDeps {
  /** Override embedder for testing. */
  embedder?: Embedder
  /** Override extractor for testing. */
  extractorFn?: (path: string) => { text: string; tokenCount: number } | Promise<{ text: string; tokenCount: number }>
}

// --- Service --------------------------------------------------------------

export class KnowledgeService extends EventEmitter {
  private db: DatabaseSync
  private config: KnowledgeConfig
  private embedder: Embedder
  private extractorFn: (path: string) => { text: string; tokenCount: number } | Promise<{ text: string; tokenCount: number }>

  private queue: QueueItem[] = []
  private processing = false
  private activeWorkers = 0
  private vecAvailable = false

  constructor(
    db: DatabaseSync,
    config: KnowledgeConfig,
    deps: KnowledgeServiceDeps = {},
  ) {
    super()
    this.db = db
    this.config = config
    this.extractorFn = deps.extractorFn ?? ((path: string) => extract(path))

    if (deps.embedder) {
      this.embedder = deps.embedder
    } else {
      const embedConfig: EmbedConfig = {
        provider: config.embedProvider,
        model: config.embedModel,
        dim: config.embedDim,
        apiKey: config.embedApiKey,
        apiBase: config.embedApiBase,
        batchSize: config.embedBatchSize,
        timeoutMs: config.embedTimeoutMs,
        retries: config.embedRetries,
      }
      const provider = createTongyiProvider(embedConfig)
      this.embedder = createEmbedder(provider)
    }
  }

  // --- Lifecycle ----------------------------------------------------------

  /**
   * Bootstrap the knowledge schema on the shared DB connection.
   * Returns a status describing whether sqlite-vec (vector search)
   * was successfully loaded. Callers should check status.vecAvailable
   * before accepting ingest / search tasks.
   */
  init(): KnowledgeSchemaBootstrapStatus {
    const status = ensureKnowledgeSchema(this.db, this.config.embedDim, this.config.embedModel)
    this.vecAvailable = status.vecAvailable
    return status
  }

  // --- Vault management ---------------------------------------------------

  /**
   * Create a vault. Enforces the two binding contracts from task-12
   * (spec § "Extending beyond the four defaults"):
   *   - flat total ceiling of `MAX_KNOWLEDGE_VAULTS` across all kinds
   *   - unique `root_path` (the schema UNIQUE constraint is the backstop;
   *     here we translate the raw SQLite error into a typed code the
   *     controller maps to a stable HTTP status).
   * Every path — the UI drawer, the CLI, the MCP tool, and auto-vault
   * bootstrap — goes through here so the checks are uniform.
   */
  addVault(rootPath: string, name: string, kind: KnowledgeVaultKind = 'manual'): KnowledgeVault {
    if (!isVaultKind(kind)) {
      throw new Error(`invalid vault kind: ${String(kind)}`)
    }
    const count = (this.db.prepare(
      'SELECT COUNT(*) AS n FROM knowledge_vaults'
    ).get() as { n: number }).n
    if (count >= MAX_KNOWLEDGE_VAULTS) {
      throw new VaultLimitError(
        `vault limit reached: ${count}/${MAX_KNOWLEDGE_VAULTS} vaults`,
      )
    }

    const now = Date.now()
    try {
      this.db.prepare(
        'INSERT INTO knowledge_vaults (root_path, name, kind, watch, created_at) VALUES (?, ?, ?, 1, ?)'
      ).run(rootPath, name, kind, now)
    } catch (err) {
      if (err instanceof Error && /UNIQUE constraint failed: knowledge_vaults\.root_path/.test(err.message)) {
        throw new VaultPathInUseError(`vault root_path already in use: ${rootPath}`)
      }
      throw err
    }

    const rows = this.db.prepare(
      'SELECT * FROM knowledge_vaults WHERE root_path = ?'
    ).all(rootPath) as unknown as KnowledgeVault[]
    return rows[0]
  }

  removeVault(vaultId: number, cascade: boolean = false): void {
    if (cascade) {
      // Atomic cascade: virtual tables (FTS5, vec0) don't participate in
      // FK cascades (P0-1), so we delete from all three manually inside
      // one transaction. If any step fails, ROLLBACK restores everything.
      this.db.exec('BEGIN')
      try {
        const docs = this.db.prepare(
          'SELECT id FROM knowledge_documents WHERE vault_id = ?'
        ).all(vaultId) as Array<{ id: number }>
        for (const doc of docs) {
          this.deleteDocumentIndexes(doc.id, true) // skipTransaction — outer txn covers us
        }
        this.db.prepare('DELETE FROM knowledge_documents WHERE vault_id = ?').run(vaultId)
        this.db.prepare('DELETE FROM knowledge_vaults WHERE id = ?').run(vaultId)
        this.db.exec('COMMIT')
      } catch (err) {
        this.db.exec('ROLLBACK')
        throw err
      }
    } else {
      // Without cascade, just disable watching — documents remain
      // referencing the vault (FK constraint prevents row deletion).
      this.db.prepare('UPDATE knowledge_vaults SET watch = 0 WHERE id = ?').run(vaultId)
    }
  }

  listVaults(): KnowledgeVault[] {
    return this.db.prepare('SELECT * FROM knowledge_vaults ORDER BY id').all() as unknown as KnowledgeVault[]
  }

  /**
   * Stamp the provenance source on a document row (task-12). The ingest
   * pipeline leaves `source` at its 'unknown' default; the semi-auto
   * task-archive path marks its rows 'task-finalize' so the auto_tasks
   * vault can distinguish continuously-watched workspace files from
   * task deliverables sharing the same root path.
   */
  setDocumentSource(documentId: number, source: string): void {
    this.db.prepare('UPDATE knowledge_documents SET source = ? WHERE id = ?')
      .run(source, documentId)
  }

  findVaultByPath(rootPath: string): KnowledgeVault | undefined {
    return this.db.prepare(
      'SELECT * FROM knowledge_vaults WHERE root_path = ?'
    ).get(rootPath) as KnowledgeVault | undefined
  }

  /** Locate an already-recorded document for a source path inside a vault. */
  findDocumentInVault(sourcePath: string, vaultId: number): { id: number; status: string } | undefined {
    return this.db.prepare(
      'SELECT id, status FROM knowledge_documents WHERE source_path = ? AND vault_id = ?'
    ).get(sourcePath, vaultId) as { id: number; status: string } | undefined
  }

  /**
   * Flip a USB vault's documents between 'unmounted' (mount gone) and
   * 'fts_only' (mount back), touching only rows currently in the opposite
   * state so chunk content persists and re-mount needs no re-extraction
   * (task-12). Returns the number of rows changed.
   */
  markUsbVaultUnmounted(vaultId: number, target: 'unmounted' | 'fts_only'): number {
    const from = target === 'unmounted' ? 'fts_only' : 'unmounted'
    const res = this.db.prepare(
      'UPDATE knowledge_documents SET status = ? WHERE vault_id = ? AND status = ?'
    ).run(target, vaultId, from) as { changes: number }
    return Number(res.changes)
  }

  /** Disk quota snapshot (task-12). Pure read over the shared connection. */
  getQuota(): KnowledgeQuota {
    return computeKnowledgeQuota(this.db)
  }

  /**
   * Ensure the four default auto vaults exist (task-12). Thin delegate
   * to the bootstrap module so the endpoint and startup share one code
   * path. `profile` selects the per-profile workspace/notes roots.
   */
  ensureDefaultVaults(opts: {
    roots: { uploadDir: string; meetingsDir: string; hermesDataDir: string; profile: string }
    mode?: DefaultVaultsMode
    env?: NodeJS.ProcessEnv
  }): BootstrapResult {
    return bootstrapDefaultVaults(this, opts)
  }

  // --- Document listing ---------------------------------------------------

  listDocuments(vaultId?: number): KnowledgeDocument[] {
    if (vaultId != null) {
      return this.db.prepare(
        'SELECT * FROM knowledge_documents WHERE vault_id = ? ORDER BY indexed_at DESC'
      ).all(vaultId) as unknown as KnowledgeDocument[]
    }
    return this.db.prepare(
      'SELECT * FROM knowledge_documents ORDER BY indexed_at DESC'
    ).all() as unknown as KnowledgeDocument[]
  }

  listDocumentChunks(documentId: number): KnowledgeChunk[] {
    return this.db.prepare(
      'SELECT * FROM knowledge_chunks WHERE document_id = ? ORDER BY position ASC'
    ).all(documentId) as unknown as KnowledgeChunk[]
  }

  // --- Ingest pipeline ----------------------------------------------------

  /**
   * Queue a file for ingestion. Returns a promise that resolves when
   * the single-writer worker has processed the file.
   *
   * `forceFull` bypasses the auto-vault metadata_only short-circuit —
   * used by promoteDocument() so the promote of an auto-vault row is
   * not re-short-circuited by step 0.5.
   */
  ingest(
    path: string,
    vaultId: number,
    opts: { forceFull?: boolean } = {},
  ): Promise<IngestResult> {
    return new Promise<IngestResult>((resolve, reject) => {
      if (this.queue.length >= this.config.queueDepth) {
        reject(new Error(`Ingest queue full (${this.config.queueDepth}). Try later.`))
        return
      }
      this.queue.push({ path, vaultId, forceFull: opts.forceFull === true, resolve, reject })
      this.drainQueue()
    })
  }

  /**
   * Promote a metadata_only document to a full index. Reuses the regular
   * ingest pipeline: the metadata_only row carries an empty source_hash,
   * so the no-op check never fires and the full extract→chunk→embed path
   * runs. State validation happens synchronously (throws before enqueue)
   * so HTTP callers can map document_not_found / not_metadata_only /
   * unsupported_extension / ingest_queue_full to 404 / 409 / 422 / 503;
   * the pipeline itself runs on the single-writer queue.
   */
  promoteDocument(documentId: number): Promise<IngestResult> {
    const row = this.db.prepare(
      'SELECT source_path, vault_id, status FROM knowledge_documents WHERE id = ?'
    ).get(documentId) as { source_path: string; vault_id: number; status: string } | undefined

    if (!row) {
      throw new Error('document_not_found')
    }
    if (row.status !== 'metadata_only') {
      throw new Error('not_metadata_only')
    }
    // Reject unsupported extensions up front — otherwise the ingest's
    // step-0 whitelist would silently re-record the file as metadata_only
    // and the user's "index this" click would be a no-op behind a 202.
    const ext = extname(row.source_path).toLowerCase()
    if (ext && !this.config.supportedExtensions.includes(ext)) {
      throw new Error('unsupported_extension')
    }
    // Reject a full queue synchronously: the queue-full rejection inside
    // ingest() fires before the pipeline, so nothing would update the
    // document status or emit an event — the 202 would be the last word.
    if (this.queue.length >= this.config.queueDepth) {
      throw new Error('ingest_queue_full')
    }
    return this.ingest(row.source_path, row.vault_id, { forceFull: true })
  }

  private async drainQueue(): Promise<void> {
    if (this.processing) return
    this.processing = true

    while (this.queue.length > 0) {
      const item = this.queue.shift()!
      this.activeWorkers++
      try {
        const result = await this.processIngest(item.path, item.vaultId, item.forceFull)
        item.resolve(result)
      } catch (err) {
        item.reject(err as Error)
      } finally {
        this.activeWorkers--
      }
    }

    this.processing = false
  }

  /** Vault kind lookup; unknown/legacy rows behave as 'manual'. */
  private getVaultKind(vaultId: number): KnowledgeVaultKind {
    const rows = this.db.prepare(
      'SELECT kind FROM knowledge_vaults WHERE id = ?'
    ).all(vaultId) as Array<{ kind: string }>
    return isVaultKind(rows[0]?.kind) ? rows[0].kind : 'manual'
  }

  /**
   * Record a file without extract/chunk/embed — one documents row, no
   * chunks / FTS5 / vec0, invisible to search until promoted.
   */
  private metadataOnlyIngest(path: string, vaultId: number): IngestResult {
    let fileStat: { size: number; mtimeMs: number }
    try {
      const s = statSync(path)
      fileStat = { size: s.size, mtimeMs: s.mtimeMs }
    } catch {
      // File was deleted between watcher event and processing — skip.
      return { documentId: 0, status: 'failed', chunks: 0, error: 'File disappeared before processing' }
    }
    const docId = this.upsertDocument(path, vaultId, '', fileStat)
    // If this document was fully indexed before (promoted, then the file
    // changed again), drop its stale chunk/FTS5/vec0 rows — search filters
    // by status so they'd be invisible, but they'd still sit on disk as
    // orphans. For fresh metadata_only rows these DELETEs are no-ops.
    this.deleteDocumentIndexes(docId)
    this.db.prepare(
      "UPDATE knowledge_documents SET status = 'metadata_only', indexed_at = ? WHERE id = ?"
    ).run(Date.now(), docId)
    return { documentId: docId, status: 'metadata_only', chunks: 0 }
  }

  /**
   * FTS5-only ingest for USB vaults (task-12). Extracts text and writes
   * knowledge_chunks + knowledge_chunks_fts, but NEVER vec0 — the mount
   * may vanish at any moment and embedding a removable drive is wasted
   * budget. Document status ends as 'fts_only' so keyword search sees it
   * and vector search does not.
   */
  private async ftsOnlyIngest(path: string, vaultId: number): Promise<IngestResult> {
    let fileStat: { size: number; mtimeMs: number }
    try {
      const s = statSync(path)
      if (s.size > this.config.maxFileSizeBytes) {
        const maxMb = Math.round(this.config.maxFileSizeBytes / (1024 * 1024))
        throw new Error(`File too large (${Math.round(s.size / (1024 * 1024))}MB > ${maxMb}MB limit)`)
      }
      fileStat = { size: s.size, mtimeMs: s.mtimeMs }
    } catch (err) {
      const docId = this.upsertDocument(path, vaultId, '', { size: 0, mtimeMs: Date.now() })
      this.db.prepare("UPDATE knowledge_documents SET status = 'failed', error = ? WHERE id = ?")
        .run((err as Error).message, docId)
      return { documentId: docId, status: 'failed', chunks: 0, error: (err as Error).message }
    }

    let fileContent: { text: string; tokenCount: number }
    try {
      fileContent = await this.extractorFn(path)
    } catch (err) {
      const docId = this.upsertDocument(path, vaultId, '', fileStat)
      this.db.prepare("UPDATE knowledge_documents SET status = 'failed', error = ? WHERE id = ?")
        .run((err as Error).message, docId)
      return { documentId: docId, status: 'failed', chunks: 0, error: (err as Error).message }
    }

    const sourceHash = createHash('sha256').update(fileContent.text).digest('hex')
    const docId = this.upsertDocument(path, vaultId, sourceHash, fileStat)
    this.db.prepare("UPDATE knowledge_documents SET status = 'indexing', error = NULL WHERE id = ?").run(docId)
    this.deleteDocumentIndexes(docId)

    const ext = extname(path).toLowerCase()
    const chunks = chunkText(fileContent.text, ext === '.md' ? 'markdown' : 'plaintext', {
      chunkSize: this.config.chunkSize,
      chunkOverlap: this.config.chunkOverlap,
      chunkFallbackSize: this.config.chunkFallbackSize,
    })

    try {
      this.insertChunksFtsOnly(docId, chunks)
    } catch (err) {
      const errorMsg = (err as Error).message
      this.db.prepare("UPDATE knowledge_documents SET status = 'failed', error = ? WHERE id = ?")
        .run(errorMsg, docId)
      return { documentId: docId, status: 'failed', chunks: 0, error: errorMsg }
    }

    this.db.prepare("UPDATE knowledge_documents SET status = 'fts_only', indexed_at = ? WHERE id = ?")
      .run(Date.now(), docId)
    this._lastSuccessAt = Date.now()
    this.emit('knowledge:ingest:success', { documentId: docId, chunks: chunks.length })
    return { documentId: docId, status: 'fts_only', chunks: chunks.length }
  }

  private async processIngest(
    path: string,
    vaultId: number,
    forceFull = false,
  ): Promise<IngestResult> {
    // 0. Extension whitelist — skip unsupported types before touching disk.
    const ext = extname(path).toLowerCase()
    if (ext && !this.config.supportedExtensions.includes(ext)) {
      // Metadata-only: record the document but don't extract.
      return this.metadataOnlyIngest(path, vaultId)
    }

    // 0.5 Auto vaults (task-11): record metadata only. A full index is
    // user-triggered via promoteDocument({ forceFull }) — a drop of 50
    // files into an auto vault must never silently occupy the embedding
    // queue for minutes on the ARM device.
    if (!forceFull && this.getVaultKind(vaultId) === 'auto') {
      return this.metadataOnlyIngest(path, vaultId)
    }

    // 0.6 USB vaults (task-12): FTS5-only, reference-based. The mount is
    // read but content is never copied into vec0 (embedding a removable
    // drive the user may unplug any moment is wasted budget). Keyword
    // search works; vector search does not for these rows.
    if (!forceFull && this.getVaultKind(vaultId) === 'usb') {
      return this.ftsOnlyIngest(path, vaultId)
    }

    // 1. Read file and compute source_hash.
    let fileContent: { text: string; tokenCount: number }
    let fileStat: { size: number; mtimeMs: number } = { size: 0, mtimeMs: Date.now() }
    try {
      fileStat = statSync(path)
      // ARM protection: reject files exceeding the size limit.
      if (fileStat.size > this.config.maxFileSizeBytes) {
        const maxMb = Math.round(this.config.maxFileSizeBytes / (1024 * 1024))
        throw new Error(`File too large (${Math.round(fileStat.size / (1024 * 1024))}MB > ${maxMb}MB limit)`)
      }
      fileContent = await this.extractorFn(path)
    } catch (err) {
      // File unreadable — record failure.
      const docId = this.upsertDocument(path, vaultId, '', fileStat)
      this.db.prepare(
        "UPDATE knowledge_documents SET status = 'failed', error = ? WHERE id = ?"
      ).run((err as Error).message, docId)
      return { documentId: docId, status: 'failed', chunks: 0, error: (err as Error).message }
    }

    const sourceHash = createHash('sha256').update(fileContent.text).digest('hex')
    const mimeType = guessMimeType(path)

    // 2. Check if source_hash matches existing document (no-op).
    const existing = this.db.prepare(
      'SELECT id, source_hash, status FROM knowledge_documents WHERE source_path = ? AND vault_id = ?'
    ).all(path, vaultId) as Array<{ id: number; source_hash: string; status: string }>

    if (existing.length > 0 && existing[0].source_hash === sourceHash && existing[0].status === 'indexed') {
      return { documentId: existing[0].id, status: 'indexed', chunks: 0 }
    }

    // 3. Mark document as indexing.
    const docId = this.upsertDocument(path, vaultId, sourceHash, {
      size: fileStat.size,
      mtimeMs: fileStat.mtimeMs,
    })
    this.db.prepare(
      "UPDATE knowledge_documents SET status = 'indexing', error = NULL WHERE id = ?"
    ).run(docId)

    try {
      // 4. If re-indexing, delete old chunks/FTS/vec.
      if (existing.length > 0) {
        this.deleteDocumentIndexes(docId)
      }

      // 5. Chunk.
      const ext = extname(path).toLowerCase()
      const kind = (ext === '.md') ? 'markdown' : 'plaintext'
      const chunks = chunkText(fileContent.text, kind, {
        chunkSize: this.config.chunkSize,
        chunkOverlap: this.config.chunkOverlap,
        chunkFallbackSize: this.config.chunkFallbackSize,
      })

      if (chunks.length === 0) {
        // Metadata-only document (empty file).
        this.db.prepare(
          "UPDATE knowledge_documents SET status = 'indexed', indexed_at = ? WHERE id = ?"
        ).run(Date.now(), docId)
        return { documentId: docId, status: 'indexed', chunks: 0 }
      }

      // 6. Embed.
      const chunkTexts = chunks.map(c => c.content)
      const vectors = await this.embedder.embed(chunkTexts)

      // 7. Write chunks + FTS5 + vec0 in one transaction.
      this.insertChunks(docId, chunks, vectors)

      // 8. Mark as indexed.
      this.db.prepare(
        "UPDATE knowledge_documents SET status = 'indexed', indexed_at = ? WHERE id = ?"
      ).run(Date.now(), docId)

      // Track success.
      this._lastSuccessAt = Date.now()
      this.emit('knowledge:ingest:success', { documentId: docId, chunks: chunks.length })

      return { documentId: docId, status: 'indexed', chunks: chunks.length }
    } catch (err) {
      const errorMsg = (err as Error).message
      // Rollback: mark as failed.
      this.db.prepare(
        "UPDATE knowledge_documents SET status = 'failed', error = ? WHERE id = ?"
      ).run(errorMsg, docId)

      // Track failure.
      this._lastFailureAt = Date.now()
      this._lastError = errorMsg
      this.emit('knowledge:ingest:error', { documentId: docId, error: errorMsg })

      return { documentId: docId, status: 'failed', chunks: 0, error: errorMsg }
    }
  }

  private upsertDocument(
    path: string,
    vaultId: number,
    sourceHash: string,
    stat: { size: number; mtimeMs: number },
  ): number {
    const existing = this.db.prepare(
      'SELECT id FROM knowledge_documents WHERE source_path = ? AND vault_id = ?'
    ).all(path, vaultId) as Array<{ id: number }>

    if (existing.length > 0) {
      this.db.prepare(`
        UPDATE knowledge_documents
        SET source_hash = ?, size_bytes = ?, mtime = ?, mime_type = ?
        WHERE id = ?
      `).run(
        sourceHash || '',
        stat.size,
        Math.floor(stat.mtimeMs),
        guessMimeType(path),
        existing[0].id,
      )
      return existing[0].id
    }

    this.db.prepare(`
      INSERT INTO knowledge_documents
        (source_path, source_hash, vault_id, mime_type, size_bytes, mtime, indexed_at, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
    `).run(
      path,
      sourceHash || '',
      vaultId,
      guessMimeType(path),
      stat.size,
      Math.floor(stat.mtimeMs),
      Date.now(),
    )

    const rows = this.db.prepare('SELECT last_insert_rowid() AS id').all() as Array<{ id: number }>
    return rows[0].id
  }

  private insertChunks(documentId: number, chunks: Chunk[], vectors: Float32Array[]): void {
    // Single transaction for chunks + FTS5 (+ vec0 if available).
    // virtual tables can't use FK cascades (P0-1), so we insert
    // into all three explicitly.
    this.db.exec('BEGIN')
    try {
      const insertChunk = this.db.prepare(`
        INSERT INTO knowledge_chunks (document_id, position, content, token_count)
        VALUES (?, ?, ?, ?)
      `)
      const insertFts = this.db.prepare(`
        INSERT INTO knowledge_chunks_fts (rowid, content) VALUES (?, ?)
      `)
      const insertVec = this.vecAvailable
        ? this.db.prepare(`
            INSERT INTO knowledge_chunks_vec (chunk_id, embedding)
            VALUES (CAST(? AS INTEGER), ?)
          `)
        : null

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i]
        const vector = vectors[i]

        // insertChunk returns { lastInsertRowid, changes }.
        const insertResult = insertChunk.run(documentId, i, chunk.content, chunk.tokenCount) as { lastInsertRowid: number; changes: number }
        const chunkId = Number(insertResult.lastInsertRowid)

        // FTS5 rowid coupling: explicit rowid = chunk.id (P1-3).
        // Write bigram-tokenized text so CJK queries can match via FTS5.
        // The original content stays in knowledge_chunks for display.
        insertFts.run(chunkId, tokenizeForFts(chunk.content).join(' '))

        // vec0 insert: only when the extension is loaded.
        if (insertVec) {
          const vecJson = '[' + Array.from(vector).join(',') + ']'
          insertVec.run(chunkId, vecJson)
        }
      }

      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  /**
   * FTS5-only variant of insertChunks: writes knowledge_chunks + the
   * FTS5 shadow (with the same rowid coupling and bigram tokenization)
   * but never touches vec0. Used by USB-vault fts_only ingest (task-12).
   */
  private insertChunksFtsOnly(documentId: number, chunks: Chunk[]): void {
    this.db.exec('BEGIN')
    try {
      const insertChunk = this.db.prepare(`
        INSERT INTO knowledge_chunks (document_id, position, content, token_count)
        VALUES (?, ?, ?, ?)
      `)
      const insertFts = this.db.prepare(`
        INSERT INTO knowledge_chunks_fts (rowid, content) VALUES (?, ?)
      `)
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i]
        const r = insertChunk.run(documentId, i, chunk.content, chunk.tokenCount) as { lastInsertRowid: number }
        const chunkId = Number(r.lastInsertRowid)
        insertFts.run(chunkId, tokenizeForFts(chunk.content).join(' '))
      }
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  private deleteDocumentIndexes(documentId: number, skipTransaction = false): void {
    // Virtual tables don't cascade — delete from all three explicitly
    // in one transaction (P0-1).
    // Uses prepared statements with parameterized documentId to prevent
    // SQL injection (root-cause fix: was using string interpolation).
    // When called from removeVault (which already holds a transaction),
    // skipTransaction=true avoids nested BEGIN.
    if (!skipTransaction) this.db.exec('BEGIN')
    try {
      // FTS5: delete by rowid = chunk.id.
      this.db.prepare(`
        DELETE FROM knowledge_chunks_fts WHERE rowid IN (
          SELECT id FROM knowledge_chunks WHERE document_id = ?
        )
      `).run(documentId)
      // vec0: delete by chunk_id (only when vec0 is available).
      if (this.vecAvailable) {
        this.db.prepare(`
          DELETE FROM knowledge_chunks_vec WHERE chunk_id IN (
            SELECT id FROM knowledge_chunks WHERE document_id = ?
          )
        `).run(documentId)
      }
      // Chunks: cascade from documents will handle this, but be explicit.
      this.db.prepare(
        'DELETE FROM knowledge_chunks WHERE document_id = ?'
      ).run(documentId)
      // Citation audit log: entries reference chunk ids that no longer
      // exist after this delete — drop them with the same transaction
      // so listDocumentReferences can't return dangling rows.
      this.db.prepare(
        'DELETE FROM knowledge_references WHERE document_id = ?'
      ).run(documentId)
      if (!skipTransaction) this.db.exec('COMMIT')
    } catch (err) {
      if (!skipTransaction) this.db.exec('ROLLBACK')
      throw err
    }
  }

  // --- Search -------------------------------------------------------------

  /** Max rows kept in knowledge_references (trimmed oldest-first on write). */
  private static readonly REFERENCE_CAP = 20_000
  /**
   * Trim amortization: scanning/trimming 20k rows on EVERY search costs
   * tens of ms on the Cortex-A53 device. Instead, trim only once every
   * REFERENCE_TRIM_INTERVAL inserts — the table may overshoot the cap by
   * at most one search batch (≤ 20 rows) between trims.
   */
  private static readonly REFERENCE_TRIM_INTERVAL = 500
  private lastReferenceTrimId = 0

  async search(
    params: SearchParams & { reference?: ReferenceContext },
  ): Promise<SearchResponse> {
    // Embed the query, then delegate to search.ts.
    const queryVectors = await this.embedder.embed([params.query])
    const queryEmbedding = queryVectors[0]
    const response = searchFn(this.db, queryEmbedding, params)
    if (params.reference) {
      // Citation audit log is best-effort — never fail a search over it.
      try {
        this.recordReferences(response.results, params.reference)
      } catch {
        // Swallowed by design.
      }
    }
    return response
  }

  private recordReferences(
    results: SearchResponse['results'],
    ref: ReferenceContext,
  ): void {
    if (results.length === 0) return
    const now = Date.now()
    const insert = this.db.prepare(
      'INSERT INTO knowledge_references (document_id, chunk_id, source, session_id, distance, rank, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    this.db.exec('BEGIN')
    try {
      results.forEach((hit, i) => {
        insert.run(
          hit.documentId,
          hit.chunkId,
          ref.source,
          ref.sessionId ?? null,
          hit.distance,
          i,
          now
        )
      })
      // Amortized trim: locate the cutoff by PK offset (index walk, no
      // temp b-tree) instead of NOT IN over 20k materialized ids, and
      // only every TRIM_INTERVAL inserts.
      const maxRows = this.db.prepare(
        'SELECT MAX(id) AS max_id FROM knowledge_references'
      ).all() as Array<{ max_id: number | null }>
      const maxId = Number(maxRows[0]?.max_id ?? 0)
      if (
        this.lastReferenceTrimId === 0 ||
        maxId - this.lastReferenceTrimId >= KnowledgeService.REFERENCE_TRIM_INTERVAL
      ) {
        this.db.exec(
          'DELETE FROM knowledge_references WHERE id <= ' +
            `(SELECT id FROM knowledge_references ORDER BY id DESC LIMIT 1 OFFSET ${KnowledgeService.REFERENCE_CAP})`
        )
        this.lastReferenceTrimId = maxId
      }
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  /** Citation log for one document, newest first. */
  listDocumentReferences(documentId: number, limit = 200): ReferenceEntry[] {
    const capped = Math.max(1, Math.min(limit, 1000))
    return this.db.prepare(
      `SELECT id, document_id, chunk_id, source, session_id, distance, rank, created_at
       FROM knowledge_references
       WHERE document_id = ?
       ORDER BY id DESC LIMIT ?`
    ).all(documentId, capped) as unknown as ReferenceEntry[]
  }

  // --- Health -------------------------------------------------------------

  health(): KnowledgeHealthReport {
    // Vault counts.
    const vaultRows = this.db.prepare(
      'SELECT count(*) AS total, SUM(CASE WHEN watch = 1 THEN 1 ELSE 0 END) AS watching FROM knowledge_vaults'
    ).all() as Array<{ total: number; watching: number }>
    const vaultTotal = vaultRows[0]?.total ?? 0
    const vaultWatching = vaultRows[0]?.watching ?? 0

    // Document counts by status.
    const docRows = this.db.prepare(
      'SELECT status, count(*) AS n FROM knowledge_documents GROUP BY status'
    ).all() as Array<{ status: string; n: number }>
    const docCounts: Record<string, number> = {}
    let docTotal = 0
    for (const row of docRows) {
      docCounts[row.status] = row.n
      docTotal += row.n
    }

    // Chunk count.
    const chunkRows = this.db.prepare('SELECT count(*) AS n FROM knowledge_chunks').all() as Array<{ n: number }>
    const chunkTotal = chunkRows[0]?.n ?? 0

    // vec0 index size (vector count) — only when vec0 is available.
    let vecCount = 0
    if (this.vecAvailable) {
      const vecRows = this.db.prepare('SELECT count(*) AS n FROM knowledge_chunks_vec').all() as Array<{ n: number }>
      vecCount = vecRows[0]?.n ?? 0
    }

    // FTS5 content size (approximate).
    const ftsRows = this.db.prepare(
      'SELECT SUM(length(content)) AS total_len, count(*) AS n FROM knowledge_chunks_fts'
    ).all() as Array<{ total_len: number; n: number }>
    const ftsSizeBytes = ftsRows[0]?.total_len ?? 0
    const ftsTermCount = ftsRows[0]?.n ?? 0

    return {
      vaults: { total: vaultTotal, watching: vaultWatching, offline: vaultTotal - vaultWatching },
      documents: {
        total: docTotal,
        pending: docCounts['pending'] ?? 0,
        indexed: docCounts['indexed'] ?? 0,
        failed: docCounts['failed'] ?? 0,
        indexing: docCounts['indexing'] ?? 0,
        metadataOnly: docCounts['metadata_only'] ?? 0,
      },
      chunks: { total: chunkTotal },
      vecIndex: { vectorCount: vecCount },
      ftsIndex: { sizeBytes: ftsSizeBytes, termCount: ftsTermCount },
      ingestion: {
        inFlight: this.activeWorkers,
        queued: this.queue.length,
        lastSuccessAt: this._lastSuccessAt,
        lastFailureAt: this._lastFailureAt,
        lastError: this._lastError,
      },
      embedder: this._embedderStats,
    }
  }

  // In-memory ingestion tracking (populated by processIngest).
  private _lastSuccessAt: number | null = null
  private _lastFailureAt: number | null = null
  private _lastError: string | null = null
  private _embedderStats = { requestsLastHour: 0, tokensLastHour: 0, failuresLastHour: 0, avgLatencyMs: 0 }
}

// --- Helpers --------------------------------------------------------------

function guessMimeType(path: string): string {
  const ext = extname(path).toLowerCase()
  const map: Record<string, string> = {
    '.md': 'text/markdown',
    '.txt': 'text/plain',
    '.pdf': 'application/pdf',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  }
  return map[ext] || 'application/octet-stream'
}
