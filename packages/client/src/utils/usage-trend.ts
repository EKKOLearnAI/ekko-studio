import type { UsageCostCoverage } from './usage-cost'

export type UsageTrendGranularity = 'day' | 'week' | 'month'

interface UsageTrendDay {
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

export interface UsageTrendBucket extends UsageTrendDay {
  endDate: string
}

export function buildUsageTrend(days: readonly UsageTrendDay[], periodDays = days.length) {
  const granularity: UsageTrendGranularity = periodDays > 180 ? 'month' : periodDays > 31 ? 'week' : 'day'
  const groups = new Map<string, { bucket: UsageTrendBucket; uncoveredDays: number }>()
  for (const day of [...days].sort((a, b) => a.date.localeCompare(b.date))) {
    let key = day.date
    if (granularity === 'month') key = day.date.slice(0, 7)
    if (granularity === 'week') {
      // Daily keys are calendar dates; UTC arithmetic avoids browser timezone/DST shifts.
      const monday = new Date(`${day.date}T00:00:00Z`)
      monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7)
      key = monday.toISOString().slice(0, 10)
    }
    let group = groups.get(key)
    if (!group) {
      group = { bucket: { date: day.date, endDate: day.date, input_tokens: 0, output_tokens: 0,
        cache_read_tokens: 0, cache_write_tokens: 0, sessions: 0, errors: 0, cost: 0 }, uncoveredDays: 0 }
      groups.set(key, group)
    }
    const bucket = group.bucket
    bucket.endDate = day.date
    bucket.input_tokens += day.input_tokens
    bucket.output_tokens += day.output_tokens
    bucket.cache_read_tokens += day.cache_read_tokens
    bucket.cache_write_tokens += day.cache_write_tokens
    bucket.sessions += day.sessions
    bucket.errors += day.errors
    bucket.cost += day.cost
    if (day.cost_coverage) {
      bucket.cost_coverage ??= { reported: 0, estimated: 0, unknown: 0 }
      bucket.cost_coverage.reported += day.cost_coverage.reported
      bucket.cost_coverage.estimated += day.cost_coverage.estimated
      bucket.cost_coverage.unknown += day.cost_coverage.unknown
    } else if (day.sessions > 0 || day.input_tokens + day.output_tokens + day.cache_read_tokens + day.cache_write_tokens > 0 || day.cost > 0) {
      group.uncoveredDays += 1
    }
  }
  const buckets = [...groups.values()].map(({ bucket, uncoveredDays }) => {
    if (bucket.cost_coverage) bucket.cost_coverage.unknown += uncoveredDays
    return bucket
  })
  return { granularity, buckets }
}
