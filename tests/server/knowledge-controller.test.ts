/**
 * Knowledge controller tests — HTTP request/response mapping.
 *
 * Tests the thin controller layer with mock Koa contexts. Business
 * logic is tested in knowledge-service.test.ts; these tests verify
 * the HTTP shape: status codes, error codes, response fields.
 */

import { mkdtempSync, rmSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as ctrl from '../../packages/server/src/modules/studio/controllers/knowledge'
import { KnowledgeService } from '../../packages/server/src/modules/studio/services/knowledge/knowledge.service'

// --- Mock service ---------------------------------------------------------

function createMockService(overrides: Partial<KnowledgeService> = {}): KnowledgeService {
  return {
    listVaults: vi.fn().mockReturnValue([]),
    addVault: vi.fn().mockReturnValue({ id: 1, root_path: '/tmp/test', name: 'Test', watch: 1, created_at: Date.now() }),
    removeVault: vi.fn(),
    listDocuments: vi.fn().mockReturnValue([]),
    ingest: vi.fn().mockResolvedValue({ documentId: 1, status: 'indexed', chunks: 3 }),
    search: vi.fn().mockResolvedValue({
      results: [],
      totalCandidatesBeforeFilter: 0,
    }),
    health: vi.fn().mockReturnValue({ vaultCount: 0, documentCount: {}, vecIndexSize: 0 }),
    init: vi.fn(),
    ...overrides,
  } as unknown as KnowledgeService
}

function mockCtx(overrides: Record<string, unknown> = {}): any {
  return {
    status: 200,
    body: undefined as unknown,
    params: {},
    query: {},
    request: { body: {} },
    set: vi.fn(),
    ...overrides,
  }
}

// --- Tests ----------------------------------------------------------------

describe('knowledge controller', () => {
  let tempDir: string

  beforeEach(() => {
    // Reset the service singleton.
    ctrl.setKnowledgeService(null as unknown as KnowledgeService)
    tempDir = mkdtempSync(join(homedir(), '.knowledge-ctrl-test-'))
  })

  afterEach(() => {
    try { rmSync(tempDir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  // --- Vault endpoints ---

  describe('listVaults', () => {
    it('returns vault list', async () => {
      const service = createMockService({
        listVaults: vi.fn().mockReturnValue([
          { id: 1, root_path: '/tmp/a', name: 'A', watch: 1, created_at: 1000 },
        ]),
      })
      ctrl.setKnowledgeService(service)
      const ctx = mockCtx()

      await ctrl.listVaults(ctx)

      expect(ctx.body).toEqual({
        vaults: [{ id: 1, root_path: '/tmp/a', name: 'A', watch: 1, created_at: 1000 }],
      })
    })
  })

  describe('createVault', () => {
    it('creates a vault and returns 201', async () => {
      const service = createMockService()
      ctrl.setKnowledgeService(service)
      const ctx = mockCtx({
        request: { body: { root_path: tempDir, name: 'Test' } },
      })

      await ctrl.createVault(ctx)

      expect(ctx.status).toBe(201)
      expect((ctx.body as any).vault).toBeDefined()
      expect((ctx.body as any).vault.name).toBe('Test')
    })

    it('returns 400 when root_path is missing', async () => {
      const service = createMockService()
      ctrl.setKnowledgeService(service)
      const ctx = mockCtx({
        request: { body: { name: 'Test' } },
      })

      await ctrl.createVault(ctx)

      expect(ctx.status).toBe(400)
      expect((ctx.body as any).error).toBe('missing_fields')
    })

    it('returns 409 on duplicate root_path', async () => {
      const service = createMockService({
        addVault: vi.fn().mockImplementation(() => {
          throw new Error('UNIQUE constraint failed: knowledge_vaults.root_path')
        }),
      })
      ctrl.setKnowledgeService(service)
      const ctx = mockCtx({
        request: { body: { root_path: tempDir, name: 'Test' } },
      })

      await ctrl.createVault(ctx)

      expect(ctx.status).toBe(409)
      // task-12 unified the duplicate-root error code to vault_path_in_use
      expect((ctx.body as any).error).toBe('vault_path_in_use')
    })
  })

  describe('deleteVault', () => {
    it('calls removeVault with cascade=false by default', async () => {
      const service = createMockService()
      ctrl.setKnowledgeService(service)
      const ctx = mockCtx({ params: { id: '1' } })

      await ctrl.deleteVault(ctx)

      expect(service.removeVault).toHaveBeenCalledWith(1, false)
      expect(ctx.status).toBe(204)
    })

    it('passes cascade=true from query param', async () => {
      const service = createMockService()
      ctrl.setKnowledgeService(service)
      const ctx = mockCtx({ params: { id: '1' }, query: { cascade: 'true' } })

      await ctrl.deleteVault(ctx)

      expect(service.removeVault).toHaveBeenCalledWith(1, true)
    })

    it('returns 400 for invalid id', async () => {
      const service = createMockService()
      ctrl.setKnowledgeService(service)
      const ctx = mockCtx({ params: { id: 'abc' } })

      await ctrl.deleteVault(ctx)

      expect(ctx.status).toBe(400)
      expect((ctx.body as any).error).toBe('invalid_id')
    })
  })

  // --- Document endpoints ---

  describe('listDocuments', () => {
    it('returns all documents', async () => {
      const docs = [
        { id: 1, source_path: '/a.md', source_hash: 'abc', vault_id: 1, mime_type: 'text/markdown', size_bytes: 100, mtime: 1000, indexed_at: 2000, status: 'indexed' as const, error: null },
      ]
      const service = createMockService({ listDocuments: vi.fn().mockReturnValue(docs) })
      ctrl.setKnowledgeService(service)
      const ctx = mockCtx()

      await ctrl.listDocuments(ctx)

      expect((ctx.body as any).documents).toHaveLength(1)
    })

    it('filters by vault_id', async () => {
      const service = createMockService()
      ctrl.setKnowledgeService(service)
      const ctx = mockCtx({ query: { vault_id: '5' } })

      await ctrl.listDocuments(ctx)

      expect(service.listDocuments).toHaveBeenCalledWith(5)
    })

    it('filters by status', async () => {
      const allDocs = [
        { id: 1, status: 'indexed' },
        { id: 2, status: 'failed' },
        { id: 3, status: 'indexed' },
      ]
      const service = createMockService({ listDocuments: vi.fn().mockReturnValue(allDocs) })
      ctrl.setKnowledgeService(service)
      const ctx = mockCtx({ query: { status: 'indexed' } })

      await ctrl.listDocuments(ctx)

      expect((ctx.body as any).documents).toHaveLength(2)
    })
  })

  describe('getDocument', () => {
    it('returns a document by id', async () => {
      const docs = [
        { id: 42, source_path: '/test.md', source_hash: 'abc', vault_id: 1, mime_type: 'text/markdown', size_bytes: 100, mtime: 1000, indexed_at: 2000, status: 'indexed' as const, error: null },
      ]
      const service = createMockService({ listDocuments: vi.fn().mockReturnValue(docs) })
      ctrl.setKnowledgeService(service)
      const ctx = mockCtx({ params: { id: '42' } })

      await ctrl.getDocument(ctx)

      expect((ctx.body as any).document.id).toBe(42)
    })

    it('returns 404 for missing document', async () => {
      const service = createMockService({ listDocuments: vi.fn().mockReturnValue([]) })
      ctrl.setKnowledgeService(service)
      const ctx = mockCtx({ params: { id: '99' } })

      await ctrl.getDocument(ctx)

      expect(ctx.status).toBe(404)
      expect((ctx.body as any).error).toBe('not_found')
    })
  })

  // --- Search ---

  describe('searchKnowledge', () => {
    it('returns search results with totalCandidatesBeforeFilter', async () => {
      const service = createMockService({
        search: vi.fn().mockResolvedValue({
          results: [{ chunkId: 1, documentId: 1, content: 'hello', distance: 0.1, vaultId: 1 }],
          totalCandidatesBeforeFilter: 5,
        }),
      })
      ctrl.setKnowledgeService(service)
      const ctx = mockCtx({
        request: { body: { query: 'hello' } },
      })

      await ctrl.searchKnowledge(ctx)

      expect((ctx.body as any).results).toHaveLength(1)
      expect((ctx.body as any).totalCandidatesBeforeFilter).toBe(5)
    })

    it('returns 400 for empty query', async () => {
      const service = createMockService()
      ctrl.setKnowledgeService(service)
      const ctx = mockCtx({
        request: { body: { query: '   ' } },
      })

      await ctrl.searchKnowledge(ctx)

      expect(ctx.status).toBe(400)
      expect((ctx.body as any).error).toBe('empty_query')
    })

    it('returns 400 for query > 2000 chars', async () => {
      const service = createMockService()
      ctrl.setKnowledgeService(service)
      const ctx = mockCtx({
        request: { body: { query: 'a'.repeat(2001) } },
      })

      await ctrl.searchKnowledge(ctx)

      expect(ctx.status).toBe(400)
      expect((ctx.body as any).error).toBe('query_too_long')
    })

    it('passes search params through to the service', async () => {
      const service = createMockService()
      ctrl.setKnowledgeService(service)
      const ctx = mockCtx({
        request: {
          body: {
            query: 'test',
            vault_id: 3,
            limit: 10,
            hybrid: false,
            max_distance: 0.5,
          },
        },
      })

      await ctrl.searchKnowledge(ctx)

      expect(service.search).toHaveBeenCalledWith({
        query: 'test',
        vaultId: 3,
        limit: 10,
        hybrid: false,
        maxDistance: 0.5,
        reference: { source: 'chat', sessionId: null },
      })
    })

    it('defaults hybrid to true and limit to 5', async () => {
      const service = createMockService()
      ctrl.setKnowledgeService(service)
      const ctx = mockCtx({
        request: { body: { query: 'test' } },
      })

      await ctrl.searchKnowledge(ctx)

      expect(service.search).toHaveBeenCalledWith({
        query: 'test',
        vaultId: null,
        limit: 5,
        hybrid: true,
        maxDistance: undefined,
        reference: { source: 'chat', sessionId: null },
      })
    })

    it('passes session_id through as chat reference context', async () => {
      const service = createMockService()
      ctrl.setKnowledgeService(service)
      const ctx = mockCtx({
        request: { body: { query: 'test', session_id: '  sess-7  ' } },
      })

      await ctrl.searchKnowledge(ctx)

      expect(service.search).toHaveBeenCalledWith(
        expect.objectContaining({
          reference: { source: 'chat', sessionId: 'sess-7' },
        }),
      )
    })
  })

  // --- Promote (metadata_only → full index) ---

  describe('indexDocument', () => {
    it('returns 202 queued on success', async () => {
      const service = createMockService({
        promoteDocument: vi.fn().mockResolvedValue({ documentId: 7, status: 'indexed', chunks: 2 }),
      })
      ctrl.setKnowledgeService(service)
      const ctx = mockCtx({ params: { id: '7' } })

      await ctrl.indexDocument(ctx)

      expect(ctx.status).toBe(202)
      expect(ctx.body).toEqual({ documentId: 7, status: 'queued' })
      expect(service.promoteDocument).toHaveBeenCalledWith(7)
    })

    it('returns 404 when the document does not exist', async () => {
      const service = createMockService({
        promoteDocument: vi.fn().mockImplementation(() => {
          throw new Error('document_not_found')
        }),
      })
      ctrl.setKnowledgeService(service)
      const ctx = mockCtx({ params: { id: '99' } })

      await ctrl.indexDocument(ctx)

      expect(ctx.status).toBe(404)
      expect(ctx.body.error).toBe('not_found')
    })

    it('returns 409 when the document is not metadata_only', async () => {
      const service = createMockService({
        promoteDocument: vi.fn().mockImplementation(() => {
          throw new Error('not_metadata_only')
        }),
      })
      ctrl.setKnowledgeService(service)
      const ctx = mockCtx({ params: { id: '3' } })

      await ctrl.indexDocument(ctx)

      expect(ctx.status).toBe(409)
      expect(ctx.body.error).toBe('not_metadata_only')
    })

    it('returns 422 when the file type is unsupported for indexing', async () => {
      const service = createMockService({
        promoteDocument: vi.fn().mockImplementation(() => {
          throw new Error('unsupported_extension')
        }),
      })
      ctrl.setKnowledgeService(service)
      const ctx = mockCtx({ params: { id: '5' } })

      await ctrl.indexDocument(ctx)

      expect(ctx.status).toBe(422)
      expect(ctx.body.error).toBe('unsupported_extension')
    })

    it('returns 503 when the ingest queue is full', async () => {
      const service = createMockService({
        promoteDocument: vi.fn().mockImplementation(() => {
          throw new Error('ingest_queue_full')
        }),
      })
      ctrl.setKnowledgeService(service)
      const ctx = mockCtx({ params: { id: '9' } })

      await ctrl.indexDocument(ctx)

      expect(ctx.status).toBe(503)
      expect(ctx.body.error).toBe('ingest_queue_full')
    })

    it('returns 400 on an invalid id', async () => {
      const service = createMockService()
      ctrl.setKnowledgeService(service)
      const ctx = mockCtx({ params: { id: 'abc' } })

      await ctrl.indexDocument(ctx)

      expect(ctx.status).toBe(400)
      expect(ctx.body.error).toBe('invalid_id')
    })
  })

  // --- Vault kind validation (task-11) ---

  describe('createVault kind validation', () => {
    it('rejects an unknown kind with 400', async () => {
      const service = createMockService()
      ctrl.setKnowledgeService(service)
      const ctx = mockCtx({
        request: { body: { root_path: tempDir, name: 'X', kind: 'weird' } },
      })

      await ctrl.createVault(ctx)

      expect(ctx.status).toBe(400)
      expect(ctx.body.error).toBe('invalid_kind')
      expect(service.addVault).not.toHaveBeenCalled()
    })

    it('passes a valid kind through to the service', async () => {
      const service = createMockService()
      ctrl.setKnowledgeService(service)
      const ctx = mockCtx({
        request: { body: { root_path: tempDir, name: 'X', kind: 'auto' } },
      })

      await ctrl.createVault(ctx)

      expect(ctx.status).toBe(201)
      expect(service.addVault).toHaveBeenCalledWith(expect.any(String), 'X', 'auto')
    })
  })

  // --- Settings (embedding API key) ---

  describe('getKeySettings', () => {
    it('reports keyConfigured=false when no key is resolvable', async () => {
      const prevHome = process.env.HERMES_WEB_UI_HOME
      const prevKey = process.env.KNOWLEDGE_EMBED_API_KEY
      const prevDash = process.env.DASHSCOPE_API_KEY
      process.env.HERMES_WEB_UI_HOME = tempDir
      delete process.env.KNOWLEDGE_EMBED_API_KEY
      delete process.env.DASHSCOPE_API_KEY
      try {
        const ctx = mockCtx()
        await ctrl.getKeySettings(ctx)
        expect((ctx.body as any).keyConfigured).toBe(false)
        expect((ctx.body as any).keyHint).toBeUndefined()
        expect((ctx.body as any).initialized).toBe(false)
      } finally {
        if (prevHome !== undefined) process.env.HERMES_WEB_UI_HOME = prevHome; else delete process.env.HERMES_WEB_UI_HOME
        if (prevKey !== undefined) process.env.KNOWLEDGE_EMBED_API_KEY = prevKey; else delete process.env.KNOWLEDGE_EMBED_API_KEY
        if (prevDash !== undefined) process.env.DASHSCOPE_API_KEY = prevDash; else delete process.env.DASHSCOPE_API_KEY
      }
    })

    it('reports keyConfigured=true with a masked hint when key is set', async () => {
      const prevKey = process.env.KNOWLEDGE_EMBED_API_KEY
      process.env.HERMES_WEB_UI_HOME = tempDir
      process.env.KNOWLEDGE_EMBED_API_KEY = 'sk-test-1234567890'
      try {
        const ctx = mockCtx()
        await ctrl.getKeySettings(ctx)
        expect((ctx.body as any).keyConfigured).toBe(true)
        expect((ctx.body as any).keyHint).toBe('7890')
        expect(JSON.stringify(ctx.body)).not.toContain('sk-test-1234567890')
      } finally {
        if (prevKey !== undefined) process.env.KNOWLEDGE_EMBED_API_KEY = prevKey; else delete process.env.KNOWLEDGE_EMBED_API_KEY
      }
    })
  })

  describe('saveKeySettings', () => {
    it('rejects keys shorter than 8 chars with 400', async () => {
      const ctx = mockCtx({ request: { body: { api_key: 'short' } } })
      await ctrl.saveKeySettings(ctx)
      expect(ctx.status).toBe(400)
      expect((ctx.body as any).error).toBe('invalid_api_key')
    })

    it('rejects keys containing whitespace with 400', async () => {
      const ctx = mockCtx({ request: { body: { api_key: 'sk-test key with spaces' } } })
      await ctrl.saveKeySettings(ctx)
      expect(ctx.status).toBe(400)
    })

    it('writes the secrets file and triggers reinit', async () => {
      const prevHome = process.env.HERMES_WEB_UI_HOME
      process.env.HERMES_WEB_UI_HOME = tempDir
      let reinitCalls = 0
      ctrl.setKnowledgeReinit(() => {
        reinitCalls++
        ctrl.setKnowledgeService(createMockService())
      })
      try {
        const ctx = mockCtx({ request: { body: { api_key: 'sk-ui-saved-key-9876' } } })
        await ctrl.saveKeySettings(ctx)

        expect(ctx.status).toBe(200)
        expect((ctx.body as any).ok).toBe(true)
        expect((ctx.body as any).initialized).toBe(true)
        expect(reinitCalls).toBe(1)

        const { readFileSync } = await import('fs')
        const written = readFileSync(join(tempDir, 'secrets', 'knowledge-embed.env'), 'utf-8')
        expect(written).toBe('DASHSCOPE_API_KEY=sk-ui-saved-key-9876\n')
      } finally {
        if (prevHome !== undefined) process.env.HERMES_WEB_UI_HOME = prevHome; else delete process.env.HERMES_WEB_UI_HOME
        ctrl.setKnowledgeReinit(null)
        ctrl.setKnowledgeService(null as unknown as KnowledgeService)
      }
    })

    it('reports initialized=false when reinit callback is not registered', async () => {
      const prevHome = process.env.HERMES_WEB_UI_HOME
      process.env.HERMES_WEB_UI_HOME = tempDir
      try {
        const ctx = mockCtx({ request: { body: { api_key: 'sk-no-reinit-key-1' } } })
        await ctrl.saveKeySettings(ctx)
        expect((ctx.body as any).ok).toBe(true)
        expect((ctx.body as any).initialized).toBe(false)
      } finally {
        if (prevHome !== undefined) process.env.HERMES_WEB_UI_HOME = prevHome; else delete process.env.HERMES_WEB_UI_HOME
      }
    })
  })

  // --- Health ---

  describe('health', () => {
    it('returns health data', async () => {
      const service = createMockService({
        health: vi.fn().mockReturnValue({
          vaultCount: 2,
          documentCount: { indexed: 10, failed: 1 },
          vecIndexSize: 50,
        }),
      })
      ctrl.setKnowledgeService(service)
      const ctx = mockCtx()

      await ctrl.health(ctx)

      expect(ctx.body).toEqual({
        vaultCount: 2,
        documentCount: { indexed: 10, failed: 1 },
        vecIndexSize: 50,
      })
    })
  })
})
