/**
 * Knowledge plugin — search path.
 *
 * Two search modes:
 *
 * 1. Hybrid (FTS5 + vec0): keyword-match via FTS5 to get a candidate
 *    set, then re-rank by cosine distance via vec0. This is the
 *    default — it combines lexical precision with semantic recall.
 *
 * 2. Pure-vector (vec0 KNN): use vec0's MATCH operator with `k = ?`
 *    for approximate nearest neighbors, then post-filter in app code
 *    to enforce vault/status constraints (because vec0's `distance`
 *    column is NULL under a PK join — it cannot be filtered in SQL).
 *
 * Both paths enforce:
 *   - Only `status = 'indexed'` documents appear in results.
 *   - Query length ≤ 2000 chars (throws QueryTooLongError).
 *   - Limit is clamped to 20; overage sets a `warning` field.
 *   - Response includes `totalCandidatesBeforeFilter`.
 */

import type { DatabaseSync } from 'node:sqlite'
import { buildFtsQuery } from './fts-tokenizer'

// --- Public types ---------------------------------------------------------

export class QueryTooLongError extends Error {
  constructor(
    public readonly length: number,
    public readonly limit: number,
  ) {
    super(`Query length ${length} exceeds limit ${limit}`)
    this.name = 'QueryTooLongError'
  }
}

export interface SearchResult {
  chunkId: number
  documentId: number
  content: string
  distance: number
  vaultId: number
}

export interface SearchResponse {
  results: SearchResult[]
  totalCandidatesBeforeFilter: number
  warning?: string
}

export interface SearchParams {
  query: string
  vaultId?: number | null
  limit?: number
  hybrid?: boolean
  maxDistance?: number
}

export interface SearchConfig {
  /** Max query length in chars. Default 2000. */
  maxQueryLength: number
  /** Max results to return. Default 20. */
  maxLimit: number
  /** Default max cosine distance. Default 0.3. */
  defaultMaxDistance: number
  /** Multiplier for vec0 KNN k to absorb post-filter losses. */
  knnInflateFactor: number
}

export const DEFAULT_SEARCH_CONFIG: SearchConfig = {
  maxQueryLength: 2000,
  maxLimit: 20,
  defaultMaxDistance: 0.3,
  knnInflateFactor: 3,
}

// --- Entry point ----------------------------------------------------------

export function search(
  db: DatabaseSync,
  queryEmbedding: Float32Array,
  params: SearchParams,
  searchConfig: Partial<SearchConfig> = {},
): SearchResponse {
  const cfg = { ...DEFAULT_SEARCH_CONFIG, ...searchConfig }

  // Validate query length.
  if (params.query.length > cfg.maxQueryLength) {
    throw new QueryTooLongError(params.query.length, cfg.maxQueryLength)
  }

  const limit = Math.min(params.limit ?? 10, cfg.maxLimit)
  const maxDistance = params.maxDistance ?? cfg.defaultMaxDistance
  const hybrid = params.hybrid ?? true
  const warning = (params.limit ?? 10) > cfg.maxLimit
    ? `Limit clamped from ${params.limit} to ${cfg.maxLimit}`
    : undefined

  if (hybrid) {
    return searchHybrid(db, queryEmbedding, params, limit, maxDistance, cfg, warning)
  }
  return searchVector(db, queryEmbedding, params, limit, maxDistance, cfg, warning)
}

// --- Hybrid path (FTS5 → vec0 re-rank) -----------------------------------

