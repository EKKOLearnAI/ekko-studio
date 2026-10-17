import type { LocalUsageStats, UsageStatsFilters, UsageStatsModelRow, UsageStatsAgentRow, UsageStatsDailyRow } from '../../contracts/runs/usage'
import { getLocalUsageStats, getRecordedUsageSessionIds, getUnpricedHermesUsageSessions, getSessionUsageAccounts, getUsageAccountOptions } from '../../public/sessions'
import { getHermesUsageStats } from '../../public/session-agent-runtime'
import { logger } from '../../public/logging'
import { applyHermesCostFallbacks } from './hermes-cost-fallback'
import { emptyCostCoverage, addCostCoverage } from './usage-cost'

export async function getAggregatedUsageStats(profiles: string[], days: number, selection: UsageStatsFilters) {
  const ledgers: LocalUsageStats[] = []
  for (const profile of profiles) {
    const profileSelection = selection.account ? { ...selection, sessionAccounts: getSessionUsageAccounts(profile) } : selection
    const local = getLocalUsageStats(profile, days, profileSelection)
    const localSessionIds = getRecordedUsageSessionIds(profile)
    const unpriced = getUnpricedHermesUsageSessions(profile, days, profileSelection)
    ledgers.push(local)
    try {
      // Each Profile owns a separate history DB; exclusions and bills stay within that Profile.
      const hermes = await getHermesUsageStats(days, undefined, profile, localSessionIds, unpriced.map(row => row.sessionId), profileSelection)
      applyHermesCostFallbacks(local, unpriced, hermes.cost_fallbacks)
      ledgers.push(hermes)
    } catch (err) {
      logger.warn({ err, profile }, 'usageStats: failed to load Hermes usage analytics from state.db')
    }
  }
  const sum = (field: 'input_tokens' | 'output_tokens' | 'cache_read_tokens' | 'cache_write_tokens' | 'reasoning_tokens' | 'sessions' | 'cost' | 'total_api_calls') =>
    ledgers.reduce((total, ledger) => total + (ledger[field] || 0), 0)

  const modelMap = new Map<string, UsageStatsModelRow>()
  for (const row of ledgers.flatMap(ledger => ledger.by_model)) {
    const model = row.model.trim()
    const current = modelMap.get(model) || {
      model,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      sessions: 0,
    }
    current.input_tokens += row.input_tokens
    current.output_tokens += row.output_tokens
    current.cache_read_tokens += row.cache_read_tokens
    current.cache_write_tokens += row.cache_write_tokens
    current.reasoning_tokens += row.reasoning_tokens
    current.sessions += row.sessions
    modelMap.set(model, current)
  }

  const agentMap = new Map<string, UsageStatsAgentRow>()
  for (const row of ledgers.flatMap(ledger => ledger.by_agent || [])) {
    const agent = row.agent.trim() || 'unknown'
    const current = agentMap.get(agent) || {
      agent,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      sessions: 0,
    }
    current.input_tokens += row.input_tokens
    current.output_tokens += row.output_tokens
    current.cache_read_tokens += row.cache_read_tokens
    current.cache_write_tokens += row.cache_write_tokens
    current.reasoning_tokens += row.reasoning_tokens
    current.sessions += row.sessions
    agentMap.set(agent, current)
  }

  const dayMap = new Map<string, UsageStatsDailyRow>()
  const now = new Date()
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now)
    d.setDate(d.getDate() - i)
    const key = selection.today?.date || d.toISOString().slice(0, 10)
    dayMap.set(key, { date: key, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, sessions: 0, errors: 0, cost: 0, cost_coverage: emptyCostCoverage() })
  }
  for (const d of ledgers.flatMap(ledger => ledger.by_day)) {
    // Rolling windows can include part of the preceding UTC day as well.
    const existing = dayMap.get(d.date) || { date: d.date, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, sessions: 0, errors: 0, cost: 0, cost_coverage: emptyCostCoverage() }
    existing.input_tokens += d.input_tokens; existing.output_tokens += d.output_tokens
    existing.cache_read_tokens += d.cache_read_tokens; existing.cache_write_tokens += d.cache_write_tokens
    existing.sessions += d.sessions; existing.errors += d.errors; existing.cost += d.cost
    addCostCoverage(existing.cost_coverage!, d.cost_coverage)
    dayMap.set(d.date, existing)
  }

  const costCoverage = emptyCostCoverage()
  for (const ledger of ledgers) addCostCoverage(costCoverage, ledger.cost_coverage)
  return {
    total_input_tokens: sum('input_tokens'),
    total_output_tokens: sum('output_tokens'),
    total_cache_read_tokens: sum('cache_read_tokens'),
    total_cache_write_tokens: sum('cache_write_tokens'),
    total_reasoning_tokens: sum('reasoning_tokens'),
    total_sessions: sum('sessions'),
    total_cost: sum('cost'),
    cost_coverage: costCoverage,
    total_api_calls: sum('total_api_calls'),
    period_days: days,
    account_attribution_available: true,
    filter_options: {
      accounts: getUsageAccountOptions(profiles),
      models: [...new Set(ledgers.flatMap(ledger => ledger.filter_options?.models || []))].sort(),
      agents: [...new Set(ledgers.flatMap(ledger => ledger.filter_options?.agents || []))].sort(),
    },
    model_usage: [...modelMap.values()].sort((a, b) => (b.input_tokens + b.output_tokens) - (a.input_tokens + a.output_tokens)),
    agent_usage: [...agentMap.values()].sort((a, b) => (b.input_tokens + b.output_tokens) - (a.input_tokens + a.output_tokens)),
    daily_usage: [...dayMap.values()].sort((a, b) => a.date.localeCompare(b.date)),
  }
}
