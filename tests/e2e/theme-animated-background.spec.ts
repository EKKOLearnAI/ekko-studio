import { readFile } from 'node:fs/promises'
import AdmZip from 'adm-zip'
import sharp from 'sharp'
import { expect, test, type Page, type Locator } from '@playwright/test'
import { authenticate, mockHermesApi } from './fixtures'
import { animatedThemeBackground, animatedThemeFormats } from '../fixtures/animated-theme-background'

async function expectAnimation(page: Page, surface: Locator, offset = { x: 10, y: 10 }) {
  await surface.scrollIntoViewIfNeeded()
  const box = (await surface.boundingBox())!
  const colors = new Set<string>()
  await expect.poll(async () => {
    const screenshot = await page.screenshot({ clip: { x: box.x + offset.x, y: box.y + offset.y, width: 4, height: 4 } })
    const { channels } = await sharp(screenshot).stats()
    if (channels[0].mean > channels[2].mean + 30) colors.add('red')
    if (channels[2].mean > channels[0].mean + 30) colors.add('blue')
    return colors.size
  }, { timeout: 8_000, intervals: [100] }).toBe(2)
}

for (const width of [1280, 390]) {
  for (const format of animatedThemeFormats) {
    test(`plays ${format.format} wallpapers after upload, cache reload and theme ZIP import at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 })
      await authenticate(page)
      const api = await mockHermesApi(page, { theme: { appearance: { global: { opacity: 0.2 }, regions: {} } } })
      const image = await animatedThemeBackground(format.format)
      const name = `motion.${format.format}`
      await page.goto('/#/hermes/theme')
      await page.locator('.file-input').setInputFiles({
        name, mimeType: format.format === 'gif' && width === 390 ? '' : format.mime, buffer: image,
      })
      await expect(page.locator('.background-name')).toHaveText(name)
      const preview = page.locator('.background-preview')
      await expectAnimation(page, preview)
      await expect(page.locator('.app-shell')).toHaveClass(/app-shell--custom-background/)
      await expectAnimation(page, page.locator('.app-shell'), { x: 2, y: 150 })
      const backgroundGets = () => api.requests.filter(request => request.method === 'GET' && request.pathname === '/api/theme/background').length
      const requestsBeforeReload = backgroundGets()
      await page.reload()
      await expect(page.locator('.background-name')).toHaveText(name)
      await expectAnimation(page, preview)
      expect(backgroundGets()).toBe(requestsBeforeReload)

      const downloadPromise = page.waitForEvent('download')
      await page.getByTestId('theme-export').click()
      const downloaded = await downloadPromise
      const archive = await readFile((await downloaded.path())!)
      const zip = new AdmZip(archive)
      expect(zip.readFile(`background.${format.extension}`)).toEqual(image)
      await page.getByTestId('theme-import-file').setInputFiles({ name: 'motion.zip', mimeType: 'application/zip', buffer: archive })
      await expect(page.getByTestId('theme-preset-theme-1')).toHaveAttribute('aria-pressed', 'true')
      await expect(page.locator('.background-name')).toHaveText(name)
      await expectAnimation(page, preview)
      expect(api.unexpectedRequests).toEqual([])
    })
  }
}

test('accepts animated files with missing or generic MIME and rejects unsupported file types', async ({ page }) => {
  await authenticate(page)
  const api = await mockHermesApi(page)
  const image = await animatedThemeBackground('gif')
  await page.goto('/#/hermes/theme')
  const input = page.locator('.file-input')
  for (const [index, mimeType] of ['', 'application/octet-stream'].entries()) {
    const name = `motion-${index}.GIF`
    await input.setInputFiles({ name, mimeType, buffer: image })
    await expect(page.locator('.background-name')).toHaveText(name)
  }
  const uploads = () => api.requests.filter(request => request.method === 'POST' && request.pathname === '/api/theme/background').length
  expect(uploads()).toBe(2)
  for (const file of [{ name: 'motion.bin', mimeType: '' }, { name: 'motion.gif', mimeType: 'image/svg+xml' }]) {
    await input.setInputFiles({ ...file, buffer: image })
    await expect(page.getByText('Use a PNG, JPEG, WebP, GIF, or APNG image').first()).toBeVisible()
    expect(uploads()).toBe(2)
  }
  expect(api.unexpectedRequests).toEqual([])
})

test('allows a 30 MiB wallpaper and rejects a file one byte larger before upload', async ({ page }) => {
  await authenticate(page)
  const api = await mockHermesApi(page)
  const image = await animatedThemeBackground('gif')
  await page.goto('/#/hermes/theme')
  const input = page.locator<HTMLInputElement>('.file-input')
  await expect(page.getByTestId('theme-library')).toHaveAttribute('aria-busy', 'false')
  async function selectFile(size: number, name: string) {
    await input.evaluate((element, file) => {
      const bytes = new Uint8Array(file.size)
      bytes.set(file.header)
      const transfer = new DataTransfer()
      transfer.items.add(new File([bytes], file.name, { type: 'image/gif' }))
      element.files = transfer.files
      element.dispatchEvent(new Event('change', { bubbles: true }))
    }, { size, name, header: Array.from(image) })
  }
  // Recording the full multipart upload can exceed the default UI assertion timeout in CI.
  const uploaded = page.waitForResponse(response =>
    new URL(response.url()).pathname === '/api/theme/background' && response.request().method() === 'POST')
  await selectFile(30 * 1024 * 1024, 'large.gif')
  expect((await uploaded).status()).toBe(200)
  await expect(page.locator('.background-name')).toHaveText('large.gif')
  const uploads = () => api.requests.filter(request => request.method === 'POST' && request.pathname === '/api/theme/background').length
  expect(uploads()).toBe(1)
  await selectFile(30 * 1024 * 1024 + 1, 'too-large.gif')
  await expect(page.getByText('Background images must be 30 MB or smaller')).toBeVisible()
  expect(uploads()).toBe(1)
  await expect(page.locator('.background-name')).toHaveText('large.gif')
  expect(api.unexpectedRequests).toEqual([])
})
