import { isSqliteAvailable, getDb, jsonSet, jsonGet, jsonGetAll, jsonDelete } from '../infrastructure/database'
import { USAGE_TABLE as TABLE } from '../infrastructure/database/schemas'
import type {
  LocalUsageStats,
  UsageStatsAgentRow,
  UsageStatsDailyRow,
  UsageStatsModelRow,
} from '../contracts/runs/usage'

export type {
  LocalUsageStats,
  UsageStatsAgentRow,
  UsageStatsDailyRow,
  UsageStatsModelRow,
} from '../contracts/runs/usage'

export interface UsageRecord {
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  reasoning_tokens: number
  model: string
  profile: string
  created_at: number
}

function hasUpdatedAtColumn(): boolean {
  const db = getDb()
  if (!db) return false
  try {
    const rows = db.prepare(`PRAGMA table_info("${TABLE}")`).all() as unknown
    return Array.isArray(rows) && rows.some((row: any) => row?.name === 'updated_at')
  } catch {
    return false
  }
}

export function updateUsage(
  sessionId: string,
  data: {
    runId?: string
    source?: string
    agent?: string
    usageScope?: 'model_call' | 'run'
    purpose?: string
    apiCalls?: number
    inputTokens: number
    outputTokens: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
    reasoningTokens?: number
    model?: string
    provider?: string
    profile?: string
    isEstimated?: boolean
  },
): void {
  const cacheReadTokens = data.cacheReadTokens ?? 0
  const cacheWriteTokens = data.cacheWriteTokens ?? 0
  const reasoningTokens = data.reasoningTokens ?? 0
  const now = Date.now()
  const model = data.model || ''
  const provider = data.provider || ''
  const profile = data.profile || 'default'
  if (isSqliteAvailable()) {
    const db = getDb()!
    const columns = [
      'session_id',
      'run_id',
      'source',
      'agent',
      'usage_scope',
      'purpose',
      'api_calls',
      'input_tokens',
      'output_tokens',
      'cache_read_tokens',
      'cache_write_tokens',
      'reasoning_tokens',
      'model',
      'provider',
      'profile',
      'is_estimated',
      'created_at',
    ]
    const values = columns.map(() => '?')
    const params = [
      sessionId,
      data.runId || '',
      data.source || '',
      data.agent || '',
      data.usageScope || 'run',
      data.purpose || '',
      data.apiCalls ?? 0,
      data.inputTokens,
      data.outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      reasoningTokens,
      model,
      provider,
      profile,
      data.isEstimated ? 1 : 0,
      now,
    ]
    if (hasUpdatedAtColumn()) {
      columns.push('updated_at')
      values.push('?')
      params.push(now)
    }
    db.prepare(
      `INSERT OR IGNORE INTO ${TABLE} (${columns.join(', ')}) VALUES (${values.join(', ')})`,
    ).run(...params)
  } else {
    jsonSet(TABLE, sessionId, {
      run_id: data.runId || '',
      source: data.source || '',
      agent: data.agent || '',
      usage_scope: data.usageScope || 'run',
      purpose: data.purpose || '',
      api_calls: data.apiCalls ?? 0,
      input_tokens: data.inputTokens,
      output_tokens: data.outputTokens,
      cache_read_tokens: cacheReadTokens,
      cache_write_tokens: cacheWriteTokens,
      reasoning_tokens: reasoningTokens,
      model,
      provider,
      profile,
      is_estimated: data.isEstimated ? 1 : 0,
      created_at: now,
    })
  }
}

export function getRecordedUsageTotals(sessionId: string, source: string): {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  apiCalls: number
} {
  if (!isSqliteAvailable()) {
    return {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      apiCalls: 0,
    }
  }
  const row = getDb()!.prepare(`
    SELECT
      COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
      COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
      COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
      COALESCE(SUM(api_calls), 0) AS api_calls
    FROM ${TABLE}
    WHERE session_id = ? AND source = ?
  `).get(sessionId, source) as any
  return {
    inputTokens: Number(row?.input_tokens || 0),
    outputTokens: Number(row?.output_tokens || 0),
    cacheReadTokens: Number(row?.cache_read_tokens || 0),
    cacheWriteTokens: Number(row?.cache_write_tokens || 0),
    reasoningTokens: Number(row?.reasoning_tokens || 0),
    apiCalls: Number(row?.api_calls || 0),
  }
}

/**
 * Aggregate provider-recorded usage for one chat run.
 *
 * Model-call rows are often stored as `${runId}:api:...` / `${runId}:step:...`
 * rather than the bare run id, so both exact and prefix matches are included.
 */
