import { expect, test } from '@playwright/test'
import { authenticate, mockHermesApi, mockTerminalWebSocket, TEST_ACCESS_KEY } from './fixtures'

test('keeps a mounted terminal in sync with Studio brightness and preserves palette overrides', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' })
  await authenticate(page)
  await page.addInitScript(() => localStorage.setItem('hermes_brightness', 'light'))
  await mockHermesApi(page)
  await mockTerminalWebSocket(page)
  await page.goto('/#/hermes/terminal')
  await expect(page.locator('.terminal-header .n-select')).toContainText('Follow Studio theme')
  await expect(page.locator('.xterm-scrollable-element')).toHaveCSS('background-color', 'rgb(250, 250, 250)')
  await page.locator('.page-sidebar-account-btn').click()
  const brightness = page.locator('.sidebar-account-menu .theme-switch')
  await expect(brightness).toHaveAttribute('data-theme-preference', 'light')
  await brightness.click()
  await expect(brightness).toHaveAttribute('data-theme-preference', 'dark')
  await expect(page.locator('.xterm-scrollable-element')).toHaveCSS('background-color', 'rgb(26, 26, 26)')
  await page.keyboard.press('Escape')
  await page.locator('.terminal-header .n-select').click()
  await page.locator('.n-base-select-option:visible').getByText('Solarized Dark', { exact: true }).click()
  await expect(page.locator('.xterm-scrollable-element')).toHaveCSS('background-color', 'rgb(0, 43, 54)')
  await page.locator('.page-sidebar-account-btn').click()
  await brightness.click()
  await expect(brightness).toHaveAttribute('data-theme-preference', 'system')
  await expect(page.locator('html')).not.toHaveClass(/\bdark\b/)
  // An explicit terminal palette must survive both shortcut and OS theme changes.
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(page.locator('html')).toHaveClass(/\bdark\b/)
  await expect(page.locator('.xterm-scrollable-element')).toHaveCSS('background-color', 'rgb(0, 43, 54)')
})

test('opens terminal websocket session and forwards user input', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const api = await mockHermesApi(page)
  await mockTerminalWebSocket(page)

  await page.goto('/#/hermes/terminal')

  await expect(page.getByText('Sessions')).toBeVisible()
  await expect(page.locator('.session-item-title', { hasText: 'zsh #1' })).toBeVisible()

  const terminalState = await page.waitForFunction(() => {
    const state = (window as any).__PW_TERMINAL_WS__
    const terminalSocket = state?.sockets?.find((socket: { url?: string | URL }) => {
      try {
        return new URL(String(socket.url || ''), window.location.href).pathname === '/api/hermes/terminal'
      } catch {
        return false
      }
    })
    return terminalSocket
      ? {
          url: terminalSocket.url,
          sent: state.sent,
        }
      : null
  })
  const initialState = await terminalState.jsonValue() as any
  const terminalUrl = new URL(initialState.url)
  expect(terminalUrl.pathname).toBe('/api/hermes/terminal')
  expect(terminalUrl.searchParams.get('token')).toBe(TEST_ACCESS_KEY)

  await page.locator('.terminal-header .header-actions button').last().click()
  await expect(page.locator('.session-item-title', { hasText: 'bash #2' })).toBeVisible()

  await page.locator('.terminal-xterm').click()
  await page.keyboard.type('pwd')
  await page.keyboard.press('Enter')

  await expect.poll(async () => page.evaluate(() => {
    const state = (window as any).__PW_TERMINAL_WS__
    return state.sent
      .map((item: any) => item.data)
      .filter((data: string) => !data.startsWith('{'))
      .join('')
  })).toContain('pwd')

  await expect.poll(async () => page.evaluate(() => {
    const state = (window as any).__PW_TERMINAL_WS__
    return state.sent
      .map((item: any) => item.data)
      .filter((data: string) => data.startsWith('{'))
      .map((data: string) => JSON.parse(data))
      .some((message: any) => message.type === 'resize' && message.cols > 0 && message.rows > 0)
  })).toBe(true)

  const finalState = await page.evaluate(() => (window as any).__PW_TERMINAL_WS__)
  const controlMessages = finalState.sent
    .map((item: any) => item.data)
    .filter((data: string) => data.startsWith('{'))
    .map((data: string) => JSON.parse(data))

  expect(controlMessages.some((message: any) => message.type === 'create')).toBe(true)
  expect(api.unexpectedRequests).toEqual([])
})
