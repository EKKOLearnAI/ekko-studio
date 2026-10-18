import { describe, expect, it } from 'vitest'
import { getTodayUsageWindow } from '../../packages/server/src/modules/studio/services/usage/usage-period'

describe('today usage window', () => {
  it.each([
    ['Asia/Shanghai', '2026-10-10T20:00:00Z', '2026-10-10T16:00:00Z', '2026-10-11'],
    ['America/Los_Angeles', '2026-10-11T02:00:00Z', '2026-10-10T07:00:00Z', '2026-10-10'],
    ['America/New_York', '2026-03-08T18:00:00Z', '2026-03-08T05:00:00Z', '2026-03-08'],
    ['America/New_York', '2026-11-01T18:00:00Z', '2026-11-01T04:00:00Z', '2026-11-01'],
  ])('uses the local calendar day in %s at %s', (zone, now, start, date) => {
    expect(getTodayUsageWindow(zone, Date.parse(now))).toEqual({ startMs: Date.parse(start), endMs: Date.parse(now), date })
  })

  it('rejects an invalid timezone', () => {
    expect(() => getTodayUsageWindow('invalid-zone')).toThrow()
  })
})
