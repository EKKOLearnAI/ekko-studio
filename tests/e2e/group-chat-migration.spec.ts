import { expect, test, type Page } from '@playwright/test'
import { resolve } from 'node:path'
import { writeFile } from 'node:fs/promises'

const key = 'hermes.groupChat.botMigrationNotice.v1.acknowledged'
const fixture = '/__group_migration__'

async function openFixture(page: Page, locale = 'zh', empty = false) {
  const entry = '/@fs/' + resolve('tests/e2e/fixtures/group-chat-migration.ts').replaceAll('\\', '/').replace(/^\//, '')
  const panel = '/@fs/' + resolve('tests/e2e/fixtures/group-chat-panel.ts').replaceAll('\\', '/').replace(/^\//, '')
  // Keep this test about the real route/loading/notice, without starting group agents or sockets.
  await page.route('**/components/hermes/group-chat/GroupChatPanel.vue*', route => route.fulfill({
    contentType: 'application/javascript',
    body: `export { default } from ${JSON.stringify(panel)}`,
  }))
  await page.route('**/__group_migration__*', route => route.fulfill({ contentType: 'text/html',
    body: `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="app"></div><script type="module" src="${entry}"></script></body></html>`,
  }))
  await page.goto(`${fixture}?locale=${locale}${empty ? '&empty=1' : ''}`)
  await page.waitForFunction(() => !!(window as any).migrationFixture)
}

async function ready(page: Page) {
  await page.evaluate(() => (window as any).migrationFixture.ready())
}

test('shows after loading, requires acknowledgement, and persists across navigation and reload', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(() => localStorage.setItem('hermes.groupChat.refactorNotice.v1.acknowledged', '1'))
  await openFixture(page)
  const dialog = page.getByRole('dialog', { name: '群聊即将下架' })
  await expect(dialog).toHaveCount(0)
  await ready(page)
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('迁移到 Bot')
  await page.keyboard.press('Escape')
  await page.mouse.click(5, 5)
  await expect(dialog).toBeVisible()
  expect(await page.evaluate(key => localStorage.getItem(key), key)).toBeNull()
  await page.getByRole('button', { name: '知道了', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  expect(await page.evaluate(key => localStorage.getItem(key), key)).toBe('1')
  await expect(page.getByTestId('group-panel')).toBeVisible()
  await page.evaluate(() => (window as any).migrationFixture.navigate('/groups/room-b'))
  await expect(dialog).toHaveCount(0)
  await page.evaluate(() => (window as any).migrationFixture.navigate('/'))
  await page.evaluate(() => (window as any).migrationFixture.navigate('/groups'))
  await expect(page.getByTestId('group-panel')).toBeVisible()
  await expect(dialog).toHaveCount(0)
  await page.reload()
  await page.waitForFunction(() => !!(window as any).migrationFixture)
  await ready(page)
  await expect(page.getByTestId('group-panel')).toBeVisible()
  await expect(dialog).toHaveCount(0)
  expect(errors).toEqual([])
})

test('acknowledgement closes the same notice in another tab', async ({ page, context }) => {
  await openFixture(page)
  await ready(page)
  await expect(page.getByRole('button', { name: '知道了', exact: true })).toBeVisible()
  const other = await context.newPage()
  await openFixture(other)
  await ready(other)
  await expect(other.getByRole('button', { name: '知道了', exact: true })).toBeVisible()
  await other.getByRole('button', { name: '知道了', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(other.getByRole('dialog')).toHaveCount(0)
})

test('also informs users with an empty room list without showing outside group chat', async ({ page }) => {
  await openFixture(page, 'en', true)
  await ready(page)
  await expect(page.getByRole('dialog', { name: 'Group chat is being retired' })).toBeVisible()
  await page.evaluate(() => (window as any).migrationFixture.navigate('/'))
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect(await page.evaluate(key => localStorage.getItem(key), key)).toBeNull()
  await page.evaluate(() => (window as any).migrationFixture.navigate('/groups'))
  await page.getByRole('button', { name: 'Got it', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('uses the existing overlay theme and remains usable on narrow and RTL layouts', async ({ page }, testInfo) => {
  await openFixture(page)
  await ready(page)
  const dialog = page.getByRole('dialog', { name: '群聊即将下架' })
  await expect(dialog).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('migration-light-desktop.png'), fullPage: true, animations: 'disabled' })
  await page.evaluate(() => (window as any).migrationFixture.theme(true, true, 0.8))
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(dialog).toBeVisible()
  await expect(dialog).toHaveCSS('background-color', 'rgba(42, 42, 42, 0.8)')
  const bounds = await dialog.boundingBox()
  expect(bounds!.width).toBeLessThanOrEqual(390 - 32)
  await page.screenshot({ path: testInfo.outputPath('migration-dark-wallpaper-mobile.png'), fullPage: true, animations: 'disabled' })
  await page.evaluate(() => (window as any).migrationFixture.theme(false, true, 0))
  await expect(dialog).toBeVisible()
  await expect(dialog).toHaveCSS('background-color', 'rgba(255, 255, 255, 0)')
  await page.screenshot({ path: testInfo.outputPath('migration-zero-opacity.png'), fullPage: true, animations: 'disabled' })
  await page.evaluate(() => (window as any).migrationFixture.resetTheme())
  await expect(dialog).toHaveCSS('background-color', 'rgb(255, 255, 255)')
  await writeFile(testInfo.outputPath('theme-checks.json'), JSON.stringify({
    darkOverlay: 'rgba(42, 42, 42, 0.8)', zeroOverlay: 'rgba(255, 255, 255, 0)', resetOverlay: 'rgb(255, 255, 255)',
    mobileDialogWidth: bounds!.width,
  }, null, 2))
  await page.screenshot({ path: testInfo.outputPath('migration-theme-reset.png'), fullPage: true, animations: 'disabled' })
  await page.getByRole('button', { name: '知道了', exact: true }).click()
  await expect(dialog).toHaveCount(0)

  await page.evaluate(key => localStorage.removeItem(key), key)
  await openFixture(page, 'ar')
  await ready(page)
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(page.getByRole('dialog')).toContainText('Bot')
  await page.screenshot({ path: testInfo.outputPath('migration-arabic-mobile.png'), fullPage: true, animations: 'disabled' })
  await page.getByRole('button', { name: 'فهمت', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
})
