import { expect, test } from '@playwright/test'
import { resolve } from 'node:path'

test('plugin settings receive typography and regional theme updates and clear overrides on reset', async ({ page }, testInfo) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const plugin = { manifest: { id: 'theme-settings', name: 'Theme settings', version: '1.0.0', apiVersion: 1,
    client: 'client.mjs', permissions: ['ui'], views: [{ id: 'settings', title: 'Settings', slot: 'agent-settings', icon: 'settings' }] },
    status: 'active', enabled: true, config: {}, tools: [], commands: [], actions: [] }
  await page.route(url => url.pathname.startsWith('/api/'), route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/auth/me') return route.fulfill({ json: { user: { id: 1, username: 'Tester', role: 'super_admin' } } })
    if (path === '/api/studio/plugins') return route.fulfill({ json: { revision: 1, plugins: [plugin] } })
    if (path.endsWith('/client')) return route.fulfill({ json: { source: `export function mount(root) {
      const style = document.createElement('style'); style.textContent = '\
        #root{padding:20px;font:var(--font-size-base,14px)/var(--line-height,1.6) var(--font-family,system-ui)}\
        section{padding:calc(14px * var(--spacing-scale,1));border:var(--border-width,1px) solid var(--theme-card-border,var(--border-color));border-radius:var(--theme-card-radius,var(--radius-component,8px));background:var(--theme-card-bg,var(--bg-card))}\
        input{background:var(--theme-input-bg,var(--bg-input));border-color:var(--theme-input-border,var(--border-color));border-radius:var(--theme-input-radius,var(--radius-component,6px))}\
        dialog{background:var(--theme-overlay-bg,var(--bg-card));border-radius:var(--theme-overlay-radius,var(--radius-component,12px))}';
      root.append(style); const card = document.createElement('section'); card.textContent = 'Settings card';
      const input = document.createElement('input'); input.setAttribute('aria-label','Configuration'); card.append(input);
      const button = document.createElement('button'); button.textContent = 'Edit';
      const dialog = document.createElement('dialog'); const close = document.createElement('button'); close.textContent = 'Close';
      close.onclick=()=>dialog.close(); dialog.append(close); button.onclick=()=>dialog.showModal(); root.append(card,button,dialog);
    }` } })
    if (path.endsWith('/events')) return route.fulfill({ json: { cursor: 0, generation: 'theme', events: [] } })
    return route.fulfill({ json: {} })
  })
  const entry = '/@fs/' + resolve('tests/e2e/fixtures/studio-plugins.ts').replace(/^\//, '')
  await page.route('**/__plugin_theme__', route => route.fulfill({ contentType: 'text/html', body: `<div id="app"></div><script type="module" src="${entry}"></script>` }))
  await page.goto('/__plugin_theme__#/studio/plugin-agent-settings/theme-settings/settings')
  const frame = page.frameLocator('.plugin-workspace iframe')
  const appearance = () => frame.locator('section').evaluate(element => {
    const style = getComputedStyle(element)
    return { background: style.backgroundColor, border: style.borderTopColor, radius: style.borderRadius,
      padding: style.padding, fontSize: style.fontSize }
  })
  await expect(frame.getByText('Settings card')).toBeVisible()
  const preset = await appearance()
  await page.evaluate(() => {
    const fixture = (window as any).pluginFixture
    fixture.wallpaper(true)
    fixture.appearance({ brightness: 'light', appearance: { global: { opacity: .7, spacing: 1.2 },
      regions: { card: { opacity: 0, radius: 20, backgroundColor: '#315a76' }, input: { opacity: .4, radius: 4 }, overlay: { radius: 18 } } } })
    document.documentElement.style.setProperty('--font-size-base', '18px')
  })
  await expect.poll(appearance).toMatchObject({ background: 'rgba(49, 90, 118, 0)', border: 'rgba(224, 224, 224, 0)', radius: '20px', padding: '16.8px', fontSize: '18px' })
  await expect.poll(() => frame.getByLabel('Configuration').evaluate(el => getComputedStyle(el).borderRadius)).toBe('4px')
  await frame.getByLabel('Configuration').fill('updated')
  await expect(frame.getByLabel('Configuration')).toHaveValue('updated')
  await frame.getByRole('button', { name: 'Edit', exact: true }).click()
  await expect.poll(() => frame.locator('dialog').evaluate(el => getComputedStyle(el).borderRadius)).toBe('18px')
  await frame.getByRole('button', { name: 'Close', exact: true }).click()
  await page.screenshot({ path: testInfo.outputPath('plugin-settings-regional-theme.png') })
  await page.evaluate(() => {
    const fixture = (window as any).pluginFixture
    fixture.wallpaper(false)
    fixture.appearance({ brightness: 'light', appearance: { global: {}, regions: {} } })
    document.documentElement.style.removeProperty('--font-size-base')
  })
  await expect.poll(appearance).toEqual(preset)
  await page.evaluate(async () => { await (window as any).pluginFixture.theme(true) })
  await expect.poll(() => frame.locator('html').evaluate(el => getComputedStyle(el).getPropertyValue('--studio-color-scheme').trim())).toBe('dark')
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(frame.getByRole('button', { name: 'Edit', exact: true })).toBeVisible()
  expect(await frame.locator('body').evaluate(el => el.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('plugin-settings-dark-narrow.png') })
  expect(errors).toEqual([])
})
