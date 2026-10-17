import { expect, test } from '@playwright/test'
import { authenticate, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

for (const width of [320, 390, 1280]) {
  test(`keeps 365-day and 90-day usage trends readable at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: width < 480 ? 1700 : 1300 })
    await authenticate(page, TEST_ACCESS_KEY)
    await page.addInitScript(() => localStorage.setItem('hermes_locale', 'zh'))
    await mockHermesApi(page)
    await page.route('**/api/studio/usage/stats?*', route => {
      const days = Number(new URL(route.request().url()).searchParams.get('days'))
      const lastDay = Date.parse('2026-10-11T00:00:00Z')
      const daily = Array.from({ length: days }, (_, index) => ({
        date: new Date(lastDay - (days - index - 1) * 86_400_000).toISOString().slice(0, 10),
        input_tokens: 1000 + index, output_tokens: 200, cache_read_tokens: 1500,
        cache_write_tokens: 0, sessions: 1, errors: 0, cost: 0.01,
        cost_coverage: { reported: 1, estimated: 0, unknown: 0 },
      }))
      const input = daily.reduce((sum, day) => sum + day.input_tokens, 0)
      return route.fulfill({ json: {
        period_days: days, total_input_tokens: input, total_output_tokens: days * 200,
        total_cache_read_tokens: days * 1500, total_cache_write_tokens: 0, total_reasoning_tokens: 0,
        total_sessions: days, total_api_calls: days, total_cost: days * 0.01,
        cost_coverage: { reported: days, estimated: 0, unknown: 0 },
        model_usage: [{ model: 'model-a', input_tokens: input, output_tokens: days * 200,
          cache_read_tokens: days * 1500, cache_write_tokens: 0, reasoning_tokens: 0, sessions: days }],
        agent_usage: [], daily_usage: daily,
      } })
    })
    await page.goto('/#/hermes/usage')
    const chart = page.locator('.daily-trend')
    const bars = chart.locator('.bar-col')
    await expect(chart).toHaveAttribute('data-granularity', 'day')
    await expect(bars).toHaveCount(30)
    await expect(page.locator('.page-loading-overlay')).toHaveCount(0)
    await page.locator('.period-option').filter({ hasText: /^365 天$/ }).click()
    await expect(chart).toHaveAttribute('data-granularity', 'month')
    await expect(chart.locator('.section-title')).toHaveText('每月用量')
    await expect(chart.locator('.chart-caption')).toContainText('按月合计')
    await expect(bars).toHaveCount(13)
    await expect(bars.first()).toHaveAttribute('aria-label', '2025-10-12 – 2025-10-31: 24.2K')
    await expect(page.locator('.stat-hero .stat-value')).toHaveText('504.4K')
    const geometry = await bars.evaluateAll(elements => ({
      minWidth: Math.min(...elements.map(element => element.getBoundingClientRect().width)),
      overflowing: elements.some(element => element.scrollWidth > element.clientWidth + 1),
      pageFits: document.documentElement.scrollWidth <= innerWidth,
    }))
    expect(geometry.minWidth).toBeGreaterThan(8)
    expect(geometry.overflowing).toBe(false)
    expect(geometry.pageFits).toBe(true)
    await expect(chart.locator('.bar-segment.input').first()).toHaveCSS('background-color', 'rgb(92, 107, 192)')
    await expect(chart.locator('.bar-segment.output').first()).toHaveCSS('background-color', 'rgb(38, 166, 154)')
    await chart.screenshot({ path: info.outputPath(`usage-year-${width}.png`), animations: 'disabled' })
    await bars.first().focus()
    await expect(bars.first().locator('.bar-tooltip')).toContainText('2025-10-12 – 2025-10-31')
    if (width < 480) {
      const tooltipFits = await bars.first().locator('.bar-tooltip').evaluate(element => {
        const bounds = element.getBoundingClientRect()
        return bounds.left >= 0 && bounds.right <= innerWidth
      })
      expect(tooltipFits).toBe(true)
    }
    await chart.locator('[data-metric="cache"]').click()
    await expect(chart.locator('.bar-segment.cache')).toHaveCount(13)
    await expect(bars.first()).toHaveAttribute('aria-label', '2025-10-12 – 2025-10-31: 30.0K')
    await chart.locator('[data-metric="cost"]').click()
    await expect(chart.locator('.bar-segment.cost')).toHaveCount(13)
    await expect(bars.first()).toHaveAttribute('aria-label', /2025-10-12 – 2025-10-31: \$0\.20/)
    await chart.locator('.daily-details summary').click()
    await expect(chart.locator('tbody tr')).toHaveCount(365)
    await expect(chart.locator('tbody tr').first()).toContainText('2026-10-11')
    await expect(chart.locator('tbody tr').last()).toContainText('2025-10-12')
    await chart.locator('.daily-details summary').click()
    await page.locator('.period-option').filter({ hasText: /^90 天$/ }).click()
    await expect(chart).toHaveAttribute('data-granularity', 'week')
    await expect(chart.locator('.section-title')).toHaveText('每周用量')
    expect(await bars.count()).toBeLessThanOrEqual(14)
    expect(await bars.count()).toBeGreaterThanOrEqual(13)
    await chart.locator('[data-metric="tokens"]').click()
    await chart.screenshot({ path: info.outputPath(`usage-quarter-${width}.png`), animations: 'disabled' })
    await page.locator('.period-option').filter({ hasText: /^7 天$/ }).click()
    await expect(chart).toHaveAttribute('data-granularity', 'day')
    await expect(chart.locator('.section-title')).toHaveText('每日用量')
    await expect(bars).toHaveCount(7)
  })
}
