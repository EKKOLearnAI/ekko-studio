import { randomUUID } from 'node:crypto'
import { getDb } from '../infrastructure/database'

export interface LiveActivityDestination {
  id: string; user_id: number; device_id: string; connection_id: number; connection_token_hash: string
  app_id: string; environment: string; destination_id: string; ciphertext: string; enabled: number; updated_at: number
}
const initialized = new WeakSet<object>()
function database() {
  const db = getDb(); if (!db) throw new Error('live_activity_storage_unavailable')
  if (!initialized.has(db)) {
    db.exec(`CREATE TABLE IF NOT EXISTS user_live_activity_destinations (
      id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, device_id TEXT NOT NULL, connection_id INTEGER NOT NULL,
      connection_token_hash TEXT NOT NULL, app_id TEXT NOT NULL, environment TEXT NOT NULL,
      destination_id TEXT NOT NULL, ciphertext TEXT NOT NULL, enabled INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(device_id, app_id, environment), UNIQUE(destination_id)
    ); CREATE INDEX IF NOT EXISTS user_live_activity_owner ON user_live_activity_destinations(user_id);`)
    initialized.add(db)
  }
  return db
}
export function replaceLiveActivityDestination(input: Omit<LiveActivityDestination, 'id' | 'updated_at'>): string[] {
  const db = database(), now = Date.now()
  db.exec('BEGIN IMMEDIATE')
  try {
    const retired = db.prepare(`SELECT destination_id FROM user_live_activity_destinations
      WHERE device_id=? AND app_id=? AND environment<>? AND enabled=1`).all(input.device_id, input.app_id, input.environment) as { destination_id: string }[]
    db.prepare(`UPDATE user_live_activity_destinations SET enabled=0,updated_at=?
      WHERE device_id=? AND app_id=? AND environment<>? AND enabled=1`).run(now, input.device_id, input.app_id, input.environment)
    db.prepare(`INSERT INTO user_live_activity_destinations
      (id,user_id,device_id,connection_id,connection_token_hash,app_id,environment,destination_id,ciphertext,enabled,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(device_id,app_id,environment) DO UPDATE SET
      user_id=excluded.user_id,connection_id=excluded.connection_id,connection_token_hash=excluded.connection_token_hash,
      destination_id=excluded.destination_id,ciphertext=excluded.ciphertext,enabled=excluded.enabled,updated_at=excluded.updated_at`)
      .run(randomUUID(), input.user_id, input.device_id, input.connection_id, input.connection_token_hash,
        input.app_id, input.environment, input.destination_id, input.ciphertext, input.enabled, now)
    if (retired.length) {
      const placeholders = retired.map(() => '?').join(',')
      db.prepare(`UPDATE live_activity_runs SET terminal=1,updated_at=?
        WHERE destination_id IN (${placeholders}) AND terminal=0`).run(now, ...retired.map(row => row.destination_id))
    }
    db.exec('COMMIT')
    return retired.map(row => row.destination_id)
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
export function listLiveActivityDestinations(): LiveActivityDestination[] {
  if (!getDb()) return []
  return database().prepare('SELECT * FROM user_live_activity_destinations').all() as unknown as LiveActivityDestination[]
}
export function removeConnectionLiveActivities(connectionId: number): void {
  database().prepare('DELETE FROM user_live_activity_destinations WHERE connection_id=?').run(connectionId)
}
