/**
 * CJK search tests — bigram tokenization and hybrid fallback.
 *
 * Covers:
 *   - tokenizeForFts produces bigrams for CJK runs.
 *   - tokenizeForFts passes non-CJK text through as whitespace tokens.
 *   - buildFtsQuery escapes FTS5 special chars.
 *   - End-to-end: CJK text written to FTS is findable via bigram query.
 *   - searchHybrid falls back to vector-only when FTS returns 0 candidates.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  tokenizeForFts,
  buildFtsQuery,
  containsCjk,
} from '../../packages/server/src/modules/studio/services/knowledge/fts-tokenizer'
import { KnowledgeService } from '../../packages/server/src/modules/studio/services/knowledge/knowledge.service'
import type { KnowledgeConfig } from '../../packages/server/src/modules/studio/services/knowledge/config'
import type { Embedder } from '../../packages/server/src/modules/studio/services/knowledge/embedder'

// --- SQLite setup (same pattern as knowledge-service.test.ts) -------------

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

// --- Unit tests (no DB needed) -------------------------------------------

describe('tokenizeForFts', () => {
  it('produces bigrams for CJK text', () => {
    const tokens = tokenizeForFts('深圳今天的天气')
    // 深圳 / 圳今 / 今天 / 天今 / 天气 = 5 bigrams from 7 CJK chars.
    expect(tokens).toContain('深圳')
    expect(tokens).toContain('今天')
    expect(tokens).toContain('天气')
    expect(tokens.length).toBe(6) // 5 bigrams + "的" single-char boundary token
  })

  it('produces whitespace tokens for non-CJK text', () => {
    const tokens = tokenizeForFts('hello world foo')
    expect(tokens).toEqual(['hello', 'world', 'foo'])
  })

  it('handles mixed CJK and non-CJK text', () => {
    const tokens = tokenizeForFts('hello 世界 test')
    // "hello" → non-CJK word; "世界" → 1 bigram; "test" → non-CJK word.
    expect(tokens).toContain('hello')
    expect(tokens).toContain('世界')
    expect(tokens).toContain('test')
  })

  it('single CJK char is emitted as-is', () => {
    const tokens = tokenizeForFts('中')
    expect(tokens).toEqual(['中'])
  })

  it('empty string returns empty array', () => {
    expect(tokenizeForFts('')).toEqual([])
  })
})

describe('containsCjk', () => {
  it('detects Chinese characters', () => {
    expect(containsCjk('深圳')).toBe(true)
    expect(containsCjk('hello')).toBe(false)
    expect(containsCjk('hello 世界')).toBe(true)
  })

  it('detects Japanese hiragana', () => {
    expect(containsCjk('こんにちは')).toBe(true)
  })
})

describe('buildFtsQuery', () => {
  it('wraps CJK bigrams in quoted OR expression', () => {
    const query = buildFtsQuery('深圳天气')
    // bigrams: 深圳 / 圳天 / 天气
    expect(query).toBe('"深圳" OR "圳天" OR "天气"')
  })

  it('wraps non-CJK words in quoted OR expression', () => {
    const query = buildFtsQuery('hello world')
    expect(query).toBe('"hello" OR "world"')
  })

  it('escapes FTS5 special characters', () => {
    const query = buildFtsQuery('test* (query)')
    // * and () are stripped.
    expect(query).not.toContain('*')
    expect(query).not.toContain('(')
    expect(query).not.toContain(')')
  })

  it('returns empty quoted string for empty input', () => {
    expect(buildFtsQuery('')).toBe('""')
    expect(buildFtsQuery('   ')).toBe('""')
  })

  it('escapes + and - characters that break FTS5 MATCH', () => {
    const query = buildFtsQuery('c++ -rust')
    expect(query).not.toContain('+')
    expect(query).not.toMatch(/[^\\]-/)
  })
})

// --- Integration tests (need SQLite + sqlite-vec) ------------------------

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

/**
 * Mock embedder that returns vectors designed so Chinese content
 * and English queries produce distinguishable distances.
 * Chunk i gets a one-hot vector at position i % dim.
 */
