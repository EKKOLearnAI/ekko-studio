/**
 * Vault kind taxonomy (task-11, v0.8.8).
 *
 * What it guards
 * --------------
 * - Fresh databases get the `kind` column with DEFAULT 'manual'.
 * - Pre-v0.8.8 databases (vaults table without `kind`) are migrated
 *   in place by ensureKnowledgeSchema — existing rows become 'manual'.
 * - The migration is idempotent (re-running does not throw).
 * - addVault defaults to 'manual', accepts explicit kinds, and
 *   rejects unknown kind values at the service boundary.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_KNOWLEDGE_EMBED_DIM,
  ensureKnowledgeSchema,
} from '../../packages/server/src/modules/studio/infrastructure/database/knowledge-schema'
import {
  ALLOWED_VAULT_KINDS,
  KnowledgeService,
  isVaultKind,
} from '../../packages/server/src/modules/studio/services/knowledge/knowledge.service'
import type { KnowledgeConfig } from '../../packages/server/src/modules/studio/services/knowledge/config'
import type { Embedder } from '../../packages/server/src/modules/studio/services/knowledge/embedder'

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

let DatabaseSync: DatabaseSyncCtor
try {
  const mod = require('node:sqlite') as { DatabaseSync: DatabaseSyncCtor }
  DatabaseSync = mod.DatabaseSync
} catch {
  DatabaseSync = null as unknown as DatabaseSyncCtor
}

function tryLoadSqliteVec(): string | null {
  try {
    return (require('sqlite-vec') as { getLoadablePath: () => string }).getLoadablePath()
  } catch {
    return null
  }
}

const canRun = DatabaseSync !== null && tryLoadSqliteVec() !== null

const TEST_CONFIG: KnowledgeConfig = {
  enabled: true,
  embedProvider: 'tongyi',
  embedModel: 'text-embedding-v3',
  embedDim: 4,
  embedApiKey: 'test-key',
  embedApiBase: 'https://test.example.com',
  embedBatchSize: 10,
  embedTimeoutMs: 5000,
  embedRetries: 3,
  chunkSize: 500,
  chunkOverlap: 50,
  chunkFallbackSize: 800,
  queueDepth: 20,
  supportedExtensions: ['.md', '.txt'],
  maxFileSizeBytes: 20 * 1024 * 1024,
}

const noopEmbedder: Embedder = {
  embed: async (texts: string[]) => texts.map(() => new Float32Array([0.9, 0.1, 0, 0])),
}

describe.skipIf(!canRun)('knowledge vault kind', () => {
  let db: InstanceType<DatabaseSyncCtor>

  beforeEach(() => {
    if (!DatabaseSync) return
    db = new DatabaseSync(':memory:', { allowExtension: true })
    db.enableLoadExtension(true)
    db.loadExtension(tryLoadSqliteVec()!)
  })

  afterEach(() => {
    try { db.close() } catch { /* best-effort */ }
  })

  function vaultColumns(): Set<string> {
    const rows = db.prepare(
      "SELECT name FROM pragma_table_info('knowledge_vaults') AS ti"
    ).all() as Array<{ name: string }>
    return new Set(rows.map(r => r.name))
  }

  it('creates the kind column with default manual on a fresh database', () => {
    ensureKnowledgeSchema(db as never, DEFAULT_KNOWLEDGE_EMBED_DIM)

    expect(vaultColumns()).toContain('kind')

    db.prepare(
      "INSERT INTO knowledge_vaults (root_path, name, watch, created_at) VALUES ('/tmp/v1', 'v1', 1, 0)"
    ).run()
    const row = db.prepare('SELECT kind FROM knowledge_vaults WHERE name = ?').all('v1') as Array<{ kind: string }>
    expect(row[0].kind).toBe('manual')
  })

  it('migrates a pre-v0.8.8 vaults table in place, defaulting rows to manual', () => {
    // Simulate a v0.8.7 database: vaults table exists WITHOUT kind,
    // with a pre-existing row.
    db.exec(`
      CREATE TABLE knowledge_vaults (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        root_path  TEXT NOT NULL UNIQUE,
        name       TEXT NOT NULL,
        watch      INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      )
    `)
    db.prepare(
      "INSERT INTO knowledge_vaults (root_path, name, watch, created_at) VALUES ('/tmp/old', 'old-vault', 1, 0)"
    ).run()

    expect(() => ensureKnowledgeSchema(db as never, DEFAULT_KNOWLEDGE_EMBED_DIM)).not.toThrow()

    expect(vaultColumns()).toContain('kind')
    const row = db.prepare('SELECT kind FROM knowledge_vaults WHERE name = ?').all('old-vault') as Array<{ kind: string }>
    expect(row[0].kind).toBe('manual')
  })

  it('is idempotent — re-running the migration does not duplicate the column', () => {
    ensureKnowledgeSchema(db as never, DEFAULT_KNOWLEDGE_EMBED_DIM)
    expect(() => ensureKnowledgeSchema(db as never, DEFAULT_KNOWLEDGE_EMBED_DIM)).not.toThrow()

    const kindCols = db.prepare(
      "SELECT count(*) AS n FROM pragma_table_info('knowledge_vaults') WHERE name = 'kind'"
    ).all() as Array<{ n: number }>
    expect(kindCols[0].n).toBe(1)
  })

  it('addVault defaults to manual and accepts explicit kinds', () => {
    // service.init() bootstraps the schema with TEST_CONFIG.embedDim (4) —
    // do NOT pre-run ensureKnowledgeSchema here or the dim guard (P1-7)
    // would refuse the 4-dim service on a 1024-dim vec table.
    const service = new KnowledgeService(db as never, TEST_CONFIG, { embedder: noopEmbedder })
    service.init()

    const manual = service.addVault('/tmp/kv-manual', 'manual-vault')
    expect(manual.kind).toBe('manual')

    const auto = service.addVault('/tmp/kv-auto', 'auto-vault', 'auto')
    expect(auto.kind).toBe('auto')

    for (const kind of ALLOWED_VAULT_KINDS) {
      expect(isVaultKind(kind)).toBe(true)
    }
    expect(isVaultKind('nope')).toBe(false)
  })

  it('addVault rejects an unknown kind', () => {
    const service = new KnowledgeService(db as never, TEST_CONFIG, { embedder: noopEmbedder })
    service.init()

    expect(() =>
      service.addVault('/tmp/kv-bad', 'bad-vault', 'nope' as never),
    ).toThrow(/invalid vault kind/)
  })
})
