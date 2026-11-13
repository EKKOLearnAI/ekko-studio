import { getDb } from '../infrastructure/database'
import { initSessionStateTables } from '../infrastructure/database/session-state-schema'
import { isPrivatePersonSession } from '../contracts/person-session'
import { getSessionGeneration } from './session-store'

/** Dispositions shown in the timeline and published live; `silent` is recorded only. */
const VISIBLE_DISPOSITIONS = ['notified', 'status_only', 'unknown'] as const
export const isVisibleNoticeDisposition = (disposition: string) => (VISIBLE_DISPOSITIONS as readonly string[]).includes(disposition)

/** Producer of a passive notice. Notices are never `messages` rows and never model history. */
export type SessionNotificationKind = 'script_report'

/** Only `notified`, `status_only` and `unknown` are shown; `silent` is recorded, never shown. */
export type SessionNotificationDisposition = 'notified' | 'status_only' | 'unknown' | 'silent'

/** Durable attention key of an accepted notice in `session_attention_events`. */
export const NOTICE_ATTENTION_PREFIX = 'session-notice:'

export interface SessionNotificationRecord {
  id: number
  namespace: string
  profile: string
  producer_key: string
  session_id: string
  /** Session generation the notice was accepted for; readers only show the current one. */
  session_generation: string
  kind: SessionNotificationKind
  disposition: SessionNotificationDisposition
  payload: Record<string, unknown>
  attention_pending: number
  created_at: number
}

const initialized = new WeakSet<object>()
function database() {
  const db = getDb()
  if (!db) throw new Error('session_notification_storage_unavailable')
  if (initialized.has(db)) return db
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      namespace TEXT NOT NULL, profile TEXT NOT NULL, producer_key TEXT NOT NULL,
      session_id TEXT NOT NULL, session_generation TEXT NOT NULL, kind TEXT NOT NULL, disposition TEXT NOT NULL,
      payload TEXT NOT NULL, attention_pending INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
      UNIQUE(namespace, profile, producer_key)
    );
    CREATE INDEX IF NOT EXISTS idx_session_notifications_session ON session_notifications(session_id, created_at);
  `)
  initSessionStateTables(db)
  initialized.add(db)
  return db
}

function rowToRecord(row: Record<string, unknown>): SessionNotificationRecord {
  let payload: Record<string, unknown> = {}
  try { payload = JSON.parse(String(row.payload || '{}')) } catch { payload = {} }
  return {
    id: Number(row.id),
    namespace: String(row.namespace),
    profile: String(row.profile),
    producer_key: String(row.producer_key),
    session_id: String(row.session_id),
    session_generation: String(row.session_generation),
    kind: String(row.kind) as SessionNotificationKind,
    disposition: String(row.disposition) as SessionNotificationDisposition,
    payload,
    attention_pending: Number(row.attention_pending || 0),
    created_at: Number(row.created_at),
  }
}

export type FencedAcceptance =
  | { status: 'accepted' | 'duplicate'; record: SessionNotificationRecord }
  | { status: 'generation_mismatch' | 'conflict' | 'unsupported' }

/**
 * Accept a producer-identified notice only while the session is still the generation the producer
 * froze. The generation is checked before an existing key is recognized, so an old receipt never
 * reports delivery to a reset or recreated session. A reused key with different content is a
 * conflict and never overwrites. The notice and its attention event commit together.
 */
export function acceptFencedSessionNotification(input: {
  namespace: string
  profile: string
  producerKey: string
  sessionId: string
  expectedGeneration: string
  kind: SessionNotificationKind
  disposition: SessionNotificationDisposition
  payload: Record<string, unknown>
  now?: number
}): FencedAcceptance {
  const now = input.now ?? Date.now()
  const attention = input.disposition !== 'silent'
  // Private Person conversations are not notice destinations.
  if (isPrivatePersonSession(input.sessionId)) return { status: 'unsupported' }
  const db = database()
  db.exec('BEGIN IMMEDIATE')
  try {
    const session = db.prepare('SELECT generation_id, profile FROM sessions WHERE id=?').get(input.sessionId) as
      { generation_id?: string; profile?: string } | undefined
    if (!session || (session.profile || 'default') !== input.profile || session.generation_id !== input.expectedGeneration) {
      db.exec('COMMIT')
      return { status: 'generation_mismatch' }
    }
    const existing = db.prepare('SELECT * FROM session_notifications WHERE namespace=? AND profile=? AND producer_key=?')
      .get(input.namespace, input.profile, input.producerKey) as Record<string, unknown> | undefined
    if (existing) {
      db.exec('COMMIT')
      const record = rowToRecord(existing)
      // A key is bound to its destination too: another session, generation or kind is a conflict.
      return record.session_id === input.sessionId && record.session_generation === input.expectedGeneration
        && record.kind === input.kind && record.disposition === input.disposition
        && JSON.stringify(record.payload) === JSON.stringify(input.payload)
        ? { status: 'duplicate', record } : { status: 'conflict' }
    }
    const result = db.prepare(`INSERT INTO session_notifications
        (namespace, profile, producer_key, session_id, session_generation, kind, disposition, payload, attention_pending, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(input.namespace, input.profile, input.producerKey, input.sessionId,
      input.expectedGeneration, input.kind, input.disposition, JSON.stringify(input.payload), attention ? 1 : 0, now)
    const id = Number(result.lastInsertRowid)
    if (attention) {
      db.prepare('INSERT INTO session_attention_events(session_id, event_key) VALUES (?, ?)')
        .run(input.sessionId, `${NOTICE_ATTENTION_PREFIX}${id}`)
    }
    db.exec('COMMIT')
    return { status: 'accepted', record: getSessionNotificationById(id)! }
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function getSessionNotificationById(id: number): SessionNotificationRecord | null {
  const row = database().prepare('SELECT * FROM session_notifications WHERE id=?').get(id) as Record<string, unknown> | undefined
  return row ? rowToRecord(row) : null
}

/** Shown notices of the session's current generation, oldest first. */
export function listVisibleSessionNotifications(sessionId: string): SessionNotificationRecord[] {
  if (!getDb() || isPrivatePersonSession(sessionId)) return []
  const generation = getSessionGeneration(sessionId)
  if (!generation) return []
  const rows = database().prepare(`SELECT * FROM session_notifications
    WHERE session_id=? AND session_generation=? AND disposition IN ('notified','status_only','unknown')
    ORDER BY created_at, id`).all(sessionId, generation) as Record<string, unknown>[]
  return rows.map(rowToRecord)
}
