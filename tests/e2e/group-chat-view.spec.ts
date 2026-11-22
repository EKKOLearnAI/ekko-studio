import { expect, test } from '@playwright/test'
import { resolve } from 'node:path'

for (const empty of [false, true]) {
  test(`opens group chat without a retirement notice ${empty ? 'with no rooms' : 'with existing rooms'}`, async ({ page }) => {
    const entry = '/@fs/' + resolve('tests/e2e/fixtures/group-chat-view.ts').replaceAll('\\', '/').replace(/^\//, '')
    const panel = '/@fs/' + resolve('tests/e2e/fixtures/group-chat-panel.ts').replaceAll('\\', '/').replace(/^\//, '')
    await page.route('**/components/hermes/group-chat/GroupChatPanel.vue*', route => route.fulfill({
      contentType: 'application/javascript',
      body: `export { default } from ${JSON.stringify(panel)}`,
    }))
    await page.route('**/__group_chat_view__*', route => route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html lang="zh"><head><meta charset="utf-8"></head><body><div id="app"></div><script type="module" src="${entry}"></script></body></html>`,
    }))
    await page.goto(`/__group_chat_view__${empty ? '?empty=1' : ''}`)
    await expect(page.getByTestId('group-panel')).toBeVisible()
    await expect(page.getByRole('dialog', { includeHidden: true })).toHaveCount(0)
  })
}
