import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import { cronBindingsDbPath, studioInstanceId } from './session-notifications'
import { isPrivatePersonSession } from '../contracts/person-session'
import { getSession, getSessionGeneration } from '../repositories/session-store'
import { setCronJobObservationState, setCronJobObserveCursor } from '../repositories/session-notification-store'
import { findUserById, userCanAccessProfile } from '../repositories/users-store'

/**
 * Notices target ordinary, locally stored Hermes bridge chats. Other runtimes and special
 * surfaces, including private Person conversations, are refused.
 */
export function isNoticeTarget(session: { id: string; source?: string | null; agent?: string | null; agent_session_id?: string | null }): boolean {
  return !isPrivatePersonSession(session.id)
    && ['', 'cli', 'api_server'].includes(session.source || '')
    && ['', 'hermes'].includes(session.agent || '')
    && !session.agent_session_id
}

export type DestinationVerdict = 'ok' | 'forbidden' | 'not_found' | 'unsupported' | 'generation_mismatch'

/**
 * The account may receive passive notices in this session as it exists now, and the caller froze
 * its current generation. Checked before any binding write; never refetches a generation.
 */
export function authorizeNoticeDestination(userId: number, profile: string, sessionId: string, expectedGeneration: string): DestinationVerdict {
  const user = findUserById(userId)
  if (!user || user.status !== 'active' || (user.role !== 'super_admin' && !userCanAccessProfile(user.id, profile))) return 'forbidden'
  const session = getSession(sessionId)
  if (!session || (session.profile || 'default') !== profile) return 'not_found'
  if (!isNoticeTarget(session)) return 'unsupported'
  if (getSessionGeneration(sessionId) !== expectedGeneration) return 'generation_mismatch'
  return 'ok'
}

const CRON_BINDINGS_SCHEMA = `CREATE TABLE IF NOT EXISTS cron_session_bindings (
  instance_id TEXT NOT NULL,
  profile TEXT NOT NULL,
  job_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  bound_at REAL NOT NULL,
  requested_deliver TEXT,
  stored_deliver TEXT,
  requested_paused INTEGER NOT NULL DEFAULT 0,
  session_generation TEXT,
  PRIMARY KEY (instance_id, profile, job_id)
)`

export interface CronBindingRevision {
  session_id: string
  bound_at: number
}

function openBindings(): DatabaseSync {
  const path = cronBindingsDbPath()
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('PRAGMA busy_timeout=5000')
  db.exec('PRAGMA journal_mode=WAL')
  db.exec(CRON_BINDINGS_SCHEMA)
  const columns = new Set((db.prepare('PRAGMA table_info(cron_session_bindings)').all() as Array<{ name: string }>).map(column => column.name))
  if (!columns.has('session_generation')) db.exec('ALTER TABLE cron_session_bindings ADD COLUMN session_generation TEXT')
  // The approving account of a consent binding; NULL for direct login bindings (profile-shared).
  if (!columns.has('account_id')) db.exec('ALTER TABLE cron_session_bindings ADD COLUMN account_id INTEGER')
  return db
}

/** The job's current binding revision in this Studio instance, or null. */
export function readCronBindingRevision(profile: string, jobId: string): CronBindingRevision | null {
  const db = openBindings()
  try {
    const row = db.prepare('SELECT session_id, bound_at FROM cron_session_bindings WHERE instance_id=? AND profile=? AND job_id=?')
      .get(studioInstanceId(), profile, jobId) as { session_id: string; bound_at: number } | undefined
    return row ? { session_id: String(row.session_id), bound_at: Number(row.bound_at) } : null
  } finally {
    db.close()
  }
}

/**
 * Explicitly bind an existing agent-backed native cron job to a session's frozen generation.
 * Native job configuration is not changed.
 * Returns false, writing nothing, when `expectedRevision` no longer matches.
 */
export function writeCronSessionBinding(input: {
  profile: string; jobId: string; sessionId: string; generation: string; storedDeliver: string
  /** Consent bindings only: compare-and-set against the revision the user approved replacing. */
  expectedRevision?: CronBindingRevision | null
  accountId?: number | null
}): boolean {
  const db = openBindings()
  try {
    db.exec('PRAGMA busy_timeout=5000')
    db.exec('PRAGMA journal_mode=WAL')
    db.exec(CRON_BINDINGS_SCHEMA)
    const columns = new Set((db.prepare('PRAGMA table_info(cron_session_bindings)').all() as Array<{ name: string }>).map(column => column.name))
    if (!columns.has('session_generation')) db.exec('ALTER TABLE cron_session_bindings ADD COLUMN session_generation TEXT')
    db.exec('BEGIN IMMEDIATE')
    // `bound_at` is the binding revision the observer fences on, so a rebinding always moves it forward.
    const previous = db.prepare('SELECT session_id, bound_at FROM cron_session_bindings WHERE instance_id=? AND profile=? AND job_id=?')
      .get(studioInstanceId(), input.profile, input.jobId) as { session_id: string; bound_at: number } | undefined
    if (input.expectedRevision !== undefined) {
      const expected = input.expectedRevision
      const same = expected === null ? !previous
        : !!previous && String(previous.session_id) === expected.session_id && Number(previous.bound_at) === expected.bound_at
      if (!same) {
        db.exec('ROLLBACK')
        return false
      }
    }
    const boundAt = Math.max(Date.now() / 1000, previous ? Number(previous.bound_at) + 0.001 : 0)
    db.prepare(`INSERT OR REPLACE INTO cron_session_bindings (instance_id, profile, job_id, session_id, bound_at,
        requested_deliver, stored_deliver, requested_paused, session_generation, account_id) VALUES (?, ?, ?, ?, ?, NULL, ?, 0, ?, ?)`)
      .run(studioInstanceId(), input.profile, input.jobId, input.sessionId, boundAt, input.storedDeliver, input.generation, input.accountId ?? null)
    db.exec('COMMIT')
  } catch (error) {
    try { db.exec('ROLLBACK') } catch { /* not in a transaction */ }
    throw error
  } finally {
    db.close()
  }
  // A deliberate (re)binding resumes observation: a job stopped earlier (for example after an
  // out-of-band delivery change, since restored to local) is observed again from this binding on.
  setCronJobObservationState(studioInstanceId(), input.profile, input.jobId, 'observing')
  setCronJobObserveCursor(studioInstanceId(), input.profile, input.jobId, null)
  return true
}

export interface CronSessionBinding {
  instance_id: string
  profile: string
  job_id: string
  session_id: string
  /** Binding revision: every (re)binding writes a strictly later value. */
  bound_at: number
  requested_deliver: string | null
  stored_deliver: string | null
  requested_paused: number
  /** Owner session generation at binding time; null is never owned. */
  session_generation: string | null
  /** Approving account of a consent binding; null for direct login bindings. */
  account_id: number | null
}

/** Bindings written by the explicit binding API for this Studio instance. */
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
      account_id: row.account_id === null || row.account_id === undefined ? null : Number(row.account_id),
    }))
  } catch (err: any) {
    if (/no such table/i.test(String(err?.message || ''))) return []
    throw err
  } finally {
    db.close()
  }
}
