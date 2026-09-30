import { expect, test } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi } from './fixtures'

for (const width of [1440, 390]) {
  test(`filters and selects sessions from the search-row menu at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await authenticate(page, undefined, 'research')
    await mockChatSocket(page)
    await mockHermesApi(page)
    const sessions = [
      { id: 'research-chat', profile: 'research', title: 'Research conversation', source: 'cli', model: 'test-model', last_active: 200, message_count: 1 },
      { id: 'default-chat', profile: 'default', title: 'Default conversation', source: 'cli', model: 'test-model', last_active: 100, message_count: 1 },
    ]
    await page.route('**/api/studio/sessions/hermes/groups**', route => route.fulfill({ json: { groups: [], included: [] } }))
    await page.route(/\/api\/studio\/sessions(?:\?|$)/, route => {
      const query = new URL(route.request().url()).searchParams
      const profile = query.get('profile')
      return route.fulfill({ json: { sessions: query.get('source') === 'global_agent' ? [] : sessions.filter(session => !profile || session.profile === profile) } })
    })
    await page.addInitScript((sessions) => {
      ;(window as any).__PW_CHAT_SOCKET_RESUMES__ = Object.fromEntries(sessions.map(session => [session.id, {
        session_id: session.id, model: session.model, messages: [], title: session.title,
      }]))
    }, sessions)
    await page.goto('/#/hermes/chat')
    if (width < 769) await page.getByRole('button', { name: 'Menu', exact: true }).click()
    const sidebar = page.locator(width < 769 ? '.studio-mobile-navigation .session-list' : '.chat-panel > .session-list')
    const more = sidebar.getByRole('button', { name: 'Session list actions', exact: true })
    await expect(more).toBeVisible()
    await expect(sidebar.locator('.session-list-toolbar')).toHaveCount(0)
    await expect(sidebar.locator('.session-profile-indicator')).toHaveCount(0)
    await sidebar.getByRole('button', { name: 'Search', exact: true }).hover()
    const searchBox = await sidebar.getByRole('button', { name: 'Search', exact: true }).boundingBox()
    const moreBox = await more.boundingBox()
    expect(moreBox!.y).toBe(searchBox!.y)
    expect(moreBox!.x).toBeGreaterThan(searchBox!.x + searchBox!.width)

    await more.press('Enter')
    await expect(more).toHaveAttribute('aria-expanded', 'true')
    await page.getByText('Filter by Profile', { exact: true }).click()
    await page.locator('.n-dropdown-option-body').filter({ hasText: /^research$/ }).click()
    await expect(sidebar.locator('.session-profile-indicator')).toHaveCount(0)
    await expect(sidebar.getByRole('link', { name: /Research conversation/ }).first()).toBeVisible()
    await expect(sidebar.getByRole('link', { name: /Default conversation/ })).toHaveCount(0)
    expect(await page.evaluate(() => localStorage.getItem('hermes_active_profile_name'))).toBe('research')
    expect(await page.evaluate(() => localStorage.getItem('hermes_session_profile_filter_v1'))).toBe('research')

    await more.click()
    await page.getByText('Filter by Profile', { exact: true }).click()
    await expect(page.locator('.n-dropdown-option-body').filter({ hasText: 'research' })).toContainText('✓')
    await page.locator('.n-dropdown-option-body').filter({ hasText: 'All profiles' }).click()
    await expect(sidebar.locator('.session-profile-indicator')).toHaveCount(0)
    await expect(sidebar.getByRole('link', { name: /Default conversation/ }).first()).toBeVisible()
    await more.click()
    await page.getByText('Batch selection', { exact: true }).click()
    const toolbar = sidebar.locator('.session-list-toolbar')
    await expect(toolbar).toContainText('0 selected')
    await toolbar.getByRole('button', { name: 'Select all', exact: true }).click()
    await expect(toolbar).toContainText('1 selected')
    await expect(toolbar.getByRole('button', { name: 'Cancel', exact: true })).toHaveText('')
    await sidebar.locator('.page-sidebar-top').hover({ position: { x: 2, y: 2 } })
    expect(await toolbar.getByRole('button', { name: 'Delete', exact: true }).evaluate(element => getComputedStyle(element).color))
      .toBe(await toolbar.getByRole('button', { name: 'Select all', exact: true }).evaluate(element => getComputedStyle(element).color))
    await expect(sidebar.locator('.page-sidebar-top')).toHaveCSS('border-bottom-width', '0px')
    await page.screenshot({ animations: 'disabled', path: `/tmp/studio-session-batch-${width}.png` })
    await toolbar.getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(page.getByText('Delete 1 selected sessions?', { exact: true })).toBeVisible()
    await page.locator('.n-popconfirm').getByRole('button', { name: 'Cancel', exact: true }).click()
    await toolbar.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(toolbar).toHaveCount(0)
    await expect(sidebar.locator('.session-item-checkbox')).toHaveCount(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ animations: 'disabled', path: `/tmp/studio-session-menu-${width}.png` })
    await more.click()
    await page.getByText('Filter by Profile', { exact: true }).click()
    await expect(page.locator('.n-dropdown-option-body').filter({ hasText: /^research$/ })).toBeVisible()
    await page.screenshot({ animations: 'disabled', path: `/tmp/studio-session-menu-open-${width}.png` })
    await more.click()
    if (width < 769) {
      await page.locator('.studio-mobile-navigation__close').click()
      await expect(sidebar).toBeHidden()
      await expect(page.getByRole('button', { name: 'Menu', exact: true })).toHaveAttribute('aria-expanded', 'false')
    }
  })
}
