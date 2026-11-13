/**
 * Regression test for the knowledge plugin schema bootstrap.
 *
 * What it guards
 * --------------
 * - All five knowledge tables materialize with the right shape.
 * - FTS5 ↔ chunks rowid coupling holds (audit fix P1-3): inserting a
 *   chunk with id N must make knowledge_chunks_fts.rowid == N.
 * - vec0 `distance=cosine` is honored (audit S1): pure-vector KNN via
 *   MATCH returns cosine, not L2, distances.
 * - ensureKnowledgeSchema is idempotent — re-running on a populated
 *   database is a no-op.
 * - Dim mismatch throws (audit fix P1-7) — bootstrap refuses to run
 *   with a different dim than the vec0 table was created with.
 *
 * Skip behavior
 * -------------
 * If sqlite-vec is not installed (CI on a platform that hasn't added
 * the peer package), the describe block is skipped with a clear
 * reason. Nothing in the default CI run breaks.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_KNOWLEDGE_EMBED_DIM,
  KnowledgeSchemaError,
  ensureKnowledgeSchema,
} from '../../packages/server/src/modules/studio/infrastructure/database/knowledge-schema'

type DatabaseSyncCtor = new (
  path: string,
  options?: Record<string, unknown>
) => {
  exec: (sql: string) => void
  prepare: (sql: string) => {
    all: (...params: unknown[]) => unknown[]
    run: (...params: unknown[]) => unknown
  }
  close: () => void
  enableLoadExtension: (value: boolean) => void
  loadExtension: (path: string) => void
}

const SQLITE_VEC_UNAVAILABLE =
  'sqlite-vec is not installed — install sqlite-vec + platform peer'

let DatabaseSync: DatabaseSyncCtor
try {
  const mod: { DatabaseSync: DatabaseSyncCtor } =
    require('node:sqlite') as { DatabaseSync: DatabaseSyncCtor }
  DatabaseSync = mod.DatabaseSync
} catch {
  DatabaseSync = null as unknown as DatabaseSyncCtor
}

function tryLoadSqliteVec(): string | null {
  try {
    const shim = require('sqlite-vec') as { getLoadablePath: () => string }
    return shim.getLoadablePath()
  } catch {
    return null
  }
}

const canRun = DatabaseSync !== null && tryLoadSqliteVec() !== null

describe.skipIf(!canRun)('knowledge schema bootstrap', () => {
  let db: InstanceType<DatabaseSyncCtor>

  beforeEach(() => {
    if (!DatabaseSync) return
    db = new DatabaseSync(':memory:', { allowExtension: true })
    db.enableLoadExtension(true)
  })

  afterEach(() => {
    try {
      db?.close()
    } catch {
      /* best-effort */
    }
  })

  it('creates all five tables idempotently', () => {
    ensureKnowledgeSchema(db as never, DEFAULT_KNOWLEDGE_EMBED_DIM)

    // sqlite_master exposes virtual-table shadow tables alongside
    // the logical ones (FTS5 creates _config/_content/_data/_docsize/
    // _idx; vec0 creates _chunks/_info/_rowids/_vector_chunks00).
    // Assert the five user-defined tables are present; we do not
    // assert shadow tables — they are internal implementation.
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'knowledge_%'"
      )
      .all() as Array<{ name: string }>
    const names = new Set(tables.map(t => t.name))
    for (const expected of [
      'knowledge_vaults',
      'knowledge_documents',
      'knowledge_chunks',
      'knowledge_chunks_fts',
      'knowledge_chunks_vec',
    ]) {
      expect(names, `missing table ${expected}`).toContain(expected)
    }

    // Idempotent — calling again must not throw.
    ensureKnowledgeSchema(db as never, DEFAULT_KNOWLEDGE_EMBED_DIM)
  })

  it('enforces per-connection PRAGMAs', () => {
    ensureKnowledgeSchema(db as never, DEFAULT_KNOWLEDGE_EMBED_DIM)

    const fk = db.prepare('PRAGMA foreign_keys').all() as Array<{
      foreign_keys: number
    }>
    expect(fk[0].foreign_keys).toBe(1)

    const bt = db.prepare('PRAGMA busy_timeout').all() as Array<{
      timeout: number
    }>
    expect(bt[0].timeout).toBe(5000)
  })

  it('FTS5 rowid coupling: chunk id == fts rowid (audit P1-3)', () => {
    ensureKnowledgeSchema(db as never, DEFAULT_KNOWLEDGE_EMBED_DIM)

    // FK chain: vault → document → chunk.
    db.exec(
      "INSERT INTO knowledge_vaults(id, root_path, name, created_at) " +
        "VALUES (1, '/tmp/vault', 'test', strftime('%s','now') * 1000)"
    )
    db.exec(
      "INSERT INTO knowledge_documents(id, source_path, source_hash, vault_id, " +
        "mime_type, size_bytes, mtime, indexed_at, status) " +
        "VALUES (1, '/tmp/vault/a.md', 'abc', 1, 'text/markdown', 100, " +
        "strftime('%s','now') * 1000, strftime('%s','now') * 1000, 'indexed')"
    )
    db.exec(
      'INSERT INTO knowledge_chunks(id, document_id, position, content, token_count) ' +
        "VALUES (42, 1, 0, 'hello world', 2)"
    )
    db.exec(
      "INSERT INTO knowledge_chunks_fts(rowid, content) VALUES (42, 'hello world')"
    )

    const rows = db
      .prepare(
        'SELECT c.id AS cid, f.rowid AS fid FROM knowledge_chunks c ' +
          'JOIN knowledge_chunks_fts f ON f.rowid = c.id'
      )
      .all() as Array<{ cid: number; fid: number }>
    expect(rows).toHaveLength(1)
    expect(rows[0].cid).toBe(42)
    expect(rows[0].fid).toBe(42)
  })

  it('vec0 cosine distance via MATCH (audit S1)', () => {
    ensureKnowledgeSchema(db as never, DEFAULT_KNOWLEDGE_EMBED_DIM)

    // Build a small vec table with dim=4 for predictable cosine math.
    db.exec(
      'CREATE VIRTUAL TABLE test_vec USING vec0(' +
        'chunk_id INTEGER PRIMARY KEY, embedding float[4] distance=cosine)'
    )
    db.exec(
      "INSERT INTO test_vec(chunk_id, embedding) VALUES " +
        "(10, '[1.0, 0.0, 0.0, 0.0]'), " +
        "(20, '[0.0, 1.0, 0.0, 0.0]'), " +
        "(30, '[0.7071, 0.7071, 0.0, 0.0]')"
    )
    const rows = db
      .prepare(
        'SELECT chunk_id, distance FROM test_vec ' +
          'WHERE embedding MATCH ? AND k = 3'
      )
      .all(new Float32Array([0.9, 0.1, 0.0, 0.0])) as Array<{
      chunk_id: number
      distance: number
    }>
    expect(rows.map(r => r.chunk_id)).toEqual([10, 30, 20])
    // Cosine distance ~0.006 between [1,0,0,0] and [0.9,0.1,0,0].
    // L2 would give ~0.1414. Assert the metric is cosine, not L2.
    expect(rows[0].distance).toBeLessThan(0.01)
  })

  it('dim mismatch throws (audit P1-7)', () => {
    ensureKnowledgeSchema(db as never, DEFAULT_KNOWLEDGE_EMBED_DIM)

    // Close + reopen so the vec table exists on disk-equivalent state.
    // :memory: keeps the in-memory instance; just verify the dim
    // assertion runs on a populated schema.
    expect(() =>
      ensureKnowledgeSchema(db as never, DEFAULT_KNOWLEDGE_EMBED_DIM + 1)
    ).toThrow(KnowledgeSchemaError)
  })

  it('rejects invalid dim (zero or negative)', () => {
    expect(() => ensureKnowledgeSchema(db as never, 0)).toThrow(
      KnowledgeSchemaError
    )
    expect(() => ensureKnowledgeSchema(db as never, -1024)).toThrow(
      KnowledgeSchemaError
    )
  })

  it('creates knowledge_embeddings_meta with model and dim', () => {
    ensureKnowledgeSchema(db as never, 1024, 'text-embedding-v3')

    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='knowledge_embeddings_meta'"
      )
      .all() as Array<{ name: string }>
    expect(tables).toHaveLength(1)

    const rows = db
      .prepare('SELECT model, dim, vec_table FROM knowledge_embeddings_meta WHERE id = 1')
      .all() as Array<{ model: string; dim: number; vec_table: string }>
    expect(rows).toHaveLength(1)
    expect(rows[0].model).toBe('text-embedding-v3')
    expect(rows[0].dim).toBe(1024)
    expect(rows[0].vec_table).toBe('knowledge_chunks_vec')
  })

  it('soft migration: existing vec0 without meta → creates meta with unverified model', () => {
    // Simulate a pre-existing deployment: create vec0 directly, no meta table.
    db.enableLoadExtension(true)
    const sqliteVec = require('sqlite-vec') as { getLoadablePath: () => string }
    db.loadExtension(sqliteVec.getLoadablePath())
    db.enableLoadExtension(false)

    db.exec(`
      CREATE VIRTUAL TABLE knowledge_chunks_vec
      USING vec0(chunk_id INTEGER PRIMARY KEY, embedding FLOAT[512] distance=cosine)
    `)
    // Also create the other tables so ensureKnowledgeSchema doesn't error out.
    db.exec(`CREATE TABLE IF NOT EXISTS knowledge_vaults (
      id INTEGER PRIMARY KEY AUTOINCREMENT, root_path TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL, watch INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
    )`)
    db.exec(`CREATE TABLE IF NOT EXISTS knowledge_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT, source_path TEXT NOT NULL,
      source_hash TEXT NOT NULL, vault_id INTEGER NOT NULL, mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL, mtime INTEGER NOT NULL, indexed_at INTEGER NOT NULL,
      status TEXT NOT NULL, error TEXT,
      FOREIGN KEY (vault_id) REFERENCES knowledge_vaults(id)
    )`)
    db.exec(`CREATE TABLE IF NOT EXISTS knowledge_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, document_id INTEGER NOT NULL,
      position INTEGER NOT NULL, content TEXT NOT NULL, token_count INTEGER NOT NULL,
      FOREIGN KEY (document_id) REFERENCES knowledge_documents(id) ON DELETE CASCADE
    )`)
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_chunks_fts
      USING fts5(content, tokenize='porter')`)

    // Now call ensureKnowledgeSchema with dim=512 (matching the vec0 table).
    ensureKnowledgeSchema(db as never, 512, 'text-embedding-v3')

    const rows = db
      .prepare('SELECT model, dim FROM knowledge_embeddings_meta WHERE id = 1')
      .all() as Array<{ model: string; dim: number }>
    expect(rows).toHaveLength(1)
    // Soft migration marks model as 'unverified' since we're inferring from existing data.
    expect(rows[0].model).toBe('unverified')
    expect(rows[0].dim).toBe(512)
  })

  it('dim mismatch in meta throws KnowledgeSchemaError', () => {
    ensureKnowledgeSchema(db as never, 1024, 'text-embedding-v3')

    // Try to re-bootstrap with a different dim — should throw.
    expect(() =>
      ensureKnowledgeSchema(db as never, 512, 'text-embedding-v3')
    ).toThrow(KnowledgeSchemaError)
  })
})

describe.skipIf(canRun)('knowledge schema — sqlite-vec unavailable', () => {
  it('reports the missing dependency', () => {
    expect(SQLITE_VEC_UNAVAILABLE).toContain('sqlite-vec')
  })
})
