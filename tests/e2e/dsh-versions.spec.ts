import { expect, test } from '@playwright/test'
import { resolve } from 'node:path'

test('pins exact versions, uses latest, restores previous, and preserves the displayed installation on rejection', async ({ page }, testInfo) => {
  const requests: unknown[] = []
  let rejected = false
  await page.route('**/api/coding-agents/dsh/install', async route => {
    const options = route.request().postDataJSON(); requests.push(options)
    if (rejected) return route.fulfill({ json: { success: false, message: 'DSH candidate was not activated; previous installation preserved.' } })
    return route.fulfill({ json: { success: true, tools: [{ id: 'dsh', compatibility: { adapterRevision: 5,
      pinnedVersion: options.rollback ? '0.2.1-rc.5' : options.version === 'latest' ? '' : options.version,
      previousVersion: '0.2.2-rc.1', verifiedVersion: options.rollback ? '0.2.1-rc.5' : '0.2.2-rc.1' } }] } })
  })
  const entry = '/@fs/' + resolve('tests/e2e/fixtures/dsh-versions.ts').replaceAll('\\', '/').replace(/^\//, '')
  await page.route('**/__dsh_versions__', route => route.fulfill({ contentType: 'text/html', body: `<div id="app"></div><script type="module" src="${entry}"></script>` }))
  await page.goto('/__dsh_versions__')
  const pin = page.getByRole('button', { name: '安装并固定', exact: true })
  await expect(pin).toBeDisabled()
  await page.getByRole('textbox', { name: '精确 npm 版本（如 0.2.2-rc.1）' }).fill('0.2.2-rc.1')
  await pin.click()
  await expect(page.getByTestId('dsh-versions')).toContainText('固定版本：0.2.2-rc.1')
  await page.getByRole('button', { name: '检查并使用最新版' }).click()
  await expect(page.getByTestId('dsh-versions')).toContainText('固定版本：—')
  await page.getByRole('button', { name: '恢复 0.2.2-rc.1' }).click()
  await expect(page.getByTestId('dsh-versions')).toContainText('已验证安装：0.2.1-rc.5')
  expect(requests).toEqual([{ version: '0.2.2-rc.1' }, { version: 'latest' }, { rollback: true }])
  rejected = true
  await pin.click()
  await expect(page.getByRole('alert')).toContainText('previous installation preserved')
  await expect(page.getByTestId('dsh-versions')).toContainText('已验证安装：0.2.1-rc.5')
  await page.screenshot({ path: testInfo.outputPath('versions-light.png') })
  await page.evaluate(() => (window as any).dshFixture.theme(true, true))
  await expect(pin).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('versions-dark-wallpaper.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByRole('textbox')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})
