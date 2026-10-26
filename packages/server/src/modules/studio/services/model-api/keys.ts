import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { findModelApiKeyByHash, insertModelApiKey, listModelApiKeys, type ModelApiKey } from '../../repositories/model-api-keys-store'
import { ModelApiError } from './errors'

export { listModelApiKeys, revokeModelApiKey, touchModelApiKey } from '../../repositories/model-api-keys-store'
export const MODEL_API_KEY_PREFIX = 'sk-ekko-'
const hash = (token: string) => createHash('sha256').update(token).digest('hex')

export function createModelApiKey(userId: number, name: string, models: string[], budgetUsd: number | null) {
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 80) throw new ModelApiError('Key name must contain 1–80 characters.', 400, 'name')
  if (listModelApiKeys(userId).length >= 50) throw new ModelApiError('Revoke an existing key before creating another (maximum 50 per account).', 400)
  const apiKey = `${MODEL_API_KEY_PREFIX}${randomBytes(32).toString('base64url')}`
  const key: ModelApiKey = { id: randomUUID(), name: name.trim(), models, budgetUsd, spentUsd: 0, unpricedRequests: 0, preview: `${MODEL_API_KEY_PREFIX}…${apiKey.slice(-4)}`, createdAt: Date.now(), lastUsedAt: null }
  insertModelApiKey(userId, key, hash(apiKey))
  // Plaintext is returned only on creation; it is never persisted.
  return { key, apiKey }
}

export function findModelApiKey(token: string): { id: string; userId: number; models: string[] } | null {
  if (!/^sk-ekko-[A-Za-z0-9_-]{43}$/.test(token)) return null
  return findModelApiKeyByHash(hash(token))
}
