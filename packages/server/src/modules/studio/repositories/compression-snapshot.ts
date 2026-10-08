/** SQLite-backed compression snapshots for 1:1 chat sessions. */

import { isSqliteAvailable, getDb } from '../infrastructure/database'
import {
  COMPRESSION_SNAPSHOT_TABLE as TABLE,
  MESSAGES_TABLE,
  SESSIONS_TABLE,
} from '../infrastructure/database/schemas'

export interface CompressionSnapshot {
  summary: string
  lastMessageIndex: number
  messageCountAtTime: number
  compressedThroughMessageId: number | null
  protectedHeadThroughMessageId: number | null
  historyRevision: number
  updatedAt: number
}

export interface CompressionSnapshotCursorWrite {
  compressedThroughMessageId: number
  protectedHeadThroughMessageId?: number | null
  expectedHistoryRevision: number
}

export function getCompressionSnapshot(sessionId: string): CompressionSnapshot | null {
  if (!isSqliteAvailable()) return null
  return getDb()!.prepare(
    `SELECT
       summary,
       last_message_index AS lastMessageIndex,
       message_count_at_time AS messageCountAtTime,
       compressed_through_message_id AS compressedThroughMessageId,
       protected_head_through_message_id AS protectedHeadThroughMessageId,
       history_revision AS historyRevision,
       updated_at AS updatedAt
     FROM ${TABLE}
     WHERE session_id = ?`,
  ).get(sessionId) as CompressionSnapshot | undefined ?? null
}

export function saveCompressionSnapshot(
  sessionId: string,
  summary: string,
  lastMessageIndex: number,
  messageCountAtTime: number,
  cursor?: CompressionSnapshotCursorWrite,
): boolean {
  if (!isSqliteAvailable()) return true
  const db = getDb()!
  const session = db.prepare(
    `SELECT history_revision AS historyRevision FROM ${SESSIONS_TABLE} WHERE id = ?`,
  ).get(sessionId) as { historyRevision: number } | undefined
  if (!session) return false
  const historyRevision = Number(session.historyRevision || 0)
  if (cursor && historyRevision !== cursor.expectedHistoryRevision) return false

  if (cursor) {
    const compressedBoundary = db.prepare(
      `SELECT id FROM ${MESSAGES_TABLE}
       WHERE session_id = ? AND id = ? AND role IN ('user', 'assistant', 'tool')`,
    ).get(sessionId, cursor.compressedThroughMessageId)
    if (!compressedBoundary) return false
    if (
      cursor.protectedHeadThroughMessageId != null &&
      cursor.protectedHeadThroughMessageId > cursor.compressedThroughMessageId
    ) return false
    if (cursor.protectedHeadThroughMessageId != null) {
      const protectedBoundary = db.prepare(
        `SELECT id FROM ${MESSAGES_TABLE}
         WHERE session_id = ? AND id = ? AND role IN ('user', 'assistant', 'tool')`,
      ).get(sessionId, cursor.protectedHeadThroughMessageId)
      if (!protectedBoundary) return false
    }
  }

  let resolvedLastIndex = lastMessageIndex
  let resolvedMessageCount = messageCountAtTime
  if (cursor) {
    const through = db.prepare(
      `SELECT COUNT(*) AS count FROM ${MESSAGES_TABLE}
       WHERE session_id = ?
         AND role IN ('user', 'assistant', 'tool')
         AND id <= ?`,
    ).get(sessionId, cursor.compressedThroughMessageId) as { count: number }
    const total = db.prepare(
      `SELECT COUNT(*) AS count FROM ${MESSAGES_TABLE}
       WHERE session_id = ? AND role IN ('user', 'assistant', 'tool')`,
    ).get(sessionId) as { count: number }
    resolvedLastIndex = Math.max(-1, Number(through?.count || 0) - 1)
    resolvedMessageCount = Number(total?.count || 0)
  }

  const result = db.prepare(
    `INSERT INTO ${TABLE} (
       session_id, summary, last_message_index, message_count_at_time,
       compressed_through_message_id, protected_head_through_message_id,
       history_revision, updated_at
     )
     SELECT ?, ?, ?, ?, ?, ?, s.history_revision, ?
     FROM ${SESSIONS_TABLE} s
     WHERE s.id = ? AND s.history_revision = ?
     ON CONFLICT(session_id) DO UPDATE SET
       summary = excluded.summary,
       last_message_index = excluded.last_message_index,
       message_count_at_time = excluded.message_count_at_time,
       compressed_through_message_id = excluded.compressed_through_message_id,
       protected_head_through_message_id = excluded.protected_head_through_message_id,
       history_revision = excluded.history_revision,
       updated_at = excluded.updated_at`,
  ).run(
    sessionId,
    summary,
    resolvedLastIndex,
    resolvedMessageCount,
    cursor?.compressedThroughMessageId ?? null,
    cursor?.protectedHeadThroughMessageId ?? null,
    Date.now(),
    sessionId,
    cursor?.expectedHistoryRevision ?? historyRevision,
  )
  return result.changes > 0
}

