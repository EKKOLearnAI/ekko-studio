import { expect, test } from '@playwright/test'
import { authenticate, mockHermesApi } from './fixtures'

const cases = [
  {
    path: 'performance', endpoint: '/api/studio/performance/runtime', surface: '.runtime-section:has(.worker-table)', table: '.worker-table',
    payload: {
      timestamp: 1790000000000,
      system: { platform: 'linux', arch: 'x64', uptimeSeconds: 60, cpuCount: 4, cpuPercent: 12, loadAverage: [],
        totalMemoryBytes: 1000, freeMemoryBytes: 800, usedMemoryBytes: 200, memoryPercent: 20 },
      web: { pid: 123, uptimeSeconds: 60, memory: { rss: 100 }, cpuPercent: 2 },
      bridge: { endpoint: 'fixture', reachable: true, broker: { running: true, ready: true, restartScheduled: false, restartAttempts: 0 },
        workers: [{ pid: 124, role: 'worker', profile: 'research', running: true, cpuPercent: 1,
          memoryRssBytes: 50, sessionCount: 2, runningSessionCount: 1 }], totalWorkerMemoryRssBytes: 50 },
      sessions: { active: 2, running: 1, byProfile: { research: 2 } },
    },
  },
  {
    path: 'skills-usage', endpoint: '/api/hermes/skills/usage/stats', surface: '.usage-panel:has(.skills-table)', table: '.skills-table',
    payload: {
      period_days: 7, summary: { total_skill_loads: 2, total_skill_edits: 0, total_skill_actions: 2, distinct_skills_used: 1 },
      by_day: [], top_skills: [{ skill: 'fixture', view_count: 2, manage_count: 0, total_count: 2, percentage: 100, last_used_at: 1790000000 }],
    },
  },
  {
    path: 'usage', endpoint: '/api/studio/usage/stats', surface: '.daily-trend', table: '.trend-table table', open: '.daily-details summary',
    payload: {
      period_days: 30, total_input_tokens: 100, total_output_tokens: 50, total_cache_read_tokens: 0,
      total_cache_write_tokens: 0, total_reasoning_tokens: 0, total_sessions: 1, total_api_calls: 1,
      total_cost: 0.01, cost_coverage: { reported: 1, estimated: 0, unknown: 0 }, model_usage: [], agent_usage: [],
      daily_usage: [{ date: '2026-10-15', input_tokens: 100, output_tokens: 50, cache_read_tokens: 0,
        cache_write_tokens: 0, sessions: 1, errors: 0, cost: 0.01, cost_coverage: { reported: 1, estimated: 0, unknown: 0 } }],
    },
  },
  {
    path: 'api-relay', endpoint: '/api/hermes/api-relay/usage', surface: '.relay-usage-card', table: '.relay-usage-table',
    payload: { configured: true, checkedAt: '2026-10-15T00:00:00Z', accounts: [{
      id: 'fixture', endpoint: 'https://example.invalid/usage', sources: [{ profile: 'research', provider: 'fixture', label: 'Fixture' }],
      status: 'ready', usage: { isValid: true, remaining: 10, unit: 'USD', today: { requests: 1, total_tokens: 150, cost: 0.01 }, modelStats: [] },
    }] },
  },
]

for (const fixture of cases) {
  test(`${fixture.path} tables inherit translucent card surfaces`, async ({ page }) => {
    await authenticate(page)
    const api = await mockHermesApi(page, { theme: {
      brightness: 'dark', background: { name: 'wall.png', mime: 'image/png', updatedAt: 1 },
      appearance: { global: { opacity: 0.4 }, regions: { card: { backgroundColor: '#336699', opacity: 0.25, radius: 16, blur: 12, borderColor: '#6688aa' } } },
    } })
    await page.route(url => url.pathname === fixture.endpoint, route => route.fulfill({ json: fixture.payload }))
    await page.goto(`/#/hermes/${fixture.path}`)
    if (fixture.open) await page.locator(fixture.open).click()
    const surface = page.locator(fixture.surface)
    const table = page.locator(fixture.table)
    const header = table.locator('thead th, .table-head').first()
    const row = table.locator('tbody tr, .skills-row:not(.table-head)').first()
    await expect(surface).toHaveCSS('background-color', 'rgba(51, 102, 153, 0.25)')
    await expect(surface).toHaveCSS('border-radius', '16px')
    await expect(surface).toHaveCSS('backdrop-filter', 'blur(12px) saturate(1.1)')
    await expect(surface).toHaveCSS('border-top-color', 'rgba(102, 136, 170, 0.25)')
    await expect(header).toHaveCSS('background-color', 'rgba(224, 224, 224, 0.04)')
    await expect(row).toBeVisible()
    await row.hover()
    await expect(row).toHaveCSS('background-color', 'rgba(224, 224, 224, 0.08)')
    expect(api.unexpectedRequests).toEqual([])
  })
}
