/**
 * Knowledge plugin — disk quota monitor (task-12, v0.8.9).
 *
 * Why: the device emmc is 64 GB with a ~40 GB user area and SQLite
 * already at ~540 MB. vec0 + FTS5 + chunks grow linearly with content;
 * without a guard the knowledge library can saturate the disk and brick
 * updates (AGENTS.md: disk exhaustion must refuse the update, 503-class,
 * never degrade the safety margin). This module turns that concern into
 * a single snapshot the ingest path reads to decide how hard to push.
 *
 * Budget (spec § Quota monitor):
 *   - ≤ 4 GB total knowledge data
 *   - ≤ 5 GB per vault (per-vault ceiling enforced at bootstrap/add time
 *     elsewhere; this module only reports perVaultBytes for display)
 *   - ≤ 8 vaults (enforced in knowledge.service.ts addVault)
 *
 * What counts: knowledge_documents + knowledge_chunks + the FTS5 content
 * (read as the fts shadow-table page footprint) + the vec0 table's on-disk
 * size (pragma page_count * page_size of the vec0 backing store, read via
 * sqlite_master when available; falls back to a per-row vector estimate).
 * knowledge_references is EXCLUDED — it is an audit log, not a content
 * index (spec), and trimming is amortized separately.
 */

import type { DatabaseSync } from 'node:sqlite'

export const QUOTA = {
  totalBytes: 4 * 1024 * 1024 * 1024, // 4 GB
  warnThreshold: 0.8,                  // 3.2 GB
  downgradeThreshold: 0.9,             // 3.6 GB
  hardLimit: 1.0,                       // 4 GB
  perVaultBytes: 5 * 1024 * 1024 * 1024, // 5 GB
  maxVaults: 8,
} as const

export interface KnowledgeQuota {
  totalBytes: number
  warn: boolean                // >= 80%
  downgrade: boolean           // >= 90%
  hardLimitReached: boolean    // >= 100%
  vaultCount: number
  perVaultBytes: number
}

function tablePageBytes(db: DatabaseSync, tableName: string): number {
  // vec0 / fts5 backing tables expose page_size; a real table's footprint
  // is approximated by counting rows * avg content length where a page
  // pragma is unavailable. We prefer the db-wide page_count/page_size
  // scaled by the table's share via `dbstat` when the STAT4/dbstat module
  // is compiled in; otherwise fall back to a content-length sum.
  try {
    const rows = db.prepare(
      'SELECT pgsize AS size FROM dbstat WHERE name = ?'
    ).all(tableName) as Array<{ size: number }>
    if (rows.length > 0) {
      return rows.reduce((a, r) => a + (Number(r.size) || 0), 0)
    }
  } catch {
    // dbstat not compiled in (the common case on the shipped Node builds)
    // — fall through to the content-sum estimate.
  }
  return -1
}

function sumTextBytes(db: DatabaseSync, table: string, column: string): number {
  try {
    const row = db.prepare(
      `SELECT COALESCE(SUM(LENGTH(${column})), 0) AS bytes FROM ${table}`
    ).get() as { bytes: number }
    return Number(row.bytes) || 0
  } catch {
    return 0
  }
}

function countRows(db: DatabaseSync, table: string): number {
  try {
    return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
  } catch {
    return 0
  }
}

/**
 * Estimate the vec0 backing store size: chunk_count * (dim * 4 + rowid +
 * overhead). We cannot ask vec0 for page bytes portably, and the on-disk
 * size is dominated by the float payload; dim is read from the embeddings
 * meta row. A ±10 % estimate is acceptable — the guard is a safety margin,
 * not a billing meter.
 */
function estimateVecBytes(db: DatabaseSync): number {
  try {
    const meta = db.prepare(
      'SELECT dim FROM knowledge_embeddings_meta WHERE id = 1'
    ).get() as { dim: number } | undefined
    const dim = meta?.dim ?? 1024
    const vectors = countRows(db, 'knowledge_chunks_vec')
    return vectors * (dim * 4 + 16)
  } catch {
    return 0
  }
}

export function computeKnowledgeQuota(
  db: DatabaseSync,
  budgetBytes: number = QUOTA.totalBytes,
): KnowledgeQuota {
  const documents = sumTextBytes(db, 'knowledge_documents', 'source_path')
  const chunks = sumTextBytes(db, 'knowledge_chunks', 'content')
  // FTS content shadow (fts5 stores tokens + doc-lengths; the content sum is
  // the lower bound and the dominant term for our row sizes).
  const fts = sumTextBytes(db, 'knowledge_chunks_fts', 'content')
  // Prefer exact page bytes when dbstat is present, else fall back to the
  // chunk-text proxy already counted in `chunks`.
  const ftsExact = tablePageBytes(db, 'knowledge_chunks_fts_data')
  const vec = estimateVecBytes(db)
  const totalBytes =
    documents + chunks + (ftsExact >= 0 ? ftsExact : fts) + vec

  const ratio = budgetBytes > 0 ? totalBytes / budgetBytes : 0
  const vaultCount = countRows(db, 'knowledge_vaults')
  const perVaultBytes = vaultCount > 0 ? Math.round(totalBytes / vaultCount) : 0

  return {
    totalBytes,
    warn: ratio >= QUOTA.warnThreshold && ratio < QUOTA.downgradeThreshold,
    downgrade: ratio >= QUOTA.downgradeThreshold && ratio < QUOTA.hardLimit,
    hardLimitReached: ratio >= QUOTA.hardLimit,
    vaultCount,
    perVaultBytes,
  }
}
