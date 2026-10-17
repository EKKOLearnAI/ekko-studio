import { readFile } from 'node:fs/promises'
import AdmZip from 'adm-zip'
import { expect, test } from '@playwright/test'
import { authenticate, mockHermesApi } from './fixtures'

for (const width of [1280, 390]) {
  test(`exports and imports theme ZIPs with settings and wallpaper at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 })
    await authenticate(page)
    const appearance = { global: { opacity: 0.4, gradientColor: '#244466' }, regions: { card: { radius: 14 }, sidebar: { opacity: 0.2 }, overlay: { blur: 8 } } }
    const api = await mockHermesApi(page, { theme: { brightness: 'dark', style: 'comic', fontSize: 18,
      textColor: '#ddeeff', accentColor: '#6699bb', appearance,
      background: { name: '夜空.png', mime: 'image/png', updatedAt: 1 } } })
    await page.goto('/#/hermes/theme')
    await page.getByTestId('theme-rename').click()
    await page.getByTestId('theme-name').locator('input').fill('夜空 Night glass')
    await page.getByTestId('theme-name-save').click()
    const downloadPromise = page.waitForEvent('download')
    await page.getByTestId('theme-export').click()
    const download = await downloadPromise
    expect(download.suggestedFilename()).toBe('夜空 Night glass.zip')
    const data = await readFile((await download.path())!)
    const zip = new AdmZip(data)
    const manifest = JSON.parse(zip.readAsText('theme.json'))
    expect(manifest.settings).toEqual({ brightness: 'dark', style: 'comic', fontSize: 18,
      textColor: '#ddeeff', accentColor: '#6699bb', appearance })
    expect(manifest.background).toEqual({ file: 'background.png', name: '夜空.png' })
    expect(zip.readFile('background.png')!.length).toBeGreaterThan(0)

    const fileChooser = page.waitForEvent('filechooser')
    await page.getByTestId('theme-import').click()
    await (await fileChooser).setFiles({ name: download.suggestedFilename(), mimeType: 'application/zip', buffer: data })
    const imported = page.getByTestId('theme-preset-theme-1')
    const original = page.getByTestId('theme-preset-theme-0')
    await expect(imported).toHaveAttribute('aria-pressed', 'true')
    await expect(original).toBeVisible()
    await expect(imported).toContainText('夜空 Night glass')
    await expect(page.locator('.background-name')).toHaveText('夜空.png')
    await page.reload()
    await expect(imported).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByLabel('Text color', { exact: true })).toHaveValue('#ddeeff')
    await expect(page.locator('html')).toHaveClass(/dark/)
    await expect(page.locator('html')).toHaveClass(/comic/)
    await original.click()
    await expect(original).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('theme-import')).toBeEnabled()
    await page.getByTestId('theme-scope').selectOption('card')
    await page.getByTestId('theme-card-radius').fill('4')
    await page.getByTestId('theme-card-radius').dispatchEvent('change')
    await imported.click()
    await expect(page.getByTestId('theme-card-radius')).toHaveValue('14')
    await expect(page.getByTestId('theme-import')).toBeEnabled()
    await expect(page.getByText('Failed to save theme')).not.toBeVisible()
    await page.getByTestId('theme-library').scrollIntoViewIfNeeded()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: `/tmp/studio-theme-zip-${width}.png` })
    await page.getByTestId('theme-import-file').setInputFiles({ name: 'broken.zip', mimeType: 'application/zip', buffer: Buffer.from('broken') })
    await expect(page.getByText('Could not import the theme. Check that the ZIP is a valid Studio theme.')).toBeVisible()
    await expect(imported).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('theme-import')).toBeEnabled()
    expect(api.requests.find(request => request.pathname === '/api/theme/presets/import')?.headers['content-type']).toBe('application/zip')
    await page.getByTestId('theme-import-file').setInputFiles({ name: 'theme.json', mimeType: 'application/json', buffer: Buffer.from('{}') })
    await expect(page.getByText('Choose a ZIP file no larger than 32 MB.')).toBeVisible()
    await page.route(/\/api\/theme\/presets\/[^/]+\/export(?:\?.*)?$/, route => route.fulfill({ status: 500, json: { error: 'Export unavailable' } }))
    await page.getByTestId('theme-export').click()
    await expect(page.getByText('Could not export the theme. Please try again.')).toBeVisible()
    await expect(page.getByTestId('theme-export')).toBeEnabled()
    await page.unroute(/\/api\/theme\/presets\/[^/]+\/export(?:\?.*)?$/)
    const retryDownload = page.waitForEvent('download')
    await page.getByTestId('theme-export').click()
    expect((await retryDownload).suggestedFilename()).toBe('夜空 Night glass.zip')
    expect(api.unexpectedRequests).toEqual([])
  })
}
