import { getDb } from '../infrastructure/database'
import { MESSAGES_TABLE, SESSION_SHARES_TABLE, SESSION_UPLOADS_TABLE } from '../infrastructure/database/schemas'

export const sessionUploadsStore = {
  record(sessionId: string, profile: string, path: string, realPath: string): void {
    getDb()?.prepare(`INSERT INTO ${SESSION_UPLOADS_TABLE} (session_id, profile, path, real_path) VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id, profile, path) DO UPDATE SET real_path = excluded.real_path`)
      .run(sessionId, profile, path, realPath)
  },
  find(sessionId: string, profile: string, path: string): string | undefined {
    return (getDb()?.prepare(`SELECT real_path FROM ${SESSION_UPLOADS_TABLE} WHERE session_id = ? AND profile = ? AND path = ?`)
      .get(sessionId, profile, path) as { real_path: string } | undefined)?.real_path
  },
  legacyContents(sessionId: string): string[] {
    // Old messages have no sender provenance. Only history predating the first
    // share can be used; later recipient-authored paths cannot grant access.
    return (getDb()?.prepare(`SELECT content FROM ${MESSAGES_TABLE} WHERE session_id = ? AND role = 'user'
      AND timestamp < (SELECT MIN(created_at) / 1000 FROM ${SESSION_SHARES_TABLE} WHERE session_id = ?)
      AND substr(ltrim(content), 1, 1) = '['`).all(sessionId, sessionId) || [])
      .map(row => String(row.content || ''))
  },
}