function searchHybrid(
  db: DatabaseSync,
  queryEmbedding: Float32Array,
  params: SearchParams,
  limit: number,
  maxDistance: number,
  _cfg: SearchConfig,
  warning?: string,
): SearchResponse {
  // Stage 1: FTS5 keyword match → candidate chunk IDs.
  const ftsQuery = buildFtsQuery(params.query)
  const vaultFilter = params.vaultId != null

  let candidateSql: string
  let candidateParams: any[]

  if (vaultFilter) {
    candidateSql = `
      SELECT c.id AS chunk_id, c.document_id, c.content
      FROM knowledge_chunks c
      JOIN knowledge_chunks_fts f ON f.rowid = c.id
      JOIN knowledge_documents d ON d.id = c.document_id
      WHERE knowledge_chunks_fts MATCH ?
        AND d.status IN ('indexed', 'fts_only')
        AND d.vault_id = ?
    `
    candidateParams = [ftsQuery, params.vaultId]
  } else {
    candidateSql = `
      SELECT c.id AS chunk_id, c.document_id, c.content
      FROM knowledge_chunks c
      JOIN knowledge_chunks_fts f ON f.rowid = c.id
      JOIN knowledge_documents d ON d.id = c.document_id
      WHERE knowledge_chunks_fts MATCH ?
        AND d.status IN ('indexed', 'fts_only')
    `
    candidateParams = [ftsQuery]
  }

  let candidates: Array<{ chunk_id: number; document_id: number; content: string }>
  try {
    candidates = (db.prepare(candidateSql).all(...candidateParams) as Array<{ chunk_id: number; document_id: number; content: string }>)
  } catch (err) {
    // FTS5 MATCH can throw on malformed queries — return empty results.
    if ((err as Error).message?.includes('fts5: syntax error') ||
        (err as Error).message?.includes('malformed')) {
      return { results: [], totalCandidatesBeforeFilter: 0, warning }
    }
    throw err
  }

  const totalCandidatesBeforeFilter = candidates.length

  if (candidates.length === 0) {
    // FTS5 returned no keyword candidates. For CJK text or queries
    // where the porter tokenizer missed, fall back to pure-vector
    // search so the user still gets semantic results.
    try {
      const vecFallback = searchVector(
        db, queryEmbedding, params, limit, maxDistance, _cfg,
        (warning ? warning + '; ' : '') +
          'FTS5 returned no candidates; fell back to vector-only search',
      )
      return vecFallback
    } catch (vecErr) {
      // vec0 may be unavailable — return empty rather than crashing,
      // but log unexpected errors so they can be diagnosed.
      // eslint-disable-next-line no-console
      console.warn('[knowledge] vector-only fallback failed:',
        vecErr instanceof Error ? vecErr.message : String(vecErr))
      return { results: [], totalCandidatesBeforeFilter: 0, warning }
    }
  }

  // Stage 2: Re-rank candidates by cosine distance via vec0.
  const chunkIds = candidates.map(c => c.chunk_id)
  const placeholders = chunkIds.map(() => '?').join(',')
  const contentMap = new Map(candidates.map(c => [c.chunk_id, c]))

  const rankSql = `
    SELECT v.chunk_id, vec_distance_cosine(v.embedding, ?) AS distance
    FROM knowledge_chunks_vec v
    WHERE v.chunk_id IN (${placeholders})
    ORDER BY distance
    LIMIT ?
  `

  const rankParams: any[] = [queryEmbedding, ...chunkIds, limit]
  const ranked = db.prepare(rankSql).all(...rankParams) as Array<{ chunk_id: number; distance: number }>

  // Apply maxDistance cutoff and build final results.
  const results: SearchResult[] = []
  for (const row of ranked) {
    if (row.distance > maxDistance) break
    const candidate = contentMap.get(row.chunk_id)
    if (!candidate) continue

    // Look up vault_id from documents (already filtered to 'indexed').
    const docRows = db.prepare(
      'SELECT vault_id FROM knowledge_documents WHERE id = ?'
    ).all(candidate.document_id) as Array<{ vault_id: number }>
    if (docRows.length === 0) continue

    results.push({
      chunkId: row.chunk_id,
      documentId: candidate.document_id,
      content: candidate.content,
      distance: row.distance,
      vaultId: docRows[0].vault_id,
    })
  }

  // fts_only candidates (USB-vault rows) have no vec0 entry, so vec
  // re-ranking drops them. Append them AFTER the vector-ranked hits with
  // the worst acceptable distance so keyword matches on removable drives
  // still surface, ranked below every semantic hit (task-12 USB design).
  const rankedIds = new Set(ranked.map(r => r.chunk_id))
  for (const c of candidates) {
    if (results.length >= limit) break
    if (rankedIds.has(c.chunk_id)) continue
    const meta = db.prepare(
      'SELECT d.vault_id, d.status FROM knowledge_documents d JOIN knowledge_chunks kc ON kc.document_id = d.id WHERE kc.id = ?'
    ).get(c.chunk_id) as { vault_id: number; status: string } | undefined
    if (!meta || meta.status !== 'fts_only') continue
    results.push({
      chunkId: c.chunk_id,
      documentId: c.document_id,
      content: c.content,
      distance: maxDistance,
      vaultId: meta.vault_id,
    })
  }

  return { results, totalCandidatesBeforeFilter, warning }
}

// --- Pure-vector path (vec0 KNN → post-filter) ---------------------------

function searchVector(
  db: DatabaseSync,
  queryEmbedding: Float32Array,
  params: SearchParams,
  limit: number,
  maxDistance: number,
  cfg: SearchConfig,
  warning?: string,
): SearchResponse {
  // Inflate k to absorb post-filter losses (status/vault filtering).
  const kInflated = Math.max(limit * cfg.knnInflateFactor, 50)

  // Stage 1: vec0 KNN via MATCH.
  const knnSql = `
    SELECT chunk_id, distance
    FROM knowledge_chunks_vec
    WHERE embedding MATCH ? AND k = ?
  `
  const knnRows = db.prepare(knnSql).all(queryEmbedding, kInflated) as Array<{ chunk_id: number; distance: number }>

  const totalCandidatesBeforeFilter = knnRows.length

  if (knnRows.length === 0) {
    return { results: [], totalCandidatesBeforeFilter: 0, warning }
  }

  // Stage 2: Post-filter — look up chunk metadata and filter by status/vault.
  const chunkIds = knnRows.map(r => r.chunk_id)
  const placeholders = chunkIds.map(() => '?').join(',')

  const metaSql = `
    SELECT c.id AS chunk_id, c.document_id, c.content, d.vault_id, d.status
    FROM knowledge_chunks c
    JOIN knowledge_documents d ON d.id = c.document_id
    WHERE c.id IN (${placeholders})
  `
  const metaRows = db.prepare(metaSql).all(...chunkIds) as Array<{
    chunk_id: number; document_id: number; content: string; vault_id: number; status: string
  }>
  const metaMap = new Map(metaRows.map(r => [r.chunk_id, r]))

  const results: SearchResult[] = []
  for (const knn of knnRows) {
    if (results.length >= limit) break
    if (knn.distance > maxDistance) continue

    const meta = metaMap.get(knn.chunk_id)
    if (!meta) continue
    if (meta.status !== 'indexed') continue
    if (params.vaultId != null && meta.vault_id !== params.vaultId) continue

    results.push({
      chunkId: knn.chunk_id,
      documentId: meta.document_id,
      content: meta.content,
      distance: knn.distance,
      vaultId: meta.vault_id,
    })
  }

  return { results, totalCandidatesBeforeFilter, warning }
}

// buildFtsQuery is imported from ./fts-tokenizer (handles CJK bigrams).
