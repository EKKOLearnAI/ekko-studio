/**
 * Large document pipeline store — CRUD for the 6 gc_document_* tables.
 * Spec: docs/planning/group-chat-large-doc-pipeline-spec.md §3.
 *
 * All functions are plain SQLite CRUD over getDb(); no in-process state, so
 * restart-resume works naturally from the persisted job rows.
 */
import { getDb } from '../infrastructure/database'
import {
  GC_DOCUMENTS_TABLE,
  GC_FILE_CHUNKS_TABLE,
  GC_DOCUMENT_FIELDS_TABLE,
  GC_DOCUMENT_FACTS_TABLE,
  GC_READING_JOBS_TABLE,
  GC_VOLUME_SUMMARIES_TABLE,
} from '../infrastructure/database/schemas'

// ─── Documents ────────────────────────────────────────────────────────────

export type GcDocumentStatus = 'uploaded' | 'chunked' | 'reading' | 'aggregating' | 'done' | 'failed'

export interface GcDocumentRow {
  file_id: string
  room_id: string
  name: string
  size_bytes: number
  doc_type: string
  encoding: string
  chunk_count: number
  chunk_token_budget: number
  status: GcDocumentStatus
  report_message_id: string
  created_at: number
  updated_at: number
}

export function saveDocument(row: GcDocumentRow): void {
  const db = getDb()
  if (!db) return
  db.prepare(
    `INSERT INTO ${GC_DOCUMENTS_TABLE}
      (file_id, room_id, name, size_bytes, doc_type, encoding, chunk_count, chunk_token_budget, status, report_message_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(file_id) DO UPDATE SET
       name = excluded.name,
       size_bytes = excluded.size_bytes,
       doc_type = excluded.doc_type,
       encoding = excluded.encoding,
       chunk_count = excluded.chunk_count,
       chunk_token_budget = excluded.chunk_token_budget,
       status = excluded.status,
       report_message_id = excluded.report_message_id,
       updated_at = excluded.updated_at`,
  ).run(
    row.file_id, row.room_id, row.name, row.size_bytes, row.doc_type, row.encoding,
    row.chunk_count, row.chunk_token_budget, row.status, row.report_message_id,
    row.created_at, row.updated_at,
  )
}

export function updateDocumentStatus(fileId: string, status: GcDocumentStatus, extra: Partial<Pick<GcDocumentRow, 'report_message_id'>> = {}): void {
  const db = getDb()
  if (!db) return
  const reportMessageId = extra.report_message_id ?? ''
  db.prepare(
    `UPDATE ${GC_DOCUMENTS_TABLE} SET status = ?, report_message_id = CASE WHEN ? <> '' THEN ? ELSE report_message_id END, updated_at = ? WHERE file_id = ?`,
  ).run(status, reportMessageId, reportMessageId, Date.now(), fileId)
}

export function getDocument(fileId: string): GcDocumentRow | null {
  const db = getDb()
  if (!db) return null
  const row = db.prepare(`SELECT * FROM ${GC_DOCUMENTS_TABLE} WHERE file_id = ?`).get(fileId) as GcDocumentRow | undefined
  return row ?? null
}

export function listDocumentsByRoom(roomId: string): GcDocumentRow[] {
  const db = getDb()
  if (!db) return []
  return (db.prepare(`SELECT * FROM ${GC_DOCUMENTS_TABLE} WHERE room_id = ? ORDER BY created_at DESC`).all(roomId) || []) as unknown as GcDocumentRow[]
}

export function deleteDocument(fileId: string): void {
  const db = getDb()
  if (!db) return
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare(`DELETE FROM ${GC_DOCUMENTS_TABLE} WHERE file_id = ?`).run(fileId)
    db.prepare(`DELETE FROM ${GC_FILE_CHUNKS_TABLE} WHERE file_id = ?`).run(fileId)
    db.prepare(`DELETE FROM ${GC_DOCUMENT_FIELDS_TABLE} WHERE file_id = ?`).run(fileId)
    db.prepare(`DELETE FROM ${GC_DOCUMENT_FACTS_TABLE} WHERE file_id = ?`).run(fileId)
    db.prepare(`DELETE FROM ${GC_READING_JOBS_TABLE} WHERE file_id = ?`).run(fileId)
    db.prepare(`DELETE FROM ${GC_VOLUME_SUMMARIES_TABLE} WHERE file_id = ?`).run(fileId)
    db.exec('COMMIT')
  } catch (err) {
    try { db.exec('ROLLBACK') } catch { /* ignore */ }
    throw err
  }
}

