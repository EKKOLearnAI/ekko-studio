import { expect, it } from 'vitest'
import { nextWorkflowScheduleAt } from '../../packages/server/src/modules/studio/services/workflow/schedule'

it.each([
  ['0 0 29 2 *', 'UTC', '2028-02-29T00:00Z', '2032-02-29T00:00Z'],
  ['0 0 29 2 1', 'UTC', '2016-02-29T00:00Z', '2044-02-29T00:00Z'],
  ['30 2 * * *', 'America/New_York', '2026-03-08T05:00Z', '2026-03-09T06:30Z'],
  ['30 1 * * *', 'America/New_York', '2026-11-01T05:30Z', '2026-11-01T06:30Z'],
  ['@monthly', 'Asia/Kathmandu', '2026-04-02T00:00Z', '2026-04-30T18:15Z'],
])('finds %s in %s after %s', (cron, zone, after, expected) => {
  expect(nextWorkflowScheduleAt(cron, zone, Date.parse(after))).toBe(Date.parse(expected))
})

it('rejects impossible dates', () => {
  expect(() => nextWorkflowScheduleAt('0 0 31 2 *', 'UTC', Date.now())).toThrow(/no possible/)
})
