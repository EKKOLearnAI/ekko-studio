import { expect, test, type Page } from '@playwright/test'
import { defaultNavigationSettings } from '../../packages/shared/navigation-settings'

const token = `fixture.${Buffer.from(JSON.stringify({ sub: '1', role: 'super_admin' })).toString('base64url')}.fixture`
const bot = { id: 'person-main-entry', title: '入口测试 BOT', bot_type: 'shuishui', workspace: '/fixture/bot', profile: 'default', source: 'builtin_agent', agent: 'ekko-agent', agent_preset: 'person', agent_mode: 'scoped', history_revision: 0, started_at: 1, last_active: 1 }
const chat = { ...bot, id: 'entry-chat', title: '保留的单聊', source: 'web', agent_preset: '' }

interface StartupState { items: string[]; plugins?: object[]; role?: 'admin' | 'super_admin'; wait?: Promise<void> }

async function mockStudio(page: Page, authenticated: boolean, existingBot = false, startup: StartupState = { items: defaultNavigationSettings().items }) {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => {
    if (message.text().includes('uncaught Vue error')) errors.push(message.text())
  })
  const accountToken = startup.role === 'admin' ? `fixture.${Buffer.from(JSON.stringify({ sub: '1', role: 'admin' })).toString('base64url')}.fixture` : token
  await page.addInitScript(({ token, authenticated }) => {
    if (window !== window.top) return
    localStorage.setItem('hermes_locale', 'zh')
    localStorage.setItem('hermes_active_profile_name', 'default')
    if (authenticated) localStorage.setItem('hermes_api_key', token)
  }, { token: accountToken, authenticated })
  await page.routeWebSocket('**/socket.io/**', () => {})
  await page.route(url => url.pathname.startsWith('/api/') || url.pathname === '/health', async route => {
    const url = new URL(route.request().url())
    const path = url.pathname
    let json: unknown = {}
    if (path === '/health') json = { status: 'ok' }
    else if (path === '/api/auth/status') json = { hasPasswordLogin: true, hasUsers: true }
    else if (path === '/api/auth/login') json = { token: accountToken, userId: 1, theme: {} }
    else if (path === '/api/auth/me') json = { user: { id: 1, username: 'fixture', role: startup.role || 'super_admin' } }
    else if (path === '/api/auth/avatar') json = { avatar: '' }
    else if (path === '/api/auth/locked-ips') json = { locks: [] }
    else if (path === '/api/navigation') {
      if (route.request().method() === 'PUT') startup.items = route.request().postDataJSON().items
      else if (startup.wait) await startup.wait
      json = { items: startup.items }
    }
    else if (path === '/api/studio/plugins') json = { revision: 1, plugins: startup.plugins || [] }
    else if (path.endsWith('/client')) json = { source: 'export function mount(root){root.textContent="启动笔记页"}' }
    else if (path === '/api/studio/plugins/events') json = { generation: 'startup', cursor: 0, events: [] }
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
    const errors = await mockStudio(page, authenticated, false, { items: ['studioPlugins', 'chat'] })
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

  test(`opens the first saved navigation entry ${authenticated ? 'with existing auth' : 'after password login'}`, async ({ page }) => {
    const startup = { items: ['chat', 'person', 'studioPlugins'] }
    const errors = await mockStudio(page, authenticated, false, startup)
    await page.goto('/')
    if (!authenticated) await login(page)
    await expect(page).toHaveURL(/#\/hermes\/chat$/)
    await expect(page.locator('.person-layout')).toHaveCount(0)
    await page.locator('.page-sidebar-account-btn').click()
    await page.getByRole('button', { name: '导航栏设置', exact: true }).click()
    const modal = page.locator('.navigation-settings-modal')
    await expect(modal.locator('.navigation-settings-footer')).toContainText('所有更改已保存')
    await modal.getByRole('button', { name: '上移插件中心', exact: true }).click()
    await expect.poll(() => startup.items[1]).toBe('studioPlugins')
    await expect(modal.locator('.navigation-settings-footer')).toContainText('所有更改已保存')
    await modal.getByRole('button', { name: '上移插件中心', exact: true }).click()
    await expect.poll(() => startup.items[0]).toBe('studioPlugins')
    await page.keyboard.press('Escape')
    // Reordering changes the next launch, not the already open page.
    await expect(page).toHaveURL(/#\/hermes\/chat$/)
    await page.goto('/')
    await expect(page).toHaveURL(/#\/studio\/plugins$/)
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

test('waits for the saved navigation order before choosing the initial page', async ({ page }) => {
  let release!: () => void
  const wait = new Promise<void>(resolve => { release = resolve })
  const errors = await mockStudio(page, true, false, { items: ['chat', 'person'], wait })
  const requested = page.waitForRequest(request => new URL(request.url()).pathname === '/api/navigation')
  await page.goto('/')
  await requested
  await expect(page.locator('.person-layout')).toHaveCount(0)
  expect(new URL(page.url()).hash).not.toContain('/person')
  release()
  await expect(page).toHaveURL(/#\/hermes\/chat$/)
  expect(errors).toEqual([])
})

test('uses registered plugin entries and skips disabled or unregistered plugins at startup', async ({ page }) => {
  const plugin = { manifest: { id: 'startup-notes', name: '启动笔记插件', apiVersion: 1, version: '1.0.0', permissions: ['ui'], client: 'client.mjs',
    views: [{ id: 'home', title: '启动笔记', slot: 'page' }], navigation: { main: [{ viewId: 'home', icon: 'book' }] } },
    status: 'active', enabled: true, config: {}, tools: [], commands: [], actions: [] }
  const errors = await mockStudio(page, true, false, { items: ['plugin:startup-notes/home', 'chat'], plugins: [plugin] })
  await page.goto('/')
  await expect(page).toHaveURL(/#\/studio\/plugins\/startup-notes\/home$/)
  await expect(page.frameLocator('.plugin-workspace iframe').locator('#root')).toHaveText('启动笔记页')
  plugin.status = 'disabled'
  await page.goto('/')
  await expect(page).toHaveURL(/#\/hermes\/chat$/)
  plugin.status = 'active'; plugin.manifest.navigation.main = []
  await page.goto('/')
  await expect(page).toHaveURL(/#\/hermes\/chat$/)
  expect(errors).toEqual([])
})

test('skips restricted entries and uses settings when the saved list has no available entries', async ({ page }) => {
  const startup: StartupState = { items: ['agents', 'chat'], role: 'admin' }
  const errors = await mockStudio(page, true, false, startup)
  await page.goto('/')
  await expect(page).toHaveURL(/#\/hermes\/chat$/)
  startup.items = []
  await page.goto('/')
  await expect(page).toHaveURL(/#\/hermes\/settings$/)
  expect(errors).toEqual([])
})

test('resolves the Desktop startup route after acquiring local Desktop authentication', async ({ page }) => {
  const errors = await mockStudio(page, false, false, { items: ['chat', 'person'] })
  await page.addInitScript(token => {
    ;(window as any).hermesDesktop = { isDesktop: true, platform: 'darwin', ensureAuth: async () => {
      localStorage.setItem('hermes_api_key', token)
      return true
    } }
  }, token)
  await page.goto('/#/home')
  await expect(page).toHaveURL(/#\/hermes\/chat$/)
  await expect(page.locator('.login-form')).toHaveCount(0)
  expect(errors).toEqual([])
})