// ─── File chunks ──────────────────────────────────────────────────────────

export interface GcFileChunkRow {
  chunk_id: string
  file_id: string
  idx: number
  start_offset: number
  end_offset: number
  token_estimate: number
  status: 'pending' | 'read' | 'fact_extracted'
  read_by_agent: string | null
}

export function insertChunks(fileId: string, chunks: Array<{ chunk_id: string; idx: number; start_offset: number; end_offset: number; token_estimate: number }>): void {
  const db = getDb()
  if (!db || chunks.length === 0) return
  const stmt = db.prepare(
    `INSERT INTO ${GC_FILE_CHUNKS_TABLE} (chunk_id, file_id, idx, start_offset, end_offset, token_estimate, status) VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
  )
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const chunk of chunks) {
      stmt.run(chunk.chunk_id, fileId, chunk.idx, chunk.start_offset, chunk.end_offset, chunk.token_estimate)
    }
    db.exec('COMMIT')
  } catch (err) {
    try { db.exec('ROLLBACK') } catch { /* ignore */ }
    throw err
  }
}

export function getChunks(fileId: string): GcFileChunkRow[] {
  const db = getDb()
  if (!db) return []
  return (db.prepare(`SELECT * FROM ${GC_FILE_CHUNKS_TABLE} WHERE file_id = ? ORDER BY idx ASC`).all(fileId) || []) as unknown as GcFileChunkRow[]
}

export function updateChunkRead(chunkId: string, agentId: string | null): void {
  const db = getDb()
  if (!db) return
  db.prepare(`UPDATE ${GC_FILE_CHUNKS_TABLE} SET status = 'read', read_by_agent = ? WHERE chunk_id = ?`).run(agentId, chunkId)
}

export function getChunkCounts(fileId: string): { total: number; read: number } {
  const db = getDb()
  if (!db) return { total: 0, read: 0 }
  const row = db.prepare(
    `SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN status <> 'pending' THEN 1 ELSE 0 END), 0) AS read FROM ${GC_FILE_CHUNKS_TABLE} WHERE file_id = ?`,
  ).get(fileId) as { total: number; read: number } | undefined
  return row ?? { total: 0, read: 0 }
}

// ─── Rule-extracted fields ────────────────────────────────────────────────

export interface GcDocumentFieldRow {
  field_id: string
  file_id: string
  chunk_id: string
  field_type: string
  value: string
  quote: string
  quote_offset: number
  verified_by_agent: string | null
  verified_at: number | null
}

export function insertFields(fileId: string, fields: Array<{ field_id: string; chunk_id: string; field_type: string; value: string; quote: string; quote_offset: number }>): void {
  const db = getDb()
  if (!db || fields.length === 0) return
  const stmt = db.prepare(
    `INSERT INTO ${GC_DOCUMENT_FIELDS_TABLE} (field_id, file_id, chunk_id, field_type, value, quote, quote_offset) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const field of fields) {
      stmt.run(field.field_id, fileId, field.chunk_id, field.field_type, field.value, field.quote, field.quote_offset)
    }
    db.exec('COMMIT')
  } catch (err) {
    try { db.exec('ROLLBACK') } catch { /* ignore */ }
    throw err
  }
}

export function getFields(fileId: string): GcDocumentFieldRow[] {
  const db = getDb()
  if (!db) return []
  return (db.prepare(`SELECT * FROM ${GC_DOCUMENT_FIELDS_TABLE} WHERE file_id = ? ORDER BY quote_offset ASC`).all(fileId) || []) as unknown as GcDocumentFieldRow[]
}

