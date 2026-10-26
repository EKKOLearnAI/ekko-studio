import { expect, test } from '@playwright/test'
import { authenticate, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

for (const width of [390, 1280]) {
  test(`separates internal and external usage at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 1000 })
    await authenticate(page, TEST_ACCESS_KEY)
    await mockHermesApi(page)
    const requests: URLSearchParams[] = []
    let externalState: 'data' | 'empty' | 'error' = 'data'
    await page.route('**/api/studio/usage/stats?*', route => {
      const params = new URL(route.request().url()).searchParams
      requests.push(params)
      const origin = params.get('origin') || 'internal'
      const external = origin === 'external'
      if (external && externalState === 'error') return route.fulfill({ status: 502, json: { error: 'unavailable' } })
      const count = external && externalState === 'empty' ? 0 : 1
      const tokens = { input_tokens: 100 * count, output_tokens: 20 * count, cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0, sessions: external ? 0 : 1 }
      return route.fulfill({ json: {
        origin, total_input_tokens: tokens.input_tokens, total_output_tokens: tokens.output_tokens,
        total_cache_read_tokens: 0, total_cache_write_tokens: 0, total_reasoning_tokens: 0,
        total_sessions: tokens.sessions, total_api_calls: count, total_cost: 0.02 * count,
        cost_coverage: { reported: count, estimated: 0, unknown: 0 },
        filter_options: { accounts: [{ id: '7', username: 'tester' }], models: ['model-a'], agents: [external ? 'model_api' : 'codex'] },
        model_usage: count ? [{ model: 'model-a', ...tokens }] : [], agent_usage: external ? [] : [{ agent: 'qwen', ...tokens }, { agent: 'ekko_agent', ...tokens, input_tokens: 0, output_tokens: 0 }, { agent: 'future-cli', ...tokens, input_tokens: 0, output_tokens: 0 }],
        daily_usage: count ? [{ date: new Date().toISOString().slice(0, 10), ...tokens, cost: 0.02, errors: 0, cost_coverage: { reported: 1, estimated: 0, unknown: 0 } }] : [],
      } })
    })
    await page.goto('/#/hermes/usage')
    await expect(page.locator('[data-usage-origin="internal"]')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('.stat-hero .stat-value')).toHaveText('120')
    await expect(page.locator('.stat-card').nth(2).locator('.stat-label')).toHaveText('Total Sessions')
    const agents = page.getByTestId('agent-usage')
    await expect(agents.locator('.agent-name')).toHaveText(['Qwen Code', 'Ekko', 'future-cli'])
    await expect(agents.locator('[data-agent="qwen"] .agent-details')).toContainText('Input 100')
    await expect(agents.locator('[data-agent="qwen"] .agent-details')).toContainText('Sessions 1')
    await agents.scrollIntoViewIfNeeded()
    await expect(page.locator('.page-loading-overlay')).toBeHidden()
    await page.screenshot({ path: info.outputPath(`agents-${width}.png`), fullPage: true, animations: 'disabled' })
    expect(await agents.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
    await page.locator('[data-usage-origin="external"]').click()
    await expect(page.locator('.usage-content')).toHaveAttribute('aria-busy', 'false')
    await expect(agents).toHaveCount(0)
    expect(requests.at(-1)?.get('origin')).toBe('external')
    // The same physical call appears in either category, never as a combined 240 tokens.
    await expect(page.locator('.stat-hero .stat-value')).toHaveText('120')
    await expect(page.locator('.stat-card').nth(2).locator('.stat-value')).toHaveText('1')
    await expect(page.locator('.stat-card').nth(2).locator('.stat-label')).toHaveText('API calls')
    await expect(page.getByText('External usage is attributed to the authenticated Studio user making the API request.', { exact: true })).toBeVisible()
    await page.locator('.period-option').filter({ hasText: /^7d$/ }).click()
    await expect.poll(() => requests.at(-1)?.get('days')).toBe('7')
    expect(requests.at(-1)?.get('origin')).toBe('external')
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    await expect(page.locator('.usage-content')).toHaveAttribute('aria-busy', 'false')
    expect(requests.at(-1)?.get('origin')).toBe('external')
    await expect(page.locator('.page-loading-overlay')).toBeHidden()
    await page.screenshot({ path: info.outputPath(`external-${width}.png`), fullPage: true, animations: 'disabled' })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    externalState = 'error'
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    await expect(page.locator('.usage-empty[role="alert"]')).toBeVisible()
    await expect(page.locator('.stat-hero')).toHaveCount(0)
    externalState = 'empty'
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    await expect(page.locator('.usage-empty')).toBeVisible()
    await expect(page.locator('[data-usage-origin="internal"]')).toBeVisible()
    await page.locator('[data-usage-origin="internal"]').click()
    await expect(page.locator('.stat-hero .stat-value')).toHaveText('120')
    await expect(agents.locator('[data-agent="qwen"]')).toBeVisible()
    expect(requests.at(-1)?.get('origin')).toBe('internal')
  })
}

for (const brightness of ['light', 'dark']) {
  test(`Agent usage follows card theme and preset reset in ${brightness} mode`, async ({ page }, info) => {
    await authenticate(page, TEST_ACCESS_KEY)
    await mockHermesApi(page, { theme: { brightness, background: { name: 'wall.png', mime: 'image/png', updatedAt: 1 }, appearance: {
      global: { opacity: 0.4 }, regions: { card: { backgroundColor: '#6286a8', opacity: 0, blur: 12, radius: 18 } },
    } } })
    const row = { input_tokens: 100, output_tokens: 20, cache_read_tokens: 30, cache_write_tokens: 10, reasoning_tokens: 0, sessions: 1 }
    await page.route('**/api/studio/usage/stats?*', route => route.fulfill({ json: {
      origin: 'internal', total_input_tokens: 100, total_output_tokens: 20, total_cache_read_tokens: 30, total_sessions: 1, total_cost: 0,
      model_usage: [{ model: 'm', ...row }], agent_usage: [{ agent: 'qwen', ...row }], daily_usage: [],
    } }))
    await page.goto('/#/hermes/usage')
    const card = page.getByTestId('agent-usage')
    await expect(card).toHaveCSS('background-color', 'rgba(98, 134, 168, 0)')
    await expect(card).toHaveCSS('backdrop-filter', 'blur(12px) saturate(1.1)')
    await expect(card).toHaveCSS('border-radius', '18px')
    await expect(card).toHaveCSS('opacity', '1')
    await expect(card.locator('.agent-name')).toHaveText('Qwen Code')
    await card.scrollIntoViewIfNeeded()
    await expect(page.locator('.page-loading-overlay')).toBeHidden()
    await page.screenshot({ path: info.outputPath(`agents-${brightness}-wallpaper.png`), fullPage: true, animations: 'disabled' })
    await page.route('**/api/theme', route => route.fulfill({ json: { brightness, background: null, appearance: { global: {}, regions: {} } } }))
    await page.reload()
    await expect(card).not.toHaveCSS('background-color', 'rgba(98, 134, 168, 0)')
    await expect(card).toHaveCSS('backdrop-filter', 'none')
    await card.scrollIntoViewIfNeeded()
    await expect(page.locator('.page-loading-overlay')).toBeHidden()
    await page.screenshot({ path: info.outputPath(`agents-${brightness}-preset.png`), fullPage: true, animations: 'disabled' })
  })
}
