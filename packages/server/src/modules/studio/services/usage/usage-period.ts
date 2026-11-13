import type { UsageStatsFilters } from '../../contracts/runs/usage'

export function getTodayUsageWindow(timeZone: string, now = Date.now()): NonNullable<UsageStatsFilters['today']> {
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
  const dateAt = (timestamp: number) => {
    const parts = formatter.formatToParts(timestamp)
    const value = (type: string) => parts.find(part => part.type === type)!.value
    return `${value('year')}-${value('month')}-${value('day')}`
  }
  const date = dateAt(now)
  // Find the first instant of this local date, including days with DST transitions.
  let before = now - 48 * 60 * 60 * 1000
  let start = now
  while (start - before > 1) {
    const middle = Math.floor((before + start) / 2)
    if (dateAt(middle) < date) before = middle
    else start = middle
  }
  return { startMs: start, endMs: now, date }
}
