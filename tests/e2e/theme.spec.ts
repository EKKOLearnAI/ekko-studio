import { expect, test } from '@playwright/test'
import { authenticate, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

test('loads and saves the signed-in user theme without profile scoping', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  await page.addInitScript(() => {
    localStorage.setItem('hermes_style', 'comic')
  })
  const api = await mockHermesApi(page, {
    theme: {
      fontSize: 16,
      textColor: '#203040',
      accentColor: '#3366ff',
    },
  })

  await page.goto('/#/hermes/theme')

  await expect(page.getByRole('heading', { name: 'Theme' })).toBeVisible()
  await expect(page.locator('html')).not.toHaveClass(/\bcomic\b/)
  await page.locator('.page-sidebar-account-btn').click()
  await expect(page.locator('.sidebar-account-menu .theme-switch')).toHaveCount(1)
  await expect(page.getByTitle('Comic style', { exact: true })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(page.locator('.page-header .header-subtitle')).toHaveCount(0)
  await expect(page.locator('.studio-page-header .page-header')).toHaveCSS('height', '40px')
  await expect(page.getByLabel('Text color')).toHaveValue('#203040')
  await expect(page.getByLabel('Selection color')).toHaveValue('#3366ff')
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
    'rgba(26, 26, 26, 0.72)',
  )
  await expect(page.locator('aside.sidebar')).toHaveCSS(
    'background-color',
    'rgba(26, 26, 26, 0.72)',
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
    'rgba(26, 26, 26, 0.72)',
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
    'rgba(26, 26, 26, 0.72)',
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
    'rgba(26, 26, 26, 0.72)',
  )

  await page.goto('/#/studio/agents')
  await expect(page.locator('.agent-manager-panel')).toHaveCSS(
    'background-color',
    'rgba(0, 0, 0, 0)',
  )
  await expect(page.locator('.app-main--card')).toHaveCount(0)
  expect(api.unexpectedRequests).toEqual([])
})
