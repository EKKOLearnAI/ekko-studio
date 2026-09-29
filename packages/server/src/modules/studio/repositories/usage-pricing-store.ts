import { getDb, isSqliteAvailable, jsonGet, jsonSet } from '../infrastructure/database'
import { USAGE_PRICING_TABLE as TABLE } from '../infrastructure/database/schemas'
import type { UsagePricing } from '../services/usage/usage-cost'

export function getUsagePricing(profile: string): UsagePricing[] {
  const row = isSqliteAvailable()
    ? getDb()!.prepare(`SELECT rates FROM ${TABLE} WHERE profile = ?`).get(profile) as { rates: string } | undefined
    : jsonGet(TABLE, profile)
  return row ? JSON.parse(row.rates) : []
}

export function saveUsagePricing(profile: string, rates: UsagePricing[]): void {
  const serialized = JSON.stringify(rates)
  if (isSqliteAvailable()) {
    getDb()!.prepare(`INSERT INTO ${TABLE} (profile, rates) VALUES (?, ?)
      ON CONFLICT(profile) DO UPDATE SET rates = excluded.rates`).run(profile, serialized)
  } else {
    jsonSet(TABLE, profile, { rates: serialized })
  }
}
