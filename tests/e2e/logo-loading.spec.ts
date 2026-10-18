import { expect, test, type Locator } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi } from './fixtures'

const pendingReleases = new Set<() => void>()
test.afterEach(() => {
  for (const release of pendingReleases) release()
  pendingReleases.clear()
})

async function sweepStyle(logo: Locator) {
  return logo.evaluate(element => {
    const style = getComputedStyle(element, '::after')
    return { name: style.animationName, duration: style.animationDuration, gradient: style.backgroundImage }
  })
}

test('loading older messages keeps the conversation available with a small spinner', async ({ page }) => {
  const session = { id: 'older-loading', profile: 'research', source: 'cli', title: 'Older messages', model: 'test-model', provider: 'test-provider', started_at: 1, last_active: 300, message_count: 300 }
  const messages = Array.from({ length: 150 }, (_, i) => ({ id: i + 151, role: 'user', content: `Recent message ${i + 151}`, timestamp: i + 151 }))
  await authenticate(page)
  await mockHermesApi(page, { sessions: [session] })
  await mockChatSocket(page)
  await page.addInitScript(({ sessionId, messages }) => {
    ;(window as any).__PW_CHAT_SOCKET_RESUMES__ = {
      [sessionId]: { session_id: sessionId, messages, isWorking: false, events: [], messageTotal: 300, messageLoadedCount: 150, hasMoreBefore: true },
    }
  }, { sessionId: session.id, messages })
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve; pendingReleases.add(resolve) })
  await page.route('**/api/studio/sessions/conversations/older-loading/messages/paginated?**', async route => {
    await pending
    await route.fulfill({ json: { session, messages: [{ id: 150, role: 'user', content: 'Older message loaded', timestamp: 150 }], total: 151, offset: 150, limit: 150, hasMore: false } })
  })
  await page.goto('/#/hermes/session/older-loading')
  await expect(page.locator('.chat-view')).toHaveAttribute('aria-busy', 'false', { timeout: 15000 })
  await expect(page.locator('#message-300')).toBeVisible()
  await page.locator('.input-textarea').fill('Keep my draft')
  await page.locator('.virtual-message-list').evaluate(element => { element.scrollTop = 0; element.dispatchEvent(new Event('scroll')) })
  const spinner = page.locator('.history-loader-spinner')
  await expect(spinner).toBeVisible()
  await expect(spinner).toHaveCSS('border-radius', '50%')
  await expect(page.locator('.chat-view')).toHaveAttribute('aria-busy', 'false', { timeout: 15000 })
  await expect(page.locator('.chat-view .studio-loading-logo')).toHaveCount(0)
  await expect(page.locator('.input-textarea')).toBeEnabled()
  await expect(page.locator('.input-textarea')).toHaveValue('Keep my draft')
  await page.screenshot({ path: '/tmp/studio-local-history-loading.png' })
  release()
  await expect(spinner).toHaveCount(0)
  await expect(page.locator('#message-150')).toBeAttached()
})

test('local table loading uses the original spinner and clears after a failed request', async ({ page }) => {
  await authenticate(page)
  await mockHermesApi(page)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve; pendingReleases.add(resolve) })
  let requests = 0
  await page.route('**/api/mcu-devices', async route => {
    if (++requests === 1) { await route.fulfill({ json: { devices: [] } }); return }
    await gate
    await route.fulfill({ status: 503, json: { error: 'Device list unavailable' } })
  })
  await page.goto('/#/hermes/connections?tab=mcu')
  await expect(page.locator('.chat-view')).toHaveAttribute('aria-busy', 'false', { timeout: 15000 })
  await page.locator('.mcu-devices-panel').getByRole('button', { name: 'Refresh', exact: true }).click()
  const loading = page.locator('.mcu-device-table .n-data-table-loading-wrapper')
  await expect(loading.locator('.n-base-loading')).toBeVisible()
  await expect(loading.locator('.studio-loading-logo')).toHaveCount(0)
  release()
  await expect(loading).toHaveCount(0)
  await expect(page.locator('.mcu-device-table')).toBeVisible()
})

for (const theme of ['light', 'dark']) {
  test(`startup, page and overlay share the logo sweep in ${theme} mode`, async ({ page }) => {
    await page.setViewportSize({ width: theme === 'light' ? 390 : 1280, height: 820 })
    await authenticate(page)
    await mockHermesApi(page)
    await page.route('**/api/hermes/write-gate/pending', route => route.fulfill({ json: { pending: [] } }))
    await page.addInitScript(value => localStorage.setItem('hermes_brightness', value), theme)
    let releaseBoot!: () => void
    let releaseSkills!: () => void
    const bootGate = new Promise<void>(resolve => { releaseBoot = resolve; pendingReleases.add(resolve) })
    const skillsGate = new Promise<void>(resolve => { releaseSkills = resolve; pendingReleases.add(resolve) })
    await page.route('**/src/main.ts', async route => { await bootGate; await route.continue() })
    await page.route(/\/api\/hermes\/skills(?:\?.*)?$/, async route => {
      await skillsGate
      await route.fulfill({ json: { categories: [], archived: [] } })
    })
    await page.goto('/#/hermes/skills', { waitUntil: 'commit' })
    const bootLogo = page.locator('.boot-fallback .studio-loading-logo')
    await expect(bootLogo).toBeVisible()
    await expect(bootLogo).toHaveCSS('width', '72px')
    const bootSweep = await sweepStyle(bootLogo)
    expect(bootSweep.name).toBe('studio-logo-shimmer')
    expect(bootSweep.duration).toBe('1.8s')
    releaseBoot()

    const pageLogo = page.locator('.skills-view > .page-loading-overlay .studio-loading-logo')
    await expect(pageLogo).toBeVisible()
    expect(await sweepStyle(pageLogo)).toEqual(bootSweep)
    await expect(pageLogo).toHaveCSS('width', '72px')
    await pageLogo.locator('img').evaluate(img => (img as HTMLImageElement).decode())
    expect(await pageLogo.locator('img').evaluate(img => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
    await page.screenshot({ path: `/tmp/studio-logo-loading-${theme}.png` })
    releaseSkills()
    await expect(page.locator('.skills-loading')).toHaveCount(0)

    let releaseDevices!: () => void
    const devicesGate = new Promise<void>(resolve => { releaseDevices = resolve; pendingReleases.add(resolve) })
    await page.route(/\/api\/devices(?:\?.*)?$/, async route => {
      await devicesGate
      await route.fulfill({ json: { scanning: false, last_scanned_at: null, devices: [], requests: [] } })
    })
    await page.goto('/#/hermes/devices')
    const overlay = page.locator('.chat-view')
    await expect(overlay).toHaveAttribute('aria-busy', 'true')
    const overlayLogo = overlay.locator('.studio-loading-logo')
    await expect(overlayLogo).toBeVisible()
    expect(await sweepStyle(overlayLogo)).toEqual(bootSweep)
    await expect(overlay.locator(':scope > .page-loading-content')).toHaveCount(1)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    expect((await sweepStyle(overlayLogo)).name).toBe('none')
    releaseDevices()
    await expect(overlay).toHaveAttribute('aria-busy', 'false')
    await expect(overlayLogo).toHaveCount(0)
  })
}
