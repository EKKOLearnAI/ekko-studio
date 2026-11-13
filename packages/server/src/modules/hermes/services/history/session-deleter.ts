/**
 * Session Deleter — periodically drains pending session deletes.
 *
 * Reads from gc_pending_session_deletes table, executes deletion via
 * Hermes CLI, tracks failures (max 3 attempts), and auto-drains on
 * a timer + profile switch.
 */
import {
  completePendingSessionDelete,
  failPendingSessionDelete,
  listPendingSessionDeletes,
} from '../../../studio/public/session-gc'
import { deleteSession as hermesDeleteSession } from '../runtime/cli'
import { logger } from '../../../studio/public/logging'

const MAX_ATTEMPTS = 3
const DRAIN_INTERVAL_MS = 300_000

export class SessionDeleter {
  private static _instance: SessionDeleter | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private currentProfile: string = 'default'

  static getInstance(): SessionDeleter {
    if (!SessionDeleter._instance) {
      SessionDeleter._instance = new SessionDeleter()
    }
    return SessionDeleter._instance
  }

  /** Start periodic drain for the given profile */
  start(profile: string): void {
    this.currentProfile = profile
    this.stop()
    logger.info('[SessionDeleter] started, profile=%s, interval=%dms', profile, DRAIN_INTERVAL_MS)
    // Drain immediately on start, then on interval
    this.drain(profile).catch(() => {})
    this.timer = setInterval(() => {
      this.drain(profile).catch(() => {})
    }, DRAIN_INTERVAL_MS)
  }

  /** Switch to a new profile, stop old timer and start new one */
  switchProfile(newProfile: string): void {
    if (newProfile !== this.currentProfile) {
      logger.info('[SessionDeleter] switching profile %s -> %s', this.currentProfile, newProfile)
      this.start(newProfile)
    }
  }

  /** Stop periodic drain */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** Drain pending deletes for a specific profile (called on profile switch or manually) */
  async drain(profile: string): Promise<{ deleted: string[]; skipped: string[]; failed: string[] }> {
    const now = Date.now()
    const rows = listPendingSessionDeletes(profile, MAX_ATTEMPTS, now, 50)

    if (rows.length === 0) return { deleted: [], skipped: [], failed: [] }

    const deleted: string[] = []
    const skipped: string[] = []
    const failed: string[] = []

    for (const row of rows) {
      try {
        const ok = await hermesDeleteSession(row.session_id)
        if (ok) {
          completePendingSessionDelete(row.session_id)
          deleted.push(row.session_id)
        } else {
          skipped.push(row.session_id)
        }
      } catch (err: any) {
        const msg = err?.message || 'Unknown error'
        failPendingSessionDelete(row.session_id, msg, now, now + 60_000)
        failed.push(row.session_id)
        logger.warn('[SessionDeleter] failed to delete %s (attempt %d): %s', row.session_id, row.attempt_count + 1, msg)
      }
    }

    if (deleted.length || failed.length) {
      logger.info('[SessionDeleter] profile=%s: deleted=%d, failed=%d', profile, deleted.length, failed.length)
    }

    return { deleted, skipped, failed }
  }
}
