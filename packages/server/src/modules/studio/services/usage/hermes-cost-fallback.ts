import type { LocalUsageStats } from '../../contracts/runs/usage'
import { emptyCostCoverage } from './usage-cost'

export function applyHermesCostFallbacks(
  local: LocalUsageStats,
  candidates: Array<{ sessionId: string; days: Array<{ date: string; entries: number }> }>,
  fallbacks: Array<{ session_id: string; date: string; cost: number; source: 'reported' | 'estimated' }> = [],
): void {
  const remaining = new Map(candidates.map(row => [row.sessionId, row]))
  for (const fallback of fallbacks) {
    const candidate = remaining.get(fallback.session_id)
    if (!candidate || !Number.isFinite(fallback.cost) || fallback.cost < 0) continue
    remaining.delete(fallback.session_id)
    local.cost += fallback.cost
    local.cost_coverage ??= emptyCostCoverage()
    local.cost_coverage.unknown = Math.max(0, local.cost_coverage.unknown - candidate.days.reduce((sum, day) => sum + day.entries, 0))
    local.cost_coverage[fallback.source]++
    let day = local.by_day.find(row => row.date === fallback.date)
    if (!day) {
      day = { date: fallback.date, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, sessions: 0, errors: 0, cost: 0 }
      local.by_day.push(day)
    }
    day.cost += fallback.cost
    day.cost_coverage ??= emptyCostCoverage()
    day.cost_coverage[fallback.source]++
    // A session-level bill cannot identify each day's charge in a multi-day session.
    if (candidate.days.length === 1 && candidate.days[0].date === fallback.date) {
      day.cost_coverage.unknown = Math.max(0, day.cost_coverage.unknown - candidate.days[0].entries)
    }
  }
}
