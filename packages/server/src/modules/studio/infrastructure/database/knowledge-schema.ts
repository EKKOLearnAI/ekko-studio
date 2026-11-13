/**
 * Knowledge plugin — DDL bootstrap for the shared SQLite connection.
 *
 * This file owns the schema definitions for the knowledge plugin. The
 * plugin shares the `hermes-web-ui.db` connection exposed by `getDb()`;
 * it never opens a second one (per AGENTS.md rule).
 *
 * `ensureKnowledgeSchema(db, dim)` is called once at service init.
 * It is additive: every CREATE statement uses IF NOT EXISTS, so re-running
 * it on an already-bootstrapped database is a no-op.
 *
 * Hard invariants (audit fixes, see architecture doc §11):
 *   - Per-connection PRAGMAs (foreign_keys, busy_timeout) are enforced
 *     on every boot (P0-2).
 *   - Journal-mode != 'wal' emits a warning (P0-2 dev caveat).
 *   - `knowledge_chunks_vec` is created with `distance=cosine` —
 *     without it, vec0's default metric is L2, and hybrid / pure-vector
 *     searches return incomparable scores (S1).
 *   - `dim` is baked in at table creation. Re-running with a different
 *     dim against an existing table throws KnowledgeSchemaError (P1-7).
 *   - FTS5 and vec0 are virtual tables — they cannot participate in
 *     FK cascades. Worker code must explicitly delete from both in
 *     the same transaction as `knowledge_chunks` (P0-1).
 */

import type { DatabaseSync } from 'node:sqlite'

export class KnowledgeSchemaError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'KnowledgeSchemaError'
  }
}

/**
 * Default embedding dimension for Tongyi text-embedding-v3.
 * Must match the model in use; changing it after the vec0 table
 * is created requires re-indexing the entire corpus (architecture
 * doc §3.4, audit fix P1-7).
 *
 * v3 verified dims: 1024 / 768 / 512 / 256 / 128 / 64.
 * 1536 is a v2-only dim — do NOT set it here.
 */
export const DEFAULT_KNOWLEDGE_EMBED_DIM = 1024

/**
 * Result of bootstrapping the knowledge plugin schema. Tells the caller
 * whether vec0 (and hence vector search) is available — if not, FTS5
 * keyword search still works and the rest of the plugin keeps operating.
 */
export interface KnowledgeSchemaBootstrapStatus {
  /** true iff sqlite-vec is installed AND vec0 table is usable. */
  vecAvailable: boolean
  /** Populated when vecAvailable is false — explains why. */
  vecReason?: string
}

/**
 * Idempotently bootstrap every table the knowledge plugin needs on
 * the shared connection. Returns a status object describing whether
 * sqlite-vec (vector search) was successfully loaded. Throws
 * KnowledgeSchemaError only on unrecoverable inconsistencies (e.g.,
 * embed-dim mismatch against an already-created vec0 table).
 *
 * Graceful-degradation path: if sqlite-vec is not installed (e.g.,
 * on a Docker image where it was moved to optionalDependencies and
 * failed to install), the base tables (vaults/documents/chunks/fts)
 * are still created, but knowledge_chunks_vec is skipped. The caller
 * (KnowledgeService) must check vecAvailable and refuse search /
 * ingest tasks that depend on vec0.
 *
 * Root-cause fix (2026-09-10): loadSqliteVec now returns a status
 * instead of throwing. The extension is loaded on every boot because
 * extension loading is per-connection, not per-database.
 */
