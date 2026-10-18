import { getDb } from '../infrastructure/database'
import { MODEL_API_KEYS_TABLE } from '../infrastructure/database/schemas'

export interface ModelApiKey {
  id: string
  name: string
  preview: string
  createdAt: number
  lastUsedAt: number | null
}
type KeyRow = {
  id: string; user_id: number; name: string; preview: string
  created_at: number; last_used_at: number | null
}
const columns = 'id, user_id, name, preview, created_at, last_used_at'
function database() {
  const db = getDb()
  if (!db) throw new Error('API key storage is unavailable.')
  return db
}
function publicKey(row: KeyRow): ModelApiKey {
  return { id: row.id, name: row.name, preview: row.preview, createdAt: row.created_at, lastUsedAt: row.last_used_at }
}
export function listModelApiKeys(userId: number): ModelApiKey[] {
  const rows = database().prepare(`SELECT ${columns} FROM ${MODEL_API_KEYS_TABLE} WHERE user_id = ? ORDER BY created_at DESC, id`).all(userId) as KeyRow[]
  return rows.map(publicKey)
}
export function insertModelApiKey(userId: number, key: ModelApiKey, tokenHash: string) {
  database().prepare(`INSERT INTO ${MODEL_API_KEYS_TABLE} (id, user_id, name, preview, token_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(key.id, userId, key.name, key.preview, tokenHash, key.createdAt)
}
export function findModelApiKeyByHash(tokenHash: string): { id: string; userId: number } | null {
  const row = database().prepare(`SELECT id, user_id FROM ${MODEL_API_KEYS_TABLE} WHERE token_hash = ?`).get(tokenHash) as KeyRow | undefined
  return row ? { id: row.id, userId: row.user_id } : null
}
export function touchModelApiKey(id: string) {
  database().prepare(`UPDATE ${MODEL_API_KEYS_TABLE} SET last_used_at = ? WHERE id = ?`).run(Date.now(), id)
}
export function revokeModelApiKey(userId: number, id: string): boolean {
  return database().prepare(`DELETE FROM ${MODEL_API_KEYS_TABLE} WHERE id = ? AND user_id = ?`).run(id, userId).changes > 0
}
