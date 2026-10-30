import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'fs'
import { getDb } from '../infrastructure/database'
import { initSessionStateTables } from '../infrastructure/database/session-state-schema'
import { getSessionGeneration } from './session-store'

export type SessionNotificationKind = 'cron' | 'process_completion'

/**
 * Terminal disposition of one producer event.
 * Cron: notified | status_only | silent | no_content | unknown | owner_missing | target_changed.
 * Process completion: admitting -> admitted (bridge admission) -> dispatched (final run seam), or
 * consumed | cancelled | owner_missing | owner_reset | owner_stopped | unknown.
 */
export type SessionNotificationDisposition =
  | 'notified' | 'status_only' | 'silent' | 'no_content' | 'unknown' | 'owner_missing' | 'target_changed'
  | 'admitting' | 'admitted' | 'dispatched' | 'consumed' | 'cancelled' | 'owner_reset' | 'owner_stopped'
  | 'bridge_unavailable'

/** Durable attention key of an accepted notice in `session_attention_events`. */
export const NOTICE_ATTENTION_PREFIX = 'cron-notice:'

export interface SessionNotificationRecord {
  id: number
  namespace: string
  profile: string
  producer_key: string
  session_id: string
  /** Owner session generation the event was accepted for; readers only show the current one. */
  session_generation: string | null
  kind: SessionNotificationKind
  disposition: SessionNotificationDisposition
  payload: Record<string, unknown>
  attention_pending: number
  projected_at: number | null
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
      session_id TEXT NOT NULL, kind TEXT NOT NULL, disposition TEXT NOT NULL,
      payload TEXT NOT NULL, attention_pending INTEGER NOT NULL DEFAULT 0,
      projected_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(namespace, profile, producer_key)
    );
    CREATE INDEX IF NOT EXISTS idx_session_notifications_session
      ON session_notifications(session_id, created_at);
    CREATE TABLE IF NOT EXISTS session_notification_cron_jobs (
      namespace TEXT NOT NULL, profile TEXT NOT NULL, job_id TEXT NOT NULL,
      state TEXT NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY(namespace, profile, job_id)
    );
  `)
  const columns = new Set((db.prepare('PRAGMA table_info(session_notifications)').all() as Array<{ name: string }>).map(column => column.name))
  if (!columns.has('session_generation')) db.exec('ALTER TABLE session_notifications ADD COLUMN session_generation TEXT')
  const jobColumns = new Set((db.prepare('PRAGMA table_info(session_notification_cron_jobs)').all() as Array<{ name: string }>).map(column => column.name))
  if (!jobColumns.has('observe_before')) db.exec('ALTER TABLE session_notification_cron_jobs ADD COLUMN observe_before TEXT')
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
    session_generation: row.session_generation == null ? null : String(row.session_generation),
    kind: String(row.kind) as SessionNotificationKind,
    disposition: String(row.disposition) as SessionNotificationDisposition,
    payload,
    attention_pending: Number(row.attention_pending || 0),
    projected_at: row.projected_at == null ? null : Number(row.projected_at),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  }
}

/**
 * Accept one producer event exactly once. Disposition, payload and attention are written in
 * the same statement; a replay of the same key returns `null` and changes nothing.
 */
export function acceptSessionNotification(input: {
  namespace: string
  profile: string
  producerKey: string
  sessionId: string
  /** Owner generation the producer belongs to; null records a disposition that is never shown. */
  sessionGeneration: string | null
  kind: SessionNotificationKind
  disposition: SessionNotificationDisposition
  payload: Record<string, unknown>
  attention: boolean
  now?: number
}): SessionNotificationRecord | null {
  const now = input.now ?? Date.now()
  const db = database()
  // The notice and its durable attention event are one acceptance: both or neither.
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = db.prepare(`
      INSERT INTO session_notifications
        (namespace, profile, producer_key, session_id, session_generation, kind, disposition, payload,
         attention_pending, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(namespace, profile, producer_key) DO NOTHING
    `).run(input.namespace, input.profile, input.producerKey, input.sessionId, input.sessionGeneration, input.kind,
      input.disposition, JSON.stringify(input.payload), input.attention ? 1 : 0, now, now)
    if (!result.changes) {
      db.exec('COMMIT')
      return null
    }
    const id = Number(result.lastInsertRowid)
    if (input.attention && input.sessionGeneration) {
      db.prepare(`INSERT OR IGNORE INTO session_attention_events(session_id, event_key)
        SELECT id, ? FROM sessions WHERE id = ?`).run(`${NOTICE_ATTENTION_PREFIX}${id}`, input.sessionId)
    }
    db.exec('COMMIT')
    return getSessionNotificationById(id)
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
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

/** Visible cron notices of the session's current generation, oldest first. */
export function listVisibleSessionNotifications(sessionId: string): SessionNotificationRecord[] {
  if (!getDb()) return []
  const generation = getSessionGeneration(sessionId)
  if (!generation) return []
  const rows = database().prepare(`SELECT * FROM session_notifications
    WHERE session_id=? AND session_generation=? AND kind='cron' AND disposition IN ('notified','status_only','unknown')
    ORDER BY created_at, id`).all(sessionId, generation) as Record<string, unknown>[]
  return rows.map(rowToRecord)
}

/** Current-generation notices not yet shown to the model on an intentional user turn. */
export function listUnprojectedSessionNotifications(sessionId: string, limit: number): SessionNotificationRecord[] {
  if (!getDb()) return []
  const generation = getSessionGeneration(sessionId)
  if (!generation) return []
  const rows = database().prepare(`SELECT * FROM session_notifications
    WHERE session_id=? AND session_generation=? AND kind='cron' AND disposition IN ('notified','status_only','unknown')
      AND projected_at IS NULL
    ORDER BY created_at, id LIMIT ?`).all(sessionId, generation, limit) as Record<string, unknown>[]
  return rows.map(rowToRecord)
}

export function markSessionNotificationsProjected(ids: number[], now = Date.now()): void {
  if (!ids.length) return
  const statement = database().prepare('UPDATE session_notifications SET projected_at=? WHERE id=? AND projected_at IS NULL')
  for (const id of ids) statement.run(now, id)
}

export function cronJobObservationState(namespace: string, profile: string, jobId: string): string | null {
  const row = database().prepare('SELECT state FROM session_notification_cron_jobs WHERE namespace=? AND profile=? AND job_id=?')
    .get(namespace, profile, jobId) as { state?: string } | undefined
  return row?.state ?? null
}

/** Cursor into older native executions still to be observed (bounded recovery across passes). */
export function cronJobObserveCursor(namespace: string, profile: string, jobId: string): string | null {
  const row = database().prepare('SELECT observe_before FROM session_notification_cron_jobs WHERE namespace=? AND profile=? AND job_id=?')
    .get(namespace, profile, jobId) as { observe_before?: string | null } | undefined
  return row?.observe_before ?? null
}

export function setCronJobObserveCursor(namespace: string, profile: string, jobId: string, before: string | null): void {
  database().prepare(`INSERT INTO session_notification_cron_jobs (namespace, profile, job_id, state, updated_at, observe_before)
    VALUES (?, ?, ?, 'observing', ?, ?) ON CONFLICT(namespace, profile, job_id) DO UPDATE SET
      observe_before=excluded.observe_before, updated_at=excluded.updated_at`)
    .run(namespace, profile, jobId, Date.now(), before)
}

export function setCronJobObservationState(namespace: string, profile: string, jobId: string, state: 'observing' | 'stopped'): void {
  database().prepare(`INSERT INTO session_notification_cron_jobs (namespace, profile, job_id, state, updated_at)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(namespace, profile, job_id) DO UPDATE SET state=excluded.state, updated_at=excluded.updated_at`)
    .run(namespace, profile, jobId, state, Date.now())
}

export interface CronSessionBinding {
  instance_id: string
  profile: string
  job_id: string
  session_id: string
  bound_at: number
  requested_deliver: string | null
  stored_deliver: string | null
  requested_paused: number
  /** Owner session generation at binding time; null for bindings that predate it (never owned). */
  session_generation: string | null
}

/** Bindings written by the Agent Bridge cronjob middleware for this Studio instance. */
export function readCronSessionBindings(path: string, instanceId: string): CronSessionBinding[] {
  if (!existsSync(path)) return []
  const db = new DatabaseSync(path, { open: true, readOnly: true })
  try {
    db.exec('PRAGMA busy_timeout=2000')
    const rows = db.prepare('SELECT * FROM cron_session_bindings WHERE instance_id=? ORDER BY bound_at')
      .all(instanceId) as unknown as CronSessionBinding[]
    return rows.map(row => ({
      ...row,
      bound_at: Number(row.bound_at),
      requested_paused: Number(row.requested_paused || 0),
      session_generation: row.session_generation ? String(row.session_generation) : null,
    }))
  } catch (err: any) {
    if (/no such table/i.test(String(err?.message || ''))) return []
    throw err
  } finally {
    db.close()
  }
}
