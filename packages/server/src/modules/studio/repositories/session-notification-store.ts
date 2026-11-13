import { getDb } from '../infrastructure/database'

export type SessionNotificationKind = 'process_completion'

/** Disposition of one producer event; see docs/session-notifications.md. */
export type SessionNotificationDisposition =
  | 'admitting' | 'admitted' | 'dispatched' | 'consumed' | 'cancelled'
  | 'owner_missing' | 'owner_reset' | 'owner_stopped' | 'bridge_unavailable' | 'unknown'

export interface SessionNotificationRecord {
  id: number
  namespace: string
  profile: string
  producer_key: string
  session_id: string
  /** Owner session generation the producer belongs to; null when it was never declared. */
  session_generation: string | null
  kind: SessionNotificationKind
  disposition: SessionNotificationDisposition
  payload: Record<string, unknown>
  created_at: number
  updated_at: number
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
      session_id TEXT NOT NULL, session_generation TEXT, kind TEXT NOT NULL, disposition TEXT NOT NULL,
      payload TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(namespace, profile, producer_key)
    );
    CREATE INDEX IF NOT EXISTS idx_session_notifications_session
      ON session_notifications(session_id, created_at);
  `)
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
    session_generation: row.session_generation == null ? null : String(row.session_generation),
    kind: String(row.kind) as SessionNotificationKind,
    disposition: String(row.disposition) as SessionNotificationDisposition,
    payload,
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  }
}

/** Accept one producer event exactly once; a replay of the same key returns `null`. */
export function acceptSessionNotification(input: {
  namespace: string
  profile: string
  producerKey: string
  sessionId: string
  sessionGeneration: string | null
  kind: SessionNotificationKind
  disposition: SessionNotificationDisposition
  payload: Record<string, unknown>
  now?: number
}): SessionNotificationRecord | null {
  const now = input.now ?? Date.now()
  const result = database().prepare(`
    INSERT INTO session_notifications
      (namespace, profile, producer_key, session_id, session_generation, kind, disposition, payload, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(namespace, profile, producer_key) DO NOTHING
  `).run(input.namespace, input.profile, input.producerKey, input.sessionId, input.sessionGeneration, input.kind,
    input.disposition, JSON.stringify(input.payload), now, now)
  return result.changes ? getSessionNotificationById(Number(result.lastInsertRowid)) : null
}

export function getSessionNotificationById(id: number): SessionNotificationRecord | null {
  const row = database().prepare('SELECT * FROM session_notifications WHERE id=?').get(id) as Record<string, unknown> | undefined
  return row ? rowToRecord(row) : null
}

export function getSessionNotification(namespace: string, profile: string, producerKey: string): SessionNotificationRecord | null {
  const row = database().prepare('SELECT * FROM session_notifications WHERE namespace=? AND profile=? AND producer_key=?')
    .get(namespace, profile, producerKey) as Record<string, unknown> | undefined
  return row ? rowToRecord(row) : null
}

/** Move a row forward from an expected disposition; returns false when another writer won. */
export function transitionSessionNotification(id: number, from: SessionNotificationDisposition, to: SessionNotificationDisposition): boolean {
  const result = database().prepare('UPDATE session_notifications SET disposition=?, updated_at=? WHERE id=? AND disposition=?')
    .run(to, Date.now(), id, from)
  return result.changes > 0
}

/** A crash between admission and dispatch leaves admission unknown; it is never re-dispatched. */
export function settleInterruptedProcessAdmissions(namespace: string): number {
  if (!getDb()) return 0
  const result = database().prepare(`UPDATE session_notifications SET disposition='unknown', updated_at=?
    WHERE namespace=? AND kind='process_completion' AND disposition IN ('admitting','admitted')`).run(Date.now(), namespace)
  return Number(result.changes)
}
