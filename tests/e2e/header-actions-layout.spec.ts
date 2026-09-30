import { expect, test, type Locator, type Page } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi } from './fixtures'

const softExpect = expect.configure({ soft: true })

const routes = [
  '/hermes/chat', '/hermes/history', '/hermes/global-agent', '/hermes/group-chat', '/hermes/workflow',
  '/hermes/jobs', '/hermes/kanban', '/hermes/models', '/hermes/profiles', '/hermes/logs', '/hermes/usage',
  '/hermes/performance', '/hermes/journey', '/hermes/skills-usage', '/hermes/skills', '/hermes/plugins',
  '/hermes/petdex', '/hermes/memory', '/hermes/config/settings', '/hermes/settings', '/hermes/theme',
  '/hermes/channels', '/hermes/terminal', '/hermes/connections', '/hermes/connections?tab=mcu',
  '/hermes/connections?view=messages', '/studio/agents', '/hermes/files', '/hermes/version-preview', '/hermes/mcp',
  '/ekko/memory', '/ekko/skills', '/ekko/mcp', '/ekko/settings', '/studio/agents/codex/skills',
  '/studio/agents/codex/mcp', '/studio/agents/codex/settings', '/studio/agents/dsh/plugins', '/studio/agents/dsh/presets',
]

async function setup(page: Page, platform?: string) {
  await authenticate(page)
  await mockChatSocket(page)
  const api = await mockHermesApi(page)
  await page.route('**/api/studio/sessions/hermes/groups**', route => route.fulfill({ json: { groups: [], included: [] } }))
  await page.route('**/api/studio/logs', route => route.fulfill({ json: { files: [] } }))
  if (platform) await page.addInitScript(platform => {
    Object.defineProperty(window, 'hermesDesktop', { value: {
      isDesktop: true, platform, windowKind: 'main',
      getWindowState: async () => ({ isMaximized: false }),
      windowControl: async () => ({ isMaximized: false }),
    } })
  }, platform)
  return api
}

async function clippedControls(header: Locator) {
  return header.evaluate(element => {
    const headerBox = element.getBoundingClientRect()
    return [...element.querySelectorAll<HTMLElement>('button, a, input, select, [role="button"], [role="tab"], .n-base-selection')].flatMap(el => {
      const box = el.getBoundingClientRect()
      if (!box.width || !box.height) return []
      let left = Math.max(0, headerBox.left), right = Math.min(innerWidth, headerBox.right)
      let top = Math.max(0, headerBox.top), bottom = Math.min(innerHeight, headerBox.bottom)
      for (let ancestor = el.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor), rect = ancestor.getBoundingClientRect()
        if (/(hidden|clip|auto|scroll)/.test(style.overflowX)) { left = Math.max(left, rect.left); right = Math.min(right, rect.right) }
        if (/(hidden|clip|auto|scroll)/.test(style.overflowY)) { top = Math.max(top, rect.top); bottom = Math.min(bottom, rect.bottom) }
      }
      if (box.left >= left - 1 && box.right <= right + 1 && box.top >= top - 1 && box.bottom <= bottom + 1) return []
      return [{ label: el.getAttribute('aria-label') || el.textContent?.trim() || el.className,
        box: { x: box.x, y: box.y, width: box.width, height: box.height }, visible: { left, right, top, bottom } }]
    })
  })
}

for (const { widths, platform } of [
  { widths: [390, 769, 900, 1440] },
  { widths: [769], platform: 'win32' }, { widths: [769], platform: 'linux' },
  { widths: [900], platform: 'darwin' },
]) {
  for (const route of routes) {
    test(`keeps header actions visible on ${route} (${platform || 'browser'})`, async ({ page }) => {
      await page.setViewportSize({ width: widths[0], height: 900 })
      await page.clock.install()
      await setup(page, platform)
      const headerAtWidth = (width: number) => width > 768
          ? page.locator('.studio-page-header > :not(.header-sidebar-control):not(.desktop-titlebar)')
          : page.locator('.app-main .page-header, .app-main .chat-header, .app-main .terminal-header, .app-main .file-toolbar').first()
      // Each route starts fresh; widths within the browser case share that load.
      await page.goto(`/#${route}`)
      const surface = page.locator('.app-main > .page-loading')
      // This suite measures geometry. Advance the presentation delay while still
      // waiting for data; page-loading.spec.ts exercises the real loading timing.
      await expect.poll(async () => {
        await page.clock.fastForward(1000)
        return await headerAtWidth(widths[0]).isVisible()
          && (!(await surface.count()) || await surface.getAttribute('aria-busy') !== 'true')
      }, { intervals: [0, 50, 100] }).toBe(true)
      for (const width of widths) {
        await test.step(`${width}px`, async () => {
          await page.setViewportSize({ width, height: 900 })
          const header = headerAtWidth(width)
          await expect(header).toBeVisible()
          if (width > 768) {
            await expect.poll(async () => (await header.boundingBox())!.height).toBe(40)
            expect.soft((await header.boundingBox())!.x + (await header.boundingBox())!.width, route)
              .toBeLessThanOrEqual(width - (platform === 'win32' || platform === 'linux' ? 138 : 0) + 1)
          }
          await softExpect.poll(() => clippedControls(header), { message: route }).toEqual([])
        })
      }
    })
  }
}

