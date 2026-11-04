import { beginModelApiKeyUsage, getModelApiKey, unpricedModelApiRequests } from '../../repositories/model-api-keys-store'
import { ModelApiError } from './errors'

const activeRequests = new Set<string>()

/** Admission uses settled lifetime spend; already running calls can overshoot. */
export function checkModelApiBudget(userId: number, keyId: string): void {
  const key = getModelApiKey(userId, keyId)
  if (!key) throw new ModelApiError('API key is no longer available.', 401)
  if (key.budgetUsd === null) return
  const roundingTolerance = Number.EPSILON * Math.max(key.spentUsd, key.budgetUsd) * 4
  if (key.spentUsd + roundingTolerance >= key.budgetUsd) {
    throw new ModelApiError('API key USD budget exhausted. Ask the owner to increase its budget.', 429, null, 'insufficient_quota')
  }
  // Unknown is never treated as free. A delayed catalog fill automatically
  // makes the key usable again when every request has a recorded price.
  if (key.unpricedRequests && unpricedModelApiRequests(userId, keyId).some(row => !activeRequests.has(row.run_id))) {
    throw new ModelApiError('API key has requests with unknown cost. Limited keys cannot continue until costs are resolved.', 429, null, 'quota_cost_unknown')
  }
}

export function startModelApiKeyRequest(userId: number, keyId: string, requestId: string): () => void {
  checkModelApiBudget(userId, keyId)
  beginModelApiKeyUsage(userId, keyId, requestId)
  activeRequests.add(requestId)
  return () => { activeRequests.delete(requestId) }
}
