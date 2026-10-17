import { expect, test, type Page } from '@playwright/test'
import { authenticate, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

const entries = [
  { profile: 'default', session: 's1', model: 'alpha-model', agent: 'codex', age: 0, input_tokens: 1000, output_tokens: 200, cache_read_tokens: 4000, cost: 0.02 },
  { profile: 'default', session: 's1', model: 'beta-model', agent: 'codex', age: 0, input_tokens: 300, output_tokens: 50, cache_read_tokens: 9000, cost: 0.003 },
  { profile: 'research', session: 's2', model: 'alpha-model', agent: 'hermes', age: 1, input_tokens: 700, output_tokens: 100, cache_read_tokens: 2000, cost: 0.01 },
  { profile: 'research', session: 's3', model: 'beta-model', agent: 'codex', age: 12, input_tokens: 100, output_tokens: 10, cache_read_tokens: 3000, cost: 0.002 },
]

test.use({ timezoneId: 'Asia/Shanghai' })

async function choose(page: Page, selector: string, label: string) {
  await page.locator(selector).click()
  await page.locator('.n-base-select-option').filter({ hasText: new RegExp(`^${label}$`) }).click()
  await expect(page.locator('.usage-content')).toHaveAttribute('aria-busy', 'false')
}

async function captureUsage(page: Page, path: string) {
  await expect(page.locator('.page-loading-overlay')).toHaveCount(0)
  await expect(page.locator('.overview-controls')).toBeVisible()
  await page.screenshot({ path, fullPage: true, animations: 'disabled' })
}

for (const width of [1280, 390]) {
  test(`filters the A overview by period and account at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 1700 : 1300 })
    await authenticate(page, TEST_ACCESS_KEY)
    await mockHermesApi(page)
    const requests: URLSearchParams[] = []
    await page.route('**/api/studio/usage/stats?*', route => {
      const params = new URL(route.request().url()).searchParams
      requests.push(params)
      const days = Number(params.get('days'))
      expect(route.request().headers()['x-hermes-profile']).toBeUndefined()
      const baseline = entries.filter(row => row.age < days && (!params.get('profile') || row.profile === params.get('profile')))
      const rows = baseline.filter(row => (!params.get('model') || row.model === params.get('model'))
        && (!params.get('agent') || row.agent === params.get('agent')))
      const sum = (field: 'input_tokens' | 'output_tokens' | 'cache_read_tokens' | 'cost') => rows.reduce((n, row) => n + row[field], 0)
      const group = (field: 'model' | 'agent') => [...new Set(rows.map(row => row[field]))].map(id => {
        const subset = rows.filter(row => row[field] === id)
        return { [field]: id, input_tokens: subset.reduce((n, row) => n + row.input_tokens, 0),
          output_tokens: subset.reduce((n, row) => n + row.output_tokens, 0),
          cache_read_tokens: subset.reduce((n, row) => n + row.cache_read_tokens, 0),
          cache_write_tokens: 0, reasoning_tokens: 0, sessions: new Set(subset.map(row => row.session)).size }
      })
      return route.fulfill({ json: {
        total_input_tokens: sum('input_tokens'), total_output_tokens: sum('output_tokens'), total_cache_read_tokens: sum('cache_read_tokens'),
        total_cache_write_tokens: 0, total_reasoning_tokens: 0, total_sessions: new Set(rows.map(row => row.session)).size,
        total_cost: sum('cost'), total_api_calls: rows.length, cost_coverage: { reported: rows.length, estimated: 0, unknown: 0 },
        account_attribution_available: true,
        filter_options: { models: [...new Set(baseline.map(row => row.model))], agents: [...new Set(baseline.map(row => row.agent))] },
        model_usage: group('model'), agent_usage: group('agent'),
        daily_usage: Array.from({ length: days }, (_, index) => days - index - 1).map(age => {
          const subset = rows.filter(row => row.age === age)
          return { date: new Date(Date.now() - age * 86_400_000).toISOString().slice(0, 10),
            input_tokens: subset.reduce((n, row) => n + row.input_tokens, 0), output_tokens: subset.reduce((n, row) => n + row.output_tokens, 0),
            cache_read_tokens: subset.reduce((n, row) => n + row.cache_read_tokens, 0), cache_write_tokens: 0,
            sessions: new Set(subset.map(row => row.session)).size, errors: 0, cost: subset.reduce((n, row) => n + row.cost, 0),
            cost_coverage: { reported: subset.length, estimated: 0, unknown: 0 } }
        }),
      } })
    })
    await page.goto('/#/hermes/usage')
    await expect(page.locator('.stat-hero .stat-value')).toHaveText('2.5K')
    await expect(page.getByText('Usage is grouped by the Studio user who owns the session. Records without an owner remain unassigned.', { exact: true })).toBeVisible()
    await expect(page.locator('.bar-segment.cache')).toHaveCount(0)
    await expect(page.locator('.bar-segment.input').first()).toHaveCSS('background-color', 'rgb(92, 107, 192)')
    await expect(page.locator('.bar-segment.output').first()).toHaveCSS('background-color', 'rgb(38, 166, 154)')
    await expect(page.locator('[data-metric="tokens"]')).toHaveClass(/n-button--secondary/)
    await expect(page.locator('.period-option[aria-pressed="true"]')).toHaveClass(/n-button--secondary/)
    await expect(page.locator('[data-metric="cache"]')).not.toHaveClass(/n-button--secondary/)
    await expect(page.locator('[data-metric="cache"]')).toHaveAttribute('aria-pressed', 'false')
    await page.locator('[data-metric="cache"]').click()
    await expect(page.locator('.bar-segment.cache')).toHaveCount(3)
    await expect(page.locator('.bar-segment.cache').first()).toHaveCSS('background-color', 'rgb(246, 173, 85)')
    await page.locator('[data-metric="tokens"]').click()
    const names = page.locator('.ranking-panel .rank-name')
    await expect(names).toHaveText(['alpha-model', 'beta-model'])
    await expect(page.locator('[data-dimension]')).toHaveCount(0)
    await expect(page.locator('.model-filter, .agent-filter, .usage-breakdown')).toHaveCount(0)
    const layout = await page.locator('.overview-controls').evaluate(element => {
      const children = [...element.children]
      return { classes: children.map(child => child.className), tops: children.map(child => child.getBoundingClientRect().top),
        lefts: children.map(child => child.getBoundingClientRect().left) }
    })
    expect(layout.classes).toHaveLength(4)
    expect(layout.classes[0]).toContain('period-selector')
    expect(layout.classes[1]).toContain('account-filter')
    expect(layout.classes[2]).toContain('profile-filter')
    expect(layout.classes[3]).toContain('pricing-preset-button')
    expect(Math.max(...layout.tops) - Math.min(...layout.tops)).toBeLessThan(5)
    expect(layout.lefts[0]).toBeLessThan(layout.lefts[1])
    expect(layout.lefts[1]).toBeLessThan(layout.lefts[2])
    expect(layout.lefts[2]).toBeLessThan(layout.lefts[3])
    await expect(page.locator('.page-header .period-selector')).toHaveCount(0)
    expect(requests.at(-1)?.get('profile')).toBe('')
    await choose(page, '.profile-filter', 'default')
    await expect(page.locator('.stat-hero .stat-value')).toHaveText('1.6K')
    expect(requests.at(-1)?.get('profile')).toBe('default')
    await choose(page, '.profile-filter', 'research')
    await expect(page.locator('.stat-hero .stat-value')).toHaveText('910')
    await expect(page.locator('.overview-heading')).toContainText('research')
    expect(await page.evaluate(() => localStorage.getItem('hermes_active_profile_name'))).toBe('default')
    await choose(page, '.profile-filter', 'All Profiles')
    await expect(page.locator('.stat-hero .stat-value')).toHaveText('2.5K')
    await choose(page, '.account-filter', 'Unassigned account')
    await choose(page, '.profile-filter', 'default')
    await page.locator('.period-option').filter({ hasText: /^Today$/ }).click()
    await expect(page.locator('.stat-hero .stat-value')).toHaveText('1.6K')
    expect(requests.at(-1)?.get('days')).toBe('1')
    expect(requests.at(-1)?.get('period')).toBe('today')
    expect(requests.at(-1)?.get('time_zone')).toBe('Asia/Shanghai')
    expect(requests.at(-1)?.get('account')).toBe('unassigned')
    expect(requests.at(-1)?.get('profile')).toBe('default')
    await expect(page.locator('.overview-heading')).toContainText('Today · default')
    await expect(page.locator('.bar-col')).toHaveCount(1)
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    await expect(page.locator('.stat-hero .stat-value')).toHaveText('1.6K')
    expect(requests.at(-1)?.get('period')).toBe('today')
    expect(requests.at(-1)?.get('profile')).toBe('default')
    await choose(page, '.profile-filter', 'All Profiles')
    expect(requests.at(-1)?.get('account')).toBe('unassigned')
    await page.locator('.period-option').filter({ hasText: /^7d$/ }).click()
    await expect.poll(() => requests.at(-1)?.get('days')).toBe('7')
    expect(requests.at(-1)?.has('model')).toBe(false)
    expect(requests.at(-1)?.has('agent')).toBe(false)
    expect(requests.at(-1)?.get('account')).toBe('unassigned')
    expect(requests.at(-1)?.has('period')).toBe(false)
    await expect(page.locator('.stat-hero .stat-value')).toHaveText('2.4K')
    await expect(page.locator('.rank-share').first()).toHaveText('85.1%')
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    await expect(page.locator('.stat-hero .stat-value')).toHaveText('2.4K')
    expect(requests.at(-1)?.get('account')).toBe('unassigned')
    await choose(page, '.account-filter', 'All accounts')
    expect(requests.at(-1)?.has('model')).toBe(false)
    expect(requests.at(-1)?.has('agent')).toBe(false)
    expect(requests.at(-1)?.has('account')).toBe(false)
    await page.locator('.period-option').filter({ hasText: /^30d$/ }).click()
    await expect(page.locator('.stat-hero .stat-value')).toHaveText('2.5K')
    await page.keyboard.press('Escape')
    await page.locator('.overview-heading').click()
    await captureUsage(page, info.outputPath(`usage-${width}.png`))
    await page.evaluate(() => localStorage.setItem('hermes_locale', 'zh'))
    await page.reload()
    await expect(page.locator('.header-title')).toHaveText('用量统计')
    await expect(page.locator('.stat-hero .stat-value')).toHaveText('2.5K')
    await captureUsage(page, info.outputPath(`usage-zh-${width}.png`))
    await page.locator('.period-option').filter({ hasText: /^当天$/ }).click()
    await expect(page.locator('.stat-hero .stat-value')).toHaveText('1.6K')
    await expect(page.locator('.overview-heading')).toContainText('当天 · 全部配置')
    await page.locator('.overview-heading').click()
    await captureUsage(page, info.outputPath(`usage-today-${width}.png`))
    if (width === 1280) {
      for (const theme of ['dark', 'comic']) {
        await page.evaluate(value => { localStorage.setItem('hermes_brightness', value === 'dark' ? 'dark' : 'light'); localStorage.setItem('hermes_style', value === 'comic' ? 'comic' : 'ink') }, theme)
        await page.reload()
        await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${theme}\\b`))
        await expect(page.locator('.stat-hero .stat-value')).toHaveText('2.5K')
        await expect(page.locator('.bar-segment.input').first()).toHaveCSS('background-color', 'rgb(92, 107, 192)')
        await expect(page.locator('[data-metric="tokens"]')).toHaveClass(/n-button--secondary/)
        await page.locator('[data-metric="cache"]').click()
        await expect(page.locator('[data-metric="cache"]')).toHaveClass(/n-button--secondary/)
        await expect(page.locator('[data-metric="tokens"]')).not.toHaveClass(/n-button--secondary/)
        await expect(page.locator('[data-metric="tokens"]')).toHaveAttribute('aria-pressed', 'false')
        await page.locator('[data-metric="tokens"]').click()
        await captureUsage(page, info.outputPath(`usage-${theme}.png`))
      }
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  })
}

