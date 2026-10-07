import { expect, test, type Page } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi } from './fixtures'

function gate() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

async function expectCovered(page: Page, selector: string) {
  const surface = page.locator(selector)
  const overlay = surface.locator(':scope > .page-loading-overlay')
  await expect(overlay.locator('.studio-loading-logo')).toBeVisible()
  await expect(surface).toHaveAttribute('aria-busy', 'true')
  await expect(surface.locator(':scope > .page-loading-content')).toHaveAttribute('inert', '')
  await expect(surface.locator(':scope > .page-loading-content')).not.toBeVisible()
  const bounds = await surface.evaluate(element => {
    const a = element.getBoundingClientRect()
    const b = element.querySelector('.page-loading-overlay')!.getBoundingClientRect()
    return Math.max(Math.abs(a.width - b.width), Math.abs(a.height - b.height))
  })
  expect(bounds).toBeLessThanOrEqual(1)
}

test('single chat covers its first load and keeps session switches uncovered', async ({ page }) => {
  await authenticate(page)
  await mockChatSocket(page)
  const session = { id: 'slow-chat', title: 'Slow chat', profile: 'research', source: 'cli', model: 'test-model', provider: 'test-provider', started_at: 1, last_active: 2, message_count: 1 }
  await mockHermesApi(page, { sessions: [session, { ...session, id: 'next-chat', title: 'Next chat' }] })
  const profiles = gate()
  const sessions = gate()
  const categories = gate()
  await page.route('**/api/hermes/profiles', async route => { await profiles.promise; await route.fallback() })
  await page.route(/\/api\/studio\/sessions(?:\?.*)?$/, async route => { await sessions.promise; await route.fallback() })
  await page.route('**/api/studio/session-categories', async route => { await categories.promise; await route.fallback() })
  await page.goto('/#/hermes/session/slow-chat')
  await expectCovered(page, '.chat-view')
  await page.screenshot({ path: '/tmp/studio-full-page-loading-chat.png' })
  profiles.release()
  await expectCovered(page, '.chat-view')
  sessions.release()
  await page.waitForFunction(() => (window as any).__PW_CHAT_SOCKET__?.emitted.some((item: any) => item.event === 'resume' && item.payload.session_id === 'slow-chat'))
  await expectCovered(page, '.chat-view')
  await page.evaluate(() => (window as any).__PW_CHAT_SOCKET__.latest.__trigger('resumed', {
    session_id: 'slow-chat', isWorking: false,
    messages: [{ id: 'ready-message', role: 'user', content: 'Fully loaded conversation', timestamp: 1 }],
    messageTotal: 1, messageLoadedCount: 1, hasMoreBefore: false,
  }))
  await expectCovered(page, '.chat-view')
  categories.release()
  await expect(page.locator('.chat-view > .page-loading-overlay')).toHaveCount(0)
  await expect(page.getByText('Fully loaded conversation', { exact: true })).toBeVisible()
  await page.locator('.input-textarea').fill('Keep my draft')
  // Ordinary generation is independent of initial page readiness.
  await expect(page.locator('.chat-view')).toHaveAttribute('aria-busy', 'false')

  await page.locator('.session-items').getByText('Next chat', { exact: true }).first().click()
  await page.waitForFunction(() => (window as any).__PW_CHAT_SOCKET__?.emitted.some((item: any) => item.event === 'resume' && item.payload.session_id === 'next-chat'))
  await expect(page.locator('.chat-view > .page-loading-overlay')).toHaveCount(0)
  await expect(page.locator('.chat-view > .page-loading-content')).not.toHaveAttribute('inert', '')
  await page.evaluate(() => (window as any).__PW_CHAT_SOCKET__.latest.__trigger('resumed', {
    session_id: 'next-chat', isWorking: false,
    messages: [{ id: 'next-message', role: 'user', content: 'Next conversation loaded', timestamp: 1 }],
    messageTotal: 1, messageLoadedCount: 1, hasMoreBefore: false,
  }))
  await expect(page.getByText('Next conversation loaded', { exact: true })).toBeVisible()
  await expect(page.locator('.chat-view > .page-loading-overlay')).toHaveCount(0)
})

