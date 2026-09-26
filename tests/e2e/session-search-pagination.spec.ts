import { expect, test } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi } from './fixtures'

const session = {
  id: 'search-history', profile: 'research', source: 'cli', title: 'Long searchable conversation',
  model: 'test-model', provider: 'test-provider', preview: 'Long conversation',
  started_at: 1, last_active: 600, ended_at: null, message_count: 600, tool_call_count: 0,
  input_tokens: 0, output_tokens: 0,
}
for (const { path, hit, listed, total } of [
  { path: '/#/hermes/session/search-history', hit: 320, listed: true, total: 600 },
  { path: '/#/hermes/session/search-history', hit: 170, listed: true, total: 600 },
  { path: '/#/hermes/skills', hit: 170, listed: false, total: 600 },
  { path: '/#/hermes/session/search-history', hit: 50, listed: true, total: 1860 },
]) {
  test(`search focuses message ${hit} from ${path} (listed: ${listed})`, async ({ page }) => {
    const messages = Array.from({ length: total }, (_, i) => ({
      id: i + 1, session_id: session.id, role: i % 2 ? 'assistant' : 'user',
      content: `Historical message ${i + 1}` + (total > 600 && i % 3 === 0
        ? '\n\n' + 'A paragraph with variable height to exercise virtual row measurement.\n\n'.repeat(1 + i % 12)
        : ''),
      timestamp: i + 1,
    }))
    await authenticate(page)
    await page.addInitScript(({ sessionId, rows, total }) => {
      ;(window as any).__PW_CHAT_SOCKET_RESUMES__ = {
        [sessionId]: {
          session_id: sessionId, messages: rows, isWorking: false, events: [],
          messageTotal: total, messageLoadedCount: 150, hasMoreBefore: true,
        },
      }
    }, { sessionId: session.id, rows: messages.slice(-150), total })
    const api = await mockHermesApi(page, { sessions: listed ? [{ ...session, message_count: total }] : [] })
    await mockChatSocket(page)
    await page.route('**/api/hermes/write-gate/pending', route => route.fulfill({ json: { pending: [] } }))
    let selectedHit = hit
    const offsets: number[] = []
    let releasePage!: () => void
    const paginationGate = new Promise<void>(resolve => { releasePage = resolve })
    await page.route('**/api/studio/search/sessions?**', route => route.fulfill({
      json: { results: [{ ...session, snippet: `Historical message ${selectedHit}`, matched_message_id: selectedHit, rank: 1 }] },
    }))
    await page.route('**/api/studio/sessions/conversations/*/messages/paginated?**', async route => {
      const query = new URL(route.request().url()).searchParams
      expect(query.get('profile')).toBe('research')
      const offset = Number(query.get('offset'))
      const limit = Number(query.get('limit'))
      offsets.push(offset)
      const end = messages.length - offset
      const start = Math.max(0, end - limit)
      if (offset === 150 && listed) await paginationGate
      await route.fulfill({ json: {
        session, messages: messages.slice(start, end), total: messages.length,
        offset, limit, hasMore: start > 0,
      } })
    })

    await page.goto(path)
    if (listed) await expect(page.locator(`#message-${total}`)).toBeVisible()
    else await expect(page.getByRole('heading', { name: 'Skills', exact: true })).toBeVisible()

    const search = async (term: string) => {
      await page.keyboard.press('Control+k')
      await page.locator('.session-search-modal input').fill(term)
      await page.locator('.session-search-modal .result-item').filter({ hasText: `#${selectedHit}` }).click()
    }
    await search('Historical')
    const loading = page.locator('.message-search-loading')
    if (listed) {
      await expect(loading).toBeVisible()
      await expect(page.locator('.virtual-message-list-host')).toHaveCount(0)
      await loading.evaluate(async loader => {
        const spinner = loader.querySelector('.message-search-spinner')!
        const animation = spinner.getAnimations()[0]
        await animation.ready
        const startTime = animation.startTime
        const state = { continuous: true, hiddenDuringMount: false }
        ;(window as any).__searchSpinner = state
        const observer = new MutationObserver(() => {
          if (!loader.isConnected) {
            observer.disconnect()
            return
          }
          state.continuous &&= spinner.isConnected
            && spinner.getAnimations()[0] === animation
            && animation.startTime === startTime
          const transcript = loader.parentElement?.querySelector('.virtual-message-list-host')
          if (transcript) state.hiddenDuringMount = getComputedStyle(transcript).opacity === '0'
        })
        observer.observe(loader.parentElement!, { childList: true })
      })
      if (total === 1860) {
        // Verify Chromium actually accelerates this animation, so a busy
        // message-rendering main thread cannot pause the rotation.
        const cdp = await page.context().newCDPSession(page)
        let layers: Array<{ layerId: string; backendNodeId?: number }> = []
        cdp.on('LayerTree.layerTreeDidChange', event => { layers = event.layers || [] })
        await cdp.send('LayerTree.enable')
        const { root } = await cdp.send('DOM.getDocument')
        const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '.message-search-spinner' })
        const { node } = await cdp.send('DOM.describeNode', { nodeId })
        await expect.poll(async () => {
          const layer = layers.find(item => item.backendNodeId === node.backendNodeId)
          if (!layer) return []
          return (await cdp.send('LayerTree.compositingReasons', { layerId: layer.layerId })).compositingReasonIds
        }).toContain('ActiveTransformAnimation')
        await cdp.detach()
      }
      releasePage()
    }
    await expect(page).toHaveURL(/#\/hermes\/session\/search-history$/)
    // Normal positioning must finish through layout stability, before its 5 s failsafe.
    await expect(loading).toBeHidden({ timeout: 3500 })
    if (listed) {
      expect(await page.evaluate(() => (window as any).__searchSpinner)).toEqual({
        continuous: true, hiddenDuringMount: true,
      })
    }
    const target = page.locator(`#message-${hit}.highlight`)
    await expect(target).toBeInViewport()
    // Once revealed, no alignment retries or virtual size corrections may shake the hit.
    const positions = await target.evaluate(async element => {
      const positions: number[] = []
      for (let i = 0; i < 25; i++) {
        await new Promise(requestAnimationFrame)
        positions.push(element.getBoundingClientRect().top)
      }
      return positions
    })
    expect(Math.max(...positions) - Math.min(...positions)).toBeLessThanOrEqual(2)
    // Initial bottom-follow retries must not pull the viewport off the hit.
    await page.waitForTimeout(1500)
    await expect(target).toBeInViewport()
    expect(offsets).toContain(150)
    if (hit === 170) expect(offsets).toContain(300)

    selectedHit = 580
    await search('Recent')
    await expect(loading).toBeHidden({ timeout: 3500 })
    await expect(page.locator('#message-580.highlight')).toBeInViewport()
    expect(api.unexpectedRequests).toEqual([])
  })
}