test('keeps filters usable and reports failure without showing previous results', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY)
  await mockHermesApi(page)
  await page.route('**/api/studio/usage/stats?*', route => route.fulfill({ status: 503, json: { error: 'offline' } }))
  await page.goto('/#/hermes/usage')
  await expect(page.getByRole('alert')).toHaveText('Unable to load usage. Try refreshing.')
  await expect(page.locator('.overview-controls')).toBeVisible()
  await expect(page.locator('.stat-cards')).toHaveCount(0)
})

test('lists real Studio accounts, refreshes newly created owners and intersects account with Profile and today', async ({ page }, info) => {
  await authenticate(page, TEST_ACCESS_KEY)
  await mockHermesApi(page)
  const requests: URLSearchParams[] = []
  let newAccount = false
  const ledger = entries.map(row => ({ ...row, account: row.session === 's1' ? '1' : row.session === 's2' ? '2' : 'unassigned' }))
  await page.route('**/api/studio/usage/stats?*', route => {
    const params = new URL(route.request().url()).searchParams
    requests.push(params)
    const rows = ledger.filter(row => row.age < Number(params.get('days'))
      && (!params.get('profile') || params.get('profile') === row.profile)
      && (!params.get('account') || params.get('account') === row.account))
    const sum = (field: 'input_tokens' | 'output_tokens' | 'cache_read_tokens' | 'cost') => rows.reduce((total, row) => total + row[field], 0)
    const models = [...new Set(rows.map(row => row.model))].map(model => {
      const subset = rows.filter(row => row.model === model)
      return { model, input_tokens: subset.reduce((n, row) => n + row.input_tokens, 0),
        output_tokens: subset.reduce((n, row) => n + row.output_tokens, 0),
        cache_read_tokens: subset.reduce((n, row) => n + row.cache_read_tokens, 0), cache_write_tokens: 0, reasoning_tokens: 0, sessions: 1 }
    })
    return route.fulfill({ json: {
      account_attribution_available: true,
      filter_options: { models: ['alpha-model', 'beta-model'], agents: ['codex', 'hermes'],
        accounts: params.get('profile') === 'research' ? [{ id: '2', username: 'alice' }]
          : [{ id: '1', username: 'ekko' }, { id: '2', username: 'alice' }, ...(newAccount ? [{ id: '3', username: 'new-user' }] : [])] },
      total_input_tokens: sum('input_tokens'), total_output_tokens: sum('output_tokens'),
      total_cache_read_tokens: sum('cache_read_tokens'), total_cache_write_tokens: 0, total_reasoning_tokens: 0,
      total_sessions: new Set(rows.map(row => row.session)).size, total_api_calls: rows.length, total_cost: sum('cost'),
      cost_coverage: { reported: rows.length, estimated: 0, unknown: 0 }, period_days: Number(params.get('days')),
      model_usage: models, agent_usage: [], daily_usage: [{ date: '2026-10-11', input_tokens: sum('input_tokens'),
        output_tokens: sum('output_tokens'), cache_read_tokens: sum('cache_read_tokens'), cache_write_tokens: 0,
        sessions: new Set(rows.map(row => row.session)).size, errors: 0, cost: sum('cost'), cost_coverage: { reported: rows.length, estimated: 0, unknown: 0 } }],
    } })
  })
  await page.goto('/#/hermes/usage')
  await expect(page.locator('.stat-hero .stat-value')).toHaveText('2.5K')
  await choose(page, '.account-filter', 'ekko · #1')
  expect(requests.at(-1)?.get('account')).toBe('1')
  await expect(page.locator('.stat-hero .stat-value')).toHaveText('1.6K')
  await expect(page.locator('.ranking-panel .rank-name')).toHaveText(['alpha-model', 'beta-model'])
  await choose(page, '.profile-filter', 'research')
  await expect(page.locator('.usage-empty')).toContainText('No usage matches these conditions')
  expect(requests.at(-1)?.get('account')).toBe('1')
  await choose(page, '.profile-filter', 'All Profiles')
  await expect(page.locator('.stat-hero .stat-value')).toHaveText('1.6K')
  await page.locator('.period-option').filter({ hasText: /^Today$/ }).click()
  await expect.poll(() => requests.at(-1)?.get('period')).toBe('today')
  expect(requests.at(-1)?.get('account')).toBe('1')
  await choose(page, '.account-filter', 'All accounts')
  newAccount = true
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect(page.locator('.usage-content')).toHaveAttribute('aria-busy', 'false')
  await page.locator('.account-filter').click()
  await expect(page.locator('.n-base-select-option').filter({ hasText: /^new-user · #3$/ })).toBeVisible()
  await page.locator('.n-base-select-option').filter({ hasText: /^new-user · #3$/ }).hover()
  await expect.poll(() => page.locator('.n-base-select-option').filter({ hasText: /^new-user · #3$/ }).evaluate(element => {
    let opacity = 1
    for (let node: Element | null = element; node; node = node.parentElement) opacity *= Number(getComputedStyle(node).opacity)
    return opacity
  })).toBe(1)
  await page.screenshot({ path: info.outputPath('usage-accounts-dropdown.png'), fullPage: true })
  await page.keyboard.press('Escape')
  await choose(page, '.account-filter', 'new-user · #3')
  await expect(page.locator('.usage-empty')).toContainText('No usage matches these conditions')
  expect(requests.at(-1)?.get('account')).toBe('3')
  await choose(page, '.account-filter', 'Unassigned account')
  await page.locator('.period-option').filter({ hasText: /^30d$/ }).click()
  await expect(page.locator('.stat-hero .stat-value')).toHaveText('110')
  await expect(page.locator('.ranking-panel .rank-name')).toHaveText(['beta-model'])
})
