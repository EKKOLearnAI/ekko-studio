import { expect, test, type Page } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi } from './fixtures'

const wallpaper = { name: 'wall.png', mime: 'image/png', updatedAt: 1 }
const appearance = {
  global: { backgroundColor: '#223344', opacity: 0.4 },
  regions: { card: { backgroundColor: '#336699', opacity: 0.25, blur: 12, radius: 16, borderColor: '#6688aa' } },
}
const transparent = 'rgba(0, 0, 0, 0)'

async function mockPlugins(page: Page) {
  await page.route('**/api/hermes/plugins', route => route.fulfill({ json: {
    plugins: [{ key: 'fixture', name: 'Theme plugin', kind: 'standalone', source: 'bundled',
      configStatus: 'enabled', effectiveStatus: 'enabled', version: '1.0', description: 'Theme fixture',
      author: 'Tester', path: '/fixture/plugin', providesTools: [], providesHooks: [], requiresEnv: [] }],
    warnings: [], metadata: null,
  } }))
}

async function paintedTableStyle(page: Page, property: 'backgroundColor' | 'backdropFilter') {
  return page.locator('.n-data-table-wrapper').first().evaluate((element, property) => getComputedStyle(element, '::before')[property], property)
}

for (const brightness of ['light', 'dark']) {
  const textRgb = brightness === 'dark' ? '224, 224, 224' : '26, 26, 26'
  const tint = (opacity: number) => `rgba(${textRgb}, ${opacity})`
  const wallpaperBg = brightness === 'dark' ? 'rgba(42, 42, 42, 0.72)' : 'rgba(255, 255, 255, 0.72)'

  test(`data tables use a single translucent surface in ${brightness} mode`, async ({ page }) => {
    await authenticate(page)
    const api = await mockHermesApi(page, { theme: { brightness, background: wallpaper } })
    let connections = ['Phone', 'Tablet'].map((name, index) => ({
      id: index + 1, device_code: `device-${index}`, device_name: name, device_brand: '', device_model: '',
      connection_type: 'lan', user_id: 1, cloud_user_id: 0, username: 'playwright',
      token_expires_at: 4102444800, last_connected_at: 1780000000, created_at: 1780000000, updated_at: 1780000000,
      active: true, online: true, push_enabled: true, can_manage_push: true,
    }))
    await page.route('**/api/app-connections', route => route.fulfill({ json: { connections, access_failure: null } }))
    const path = '/#/hermes/connections?view=list'
    await page.goto(path)
    const wrapper = page.locator('.n-data-table-wrapper')
    const row = wrapper.locator('tbody tr').first()
    await expect(wrapper).toHaveCSS('background-color', wallpaperBg)
    await expect(row).toContainText('Phone')
    await expect(row.locator('td').first()).toHaveCSS('background-color', transparent)
    await expect(wrapper.locator('th').first()).toHaveCSS('background-color', tint(0.04))
    for (const layer of await wrapper.locator('table, thead, tr').all()) await expect(layer).toHaveCSS('background-color', transparent)
    await row.hover()
    await expect(row).toHaveCSS('background-color', transparent)
    await expect(row.locator('td').first()).toHaveCSS('background-color', tint(0.08))

    await page.goto('/#/hermes/theme')
    await page.getByTestId('theme-scope').selectOption('card')
    await page.getByTestId('theme-card-backgroundColor').fill('#336699')
    await page.getByTestId('theme-card-borderColor').fill('#6688aa')
    for (const [key, value] of [['opacity', '0.25'], ['blur', '12'], ['radius', '16']]) {
      await page.getByTestId(`theme-card-${key}`).fill(value)
      await page.getByTestId(`theme-card-${key}`).dispatchEvent('change')
    }
    await page.goto(path)
    await page.reload()
    await expect(wrapper).toHaveCSS('background-color', transparent)
    await expect(wrapper).toHaveCSS('backdrop-filter', 'none')
    await expect.poll(() => paintedTableStyle(page, 'backgroundColor')).toBe('rgba(51, 102, 153, 0.25)')
    await expect.poll(() => paintedTableStyle(page, 'backdropFilter')).toBe('blur(12px) saturate(1.1)')
    await expect(wrapper).toHaveCSS('border-radius', '16px')
    await expect(wrapper.locator('th').first()).toHaveCSS('border-bottom-color', 'rgba(102, 136, 170, 0.25)')
    await page.setViewportSize({ width: 390, height: 900 })
    await expect(page.getByRole('switch', { name: 'Push notifications for Phone', exact: true })).toBeVisible()
    await page.screenshot({ path: `/tmp/studio-tables-data-${brightness}.png`, animations: 'disabled' })
    connections = []
    await page.reload()
    await expect(wrapper.locator('.n-data-table-empty')).toBeVisible()
    await expect.poll(() => paintedTableStyle(page, 'backgroundColor')).toBe('rgba(51, 102, 153, 0.25)')
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto('/#/hermes/theme')
    await page.getByTestId('theme-scope').selectOption('card')
    await page.getByTestId('theme-card-opacity').fill('0')
    await page.getByTestId('theme-card-opacity').dispatchEvent('change')
    await page.getByTestId('theme-card-blur').fill('0')
    await page.getByTestId('theme-card-blur').dispatchEvent('change')
    await page.goto(path)
    await expect.poll(() => paintedTableStyle(page, 'backgroundColor')).toBe('rgba(51, 102, 153, 0)')
    await expect.poll(() => paintedTableStyle(page, 'backdropFilter')).toBe('blur(0px) saturate(1.1)')
    await expect.poll(() => wrapper.locator('.n-data-table-th--fixed-right').first().evaluate(
      element => getComputedStyle(element, '::after').backdropFilter,
    )).toBe('blur(12px) saturate(1.1)')
    await page.goto('/#/hermes/theme')
    await page.getByRole('button', { name: 'Restore defaults', exact: true }).click()
    await page.goto(path)
    await expect(wrapper).toHaveCSS('background-color', wallpaperBg)
    await page.goto('/#/hermes/theme')
    await page.getByRole('button', { name: 'Remove', exact: true }).click()
    await page.goto(path)
    await expect(wrapper).toHaveCSS('background-color', transparent)
    await expect(wrapper.locator('th').first()).not.toHaveCSS('background-color', tint(0.04))
    expect(api.unexpectedRequests).toEqual([])
  })

  test(`native plugin tables follow card appearance in ${brightness} mode`, async ({ page }) => {
    await authenticate(page)
    const api = await mockHermesApi(page, { theme: { brightness, background: wallpaper, appearance } })
    await mockPlugins(page)
    await page.goto('/#/hermes/plugins')
    const wrapper = page.locator('.plugins-table-wrap')
    await expect(wrapper).toHaveCSS('background-color', 'rgba(51, 102, 153, 0.25)')
    await expect(wrapper).toHaveCSS('backdrop-filter', 'blur(12px) saturate(1.1)')
    await expect(wrapper).toHaveCSS('border-radius', '16px')
    await expect(wrapper).toHaveCSS('border-top-color', 'rgba(102, 136, 170, 0.25)')
    await expect(wrapper.locator('th').first()).toHaveCSS('background-color', tint(0.04))
    await expect(wrapper.locator('td').first()).toHaveCSS('background-color', transparent)
    await wrapper.locator('tbody tr').hover()
    await expect(wrapper.locator('tbody tr')).toHaveCSS('background-color', tint(0.08))
    await expect(wrapper).toContainText('Theme plugin')
    await wrapper.evaluate(element => { element.scrollLeft = 0 })
    await page.screenshot({ path: `/tmp/studio-tables-native-${brightness}.png`, animations: 'disabled' })
    await page.goto('/#/hermes/theme')
    await page.getByRole('button', { name: 'Restore defaults', exact: true }).click()
    await page.goto('/#/hermes/plugins')
    await expect(wrapper).toHaveCSS('background-color', wallpaperBg)
    expect(api.unexpectedRequests).toEqual([])
  })

  test(`message tables share the bubble while spreadsheets follow cards in ${brightness} mode`, async ({ page }) => {
    const id = 'theme-table-session'
    const path = '/tmp/theme-table.csv'
    await authenticate(page)
    await page.addInitScript(({ id, path }) => {
      ;(window as any).__PW_CHAT_SOCKET_RESUMES__ = { [id]: {
        session_id: id, isWorking: false, events: [], messages: [{ id: 1, session_id: id,
          role: 'assistant', content: `| Name | Value |\n| --- | --- |\n| Theme | 42 |\n\n[theme-table.csv](${path})`,
          timestamp: 1790000001, tool_call_id: null, tool_calls: null, tool_name: null,
          token_count: null, finish_reason: null, reasoning: null }],
      } }
    }, { id, path })
    const api = await mockHermesApi(page, { theme: { brightness, background: wallpaper, appearance: {
      ...appearance,
      regions: { ...appearance.regions, assistantMessage: { backgroundColor: '#884422', opacity: 0.35, borderColor: '#aa6633', blur: 9 } },
    } }, sessions: [{
      id, profile: 'research', source: 'cli', model: 'test-model', provider: 'test-provider', title: 'Table fixture',
      started_at: 1790000000, last_active: 1790000100, ended_at: null, message_count: 1,
      tool_call_count: 0, input_tokens: 0, output_tokens: 0, workspace: '/tmp',
    }] })
    await mockChatSocket(page)
    await page.route(`**/api/studio/sessions/${id}/workspace-file/content**`, route => route.fulfill({
      contentType: 'text/csv', body: 'Name,Value,Notes,More\nTheme,42,Transparent,Wide\nSecond,43,Striped,Test\n',
    }))
    await page.goto(`/#/hermes/session/${id}`)
    const markdown = page.locator('.markdown-body table')
    await expect(page.locator('.message.assistant .message-bubble')).toHaveCSS('background-color', 'rgba(136, 68, 34, 0.35)')
    await expect(markdown).toHaveCSS('background-color', transparent)
    await expect(markdown).toHaveCSS('backdrop-filter', 'none')
    await expect(markdown).toHaveCSS('box-shadow', 'none')
    await expect(markdown.locator('th').first()).toHaveCSS('background-color', tint(0.04))
    await expect(markdown.locator('td').first()).toHaveCSS('border-top-color', 'rgba(170, 102, 51, 0.35)')
    await page.locator('.markdown-file-link').filter({ hasText: 'theme-table.csv' }).click()
    const table = page.locator('.spreadsheet-preview .n-data-table-wrapper')
    await expect.poll(() => paintedTableStyle(page, 'backgroundColor')).toBe('rgba(51, 102, 153, 0.25)')
    await expect(table).toContainText('Transparent')
    const stripe = table.locator('.n-data-table-tr--striped').first()
    await page.mouse.move(0, 0)
    await expect(stripe).toHaveCSS('background-color', transparent)
    // Chromium serializes the 2.5% alpha to its nearest 8-bit value.
    await expect(stripe.locator('td').last()).toHaveCSS('background-color', tint(0.024))
    await stripe.hover()
    await expect(stripe.locator('td').last()).toHaveCSS('background-color', tint(0.08))
    await expect.poll(() => table.locator('.n-data-table-td--fixed-left').first().evaluate(
      element => getComputedStyle(element, '::before').backdropFilter,
    )).toBe('blur(12px) saturate(1.1)')
    await page.screenshot({ path: `/tmp/studio-tables-preview-${brightness}.png`, animations: 'disabled' })
    expect(api.unexpectedRequests).toEqual([])
  })
}
