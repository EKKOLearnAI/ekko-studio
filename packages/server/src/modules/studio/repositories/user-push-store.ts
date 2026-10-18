import { randomUUID } from 'node:crypto'
import { getDb } from '../infrastructure/database'

export interface UserPushDevice {
  id: string; user_id: number; device_id: string; connection_id: number; connection_token_hash: string
  app_id: string; environment: string; recipient_hash: string; ciphertext: string; updated_at: number
}
const initialized = new WeakSet<object>()
function database() {
  const db = getDb()
  if (!db) throw new Error('push_storage_unavailable')
  if (!initialized.has(db)) {
    db.exec(`CREATE TABLE IF NOT EXISTS user_push_devices (
      id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, device_id TEXT NOT NULL,
      connection_id INTEGER NOT NULL, connection_token_hash TEXT NOT NULL,
      app_id TEXT NOT NULL, environment TEXT NOT NULL, recipient_hash TEXT NOT NULL,
      ciphertext TEXT NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(device_id, app_id, environment), UNIQUE(app_id, environment, recipient_hash)
    ); CREATE INDEX IF NOT EXISTS user_push_devices_user ON user_push_devices(user_id);`)
    initialized.add(db)
  }
  return db
}

/** A new login/token replaces the device's old ownership; never copy run snapshots. */
export function saveUserPushDevice(input: Omit<UserPushDevice, 'id' | 'updated_at'>): void {
  database().prepare(`INSERT OR REPLACE INTO user_push_devices
    (id,user_id,device_id,connection_id,connection_token_hash,app_id,environment,recipient_hash,ciphertext,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(), input.user_id, input.device_id, input.connection_id,
      input.connection_token_hash, input.app_id, input.environment, input.recipient_hash, input.ciphertext, Date.now())
}
export function listUserPushDevices(): UserPushDevice[] {
  if (!getDb()) return []
  return database().prepare('SELECT * FROM user_push_devices').all() as unknown as UserPushDevice[]
}
export function removeUserPushDevice(id: string): void {
  // IDs change on every registration, so a late send failure cannot delete a refreshed token.
  database().prepare('DELETE FROM user_push_devices WHERE id=?').run(id)
}
export function removeConnectionPushDevices(connectionId: number): void {
  database().prepare('DELETE FROM user_push_devices WHERE connection_id=?').run(connectionId)
}
