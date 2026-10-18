import { expect, test } from '@playwright/test'
import { authenticate, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

test('creates, copies, renames and switches themes without losing their independent settings', async ({ page }) => {
  await authenticate(page)
  const api = await mockHermesApi(page, { theme: { accentColor: '#225588' } })
  await page.goto('/#/hermes/theme')
  const original = page.getByTestId('theme-preset-theme-0')
  await expect(original).toHaveAttribute('aria-pressed', 'true')
  await page.getByTestId('theme-global-radius').fill('20')
  await page.getByTestId('theme-global-radius').dispatchEvent('change')
  await page.getByTestId('theme-duplicate').click()
  await page.getByTestId('theme-name').locator('input').fill('Night glass')
  await page.getByTestId('theme-name-save').click()
  const copy = page.getByTestId('theme-preset-theme-1')
  await expect(copy).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('theme-global-radius')).toHaveValue('20')
  await page.getByTestId('theme-global-radius').fill('4')
  await page.getByTestId('theme-global-radius').dispatchEvent('change')
  await page.locator('.theme-select').first().click()
  await page.locator('.n-base-select-option:visible').getByText('Dark', { exact: true }).click()
  await expect(page.locator('html')).toHaveClass(/dark/)
  await page.getByTestId('theme-rename').click()
  await page.getByTestId('theme-name').locator('input').fill('Midnight')
  await page.getByTestId('theme-name-save').click()
  await expect(copy).toContainText('Midnight')
  await original.click()
  await expect(original).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('html')).not.toHaveClass(/dark/)
  await expect(page.getByTestId('theme-global-radius')).toHaveValue('20')
  await copy.click()
  await expect(page.getByTestId('theme-global-radius')).toHaveValue('4')
  await page.reload()
  await expect(copy).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('html')).toHaveClass(/dark/)
  await page.getByTestId('theme-create').click()
  await page.getByTestId('theme-name').locator('input').fill('Clean')
  await page.getByTestId('theme-name-save').click()
  await expect(page.getByTestId('theme-preset-theme-2')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('html')).not.toHaveClass(/theme-card-radius/)
  await page.getByTestId('theme-delete').click()
  await page.locator('.n-popconfirm').getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(page.getByTestId('theme-preset-theme-2')).toHaveCount(0)
  await expect(original).toHaveAttribute('aria-pressed', 'true')
  expect(api.unexpectedRequests).toEqual([])
})

test('retains the current theme after a failed switch and fits the theme manager on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await authenticate(page)
  const api = await mockHermesApi(page)
  await page.goto('/#/hermes/theme')
  await expect(page.getByTestId('theme-preset-theme-0')).toBeVisible()
  await expect(page.getByTestId('theme-delete')).toBeDisabled()
  await page.getByTestId('theme-create').click()
  await page.getByTestId('theme-name').locator('input').fill('A long theme name that must wrap on a narrow phone display')
  await page.getByTestId('theme-name-save').click()
  await expect(page.getByTestId('theme-preset-theme-1')).toHaveAttribute('aria-pressed', 'true')
  await page.route('**/api/theme/presets/theme-0/activate', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"offline"}' }))
  await page.getByTestId('theme-preset-theme-0').click()
  await expect(page.getByTestId('theme-preset-theme-1')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('theme-create')).toBeEnabled()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: '/tmp/studio-theme-presets-mobile.png' })
  expect(api.unexpectedRequests).toEqual([])
})

