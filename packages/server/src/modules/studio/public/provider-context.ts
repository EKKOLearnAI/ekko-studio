import { getDb } from '../infrastructure/database'
import {
  MODEL_CONTEXT_INDEX,
  MODEL_CONTEXT_SCHEMA,
  MODEL_CONTEXT_TABLE,
  syncTable,
} from '../infrastructure/database/schemas'

function ensureProviderContextTable(): void {
  syncTable(MODEL_CONTEXT_TABLE, MODEL_CONTEXT_SCHEMA, {
    indexes: { idx_model_context_profile_provider_model: MODEL_CONTEXT_INDEX },
  })
}

export interface ModelContextRecord {
  id: number
  profile: string
  provider: string
  model: string
  context_limit: number
}

export type ModelContextResult =
  | { available: false }
  | { available: true; row?: ModelContextRecord }

export function readModelContextRecord(profile: string, provider: string, model: string): ModelContextResult {
  const db = getDb()
  if (!db) return { available: false }
  const row = db.prepare(
    `SELECT id, profile, provider, model, context_limit FROM ${MODEL_CONTEXT_TABLE} WHERE profile = ? AND provider = ? AND model = ?`,
  ).get(profile, provider, model) as ModelContextRecord | undefined
  return { available: true, ...(row ? { row } : {}) }
}

export function upsertModelContextRecord(
  profile: string,
  provider: string,
  model: string,
  contextLimit: number,
): ModelContextResult {
  const db = getDb()
  if (!db) return { available: false }
  db.prepare(
    `INSERT INTO ${MODEL_CONTEXT_TABLE} (profile, provider, model, context_limit) VALUES (?, ?, ?, ?) `
    + 'ON CONFLICT(profile, provider, model) DO UPDATE SET context_limit = excluded.context_limit',
  ).run(profile, provider, model, contextLimit)
  const row = db.prepare(
    `SELECT id, profile, provider, model, context_limit FROM ${MODEL_CONTEXT_TABLE} WHERE profile = ? AND provider = ? AND model = ?`,
  ).get(profile, provider, model) as unknown as ModelContextRecord
  return { available: true, row }
}

export function readProviderContextLengths(profile: string, provider: string): Record<string, number> {
  const db = getDb()
  if (!db) return {}
  try {
    ensureProviderContextTable()
    const rows = db.prepare(
      `SELECT model, context_limit FROM ${MODEL_CONTEXT_TABLE} WHERE profile = ? AND provider = ? ORDER BY model`,
    ).all(profile, provider) as unknown as Array<{ model: string; context_limit: number }>
    return Object.fromEntries(rows.map(row => [row.model, Number(row.context_limit)]))
  } catch {
    return {}
  }
}

export function writeProviderContextLengths(
  profile: string,
  provider: string,
  updates: Array<[model: string, value: number | null]>,
): boolean {
  const db = getDb()
  if (!db) return false
  ensureProviderContextTable()
  db.exec('BEGIN IMMEDIATE')
  try {
    const upsert = db.prepare(
      `INSERT INTO ${MODEL_CONTEXT_TABLE} (profile, provider, model, context_limit) VALUES (?, ?, ?, ?) `
      + 'ON CONFLICT(profile, provider, model) DO UPDATE SET context_limit = excluded.context_limit',
    )
    const remove = db.prepare(
      `DELETE FROM ${MODEL_CONTEXT_TABLE} WHERE profile = ? AND provider = ? AND model = ?`,
    )
    for (const [model, value] of updates) {
      if (value === null) remove.run(profile, provider, model)
      else upsert.run(profile, provider, model, value)
    }
    db.exec('COMMIT')
    return true
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
