import { expect, test } from '@playwright/test'
import { containPage } from './fixtures/contained-page'
import { fakeChatRunSockets } from './fixtures/session-state-socket'

const sessions = [['1', 'Person'], ['second', 'Second']].map(([id, title]) => ({ id: `person-main-${id}`, title, workspace: `/fixture/${id}`,
  bot_type: 'dachu', profile: 'default', source: 'builtin_agent', agent: 'ekko-agent', agent_preset: 'person', agent_mode: 'scoped',
  history_revision: 0, started_at: 1, last_active: 1 }))

function personSnapshot(session: unknown) {
  return { session: session || null, settings: { model: { profile: 'default', provider: 'fixture', model: 'test-model' }, agents: [], workspace: '',
    timezone: 'UTC', maxSteps: 12, maxConcurrentTasks: 6, taskTimeoutMinutes: 60, compressionThreshold: null }, revision: 0, busy: false,
    history_revision: 0, can_clear: false, inherits_global_model: true, reasoning_efforts: [], compression: { enabled: false, threshold: .8, globalThreshold: .8 },
    contextTokens: 16000, tasks: [], active_tasks: [], active_agent_task_count: 0, schedules: [], memories: [], interactions: [], flows: [] }
}

test('Person marks the open conversation unread from its menu and reads it only when selected again', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    localStorage.setItem('hermes_locale', 'en'); localStorage.setItem('hermes_api_key', 'journey-key'); (window as any).__APP_VERSION__ = 'test'
  })
  await containPage(page, (path, _method) => {
    if (path === '/api/auth/me') return { user: { id: 1, username: 'playwright', role: 'super_admin', status: 'active' } }
    if (path.includes('/profiles')) return { profiles: [{ name: 'default', active: true }] }
    if (path === '/api/hermes/available-models') return { groups: [{ provider: 'fixture', models: ['test-model'], label: 'Fixture' }], allProviders: [], default: 'test-model', default_provider: 'fixture' }
    if (path === '/api/studio/person/conversations') return { sessions, next_offset: null }
    if (path.includes('/messages/paginated')) return { session: sessions[0], messages: [], total: 0, hasMore: false }
    return {}
  })
  // Person snapshots carry the requested conversation (query string), so answer them by session_id.
  await page.route(url => url.pathname === '/api/studio/person', route => {
    const id = new URL(route.request().url()).searchParams.get('session_id')
    return route.fulfill({ json: personSnapshot(sessions.find(session => session.id === id)) })
  })
  const sockets = await fakeChatRunSockets(page)
  await page.goto('/#/person?session=person-main-1')
  await expect(page.locator('.person-title')).toHaveText('Person')
  await expect.poll(sockets.connected).toBe(true)
  const read = { working: false, backgroundPending: 0, lastMessageId: 4, readMessageId: 4, unread: false, manualUnread: false, unreadRevision: 0, generation: 'g1' }
  sockets.publish({ sessionId: 'person-main-1', ...read })
  sockets.publish({ sessionId: 'person-main-second', ...read, working: true })
  const current = page.locator('.person-sidebar .session-item').filter({ hasText: 'Person' })
  const busy = page.locator('.person-sidebar .session-item').filter({ hasText: 'Second' })
  const option = page.locator('.n-dropdown-option:visible').filter({ hasText: 'Mark as unread' })

  // A working conversation offers no Mark as unread.
  await busy.click({ button: 'right' })
  await expect(page.locator('.n-dropdown-option:visible').filter({ hasText: 'Rename' })).toBeVisible()
  await expect(option).toHaveCount(0)
  await page.mouse.click(900, 250)
  await expect(page.locator('.n-dropdown-option:visible')).toHaveCount(0)

  await current.click({ button: 'right' })
  await option.click()
  await expect.poll(() => sockets.unreads.map(entry => entry.payload)).toEqual([{ sessionId: 'person-main-1', unreadRevision: 0, generation: 'g1' }])
  sockets.unreads[0].ack({ ok: true, changed: true })
  sockets.publish({ sessionId: 'person-main-1', ...read, unread: true, manualUnread: true, unreadRevision: 9 })
  await expect(current.locator('.session-item-unread-dot')).toBeVisible()
  await expect(page).toHaveURL(/session=person-main-1/)
  await expect(page.locator('.person-title')).toHaveText('Person')
  expect(sockets.reads).not.toContainEqual(expect.objectContaining({ sessionId: 'person-main-1' }))
  await page.screenshot({ path: testInfo.outputPath('person-manual-unread-open.png') })

  await current.click()
  await expect.poll(() => sockets.reads).toContainEqual({ sessionId: 'person-main-1', messageId: 4, unreadRevision: 9, generation: 'g1' })
  sockets.publish({ sessionId: 'person-main-1', ...read, unreadRevision: 9 })
  await expect(current.locator('.session-item-unread-dot')).toHaveCount(0)
})
