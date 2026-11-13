import { test, expect, type Page } from '@playwright/test'
import { resolve } from 'node:path'

type SeenRequest = { path: string; profile: string | null; header: string | undefined }
const pageErrors = new WeakMap<Page, string[]>()
test.afterEach(async ({ page }) => { expect(pageErrors.get(page) || []).toEqual([]) })

async function openHistory(page: Page, options: { profile?: string; active?: string; deny?: 'groups' | 'messages' } = {}) {
  const errors: string[] = []
  pageErrors.set(page, errors)
  page.on('pageerror', error => errors.push(error.message))
  const requests: SeenRequest[] = []
  const active = options.active || 'default'
  await page.addInitScript(active => {
    ;(window as any).__APP_VERSION__ = 'fixture'
    localStorage.setItem('hermes_api_key', 'fixture-token')
    localStorage.setItem('hermes_active_profile_name', active)
    localStorage.setItem('hermes_locale', 'en')
  }, active)
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url())
    const path = url.pathname
    if (!path.startsWith('/api/')) { await route.continue(); return }
    if (path === '/api/auth/me') {
      await route.fulfill({ json: { user: { id: 1, username: 'fixture-user', role: 'user' } } })
      return
    }
    const profile = route.request().headers()['x-hermes-profile'] || url.searchParams.get('profile') || active
    if (path === '/api/hermes/profiles') {
      await route.fulfill({ json: { profiles: ['default', 'coder'].map(name => ({ name, alias: name, model: '', active: name === active })) } })
      return
    }
    if (path.startsWith('/api/studio/sessions/')) requests.push({ path, profile: url.searchParams.get('profile'), header: route.request().headers()['x-hermes-profile'] })
    const session = {
      id: `${profile}-session`, profile, source: 'coding_agent', agent: 'dsh',
      title: `${profile} fixture session`, model: 'fixture-model', started_at: 1000,
      ended_at: null, message_count: 1, input_tokens: 0, output_tokens: 0,
    }
    if (path === '/api/studio/sessions/hermes/groups') {
      await route.fulfill(options.deny === 'groups'
        ? { status: 403, json: { error: 'Profile is not available for this fixture user' } }
        : { json: { groups: [{ source: 'coding_agent', sessions: [session], hasMore: false }], included: [] } })
      return
    }
    if (path.includes('/messages/paginated')) {
      const matches = path.includes(`/${profile}-session/`)
      await route.fulfill(options.deny === 'messages' || !matches
        ? { status: options.deny ? 403 : 404, json: { error: 'Conversation not available' } }
        : { json: { session, messages: [{ id: 1, role: 'assistant', content: `${profile} fixture transcript`, timestamp: 1000 }], total: 1, offset: 0, limit: 150, hasMore: false, taskPlans: [], workspaceRunChanges: [] } })
      return
    }
    if (path.startsWith('/api/studio/sessions/hermes/')) {
      await route.fulfill({ status: 403, json: { error: 'Conversation not available' } })
      return
    }
    await route.fulfill({ json: {} })
  })
  const entry = '/@fs/' + resolve('tests/e2e/fixtures/history-profile.ts').replaceAll('\\', '/').replace(/^\//, '')
  await page.route('**/__history_profile__', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="app"></div><script type="module" src="${entry}"></script></body></html>` }))
  const profile = options.profile
  const session = profile?.trim() || active
  await page.goto(`/__history_profile__#/hermes/history/session/${session}-session${profile !== undefined ? `?profile=${encodeURIComponent(profile)}` : ''}`)
  return requests
}

test('opens an app-generated history link using its profile instead of the active profile', async ({ page }) => {
  const requests = await openHistory(page, { profile: 'coder' })
  await expect(page.getByText('coder fixture transcript', { exact: true })).toBeVisible()
  await expect(page).toHaveURL(/history\/session\/coder-session\?profile=coder$/)
  expect(requests.filter(request => request.path.includes('/groups') || request.path.includes('/messages/'))).toEqual([
    expect.objectContaining({ profile: 'coder', header: undefined }),
    expect.objectContaining({ profile: 'coder', header: undefined }),
  ])
  expect(await page.evaluate(() => localStorage.getItem('hermes_active_profile_name'))).toBe('default')
})

test('keeps a same-profile deep link working', async ({ page }) => {
  await openHistory(page, { profile: 'default' })
  await expect(page.getByText('default fixture transcript', { exact: true })).toBeVisible()
})

test('uses the active profile when the link has no explicit profile', async ({ page }) => {
  await openHistory(page)
  await expect(page.getByText('default fixture transcript', { exact: true })).toBeVisible()
})

test('keeps explicit history scope when the active profile changes', async ({ page }) => {
  await openHistory(page, { profile: 'coder', active: 'coder' })
  await expect(page.getByText('coder fixture transcript', { exact: true })).toBeVisible()
  await page.evaluate(() => { (window as any).historyProfileFixture.profiles.activeProfileName = 'default' })
  await expect(page).toHaveURL(/history\/session\/coder-session\?profile=coder$/)
  await expect(page.getByText('coder fixture transcript', { exact: true })).toBeVisible()
})

test('still follows active-profile changes for unscoped history', async ({ page }) => {
  await openHistory(page)
  await expect(page.getByText('default fixture transcript', { exact: true })).toBeVisible()
  await page.evaluate(() => { (window as any).historyProfileFixture.profiles.activeProfileName = 'coder' })
  await expect(page.getByText('coder fixture transcript', { exact: true })).toBeVisible()
})

for (const deny of ['groups', 'messages'] as const) {
  test(`does not expose a transcript when ${deny} access is denied`, async ({ page }) => {
    const requests = await openHistory(page, { profile: 'coder', active: 'coder', deny })
    await expect.poll(() => requests.some(request => deny === 'groups'
      ? request.path.endsWith('/groups') : request.path.includes('/messages/paginated'))).toBe(true)
    if (deny === 'messages') await expect(page.getByText('Session not found', { exact: true })).toBeVisible()
    else await expect(page).toHaveURL(/#\/hermes\/history$/)
    await expect(page.getByText('coder fixture transcript', { exact: true })).toHaveCount(0)
    await expect(page.getByText('default fixture transcript', { exact: true })).toHaveCount(0)
    expect(requests.every(request => request.profile !== null)).toBe(true)
  })
}
