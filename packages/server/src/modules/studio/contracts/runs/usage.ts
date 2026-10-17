export interface UsageCostCoverage {
  reported: number
  estimated: number
  unknown: number
}

/** Legacy CLI imports may contain gateway identities in user_id. */
export function studioSessionAccount(session: { studio_user_id?: unknown; user_id?: unknown; source?: string }): string | undefined {
  const explicit = String(session.studio_user_id ?? '').trim()
  if (/^[1-9]\d*$/.test(explicit)) return explicit
  const studioSources = ['api_server', 'coding_agent', 'builtin_agent', 'group_chat', 'workflow', 'global_agent']
  const legacy = String(session.user_id ?? '').trim()
  return studioSources.includes(session.source || '') && /^[1-9]\d*$/.test(legacy) ? legacy : undefined
}

export interface UsageStatsFilters {
  model?: string
  agent?: string
  account?: string
  // Internal, Profile-scoped Studio ownership for native history and legacy ledger rows.
  sessionAccounts?: Record<string, string>
  // Computed by the controller for a calendar-day request in the browser's timezone.
  today?: { startMs: number; endMs: number; date: string }
}

export interface UsageFilterOptions {
  models: string[]
  agents: string[]
}

export interface UsageStatsModelRow {
  model: string
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  reasoning_tokens: number
  sessions: number
}

export interface UsageStatsAgentRow {
  agent: string
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  reasoning_tokens: number
  sessions: number
}

export interface UsageStatsDailyRow {
  date: string
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  sessions: number
  errors: number
  cost: number
  cost_coverage?: UsageCostCoverage
}

export interface LocalUsageStats {
  filter_options?: UsageFilterOptions
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  reasoning_tokens: number
  sessions: number
  by_model: UsageStatsModelRow[]
  by_agent: UsageStatsAgentRow[]
  by_day: UsageStatsDailyRow[]
  cost: number
  cost_coverage?: UsageCostCoverage
  total_api_calls: number
}