export function countFields(fileId: string): number {
  const db = getDb()
  if (!db) return 0
  const row = db.prepare(`SELECT COUNT(*) AS total FROM ${GC_DOCUMENT_FIELDS_TABLE} WHERE file_id = ?`).get(fileId) as { total: number } | undefined
  return row?.total ?? 0
}

// ─── AI-extracted facts ───────────────────────────────────────────────────

export interface GcDocumentFactRow {
  fact_id: string
  file_id: string
  chunk_id: string
  agent_id: string
  fact_json: string
  created_at: number
}

export function insertFact(fileId: string, chunkId: string, agentId: string, factJson: string, index = 0): void {
  const db = getDb()
  if (!db) return
  db.prepare(
    `INSERT INTO ${GC_DOCUMENT_FACTS_TABLE} (fact_id, file_id, chunk_id, agent_id, fact_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(`gcdf_${chunkId}_${agentId}_${index}`, fileId, chunkId, agentId, factJson, Date.now())
}

export function getFactsByAgent(fileId: string, agentId: string): GcDocumentFactRow[] {
  const db = getDb()
  if (!db) return []
  return (db.prepare(
    `SELECT * FROM ${GC_DOCUMENT_FACTS_TABLE} WHERE file_id = ? AND agent_id = ? ORDER BY created_at ASC`,
  ).all(fileId, agentId) || []) as unknown as GcDocumentFactRow[]
}

export function getFacts(fileId: string): GcDocumentFactRow[] {
  const db = getDb()
  if (!db) return []
  return (db.prepare(
    `SELECT * FROM ${GC_DOCUMENT_FACTS_TABLE} WHERE file_id = ? ORDER BY created_at ASC`,
  ).all(fileId) || []) as unknown as GcDocumentFactRow[]
}

export function countFacts(fileId: string): number {
  const db = getDb()
  if (!db) return 0
  const row = db.prepare(`SELECT COUNT(*) AS total FROM ${GC_DOCUMENT_FACTS_TABLE} WHERE file_id = ?`).get(fileId) as { total: number } | undefined
  return row?.total ?? 0
}

// ─── Reading jobs ─────────────────────────────────────────────────────────

export type GcJobStatus = 'pending' | 'running' | 'done' | 'failed'

export interface GcReadingJobRow {
  job_id: string
  file_id: string
  chunk_id: string
  agent_id: string | null
  status: GcJobStatus
  attempts: number
  started_at: number | null
  finished_at: number | null
  error: string | null
}

export function insertJobs(fileId: string, jobs: Array<{ job_id: string; chunk_id: string; agent_id: string | null }>): void {
  const db = getDb()
  if (!db || jobs.length === 0) return
  const stmt = db.prepare(
    `INSERT INTO ${GC_READING_JOBS_TABLE} (job_id, file_id, chunk_id, agent_id, status) VALUES (?, ?, ?, ?, 'pending')`,
  )
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const job of jobs) {
      stmt.run(job.job_id, fileId, job.chunk_id, job.agent_id)
    }
    db.exec('COMMIT')
  } catch (err) {
    try { db.exec('ROLLBACK') } catch { /* ignore */ }
    throw err
  }
}

export function getPendingJobs(fileId: string, limit: number): GcReadingJobRow[] {
  const db = getDb()
  if (!db) return []
  return (db.prepare(
    `SELECT * FROM ${GC_READING_JOBS_TABLE} WHERE file_id = ? AND status = 'pending' ORDER BY job_id ASC LIMIT ?`,
  ).all(fileId, limit) || []) as unknown as GcReadingJobRow[]
}

export function claimJobs(fileId: string, agentId: string, limit: number): GcReadingJobRow[] {
  const db = getDb()
  if (!db) return []
  const rows = getPendingJobs(fileId, limit)
  if (rows.length === 0) return rows
  const stmt = db.prepare(
    `UPDATE ${GC_READING_JOBS_TABLE} SET agent_id = ?, status = 'running', started_at = ? WHERE job_id = ? AND status = 'pending'`,
  )
  const claimed: GcReadingJobRow[] = []
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const row of rows) {
      const result = stmt.run(agentId, Date.now(), row.job_id)
      if (result.changes > 0) claimed.push({ ...row, agent_id: agentId, status: 'running', started_at: Date.now() })
    }
    db.exec('COMMIT')
  } catch (err) {
    try { db.exec('ROLLBACK') } catch { /* ignore */ }
    throw err
  }
  return claimed
}

export function completeJob(jobId: string): void {
  const db = getDb()
  if (!db) return
  db.prepare(`UPDATE ${GC_READING_JOBS_TABLE} SET status = 'done', finished_at = ? WHERE job_id = ?`).run(Date.now(), jobId)
}

export function failJob(jobId: string, error: string): void {
  const db = getDb()
  if (!db) return
  db.prepare(
    `UPDATE ${GC_READING_JOBS_TABLE} SET status = 'failed', finished_at = ?, error = ?, attempts = attempts + 1 WHERE job_id = ?`,
  ).run(Date.now(), error.slice(0, 1000), jobId)
}

export function requeueFailedJobs(fileId: string, maxAttempts: number): number {
  const db = getDb()
  if (!db) return 0
  const result = db.prepare(
    `UPDATE ${GC_READING_JOBS_TABLE} SET status = 'pending', error = NULL WHERE file_id = ? AND status = 'failed' AND attempts < ?`,
  ).run(fileId, maxAttempts)
  return Number(result.changes)
}

export function getJobCounts(fileId: string): { pending: number; running: number; done: number; failed: number; total: number } {
  const db = getDb()
  if (!db) return { pending: 0, running: 0, done: 0, failed: 0, total: 0 }
  const row = db.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS pending,
       COALESCE(SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END), 0) AS running,
       COALESCE(SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END), 0) AS done,
       COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
       COUNT(*) AS total
     FROM ${GC_READING_JOBS_TABLE} WHERE file_id = ?`,
  ).get(fileId) as { pending: number; running: number; done: number; failed: number; total: number } | undefined
  return row ?? { pending: 0, running: 0, done: 0, failed: 0, total: 0 }
}