export function getRecordedUsageByRun(
  sessionId: string,
  source: string,
  runId: string,
): {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  apiCalls: number
} {
  const empty = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    apiCalls: 0,
  }
  const normalizedRunId = String(runId || '').trim()
  if (!normalizedRunId) return empty

  if (!isSqliteAvailable()) {
    const all = jsonGetAll(TABLE)
    // JSON fallback stores one blob per session id (no multi-row run history).
    const row = all[sessionId]
    if (!row) return empty
    const rowRunId = String(row.run_id || '')
    if (rowRunId !== normalizedRunId && !rowRunId.startsWith(`${normalizedRunId}:`)) {
      return empty
    }
    if (source && String(row.source || '') !== source) return empty
    return {
      inputTokens: Number(row.input_tokens || 0),
      outputTokens: Number(row.output_tokens || 0),
      cacheReadTokens: Number(row.cache_read_tokens || 0),
      cacheWriteTokens: Number(row.cache_write_tokens || 0),
      reasoningTokens: Number(row.reasoning_tokens || 0),
      apiCalls: Number(row.api_calls || 0),
    }
  }

  const row = getDb()!.prepare(`
    SELECT
      COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
      COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
      COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
      COALESCE(SUM(api_calls), 0) AS api_calls
    FROM ${TABLE}
    WHERE session_id = ?
      AND source = ?
      AND (run_id = ? OR run_id LIKE ?)
  `).get(sessionId, source, normalizedRunId, `${normalizedRunId}:%`) as any

  return {
    inputTokens: Number(row?.input_tokens || 0),
    outputTokens: Number(row?.output_tokens || 0),
    cacheReadTokens: Number(row?.cache_read_tokens || 0),
    cacheWriteTokens: Number(row?.cache_write_tokens || 0),
    reasoningTokens: Number(row?.reasoning_tokens || 0),
    apiCalls: Number(row?.api_calls || 0),
  }
}

export function getUsage(sessionId: string): UsageRecord | undefined {
  if (isSqliteAvailable()) {
    return getDb()!.prepare(
      `SELECT session_id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, model, profile, created_at FROM ${TABLE} WHERE session_id = ? ORDER BY id DESC LIMIT 1`,
    ).get(sessionId) as UsageRecord | undefined
  }
  const row = jsonGet(TABLE, sessionId)
  if (!row) return undefined
  return {
    input_tokens: row.input_tokens ?? 0,
    output_tokens: row.output_tokens ?? 0,
    cache_read_tokens: row.cache_read_tokens ?? 0,
    cache_write_tokens: row.cache_write_tokens ?? 0,
    reasoning_tokens: row.reasoning_tokens ?? 0,
    model: row.model ?? '',
    profile: row.profile ?? 'default',
    created_at: row.created_at ?? 0,
  }
}

export function getUsageBatch(sessionIds: string[]): Record<string, UsageRecord> {
  if (sessionIds.length === 0) return {}
  if (isSqliteAvailable()) {
    const db = getDb()!
    const placeholders = sessionIds.map(() => '?').join(',')
    const rows = db.prepare(
      `SELECT session_id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, model, profile, created_at
       FROM ${TABLE}
       WHERE id IN (SELECT MAX(id) FROM ${TABLE} WHERE session_id IN (${placeholders}) GROUP BY session_id)`,
    ).all(...sessionIds) as unknown as Array<UsageRecord & { session_id: string }>
    const map: Record<string, UsageRecord> = {}
    for (const r of rows) {
      map[r.session_id] = {
        input_tokens: r.input_tokens,
        output_tokens: r.output_tokens,
        cache_read_tokens: r.cache_read_tokens,
        cache_write_tokens: r.cache_write_tokens,
        reasoning_tokens: r.reasoning_tokens,
        model: r.model,
        profile: r.profile,
        created_at: r.created_at,
      }
    }
    return map
  }
  const all = jsonGetAll(TABLE)
  const map: Record<string, UsageRecord> = {}
  for (const id of sessionIds) {
    const row = all[id]
    if (row) {
      map[id] = {
        input_tokens: row.input_tokens ?? 0,
        output_tokens: row.output_tokens ?? 0,
        cache_read_tokens: row.cache_read_tokens ?? 0,
        cache_write_tokens: row.cache_write_tokens ?? 0,
        reasoning_tokens: row.reasoning_tokens ?? 0,
        model: row.model ?? '',
        profile: row.profile ?? 'default',
        created_at: row.created_at ?? 0,
      }
    }
  }
  return map
}

export function deleteUsage(sessionId: string): void {
  if (isSqliteAvailable()) {
    getDb()!.prepare(`DELETE FROM ${TABLE} WHERE session_id = ?`).run(sessionId)
  } else {
    jsonDelete(TABLE, sessionId)
  }
}

// --- Aggregation for stats endpoint ---

