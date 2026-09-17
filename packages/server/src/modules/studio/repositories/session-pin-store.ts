import { getDb } from '../infrastructure/database'
import { SESSION_PINS_TABLE } from '../infrastructure/database/schemas'

function database() {
  const db = getDb()
  if (!db) throw new Error('Session pin storage unavailable')
  return db
}

export function listSessionPins(userId: number, profile: string): string[] {
  return (database().prepare(
    `SELECT session_id FROM ${SESSION_PINS_TABLE}
     WHERE user_id = ? AND profile = ? AND pinned = 1 ORDER BY updated_at, session_id`,
  ).all(userId, profile) as { session_id: string }[]).map(row => row.session_id)
}

export function writeSessionPin(userId: number, profile: string, sessionId: string, pinned: boolean) {
  // Retain unpins so a stale browser's legacy migration cannot resurrect them.
  database().prepare(
    `INSERT INTO ${SESSION_PINS_TABLE} (user_id, profile, session_id, pinned, updated_at)
     VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id, profile, session_id)
     DO UPDATE SET pinned = excluded.pinned, updated_at = excluded.updated_at`,
  ).run(userId, profile, sessionId, Number(pinned), Date.now())
  return listSessionPins(userId, profile)
}

export function importSessionPins(userId: number, profile: string, sessionIds: string[]) {
  const db = database()
  const insert = db.prepare(
    `INSERT OR IGNORE INTO ${SESSION_PINS_TABLE} (user_id, profile, session_id, pinned, updated_at)
     VALUES (?, ?, ?, 1, ?)`,
  )
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const id of sessionIds) insert.run(userId, profile, id, Date.now())
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  return listSessionPins(userId, profile)
}
