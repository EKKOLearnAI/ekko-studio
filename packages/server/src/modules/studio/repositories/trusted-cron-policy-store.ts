import { randomUUID } from 'crypto'
import { getDb } from '../infrastructure/database'

/**
 * Trusted current-session Cron automation, per Studio instance, account and profile. A missing row
 * is OFF. Every change of `enabled` rotates the opaque epoch, so authority captured under an earlier
 * epoch (admissions, policy-created bindings) never becomes valid again.
 */
export interface TrustedCronPolicy {
  enabled: boolean
  epoch: string | null
  revision: number
  updated_at: number | null
}

const initialized = new WeakSet<object>()
function database() {
  const db = getDb()
  if (!db) throw new Error('trusted_cron_policy_storage_unavailable')
  if (initialized.has(db)) return db
  db.exec(`CREATE TABLE IF NOT EXISTS trusted_cron_policies (
    namespace TEXT NOT NULL, account_id INTEGER NOT NULL, profile TEXT NOT NULL, enabled INTEGER NOT NULL,
    epoch TEXT NOT NULL, revision INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY(namespace, account_id, profile)
  )`)
  initialized.add(db)
  return db
}

export function readTrustedCronPolicy(namespace: string, accountId: number, profile: string): TrustedCronPolicy {
  const row = database().prepare('SELECT enabled, epoch, revision, updated_at FROM trusted_cron_policies WHERE namespace=? AND account_id=? AND profile=?')
    .get(namespace, accountId, profile) as { enabled: number; epoch: string; revision: number; updated_at: number } | undefined
  if (!row) return { enabled: false, epoch: null, revision: 0, updated_at: null }
  return { enabled: Number(row.enabled) === 1, epoch: String(row.epoch), revision: Number(row.revision), updated_at: Number(row.updated_at) }
}

/**
 * Compare-and-set on the revision. An unchanged `enabled` is a no-op; any change commits a new epoch
 * synchronously. Returns null on a stale revision, otherwise the stored policy and the epoch it replaced.
 */
export function writeTrustedCronPolicy(namespace: string, accountId: number, profile: string, enabled: boolean,
  expectedRevision: number): { policy: TrustedCronPolicy; previousEpoch: string | null } | null {
  const db = database()
  db.exec('BEGIN IMMEDIATE')
  try {
    const current = readTrustedCronPolicy(namespace, accountId, profile)
    if (current.revision !== expectedRevision) {
      db.exec('ROLLBACK')
      return null
    }
    if (current.enabled === enabled && current.revision > 0) {
      db.exec('COMMIT')
      return { policy: current, previousEpoch: null }
    }
    db.prepare(`INSERT OR REPLACE INTO trusted_cron_policies (namespace, account_id, profile, enabled, epoch, revision, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(namespace, accountId, profile, enabled ? 1 : 0, randomUUID(), current.revision + 1, Date.now())
    db.exec('COMMIT')
    return { policy: readTrustedCronPolicy(namespace, accountId, profile), previousEpoch: current.epoch }
  } catch (error) {
    try { db.exec('ROLLBACK') } catch { /* not in a transaction */ }
    throw error
  }
}