export function ensureKnowledgeSchema(
  db: DatabaseSync,
  dim: number = DEFAULT_KNOWLEDGE_EMBED_DIM,
  model: string = 'text-embedding-v3',
): KnowledgeSchemaBootstrapStatus {
  if (!Number.isInteger(dim) || dim <= 0) {
    throw new KnowledgeSchemaError(`Invalid embed dim: ${dim}`)
  }

  // --- Per-connection PRAGMAs (audit fix P0-2). ---
  db.exec('PRAGMA foreign_keys=ON')
  db.exec('PRAGMA busy_timeout=5000')

  // --- Journal-mode assertion (P0-2 dev caveat). ---
  const jm = db.prepare('PRAGMA journal_mode').all() as Array<{
    journal_mode: string
  }>
  const mode = jm[0]?.journal_mode
  if (mode !== 'wal') {
    // eslint-disable-next-line no-console
    console.warn(
      `[knowledge] journal_mode=${mode}; WAL is required for concurrent reads. ` +
        `Consider switching dev to WAL (audit fix P0-2).`
    )
  }

  // --- sqlite-vec extension (lazy, idempotent, graceful degradation). ---
  // Track whether vec0 existed BEFORE this boot — used by ensureEmbeddingsMeta
  // to distinguish soft migration (pre-existing vec0) from fresh install.
  const vecPreExisted = vecTableExists(db)
  const vecStatus = loadSqliteVec(db)

  // --- Idempotent DDL. ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_vaults (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      root_path  TEXT NOT NULL UNIQUE,
      name       TEXT NOT NULL,
      watch      INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    )
  `)

  // --- Vault kind migration (task-11, v0.8.8) ---
  // 'auto'   → bootstrap-created; ingest records metadata_only only.
  // 'manual' → user-created; full extract→chunk→embed ingest.
  // 'usb'    → on-demand mount vault (wired in task-12; FTS5-only).
  // SQLite has no ADD COLUMN IF NOT EXISTS — a duplicate-column error is
  // the expected no-op signal on already-migrated databases. Any other
  // failure (corruption, disk full) must surface, not vanish.
  try {
    db.exec(
      "ALTER TABLE knowledge_vaults ADD COLUMN kind TEXT NOT NULL DEFAULT 'manual'"
    )
  } catch (err) {
    if (!(err instanceof Error) || !err.message.toLowerCase().includes('duplicate column')) {
      throw err
    }
  }
  db.exec(
    'CREATE INDEX IF NOT EXISTS knowledge_vaults_kind ON knowledge_vaults(kind)'
  )

  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_documents (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      source_path  TEXT NOT NULL,
      source_hash  TEXT NOT NULL,
      vault_id     INTEGER NOT NULL,
      mime_type    TEXT NOT NULL,
      size_bytes   INTEGER NOT NULL,
      mtime        INTEGER NOT NULL,
      indexed_at   INTEGER NOT NULL,
      status       TEXT NOT NULL,
      error        TEXT,
      FOREIGN KEY (vault_id) REFERENCES knowledge_vaults(id)
    )
  `)
  db.exec(
    'CREATE INDEX IF NOT EXISTS knowledge_documents_source_hash ' +
      'ON knowledge_documents(source_hash)'
  )
  db.exec(
    'CREATE INDEX IF NOT EXISTS knowledge_documents_vault_status ' +
      'ON knowledge_documents(vault_id, status)'
  )

  // --- Document provenance column (task-12, v0.8.9) ---
  // 'agent-workspace' vs 'task-finalize' let the auto_tasks vault
  // distinguish continuously-watched workspace files from semi-auto
  // archives written at task finalize, sharing one root path. Default
  // 'unknown' keeps every pre-existing row honest. Placed AFTER the
  // documents table is created (an ALTER before CREATE has no target).
  try {
    db.exec(
      "ALTER TABLE knowledge_documents ADD COLUMN source TEXT NOT NULL DEFAULT 'unknown'"
    )
  } catch (err) {
    if (!(err instanceof Error) || !err.message.toLowerCase().includes('duplicate column')) {
      throw err
    }
  }

  // --- Status enum check as a trigger (task-12) ---
  // A table-level CHECK cannot be ALTERed, so the enum guard lives in
  // a trigger: extending the set ('fts_only', 'unmounted') without DDL
  // drift is then a matter of replacing this trigger. Existing rows are
  // untouched — the trigger only gates new INSERTs.
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS knowledge_documents_status_check
    BEFORE INSERT ON knowledge_documents
    FOR EACH ROW
    WHEN NEW.status NOT IN (
      'pending','indexing','indexed','failed','metadata_only','fts_only','unmounted'
    )
    BEGIN
      SELECT RAISE(ABORT, 'invalid document status');
    END
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_chunks (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id  INTEGER NOT NULL,
      position     INTEGER NOT NULL,
      content      TEXT NOT NULL,
      token_count  INTEGER NOT NULL,
      FOREIGN KEY (document_id) REFERENCES knowledge_documents(id) ON DELETE CASCADE
    )
  `)
  db.exec(
    'CREATE INDEX IF NOT EXISTS knowledge_chunks_document ' +
      'ON knowledge_chunks(document_id)'
  )

  // Retrieval audit log — every search hit is recorded so the UI can answer
  // "which documents did my tasks actually cite, and are those citations
  // still valid?". Bounded at ~20k rows (trimmed on write) to protect the
  // single-file SQLite budget on low-memory devices.
  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_references (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER NOT NULL,
      chunk_id    INTEGER NOT NULL,
      source      TEXT NOT NULL,
      session_id  TEXT,
      distance    REAL,
      rank        INTEGER NOT NULL,
      created_at  INTEGER NOT NULL,
      FOREIGN KEY (document_id) REFERENCES knowledge_documents(id) ON DELETE CASCADE
    )
  `)
  db.exec(
    'CREATE INDEX IF NOT EXISTS knowledge_references_document ' +
      'ON knowledge_references(document_id, created_at DESC)'
  )

  // FTS5 virtual table — shadow of knowledge_chunks.content.
  // The worker MUST insert with an explicit rowid equal to chunk.id
  // so the join in hybrid search remains correct (audit fix P1-3).
  // Virtual tables cannot participate in foreign keys (P0-1).
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_chunks_fts
    USING fts5(content, tokenize='porter')
  `)

  // vec0 virtual table with cosine distance — only created when
  // sqlite-vec was successfully loaded. The dim is baked in at
  // creation time; switching dims requires re-creating the table
  // plus a full re-embed (P1-7). Without distance=cosine, the vec0
  // default is L2 and the hybrid / pure-vector scores disagree (S1).
  if (vecStatus.available) {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_chunks_vec
      USING vec0(chunk_id INTEGER PRIMARY KEY, embedding FLOAT[${dim}] distance=cosine)
    `)

    // --- Dim-mismatch check (P1-7). ---
    assertVecDim(db, dim)
  }

  // --- Embedding metadata (model + dim persistence). ---
  // Persists the embedding model and dimension so that a config change
  // (e.g. switching models without re-indexing) is detected at boot
  // rather than silently producing garbage search results.
  ensureEmbeddingsMeta(db, dim, model, vecStatus.available, vecPreExisted)

  return { vecAvailable: vecStatus.available, vecReason: vecStatus.reason }
}

