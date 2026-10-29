import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { config } from './config'

/**
 * Studio-owned locations shared with the Hermes Agent Bridge for cron session bindings.
 * The bridge writes bindings; Studio reads them. Both live under the Web UI home.
 */
export function sessionNotificationsDir(): string {
  return join(config.appHome, 'session-notifications')
}

export function cronBindingsDbPath(): string {
  return join(sessionNotificationsDir(), 'cron-bindings.db')
}

let cachedInstanceId: string | null = null

/** Stable identity of this Studio installation's state directory. */
export function studioInstanceId(): string {
  if (cachedInstanceId) return cachedInstanceId
  const dir = sessionNotificationsDir()
  const file = join(dir, 'instance-id')
  if (existsSync(file)) {
    const existing = readFileSync(file, 'utf-8').trim()
    if (existing) return (cachedInstanceId = existing)
  }
  mkdirSync(dir, { recursive: true })
  const created = randomUUID()
  writeFileSync(file, `${created}\n`, { encoding: 'utf-8', mode: 0o600 })
  return (cachedInstanceId = created)
}

export function sessionNotificationBridgeEnv(): string {
  return JSON.stringify({ bindings_db: cronBindingsDbPath(), instance_id: studioInstanceId() })
}

export function resetSessionNotificationInstanceForTests(): void {
  cachedInstanceId = null
}
