import { test, expect, type Locator, type Page } from '@playwright/test'
import { resolve } from 'node:path'

const repository = 'https://github.com/ekkolearnai/ekko-studio-plugin-junie'
const image = 'https://resources.jetbrains.com/storage/products/company/brand/logos/Junie_icon.png'
const officialSite = 'https://www.jetbrains.com/'
const title = 'Ekko Studio · Junie'
const credit = 'Copyright © 2026 JetBrains s.r.o. Junie and the Junie logo are trademarks of JetBrains s.r.o.'
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN1sAAAAASUVORK5CYII=', 'base64')
const fallback = 'data:image/png;base64,' + png.toString('base64')
const commit = 'a'.repeat(40)

async function openStudio(page: Page, imageAvailable: boolean, source = `github:ekkolearnai/ekko-studio-plugin-junie#${commit}`) {
  const imageRequests: Record<string, string>[] = []
  await page.route(image, async route => {
    imageRequests.push(await route.request().allHeaders())
    await route.fulfill({
      status: imageAvailable ? 200 : 503,
      contentType: 'image/png',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: imageAvailable ? png : undefined,
    })
  })
  const manifest = { id: 'junie', repository, name: 'JetBrains Junie', version: '0.3.1', apiVersion: 1, permissions: ['agents', 'ui'], icon: fallback }
  const installed = { manifest, source, installedAt: 0, enabled: true, status: 'active', config: {}, tools: [], commands: [], actions: [] }
  const published = {
    id: 'a'.repeat(64), repository, manifestId: 'junie', name: manifest.name,
    version: manifest.version, apiVersion: 1, permissions: manifest.permissions,
    description: 'Junie CLI integration', iconUrl: fallback, sourceCommit: commit,
    installSource: `github:ekkolearnai/ekko-studio-plugin-junie#${commit}`,
  }
  const agent = {
    id: 'plugin:junie/junie', pluginId: 'junie', name: manifest.name, vendor: 'JetBrains',
    icon: fallback, origin: 'plugin', modes: ['global', 'scoped'], surfaces: ['chat'],
    actions: { settings: true }, status: { installed: true, version: '1.0.0' },
  }
  await page.route(url => url.host === 'api.ekkostudio.xyz', async route => {
    const url = new URL(route.request().url())
    const data = url.pathname.endsWith('/count') ? { total: 1 } : { list: [published], page: 1, pageSize: 100, total: 1 }
    await route.fulfill({ json: { ok: true, data } })
  })
  await page.route(url => url.hostname === '127.0.0.1' && url.pathname.startsWith('/api/'), async route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/studio/plugins') return route.fulfill({ json: { revision: 1, plugins: [installed] } })
    if (path === '/api/studio/agents') return route.fulfill({ json: { agents: [agent] } })
    return route.fulfill({ json: {} })
  })
  const entry = '/@fs/' + resolve('tests/e2e/fixtures/studio-plugins.ts').replaceAll('\\', '/').replace(/^\//, '')
  await page.route('**/__studio_junie_brand__', route => route.fulfill({
    contentType: 'text/html', body: `<div id="app"></div><script type="module" src="${entry}"></script>`,
  }))
  await page.goto('/__studio_junie_brand__')
  return imageRequests
}

async function expectBrand(surface: Locator) {
  const link = surface.locator('a.integration-product-icon')
  await expect(link).toBeVisible()
  await expect(link).toHaveAccessibleName('JetBrains Junie')
  await expect(link).toHaveAttribute('href', officialSite)
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  await expect(link.locator('img')).toHaveAttribute('src', image)
  await expect(surface.getByText(title, { exact: true }).first()).toBeVisible()
  const attribution = surface.getByText(credit, { exact: true })
  await expect(attribution).toBeVisible()
  await expect.poll(() => attribution.evaluate(node => {
    const bounds = node.getBoundingClientRect()
    return bounds.left >= -1 && bounds.right <= innerWidth + 1
  })).toBe(true)
}

test('shows the official Junie embed with attribution on cards and details at narrow widths', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const imageRequests = await openStudio(page, true)
  const installed = page.getByTestId('plugin-card-junie')
  await expectBrand(installed)
  await installed.locator('a.integration-product-icon').focus()
  await expect(installed.locator('a.integration-product-icon')).toBeFocused()
  await installed.getByRole('button', { name: title }).click()
  await expectBrand(page.locator('.n-drawer-content:visible'))
  await page.keyboard.press('Escape')
  await page.getByRole('tab', { name: /^全部/ }).click()
  const market = page.getByTestId('market-plugin-junie')
  await expectBrand(market)
  await market.getByRole('button', { name: title }).click()
  await expectBrand(page.locator('.n-drawer-content:visible'))
  await page.keyboard.press('Escape')
  await page.evaluate(() => { location.hash = '#/hermes/agentManager' })
  const agent = page.getByTestId('agent-card-plugin:junie/junie')
  await expectBrand(agent)
  expect(imageRequests.length).toBeGreaterThan(0)
  for (const headers of imageRequests) {
    for (const name of ['referer', 'cookie', 'authorization', 'x-hermes-profile']) expect(headers[name]).toBeUndefined()
  }
})

test('uses the bundled fallback when the official image is unavailable', async ({ page }) => {
  await openStudio(page, false)
  const installed = page.getByTestId('plugin-card-junie')
  await expect(installed.locator('img:visible')).toHaveAttribute('src', fallback)
  await expect(installed.locator('a.integration-product-icon')).toHaveCount(0)
  await page.evaluate(() => { location.hash = '#/hermes/agentManager' })
  const agent = page.getByTestId('agent-card-plugin:junie/junie')
  await expect(agent.locator('img.agent-logo')).toBeVisible()
  await expect(agent.locator('img.agent-logo')).toHaveAttribute('src', fallback)
  await expect(agent.locator('a.integration-product-icon')).toHaveCount(0)
})

test('a different install source cannot activate Junie branding', async ({ page }) => {
  const imageRequests = await openStudio(page, true, `github:someone/junie#${commit}`)
  const installed = page.getByTestId('plugin-card-junie')
  await expect(installed.locator('img')).toHaveAttribute('src', fallback)
  await expect(installed.getByText(credit)).toHaveCount(0)
  await page.evaluate(() => { location.hash = '#/hermes/agentManager' })
  const agent = page.getByTestId('agent-card-plugin:junie/junie')
  await expect(agent.getByRole('heading', { name: 'JetBrains Junie' })).toBeVisible()
  await expect(agent.getByText(credit)).toHaveCount(0)
  expect(imageRequests).toHaveLength(0)
})