test('keeps job sorting and creation usable at the minimum Windows width', async ({ page }) => {
  await setup(page, 'win32')
  await page.setViewportSize({ width: 769, height: 900 })
  await page.goto('/#/hermes/jobs')
  const header = page.locator('.studio-page-header > .page-header')
  await expect.poll(() => clippedControls(header)).toEqual([])
  await header.getByRole('button', { name: 'More', exact: true }).click()
  const menu = page.locator('.header-overflow-menu')
  await expect(menu).toBeVisible()
  expect(await clippedControls(menu)).toEqual([])
  await menu.getByRole('button', { name: /Time/ }).click()
  await page.setViewportSize({ width: 1440, height: 900 })
  await expect(menu).toBeHidden()
  await expect(header.getByRole('button', { name: /Time/ })).toContainText('↑')
  await page.setViewportSize({ width: 769, height: 900 })
  await header.getByRole('button', { name: 'Create Job', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
})

test('keeps compact Kanban actions and filters usable as the header resizes', async ({ page }) => {
  await setup(page)
  await page.setViewportSize({ width: 900, height: 900 })
  await page.goto('/#/hermes/kanban')
  const header = page.locator('.studio-page-header > .page-header')
  const more = header.getByRole('button', { name: 'More', exact: true })
  await expect(more).toBeVisible()
  await more.click()
  const menu = page.locator('.header-overflow-menu')
  await expect(menu).toBeVisible()
  expect(await clippedControls(menu)).toEqual([])
  await page.screenshot({ path: test.info().outputPath('kanban-header-actions.png'), animations: 'disabled' })
  await menu.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.setViewportSize({ width: 1600, height: 900 })
  await expect(more).toHaveCount(0)
  await expect(header.getByRole('button', { name: 'Add', exact: true })).toBeVisible()
  await expect.poll(() => clippedControls(header)).toEqual([])
})

test('preserves skill filters and search when moving between compact and wide headers', async ({ page }) => {
  await setup(page)
  await page.setViewportSize({ width: 900, height: 900 })
  await page.goto('/#/hermes/skills')
  const header = page.locator('.studio-page-header > .page-header')
  await header.getByPlaceholder('Search skills...').fill('saved search')
  const sources = header.getByRole('button', { name: 'Filter by source', exact: true })
  await sources.click()
  const menu = page.locator('.header-overflow-menu')
  await expect(menu).toBeVisible()
  expect(await clippedControls(menu)).toEqual([])
  await page.screenshot({ path: test.info().outputPath('skills-header-actions.png'), animations: 'disabled' })
  await menu.getByRole('button', { name: 'Local', exact: true }).click()
  await page.setViewportSize({ width: 1600, height: 900 })
  await expect(sources).toHaveCount(0)
  await expect(header.getByRole('button', { name: 'Local', exact: true })).toHaveClass(/active/)
  await expect(header.getByPlaceholder('Search skills...')).toHaveValue('saved search')
  await expect.poll(() => clippedControls(header)).toEqual([])
  await page.setViewportSize({ width: 769, height: 900 })
  await expect(sources).toBeVisible()
  await sources.click()
  await expect(menu.getByRole('button', { name: 'Local', exact: true })).toHaveClass(/active/)
})

test('uses compact usage period controls at the minimum Windows width', async ({ page }) => {
  const api = await setup(page, 'win32')
  await page.setViewportSize({ width: 769, height: 900 })
  await page.goto('/#/hermes/usage')
  const header = page.locator('.studio-page-header > .page-header')
  await header.getByRole('button', { name: 'More', exact: true }).click()
  const menu = page.locator('.header-overflow-menu')
  await expect(menu).toBeVisible()
  expect(await clippedControls(menu)).toEqual([])
  await menu.getByRole('button', { name: '90d', exact: true }).click()
  await expect.poll(() => api.requests.some(request => request.pathname === '/api/studio/usage/stats'
    && new URLSearchParams(request.search).get('days') === '90')).toBe(true)
  await page.setViewportSize({ width: 1440, height: 900 })
  await expect(header.getByRole('button', { name: '90d', exact: true })).toHaveAttribute('aria-pressed', 'true')
})

for (const tab of ['app', 'mcu', 'devices']) {
  test(`keeps embedded connection header actions visible in the ${tab} panel`, async ({ page }) => {
    await setup(page)
    await page.goto(`/#/hermes/connections?tab=${tab}`)
    const header = page.locator(tab === 'devices' ? '.devices-view .page-header' : '.connections-panel .panel-header')
    await expect(header).toBeVisible()
    for (const width of [1440, 900, 769, 390]) {
      await page.setViewportSize({ width, height: 900 })
      await expect.poll(() => clippedControls(header), { message: `${tab} at ${width}px` }).toEqual([])
    }
  })
}
