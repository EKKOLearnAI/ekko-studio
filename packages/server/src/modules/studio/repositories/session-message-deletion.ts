import { getDb, isSqliteAvailable } from '../infrastructure/database'
import { getCompressionSnapshot } from './compression-snapshot'
import {
  COMPRESSION_SNAPSHOT_TABLE, MESSAGES_TABLE, SESSIONS_TABLE, TASK_PLANS_TABLE,
  WORKSPACE_RUN_CHANGES_TABLE, WORKSPACE_RUN_CHANGE_FILES_TABLE,
} from '../infrastructure/database/schemas'

export interface MessageSelectionGroup {
  id: number
  kind: 'message' | 'run'
  messageIds: number[]
  runMarker?: string
  deleteBlockedReason?: 'compressed' | 'compression_boundary_unknown'
}

/** Read only identities, including rows outside the current display page. */
export function getMessageSelectionGroups(sessionId: string): MessageSelectionGroup[] {
  if (!isSqliteAvailable()) throw new Error('Message storage is unavailable')
  const rows = getDb()!.prepare(`SELECT id, role, run_marker FROM ${MESSAGES_TABLE}
    WHERE session_id = ? ORDER BY id`).all(sessionId) as Array<{ id: number; role: string; run_marker: string | null }>
  const groups: MessageSelectionGroup[] = []
  const runs = new Map<string, MessageSelectionGroup>()
  let current: MessageSelectionGroup | undefined
  for (const row of rows) {
    if (!['assistant', 'tool', 'moa'].includes(row.role)) {
      groups.push({ id: row.id, kind: 'message', messageIds: [row.id] })
      current = undefined
      continue
    }
    const marker = row.run_marker?.trim()
    if (marker && current?.runMarker !== marker) {
      const known = runs.get(marker)
      if (known) current = known
      else if (current && !current.runMarker) {
        current.runMarker = marker
        runs.set(marker, current)
      } else current = undefined
    }
    if (!current) {
      current = { id: row.id, kind: 'run', messageIds: [], ...(marker ? { runMarker: marker } : {}) }
      groups.push(current)
      if (marker) runs.set(marker, current)
    }
    current.messageIds.push(row.id)
  }
  const snapshot = getCompressionSnapshot(sessionId)
  if (snapshot) {
    const session = getDb()!.prepare(`SELECT history_revision FROM ${SESSIONS_TABLE} WHERE id = ?`)
      .get(sessionId) as { history_revision: number } | undefined
    const cursor = snapshot.compressedThroughMessageId
    const head = snapshot.protectedHeadThroughMessageId
    const hasContextRow = (id: number) => rows.some(row => row.id === id && ['user', 'assistant', 'tool'].includes(row.role))
    // Legacy ordinals refer to filtered runtime history, not raw database rows.
    // Without a valid cursor, do not guess which records a summary depends on.
    const reliable = cursor != null && session?.history_revision === snapshot.historyRevision
      && hasContextRow(cursor) && (head == null || (head <= cursor && hasContextRow(head)))
    for (const group of groups) {
      if (!reliable) group.deleteBlockedReason = 'compression_boundary_unknown'
      else if (group.messageIds.some(id => id <= cursor!)) group.deleteBlockedReason = 'compressed'
    }
  }
  return groups
}

