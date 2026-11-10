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
  /** When the notice was shown to the model on an intentional turn; null until then. */
  projected_at: number | null
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
  const columns = new Set((db.prepare('PRAGMA table_info(session_notifications)').all() as Array<{ name: string }>).map(column => column.name))
  if (!columns.has('projected_at')) db.exec('ALTER TABLE session_notifications ADD COLUMN projected_at INTEGER')
  if (!columns.has('projection_dispatch_id')) db.exec('ALTER TABLE session_notifications ADD COLUMN projection_dispatch_id TEXT')
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
    projected_at: row.projected_at == null ? null : Number(row.projected_at),
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

/** Shown notices of the current generation not yet given to the model on an intentional turn. */
export function listUnprojectedSessionNotifications(sessionId: string, limit: number): SessionNotificationRecord[] {
  if (!getDb() || isPrivatePersonSession(sessionId)) return []
  const generation = getSessionGeneration(sessionId)
  if (!generation) return []
  const rows = database().prepare(`SELECT * FROM session_notifications
    WHERE session_id=? AND session_generation=? AND disposition IN ('notified','status_only','unknown')
      AND projected_at IS NULL AND projection_dispatch_id IS NULL
    ORDER BY created_at, id LIMIT ?`).all(sessionId, generation, limit) as Record<string, unknown>[]
  return rows.map(rowToRecord)
}

/** Marks notices as given to the model once; a notice is never projected twice. */
export function markSessionNotificationsProjected(ids: number[], now = Date.now()): void {
  if (!ids.length) return
  const statement = database().prepare('UPDATE session_notifications SET projected_at=? WHERE id=? AND projected_at IS NULL')
  for (const id of ids) statement.run(now, id)
}

/** Reserves pending notices for one dispatch before it is sent; returns the ids actually reserved. */
export function reserveSessionNotificationsForDispatch(ids: number[], dispatchId: string): number[] {
  const statement = database().prepare(`UPDATE session_notifications SET projection_dispatch_id=?
    WHERE id=? AND projected_at IS NULL AND projection_dispatch_id IS NULL`)
  return ids.filter(id => statement.run(dispatchId, id).changes > 0)
}

/** The bridge admitted the dispatch: its reserved notices are consumed and never projected again. */
export function consumeDispatchNotifications(dispatchId: string, now = Date.now()): void {
  database().prepare('UPDATE session_notifications SET projected_at=? WHERE projection_dispatch_id=? AND projected_at IS NULL')
    .run(now, dispatchId)
}

/** The dispatch was definitely not admitted: its notices are pending again for a later question. */
export function releaseDispatchNotifications(dispatchId: string): void {
  database().prepare('UPDATE session_notifications SET projection_dispatch_id=NULL WHERE projection_dispatch_id=? AND projected_at IS NULL')
    .run(dispatchId)
}

/** Dispatches of this session whose admission is still unresolved (an acknowledgement was lost). */
export function unresolvedProjectionDispatches(sessionId: string): string[] {
  if (!getDb()) return []
  return (database().prepare(`SELECT DISTINCT projection_dispatch_id AS id FROM session_notifications
    WHERE session_id=? AND projection_dispatch_id IS NOT NULL AND projected_at IS NULL`).all(sessionId) as Array<{ id: string }>)
    .map(row => row.id)
}
