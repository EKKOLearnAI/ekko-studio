import { getDb, isSqliteAvailable } from '../infrastructure/database'
import { RUN_USAGE_TABLE, USAGE_TABLE } from '../infrastructure/database/schemas'
import type { RunUsageSummary } from '../contracts/runs/run-usage'
import { logger } from '../public/logging'

const metricColumns = [
  'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens',
  'cache_hit_rate', 'cost_usd', 'model_duration_seconds', 'tokens_per_second', 'is_estimated',
]
// Ledger input buckets are disjoint. Weight the whole run by token counts, not
// by averaging individual request hit rates. Cache writes are input, not hits.
const totalInput = 'SUM(input_tokens + cache_read_tokens + cache_write_tokens)'
const modelDuration = 'CASE WHEN COUNT(api_duration) = COUNT(*) THEN SUM(api_duration) END'
const aggregateMetrics = `${totalInput}, SUM(output_tokens), SUM(cache_read_tokens), SUM(cache_write_tokens),
  CASE WHEN ${totalInput} > 0 THEN 1.0 * SUM(cache_read_tokens) / ${totalInput} END,
  CASE WHEN COUNT(cost_usd) = COUNT(*) THEN SUM(cost_usd) END,
  ${modelDuration},
  CASE WHEN (${modelDuration}) > 0 THEN ROUND(1.0 * SUM(output_tokens) / (${modelDuration}), 1) END,
  COALESCE(MAX(is_estimated), 0)`

function emptySummary(runId: string, assistantMessageId: string): RunUsageSummary {
  return { runId, assistantMessageId, inputTokens: null, outputTokens: null, cacheReadTokens: null,
    cacheHitRate: null, costUsd: null, tokensPerSecond: null, speedSource: null, isEstimated: false }
}

function mapSummary(row: Record<string, any>): RunUsageSummary {
  return {
    runId: row.run_id,
    assistantMessageId: row.assistant_message_id,
    inputTokens: row.input_tokens ?? null,
    outputTokens: row.output_tokens ?? null,
    cacheReadTokens: row.cache_read_tokens ?? null,
    cacheHitRate: row.cache_hit_rate ?? null,
    costUsd: row.cost_usd ?? null,
    tokensPerSecond: row.tokens_per_second ?? null,
    speedSource: row.tokens_per_second == null ? null : row.model_duration_seconds > 0 ? 'model' : row.tool_duration_seconds != null ? 'estimated' : 'run',
    isEstimated: Boolean(row.is_estimated),
  }
}

/** Reads the stored per-run snapshot, without re-aggregating the call ledger. */
function readSummaries(sessionId: string, assistantIds: string[]): RunUsageSummary[] {
  if (!isSqliteAvailable() || !assistantIds.length) return []
  const rows = getDb()?.prepare(`SELECT * FROM ${RUN_USAGE_TABLE}
    WHERE session_id = ? AND assistant_message_id IN (${assistantIds.map(() => '?').join(',')})`)
    .all(sessionId, ...assistantIds) as Array<Record<string, any>> | undefined
  return (rows || []).map(mapSummary)
}

/** Deduct the union of tool intervals only when their timing is complete. */
function applyRunSpeedFallback(sessionId: string, runId: string): void {
  getDb()?.prepare(`UPDATE ${RUN_USAGE_TABLE} SET tokens_per_second =
    CASE WHEN run_duration_seconds > COALESCE(tool_duration_seconds, 0)
      THEN ROUND(1.0 * output_tokens / (run_duration_seconds - COALESCE(tool_duration_seconds, 0)), 1) END
    WHERE session_id = ? AND run_id = ? AND model_duration_seconds IS NULL AND run_duration_seconds > 0`)
    .run(sessionId, runId)
}

/** Late usage or pricing can refresh an existing completed run, never create one. */
export function refreshCompletedRunUsage(sessionId: string, runId: string): void {
  if (!runId || !isSqliteAvailable()) return
  getDb()?.prepare(`UPDATE ${RUN_USAGE_TABLE} SET (${metricColumns.join(', ')}, updated_at) = (
    SELECT ${aggregateMetrics}, ? FROM ${USAGE_TABLE} WHERE session_id = ? AND parent_run_id = ?
  ) WHERE session_id = ? AND run_id = ?`).run(Date.now(), sessionId, runId, sessionId, runId)
  applyRunSpeedFallback(sessionId, runId)
}

/** Save one completed run, deduplicated by its session and run identity. */
export function completeRunUsage(sessionId: string, runId: string, assistantMessageId?: string | number | null, runDurationSeconds?: number, toolDurationSeconds?: number): RunUsageSummary {
  const id = assistantMessageId == null ? '' : String(assistantMessageId)
  const fallback = emptySummary(runId, id)
  if (!runId || !isSqliteAvailable()) return fallback
  try {
    const db = getDb()
    if (!db) return fallback
    const now = Date.now()
    const duration = typeof runDurationSeconds === 'number' && Number.isFinite(runDurationSeconds) && runDurationSeconds > 0
      ? runDurationSeconds : null
    const tools = duration != null && typeof toolDurationSeconds === 'number' && Number.isFinite(toolDurationSeconds)
      && toolDurationSeconds >= 0 && toolDurationSeconds <= duration ? toolDurationSeconds : null
    db.prepare(`INSERT INTO ${RUN_USAGE_TABLE}
      (session_id, run_id, assistant_message_id, completed_at, updated_at, run_duration_seconds, tool_duration_seconds, ${metricColumns.join(', ')})
      SELECT ?, ?, ?, ?, ?, ?, ?, ${aggregateMetrics} FROM ${USAGE_TABLE}
      WHERE session_id = ? AND parent_run_id = ?
      ON CONFLICT(session_id, run_id) DO UPDATE SET
        assistant_message_id = CASE WHEN excluded.assistant_message_id <> '' THEN excluded.assistant_message_id ELSE assistant_message_id END,
        updated_at = excluded.updated_at,
        run_duration_seconds = COALESCE(run_duration_seconds, excluded.run_duration_seconds),
        tool_duration_seconds = COALESCE(tool_duration_seconds, excluded.tool_duration_seconds),
        ${metricColumns.map(column => `${column} = excluded.${column}`).join(', ')}`)
      .run(sessionId, runId, id, now, now, duration, tools, sessionId, runId)
    applyRunSpeedFallback(sessionId, runId)
    const row = db.prepare(`SELECT * FROM ${RUN_USAGE_TABLE} WHERE session_id = ? AND run_id = ?`)
      .get(sessionId, runId) as Record<string, any>
    return mapSummary(row)
  } catch (err) {
    logger.warn({ err, sessionId, runId }, '[run-usage] failed to complete run usage')
    return fallback
  }
}

/** Only enrich the exact persisted assistant row; never guess the last turn. */
export function withRunUsage<T extends { id?: unknown; role?: unknown; display_role?: unknown }>(sessionId: string, messages: T[]): T[] {
  const ids = messages.filter(message => (message.display_role || message.role) === 'assistant')
    .map(message => String(message.id || '')).filter(Boolean)
  try {
    const summaries = new Map(readSummaries(sessionId, ids).map(row => [row.assistantMessageId, row]))
    return messages.map(message => {
      const summary = summaries.get(String(message.id))
      return summary ? { ...message, run_usage: summary } : message
    })
  } catch (err) {
    logger.warn({ err, sessionId }, '[run-usage] failed to read run usage')
    return messages
  }
}
