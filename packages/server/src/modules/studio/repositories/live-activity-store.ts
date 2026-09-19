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
export function saveLiveActivityDestination(input: Omit<LiveActivityDestination, 'id' | 'updated_at'>): void {
  database().prepare(`INSERT OR REPLACE INTO user_live_activity_destinations
    (id,user_id,device_id,connection_id,connection_token_hash,app_id,environment,destination_id,ciphertext,enabled,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(), input.user_id, input.device_id, input.connection_id,
      input.connection_token_hash, input.app_id, input.environment, input.destination_id, input.ciphertext, input.enabled, Date.now())
}
export function listLiveActivityDestinations(): LiveActivityDestination[] {
  if (!getDb()) return []
  return database().prepare('SELECT * FROM user_live_activity_destinations').all() as unknown as LiveActivityDestination[]
}
export function removeConnectionLiveActivities(connectionId: number): void {
  database().prepare('DELETE FROM user_live_activity_destinations WHERE connection_id=?').run(connectionId)
}
