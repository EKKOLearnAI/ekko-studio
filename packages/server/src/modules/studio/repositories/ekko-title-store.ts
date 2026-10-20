import { getDb, isSqliteAvailable } from '../infrastructure/database'
import { MESSAGES_TABLE, SESSIONS_TABLE } from '../infrastructure/database/schemas'

export interface EkkoTitleSnapshot {
  id: string
  profile: string
  title: string | null
  title_origin: string
  history_revision: number
  first_user_id: number
  first_user_content: string
}

/** Read raw title, not the session-list preview fallback. */
export function readEkkoTitleSnapshot(id: string): EkkoTitleSnapshot | null {
  if (!isSqliteAvailable()) return null
  return getDb()!.prepare(`
    SELECT s.id, s.profile, s.title, s.title_origin, s.history_revision,
           m.id AS first_user_id, m.content AS first_user_content
    FROM ${SESSIONS_TABLE} s JOIN ${MESSAGES_TABLE} m ON m.id = (
      SELECT id FROM ${MESSAGES_TABLE} WHERE session_id = s.id AND role = 'user'
      ORDER BY timestamp, id LIMIT 1
    )
    WHERE s.id = ? AND s.agent = 'ekko-agent'
      AND s.source IN ('builtin_agent', 'global_agent')
      AND s.title_origin IN ('', 'fallback') AND s.title_generation_attempts < 2
  `).get(id) as EkkoTitleSnapshot | undefined ?? null
}

// AUTOINCREMENT message anchors distinguish deleted/recreated sessions even if
// their id, title and second-resolution started_at happen to be identical.
const currentSnapshotSql = `id = ? AND profile = ? AND agent = 'ekko-agent'
  AND source IN ('builtin_agent', 'global_agent')
  AND title IS ? AND title_origin = ? AND history_revision = ?
  AND EXISTS (SELECT 1 FROM ${MESSAGES_TABLE} WHERE session_id = ? AND id = ? AND role = 'user' AND content = ?)
  AND EXISTS (SELECT 1 FROM ${MESSAGES_TABLE} WHERE session_id = ? AND id = ? AND role = 'assistant' AND TRIM(content) <> '')`

function snapshotValues(snapshot: EkkoTitleSnapshot, replyId: string) {
  return [snapshot.id, snapshot.profile, snapshot.title, snapshot.title_origin, snapshot.history_revision,
    snapshot.id, snapshot.first_user_id, snapshot.first_user_content, snapshot.id, replyId]
}

export function isEkkoTitleSnapshotCurrent(snapshot: EkkoTitleSnapshot, replyId: string): boolean {
  if (!isSqliteAvailable()) return false
  return !!getDb()!.prepare(`SELECT 1 FROM ${SESSIONS_TABLE} WHERE ${currentSnapshotSql}`)
    .get(...snapshotValues(snapshot, replyId))
}

/** Persistent two-attempt budget, shared by all turns and reset on history clear. */
export function claimEkkoTitleAttempt(snapshot: EkkoTitleSnapshot, replyId: string): boolean {
  if (!isSqliteAvailable()) return false
  return getDb()!.prepare(`UPDATE ${SESSIONS_TABLE}
    SET title_generation_attempts = title_generation_attempts + 1
    WHERE ${currentSnapshotSql} AND title_generation_attempts < 2`)
    .run(...snapshotValues(snapshot, replyId)).changes > 0
}

export function applyEkkoGeneratedTitle(snapshot: EkkoTitleSnapshot, replyId: string, title: string): boolean {
  if (!isSqliteAvailable()) return false
  return getDb()!.prepare(`UPDATE ${SESSIONS_TABLE} SET title = ?, title_origin = 'ai'
    WHERE ${currentSnapshotSql}`)
    .run(title, ...snapshotValues(snapshot, replyId)).changes > 0
}
