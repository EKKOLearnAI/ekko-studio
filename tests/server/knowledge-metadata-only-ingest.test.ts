/**
 * metadata_only ingest mode (task-11, v0.8.8).
 *
 * What it guards
 * --------------
 * - An auto-kind vault ingests files as metadata_only: one documents
 *   row, ZERO rows in chunks / FTS5 / vec0.
 * - metadata_only documents are invisible to search by construction.
 * - promoteDocument() runs the regular pipeline (metadata_only →
 *   pending → indexing → indexed) and the file becomes searchable.
 * - promoteDocument() rejects unknown ids and non-metadata_only rows.
 * - Manual vaults keep full-ingest behavior (v0.8.7 regression).
 */

import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KnowledgeService } from '../../packages/server/src/modules/studio/services/knowledge/knowledge.service'
import type { KnowledgeConfig } from '../../packages/server/src/modules/studio/services/knowledge/config'
import type { Embedder } from '../../packages/server/src/modules/studio/services/knowledge/embedder'

type DatabaseSyncCtor = new (path: string, options?: Record<string, unknown>) => {
  exec: (sql: string) => void
  prepare: (sql: string) => {
    all: (...params: unknown[]) => unknown[]
    run: (...params: unknown[]) => unknown
  }
  close: () => void
  loadExtension: (path: string) => void
  enableLoadExtension: (value: boolean) => void
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

/** Deterministic mock embedder: every chunk/query → [0.9, 0.1, 0, 0]. */
function createMockEmbedder(): Embedder {
  return {
    embed: async (texts: string[]) => texts.map(() => new Float32Array([0.9, 0.1, 0, 0])),
  }
}

describe.skipIf(!canRun)('metadata_only ingest mode', () => {
  let db: InstanceType<DatabaseSyncCtor>
  let tempDir: string
  let service: KnowledgeService

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'hermes-knowledge-meta-'))
    db = new DatabaseSync(':memory:', { allowExtension: true })
    db.enableLoadExtension(true)
    db.loadExtension(tryLoadSqliteVec()!)

    service = new KnowledgeService(db, TEST_CONFIG, {
      embedder: createMockEmbedder(),
      extractorFn: (path: string) => {
        const { readFileSync } = require('fs') as typeof import('fs')
        const text = readFileSync(path, 'utf-8')
        return { text, tokenCount: text.split(/\s+/).length }
      },
    })
    service.init()
  })

  afterEach(() => {
    try { db.close() } catch { /* best-effort */ }
    if (tempDir) rmSync(tempDir, { recursive: true, force: true })
  })

  function rowCount(table: string): number {
    const rows = db.prepare(`SELECT count(*) AS n FROM ${table}`).all() as Array<{ n: number }>
    return rows[0].n
  }

  function docStatus(documentId: number): string {
    const rows = db.prepare(
      'SELECT status FROM knowledge_documents WHERE id = ?'
    ).all(documentId) as Array<{ status: string }>
    return rows[0]?.status ?? 'missing'
  }

  it('auto vault ingests as metadata_only with zero index rows', async () => {
    const filePath = join(tempDir, 'dropped.md')
    writeFileSync(filePath, 'settlement agreement clauses between parties')

    const vault = service.addVault(tempDir, 'auto-vault', 'auto')
    const result = await service.ingest(filePath, vault.id)

    expect(result.status).toBe('metadata_only')
    expect(docStatus(result.documentId)).toBe('metadata_only')
    expect(rowCount('knowledge_chunks')).toBe(0)
    expect(rowCount('knowledge_chunks_fts')).toBe(0)
    expect(rowCount('knowledge_chunks_vec')).toBe(0)
  })

  it('metadata_only documents are invisible to search', async () => {
    const filePath = join(tempDir, 'hidden.md')
    writeFileSync(filePath, 'confidential settlement agreement clauses')

    const vault = service.addVault(tempDir, 'auto-vault', 'auto')
    await service.ingest(filePath, vault.id)

    const results = await service.search({ query: 'settlement agreement', hybrid: false, limit: 10 })
    expect(results.results).toHaveLength(0)
  })

  it('promoteDocument runs the full pipeline and makes the file searchable', async () => {
    const filePath = join(tempDir, 'promoted.md')
    writeFileSync(filePath, 'confidential settlement agreement clauses')

    const vault = service.addVault(tempDir, 'auto-vault', 'auto')
    const meta = await service.ingest(filePath, vault.id)
    expect(meta.status).toBe('metadata_only')

    const promoted = await service.promoteDocument(meta.documentId)
    expect(promoted.status).toBe('indexed')
    expect(docStatus(meta.documentId)).toBe('indexed')
    expect(rowCount('knowledge_chunks')).toBeGreaterThan(0)

    const results = await service.search({ query: 'settlement agreement', hybrid: false, limit: 10 })
    expect(results.results.length).toBeGreaterThan(0)
    expect(results.results.every(r => r.documentId === meta.documentId)).toBe(true)
  })

  it('promoteDocument refuses unknown ids and non-metadata_only rows', async () => {
    const filePath = join(tempDir, 'plain.md')
    writeFileSync(filePath, 'regular manual vault content for indexing')

    const vault = service.addVault(tempDir, 'manual-vault')
    const result = await service.ingest(filePath, vault.id)
    expect(result.status).toBe('indexed')

    expect(() => service.promoteDocument(999_999)).toThrow('document_not_found')
    expect(() => service.promoteDocument(result.documentId)).toThrow('not_metadata_only')
  })

  it('promoteDocument rejects unsupported extensions instead of silently re-recording', async () => {
    // OCR finding 2: an unsupported extension hit the ingest step-0
    // whitelist on promote, which re-recorded the doc as metadata_only
    // behind a 202 — the user's index click was a silent no-op.
    const filePath = join(tempDir, 'photo.jpg')
    writeFileSync(filePath, 'fake image bytes')

    const vault = service.addVault(tempDir, 'auto-vault', 'auto')
    const meta = await service.ingest(filePath, vault.id)
    expect(meta.status).toBe('metadata_only')

    expect(() => service.promoteDocument(meta.documentId)).toThrow('unsupported_extension')
    expect(docStatus(meta.documentId)).toBe('metadata_only')
  })

  it('re-recording a promoted file as metadata_only drops its stale index rows', async () => {
    // OCR finding 4: promote → indexed → file changed again →
    // metadataOnlyIngest left the old chunks/FTS5/vec0 rows as orphans.
    const filePath = join(tempDir, 'churn.md')
    writeFileSync(filePath, 'version one of the indexed content')

    const vault = service.addVault(tempDir, 'auto-vault', 'auto')
    const meta = await service.ingest(filePath, vault.id)
    const promoted = await service.promoteDocument(meta.documentId)
    expect(promoted.status).toBe('indexed')
    expect(rowCount('knowledge_chunks')).toBeGreaterThan(0)

    // File changes again; the auto vault records metadata only.
    writeFileSync(filePath, 'version two with different content entirely')
    const again = await service.ingest(filePath, vault.id)
    expect(again.status).toBe('metadata_only')

    expect(rowCount('knowledge_chunks')).toBe(0)
    expect(rowCount('knowledge_chunks_fts')).toBe(0)
    expect(rowCount('knowledge_chunks_vec')).toBe(0)
  })

  it('demoting a cited document drops its citation log entries too', async () => {
    // OCR round-2 finding: deleteDocumentIndexes cleaned chunks/FTS5/vec0
    // but left knowledge_references rows with dangling chunk_ids.
    const filePath = join(tempDir, 'cited-churn.md')
    writeFileSync(filePath, 'cited document that will be demoted')

    const vault = service.addVault(tempDir, 'auto-vault', 'auto')
    const meta = await service.ingest(filePath, vault.id)
    const promoted = await service.promoteDocument(meta.documentId)
    expect(promoted.status).toBe('indexed')

    // Simulate a search citation recorded against this document.
    const chunkId = (db.prepare(
      'SELECT id FROM knowledge_chunks WHERE document_id = ? LIMIT 1'
    ).all(meta.documentId) as Array<{ id: number }>)[0].id
    db.prepare(
      'INSERT INTO knowledge_references (document_id, chunk_id, source, session_id, distance, rank, created_at) VALUES (?, ?, ?, NULL, 0.1, 0, ?)'
    ).run(meta.documentId, chunkId, 'chat', Date.now())
    expect(rowCount('knowledge_references')).toBe(1)

    // File changes again → demoted to metadata_only → citation rows go too.
    writeFileSync(filePath, 'changed content after citation was recorded')
    await service.ingest(filePath, vault.id)

    expect(rowCount('knowledge_chunks')).toBe(0)
    expect(rowCount('knowledge_references')).toBe(0)
  })

  it('manual vaults keep full-ingest behavior (v0.8.7 regression)', async () => {
    const filePath = join(tempDir, 'manual.md')
    writeFileSync(filePath, 'manual vault documents index immediately')

    const vault = service.addVault(tempDir, 'manual-vault')
    const result = await service.ingest(filePath, vault.id)

    expect(result.status).toBe('indexed')
    expect(result.chunks).toBeGreaterThan(0)
    expect(docStatus(result.documentId)).toBe('indexed')
    expect(rowCount('knowledge_chunks_vec')).toBeGreaterThan(0)
  })
})