function createMockEmbedder(queryVec?: Float32Array): Embedder {
  return {
    async embed(chunks: string[]): Promise<Float32Array[]> {
      if (chunks.length === 1 && queryVec) return [queryVec]
      return chunks.map((_, i) => {
        const v = new Float32Array(4)
        v[i % 4] = 1.0
        return v
      })
    },
  }
}

describe.skipIf(!canRun)('CJK search integration', () => {
  let db: InstanceType<DatabaseSyncCtor>
  let tempDir: string
  let service: KnowledgeService

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'knowledge-cjk-'))
    db = new DatabaseSync(':memory:', { allowExtension: true })
    const vecPath = tryLoadSqliteVec()!
    db.enableLoadExtension(true)
    db.loadExtension(vecPath)
    db.enableLoadExtension(false)

    service = new KnowledgeService(db as any, TEST_CONFIG, {
      embedder: createMockEmbedder(),
      extractorFn: (path: string) => {
        const { readFileSync } = require('fs')
        const text = readFileSync(path, 'utf-8')
        return { text, tokenCount: text.length }
      },
    })
    service.init()
  })

  afterEach(() => {
    try { db.close() } catch { /* ignore */ }
    try { rmSync(tempDir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('FTS finds CJK content after bigram indexing', async () => {
    const filePath = join(tempDir, 'shenzhen.md')
    writeFileSync(filePath, '深圳是一个美丽的城市，位于中国南方')

    const vault = service.addVault(tempDir, 'test-vault')
    await service.ingest(filePath, vault.id)

    // Verify FTS content has bigrams.
    const ftsRows = db.prepare(
      'SELECT content FROM knowledge_chunks_fts'
    ).all() as Array<{ content: string }>
    expect(ftsRows.length).toBeGreaterThan(0)
    // The FTS content should contain bigrams like "深圳".
    const ftsContent = ftsRows.map(r => r.content).join(' ')
    expect(ftsContent).toContain('深圳')

    // Hybrid search with CJK query should find results via FTS bigrams.
    const results = await service.search({
      query: '深圳',
      vaultId: vault.id,
      hybrid: true,
      limit: 5,
    })
    // FTS should match the bigram "深圳" → at least 1 candidate.
    expect(results.totalCandidatesBeforeFilter).toBeGreaterThanOrEqual(1)
  })

  it('searchHybrid falls back to vector when FTS has no candidates', async () => {
    const filePath = join(tempDir, 'english.md')
    writeFileSync(filePath, 'transformer attention mechanism deep learning')

    const vault = service.addVault(tempDir, 'test-vault')
    await service.ingest(filePath, vault.id)

    // Query with a term that does NOT exist in the FTS index.
    // FTS returns 0 candidates → should fall back to vector search.
    const results = await service.search({
      query: '非存在关键词',
      vaultId: vault.id,
      hybrid: true,
      limit: 5,
      maxDistance: 1.0, // loose threshold so vec fallback can return something
    })

    // The warning should mention the fallback.
    if (results.results.length === 0) {
      // vec0 KNN returned nothing within maxDistance — that's fine,
      // but we should at least see the fallback warning.
      expect(results.warning).toContain('fell back to vector-only')
    } else {
      expect(results.warning).toContain('fell back to vector-only')
    }
  })

  it('non-CJK search still works via whitespace tokens', async () => {
    const filePath = join(tempDir, 'english.md')
    writeFileSync(filePath, 'transformer attention mechanism neural network')

    const vault = service.addVault(tempDir, 'test-vault')
    await service.ingest(filePath, vault.id)

    const results = await service.search({
      query: 'transformer',
      vaultId: vault.id,
      hybrid: true,
      limit: 5,
    })

    // "transformer" should match via FTS whitespace token.
    expect(results.totalCandidatesBeforeFilter).toBeGreaterThanOrEqual(1)
  })
})
