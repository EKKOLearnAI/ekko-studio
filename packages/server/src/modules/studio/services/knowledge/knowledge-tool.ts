/**
 * Knowledge plugin — Hermes Agent MCP tool definition.
 *
 * Defines `knowledge_search` as an MCP tool for the agent-bridge.
 * The bridge discovers this tool via MCP and exposes it to the
 * Hermes Agent. The tool calls KnowledgeService.search() directly
 * (no HTTP round-trip).
 *
 * Hard rules (audit P2-1):
 *   - Does NOT modify Hermes Agent core.
 *   - Does NOT mix knowledge results into Agent memory.
 *   - Tool description steers Chinese queries to semantic search.
 *   - Tool description explains totalCandidatesBeforeFilter.
 */

import type { KnowledgeService } from './knowledge.service'
import type { SearchResponse } from './search'

// --- Tool definition ------------------------------------------------------

export const KNOWLEDGE_SEARCH_TOOL = {
  name: 'knowledge_search',
  description: [
    'Search the local knowledge base for relevant document chunks.',
    'Use when the user asks about a document they dropped on USB,',
    'a fact in the corpus, or needs context from indexed files.',
    '',
    'Parameters:',
    '- query: search string (max 2000 chars; required)',
    '- vaultId: optional vault scope (integer)',
    '- limit: default 5. Recommend 3 for factual lookups, 10 for',
    '  research-style queries. Never exceed 20.',
    '- hybrid: default true (FTS5 keyword + semantic re-rank).',
    '  For Chinese queries prefer hybrid=false (pure semantic) because',
    '  v1 FTS5 keyword match is unreliable on Chinese text.',
    '- maxDistance: default 0.3. Cosine distance (lower = stricter).',
    '  Similarity = 1 - distance. Raise to 0.5 for looser recall.',
    '',
    'Response interpretation:',
    '- results[]: chunks (≤ 500 tokens each) with document_id, content,',
    '  distance, and vault_id.',
    '- totalCandidatesBeforeFilter: chunks that passed stage-1 (FTS5',
    '  or vec0 MATCH) before maxDistance trim. If results.length is much',
    '  smaller than totalCandidatesBeforeFilter, the threshold is',
    '  filtering aggressively — retry with higher maxDistance.',
    '- warning: present when limit was clamped to 20.',
  ].join('\n'),
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query (max 2000 characters).',
      },
      vaultId: {
        type: 'integer',
        description: 'Optional vault scope. Omit to search all vaults.',
      },
      limit: {
        type: 'integer',
        description: 'Max results to return (default 5, max 20).',
        default: 5,
      },
      hybrid: {
        type: 'boolean',
        description: 'Use hybrid search (default true). Set false for Chinese queries.',
        default: true,
      },
      maxDistance: {
        type: 'number',
        description: 'Max cosine distance cutoff (default 0.3, lower = stricter).',
        default: 0.3,
      },
    },
    required: ['query'],
  },
} as const

// --- Tool handler ---------------------------------------------------------

export interface KnowledgeToolDeps {
  service: KnowledgeService
}

export interface KnowledgeToolInput {
  query: string
  vaultId?: number
  limit?: number
  hybrid?: boolean
  maxDistance?: number
  /** Optional conversation/session id — recorded in the citation audit log. */
  sessionId?: string | null
}

export class KnowledgeToolError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message)
    this.name = 'KnowledgeToolError'
  }
}

/**
 * Handle a knowledge_search tool call from the Hermes Agent.
 * Returns the search response in the §5.2 shape.
 */
export async function handleKnowledgeSearch(
  input: KnowledgeToolInput,
  deps: KnowledgeToolDeps,
): Promise<SearchResponse> {
  // Validate query.
  const query = input.query?.trim() ?? ''
  if (!query) {
    throw new KnowledgeToolError('query is required and must be non-empty', 'empty_query')
  }
  if (query.length > 2000) {
    throw new KnowledgeToolError(
      `query length ${query.length} exceeds limit 2000`,
      'query_too_long',
    )
  }

  return deps.service.search({
    query,
    vaultId: input.vaultId ?? null,
    limit: input.limit ?? 5,
    hybrid: input.hybrid ?? true,
    maxDistance: input.maxDistance,
    reference: {
      source: 'agent-tool',
      // Same 256-char bound and whitespace normalization as the HTTP path.
      sessionId: typeof input.sessionId === 'string' && input.sessionId.trim()
        ? input.sessionId.trim().slice(0, 256)
        : null,
    },
  })
}

/**
 * Returns the tool definition in the format expected by the
 * agent-bridge MCP tool path.
 */
export function getKnowledgeToolDefinition() {
  return {
    type: 'function' as const,
    function: {
      name: KNOWLEDGE_SEARCH_TOOL.name,
      description: KNOWLEDGE_SEARCH_TOOL.description,
      parameters: KNOWLEDGE_SEARCH_TOOL.parameters,
    },
  }
}
