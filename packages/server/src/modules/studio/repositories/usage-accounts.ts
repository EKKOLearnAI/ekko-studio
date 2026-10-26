import { getDb, isSqliteAvailable, jsonGet, jsonGetAll } from '../infrastructure/database'
import { SESSIONS_TABLE, USAGE_TABLE, USERS_TABLE } from '../infrastructure/database/schemas'
import { studioSessionAccount } from '../contracts/runs/usage'

export interface UsageAccountOption { id: string; username: string }

function accountId(value: unknown): string | undefined {
  const id = String(value ?? '').trim()
  return /^[1-9]\d*$/.test(id) ? id : undefined
}

function hasTable(name: string): boolean {
  return !!getDb()?.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)
}

/** Studio identities come only from Web UI metadata, never a provider/gateway user ID. */
export function getSessionUsageAccounts(profile?: string): Record<string, string> {
  const rows = isSqliteAvailable()
    ? hasTable(SESSIONS_TABLE)
      ? getDb()!.prepare(`SELECT id, studio_user_id, user_id, source FROM ${SESSIONS_TABLE}${profile ? ' WHERE profile = ?' : ''}`)
        .all(...(profile ? [profile] : [])) as Array<{ id: string; studio_user_id: unknown; user_id: unknown; source: string }>
      : []
    : Object.entries(jsonGetAll(SESSIONS_TABLE) || {})
      .filter(([, row]) => !profile || (row.profile || 'default') === profile)
      .map(([id, row]) => ({ id, studio_user_id: row.studio_user_id, user_id: row.user_id, source: String(row.source || '') }))
  return Object.fromEntries(rows.flatMap(row => {
    const owner = studioSessionAccount(row)
    return owner ? [[row.id, owner]] : []
  }))
}

/** Snapshot the session owner when recording usage so deleting the session retains attribution. */
export function getSessionUsageAccount(sessionId: string, profile: string): string | undefined {
  const row = isSqliteAvailable()
    ? hasTable(SESSIONS_TABLE)
      ? getDb()!.prepare(`SELECT studio_user_id, user_id, source FROM ${SESSIONS_TABLE} WHERE id = ? AND profile = ?`).get(sessionId, profile) as { studio_user_id: unknown; user_id: unknown; source: string; profile?: string } | undefined
      : undefined
    : jsonGet(SESSIONS_TABLE, sessionId)
  if (!isSqliteAvailable() && row && (row.profile || 'default') !== profile) return undefined
  return row ? studioSessionAccount(row) : undefined
}

/** Include owners of newly created sessions, even before the first usage event arrives. */
export function getUsageAccountOptions(profiles: string[]): UsageAccountOption[] {
  const ids = new Set<string>()
  for (const profile of profiles) {
    for (const id of Object.values(getSessionUsageAccounts(profile))) ids.add(id)
    const rows = isSqliteAvailable()
      ? getDb()!.prepare(`SELECT DISTINCT account_id FROM ${USAGE_TABLE} WHERE profile = ? AND account_id IS NOT NULL`).all(profile)
      : Object.values(jsonGetAll(USAGE_TABLE) || {}).filter(row => (row.profile || 'default') === profile)
    for (const row of rows) {
      const id = accountId(row.account_id)
      if (id) ids.add(id)
    }
  }
  const users = isSqliteAvailable()
    ? hasTable(USERS_TABLE) && ids.size
      ? getDb()!.prepare(`SELECT id, username FROM ${USERS_TABLE} WHERE CAST(id AS TEXT) IN (SELECT value FROM json_each(?))`)
        .all(JSON.stringify([...ids])) as Array<{ id: number; username: string }>
      : []
    : Object.values(jsonGetAll(USERS_TABLE) || {}) as Array<{ id: number; username: string }>
  const names = new Map(users.map(user => [String(user.id), user.username]))
  return [...ids].sort((a, b) => Number(a) - Number(b)).map(id => ({ id, username: names.get(id) || `#${id}` }))
}

/** The persisted owner takes priority; historical rows may use an exact session/Profile match. */
export const usageAccountExpression = "COALESCE(NULLIF(TRIM(account_id), ''), (SELECT value FROM json_each(?) WHERE key = session_id), 'unassigned')"
