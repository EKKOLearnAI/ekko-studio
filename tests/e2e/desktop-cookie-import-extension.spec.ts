import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { chromium, expect, test } from '@playwright/test'
import { BrowserCookieDiscovery } from '../../packages/desktop/src/main/browser/browser-cookie-discovery'
import { BrowserCookieImport } from '../../packages/desktop/src/main/browser/browser-cookie-import'

test('real extension stages a synthetic Chrome cookie for Desktop review', async () => {
  const extension = resolve('extensions/ekko-studio-cookie-import-helper')
  const extensionId = createHash('sha256').update(Buffer.from(JSON.parse(readFileSync(resolve(extension, 'manifest.json'), 'utf8')).key, 'base64')).digest('hex').slice(0, 32)
    .replace(/[0-9a-f]/g, value => String.fromCharCode(97 + parseInt(value, 16)))
  const root = await mkdtemp(join(tmpdir(), 'ekko-extension-test-'))
  let applied: unknown
  const receiver = new BrowserCookieImport(async () => {
    applied = await receiver.take(true)
    return { imported: 1, failed: 0 }
  })
  const discovery = new BrowserCookieDiscovery()
  const context = await chromium.launchPersistentContext(root, {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  })
  try {
    await discovery.start(() => receiver.start('synthetic-profile'))
    await context.addCookies([{
      name: 'session-test', value: 'synthetic-only', domain: '.example.com', path: '/',
      secure: true, httpOnly: true, sameSite: 'Lax',
    }])
    const page = await context.newPage()
    await page.goto(`chrome-extension://${extensionId}/popup.html`)
    await expect(page.locator('#managerUrl, #token, header, footer')).toHaveCount(0)
    await expect(page.getByRole('button', { name: '扫描', exact: true })).toBeVisible()
    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(255, 255, 255)')
    await expect(page.locator('#toolbar')).toHaveCSS('border-top-width', '0px')
    await expect(page.locator('#domains')).not.toBeVisible()
    await page.locator('#scan').click()
    await page.locator('input[type=checkbox][value="example.com"]').check()
    await page.locator('#import').click()
    await expect(page.locator('#status')).toContainText('已导入 1 个 Cookie')
    expect(applied).toMatchObject({ profileId: 'synthetic-profile', cookies: [expect.objectContaining({ name: 'session-test', value: 'synthetic-only', sameSite: 'lax' })] })

  } finally {
    await context.close()
    await discovery.stop()
    await receiver.cancel()
    await rm(root, { recursive: true, force: true })
  }
})
