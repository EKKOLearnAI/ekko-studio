import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { config } from './config'

let cachedInstanceId: string | null = null

/** Stable identity of this Studio installation's state directory; namespaces notice producer keys. */
export function studioInstanceId(): string {
  if (cachedInstanceId) return cachedInstanceId
  const dir = join(config.appHome, 'session-notifications')
  const file = join(dir, 'instance-id')
  if (existsSync(file)) {
    const existing = readFileSync(file, 'utf-8').trim()
    if (existing) return (cachedInstanceId = existing)
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const created = randomUUID()
  writeFileSync(file, `${created}\n`, { encoding: 'utf-8', mode: 0o600 })
  return (cachedInstanceId = created)
}