export function deleteSessionMessageGroups(sessionId: string, messageIds: number[], expectedRevision: number) {
  if (!isSqliteAvailable()) throw new Error('Message storage is unavailable')
  if (!messageIds.length) throw Object.assign(new Error('Select at least one message.'), { status: 400 })
  const db = getDb()!
  db.exec('BEGIN')
  try {
    const session = db.prepare(`SELECT history_revision FROM ${SESSIONS_TABLE} WHERE id = ?`).get(sessionId) as { history_revision: number } | undefined
    if (!session || session.history_revision !== expectedRevision) {
      throw Object.assign(new Error('Message history changed. Reload the selection.'), { status: 409 })
    }
    const groups = getMessageSelectionGroups(sessionId)
    const requested = new Set(messageIds)
    const selected = groups.filter(group => group.messageIds.some(id => requested.has(id)))
    const deletedIds = selected.flatMap(group => group.messageIds)
    const deletedIdSet = new Set(deletedIds)
    if (messageIds.some(id => !deletedIdSet.has(id))) {
      throw Object.assign(new Error('Selected messages no longer exist in this session.'), { status: 409 })
    }
    // Read again inside the transaction: compression may have advanced since
    // the browser entered selection mode, without changing history_revision.
    if (selected.some(group => group.deleteBlockedReason)) {
      throw Object.assign(new Error('Compressed messages cannot be deleted. Reload the selection.'), { status: 409 })
    }
    // Preserve inferred legacy run boundaries before a user message is removed.
    // Otherwise adjacent old runs without markers would merge on the next read.
    const mark = db.prepare(`UPDATE ${MESSAGES_TABLE} SET run_marker = ? WHERE session_id = ?
      AND id IN (SELECT value FROM json_each(?)) AND (run_marker IS NULL OR TRIM(run_marker) = '')`)
    for (const group of groups) {
      if (group.kind !== 'run' || group.deleteBlockedReason || deletedIdSet.has(group.id)) continue
      mark.run(group.runMarker || `legacy_run_${group.id}`, sessionId, JSON.stringify(group.messageIds))
    }
    const remove = db.prepare(`DELETE FROM ${MESSAGES_TABLE} WHERE session_id = ? AND id = ?`)
    const removeChanges = db.prepare(`DELETE FROM ${WORKSPACE_RUN_CHANGES_TABLE} WHERE session_id = ? AND assistant_message_id = ?`)
    const removeFiles = db.prepare(`DELETE FROM ${WORKSPACE_RUN_CHANGE_FILES_TABLE} WHERE session_id = ? AND change_id IN
      (SELECT change_id FROM ${WORKSPACE_RUN_CHANGES_TABLE} WHERE session_id = ? AND assistant_message_id = ?)`)
    for (const id of deletedIds) {
      removeFiles.run(sessionId, sessionId, String(id))
      removeChanges.run(sessionId, String(id))
      remove.run(sessionId, id)
    }
    const removePlans = db.prepare(`DELETE FROM ${TASK_PLANS_TABLE} WHERE session_id = ? AND run_id = ?`)
    for (const group of selected) {
      if (group.runMarker) removePlans.run(sessionId, group.runMarker)
    }
    db.prepare(`DELETE FROM ${TASK_PLANS_TABLE} WHERE session_id = ?
      AND NOT EXISTS (SELECT 1 FROM ${MESSAGES_TABLE} WHERE session_id = ?)`).run(sessionId, sessionId)
    // Only post-cursor records can change. Keep the summary, cursor, ordinals
    // and compression timestamp intact; carry its validity to the new revision.
    // The revision still rejects in-flight summaries built from the old tail.
    db.prepare(`UPDATE ${COMPRESSION_SNAPSHOT_TABLE} SET history_revision = ? WHERE session_id = ?`)
      .run(expectedRevision + 1, sessionId)
    db.prepare(`UPDATE ${SESSIONS_TABLE} SET
      history_revision = history_revision + 1, history_cleared_at = ?,
      message_count = (SELECT COUNT(*) FROM ${MESSAGES_TABLE} WHERE session_id = ?),
      tool_call_count = (SELECT COALESCE(SUM(CASE WHEN json_valid(tool_calls) THEN json_array_length(tool_calls) ELSE 0 END), 0) FROM ${MESSAGES_TABLE} WHERE session_id = ?),
      preview = COALESCE((SELECT SUBSTR(REPLACE(REPLACE(content, CHAR(10), ' '), CHAR(13), ' '), 1, 100) FROM ${MESSAGES_TABLE} WHERE session_id = ? AND role = 'user' ORDER BY id LIMIT 1), ''),
      last_active = COALESCE((SELECT MAX(timestamp) FROM ${MESSAGES_TABLE} WHERE session_id = ?), started_at)
      WHERE id = ?`).run(Date.now(), sessionId, sessionId, sessionId, sessionId, sessionId)
    db.exec('COMMIT')
    return { deleted: deletedIds.length, deletedGroups: selected.length, messageIds: deletedIds, historyRevision: expectedRevision + 1 }
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
