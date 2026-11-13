import { getDb } from '../infrastructure/database'
import { MODEL_API_KEYS_TABLE, USAGE_TABLE } from '../infrastructure/database/schemas'

export interface ModelApiKey {
  id: string
  name: string
  models: string[]
  budgetUsd: number | null
  spentUsd: number
  unpricedRequests: number
  preview: string
  createdAt: number
  lastUsedAt: number | null
}
type KeyRow = {
  id: string; user_id: number; name: string; preview: string; models_json: string
  created_at: number; last_used_at: number | null
  budget_usd: number | null; spent_usd: number; unpriced_requests: number
}
// Read the same immutable request costs used by the usage page, including any
// delayed catalog pricing. Editing a key never resets its lifetime spend.
const select = `SELECT k.*,
  COALESCE((SELECT SUM(u.cost_usd) FROM ${USAGE_TABLE} u WHERE u.model_api_key_id = k.id AND u.account_id = CAST(k.user_id AS TEXT) AND u.origin = 'external'), 0) AS spent_usd,
  (SELECT COUNT(*) FROM ${USAGE_TABLE} u WHERE u.model_api_key_id = k.id AND u.account_id = CAST(k.user_id AS TEXT) AND u.origin = 'external' AND u.cost_usd IS NULL) AS unpriced_requests
  FROM ${MODEL_API_KEYS_TABLE} k`
function database() {
  const db = getDb()
  if (!db) throw new Error('API key storage is unavailable.')
  return db
}
function publicKey(row: KeyRow): ModelApiKey {
  return { id: row.id, name: row.name, models: JSON.parse(row.models_json), budgetUsd: row.budget_usd, spentUsd: row.spent_usd, unpricedRequests: row.unpriced_requests, preview: row.preview, createdAt: row.created_at, lastUsedAt: row.last_used_at }
}
export function listModelApiKeys(userId: number): ModelApiKey[] {
  const rows = database().prepare(`${select} WHERE k.user_id = ? ORDER BY k.created_at DESC, k.id`).all(userId) as KeyRow[]
  return rows.map(publicKey)
}
export function insertModelApiKey(userId: number, key: ModelApiKey, tokenHash: string) {
  database().prepare(`INSERT INTO ${MODEL_API_KEYS_TABLE} (id, user_id, name, preview, token_hash, models_json, budget_usd, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(key.id, userId, key.name, key.preview, tokenHash, JSON.stringify(key.models), key.budgetUsd, key.createdAt)
}
export function findModelApiKeyByHash(tokenHash: string): { id: string; userId: number; models: string[] } | null {
  const row = database().prepare(`SELECT id, user_id, models_json FROM ${MODEL_API_KEYS_TABLE} WHERE token_hash = ?`).get(tokenHash) as KeyRow | undefined
  return row ? { id: row.id, userId: row.user_id, models: JSON.parse(row.models_json) } : null
}
export function getModelApiKey(userId: number, id: string): ModelApiKey | null {
  const row = database().prepare(`${select} WHERE k.id = ? AND k.user_id = ?`).get(id, userId) as KeyRow | undefined
  return row ? publicKey(row) : null
}
export function updateModelApiKey(userId: number, id: string, name: string, models: string[], budgetUsd: number | null): ModelApiKey | null {
  const result = database().prepare(`UPDATE ${MODEL_API_KEYS_TABLE} SET name = ?, models_json = ?, budget_usd = ? WHERE id = ? AND user_id = ?`)
    .run(name, JSON.stringify(models), budgetUsd, id, userId)
  return result.changes ? getModelApiKey(userId, id) : null
}
export function unpricedModelApiRequests(userId: number, keyId: string): Array<{ run_id: string }> {
  return database().prepare(`SELECT run_id FROM ${USAGE_TABLE} WHERE model_api_key_id = ? AND account_id = ? AND origin = 'external' AND cost_usd IS NULL`)
    .all(keyId, String(userId)) as Array<{ run_id: string }>
}
export function beginModelApiKeyUsage(userId: number, keyId: string, requestId: string): void {
  // Persist before contacting the provider. A crash or failed settlement leaves
  // an unknown-cost request, so a limited key cannot silently spend past it.
  database().prepare(`INSERT INTO ${USAGE_TABLE}
    (session_id, account_id, model_api_key_id, model_api_pending, origin, run_id, source, agent, usage_scope, api_calls, is_estimated, created_at)
    VALUES ('', ?, ?, 1, 'external', ?, 'model_api', 'model_api', 'model_call', 1, 1, ?)`)
    .run(String(userId), keyId, requestId, Date.now())
}
export function touchModelApiKey(id: string) {
  database().prepare(`UPDATE ${MODEL_API_KEYS_TABLE} SET last_used_at = ? WHERE id = ?`).run(Date.now(), id)
}
export function revokeModelApiKey(userId: number, id: string): boolean {
  return database().prepare(`DELETE FROM ${MODEL_API_KEYS_TABLE} WHERE id = ? AND user_id = ?`).run(id, userId).changes > 0
}
