import { expect, test } from '@playwright/test'
import { authenticate, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

for (const agent of ['codex', 'pi', 'grok', 'opencode', 'dsh', 'claude-code', 'cursor']) {
  test(`${agent} displays shared skills without editing or deletion`, async ({ page }) => {
    await authenticate(page, TEST_ACCESS_KEY, 'research')
    const api = await mockHermesApi(page)
    await page.route('**/api/hermes/skills**', async route => {
      const url = new URL(route.request().url())
      if (!url.searchParams.has('target')) return route.fallback()
      expect(url.searchParams.get('target')).toBe(agent === 'claude-code' ? 'claude' : agent)
      expect(route.request().method()).toBe('GET')
      if (url.pathname === '/api/hermes/skills') {
        return route.fulfill({ json: { categories: [{ name: 'misc', skills: [
          { name: 'shared', description: 'Shared skill', source: 'local', readonly: true },
          ...(agent === 'dsh' || agent === 'cursor' ? [{ name: 'private', description: 'Private skill', source: 'local', readonly: false }] : []),
        ] }], archived: [] } })
      }
      return route.fulfill({ json: url.pathname.endsWith('/files') ? { files: [] } : { content: '# Skill instructions' } })
    })
    await page.goto(`/#/studio/agents/${agent}/skills`)
    const shared = page.locator('.skill-item').filter({ hasText: 'shared' })
    await expect(shared).toBeVisible()
    await shared.click()
    await expect(page.locator('.detail-name')).toHaveText('shared')
    await expect(shared.locator('.skill-action-btn')).toHaveCount(0)
    await expect(page.locator('.detail-action')).toHaveCount(0)
    if (agent === 'dsh' || agent === 'cursor') {
      const privateSkill = page.locator('.skill-item').filter({ hasText: 'private' })
      await privateSkill.click()
      await expect(page.locator('.detail-name')).toHaveText('private')
      await expect(privateSkill.locator('.skill-action-btn')).toHaveCount(1)
      await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeVisible()
    }
    expect(api.unexpectedRequests).toEqual([])
  })
}