test('switches per-theme backgrounds and restores the original after removing a copied background', async ({ page }) => {
  await authenticate(page)
  const api = await mockHermesApi(page, { theme: { background: { name: 'original.png', mime: 'image/png', updatedAt: 100 } } })
  await page.goto('/#/hermes/theme')
  await expect(page.locator('.background-name')).toHaveText('original.png')
  await page.getByTestId('theme-duplicate').click()
  await page.getByTestId('theme-name-save').click()
  await expect(page.getByTestId('theme-preset-theme-1')).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('button', { name: 'Remove', exact: true }).click()
  await expect(page.locator('.background-name')).toHaveCount(0)
  await page.getByTestId('theme-preset-theme-0').click()
  await expect(page.locator('.background-name')).toHaveText('original.png')
  await page.getByTestId('theme-preset-theme-1').click()
  await expect(page.locator('.background-name')).toHaveCount(0)
  expect(api.unexpectedRequests).toEqual([])
})

test('previews global appearance, persists regional overrides, and restores inheritance', async ({ page }) => {
  await authenticate(page)
  const api = await mockHermesApi(page, { workflows: [{
    id: 'theme-workflow', name: 'Theme preview', profile: 'default', workspace: null,
    nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 }, created_at: 1, updated_at: 1,
  }] })
  await page.goto('/#/hermes/theme')
  await expect(page.getByTestId('theme-scope')).toBeVisible()
  const opacity = page.getByTestId('theme-global-opacity')
  await opacity.evaluate(element => {
    const input = element as HTMLInputElement
    input.value = '0.22'
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await expect(page.locator('.app-main--card')).toHaveCSS('background-color', 'rgba(255, 255, 255, 0.22)')
  expect(api.requests.filter(request => request.method === 'PUT' && request.pathname === '/api/theme')).toHaveLength(0)
  await opacity.dispatchEvent('change')
  await page.getByTestId('theme-global-radius').fill('18')
  await page.getByTestId('theme-global-radius').dispatchEvent('change')
  await expect(page.locator('.theme-card').first()).toHaveCSS('border-radius', '18px')
  await page.getByTestId('theme-global-borderWidth').fill('2')
  await page.getByTestId('theme-global-borderWidth').dispatchEvent('change')
  await expect(page.locator('.theme-appearance-editor')).toHaveCSS('border-top-width', '2px')
  await page.getByTestId('theme-global-lineHeight').fill('2')
  await page.getByTestId('theme-global-lineHeight').dispatchEvent('change')

  await page.getByTestId('theme-scope').selectOption('input')
  await page.getByTestId('theme-input-opacity').fill('0')
  await page.getByTestId('theme-input-opacity').dispatchEvent('change')
  await page.getByTestId('theme-input-radius').fill('0')
  await page.getByTestId('theme-input-radius').dispatchEvent('change')
  await expect.poll(() => api.requests.some(request => request.method === 'PUT' && JSON.parse(request.postData || '{}').appearance?.regions.input?.radius === 0)).toBe(true)
  await page.reload()
  await expect(page.getByTestId('theme-scope')).toBeVisible()
  await page.getByTestId('theme-scope').selectOption('input')
  await expect(page.getByTestId('theme-input-opacity')).toHaveValue('0')
  await expect(page.getByTestId('theme-input-radius')).toHaveValue('0')
  await page.getByRole('link', { name: 'Chat', exact: true }).click()
  await expect(page.locator('.chat-panel .input-wrapper')).toHaveCSS('background-color', 'rgba(255, 255, 255, 0)')
  await expect(page.locator('.chat-panel .input-wrapper')).toHaveCSS('border-radius', '0px')
  await expect(page.locator('.chat-panel .input-textarea')).toHaveCSS('line-height', '28px')
  await expect(page.locator('.chat-main-content')).toHaveCSS('background-color', 'rgba(255, 255, 255, 0.22)')

  await page.goto('/#/hermes/theme')
  await page.getByTestId('theme-scope').selectOption('input')
  await page.getByRole('button', { name: 'Reset Background opacity', exact: true }).click()
  await page.getByRole('button', { name: 'Reset Corner radius', exact: true }).click()
  await page.goto('/#/hermes/chat')
  await expect(page.locator('.chat-panel .input-wrapper')).toHaveCSS('background-color', 'rgba(255, 255, 255, 0.22)')
  await expect(page.locator('.chat-panel .input-wrapper')).toHaveCSS('border-radius', '18px')
  await page.goto('/#/hermes/workflow')
  await expect(page.locator('.workflow-main')).toHaveCSS('background-color', 'rgba(255, 255, 255, 0.22)')
  await expect(page.locator('.workflow-canvas')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await expect(page.locator('.workflow-flow')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  expect(api.unexpectedRequests).toEqual([])
})

test('applies custom colors, gradients and overlay surfaces in dark mode at mobile width', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await authenticate(page)
  await page.addInitScript(() => localStorage.setItem('hermes_brightness', 'dark'))
  const api = await mockHermesApi(page, { theme: {
    fontSize: 16, textColor: '#f0f0f0', accentColor: '#88bbff',
    appearance: { global: { backgroundColor: '#102030', gradientColor: '#304050', opacity: 0.3, radius: 14, blur: 0 }, regions: { overlay: { backgroundColor: '#203040', opacity: 0.9, radius: 10 } } },
  } })
  await page.goto('/#/hermes/theme')
  await expect(page.locator('html')).toHaveClass(/theme-has-custom-background/)
  await expect(page.locator('.theme-card').first()).toHaveCSS('background-color', 'rgba(16, 32, 48, 0.3)')
  await expect(page.locator('.theme-card').first()).toHaveCSS('backdrop-filter', 'blur(0px) saturate(1.1)')
  await page.locator('.theme-select').first().click()
  const menu = page.locator('.n-base-select-menu:visible')
  await expect(menu).toHaveCSS('background-color', 'rgba(32, 48, 64, 0.9)')
  await expect(menu).toHaveCSS('border-radius', '10px')
  await page.keyboard.press('Escape')
  await expect(menu).not.toBeVisible()
  const globalSettings = page.locator('.theme-appearance-editor .theme-global-settings')
  await globalSettings.scrollIntoViewIfNeeded()
  expect(await globalSettings.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  await page.screenshot({ path: '/tmp/studio-theme-global-settings-mobile.png' })
  await page.getByTestId('theme-scope').scrollIntoViewIfNeeded()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: '/tmp/studio-theme-customization-mobile.png' })
  expect(api.unexpectedRequests).toEqual([])
})

test('loads and saves the signed-in user theme without profile scoping', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const api = await mockHermesApi(page, {
    theme: {
      fontSize: 16,
      textColor: '#203040',
      accentColor: '#3366ff',
    },
  })

  await page.goto('/#/hermes/theme')

  await expect(page.getByRole('heading', { name: 'Theme', exact: true })).toBeVisible()
  await expect(page.locator('html')).not.toHaveClass(/\bcomic\b/)
  await page.locator('.page-sidebar-account-btn').click()
  await expect(page.locator('.sidebar-account-menu .theme-switch')).toHaveCount(1)
  await expect(page.getByTitle('Comic style', { exact: true })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(page.locator('.page-header .header-subtitle')).toHaveCount(0)
  await expect(page.locator('.studio-page-header .page-header')).toHaveCSS('height', '40px')
  await expect(page.getByLabel('Text color')).toHaveValue('#203040')
  await expect(page.getByLabel('Selection color')).toHaveValue('#3366ff')
  const globalSettings = page.locator('.theme-appearance-editor .theme-global-settings')
  await expect(globalSettings.locator('.theme-select')).toHaveCount(2)
  await expect(globalSettings.locator('.font-size-input')).toBeVisible()
  await expect(globalSettings.getByLabel('Text color')).toHaveValue('#203040')
  await expect(globalSettings.getByLabel('Selection color')).toHaveValue('#3366ff')
  await expect(page.getByRole('heading', { name: 'Appearance', exact: true })).toHaveCount(0)
  await page.getByTestId('theme-scope').selectOption('card')
  await expect(globalSettings).toHaveCount(0)
  await page.getByTestId('theme-scope').selectOption('global')
  await expect(globalSettings.getByLabel('Text color')).toHaveValue('#203040')
  await globalSettings.scrollIntoViewIfNeeded()
  await page.screenshot({ path: '/tmp/studio-theme-global-settings-desktop.png' })
  const layoutWidths = await page.locator('.theme-view').evaluate((view) => ({
    view: view.getBoundingClientRect().width,
    content: view.querySelector('.theme-content')?.getBoundingClientRect().width,
  }))
  expect(layoutWidths.content).toBe(layoutWidths.view)

  const themeRequest = api.requests.find(request => (
    request.method === 'GET' && request.pathname === '/api/theme'
  ))
  expect(themeRequest?.headers.authorization).toBe(`Bearer ${TEST_ACCESS_KEY}`)
  expect(themeRequest?.headers['x-hermes-profile']).toBeUndefined()

  await page.getByLabel('Text color').evaluate((element) => {
    const input = element as HTMLInputElement
    input.value = '#7a243d'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })

  await expect.poll(() => api.requests.find(request => (
    request.method === 'PUT' &&
    request.pathname === '/api/theme' &&
    JSON.parse(request.postData || '{}').textColor === '#7a243d'
  ))).toBeTruthy()
  await expect(page.locator('html')).toHaveCSS('--text-primary', '#7a243d')
  await expect(
    page.locator('.theme-select .n-base-selection__border').first(),
  ).toHaveCSS('border-color', 'rgba(51, 102, 255, 0.18)')

  await page.goto('/#/hermes/chat')
  const textarea = page.locator('.chat-panel .input-textarea')
  const inputWrapper = page.locator('.chat-panel .input-wrapper')
  await expect(textarea).toHaveCSS('color', 'rgb(122, 36, 61)')
  await expect.poll(() => textarea.evaluate(element => (
    getComputedStyle(element, '::placeholder').color
  ))).toBe('rgb(186, 143, 156)')
  await expect(inputWrapper).toHaveCSS(
    'border-color',
    'rgba(51, 102, 255, 0.18)',
  )
  await expect(textarea).toBeVisible()
  await textarea.focus()
  await expect(inputWrapper).toHaveCSS('border-color', 'rgb(51, 102, 255)')

  await page.goto('/#/hermes/profiles')
  const activeProfileCard = page.locator('.profile-card.active')
  await expect(activeProfileCard).toHaveCSS(
    'border-color',
    'rgba(51, 102, 255, 0.4)',
  )
  await expect(activeProfileCard.locator('.n-tag')).toHaveCSS(
    'color',
    'rgb(51, 102, 255)',
  )

  await page.goto('/#/hermes/settings?tab=display')
  const activeSwitchRail = page.locator('.n-switch.n-switch--active .n-switch__rail').first()
  await expect(activeSwitchRail).toHaveCSS('background-color', 'rgb(51, 102, 255)')
  expect(api.unexpectedRequests).toEqual([])
})

for (const brightness of ['light', 'dark'] as const) {
  test(`sidebar toggle follows the primary text color in ${brightness} mode`, async ({ page }) => {
    await authenticate(page)
    const api = await mockHermesApi(page, { theme: {
      brightness, textColor: '#5588bb', accentColor: '#bb8855',
      appearance: { version: 1, global: { secondaryTextColor: '#668866' }, regions: {} },
    } })
    await page.goto('/#/hermes/theme')
    const toggle = page.locator('.studio-page-header .header-sidebar-toggle')
    const icon = toggle.locator('svg')
    const title = page.locator('.studio-page-header .header-title')
    await expect(title).toHaveCSS('color', 'rgb(85, 136, 187)')
    await expect(icon).toHaveCSS('stroke', 'rgb(85, 136, 187)')
    await toggle.hover()
    await expect(icon).toHaveCSS('stroke', 'rgb(85, 136, 187)')
    await toggle.focus()
    await expect(icon).toHaveCSS('stroke', 'rgb(85, 136, 187)')
    await page.mouse.down()
    await expect(icon).toHaveCSS('stroke', 'rgb(85, 136, 187)')
    await page.mouse.up()
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')

    // The icon updates during preview, before the edit is saved.
    const color = page.getByLabel('Text color', { exact: true })
    await color.evaluate(element => {
      const input = element as HTMLInputElement
      input.value = '#bb5577'
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await expect(icon).toHaveCSS('stroke', 'rgb(187, 85, 119)')
    await expect(title).toHaveCSS('color', 'rgb(187, 85, 119)')
    expect(api.requests.some(request => request.method === 'PUT' && request.pathname === '/api/theme')).toBe(false)
    await color.dispatchEvent('change')
    await expect.poll(() => api.requests.some(request => request.method === 'PUT'
      && request.pathname === '/api/theme'
      && JSON.parse(request.postData || '{}').textColor === '#bb5577')).toBe(true)
    await page.reload()
    await expect(icon).toHaveCSS('stroke', 'rgb(187, 85, 119)')
    await page.locator('.theme-setting').filter({ has: color }).getByRole('button', { name: 'Reset', exact: true }).click()
    const presetText = brightness === 'dark' ? 'rgb(224, 224, 224)' : 'rgb(26, 26, 26)'
    await expect(icon).toHaveCSS('stroke', presetText)
    await expect(title).toHaveCSS('color', presetText)
    await page.screenshot({ path: `/tmp/studio-sidebar-icon-${brightness}.png`, animations: 'disabled' })
    expect(api.unexpectedRequests).toEqual([])
  })

  test(`keeps the selected theme style after reload in ${brightness} mode`, async ({ page }) => {
    await authenticate(page)
    await page.addInitScript((mode) => {
      localStorage.setItem('hermes_brightness', mode)
    }, brightness)
    const api = await mockHermesApi(page)

    await page.goto('/#/hermes/theme')
    await expect(page.getByRole('heading', { name: 'Theme', exact: true })).toBeVisible()
    const styleSelect = page.locator('.theme-select').nth(1)

    for (const [style, label] of [['comic', 'Comic'], ['ink', 'Ink']] as const) {
      await styleSelect.click()
      await page.locator('.n-base-select-option:visible').getByText(label, { exact: true }).click()
      await expect.poll(() => page.evaluate(() => localStorage.getItem('hermes_style'))).toBe(style)
      await expect.poll(() => page.locator('html').evaluate(root => root.classList.contains('comic')))
        .toBe(style === 'comic')

      await page.reload()
      await expect(page.getByRole('heading', { name: 'Theme', exact: true })).toBeVisible()
      await expect(styleSelect).toHaveText(label)
      await expect.poll(() => page.locator('html').evaluate(root => root.classList.contains('comic')))
        .toBe(style === 'comic')
      await expect.poll(() => page.locator('html').evaluate(root => root.classList.contains('dark')))
        .toBe(brightness === 'dark')
    }

    expect(api.unexpectedRequests).toEqual([])
  })
}

test('tints transparent app surfaces with the active theme background color', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  await page.addInitScript(() => {
    window.localStorage.setItem('hermes_brightness', 'dark')
  })
  const api = await mockHermesApi(page, {
    theme: {
      background: {
        name: 'theme-background.png',
        mime: 'image/png',
        updatedAt: 101,
      },
    },
  })

  await page.goto('/#/hermes/theme')

  await expect(page.locator('.app-shell')).toHaveClass(/app-shell--custom-background/)
  await expect(page.locator('html')).toHaveClass(/theme-has-custom-background/)
  await expect(page.locator('.app-main--card')).toHaveCSS(
    'background-color',
    'rgba(42, 42, 42, 0.82)',
  )
  await expect(page.locator('aside.sidebar')).toHaveCSS(
    'background-color',
    'rgba(26, 26, 26, 0.78)',
  )
  await expect(page.locator('.app-main--card')).toHaveCSS(
    'backdrop-filter',
    'blur(8px) saturate(1.1)',
  )
  await page.locator('.theme-select').first().click()
  const selectMenu = page.locator('.n-base-select-menu:visible')
  await expect(selectMenu).toHaveCSS(
    'background-color',
    'rgba(26, 26, 26, 0.72)',
  )
  await expect(selectMenu).toHaveCSS(
    'backdrop-filter',
    'blur(8px) saturate(1.1)',
  )
  await page.keyboard.press('Escape')

  await page.goto('/#/hermes/chat')
  await expect(page.locator('.chat-panel')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await expect(page.locator('.chat-panel > .session-list')).toHaveCSS(
    'background-color',
    'rgba(26, 26, 26, 0.78)',
  )
  await expect(page.locator('.chat-panel > .chat-main')).toHaveCSS(
    'background-color',
    'rgba(0, 0, 0, 0)',
  )
  await expect(page.locator('.studio-page-header > .chat-header')).toHaveCSS(
    'background-color',
    'rgba(0, 0, 0, 0)',
  )
  await expect(page.locator('.chat-panel > .chat-main > .chat-header')).toHaveCount(0)
  await expect(page.locator('.chat-main-content')).toHaveCSS(
    'background-color',
    'rgba(26, 26, 26, 0.42)',
  )
  await expect(page.locator('.chat-main-content')).toHaveCSS(
    'backdrop-filter',
    'none',
  )
  await expect(page.locator('.virtual-message-list')).toHaveCSS(
    'background-color',
    'rgba(0, 0, 0, 0)',
  )
  await expect(page.locator('.virtual-message-list')).toHaveCSS(
    'backdrop-filter',
    'none',
  )
  await expect(page.locator('.chat-panel .input-wrapper')).toHaveCSS(
    'background-color',
    'rgba(26, 26, 26, 0.72)',
  )
  await expect(page.locator('.chat-panel .input-wrapper')).toHaveCSS(
    'backdrop-filter',
    'blur(8px) saturate(1.1)',
  )

  await page.goto('/#/hermes/group-chat')
  await expect(page.locator('.group-chat-panel')).toHaveCSS(
    'background-color',
    'rgba(0, 0, 0, 0)',
  )
  await expect(page.locator('.group-chat-panel > .room-sidebar')).toHaveCSS(
    'background-color',
    'rgba(26, 26, 26, 0.78)',
  )
  await expect(page.locator('.group-chat-panel > .chat-main')).toHaveCSS(
    'background-color',
    'rgba(0, 0, 0, 0)',
  )
  await expect(page.locator('.studio-page-header > .chat-header')).toHaveCSS(
    'background-color',
    'rgba(0, 0, 0, 0)',
  )

  await page.goto('/#/hermes/petdex')
  await expect(page.locator('.petdex-view')).toHaveCSS(
    'background-color',
    'rgba(0, 0, 0, 0)',
  )
  await expect(page.locator('.app-main--card')).toHaveCSS(
    'background-color',
    'rgba(42, 42, 42, 0.82)',
  )

  for (const [route, surface] of [
    ['/hermes/connections', '.connections-panel'],
    ['/studio/agents', '.agent-manager-panel'],
    ['/hermes/models', '.models-view'],
  ]) {
    await page.goto(`/#${route}`)
    await expect(page.locator(surface)).toHaveCSS('background-color', 'rgba(42, 42, 42, 0.82)')
    await expect(page.locator(surface)).toHaveCSS('backdrop-filter', 'blur(8px) saturate(1.1)')
    await expect(page.locator('.app-main--card')).toHaveCount(0)
    if (route === '/hermes/connections') {
      await expect(page.locator('.connections-tabs > .n-tabs-nav')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    }
  }
  expect(api.unexpectedRequests).toEqual([])
})
