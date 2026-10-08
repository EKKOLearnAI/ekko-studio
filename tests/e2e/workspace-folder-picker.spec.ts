import { expect, test, type Page } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

const longName = 'studio-project-with-a-very-long-directory-name-for-layout-review'
const session = {
  id: 'workspace-picker-session',
  title: 'Workspace Picker',
  source: 'cli',
  model: 'test-model',
  provider: 'test-provider',
  profile: 'research',
  workspace: '/workspace/Archive',
  started_at: 1_800_000_000,
  ended_at: null,
  last_active: 1_800_000_100,
  message_count: 0,
}

async function openChat(page: Page, brightness: 'light' | 'dark') {
  const folderReads: string[] = []
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  await page.addInitScript(({ mode, sessionId }) => {
    localStorage.setItem('hermes_brightness', mode)
    ;(window as typeof window & { __PW_CHAT_SOCKET_RESUMES__?: Record<string, unknown> }).__PW_CHAT_SOCKET_RESUMES__ = {
      [sessionId]: { session_id: sessionId, messages: [], isWorking: false, messageLoadedCount: 0, messageTotal: 0 },
    }
  }, { mode: brightness, sessionId: session.id })
  await mockChatSocket(page)
  await mockHermesApi(page, { sessions: [session] })
  await page.route('**/api/studio/workspace/folders**', async route => {
    const path = new URL(route.request().url()).searchParams.get('path') || ''
    folderReads.push(path)
    const names = path === '' ? ['Projects', 'Archive'] : path === 'Projects' ? [longName, 'Empty'] : []
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        base: '/workspace',
        current: path,
        folders: names.map(name => ({
          name,
          path: [path, name].filter(Boolean).join('/'),
          fullPath: ['/workspace', path, name].filter(Boolean).join('/'),
        })),
      }),
    })
  })
  await page.goto(`/#/hermes/session/${session.id}`)
  await expect(page.locator('.header-session-menu-trigger')).toBeEnabled()
  return folderReads
}

for (const brightness of ['light', 'dark'] as const) {
  test(`selects and browses workspace directories with the keyboard in ${brightness} mode`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    const folderReads = await openChat(page, brightness)
    await page.locator('.header-actions').getByRole('button', { name: 'Set Workspace', exact: true }).click()
    const dialog = page.getByRole('dialog').filter({ hasText: 'Set Session Workspace' })
    await expect(dialog).toHaveCSS('width', '520px')
    const picker = dialog.locator('.folder-picker')
    await expect(picker.getByRole('textbox')).toHaveValue(session.workspace)

    const expand = picker.getByRole('button', { name: 'Expand: Projects', exact: true })
    await expand.focus()
    await page.keyboard.press('Enter')
    await expect(picker.getByRole('button', { name: 'Collapse: Projects', exact: true })).toHaveAttribute('aria-expanded', 'true')
    const project = picker.getByRole('button', { name: longName, exact: true })
    await project.focus()
    await page.keyboard.press('Space')
    await expect(project).toHaveAttribute('aria-pressed', 'true')
    await expect(picker.getByRole('textbox')).toHaveValue(`/workspace/Projects/${longName}`)
    await expect(picker.locator('.folder-selected-path')).toHaveText(`/workspace/Projects/${longName}`)

    await picker.getByRole('button', { name: 'Expand: Empty', exact: true }).click()
    const empty = picker.locator('.folder-item.empty')
    await expect(empty).toHaveText('(Empty)')
    const emptyBounds = await empty.boundingBox()
    const archiveBounds = await picker.getByRole('button', { name: 'Archive', exact: true }).boundingBox()
    expect(emptyBounds!.y + emptyBounds!.height).toBeLessThanOrEqual(archiveBounds!.y)
    await dialog.screenshot({ path: testInfo.outputPath('workspace-picker.png'), animations: 'disabled' })

    await picker.getByRole('button', { name: 'Collapse: Projects', exact: true }).click()
    await expect(project).toHaveCount(0)
    await picker.getByRole('button', { name: 'Expand: Projects', exact: true }).click()
    expect(folderReads.filter(path => path === 'Projects')).toHaveLength(1)
    await expect(project).toHaveAttribute('aria-pressed', 'true')

    const root = picker.getByRole('button', { name: '/workspace', exact: true })
    await root.focus()
    await page.keyboard.press('Enter')
    await expect(picker.getByRole('textbox')).toHaveValue('/workspace')
    await picker.getByRole('button', { name: 'Projects', exact: true }).click({ button: 'right' })
    await expect(page.locator('.n-dropdown-option:visible').filter({ hasText: /^Rename$/ })).toBeVisible()
    await picker.getByRole('textbox').click()
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()

    await page.getByRole('button', { name: 'New Chat', exact: true }).click()
    const drawer = page.locator('.new-chat-drawer')
    await expect(drawer).toHaveCSS('width', '520px')
    await expect(drawer).toHaveCSS('border-top-left-radius', '5px')
    const close = drawer.locator('.n-drawer-header__close')
    await close.hover()
    await expect.poll(() => close.evaluate(element => getComputedStyle(element, '::before').backgroundColor)).toBe('rgba(0, 0, 0, 0)')
    await close.focus()
    await page.keyboard.press('Shift+Tab')
    await page.keyboard.press('Tab')
    await expect(close).toBeFocused()
    await expect(close).toHaveCSS('outline-style', 'solid')
    await page.mouse.down()
    await expect.poll(() => close.evaluate(element => getComputedStyle(element, '::before').backgroundColor)).toBe('rgba(0, 0, 0, 0)')
    await page.mouse.up()
    await expect(drawer).toBeHidden()
  })
}

