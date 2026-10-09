import { expect, test, type Page } from '@playwright/test'
import { sendNewChatMessage } from './new-chat-helpers'
import { authenticate, mockChatSocket, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

const session = {
  id: 'session-actions-1',
  title: 'Session Menu Review',
  source: 'cli',
  model: 'test-model',
  provider: 'test-provider',
  profile: 'research',
  workspace: '/tmp/session-menu-review',
  started_at: 1_800_000_000,
  ended_at: null,
  last_active: 1_800_000_100,
  message_count: 0,
}

interface SessionActionsHarness {
  chatWindows: Array<{ sessionId: string; profile?: string }>
  openedUrls: string[]
  clipboard: { text: string }
}

async function openChat(page: Page, desktop: boolean) {
  await page.addInitScript(({ installDesktopBridge }) => {
    const sessionActionsState: SessionActionsHarness = {
      chatWindows: [],
      openedUrls: [],
      clipboard: { text: '' },
    }
    ;(window as typeof window & {
      __PW_SESSION_ACTIONS__?: SessionActionsHarness
    }).__PW_SESSION_ACTIONS__ = sessionActionsState

    if (installDesktopBridge) {
      Object.defineProperty(window, 'hermesDesktop', {
        configurable: true,
        value: {
          isDesktop: true,
          platform: 'darwin',
          windowKind: 'main',
          openChatWindow: async (sessionId: string, profile?: string) => {
            sessionActionsState.chatWindows.push({ sessionId, profile })
          },
        },
      })
    } else {
      Object.defineProperty(window, 'open', {
        configurable: true,
        value: (url?: string | URL) => {
          sessionActionsState.openedUrls.push(String(url || ''))
          return null
        },
      })
    }

    Object.defineProperty(Navigator.prototype, 'clipboard', {
      configurable: true,
      get: () => ({
        writeText: async (text: string) => {
          sessionActionsState.clipboard.text = text
        },
      }),
    })
    ;(window as typeof window & { __PW_CHAT_SOCKET_RESUMES__?: Record<string, unknown> }).__PW_CHAT_SOCKET_RESUMES__ = {
      'session-actions-1': {
        session_id: 'session-actions-1',
        messages: [],
        isWorking: false,
        messageLoadedCount: 0,
        messageTotal: 0,
      },
    }
  }, { installDesktopBridge: desktop })
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  await mockChatSocket(page)
  await mockHermesApi(page, { sessions: [session] })
  await page.goto('/#/hermes/session/session-actions-1')
  await expect(page.locator('.header-session-menu-trigger')).toBeEnabled()
}

async function openDesktopChat(page: Page) {
  await openChat(page, true)
}

async function openBrowserChat(page: Page) {
  await openChat(page, false)
}

function visibleOption(page: Page, label: string) {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return page.locator('.n-dropdown-option:visible').filter({ hasText: new RegExp(`^${escapedLabel}$`) })
}

test('consolidates current-session actions into one icon-bearing header menu', async ({ page }) => {
  await openDesktopChat(page)

  const headerActions = page.locator('.header-actions')
  await expect(headerActions.getByRole('button')).toHaveCount(3)

  const workspaceButton = headerActions.getByRole('button', { name: 'Set Workspace', exact: true })
  await expect(workspaceButton).toHaveAttribute('title', session.workspace)
  await expect(workspaceButton).toHaveText('')
  await expect(page.locator('.header-left .workspace-badge')).toHaveCount(0)
  await workspaceButton.click()
  const workspaceDialog = page.getByRole('dialog').filter({ hasText: 'Set Session Workspace' })
  await expect(workspaceDialog.getByRole('textbox')).toHaveValue(session.workspace)
  await workspaceDialog.getByRole('button', { name: 'Cancel' }).click()

  const sidePanelButton = headerActions.getByRole('button', { name: 'Side panel' })
  await expect(sidePanelButton).toHaveAttribute('aria-controls', 'chat-tool-panel')
  await expect(sidePanelButton).toHaveAttribute('aria-expanded', 'false')
  await sidePanelButton.click()
  await expect(page.locator('#chat-tool-panel')).toBeVisible()
  await expect(sidePanelButton).toHaveAttribute('aria-expanded', 'true')
  await sidePanelButton.click()
  await expect(page.locator('#chat-tool-panel')).toBeHidden()

  const sessionActionsButton = headerActions.getByRole('button', { name: 'Session actions' })
  await expect(sessionActionsButton).toHaveAttribute('aria-controls', 'active-session-actions-menu')
  await expect(sessionActionsButton).toHaveAttribute('aria-expanded', 'false')

  await sessionActionsButton.click()
  await expect(sessionActionsButton).toHaveAttribute('aria-expanded', 'true')
  const semanticMenu = page.getByRole('menu', { name: 'Session actions' })
  await expect(semanticMenu).toBeVisible()
  await expect(semanticMenu.getByRole('menuitem')).toHaveCount(4)

  const expectedItems = [
    ['Conversation Outline', 'outline'],
    ['Copy Session ID', 'copy'],
    ['Rename', 'rename'],
    ['Open in new window', 'open-new'],
  ] as const
  await expect(page.locator('.n-dropdown-option:visible')).toHaveCount(expectedItems.length)
  await expect(page.locator('.n-dropdown-option:visible .n-dropdown-option-body__label'))
    .toHaveText(expectedItems.map(([label]) => label))
  for (const [label, icon] of expectedItems) {
    await expect(visibleOption(page, label).locator(`[data-session-menu-icon="${icon}"]`)).toBeVisible()
  }

  await visibleOption(page, 'Conversation Outline').click()
  await expect(sessionActionsButton).toHaveAttribute('aria-expanded', 'false')
  await expect(page.locator('.outline-panel')).toBeVisible()

  await sessionActionsButton.click()
  await visibleOption(page, 'Rename').click()
  const renameDialog = page.getByRole('dialog').filter({ hasText: 'Rename Session' })
  await expect(renameDialog.getByRole('textbox')).toHaveValue('Session Menu Review')
  await renameDialog.getByRole('button', { name: 'Cancel' }).click()

  await sessionActionsButton.click()
  await visibleOption(page, 'Open in new window').click()
  await expect.poll(() => page.evaluate(() => (
    window as typeof window & { __PW_SESSION_ACTIONS__?: SessionActionsHarness }
  ).__PW_SESSION_ACTIONS__?.chatWindows)).toEqual([
    { sessionId: 'session-actions-1', profile: 'research' },
  ])

  await sessionActionsButton.click()
  await visibleOption(page, 'Copy Session ID').click()
  await expect.poll(() => page.evaluate(() => (
    window as typeof window & { __PW_SESSION_ACTIONS__?: SessionActionsHarness }
  ).__PW_SESSION_ACTIONS__?.clipboard.text)).toBe('session-actions-1')
})

test('supports announced keyboard focus inside the current-session menu', async ({ page }) => {
  await openDesktopChat(page)

  const trigger = page.getByRole('button', { name: 'Session actions' })
  await trigger.focus()
  await page.keyboard.press('ArrowDown')
  const menu = page.getByRole('menu', { name: 'Session actions' })
  const items = menu.getByRole('menuitem')
  await expect(menu).toBeVisible()
  await expect(items.nth(0)).toBeFocused()
  await expect(items.nth(0).locator(':scope > .n-dropdown-option-body')).toHaveCSS('outline-style', 'solid')

  await page.keyboard.press('Escape')
  await expect(menu).toBeHidden()
  await expect(trigger).toBeFocused()

  await page.keyboard.press('ArrowUp')
  await expect(menu).toBeVisible()
  await expect(items.nth(3)).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(trigger).toBeFocused()

  await page.keyboard.press('ArrowDown')
  await expect(items.nth(0)).toBeFocused()

  await page.keyboard.press('ArrowDown')
  await expect(items.nth(1)).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(menu).toBeHidden()
  await expect(trigger).toBeFocused()
  await expect.poll(() => page.evaluate(() => (
    window as typeof window & { __PW_SESSION_ACTIONS__?: SessionActionsHarness }
  ).__PW_SESSION_ACTIONS__?.clipboard.text)).toBe('session-actions-1')

  await page.keyboard.press('Tab')
  await page.locator(':focus').evaluate(element => element.setAttribute('data-pw-native-forward-focus', 'true'))
  await trigger.focus()
  await page.keyboard.press('Shift+Tab')
  await page.locator(':focus').evaluate(element => element.setAttribute('data-pw-native-backward-focus', 'true'))

  await trigger.focus()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Tab')
  await expect(page.locator('[data-pw-native-forward-focus="true"]')).toBeFocused()

  await trigger.focus()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Shift+Tab')
  await expect(page.locator('[data-pw-native-backward-focus="true"]')).toBeFocused()
})

test('opens the profiled session route in a browser tab when no desktop bridge exists', async ({ page }) => {
  await openBrowserChat(page)

  await page.getByRole('button', { name: 'Session actions' }).click()
  await visibleOption(page, 'Open in new tab').click()
  await expect.poll(() => page.evaluate(() => (
    window as typeof window & { __PW_SESSION_ACTIONS__?: SessionActionsHarness }
  ).__PW_SESSION_ACTIONS__?.openedUrls)).toEqual([
    '#/hermes/session/session-actions-1?profile=research',
  ])
})

test('keeps local-only session actions honest while the first message awaits persistence', async ({ page }) => {
  await openDesktopChat(page)

  await page.getByRole('button', { name: 'New Chat', exact: true }).click()
  await sendNewChatMessage(page)
  await expect(page).toHaveURL(/#\/hermes\/session\//)
  await expect.poll(() => page.evaluate(() => (window as any).__PW_CHAT_SOCKET__?.emitted?.filter((item: any) => item.event === 'run').length || 0)).toBe(1)

  await page.getByRole('button', { name: 'Session actions' }).click()
  await expect(visibleOption(page, 'Conversation Outline').locator(':scope > .n-dropdown-option-body'))
    .not.toHaveClass(/n-dropdown-option-body--disabled/)
  await expect(visibleOption(page, 'Copy Session ID').locator(':scope > .n-dropdown-option-body'))
    .not.toHaveClass(/n-dropdown-option-body--disabled/)
  await expect(visibleOption(page, 'Rename').locator(':scope > .n-dropdown-option-body'))
    .toHaveClass(/n-dropdown-option-body--disabled/)
  await expect(visibleOption(page, 'Open in new window').locator(':scope > .n-dropdown-option-body'))
    .toHaveClass(/n-dropdown-option-body--disabled/)
  const renameMenuItem = page.getByRole('menuitem', { name: 'Rename' })
  const openMenuItem = page.getByRole('menuitem', { name: 'Open in new window' })
  await expect(renameMenuItem).toHaveAttribute('aria-disabled', 'true')
  await expect(openMenuItem).toHaveAttribute('aria-disabled', 'true')

  await page.keyboard.press('Home')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await expect(renameMenuItem).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('menu', { name: 'Session actions' })).toBeVisible()
  await expect(page.getByRole('dialog').filter({ hasText: 'Rename Session' })).toHaveCount(0)
})

test('shows a matching icon for every sidebar session action and keeps submenu affordances', async ({ page }) => {
  await openDesktopChat(page)

  await page.locator('.session-item').first().click({ button: 'right' })
  const expectedItems = [
    ['Pin', 'pin'],
    ['Rename', 'rename'],
    ['Archive', 'archive'],
    ['Set Workspace', 'workspace'],
    ['Set Model', 'model'],
    ['Move to category', 'category'],
    ['Export', 'export'],
    ['Open in new window', 'open-new'],
    ['Copy Session Link', 'link'],
    ['Copy Session ID', 'copy'],
  ] as const
  await expect(page.locator('.n-dropdown-option:visible')).toHaveCount(expectedItems.length)
  for (const [label, icon] of expectedItems) {
    await expect(visibleOption(page, label).locator(`[data-session-menu-icon="${icon}"]`)).toBeVisible()
  }

  await expect(visibleOption(page, 'Move to category').locator('.n-dropdown-option-body__suffix')).toBeVisible()
  await expect(visibleOption(page, 'Export').locator('.n-dropdown-option-body__suffix')).toBeVisible()
  await visibleOption(page, 'Move to category').hover()
  await expect(visibleOption(page, 'Create new category')).toBeVisible()
})