test('group chat covers initial room data and keeps failed or stale room switches uncovered', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await authenticate(page)
  await mockHermesApi(page)
  await mockChatSocket(page)
  const rooms = ['alpha', 'beta'].map(id => ({ id, name: `Room ${id}`, canManage: true, workspace: '/tmp/group', summaryProfile: 'research', summaryProvider: 'test-provider', summaryModel: 'test-model', summaryEveryTurns: 20 }))
  const list = gate()
  const detail = gate()
  const failed = gate()
  const stale = gate()
  let betaRequests = 0
  await page.route(/\/api\/studio\/group-chat\/rooms(?:\?.*)?$/, async route => { await list.promise; await route.fulfill({ json: { rooms } }) })
  await page.route(/\/api\/studio\/group-chat\/rooms\/alpha(?:\?.*)?$/, async route => {
    await detail.promise
    await route.fulfill({ json: { room: rooms[0], messages: [], agents: [], members: [], total: 0, hasMore: false } })
  })
  await page.route(/\/api\/studio\/group-chat\/rooms\/beta(?:\?.*)?$/, async route => {
    betaRequests++
    if (betaRequests > 1) {
      await stale.promise
      await route.fulfill({ json: { room: rooms[1], messages: [], agents: [], members: [], total: 0, hasMore: false } })
      return
    }
    await failed.promise
    await route.fulfill({ status: 503, json: { error: 'Room unavailable' } })
  })
  await page.goto('/#/hermes/group-chat/room/alpha')
  await expectCovered(page, '.group-chat-view')
  list.release()
  await expectCovered(page, '.group-chat-view')
  detail.release()
  await expect(page.locator('.group-chat-view > .page-loading-overlay')).toHaveCount(0)
  await expect(page.locator('.room-title-text')).toContainText('Room alpha')
  await page.evaluate(() => { location.hash = '#/hermes/group-chat/room/beta' })
  await expect.poll(() => betaRequests).toBe(1)
  await expect(page.locator('.group-chat-view > .page-loading-overlay')).toHaveCount(0)
  await expect(page.locator('.group-chat-view > .page-loading-content')).not.toHaveAttribute('inert', '')
  failed.release()
  await expect(page.locator('.group-chat-view > .page-loading-overlay')).toHaveCount(0)
  await expect(page.locator('.group-chat-view')).toHaveAttribute('aria-busy', 'false')
  // Returning to the previous room must invalidate a pending join to another room.
  await page.evaluate(() => { location.hash = '#/hermes/group-chat/room/alpha' })
  await expect(page.locator('.group-chat-view')).toHaveAttribute('aria-busy', 'false')
  await page.evaluate(() => { location.hash = '#/hermes/group-chat/room/beta' })
  await expect.poll(() => betaRequests).toBe(2)
  await expect(page.locator('.group-chat-view > .page-loading-overlay')).toHaveCount(0)
  await page.evaluate(() => { location.hash = '#/hermes/group-chat/room/alpha' })
  await expect(page.locator('.group-chat-view > .page-loading-overlay')).toHaveCount(0)
  const staleResponse = page.waitForResponse(response => response.url().includes('/rooms/beta') && response.status() === 200)
  stale.release()
  await staleResponse
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())))
  await expect(page.locator('.room-title-text')).toHaveText('Room alpha')
})

test('workflow waits for initial data and keeps its canvas uncovered when switching workflows', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('hermes_brightness', 'dark'))
  await authenticate(page)
  await mockChatSocket(page)
  const workflow = {
    id: 'slow-flow', name: 'Slow flow', profile: 'research', workspace: null,
    nodes: [{ id: 'agent-1', type: 'agent', position: { x: 80, y: 80 }, data: { title: 'Ready node', agent: 'hermes', input: 'Hello', skills: [], images: [] } }],
    edges: [], viewport: { x: 80, y: 80, zoom: .75 }, created_at: 1, updated_at: 1,
  }
  await mockHermesApi(page, { workflows: [workflow, {
    ...workflow, id: 'next-flow', name: 'Next flow',
    nodes: [{ ...workflow.nodes[0], data: { ...workflow.nodes[0].data, title: 'Next node' } }],
  }] })
  const definitions = gate()
  const skills = gate()
  const runs = gate()
  const nextRuns = gate()
  let requestedRuns = false
  let requestedNextRuns = false
  await page.route(/\/api\/studio\/workflows(?:\?.*)?$/, async route => { await definitions.promise; await route.fallback() })
  await page.route(/\/api\/hermes\/skills(?:\?.*)?$/, async route => { await skills.promise; await route.fallback() })
  await page.route(/\/api\/studio\/workflows\/slow-flow\/runs(?:\?.*)?$/, async route => { requestedRuns = true; await runs.promise; await route.fallback() })
  await page.route(/\/api\/studio\/workflows\/next-flow\/runs(?:\?.*)?$/, async route => { requestedNextRuns = true; await nextRuns.promise; await route.fallback() })
  await page.goto('/#/hermes/workflow')
  await expectCovered(page, '.workflow-view')
  await page.screenshot({ path: '/tmp/studio-full-page-loading-workflow.png' })
  definitions.release()
  await expect.poll(() => requestedRuns).toBe(true)
  await expectCovered(page, '.workflow-view')
  skills.release()
  await expectCovered(page, '.workflow-view')
  runs.release()
  await expect(page.locator('.workflow-view > .page-loading-overlay')).toHaveCount(0)
  await expect(page.locator('.vue-flow__node').getByRole('textbox', { name: 'Node name' })).toHaveValue('Ready node')
  await expect(page.locator('.workflow-view')).toHaveAttribute('aria-busy', 'false')
  await page.locator('.workflow-list-item').filter({ hasText: 'Next flow' }).click()
  await expect.poll(() => requestedNextRuns).toBe(true)
  await expect(page.locator('.workflow-view > .page-loading-overlay')).toHaveCount(0)
  await expect(page.locator('.workflow-view > .page-loading-content')).not.toHaveAttribute('inert', '')
  nextRuns.release()
  await expect(page.locator('.vue-flow__node').getByRole('textbox', { name: 'Node name' })).toHaveValue('Next node')
  await expect(page.locator('.workflow-view > .page-loading-overlay')).toHaveCount(0)
})
