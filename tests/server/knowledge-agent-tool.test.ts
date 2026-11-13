/**
 * Knowledge Agent tool tests — MCP tool definition and handler.
 *
 * Verifies:
 *   - Tool definition shape (name, description, parameters).
 *   - Handler validates input and delegates to the service.
 *   - Error cases: empty query, query > 2000 chars.
 *   - Response shape matches §5.2.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  handleKnowledgeSearch,
  KNOWLEDGE_SEARCH_TOOL,
  getKnowledgeToolDefinition,
  KnowledgeToolError,
} from '../../packages/server/src/modules/studio/services/knowledge/knowledge-tool'
import type { KnowledgeService } from '../../packages/server/src/modules/studio/services/knowledge/knowledge.service'

// --- Tool definition tests ------------------------------------------------

describe('KNOWLEDGE_SEARCH_TOOL definition', () => {
  it('has the expected name', () => {
    expect(KNOWLEDGE_SEARCH_TOOL.name).toBe('knowledge_search')
  })

  it('description mentions Chinese queries and semantic search', () => {
    expect(KNOWLEDGE_SEARCH_TOOL.description).toContain('Chinese')
    expect(KNOWLEDGE_SEARCH_TOOL.description).toContain('semantic')
  })

  it('description explains totalCandidatesBeforeFilter', () => {
    expect(KNOWLEDGE_SEARCH_TOOL.description).toContain('totalCandidatesBeforeFilter')
  })

  it('description includes limit recommendations', () => {
    expect(KNOWLEDGE_SEARCH_TOOL.description).toContain('3')
    expect(KNOWLEDGE_SEARCH_TOOL.description).toContain('10')
    expect(KNOWLEDGE_SEARCH_TOOL.description).toContain('20')
  })

  it('parameters require query', () => {
    expect(KNOWLEDGE_SEARCH_TOOL.parameters.required).toContain('query')
  })

  it('parameters include all expected fields', () => {
    const props = Object.keys(KNOWLEDGE_SEARCH_TOOL.parameters.properties)
    expect(props).toContain('query')
    expect(props).toContain('vaultId')
    expect(props).toContain('limit')
    expect(props).toContain('hybrid')
    expect(props).toContain('maxDistance')
  })
})

describe('getKnowledgeToolDefinition', () => {
  it('returns OpenAI-style function tool wrapper', () => {
    const def = getKnowledgeToolDefinition()
    expect(def.type).toBe('function')
    expect(def.function.name).toBe('knowledge_search')
    expect(def.function.description).toContain('Search the local knowledge base')
    expect(def.function.parameters).toBeDefined()
  })
})

// --- Handler tests --------------------------------------------------------

function createMockService(response?: unknown): KnowledgeService {
  return {
    search: vi.fn().mockResolvedValue(response ?? {
      results: [
        { chunkId: 1, documentId: 1, content: 'test chunk', distance: 0.1, vaultId: 1 },
      ],
      totalCandidatesBeforeFilter: 5,
    }),
  } as unknown as KnowledgeService
}

describe('handleKnowledgeSearch', () => {
  it('returns search results with totalCandidatesBeforeFilter', async () => {
    const service = createMockService()
    const result = await handleKnowledgeSearch(
      { query: 'test query' },
      { service },
    )
    expect(result.results).toHaveLength(1)
    expect(result.totalCandidatesBeforeFilter).toBe(5)
  })

  it('passes all parameters through to the service', async () => {
    const service = createMockService()
    await handleKnowledgeSearch(
      { query: 'test', vaultId: 3, limit: 10, hybrid: false, maxDistance: 0.5 },
      { service },
    )
    expect(service.search).toHaveBeenCalledWith({
      query: 'test',
      vaultId: 3,
      limit: 10,
      hybrid: false,
      maxDistance: 0.5,
      reference: { source: 'agent-tool', sessionId: null },
    })
  })

  it('defaults hybrid to true and limit to 5', async () => {
    const service = createMockService()
    await handleKnowledgeSearch({ query: 'test' }, { service })
    expect(service.search).toHaveBeenCalledWith({
      query: 'test',
      vaultId: null,
      limit: 5,
      hybrid: true,
      maxDistance: undefined,
      reference: { source: 'agent-tool', sessionId: null },
    })
  })

  it('throws KnowledgeToolError on empty query', async () => {
    const service = createMockService()
    await expect(
      handleKnowledgeSearch({ query: '   ' }, { service }),
    ).rejects.toThrow(KnowledgeToolError)
    try {
      await handleKnowledgeSearch({ query: '' }, { service })
    } catch (err) {
      expect((err as KnowledgeToolError).code).toBe('empty_query')
    }
  })

  it('throws KnowledgeToolError on query > 2000 chars', async () => {
    const service = createMockService()
    try {
      await handleKnowledgeSearch({ query: 'a'.repeat(2001) }, { service })
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(KnowledgeToolError)
      expect((err as KnowledgeToolError).code).toBe('query_too_long')
    }
  })

  it('trims whitespace from query', async () => {
    const service = createMockService()
    await handleKnowledgeSearch({ query: '  hello world  ' }, { service })
    expect(service.search).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'hello world' }),
    )
  })
})