export function getJobRows(fileId: string): GcReadingJobRow[] {
  const db = getDb()
  if (!db) return []
  return (db.prepare(
    `SELECT * FROM ${GC_READING_JOBS_TABLE} WHERE file_id = ? ORDER BY job_id ASC`,
  ).all(fileId) || []) as unknown as GcReadingJobRow[]
}

// ─── Rolling volume summaries ─────────────────────────────────────────────

export interface GcVolumeSummaryRow {
  file_id: string
  agent_id: string
  volume: number
  summary: string
  through_chunk_idx: number
  updated_at: number
}

export function saveVolumeSummary(fileId: string, agentId: string, volume: number, summary: string, throughChunkIdx: number): void {
  const db = getDb()
  if (!db) return
  db.prepare(
    `INSERT INTO ${GC_VOLUME_SUMMARIES_TABLE} (file_id, agent_id, volume, summary, through_chunk_idx, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(file_id, agent_id, volume) DO UPDATE SET
       summary = excluded.summary,
       through_chunk_idx = excluded.through_chunk_idx,
       updated_at = excluded.updated_at`,
  ).run(fileId, agentId, volume, summary, throughChunkIdx, Date.now())
}

export function getLatestVolumeSummary(fileId: string, agentId: string): GcVolumeSummaryRow | null {
  const db = getDb()
  if (!db) return null
  const row = db.prepare(
    `SELECT * FROM ${GC_VOLUME_SUMMARIES_TABLE} WHERE file_id = ? AND agent_id = ? ORDER BY volume DESC LIMIT 1`,
  ).get(fileId, agentId) as GcVolumeSummaryRow | undefined
  return row ?? null
}

export function getVolumeSummaries(fileId: string, agentId: string): GcVolumeSummaryRow[] {
  const db = getDb()
  if (!db) return []
  return (db.prepare(
    `SELECT * FROM ${GC_VOLUME_SUMMARIES_TABLE} WHERE file_id = ? AND agent_id = ? ORDER BY volume ASC`,
  ).all(fileId, agentId) || []) as unknown as GcVolumeSummaryRow[]
}
