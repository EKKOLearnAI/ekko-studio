import { expect, test } from '@playwright/test'
import { authenticate, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'
import zh from '../../packages/client/src/i18n/locales/zh'
import en from '../../packages/client/src/i18n/locales/en'
import fr from '../../packages/client/src/i18n/locales/fr'
import ar from '../../packages/client/src/i18n/locales/ar'

const cases = [
  { locale: 'zh', width: 320, messages: zh },
  { locale: 'zh', width: 390, messages: zh },
  { locale: 'en', width: 375, messages: en },
  { locale: 'fr', width: 390, messages: fr },
  { locale: 'ar', width: 390, messages: ar },
  { locale: 'ar', width: 320, messages: ar },
] as const

for (const { locale, width, messages } of cases) {
  test(`localizes usage and keeps mobile values intact in ${locale} at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 1750 })
    await authenticate(page, TEST_ACCESS_KEY)
    await page.addInitScript(value => localStorage.setItem('hermes_locale', value), locale)
    await mockHermesApi(page)
    const tokens = { input_tokens: 1_234_567, output_tokens: 7_654_321, cache_read_tokens: 55_555_555,
      cache_write_tokens: 0, reasoning_tokens: 0, sessions: 1352 }
    await page.route('**/api/studio/usage/stats?*', route => route.fulfill({ json: {
      total_input_tokens: tokens.input_tokens, total_output_tokens: tokens.output_tokens,
      total_cache_read_tokens: tokens.cache_read_tokens, total_cache_write_tokens: 0, total_reasoning_tokens: 0,
      total_sessions: tokens.sessions, total_api_calls: 5678, total_cost: 1234.56,
      cost_coverage: { reported: 1, estimated: 0, unknown: 0 },
      filter_options: { accounts: [{ id: '1', username: 'admin' }], models: ['model-a'], agents: ['codex'] },
      model_usage: [{ model: 'model-a', ...tokens }], agent_usage: [],
      daily_usage: [{ date: '2026-10-11', ...tokens, errors: 0, cost: 1234.56,
        cost_coverage: { reported: 1, estimated: 0, unknown: 0 } }],
    } }))
    await page.goto('/#/hermes/usage')
    await expect(page.locator('.header-title')).toHaveText(messages.usage.title)
    await expect(page.locator('.stat-hero .stat-label')).toHaveText(messages.usage.dashboard.inputOutput)
    await expect(page.locator('.stat-unit')).toHaveText(messages.usage.tokens)
    await expect(page.locator('.profile-filter')).toContainText(messages.usage.dashboard.allProfiles)
    await expect(page.locator('.token-split')).toContainText(messages.usage.inputTokens)
    await expect(page.locator('.token-split')).toContainText(messages.usage.outputTokens)
    await expect(page.locator('.usage-content')).not.toContainText('usage.dashboard.')
    await expect(page.locator('.page-loading-overlay')).toHaveCount(0)
    if (locale === 'fr') {
      await expect(page.locator('.stat-hero .stat-value')).toHaveText('8,89M')
      await expect(page.locator('.stat-card').nth(1).locator('.stat-value')).toContainText('1 234,56')
      await expect(page.locator('.stat-card').nth(2).locator('.stat-value')).toHaveText('1 352')
      await expect(page.locator('.stat-card').nth(3).locator('.stat-value')).toHaveText('97,8 %')
      await expect(page.locator('.rank-share')).toHaveText('100,0 %')
      await expect(page.locator('.cache-caption')).toContainText('Jetons')
      await expect(page.locator('.stat-unit')).not.toHaveText('Token')
    }
    const layout = await page.locator('.stat-cards').evaluate(element => {
      const main = element.querySelector('.stat-main')!
      const value = main.querySelector('.stat-value')!
      const unit = main.querySelector('.stat-unit')!
      const singleLine = (node: Element) => {
        const range = document.createRange()
        range.selectNodeContents(node)
        return new Set([...range.getClientRects()].filter(rect => rect.width > 0).map(rect => Math.round(rect.top))).size <= 1
      }
      return { font: parseFloat(getComputedStyle(value).fontSize),
        mainFits: main.scrollWidth <= main.clientWidth + 1,
        sameLine: Math.abs(value.getBoundingClientRect().bottom - unit.getBoundingClientRect().bottom) < 6,
        singleValues: [...element.querySelectorAll('.stat-value')].every(singleLine),
        overflowingValues: [...element.querySelectorAll('.stat-value')]
          .filter(node => node.scrollWidth > node.clientWidth + 1)
          .map(node => ({ text: node.textContent, width: node.clientWidth, scrollWidth: node.scrollWidth })),
        splitGroups: [...element.querySelectorAll('.token-split > span')].every(singleLine),
        pageFits: document.documentElement.scrollWidth <= innerWidth }
    })
    expect(layout.font).toBeGreaterThanOrEqual(24)
    expect(layout.font).toBeLessThanOrEqual(28)
    expect(layout.mainFits).toBe(true)
    expect(layout.sameLine).toBe(true)
    expect(layout.singleValues).toBe(true)
    expect(layout.overflowingValues).toEqual([])
    expect(layout.splitGroups).toBe(true)
    expect(layout.pageFits).toBe(true)
    const ringLabelFits = await page.locator('.cache-ring').evaluate(element => {
      const circle = element.getBoundingClientRect()
      const label = element.querySelector('small')!.getBoundingClientRect()
      return label.left >= circle.left && label.right <= circle.right && label.top >= circle.top && label.bottom <= circle.bottom
    })
    expect(ringLabelFits).toBe(true)
    const chartLabelsFit = () => page.locator('.daily-trend').evaluate(element => {
      const card = element.getBoundingClientRect()
      return [...element.querySelectorAll('.chart-grid span')].every(label => {
        const bounds = label.getBoundingClientRect()
        return bounds.left >= card.left && bounds.right <= card.right
      })
    })
    expect(await chartLabelsFit()).toBe(true)
    await page.screenshot({ path: info.outputPath(`usage-mobile-${locale}-${width}.png`), fullPage: true, animations: 'disabled' })
    await page.locator('[data-metric="cost"]').click()
    expect(await chartLabelsFit()).toBe(true)
  })
}
