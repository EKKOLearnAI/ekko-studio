import { getDb } from '../infrastructure/database'

export interface PendingSessionDelete {
  session_id: string
  profile_name: string
  status: string
  attempt_count: number
  last_error: string | null
}

export function listPendingSessionDeletes(
  profile: string,
  maxAttempts: number,
  now: number,
  limit: number,
): PendingSessionDelete[] {
  const db = getDb()
  if (!db) return []
  return db.prepare(`
    SELECT session_id, profile_name, status, attempt_count, last_error
    FROM gc_pending_session_deletes
    WHERE profile_name = ? AND status = 'pending' AND attempt_count < ? AND next_attempt_at <= ?
    ORDER BY created_at ASC
    LIMIT ?
  `).all(profile, maxAttempts, now, limit) as unknown as PendingSessionDelete[]
}

export function completePendingSessionDelete(sessionId: string): void {
  const db = getDb()
  if (!db) return
  db.prepare('DELETE FROM gc_pending_session_deletes WHERE session_id = ?').run(sessionId)
  db.prepare('DELETE FROM gc_session_profiles WHERE session_id = ?').run(sessionId)
}

export function failPendingSessionDelete(
  sessionId: string,
  error: string,
  updatedAt: number,
  nextAttemptAt: number,
): void {
  const db = getDb()
  if (!db) return
  db.prepare(
    `UPDATE gc_pending_session_deletes
     SET status = 'pending', attempt_count = attempt_count + 1, last_error = ?, updated_at = ?, next_attempt_at = ?
     WHERE session_id = ?`,
  ).run(error, updatedAt, nextAttemptAt, sessionId)
}