/**
 * Check if the knowledge_chunks_vec virtual table exists in sqlite_master.
 * Used to distinguish pre-existing vec0 (soft migration) from freshly
 * created vec0 (fresh install) in ensureEmbeddingsMeta.
 */
function vecTableExists(db: DatabaseSync): boolean {
  const rows = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='knowledge_chunks_vec'"
    )
    .all() as Array<{ name: string | null }>
  return rows.length > 0
}

/**
 * Load sqlite-vec into the shared database connection.
 *
 * The extension is loaded on EVERY call: extension loading is
 * per-connection, not per-database. The vec0 table surviving in
 * sqlite_master from a prior boot does NOT mean the native module
 * is present in the current connection (root-cause fix 2026-09-10).
 *
 * Graceful degradation: if the sqlite-vec package is not installed,
 * returns `{ available: false, reason: ... }` rather than throwing.
 * This lets the rest of the plugin (vaults, documents, FTS5 keyword
 * search) continue working on Docker / source-deploy targets where
 * vec0 failed to install.
 *
 * Loading gate: opens enableLoadExtension(true) momentarily and
 * closes it after loadExtension, keeping the window during which
 * arbitrary native extensions can be loaded as narrow as possible
 * (root-cause fix 2026-09-10).
 */
interface SqliteVecLoadResult {
  available: boolean
  reason?: string
}

function loadSqliteVec(db: DatabaseSync): SqliteVecLoadResult {
  // NOTE: Extension loading is per-connection, NOT per-database.
  // The vec0 table may exist in sqlite_master from a prior boot,
  // but the native extension must be loaded into THIS connection.
  // Do NOT skip loadExtension based on table existence.

  let sqliteVec: { getLoadablePath: () => string }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    sqliteVec = require('sqlite-vec')
  } catch (err) {
    return {
      available: false,
      reason: `sqlite-vec package is not installed (${(err as Error).message}). ` +
        'Vector search and ingest will be disabled; FTS5 keyword search still works. ' +
        'Install: npm install sqlite-vec',
    }
  }

  try {
    db.enableLoadExtension(true)
    try {
      db.loadExtension(sqliteVec.getLoadablePath())
    } finally {
      db.enableLoadExtension(false)
    }
    return { available: true }
  } catch (err) {
    return {
      available: false,
      reason: `loadExtension failed: ${(err as Error).message}. ` +
        'Vector search and ingest will be disabled; FTS5 keyword search still works.',
    }
  }
}