export function copyCompressionSnapshot(sourceSessionId: string, targetSessionId: string): boolean {
  if (!isSqliteAvailable()) return false
  const db = getDb()!
  const snapshot = getCompressionSnapshot(sourceSessionId)
  if (!snapshot) return false
  const sourceSession = db.prepare(
    `SELECT history_revision AS historyRevision FROM ${SESSIONS_TABLE} WHERE id = ?`,
  ).get(sourceSessionId) as { historyRevision: number } | undefined
  if (
    !sourceSession ||
    (snapshot.compressedThroughMessageId != null &&
      Number(sourceSession.historyRevision || 0) !== snapshot.historyRevision)
  ) return false
  const targetSession = db.prepare(
    `SELECT history_revision AS historyRevision FROM ${SESSIONS_TABLE} WHERE id = ?`,
  ).get(targetSessionId) as { historyRevision: number } | undefined
  if (!targetSession) return false

  const mappedCursor = mapCopiedMessageId(
    sourceSessionId,
    targetSessionId,
    snapshot.compressedThroughMessageId,
  )
  const mappedProtectedHead = mapCopiedMessageId(
    sourceSessionId,
    targetSessionId,
    snapshot.protectedHeadThroughMessageId,
  )
  const canCopyCursor = snapshot.compressedThroughMessageId == null || mappedCursor != null
  if (!canCopyCursor) return false
  if (snapshot.protectedHeadThroughMessageId != null && mappedProtectedHead == null) return false

  db.prepare(
    `INSERT INTO ${TABLE} (
       session_id, summary, last_message_index, message_count_at_time,
       compressed_through_message_id, protected_head_through_message_id,
       history_revision, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       summary = excluded.summary,
       last_message_index = excluded.last_message_index,
       message_count_at_time = excluded.message_count_at_time,
       compressed_through_message_id = excluded.compressed_through_message_id,
       protected_head_through_message_id = excluded.protected_head_through_message_id,
       history_revision = excluded.history_revision,
       updated_at = excluded.updated_at`,
  ).run(
    targetSessionId,
    snapshot.summary,
    snapshot.lastMessageIndex,
    snapshot.messageCountAtTime,
    mappedCursor,
    mappedProtectedHead,
    Number(targetSession.historyRevision || 0),
    Date.now(),
  )
  return true
}

function mapCopiedMessageId(
  sourceSessionId: string,
  targetSessionId: string,
  sourceMessageId: number | null,
): number | null {
  if (sourceMessageId == null) return null
  const db = getDb()!
  const position = db.prepare(
    `SELECT COUNT(*) AS count FROM ${MESSAGES_TABLE}
     WHERE session_id = ? AND id <= ?`,
  ).get(sourceSessionId, sourceMessageId) as { count: number } | undefined
  const offset = Number(position?.count || 0) - 1
  if (offset < 0) return null
  const target = db.prepare(
    `SELECT id FROM ${MESSAGES_TABLE}
     WHERE session_id = ? ORDER BY id LIMIT 1 OFFSET ?`,
  ).get(targetSessionId, offset) as { id: number } | undefined
  return target ? Number(target.id) : null
}

export function deleteCompressionSnapshot(sessionId: string): void {
  if (!isSqliteAvailable()) return
  getDb()!.prepare(`DELETE FROM ${TABLE} WHERE session_id = ?`).run(sessionId)
}
