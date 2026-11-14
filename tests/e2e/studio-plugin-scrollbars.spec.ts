import { expect, test } from '@playwright/test'
import { resolve } from 'node:path'
import { writeFile } from 'node:fs/promises'

test('plugin documents and inner scrollers follow the regular page theme without losing scrolling', async ({ page }, testInfo) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const plugins = Array.from({ length: 30 }, (_, index) => ({
    manifest: { id: `scroll-${index}`, name: `Scroll demo ${index}`, version: '1.0.0', apiVersion: 1,
      client: 'client.mjs', permissions: ['ui'], views: [{ id: 'home', title: 'Scroll', slot: 'page' }] },
    status: 'active', enabled: true, config: {}, tools: [], commands: [], actions: [],
  }))
  const source = `export function mount(root) {
    root.innerHTML = '<h2>Plugin scrolling</h2><div id="inner" tabindex="0" style="height:100px;overflow:auto;border:1px solid var(--border-color)"><div style="width:1600px;height:500px">Nested scrolling</div></div><textarea aria-label="Long text" rows="3"></textarea><div style="height:1500px">Long content</div><button id="end">End of plugin</button>';
    root.querySelector('textarea').value = Array.from({length:40},(_,i)=>'Line '+i).join('\\n');
  }`
  await page.route(url => url.pathname.startsWith('/api/'), route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/auth/me') return route.fulfill({ json: { user: { id: 1, username: 'Tester', role: 'super_admin' } } })
    if (path === '/api/studio/plugins') return route.fulfill({ json: { revision: 1, plugins } })
    if (path.endsWith('/client')) return route.fulfill({ json: { source } })
    if (path.endsWith('/events')) return route.fulfill({ json: { cursor: 0, generation: 'scrollbars', events: [] } })
    return route.fulfill({ json: {} })
  })
  const entry = '/@fs/' + resolve('tests/e2e/fixtures/studio-plugins.ts').replace(/^\//, '')
  await page.route('**/__plugin_scrollbars__', route => route.fulfill({ contentType: 'text/html',
    body: `<div id="app"></div><script type="module" src="${entry}"></script>` }))
  await page.goto('/__plugin_scrollbars__')
  await expect(page.locator('.plugin-card')).toHaveCount(30)
  const regular = page.locator('.center-scroll')
  const scrollbar = (element: Element) => {
    const style = getComputedStyle(element)
    return { width: style.scrollbarWidth, color: style.scrollbarColor,
      track: getComputedStyle(element, '::-webkit-scrollbar-track').backgroundColor,
      thumb: getComputedStyle(element, '::-webkit-scrollbar-thumb').backgroundColor,
      radius: getComputedStyle(element, '::-webkit-scrollbar-thumb').borderRadius }
  }
  const regularStyle = await regular.evaluate(scrollbar)
  await regular.hover()
  await page.mouse.wheel(0, 300)
  await expect.poll(() => regular.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
  await page.screenshot({ path: testInfo.outputPath('regular-light.png') })
  await page.evaluate(() => (window as any).pluginFixture.navigate('/studio/plugins/scroll-0/home'))
  const hostFrame = page.locator('.plugin-workspace iframe')
  const frame = page.frameLocator('.plugin-workspace iframe')
  await expect(frame.locator('#end')).toBeAttached()
  await page.mouse.move(0, 0)
  const frameRoot = frame.locator('html'), inner = frame.locator('#inner'), textarea = frame.locator('textarea')
  const initial = { regular: regularStyle, outer: await page.locator('.workspace-content').evaluate(scrollbar),
    document: await frameRoot.evaluate(scrollbar), inner: await inner.evaluate(scrollbar), textarea: await textarea.evaluate(scrollbar) }
  await writeFile(testInfo.outputPath('initial-styles.json'), JSON.stringify(initial, null, 2))
  await page.screenshot({ path: testInfo.outputPath('plugin-light.png') })
  expect(initial.document).toEqual(regularStyle)
  expect(initial.inner).toEqual(regularStyle)
  expect(initial.textarea).toEqual(regularStyle)
  expect(initial.outer).toEqual(regularStyle)
  await expect(page.locator('iframe')).toHaveAttribute('sandbox', 'allow-scripts')
  expect(await frameRoot.evaluate(() => {
    try { void parent.document; return false } catch { return true }
  })).toBe(true)
  // The document owns the long page; the outer wrapper only scrolls when its layout needs it.
  expect(await page.locator('.workspace-content').evaluate(element => element.scrollHeight <= element.clientHeight)).toBe(true)
  await inner.focus()
  await page.keyboard.press('ArrowDown')
  await expect.poll(() => inner.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
  await page.keyboard.press('ArrowRight')
  await expect.poll(() => inner.evaluate(element => element.scrollLeft)).toBeGreaterThan(0)
  await textarea.focus()
  await page.keyboard.press('ControlOrMeta+End')
  await expect.poll(() => textarea.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
  await frame.getByRole('heading').hover()
  await page.mouse.wheel(0, 500)
  await expect.poll(() => frameRoot.evaluate(() => document.scrollingElement!.scrollTop)).toBeGreaterThan(0)
  await frame.locator('#end').focus()
  await expect(frame.locator('#end')).toBeInViewport()

  await page.mouse.move(0, 0)
  await page.evaluate(() => (window as any).pluginFixture.theme(true))
  await expect.poll(() => frameRoot.evaluate(scrollbar)).toEqual(await hostFrame.evaluate(scrollbar))
  const darkStyle = await frameRoot.evaluate(scrollbar)
  expect(darkStyle.color).not.toBe(regularStyle.color)
  await frameRoot.evaluate(() => window.scrollTo(0, 0))
  await page.screenshot({ path: testInfo.outputPath('plugin-dark.png') })
  await page.evaluate(() => {
    const fixture = (window as any).pluginFixture
    fixture.wallpaper(true)
    fixture.appearance({ brightness: 'dark', appearance: { global: { opacity: .6, radius: 9 },
      regions: { card: { opacity: 0, radius: 20, blur: 4, backgroundColor: '#315a76' } } } })
  })
  await page.mouse.move(0, 0)
  const outer = page.locator('.workspace-content')
  // A transparent frame wrapper inherits its containing surface instead of adding a card region.
  await expect.poll(() => frameRoot.evaluate(scrollbar)).toEqual(await hostFrame.evaluate(scrollbar))
  await expect.poll(() => inner.evaluate(scrollbar)).toEqual(await hostFrame.evaluate(scrollbar))
  const regionalStyle = await frameRoot.evaluate(scrollbar)
  expect(regionalStyle).toEqual(await outer.evaluate(scrollbar))
  await writeFile(testInfo.outputPath('theme-styles.json'), JSON.stringify({ dark: darkStyle,
    card: regionalStyle, outer: await outer.evaluate(scrollbar) }, null, 2))
  await frameRoot.evaluate(() => window.scrollTo(0, 0))
  await page.screenshot({ path: testInfo.outputPath('plugin-dark-wallpaper.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(frame.locator('#end')).toBeAttached()
  await inner.focus()
  await frame.locator('#end').focus()
  await expect(frame.locator('#end')).toBeInViewport()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('plugin-dark-narrow.png') })
  await page.setViewportSize({ width: 640, height: 320 })
  expect(await outer.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(false)
  await inner.focus()
  await frame.locator('#end').focus()
  await expect(frame.locator('#end')).toBeInViewport()
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.mouse.move(0, 0)
  await page.evaluate(async () => {
    const fixture = (window as any).pluginFixture
    await fixture.theme(false)
    fixture.appearance({ brightness: 'light', appearance: { global: { opacity: .65 },
      regions: { card: { opacity: .4, radius: 12, blur: 0 } } } })
  })
  await expect.poll(() => frameRoot.evaluate(scrollbar)).toEqual(await hostFrame.evaluate(scrollbar))
  await frameRoot.evaluate(() => window.scrollTo(0, 0))
  await page.screenshot({ path: testInfo.outputPath('plugin-light-wallpaper.png') })
  await page.evaluate(async () => {
    const fixture = (window as any).pluginFixture
    await fixture.theme(false)
    fixture.wallpaper(false)
    fixture.appearance({ brightness: 'light', appearance: { global: {}, regions: {} } })
  })
  await expect.poll(() => frameRoot.evaluate(scrollbar)).toEqual(regularStyle)
  expect(errors).toEqual([])
})
