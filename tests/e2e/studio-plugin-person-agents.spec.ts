import { test, expect } from '@playwright/test'
import { resolve } from 'node:path'

test('configures a Bot plugin executor with its own avatar and native catalog in the selected Profile', async ({ page }) => {
  const requests: string[] = []
  const descriptor = { id: 'plugin:omp/omp', name: 'Oh My Pi', icon: '/logo.png', origin: 'plugin', vendor: 'Stencil Labs', description: '', modes: ['scoped', 'global'], surfaces: ['chat'], actions: { settings: true } }
  await page.route(url => url.pathname.startsWith('/api/'), async route => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith('/agent-models')) return route.fulfill({ json: { groups: [], profiles: ['work', 'other'] } })
    if (path.endsWith('/capabilities')) return route.fulfill({ json: { native_allowed: false, agents: [{ runtime: descriptor.id, installed: true, descriptor }] } })
    if (path.endsWith('/models')) {
      requests.push(route.request().headers()['x-hermes-profile'])
      return route.fulfill({ json: { status: 'ready', models: [{ id: 'custom/example', name: 'OMP model' }] } })
    }
    return route.fulfill({ json: {} })
  })
  const entry = '/@fs/' + resolve('tests/e2e/fixtures/plugin-person-agents.ts').replace(/^\//, '')
  await page.route('**/__plugin_person_agents__', route => route.fulfill({ contentType: 'text/html', body: `<div id="app"></div><script type="module" src="${entry}"></script>` }))
  await page.goto('/__plugin_person_agents__')
  await page.getByRole('button', { name: /^添加\s*(?:Agent|智能体)$/ }).click()
  await page.getByRole('button', { name: 'Oh My Pi', exact: true }).click()
  await expect(page.locator('.editor-heading img')).toHaveAttribute('src', '/logo.png')
  await page.getByRole('textbox', { name: 'Agent 名称', exact: true }).fill('OMP 开发者')
  await page.locator('.field-wide textarea').fill('执行开发任务')
  await page.getByLabel('启动方式', { exact: true }).click()
  await page.locator('.n-base-select-option').filter({ hasText: /^全局$/ }).click()
  await expect.poll(() => requests).toContain('work')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.locator('.agent-runtime-label')).toHaveText('Oh My Pi')
  const saved = await page.evaluate(() => (window as any).agentFixture.agents)
  expect(saved[0]).toMatchObject({ name: 'OMP 开发者', selection: { runtime: descriptor.id, profile: 'work', mode: 'global' } })
})
