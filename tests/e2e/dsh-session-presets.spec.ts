import { selectNewChatAgent, selectNewChatLaunchMode } from './new-chat-helpers'
import { expect, test } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

for (const mobile of [false, true]) test(`selects a DSH mode for a new chat (${mobile ? 'mobile' : 'desktop'})`, async ({ page }) => {
  if (mobile) await page.setViewportSize({ width: 390, height: 844 })
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const api = await mockHermesApi(page)
  await mockChatSocket(page)
  await page.route('**/api/coding-agents', route => route.fulfill({ json: { tools: [{ id: 'dsh', name: 'DeepSeek Harness', installed: true }] } }))
  let unavailable = true, reads = 0
  await page.route('**/api/coding-agents/dsh/session-presets', route => {
    reads++
    return route.fulfill(unavailable ? { status: 503, json: { error: 'Unavailable' } } : { json: { presets: [
      { id: 'standard', name: 'Standard mode', description: 'File editing and delegation.', isDefault: true },
      { id: 'minimal', name: 'Minimal mode', description: 'A minimal set of tools for this chat.', isDefault: false },
      { id: 'broken', name: 'Broken mode', unavailable: true, isDefault: false },
    ] } })
  })
  await page.goto('/#/hermes/chat')
  if (mobile) await page.getByRole('button', { name: 'Menu', exact: true }).click()
  await page.getByRole('button', { name: 'New Chat', exact: true }).click()
  const draft = page.locator('.new-chat-page')
  await expect(page.getByTestId('dsh-session-preset')).toHaveCount(0)
  expect(reads).toBe(0)
  await selectNewChatAgent(page, 'DeepSeek Harness')
  const field = page.getByTestId('dsh-session-preset')
  const mode = field.getByRole('button', { name: 'DSH mode', exact: true })
  await expect(mode).toHaveClass(/n-button--error-type/)
  await expect(draft.getByRole('button', { name: 'Send', exact: true })).toBeDisabled()
  await mode.click()
  await expect(page.locator('.n-dropdown-option:visible').filter({ hasText: 'Unable to load DSH Agent presets' })).toBeVisible()
  unavailable = false
  await page.locator('.n-dropdown-option:visible').filter({ hasText: /^Retry$/ }).click()
  await expect(mode).toHaveAttribute('data-preset', 'standard')
  await expect(mode).toHaveAttribute('title', /Standard mode/)
  await mode.click()
  await expect(page.locator('.n-dropdown-option:visible').filter({ hasText: /^Standard mode \(Default\)/ })).toBeVisible()
  await expect(page.locator('.n-dropdown-option:visible').filter({ hasText: /^Broken mode$/ }).locator('.n-dropdown-option-body')).toHaveClass(/disabled/)
  const minimal = page.locator('.n-dropdown-option:visible').filter({ hasText: /^Minimal mode/ })
  await expect(minimal).toContainText('A minimal set of tools for this chat.')
  await minimal.click()
  await expect(mode).toHaveAttribute('data-preset', 'minimal')
  await expect(mode).toHaveAttribute('title', /Minimal mode/)
  await mode.click()
  await page.keyboard.press('Escape')
  await expect(page.locator('.n-dropdown-menu:visible')).toHaveCount(0)
  await expect(draft).toBeVisible()
  // Both global and scoped launches share the same independent Agent preset.
  if (mobile) await selectNewChatLaunchMode(page, 'global')
  await expect(mode).toHaveAttribute('data-preset', 'minimal')
  await expect(mode).toHaveAttribute('title', /Minimal mode/)
  await expect(page.locator('.n-dropdown-menu:visible')).toHaveCount(0)
  const workspace = draft.getByRole('button', { name: 'Workspace', exact: true })
  const launch = draft.getByRole('radiogroup', { name: 'Launch mode', exact: true })
  const [workspaceBounds, launchBounds] = await Promise.all([workspace.boundingBox(), launch.boundingBox()])
  expect(Math.abs(workspaceBounds!.y + workspaceBounds!.height / 2 - launchBounds!.y - launchBounds!.height / 2)).toBeLessThanOrEqual(1)
  expect(launchBounds!.x).toBeGreaterThanOrEqual(workspaceBounds!.x + workspaceBounds!.width)
  await expect(draft.locator('.new-chat-mode')).toHaveCount(0)
  expect(await draft.evaluate(el => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1)
  await page.screenshot({ animations: 'disabled', path: `/tmp/dsh-session-mode-${mobile ? 'mobile' : 'desktop'}.png` })
  const input = page.getByPlaceholder('Type a message... (Enter to send, Shift+Enter for new line)')
  await input.fill('Use the tools for my selected mode')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as any).__PW_CHAT_SOCKET__?.emitted?.find((item: any) => item.event === 'run')?.payload)).toMatchObject({ coding_agent_id: 'dsh', agent_preset: 'minimal', mode: mobile ? 'global' : 'scoped' })
  expect(api.unexpectedRequests).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})
