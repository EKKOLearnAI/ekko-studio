import { test, expect, type Page, type Route } from '@playwright/test'
import { resolve } from 'node:path'

type SeenRequest = { path: string; profile: string | null; header?: string }
const pageErrors = new WeakMap<Page, string[]>()
test.afterEach(async ({ page }) => expect(pageErrors.get(page) || []).toEqual([]))

async function openHistory(page: Page, options: { active?: string; scoped?: boolean; list?: boolean; second?: boolean; failHermesSwitch?: boolean } = {}) {
  const active = options.active || 'default'
  let hermesActive = active
  const errors: string[] = []
  pageErrors.set(page, errors)
  page.on('pageerror', error => errors.push(error.message))
  const requests: SeenRequest[] = []
  await page.addInitScript(active => {
    ;(window as any).__APP_VERSION__ = 'fixture'
    localStorage.setItem('hermes_api_key', 'fixture-token')
    // The real selector reloads the page after persisting the new active profile.
    if (!localStorage.getItem('hermes_active_profile_name')) localStorage.setItem('hermes_active_profile_name', active)
    localStorage.setItem('hermes_locale', 'en')
  }, active)
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url())
    const path = url.pathname
    if (!path.startsWith('/api/')) return route.continue()
    if (path === '/api/auth/me') return route.fulfill({ json: { user: { id: 1, username: 'fixture-user', role: 'user' } } })
    if (path === '/api/agents/status') return route.fulfill({ json: { agents: [] } })
    if (path === '/api/hermes/profiles/active') {
      if (options.failHermesSwitch) return route.fulfill({ status: 500, json: { error: 'fixture switch failed' } })
      hermesActive = route.request().postDataJSON().name
      return route.fulfill({ json: {} })
    }
    if (path === '/api/hermes/profiles') return route.fulfill({ json: {
      profiles: ['default', 'coder'].map(name => ({ name, alias: name, model: '', active: name === hermesActive })),
    } })
    if (path === '/api/hermes/profiles/runtime-statuses') return route.fulfill({ json: { profiles: [], refreshing: false } })
    const header = route.request().headers()['x-hermes-profile']
    const profile = header || url.searchParams.get('profile') || active
    if (path.startsWith('/api/studio/sessions/')) requests.push({ path, profile: url.searchParams.get('profile'), header })
    const session = {
      id: `${profile}-session`, profile, source: 'coding_agent', agent: 'dsh',
      title: `${profile} fixture session`, started_at: 1000, ended_at: null,
      message_count: 1, input_tokens: 0, output_tokens: 0,
    }
    const second = { ...session, id: `${profile}-second`, title: `${profile} second session` }
    if (path === '/api/studio/sessions/hermes/groups') return route.fulfill({ json: {
      groups: [{ source: 'coding_agent', sessions: [session, second], hasMore: false }], included: [],
    } })
    if (path.includes('/messages/paginated')) return route.fulfill(path.includes(`/${profile}-session/`) || path.includes(`/${profile}-second/`)
      ? { json: { session: path.includes('-second/') ? second : session, messages: [{ id: 1, role: 'assistant', content: `${profile} ${path.includes('-second/') ? 'second' : 'fixture'} transcript`, timestamp: 1000 }], total: 1, offset: 0, limit: 150, hasMore: false, taskPlans: [], workspaceRunChanges: [] } }
      : { status: 404, json: { error: 'Conversation not found' } })
    return route.fulfill({ json: {} })
  })
  const entry = '/@fs/' + resolve('tests/e2e/fixtures/history-navigation.ts').replaceAll('\\', '/').replace(/^\//, '')
  await page.route('**/__history_navigation__', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="app"></div><script type="module" src="${entry}"></script></body></html>` }))
  await page.goto(`/__history_navigation__#/hermes/history${options.list ? '' : `/session/${active}-${options.second ? 'second' : 'session'}`}${options.scoped ? `?profile=${active}` : ''}`)
  await expect(page.getByText(`${active} ${options.second ? 'second' : 'fixture'} transcript`, { exact: true })).toBeVisible()
  return requests
}

async function switchWithSelector(page: Page, profile: string) {
  await page.getByTestId('profile-selector-select').click()
  const row = page.locator('.profile-runtime-item').filter({ has: page.locator('.profile-runtime-name', { hasText: profile }) })
  await row.getByRole('button', { name: 'Switch Frontend Profile', exact: true }).click()
  await expect.poll(() => page.evaluate(() => localStorage.getItem('hermes_active_profile_name'))).toBe(profile)
  await expect(page.getByTestId('profile-selector-select')).toContainText(profile)
}

test('ordinary history auto-selection follows the real profile selector after reload', async ({ page }) => {
  await openHistory(page, { list: true })
  await switchWithSelector(page, 'coder')
  await expect(page.getByText('coder fixture session', { exact: true }).first()).toBeVisible()
  await page.getByText('coder fixture session', { exact: true }).first().click()
  await expect(page.getByText('coder fixture transcript', { exact: true })).toBeVisible()
  await expect(page).toHaveURL(/history\/session\/coder-session$/)
})

test('ordinary session selection follows switchProfile after its switching guard clears', async ({ page }) => {
  await openHistory(page)
  await page.getByText('default fixture session', { exact: true }).first().click()
  await page.evaluate(() => (window as any).historyNavigationFixture.profiles.switchProfile('coder'))
  await expect(page.getByText('coder fixture transcript', { exact: true })).toBeVisible()
  await expect(page).toHaveURL(/history\/session\/coder-session$/)
})

test('explicit history scope survives switchProfile completing', async ({ page }) => {
  await openHistory(page, { scoped: true })
  await page.evaluate(() => (window as any).historyNavigationFixture.profiles.switchProfile('coder'))
  await expect(page.getByText('default fixture transcript', { exact: true })).toBeVisible()
  await expect(page).toHaveURL(/history\/session\/default-session\?profile=default$/)
})

test('removing an explicit profile reloads the active profile before resolving the session', async ({ page }) => {
  const requests = await openHistory(page, { active: 'coder', scoped: true })
  await page.evaluate(() => (window as any).historyNavigationFixture.profiles.switchProfile('default'))
  await page.evaluate(() => (window as any).historyNavigationFixture.router.push({ name: 'hermes.historySession', params: { sessionId: 'default-session' } }))
  await expect(page.getByText('default fixture transcript', { exact: true })).toBeVisible()
  expect(requests.filter(request => request.path.includes('/groups')).map(request => request.profile)).toEqual(['coder', 'default'])
  expect(requests.every(request => request.header === undefined)).toBe(true)
})


test('removing an explicit profile while opening the history index refreshes its list', async ({ page }) => {
  await openHistory(page, { active: 'coder', scoped: true })
  await page.evaluate(() => (window as any).historyNavigationFixture.profiles.switchProfile('default'))
  await page.evaluate(() => (window as any).historyNavigationFixture.router.push({ name: 'hermes.history' }))
  await expect(page.getByText('default fixture session', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('coder fixture session', { exact: true })).toHaveCount(0)
})

for (const mode of ['failed-frontend', 'hermes-only', 'failed-hermes'] as const) {
  test(`keeps the selected second session after ${mode} switching`, async ({ page }) => {
    const requests = await openHistory(page, { second: true, failHermesSwitch: mode === 'failed-hermes' })
    const groupsBefore = requests.filter(request => request.path.endsWith('/groups')).length
    const result = await page.evaluate(async mode => {
      const profiles = (window as any).historyNavigationFixture.profiles
      return mode === 'failed-frontend' ? profiles.switchProfile('') : profiles.switchHermesProfile('coder')
    }, mode)
    expect(result).toBe(mode === 'hermes-only')
    await page.evaluate(() => (window as any).historyNavigationFixture.flush())
    await expect(page).toHaveURL(/history\/session\/default-second$/)
    await expect(page.getByText('default second transcript', { exact: true })).toBeVisible()
    expect(requests.filter(request => request.path.endsWith('/groups'))).toHaveLength(groupsBefore)
  })
}

test('a delayed profile reload cannot overwrite a newer explicit session navigation', async ({ page }) => {
  await openHistory(page)
  let delayed: Route | undefined
  await page.route(url => url.pathname.endsWith('/hermes/groups') && url.searchParams.get('profile') === 'coder', route => {
    if (!delayed) { delayed = route; return }
    return route.fallback()
  })
  await page.evaluate(() => (window as any).historyNavigationFixture.profiles.switchProfile('coder'))
  await expect.poll(() => Boolean(delayed)).toBe(true)
  await page.evaluate(() => (window as any).historyNavigationFixture.router.push({ name: 'hermes.historySession', params: { sessionId: 'coder-second' }, query: { profile: 'coder' } }))
  await expect(page.getByText('coder second transcript', { exact: true })).toBeVisible()
  const response = page.waitForResponse(response => response.request() === delayed!.request())
  await delayed!.fallback()
  await (await response).finished()
  await page.evaluate(() => (window as any).historyNavigationFixture.flush())
  await expect(page).toHaveURL(/history\/session\/coder-second\?profile=coder$/)
  await expect(page.getByText('coder second transcript', { exact: true })).toBeVisible()
})

test('explicit navigation to another profile uses the linked profile for list and transcript', async ({ page }) => {
  const requests = await openHistory(page)
  await page.evaluate(() => (window as any).historyNavigationFixture.router.push({ name: 'hermes.historySession', params: { sessionId: 'coder-second' }, query: { profile: 'coder' } }))
  await expect(page.getByText('coder second transcript', { exact: true })).toBeVisible()
  expect(requests.filter(request => request.path.endsWith('/groups')).map(request => request.profile)).toEqual(['default', 'coder'])
  expect(await page.evaluate(() => (window as any).historyNavigationFixture.profiles.activeProfileName)).toBe('default')
})
