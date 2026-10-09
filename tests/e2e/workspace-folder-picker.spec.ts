import { expect, test, type Page } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'
import { sendNewChatMessage } from './new-chat-helpers'

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
  await expect(page.locator('.page-loading-overlay:visible')).toHaveCount(0)
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
    const draft = page.locator('.new-chat-page')
    await expect(draft).toBeVisible()
    await expect(page.locator('.new-chat-drawer')).toHaveCount(0)
    await draft.getByRole('button', { name: 'Workspace', exact: true }).click()
    await expect(page.locator('.workspace-picker-content .folder-picker')).toBeVisible()
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await draft.locator('textarea').focus()
    await page.keyboard.press('Escape')
    await expect(draft).toBeHidden()
  })
}

test('keeps long paths and workspace favorites usable in the mobile new-chat page', async ({ page }, testInfo) => {
  await openChat(page, 'light')
  await page.getByRole('button', { name: 'New Chat', exact: true }).click()
  await page.setViewportSize({ width: 390, height: 844 })
  const draft = page.locator('.new-chat-page')
  await draft.getByRole('button', { name: 'Workspace', exact: true }).click()
  const picker = page.locator('.workspace-picker-content .folder-picker')
  await picker.getByRole('button', { name: 'Expand: Projects', exact: true }).click()
  const project = picker.getByRole('button', { name: longName, exact: true })
  await project.click()
  const path = `/workspace/Projects/${longName}`
  await expect(picker.getByRole('textbox')).toHaveValue(path)
  await expect(picker.locator('.folder-selected-path')).toHaveAttribute('title', path)
  const pin = picker.getByRole('button', { name: 'Favorite workspace', exact: true })
  await pin.click()
  await expect(picker.getByRole('button', { name: 'Remove workspace from favorites', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(picker).toBeInViewport()
  const bounds = await picker.boundingBox()
  expect(bounds!.x).toBeGreaterThanOrEqual(0)
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390)
  expect(await picker.locator('.folder-tree').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  await page.getByRole('dialog').filter({ hasText: 'Set Session Workspace' }).screenshot({ path: '/tmp/studio-shared-workspace-mobile.png', animations: 'disabled' })

  await picker.getByRole('textbox').fill('/tmp/manually-entered-project')
  await expect(picker.locator('.folder-selected-path')).toHaveText('/tmp/manually-entered-project')
  await expect(picker.getByRole('button', { name: 'Favorite workspace', exact: true })).toHaveAttribute('aria-pressed', 'false')
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
  let draft = page.locator('.new-chat-page')
  await draft.getByRole('button', { name: 'Workspace', exact: true }).click()
  let picker = page.locator('.workspace-picker-content .folder-picker')
  await expect(draft.getByText('legacy-cache', { exact: true })).toHaveCount(0)
  await picker.getByRole('button', { name: 'Archive', exact: true }).click()
  await picker.getByRole('button', { name: 'Favorite workspace', exact: true }).click()
  await expect(picker.getByRole('button', { name: 'Remove workspace from favorites', exact: true })).toHaveAttribute('aria-pressed', 'true')
  expect(await page.evaluate(() => localStorage.getItem('hermes:default_workspaces'))).toBe('["/legacy-cache"]')

  await page.reload()
  await expect(page.locator('.header-session-menu-trigger')).toBeEnabled()
  await page.getByRole('button', { name: 'New Chat', exact: true }).click()
  draft = page.locator('.new-chat-page')
  await draft.getByRole('button', { name: 'Workspace', exact: true }).click()
  picker = page.locator('.workspace-picker-content .folder-picker')
  await expect(picker.getByRole('textbox')).toHaveValue('/workspace/Archive')
  await expect(page.locator('.workspace-picker-content .recent-workspaces')).toContainText('Archive')
  await picker.getByRole('button', { name: 'Remove workspace from favorites', exact: true }).click()
  await expect(page.locator('.workspace-picker-content .default-workspace-chips')).toHaveCount(0)
  await expect(page.locator('.workspace-picker-content .recent-workspaces')).toContainText('Archive')
})

test('shares workspace favorites with existing chats and applies confirmed directories to the first draft message', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await openChat(page, 'light')
  const sessionWorkspaceWrites: string[] = []
  page.on('request', request => {
    if (/\/api\/studio\/sessions\/[^/]+\/workspace$/.test(new URL(request.url()).pathname)) {
      sessionWorkspaceWrites.push(request.url())
    }
  })
  await page.locator('.header-actions').getByRole('button', { name: 'Set Workspace', exact: true }).click()
  const dialog = page.getByRole('dialog').filter({ hasText: 'Set Session Workspace' })
  const picker = dialog.locator('.folder-picker')
  await picker.getByRole('button', { name: 'Favorite workspace', exact: true }).click()
  await expect(dialog.locator('.default-workspace-chips')).toContainText('Archive')
  await picker.getByRole('button', { name: 'Remove workspace from favorites', exact: true }).click()
  await expect(dialog.locator('.default-workspace-chips')).toHaveCount(0)
  await expect(dialog.locator('.recent-workspaces')).toContainText('Archive')
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()

  await page.getByRole('button', { name: 'New Chat', exact: true }).click()
  const draft = page.locator('.new-chat-page')
  const workspace = draft.getByRole('button', { name: 'Workspace', exact: true })
  await workspace.click()
  await picker.getByRole('button', { name: 'Projects', exact: true }).click()
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(workspace).toHaveText('Workspace')
  await workspace.click()
  await expect(picker.getByRole('textbox')).toHaveValue('')
  await picker.getByRole('button', { name: 'Projects', exact: true }).click()
  await dialog.screenshot({ path: '/tmp/studio-shared-workspace-desktop.png', animations: 'disabled' })
  await dialog.getByRole('button', { name: 'OK', exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(workspace).toHaveText('Projects')
  expect(sessionWorkspaceWrites).toEqual([])

  await sendNewChatMessage(page, 'Use my selected workspace')
  await expect(draft).toBeHidden()
  await expect.poll(() => page.evaluate(() => (window as any).__PW_CHAT_SOCKET__?.emitted?.find((item: any) => item.event === 'run')?.payload)).toMatchObject({
    input: 'Use my selected workspace', workspace: '/workspace/Projects',
  })
  expect(sessionWorkspaceWrites).toEqual([])
})
