import { getDb } from '../infrastructure/database'

// Separate from the administrator's app_connections.push_enabled. Re-enabling
// the App preference must never override an administrator's disabled device.
function database() {
  const db = getDb()
  if (!db) throw new Error('notification_preference_storage_unavailable')
  db.exec(`CREATE TABLE IF NOT EXISTS device_notification_preferences (
    user_id INTEGER NOT NULL, device_code TEXT NOT NULL, enabled INTEGER NOT NULL,
    PRIMARY KEY(user_id,device_code))`)
  return db
}
export function deviceSystemNotificationsEnabled(userId: number, deviceCode: string): boolean {
  if (!getDb()) return true
  const row = database().prepare('SELECT enabled FROM device_notification_preferences WHERE user_id=? AND device_code=?')
    .get(userId,deviceCode) as {enabled:number}|undefined
  return row?.enabled !== 0
}
export function saveDeviceSystemNotifications(userId: number, deviceCode: string, enabled: boolean): void {
  if (!Number.isSafeInteger(userId) || userId<=0 || !deviceCode) throw new Error('invalid_notification_identity')
  database().prepare(`INSERT INTO device_notification_preferences VALUES(?,?,?) ON CONFLICT(user_id,device_code)
    DO UPDATE SET enabled=excluded.enabled`).run(userId,deviceCode,enabled?1:0)
}
