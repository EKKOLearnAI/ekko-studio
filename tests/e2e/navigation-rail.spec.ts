import { expect, test } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi } from './fixtures'

test.beforeEach(async ({ page }) => {
  await authenticate(page, undefined, 'research')
  await mockChatSocket(page)
  await mockHermesApi(page)
  await page.route('**/api/studio/sessions/hermes/groups**', route => route.fulfill({ json: { groups: [], included: [] } }))
  await page.route('**/api/hermes/write-gate/pending**', route => route.fulfill({ json: { pending: [] } }))
})

test('keeps global navigation and account controls available when the conversation list is collapsed', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/#/hermes/chat')
  const rail = page.locator('.studio-navigation-rail')
  const sidebar = page.locator('.chat-panel > .session-list')
  const main = page.locator('.chat-panel > .chat-main')
  await expect(rail.getByRole('link', { name: 'Chat', exact: true })).toHaveAttribute('aria-current', 'page')
  await expect(page.locator('.page-sidebar-account-btn')).toHaveCount(1)
  await expect.poll(async () => (await main.boundingBox())?.x).toBe(304)
  expect(await rail.boundingBox()).toMatchObject({ x: 0, y: 0, width: 64, height: 900 })
  expect(await sidebar.boundingBox()).toMatchObject({ x: 64, y: 40, width: 240, height: 855 })
  expect(await main.boundingBox()).toMatchObject({ x: 304, y: 40, width: 1131, height: 855 })

  await expect(page.locator('.chat-input-area')).toBeInViewport()
  await expect(page.locator('.app-box')).toHaveCSS('padding-top', '40px')
  await expect(rail).toHaveCSS('border-right-width', '0px')
  await expect(page.locator('.app-box .studio-navigation-rail')).toHaveCount(0)
  expect(await page.locator('.app-box').evaluate(el => el.scrollHeight <= el.clientHeight)).toBe(true)
  await page.screenshot({ path: '/tmp/studio-header-box-chat.png', animations: 'disabled' })

  await page.locator('.header-sidebar-toggle').click()
  await expect.poll(async () => (await main.boundingBox())?.x).toBe(64)
  await rail.locator('.page-sidebar-account-btn').click()
  await expect(page.locator('.sidebar-account-menu')).toBeInViewport()
  await page.keyboard.press('Escape')
  await rail.getByRole('link', { name: 'History', exact: true }).click()
  await expect(page).toHaveURL(/#\/hermes\/history$/)
  await expect(rail.getByRole('link', { name: 'History', exact: true })).toHaveAttribute('aria-current', 'page')
  await expect.poll(async () => (await page.locator('.history-panel').boundingBox())?.y).toBe(40)
  expect((await page.locator('.history-panel').boundingBox())?.height).toBe(855)
  await rail.getByRole('link', { name: 'Workflow', exact: true }).click()
  await expect(page).toHaveURL(/#\/hermes\/workflow$/)
  await expect.poll(async () => (await page.locator('.workflow-view').boundingBox())?.y).toBe(40)
  expect((await page.locator('.workflow-view').boundingBox())?.height).toBe(855)
  await rail.getByRole('link', { name: 'Group Chat', exact: true }).click()
  await expect(page.locator('.group-chat-view')).toHaveAttribute('aria-busy', 'false')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect.poll(async () => (await page.locator('.group-chat-panel').boundingBox())?.y).toBe(40)
  expect((await page.locator('.group-chat-panel').boundingBox())?.height).toBe(855)
  await rail.getByRole('link', { name: 'Settings', exact: true }).click()
  await expect(page.locator('aside.sidebar')).toBeVisible()
  expect((await page.locator('aside.sidebar').boundingBox())?.y).toBe(40)
  expect((await page.locator('.app-main').boundingBox())?.y).toBe(40)
  await expect(rail.getByRole('link', { name: 'Settings', exact: true })).toHaveAttribute('aria-current', 'page')
  await rail.getByRole('link', { name: 'Chat', exact: true }).click()
  await expect(page).toHaveURL(/#\/hermes\/chat$/)
  await expect(sidebar.getByRole('button', { name: 'Search', exact: true })).toBeVisible()
  await sidebar.getByRole('button', { name: 'Search', exact: true }).click()
  await expect(page.locator('.session-search-modal')).toBeVisible()
  await page.keyboard.press('Escape')
  await sidebar.getByRole('button', { name: 'New Chat', exact: true }).click()
  await expect(page.locator('.new-chat-page')).toBeVisible()
})

test('opens the two-column mobile drawer and restores the desktop rail after resizing', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/#/hermes/chat')
  await expect(page.locator('.studio-navigation-rail')).toBeVisible()
  await page.setViewportSize({ width: 390, height: 800 })
  await expect(page.locator('.studio-navigation-rail')).not.toBeVisible()
  await expect(page.locator('.app-box')).toHaveCSS('padding-top', '0px')
  expect((await page.locator('.app-layout').boundingBox())?.y).toBe(0)
  await expect(page.locator('.chat-header .header-session-title')).toBeVisible()
  await expect(page.locator('.chat-header .header-session-title')).toHaveText('New Chat')
  await page.getByRole('button', { name: 'Menu', exact: true }).click()
  const drawer = page.locator('.studio-mobile-drawer')
  const rail = drawer.locator('.studio-navigation-rail')
  const sidebar = drawer.locator('.session-list')
  await expect(rail.getByRole('link', { name: 'Group Chat', exact: true })).toBeVisible()
  await expect(sidebar.locator('.session-items')).toBeVisible()
  await expect(drawer).toHaveCSS('width', '390px')
  await expect(drawer).toHaveCSS('border-top-right-radius', '5px')
  await expect.poll(async () => (await rail.boundingBox())?.x).toBe(0)
  expect(await rail.boundingBox()).toMatchObject({ width: 64, height: 800 })
  expect((await sidebar.boundingBox())?.x).toBe(65)
  await expect(page.locator('.conversation-switch')).toHaveCount(0)
  await page.screenshot({ path: '/tmp/studio-mobile-two-level-chat.png', animations: 'disabled' })
  await expect(page.locator('.page-sidebar-account-btn')).toHaveCount(1)
  await page.locator('.page-sidebar-account-btn').click()
  await expect(page.locator('.sidebar-account-menu')).toBeInViewport()
  await page.keyboard.press('Escape')
  const close = drawer.getByRole('button', { name: 'Close', exact: true })
  await close.hover()
  await expect(close).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await close.focus()
  await page.keyboard.press('Shift+Tab')
  await page.keyboard.press('Tab')
  await expect(close).toBeFocused()
  await expect(close).toHaveCSS('outline-style', 'solid')
  await close.click()
  await expect(drawer).not.toBeVisible()
  await expect(page.getByRole('button', { name: 'Menu', exact: true })).toBeFocused()
  await page.getByRole('button', { name: 'Menu', exact: true }).click()
  await sidebar.getByRole('button', { name: 'Search', exact: true }).click()
  await expect(page.locator('.session-search-modal')).toBeVisible()
  await expect(drawer).not.toBeVisible()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Menu', exact: true }).click()
  await page.setViewportSize({ width: 1280, height: 800 })
  await expect(page.locator('.studio-navigation-rail')).toBeVisible()
  await expect(page.locator('.page-sidebar-account-btn')).toHaveCount(1)
  await expect(page.locator('.conversation-switch')).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('navigates through the shared mobile rail and closes it on leaf pages', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/#/hermes/models')
  await expect(page.locator('.models-view')).toBeVisible()
  await page.setViewportSize({ width: 390, height: 800 })
  const drawer = page.locator('.studio-mobile-drawer')
  for (const [name, panel] of [
    ['Device connections', '.connections-panel'],
    ['Agent Manager', '.agent-manager-panel'],
    ['Models', '.models-view'],
  ]) {
    await page.getByRole('button', { name: 'Menu', exact: true }).click()
    await expect(drawer).toBeVisible()
    await expect(drawer.locator('.session-items, .session-list-toolbar')).toHaveCount(0)
    await expect(drawer.getByRole('button', { name: 'Session list actions' })).toHaveCount(0)
    await drawer.getByRole('link', { name, exact: true }).click()
    await expect(page.locator(panel)).toBeVisible()
    await expect(drawer).not.toBeVisible()
  }
  await page.getByRole('button', { name: 'Menu', exact: true }).click()
  await drawer.getByRole('link', { name: 'Chat', exact: true }).click()
  await expect(page).toHaveURL(/#\/hermes\/chat$/)
  await expect(drawer.locator('.session-list .session-items')).toBeVisible()
})

test('keeps both navigation levels while switching lists and settings on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 })
  await page.goto('/#/hermes/chat')
  await page.getByRole('button', { name: 'Menu', exact: true }).click()
  const drawer = page.locator('.studio-mobile-drawer')
  const rail = drawer.locator('.studio-navigation-rail')
  for (const [name, sidebar, route] of [
    ['History', '.session-list', '/hermes/history'],
    ['Workflow', '.workflow-sidebar', '/hermes/workflow'],
    ['Group Chat', '.room-sidebar', '/hermes/group-chat'],
    ['Settings', '.sidebar', '/hermes/settings'],
    ['Chat', '.session-list', '/hermes/chat'],
  ]) {
    await rail.getByRole('link', { name, exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`#${route}$`))
    await expect(drawer.locator(sidebar)).toBeVisible()
    await expect.poll(async () => (await drawer.locator(sidebar).boundingBox())?.x).toBe(65)
    await expect(page.locator('.page-sidebar-account-btn')).toHaveCount(1)
    await expect(drawer).toBeInViewport()
  }
  await rail.getByRole('link', { name: 'Settings', exact: true }).click()
  await drawer.locator('.sidebar').getByRole('link', { name: 'Theme', exact: true }).click()
  await expect(page).toHaveURL(/#\/hermes\/theme$/)
  await expect(drawer).not.toBeVisible()
  await page.getByRole('button', { name: 'Menu', exact: true }).click()
  await page.mouse.click(380, 400)
  await expect(drawer).not.toBeVisible()
  await page.getByRole('button', { name: 'Menu', exact: true }).click()
  await page.keyboard.press('Escape')
  await expect(drawer).not.toBeVisible()
})

test('keeps populated history open after automatic loading and closes only on session selection', async ({ page }) => {
  const history = [
    { id: 'history-first', title: 'First historical conversation', source: 'cli' },
    { id: 'history-second', title: 'Second historical conversation', source: 'cli' },
    { id: 'history-cron', title: 'Scheduled historical conversation', source: 'cron' },
  ].map(session => ({
    ...session, profile: 'research', model: 'test-model', provider: 'test-provider',
    started_at: 1790000000, last_active: 1790000010, message_count: 1,
  }))
  await page.route('**/api/studio/sessions/hermes/groups**', route => route.fulfill({ json: {
    groups: ['cli', 'cron'].map(source => ({ source, sessions: history.filter(session => session.source === source), hasMore: false })),
    included: [],
  } }))
  let releaseDefault!: () => void
  const defaultGate = new Promise<void>(resolve => { releaseDefault = resolve })
  let releaseSelected!: () => void
  const selectedGate = new Promise<void>(resolve => { releaseSelected = resolve })
  let defaultRequested = false
  await page.route('**/api/studio/sessions/conversations/history-*/messages/paginated*', async route => {
    const session = history.find(item => route.request().url().includes(`/${item.id}/`))!
    if (session.id === 'history-first') {
      defaultRequested = true
      await defaultGate
    }
    if (session.id === 'history-second') await selectedGate
    await route.fulfill({ json: {
      session, messages: [{ id: `${session.id}-message`, role: 'assistant', content: `Loaded ${session.title}`, timestamp: 1790000010 }],
      total: 1, offset: 0, limit: 150, hasMore: false,
    } })
  })
  await page.setViewportSize({ width: 390, height: 800 })
  await page.goto('/#/hermes/chat')
  await page.getByRole('button', { name: 'Menu', exact: true }).click()
  const drawer = page.locator('.studio-mobile-drawer')
  await drawer.getByRole('link', { name: 'History', exact: true }).click()
  await expect.poll(() => defaultRequested).toBe(true)
  await expect(drawer).toBeVisible()
  releaseDefault()
  await expect(page.locator('.history-panel')).toHaveAttribute('aria-busy', 'false')
  await expect(page.locator('.history-panel .header-session-title')).toHaveText(history[0].title)
  await expect(drawer).toBeVisible()
  await expect(drawer.getByRole('link', { name: 'History', exact: true })).toHaveAttribute('aria-current', 'page')
  await page.screenshot({ path: '/tmp/studio-mobile-history-selection.png', animations: 'disabled' })

  // Selecting the already loaded session should also dismiss the drawer.
  await drawer.locator('.session-item').filter({ hasText: history[0].title }).click()
  await expect(drawer).not.toBeVisible()
  await page.getByRole('button', { name: 'Menu', exact: true }).click()
  await drawer.locator('.session-item').filter({ hasText: history[1].title }).click()
  await expect(drawer).not.toBeVisible()
  await page.getByRole('button', { name: 'Menu', exact: true }).click()
  releaseSelected()
  await expect(page.locator('.history-panel')).toHaveAttribute('aria-busy', 'false')
  await expect(page.locator('.history-panel .header-session-title')).toHaveText(history[1].title)
  await expect(drawer).toBeVisible()

  // Expanding another source previews its first session without dismissing navigation.
  await drawer.locator('.session-group-header').filter({ hasText: /cron/i }).click()
  await expect(page.locator('.history-panel .header-session-title')).toHaveText(history[2].title)
  await expect(drawer).toBeVisible()
  await drawer.locator('.session-item').filter({ hasText: history[2].title }).click()
  await expect(drawer).not.toBeVisible()
})

for (const width of [320, 390]) {
  test(`shows the single-chat title and keeps actions visible on a ${width}px phone`, async ({ page }) => {
    const title = 'A long conversation title that should remain visible beside the mobile header actions'
    await page.addInitScript(() => {
      (window as any).__PW_CHAT_SOCKET_RESUMES__ = {
        'mobile-title': { session_id: 'mobile-title', messages: [], isWorking: false },
      }
    })
    await mockHermesApi(page, { sessions: [{
      id: 'mobile-title', profile: 'research', source: 'cli', title, preview: '',
      workspace: '/tmp/mobile-title', model: 'test-model', provider: 'test-provider',
      message_count: 0, started_at: 1790000000, last_active: 1790000010,
    }] })
    await page.setViewportSize({ width, height: 800 })
    await page.goto('/#/hermes/chat')
    const header = page.locator('.chat-panel .chat-header')
    await expect(header.locator('.header-session-title')).toBeVisible()
    await page.getByRole('button', { name: 'Menu', exact: true }).click()
    await page.locator('.studio-mobile-drawer .session-item').filter({ hasText: title }).first().click()
    await expect(page.locator('.studio-mobile-drawer')).not.toBeVisible()
    await expect(header.locator('.header-session-title')).toHaveText(title)
    await expect(header.locator('.header-session-title')).toBeVisible()
    const titleBox = (await header.locator('.header-session-title').boundingBox())!
    const actionsBox = (await header.locator('.header-actions').boundingBox())!
    const menuBox = (await page.getByRole('button', { name: 'Menu', exact: true }).boundingBox())!
    expect(titleBox.width).toBeGreaterThan(80)
    expect(titleBox.x).toBeGreaterThanOrEqual(menuBox.x + menuBox.width)
    expect(titleBox.x + titleBox.width).toBeLessThanOrEqual(actionsBox.x)
    expect(actionsBox.x + actionsBox.width).toBeLessThanOrEqual(width)
    await expect(header.locator('.header-session-title')).toHaveCSS('text-overflow', 'ellipsis')
    await expect(header.getByRole('button', { name: 'Session actions', exact: true })).toBeInViewport()
    await page.screenshot({ path: `/tmp/studio-mobile-chat-title-${width}.png`, animations: 'disabled' })
  })
}

for (const [route, sidebar, destination, destinationRoute] of [
  ['/hermes/jobs', '.hermes-config-sidebar', 'Skills', '/hermes/skills'],
  ['/ekko/skills', '.ekko-config-sidebar', 'Memory', '/ekko/memory'],
  ['/studio/agents/codex/skills', '.coding-agent-config-sidebar', 'MCP', '/studio/agents/codex/mcp'],
]) {
  test(`shows full configuration menus on mobile even with desktop collapse saved: ${route}`, async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('hermes_sidebar_collapsed', '1'))
    await page.setViewportSize({ width: 390, height: 800 })
    await page.goto(`/#${route}`)
    await page.getByRole('button', { name: 'Menu', exact: true }).click()
    const drawer = page.locator('.studio-mobile-drawer')
    const menu = drawer.locator(sidebar)
    await expect(menu).toBeVisible()
    await expect(menu).not.toHaveClass(/collapsed/)
    await expect.poll(async () => (await menu.boundingBox())?.x).toBe(65)
    const item = menu.getByRole('link', { name: destination, exact: true })
    await expect(item.locator('span')).toBeVisible()
    await item.click()
    await expect(page).toHaveURL(new RegExp(`#${destinationRoute}$`))
    await expect(drawer).not.toBeVisible()
    await page.getByRole('button', { name: 'Menu', exact: true }).click()
    await expect(drawer.getByRole('link', { name: 'Chat', exact: true })).toBeInViewport()
    await page.setViewportSize({ width: 1280, height: 800 })
    await expect(page.locator(sidebar)).toHaveClass(/collapsed/)
    await expect.poll(async () => (await page.locator(sidebar).boundingBox())?.width).toBe(64)
    await expect(page.locator('.studio-navigation-rail')).toHaveCount(1)
  })
}

test('scrolls a populated list within a small phone drawer and closes after selecting a session', async ({ page }) => {
  await mockHermesApi(page, {
    sessions: Array.from({ length: 24 }, (_, index) => ({
      id: `mobile-session-${index}`, profile: 'research', source: 'cli',
      title: `Mobile conversation ${index}`, preview: 'Mobile preview',
      model: 'test-model', provider: 'test-provider', message_count: 1,
      started_at: 1790000000 - index, last_active: 1790000000 - index,
    })),
  })
  await page.setViewportSize({ width: 320, height: 568 })
  await page.goto('/#/hermes/chat')
  await page.getByRole('button', { name: 'Menu', exact: true }).click()
  const drawer = page.locator('.studio-mobile-drawer')
  const list = drawer.locator('.session-items')
  await expect(list.getByRole('link', { name: /Mobile conversation 23/ }).last()).toBeAttached()
  await list.getByRole('link', { name: /Mobile conversation 23/ }).last().scrollIntoViewIfNeeded()
  await expect(drawer.getByRole('link', { name: 'Settings', exact: true })).toBeInViewport()
  expect(await drawer.boundingBox()).toMatchObject({ x: 0, y: 0, width: 320, height: 568 })
  expect(await list.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true)
  await page.screenshot({ path: '/tmp/studio-mobile-two-level-small.png', animations: 'disabled' })
  await list.getByRole('link', { name: /Mobile conversation 23/ }).last().click()
  await expect(page).toHaveURL(/\/session\/mobile-session-23/)
  await expect(drawer).not.toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})
