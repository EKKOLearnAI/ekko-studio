import { expect, test } from '@playwright/test'
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { nativeDeviceHtml } from '../../packages/desktop/src/main/native-device-html'

// Keep the real localized labels; only Electron's locale lookup is synthetic.
const require = createRequire(resolve('package.json'))
const labelsModule = { exports: {} as { nativeDeviceLabels?: (locale: string) => Record<string, string> } }
const labelsCode = buildSync({ entryPoints: [resolve('packages/desktop/src/main/native-device-messages.ts')], bundle: true, platform: 'node', format: 'cjs', external: ['electron'], write: false }).outputFiles[0]!.text
runInNewContext(labelsCode, { module: labelsModule, exports: labelsModule.exports,
  require: (name: string) => name === 'electron' ? { app: { getLocale: () => 'en' } } : require(name) })
const labels = labelsModule.exports.nativeDeviceLabels!('zh')

test('the local manager offers a keyboard-accessible exit and keeps checking protected', async ({ page }, info) => {
  await page.addInitScript(({ labels }) => {
    let changed = () => {}
    const state = { state: { devices: [], activeDeviceId: null, activeServerUrl: null }, labels, locale: 'zh', busy: false, failed: false, menuOpen: false, appearance: { scheme: 'light', values: { text: '#222222', secondary: '#555555', accent: '#222222', onAccent: '#ffffff', background: '#ffffff', card: '#f5f5f5', input: '#ffffff', border: '#cccccc', cardBorder: '#dddddd', inputBorder: '#cccccc' } }, operation: null }
    const fixture = { dismissals: 0, update(patch: Record<string, unknown>) { Object.assign(state, patch); changed() } }
    Object.assign(window, { deviceFixture: fixture, studioDevices: {
      state: async () => state,
      onChange: (callback: () => void) => { changed = callback; return () => {} },
      dismiss: async () => { fixture.dismissals++ },
    } })
  }, { labels })
  const open = () => page.goto('data:text/html;charset=utf-8,' + encodeURIComponent(nativeDeviceHtml('manager')))
  await page.setViewportSize({ width: 680, height: 620 })
  await open()
  const close = page.getByRole('button', { name: labels.close, exact: true })
  await expect(close).toBeVisible()
  await close.focus()
  await page.keyboard.press('Enter')
  await expect.poll(() => page.evaluate(() => (window as any).deviceFixture.dismissals)).toBe(1)
  await page.screenshot({ path: info.outputPath('manager-light.png') })

  await open()
  await page.evaluate(() => (window as any).deviceFixture.update({ busy: true, state: { devices: [{ id: 'fixture', name: 'Synthetic remote', serverUrl: 'https://fixture.invalid' }], activeDeviceId: null, activeServerUrl: null } }))
  await expect(close).toBeDisabled()
  await page.keyboard.press('Escape')
  expect(await page.evaluate(() => (window as any).deviceFixture.dismissals)).toBe(0)
  await page.evaluate(() => (window as any).deviceFixture.update({ busy: false, failed: true,
    appearance: { scheme: 'dark', values: { text: '#eeeeee', secondary: '#bbbbbb', accent: '#eeeeee', onAccent: '#111111', background: 'rgb(20 20 20 / 0)', card: 'rgb(30 30 30 / 0.4)', border: 'rgb(255 255 255 / 0.2)' } } }))
  await page.setViewportSize({ width: 460, height: 540 })
  await expect(close).toBeEnabled()
  const box = await close.boundingBox()
  expect(box && box.x >= 0 && box.x + box.width <= 460).toBeTruthy()
  await page.screenshot({ path: info.outputPath('manager-dark-narrow-error.png') })
  await page.keyboard.press('Escape')
  await expect.poll(() => page.evaluate(() => (window as any).deviceFixture.dismissals)).toBe(1)
})