export function getRecordedUsageSessionIds(profile?: string): string[] {
  if (isSqliteAvailable()) {
    const filters = profile ? ' WHERE profile = ?' : ''
    const params = profile ? [profile] : []
    const rows = getDb()!.prepare(
      `SELECT DISTINCT session_id FROM ${TABLE}${filters}`,
    ).all(...params) as unknown as Array<{ session_id: string }>
    return rows.map(row => String(row.session_id || '')).filter(Boolean)
  }
  return Object.entries(jsonGetAll(TABLE))
    .filter(([, row]) => !profile || (row.profile || 'default') === profile)
    .map(([sessionId]) => sessionId)
    .filter(Boolean)
}

export function getLocalUsageStats(profile?: string, days = 30): LocalUsageStats {
  const empty: LocalUsageStats = {
    input_tokens: 0, output_tokens: 0, cache_read_tokens: 0,
    cache_write_tokens: 0, reasoning_tokens: 0, sessions: 0,
    by_model: [], by_agent: [], by_day: [], cost: 0, total_api_calls: 0,
  }
  if (!isSqliteAvailable()) return empty

  const db = getDb()!
  const safeDays = Math.max(1, Math.floor(Number.isFinite(days) ? days : 30))
  const cutoffMs = Date.now() - safeDays * 24 * 60 * 60 * 1000
  const filters: string[] = ['created_at > ?']
  const params: any[] = [cutoffMs]
  if (profile) {
    filters.unshift('profile = ?')
    params.unshift(profile)
  }
  const whereClause = `WHERE ${filters.join(' AND ')}`

  const totals = db.prepare(`
    SELECT COALESCE(SUM(input_tokens),0) as input_tokens,
      COALESCE(SUM(output_tokens),0) as output_tokens,
      COALESCE(SUM(cache_read_tokens),0) as cache_read_tokens,
      COALESCE(SUM(cache_write_tokens),0) as cache_write_tokens,
      COALESCE(SUM(reasoning_tokens),0) as reasoning_tokens,
      COALESCE(SUM(api_calls),0) as total_api_calls,
      COUNT(DISTINCT session_id) as sessions
    FROM ${TABLE}
    ${whereClause}
  `).get(...params) as any

  const byModel = db.prepare(`
    SELECT model,
      COALESCE(SUM(input_tokens),0) as input_tokens,
      COALESCE(SUM(output_tokens),0) as output_tokens,
      COALESCE(SUM(cache_read_tokens),0) as cache_read_tokens,
      COALESCE(SUM(cache_write_tokens),0) as cache_write_tokens,
      COALESCE(SUM(reasoning_tokens),0) as reasoning_tokens,
      COUNT(DISTINCT session_id) as sessions
    FROM ${TABLE}
    ${whereClause}
    GROUP BY model
    ORDER BY COALESCE(SUM(input_tokens),0) + COALESCE(SUM(output_tokens),0) DESC
  `).all(...params) as unknown as UsageStatsModelRow[]

  const byAgent = db.prepare(`
    SELECT agent,
      COALESCE(SUM(input_tokens),0) as input_tokens,
      COALESCE(SUM(output_tokens),0) as output_tokens,
      COALESCE(SUM(cache_read_tokens),0) as cache_read_tokens,
      COALESCE(SUM(cache_write_tokens),0) as cache_write_tokens,
      COALESCE(SUM(reasoning_tokens),0) as reasoning_tokens,
      COUNT(DISTINCT session_id) as sessions
    FROM ${TABLE}
    ${whereClause}
    GROUP BY agent
    ORDER BY COALESCE(SUM(input_tokens),0) + COALESCE(SUM(output_tokens),0) DESC
  `).all(...params) as unknown as UsageStatsAgentRow[]

  const byDay = db.prepare(`
    SELECT DATE(created_at / 1000, 'unixepoch') as date,
      COALESCE(SUM(input_tokens),0) as input_tokens,
      COALESCE(SUM(output_tokens),0) as output_tokens,
      COALESCE(SUM(cache_read_tokens),0) as cache_read_tokens,
      COALESCE(SUM(cache_write_tokens),0) as cache_write_tokens,
      COUNT(DISTINCT session_id) as sessions
    FROM ${TABLE}
    ${whereClause}
    GROUP BY date
    ORDER BY date
  `).all(...params) as Array<{ date: string; input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number; sessions: number }>

  return {
    input_tokens: totals.input_tokens,
    output_tokens: totals.output_tokens,
    cache_read_tokens: totals.cache_read_tokens,
    cache_write_tokens: totals.cache_write_tokens,
    reasoning_tokens: totals.reasoning_tokens,
    sessions: totals.sessions,
    by_model: byModel,
    by_agent: byAgent,
    by_day: byDay.map(d => ({ ...d, errors: 0, cost: 0 })),
    cost: 0,
    total_api_calls: totals.total_api_calls,
  }
}
