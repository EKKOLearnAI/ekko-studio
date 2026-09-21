import { getDb } from '../infrastructure/database'
import { USAGE_TABLE } from '../infrastructure/database/schemas'

/** Recorded model-call usage in this activity's time window, not session lifetime totals.
 * Exclude estimates and run-level summaries to avoid double-counting model calls.
 * Unknown/unavailable data is absent, never a fabricated zero.
 */
export function getLiveActivityUsage(sessionId: string, profile: string, startedAtEpoch: number, throughMs: number) {
  if (!sessionId || !profile || !Number.isFinite(startedAtEpoch) || startedAtEpoch <= 0
    || !Number.isFinite(throughMs) || throughMs < startedAtEpoch * 1000) return undefined
  const db = getDb()
  if (!db) return undefined
  try {
    const row = db.prepare(`SELECT COUNT(*) AS count, SUM(input_tokens) AS input, SUM(output_tokens) AS output
      FROM ${USAGE_TABLE} WHERE session_id=? AND profile=? AND usage_scope='model_call'
      AND is_estimated=0 AND created_at>=? AND created_at<=?`).get(sessionId, profile, startedAtEpoch * 1000, throughMs) as any
    if (!row || !Number(row.count)) return undefined
    const inputTokens = Number(row.input), outputTokens = Number(row.output)
    if (![inputTokens, outputTokens].every(value => Number.isSafeInteger(value) && value >= 0)) return undefined
    return { inputTokens, outputTokens }
  } catch { return undefined } // Legacy stores may not have the model-call ledger yet.
}
