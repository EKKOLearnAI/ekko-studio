import { expect, test } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi } from './fixtures'

const pages = [
  ['/hermes/version-preview', '/api/studio/update/preview'],
  ['/hermes/global-agent', '/api/studio/sessions'],
  ['/studio/agents/codex/skills', '/api/hermes/skills'],
  ['/studio/agents/codex/settings', '/api/coding-agents/codex/config-files/config'],
  ['/studio/agents/dsh/presets', '/api/coding-agents/dsh/agent-presets'],
  ['/studio/agents/dsh/plugins', '/api/coding-agents/dsh/ui-session'],
  ['/hermes/models?tab=auxiliary', '/api/hermes/config/auxiliary-models'],
  ['/hermes/models?tab=tts', '/api/studio/tts/settings'],
  ['/hermes/jobs', '/api/hermes/jobs'],
  ['/hermes/profiles', '/api/hermes/profiles'],
  ['/hermes/usage', '/api/studio/usage/stats'],
  ['/hermes/performance', '/api/studio/performance/runtime'],
  ['/hermes/journey', '/api/hermes/journey'],
  ['/hermes/skills-usage', '/api/hermes/skills/usage/stats'],
  ['/hermes/skills', '/api/hermes/skills'],
  ['/hermes/plugins', '/api/hermes/plugins'],
  ['/hermes/mcp', '/api/hermes/mcp/servers'],
  ['/hermes/memory', '/api/hermes/memory'],
  ['/hermes/petdex', '/api/studio/petdex/manifest'],
  ['/hermes/settings', '/api/hermes/config'],
  ['/hermes/config/settings', '/api/hermes/config'],
  ['/hermes/channels', '/api/hermes/config'],
  ['/hermes/models', '/api/hermes/available-models'],
  ['/studio/agents', '/api/agents/status'],
  ['/hermes/kanban', '/api/hermes/kanban/boards'],
  ['/hermes/files', '/api/studio/files/list'],
  ['/ekko/memory', '/api/ekko/memory'],
  ['/ekko/skills', '/api/ekko/skills'],
  ['/ekko/mcp', '/api/ekko/mcp/servers'],
  ['/ekko/settings', '/api/ekko/config'],
  ['/hermes/connections?tab=mcu', '/api/mcu-devices'],
  ['/hermes/connections?tab=app&view=messages', '/api/social-messages/platforms'],
] as const

for (const [path, endpoint] of pages) {
  test(`fills the page with one 72px logo and releases failures: ${path}`, async ({ page }) => {
    await authenticate(page)
    await mockHermesApi(page)
    await mockChatSocket(page)
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    await page.route(url => url.pathname === endpoint, async route => {
      await pending
      await route.fulfill({ status: 503, json: { error: 'Page data unavailable' } })
    })
    await page.goto(`/#${path}`)
    const surface = page.locator('.app-main > .page-loading')
    const overlay = surface.locator(':scope > .page-loading-overlay')
    try {
      await expect(overlay).toBeVisible()
      await expect(surface.locator('.page-loading-overlay')).toHaveCount(1)
      const logo = overlay.locator('.studio-loading-logo')
      await expect(logo).toHaveCSS('width', '72px')
      await expect(logo).toHaveCSS('height', '72px')
      await expect.poll(() => overlay.evaluate(element => {
        const main = document.querySelector('.app-main')!.getBoundingClientRect()
        const box = element.getBoundingClientRect()
        return Math.max(...(['x', 'y', 'width', 'height'] as const).map(key => Math.abs(box[key] - main[key])))
      })).toBeLessThanOrEqual(1)
      await expect(surface.locator(':scope > .page-loading-content')).toHaveAttribute('inert', '')
    } finally { release() }
    await expect(overlay).toHaveCount(0)
    await expect(surface).toHaveAttribute('aria-busy', 'false')
  })
}

for (const width of [390, 1280]) {
  test(`fast page requests keep the logo for at least a second at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 820 })
    await authenticate(page)
    await mockHermesApi(page)
    await page.addInitScript(() => {
      let appeared = 0
      ;(window as any).__loadingDurations = []
      const observer = new MutationObserver(() => {
        const visible = !!document.querySelector('.app-main > .page-loading > .page-loading-overlay')
        if (visible && !appeared) appeared = performance.now()
        else if (!visible && appeared) {
          ;(window as any).__loadingDurations.push(performance.now() - appeared)
          appeared = 0
        }
      })
      observer.observe(document, { childList: true, subtree: true })
    })
    await page.goto('/#/hermes/skills')
    await expect(page.locator('.skills-view')).toHaveAttribute('aria-busy', 'false')
    const durations = await page.evaluate(() => (window as any).__loadingDurations as number[])
    expect(durations).toHaveLength(1)
    expect(durations[0]).toBeGreaterThanOrEqual(1000)
    expect(durations[0]).toBeLessThan(2500)
    await page.screenshot({ path: `/tmp/studio-page-ready-${width}.png` })
  })
}
