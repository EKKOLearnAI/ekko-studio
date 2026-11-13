import { expect, test, type Page } from '@playwright/test'

const token = `fixture.${Buffer.from(JSON.stringify({ sub: '1', role: 'super_admin' })).toString('base64url')}.fixture`
const bot = { id: 'person-main-entry', title: '入口测试 BOT', bot_type: 'shuishui', workspace: '/fixture/bot', profile: 'default', source: 'builtin_agent', agent: 'ekko-agent', agent_preset: 'person', agent_mode: 'scoped', history_revision: 0, started_at: 1, last_active: 1 }
const chat = { ...bot, id: 'entry-chat', title: '保留的单聊', source: 'web', agent_preset: '' }

async function mockStudio(page: Page, authenticated: boolean, existingBot = false) {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => {
    if (message.text().includes('uncaught Vue error')) errors.push(message.text())
  })
  await page.addInitScript(({ token, authenticated }) => {
    localStorage.setItem('hermes_locale', 'zh')
    localStorage.setItem('hermes_active_profile_name', 'default')
    if (authenticated) localStorage.setItem('hermes_api_key', token)
  }, { token, authenticated })
  await page.routeWebSocket('**/socket.io/**', () => {})
  await page.route(url => url.pathname.startsWith('/api/') || url.pathname === '/health', async route => {
    const url = new URL(route.request().url())
    const path = url.pathname
    let json: unknown = {}
    if (path === '/health') json = { status: 'ok' }
    else if (path === '/api/auth/status') json = { hasPasswordLogin: true, hasUsers: true }
    else if (path === '/api/auth/login') json = { token, userId: 1, theme: {} }
    else if (path === '/api/auth/me') json = { user: { id: 1, username: 'fixture', role: 'super_admin' } }
    else if (path === '/api/auth/avatar') json = { avatar: '' }
    else if (path === '/api/hermes/profiles') json = { profiles: [{ name: 'default', active: true }] }
    else if (path === '/api/hermes/available-models') {
      const groups = [{ provider: 'fixture', label: 'Fixture', base_url: '', api_key: 'fixture', models: ['fixture-model'] }]
      json = { groups, allProviders: groups, profiles: [], default: 'fixture-model', default_provider: 'fixture' }
    }
    else if (path === '/api/studio/person/conversations') json = { sessions: existingBot ? [bot] : [], next_offset: null }
    else if (path === '/api/studio/person') json = {
      session: url.searchParams.has('session_id') ? bot : null,
      settings: { model: null, agents: [], workspace: '', timezone: 'Asia/Shanghai', maxSteps: 12, maxConcurrentTasks: 6, taskTimeoutMinutes: 60 },
      revision: 0, busy: false, history_revision: 0, can_clear: false, inherits_global_model: true,
      reasoning_efforts: [], compression: { enabled: false, threshold: 0.8, globalThreshold: 0.8 },
      contextTokens: 16000, tasks: [], active_tasks: [], schedules: [], memories: [], interactions: [], flows: [],
    }
    else if (path === '/api/studio/person/models') json = { groups: [] }
    else if (path === '/api/studio/sessions') json = { sessions: url.searchParams.get('source') === 'global_agent' ? [] : [chat] }
    else if (path === '/api/studio/session-categories') json = { categories: [] }
    else if (path === `/api/studio/sessions/${chat.id}`) json = { session: { ...chat, messages: [] } }
    else if (path.endsWith('/messages/paginated')) json = { messages: [], total: 0, has_more: false }
    else if (path === '/api/studio/workspace/directories') json = { directories: [] }
    await route.fulfill({ json })
  })
  return errors
}

async function login(page: Page) {
  await page.locator('.login-form input[type="text"]').fill('fixture')
  await page.locator('.login-form input[type="password"]').fill('fixture-password')
  await page.locator('.login-btn').click()
}

for (const authenticated of [true, false]) {
  test(`opens BOT from the root ${authenticated ? 'with existing auth' : 'after password login'} and keeps manual chat navigation`, async ({ page }) => {
    const errors = await mockStudio(page, authenticated)
    await page.goto('/')
    if (!authenticated) await login(page)
    await expect(page).toHaveURL(/#\/person$/)
    await expect(page.locator('.person-new-name-input')).toBeVisible()

    await page.locator('.studio-navigation-rail__nav a[href="#/hermes/chat"]').click()
    await expect(page).toHaveURL(/#\/hermes\/chat$/)
    await expect(page.locator('.person-layout')).toHaveCount(0)
    await page.reload()
    await expect(page).toHaveURL(/#\/hermes\/chat$/)
    await expect(page.locator('.studio-navigation-rail__nav a[href="#/hermes/chat"]')).toHaveClass(/active/)
    expect(errors).toEqual([])
  })

  test(`preserves an explicit session login redirect ${authenticated ? 'with existing auth' : 'after password login'}`, async ({ page }) => {
    const errors = await mockStudio(page, authenticated)
    const target = '/hermes/session/entry-chat?profile=default'
    await page.goto(authenticated ? `/#/?redirect=${encodeURIComponent(target)}` : `/#${target}`)
    if (!authenticated) await login(page)
    await expect(page).toHaveURL(`http://127.0.0.1:${process.env.PLAYWRIGHT_PORT || 4173}/#${target}`)
    await expect(page.locator('.studio-navigation-rail__nav a[href="#/hermes/chat"]')).toHaveClass(/active/)
    await page.reload()
    await expect(page).toHaveURL(new RegExp(`#${target.replace('?', '\\?')}$`))
    await expect(page.locator('.person-layout')).toHaveCount(0)
    expect(errors).toEqual([])
  })
}

test('retains BOT conversation selection and restores it on refresh', async ({ page }) => {
  const errors = await mockStudio(page, true, true)
  await page.goto('/')
  await expect(page).toHaveURL(/#\/person\?session=person-main-entry$/)
  await expect(page.locator('.person-title')).toHaveText(bot.title)
  await page.reload()
  await expect(page).toHaveURL(/#\/person\?session=person-main-entry$/)
  await expect(page.locator('.person-title')).toHaveText(bot.title)
  expect(errors).toEqual([])
})