function assertVecDim(db: DatabaseSync, expectedDim: number): void {
  // vec0 virtual tables don't expose their columns via PRAGMA
  // table_info, so we parse the CREATE VIRTUAL TABLE statement
  // stored in sqlite_master. This is stable across sqlite-vec
  // versions because FLOAT[<dim>] is part of the documented syntax.
  const master = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='knowledge_chunks_vec'"
    )
    .all() as Array<{ sql: string | null }>
  if (!master[0]?.sql) return // table doesn't exist yet (shouldn't happen here)
  const match = master[0].sql.match(/FLOAT\[(\d+)\]/)
  if (!match) return
  const actualDim = Number(match[1])
  if (actualDim !== expectedDim) {
    throw new KnowledgeSchemaError(
      `knowledge_chunks_vec already exists with dim=${actualDim}; ` +
        `refusing to bootstrap with dim=${expectedDim}. ` +
        `Switching dims requires re-indexing the entire corpus ` +
        `(architecture doc §3.4, audit fix P1-7).`
    )
  }
}

/**
 * Create or verify the `knowledge_embeddings_meta` table.
 *
 * This table persists the embedding model name and dimension that were
 * used to create the vec0 index. On subsequent boots, it compares the
 * stored values with the current config and throws if they diverge —
 * switching embedding models without re-indexing silently corrupts
 * search results because the stored vectors are in a different space.
 *
 * Soft migration for existing deployments: if `knowledge_chunks_vec`
 * exists but `knowledge_embeddings_meta` doesn't (i.e. the deployment
 * was created before this table existed), we parse the dim from the
 * vec0 CREATE TABLE sql and insert a record with model='unverified'.
 * The caller should surface this as a warning prompting re-index.
 */
function ensureEmbeddingsMeta(
  db: DatabaseSync,
  dim: number,
  model: string,
  vecAvailable: boolean,
  vecPreExisted: boolean,
): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_embeddings_meta (
      id         INTEGER PRIMARY KEY CHECK (id = 1),
      model      TEXT NOT NULL,
      dim        INTEGER NOT NULL,
      vec_table  TEXT NOT NULL DEFAULT 'knowledge_chunks_vec',
      created_at INTEGER NOT NULL
    )
  `)

  const rows = db.prepare(
    'SELECT model, dim FROM knowledge_embeddings_meta WHERE id = 1'
  ).all() as Array<{ model: string; dim: number }>

  if (rows.length > 0) {
    // Existing record — compare with current config.
    const existing = rows[0]
    if (existing.dim !== dim) {
      throw new KnowledgeSchemaError(
        `knowledge_embeddings_meta records dim=${existing.dim} but config ` +
          `specifies dim=${dim}. Switching embedding dimensions requires ` +
          `re-indexing the entire corpus. ` +
          `Fix: remove all vaults, delete the knowledge database tables, ` +
          `and re-add vaults after updating KNOWLEDGE_EMBED_DIM.`
      )
    }
    // Model mismatch is a warning (not a hard error) because the vec0
    // dim check above already guards against silently incompatible
    // vectors. A model change with the same dim produces vectors in a
    // different semantic space but the same shape — search will return
    // results, just with degraded relevance. Prompt re-index.
    if (existing.model !== model && existing.model !== 'unverified') {
      // eslint-disable-next-line no-console
      console.warn(
        `[knowledge] embedding model changed: meta records '${existing.model}' ` +
          `but config specifies '${model}'. Search quality may be degraded. ` +
          `Re-index by removing all vaults and re-adding them after ` +
          `confirming the new model in the config.`
      )
    }
    return
  }

  // No existing record — insert one.
  // For soft migration: if vec0 existed before this boot (pre-existing
  // deployment without meta table), parse dim from vec0 sql and mark
  // model as 'unverified'. For fresh installs, use config values directly.
  let insertModel = model
  let insertDim = dim
  if (vecAvailable && vecPreExisted) {
    // Soft migration: vec0 existed but meta didn't → infer from vec0.
    const master = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='knowledge_chunks_vec'"
    ).all() as Array<{ sql: string | null }>
    if (master[0]?.sql) {
      const match = master[0].sql.match(/FLOAT\[(\d+)\]/)
      if (match) {
        insertDim = Number(match[1])
        insertModel = 'unverified'
      } else {
        // eslint-disable-next-line no-console
        console.warn(
          '[knowledge] soft migration: could not parse dim from vec0 SQL. ' +
            'Meta row will use config dim. Admin should verify and re-index.'
        )
      }
    }
  }

  db.prepare(
    'INSERT INTO knowledge_embeddings_meta (id, model, dim, vec_table, created_at) VALUES (1, ?, ?, ?, ?)'
  ).run(insertModel, insertDim, 'knowledge_chunks_vec', Date.now())
}