test('keeps long paths and workspace favorites usable in the mobile new-chat drawer', async ({ page }, testInfo) => {
  await openChat(page, 'light')
  await page.getByRole('button', { name: 'New Chat', exact: true }).click()
  await page.setViewportSize({ width: 390, height: 844 })
  const drawer = page.locator('.new-chat-drawer')
  const picker = drawer.locator('.folder-picker')
  await expect(drawer).toHaveCSS('width', '390px')
  await picker.getByRole('button', { name: 'Expand: Projects', exact: true }).click()
  const project = picker.getByRole('button', { name: longName, exact: true })
  await project.click()
  const path = `/workspace/Projects/${longName}`
  await expect(picker.getByRole('textbox')).toHaveValue(path)
  await expect(picker.locator('.folder-selected-path')).toHaveAttribute('title', path)
  const pin = picker.getByRole('button', { name: 'Set as default workspace', exact: true })
  await pin.click()
  await expect(picker.getByRole('button', { name: 'Unset default workspace', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(picker).toBeInViewport()
  const bounds = await picker.boundingBox()
  expect(bounds!.x).toBeGreaterThanOrEqual(0)
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390)
  expect(await picker.locator('.folder-tree').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  await drawer.screenshot({ path: testInfo.outputPath('workspace-picker-mobile.png'), animations: 'disabled' })

  await picker.getByRole('textbox').fill('/tmp/manually-entered-project')
  await expect(picker.locator('.folder-selected-path')).toHaveText('/tmp/manually-entered-project')
  await expect(picker.getByRole('button', { name: 'Set as default workspace', exact: true })).toHaveAttribute('aria-pressed', 'false')
  await picker.getByRole('textbox').fill('')
  await expect(picker.locator('.folder-selected')).toHaveCount(0)
  await expect(project).toHaveAttribute('aria-pressed', 'false')
})

test('loads directory history and favorites from the account database after reload', async ({ page }) => {
  await openChat(page, 'light')
  await page.evaluate(() => {
    localStorage.setItem('hermes:default_workspaces', '["/legacy-cache"]')
    localStorage.setItem('hermes:recent_workspaces', '[{"path":"/legacy-cache","lastUsed":1,"useCount":1}]')
  })
  await page.getByRole('button', { name: 'New Chat', exact: true }).click()
  let drawer = page.locator('.new-chat-drawer')
  let picker = drawer.locator('.folder-picker')
  await expect(drawer.getByText('legacy-cache', { exact: true })).toHaveCount(0)
  await picker.getByRole('button', { name: 'Archive', exact: true }).click()
  await picker.getByRole('button', { name: 'Set as default workspace', exact: true }).click()
  await expect(picker.getByRole('button', { name: 'Unset default workspace', exact: true })).toHaveAttribute('aria-pressed', 'true')
  expect(await page.evaluate(() => localStorage.getItem('hermes:default_workspaces'))).toBe('["/legacy-cache"]')

  await page.reload()
  await expect(page.locator('.header-session-menu-trigger')).toBeEnabled()
  await page.getByRole('button', { name: 'New Chat', exact: true }).click()
  drawer = page.locator('.new-chat-drawer')
  picker = drawer.locator('.folder-picker')
  await expect(picker.getByRole('textbox')).toHaveValue('/workspace/Archive')
  await expect(drawer.locator('.recent-workspaces')).toContainText('Archive')
  await picker.getByRole('button', { name: 'Unset default workspace', exact: true }).click()
  await expect(drawer.locator('.default-workspace-chips')).toHaveCount(0)
  await expect(drawer.locator('.recent-workspaces')).toContainText('Archive')
})
