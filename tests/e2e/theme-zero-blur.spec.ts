import { expect, test, type Page } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import type { UserThemeSettings } from '../../packages/client/src/api/studio/theme'

async function mockTheme(page: Page, brightness: 'light' | 'dark') {
  const token = `fixture.${Buffer.from(JSON.stringify({ sub: '1', role: 'super_admin' })).toString('base64url')}.fixture`
  let theme: UserThemeSettings = { activePresetId: 'fixture', brightness, style: 'ink',
    fontSize: 14, textColor: null, accentColor: null, updatedAt: 1,
    appearance: { global: { blur: 0, opacity: 0.7 }, regions: {} },
    background: { name: 'fixture.png', mime: 'image/png', updatedAt: 1 } }
  await page.addInitScript(token => {
    localStorage.setItem('hermes_api_key', token)
    localStorage.setItem('hermes_locale', 'en')
    localStorage.setItem('hermes_active_profile_name', 'default')
  }, token)
  await page.routeWebSocket('**/socket.io/**', () => {})
  await page.route(url => url.pathname.startsWith('/api/') || url.pathname === '/health', async route => {
    const path = new URL(route.request().url()).pathname
    const method = route.request().method()
    let json: unknown = {}
    if (path === '/api/theme') {
      if (method === 'PUT') theme = { ...theme, ...route.request().postDataJSON() }
      json = theme
    } else if (path === '/api/theme/presets') {
      json = { activeId: 'fixture', themes: [{ ...theme, id: 'fixture', name: 'Fixture theme' }] }
    } else if (path === '/api/theme/background') {
      if (method === 'GET') return route.fulfill({ path: 'packages/client/public/logo.png' })
      if (method === 'DELETE') theme = { ...theme, background: null }
      json = theme
    } else if (path === '/api/auth/me') json = { user: { id: 1, username: 'fixture', role: 'super_admin' } }
    else if (path === '/api/hermes/profiles') json = { profiles: [{ name: 'default', active: true }] }
    else if (path === '/api/hermes/available-models') {
      const groups = [{ provider: 'fixture', label: 'Fixture', base_url: '', api_key: 'fixture', models: ['fixture-model'] }]
      json = { groups, allProviders: groups, profiles: [], default: 'fixture-model', default_provider: 'fixture' }
    }
    else if (path === '/api/studio/sessions') json = { sessions: [] }
    else if (path === '/api/studio/session-categories') json = { categories: [] }
    await route.fulfill({ json })
  })
  await page.goto('/#/hermes/theme')
  await expect(page.getByTestId('theme-global-blur')).toBeEnabled()
  await expect(page.locator('.app-shell')).toHaveClass(/app-shell--custom-background/)
}

async function filter(page: Page, selector: string, pseudo?: string) {
  return page.locator(selector).first().evaluate((element, pseudo) => getComputedStyle(element, pseudo).backdropFilter, pseudo)
}

for (const brightness of ['light', 'dark'] as const) {
  test(`zero blur removes wallpaper filters and reset restores defaults in ${brightness} mode`, async ({ page }, testInfo) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await mockTheme(page, brightness)
    // Card overrides move the content effect to ::before. Check that layer too.
    for (const selector of ['.studio-frame-surface', '.sidebar', '.theme-appearance-editor', '.theme-select .n-base-selection']) {
      await expect.poll(() => filter(page, selector)).toBe('none')
    }
    await expect.poll(() => filter(page, '.app-main--card', '::before')).toBe('none')
    await expect(page.locator('.theme-appearance-editor')).toHaveCSS('background-color', /0\.7\)/)
    await page.getByTestId('theme-scope').selectOption('card')
    await page.getByTestId('theme-card-opacity').fill('0')
    await expect(page.locator('.theme-appearance-editor')).toHaveCSS('background-color', /, 0\)/)
    await page.getByTestId('theme-card-opacity').fill('0.4')
    await expect(page.locator('.theme-appearance-editor')).toHaveCSS('background-color', /0\.4\)/)
    await page.getByTestId('theme-rename').click()
    await expect(page.locator('.theme-name-dialog')).toBeVisible()
    await expect.poll(() => filter(page, '.theme-name-dialog')).toBe('none')
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(page.locator('.theme-name-dialog')).toBeHidden()

    // The actual editor can opt a single region back into glass.
    await page.getByTestId('theme-scope').selectOption('card')
    await page.getByTestId('theme-card-blur').fill('6')
    await expect.poll(() => filter(page, '.theme-appearance-editor')).toBe('blur(6px) saturate(1.1)')
    await expect.poll(() => filter(page, '.app-main--card', '::before')).toBe('none')
    await page.getByTestId('theme-card-blur').fill('0')
    await expect.poll(() => filter(page, '.theme-appearance-editor')).toBe('none')
    const styles = await page.evaluate(() => ({
      tokens: Object.fromEntries(['chrome', 'sidebar', 'content', 'card', 'input', 'overlay', 'userMessage', 'assistantMessage']
        .map(region => [region, getComputedStyle(document.documentElement).getPropertyValue(`--theme-${region}-filter`)])),
      content: getComputedStyle(document.querySelector('.app-main--card')!, '::before').backdropFilter,
      wallpaper: getComputedStyle(document.querySelector('.app-layout')!).backgroundImage,
    }))
    expect(Object.values(styles.tokens)).toEqual(Array(8).fill('none'))
    const evidence = testInfo.outputPath('computed-styles.json')
    await writeFile(evidence, JSON.stringify(styles, null, 2))
    await testInfo.attach('computed-styles', { path: evidence, contentType: 'application/json' })
    const screenshot = testInfo.outputPath('zero-blur.png')
    await page.screenshot({ path: screenshot, animations: 'disabled' })
    await testInfo.attach('zero-blur', { path: screenshot, contentType: 'image/png' })

    if (brightness === 'dark') {
      await page.setViewportSize({ width: 540, height: 800 })
      await expect(page.getByTestId('theme-card-blur')).toBeVisible()
      await expect.poll(() => filter(page, '.theme-appearance-editor')).toBe('none')
      await page.screenshot({ path: testInfo.outputPath('zero-blur-narrow.png'), animations: 'disabled' })
      await page.setViewportSize({ width: 1280, height: 720 })
    }

    await page.getByRole('button', { name: 'Restore defaults', exact: true }).click()
    await expect.poll(() => filter(page, '.studio-frame-surface')).toBe('blur(16px) saturate(1.1)')
    await expect.poll(() => filter(page, '.app-main--card')).toBe('blur(8px) saturate(1.1)')
    await page.locator('.background-actions').getByRole('button', { name: 'Remove', exact: true }).click()
    await expect(page.locator('.app-shell')).not.toHaveClass(/app-shell--custom-background/)
    await expect.poll(() => filter(page, '.app-main--card')).toBe('none')
    expect(errors).toEqual([])
  })
}
