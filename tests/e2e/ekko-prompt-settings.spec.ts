import { expect, test } from '@playwright/test'
import { resolve } from 'node:path'

for (const width of [1280, 390]) {
  test(`long prompt close buttons stay reachable at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 })
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    const instructions = ['Long instruction '.repeat(80), '无空格中文长指令'.repeat(100), 'https://example.invalid/' + 'abcdef'.repeat(150), 'Line one\nLine two']
    let config: any = { runtime: {}, model: {}, tools: { approvals: {}, codeExec: {}, computerUse: {} }, delegation: {}, compression: {}, memory: {}, skills: {}, logging: {}, prompt: { instructions: [...instructions] } }
    const writes: any[] = []
    await page.route(url => url.pathname.startsWith('/api/'), async route => {
      if (new URL(route.request().url()).pathname !== '/api/ekko/config') return route.fulfill({ json: {} })
      if (route.request().method() === 'PUT') { config = route.request().postDataJSON().config; writes.push(structuredClone(config)) }
      return route.fulfill({ json: { ok: true, schemaVersion: 15, configPath: '/fixture/config.json', config } })
    })
    const entry = '/@fs/' + resolve('tests/e2e/fixtures/ekko-prompt-settings.ts').replace(/^\//, '')
    await page.route('**/__prompt_settings__', route => route.fulfill({ contentType: 'text/html', body: `<meta name="viewport" content="width=device-width,initial-scale=1"><div id="app"></div><script type="module" src="${entry}"></script>` }))
    await page.goto('/__prompt_settings__#/settings?tab=advanced')
    const tags = page.locator('.prompt-instructions .n-tag')
    await expect(tags).toHaveCount(4)
    for (const tag of await tags.all()) {
      const box = (await tag.boundingBox())!
      expect(box.width).toBeLessThanOrEqual(width - 20)
      expect(await tag.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
    }
    for (const close of await tags.locator('.n-tag__close').all()) {
      await close.scrollIntoViewIfNeeded()
      const box = (await close.boundingBox())!
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width).toBeLessThanOrEqual(width)
      await close.click({ trial: true })
    }
    expect(await page.locator('.ekko-settings-content').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath(`prompt-${width}.png`) })
    await tags.nth(1).locator('.n-tag__close').click()
    await expect(tags).toHaveCount(3)
    await expect.poll(() => writes.length).toBe(1)
    expect(writes[0].prompt.instructions).toEqual(instructions.filter((_, index) => index !== 1))
    await page.reload()
    await expect(tags).toHaveCount(3)
    expect(errors).toEqual([])
  })
}
