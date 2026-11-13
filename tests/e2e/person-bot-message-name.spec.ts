import { expect, test } from '@playwright/test'
import { resolve } from 'node:path'

test('updates existing and new Bot message author names after rename and reload, keeping the selected avatar', async ({ page }, testInfo) => {
  const errors: string[] = [], renames: unknown[] = []
  const session = { id: 'person-main-name', title: '厨房助手', bot_type: 'dachu', workspace: '/fixture/bot-name', profile: 'default', source: 'builtin_agent', agent: 'ekko-agent', agent_preset: 'person', agent_mode: 'scoped', history_revision: 0, started_at: 1, last_active: 1 }
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(() => {
    localStorage.setItem('hermes_locale', 'zh')
    ;(window as any).__APP_VERSION__ = 'test'
  })
  await page.routeWebSocket('**/socket.io/**', () => {})
  await page.route(url => url.pathname.startsWith('/api/'), async route => {
    const request = route.request(), url = new URL(request.url())
    let json: unknown = {}
    if (url.pathname === '/api/auth/me') json = { user: { id: 1, username: 'fixture', role: 'super_admin' } }
    else if (url.pathname === '/api/auth/avatar') json = { avatar: '' }
    else if (url.pathname.includes('/profiles')) json = { profiles: [{ name: 'default', active: true }] }
    else if (url.pathname === '/api/studio/person/conversations') json = { sessions: [session], next_offset: null }
    else if (url.pathname === `/api/studio/sessions/${session.id}/rename` && request.method() === 'POST') {
      const body = request.postDataJSON()
      renames.push(body); session.title = body.title; json = { ok: true }
    } else if (url.pathname === '/api/studio/person') json = {
      session: url.searchParams.has('session_id') ? session : null,
      settings: { model: { profile: 'default', provider: 'fixture', model: 'test-model' }, agents: [], workspace: session.workspace, timezone: 'Asia/Shanghai', maxSteps: 12, maxConcurrentTasks: 6, taskTimeoutMinutes: 60, compressionThreshold: null },
      revision: 0, busy: false, history_revision: 0, can_clear: false, inherits_global_model: true, reasoning_efforts: [], compression: { enabled: false, threshold: .8, globalThreshold: .8 }, contextTokens: 16000, tasks: [], active_tasks: [], active_agent_task_count: 0, schedules: [], memories: [], interactions: [], flows: [],
    }
    else if (url.pathname === '/api/studio/workspace/directories') json = { directories: [] }
    await route.fulfill({ json })
  })
  // Reuse the PersonView fixture: only live chat sending/switching is replaced.
  const entry = '/@fs/' + resolve('tests/e2e/fixtures/person-conversation-layout.ts').replaceAll('\\', '/').replace(/^\//, '')
  await page.route('**/__person_bot_name__', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="zh"><body><div id="app"></div><script type="module" src="${entry}"></script></body></html>` }))
  async function openConversation() {
    await page.waitForFunction(() => !!(window as any).personWorkspaceFixture)
    await page.evaluate(async () => {
      await (window as any).personWorkspaceFixture.router.push({ name: 'hermes.person', query: { session: 'person-main-name' } })
    })
    await expect(page.locator('.person-title')).toHaveText(session.title)
    await page.evaluate(() => {
      const chat = (window as any).personWorkspaceFixture.chat
      const current = chat.sessions.find((s: any) => s.id === 'person-main-name')
      current.messages = [
        { id: 'old-reply', role: 'assistant', content: '旧消息也应显示当前 Bot 名称。', timestamp: 1 },
        { id: 'recent-reply', role: 'assistant', content: '这是另一条回复。', timestamp: 2 },
      ]
      chat.activeSessionId = current.id; chat.activeSession = current
    })
  }
  const authors = page.locator('.assistant-message-author .message-author-name')
  const avatarSources = () => page.locator('.assistant-message-author img').evaluateAll(elements => elements.map(element => element.getAttribute('src')))
  await page.goto('/__person_bot_name__')
  await openConversation()
  await expect(authors).toHaveText(['厨房助手', '厨房助手'])
  const originalAvatars = await avatarSources()
  expect(originalAvatars).toEqual(['/person/dachu/idle.png', '/person/dachu/idle.png'])

  await page.locator('.person-sidebar .session-item').click({ button: 'right' })
  await page.getByText('重命名', { exact: true }).click()
  await page.locator('.n-dialog input').fill('菜谱管家')
  await page.locator('.n-dialog input').press('Enter')
  await expect(page.locator('.n-dialog')).toBeHidden()
  expect(renames).toEqual([{ title: '菜谱管家' }])
  await expect(page.locator('.person-title')).toHaveText('菜谱管家')
  await expect(authors).toHaveText(['菜谱管家', '菜谱管家'])
  expect(await avatarSources()).toEqual(originalAvatars)
  await page.evaluate(() => {
    (window as any).personWorkspaceFixture.chat.activeSession.messages.push({ id: 'new-reply', role: 'assistant', content: '重命名后的新回复。', timestamp: 3 })
  })
  await expect(authors).toHaveText(['菜谱管家', '菜谱管家', '菜谱管家'])
  await testInfo.attach('renamed-bot', { body: await page.screenshot(), contentType: 'image/png' })

  await page.reload()
  await openConversation()
  await expect(authors).toHaveText(['菜谱管家', '菜谱管家'])
  expect(await avatarSources()).toEqual(originalAvatars)
  expect(errors).toEqual([])
})
