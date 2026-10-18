import { getDb, isSqliteAvailable } from '../infrastructure/database'
import { COMPRESSION_SNAPSHOT_TABLE, MESSAGES_TABLE, SESSIONS_TABLE } from '../infrastructure/database/schemas'

function contextVersion(sessionId: string) {
  return getDb()!.prepare(`SELECT s.history_revision AS revision, s.model, s.provider,
    (SELECT MAX(id) FROM ${MESSAGES_TABLE} WHERE session_id = s.id) AS lastMessageId,
    c.updated_at AS snapshotUpdatedAt, c.compressed_through_message_id AS cursor,
    c.protected_head_through_message_id AS protectedHead
    FROM ${SESSIONS_TABLE} s LEFT JOIN ${COMPRESSION_SNAPSHOT_TABLE} c ON c.session_id = s.id
    WHERE s.id = ?`).get(sessionId)
}

/** An edit estimate is valid only for the history and summary it counted. */
export function getSessionContextUsageEstimate(sessionId: string): { tokens: number; fixedTokens: number } | undefined {
  if (!isSqliteAvailable()) return undefined
  const row = getDb()!.prepare(`SELECT context_usage_estimate AS estimate FROM ${SESSIONS_TABLE} WHERE id = ?`)
    .get(sessionId) as { estimate: string | null } | undefined
  if (!row?.estimate) return undefined
  try {
    const saved = JSON.parse(row.estimate)
    if (typeof saved.tokens === 'number' && Number.isFinite(saved.tokens) && saved.tokens >= 0
      && typeof saved.fixedTokens === 'number' && Number.isFinite(saved.fixedTokens) && saved.fixedTokens >= 0
      && JSON.stringify(saved.version) === JSON.stringify(contextVersion(sessionId))) {
      return { tokens: saved.tokens, fixedTokens: saved.fixedTokens }
    }
  } catch { /* An absent or obsolete estimate is recalculated from current history. */ }
  return undefined
}

export function saveSessionContextUsageEstimate(sessionId: string, tokens: number, fixedTokens: number): void {
  if (!isSqliteAvailable() || !Number.isFinite(tokens) || tokens < 0 || !Number.isFinite(fixedTokens) || fixedTokens < 0) return
  const version = contextVersion(sessionId)
  if (!version) return
  getDb()!.prepare(`UPDATE ${SESSIONS_TABLE} SET context_usage_estimate = ? WHERE id = ?`)
    .run(JSON.stringify({ tokens: Math.floor(tokens), fixedTokens: Math.floor(fixedTokens), version }), sessionId)
}
