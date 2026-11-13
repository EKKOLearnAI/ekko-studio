import { test, expect, type Page } from '@playwright/test'
import { resolve } from 'node:path'
import { mkdir } from 'node:fs/promises'

async function openFixture(page: Page, failures = 0) {
  const requests: Record<string, any>[] = [], errors: string[] = []
  let created: Record<string, any> | null = null
  const settings = { model: { profile: 'default', provider: 'fixture', model: 'test-model' }, reasoningEffort: '', agents: [{ id: 'worker', name: 'Worker', description: '', selection: { runtime: 'ekko', mode: 'scoped', profile: 'default', provider: 'fixture', model: 'test-model' } }], workspace: '', timezone: 'Asia/Shanghai', maxSteps: 12, maxConcurrentTasks: 6, taskTimeoutMinutes: 60, compressionThreshold: null }
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(() => { localStorage.setItem('hermes_locale', 'zh'); (window as any).__APP_VERSION__ = 'test' })
  await page.routeWebSocket('**/socket.io/**', () => {})
  await page.route(url => url.pathname.startsWith('/api/'), route => {
    const u = new URL(route.request().url())
    if (u.pathname === '/api/studio/person/conversations' && route.request().method() === 'POST') {
      const body = route.request().postDataJSON(); requests.push(body)
      if (failures-- > 0) return route.fulfill({ status: 409, json: { code: 'WORKSPACE_UNAVAILABLE', error: 'Failed to create the default Bot workspace: permission denied' } })
      created = { id: 'person-main-created', title: body.title, workspace: body.workspace || '/fixture/.ekko/workspace/default/person-main-created', bot_type: body.bot_type, profile: 'default', source: 'builtin_agent', agent: 'ekko-agent', agent_preset: 'person', agent_mode: 'scoped', history_revision: 0, started_at: 1, last_active: 1 }
      return route.fulfill({ json: created })
    }
    let json: any = {}
    if (u.pathname === '/api/auth/me') json = { user: { id: 1, username: 'fixture', role: 'super_admin' } }
    else if (u.pathname === '/api/auth/avatar') json = { avatar: '' }
    else if (u.pathname === '/api/studio/person/conversations') json = { sessions: created ? [created] : [], next_offset: null }
    else if (u.pathname === '/api/studio/person') json = { session: u.searchParams.get('session_id') ? created : null, settings: { ...settings, workspace: created?.workspace || '' }, revision: 0, busy: false, history_revision: 0, can_clear: false, inherits_global_model: true, reasoning_efforts: [], compression: { enabled: false, threshold: 0.8, globalThreshold: 0.8 }, contextTokens: 16000, tasks: [], schedules: [], memories: [], interactions: [], flows: [], active_tasks: [] }
    else if (u.pathname === '/api/studio/workspace/directories') json = { directories: [] }
    else if (u.pathname === '/api/studio/workspace/folders') json = { base: '/fixture', current: '', folders: [{ name: 'manual', path: 'manual', fullPath: '/fixture/manual' }] }
    else if (u.pathname === '/api/studio/person/models') json = { groups: [] }
    return route.fulfill({ json })
  })
  const entry = '/@fs/' + resolve('tests/e2e/fixtures/person-workspace.ts').replaceAll('\\', '/').replace(/^\//, '')
  await page.route('**/__person_workspace__', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="zh"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div><script type="module" src="${entry}"></script></body></html>` }))
  await page.goto('/__person_workspace__')
  await expect(page.locator('.person-new-name-input')).toBeVisible()
  return { requests, errors }
}
async function screenshot(page: Page, name: string) {
  if (!process.env.BOT_WORKSPACE_EVIDENCE_DIR) return
  await mkdir(process.env.BOT_WORKSPACE_EVIDENCE_DIR, { recursive: true })
  await page.screenshot({ path: resolve(process.env.BOT_WORKSPACE_EVIDENCE_DIR, name + '.png'), animations: 'disabled' })
}
const folder = (page: Page) => page.locator('.person-new-name-input').getByRole('button', { name: '工作区', exact: true })
async function selectWorkspace(page: Page, value: string) {
  await folder(page).click()
  await page.locator('.folder-path-input input').fill(value)
  await expect(page.getByRole('button', { name: '确定', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: '确定', exact: true }).click()
  await expect(page.locator('.n-dialog')).toHaveCount(0)
}

test('creates without opening the workspace picker and sends the first message at a narrow viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const { requests, errors } = await openFixture(page)
  await page.locator('.new-chat-compose textarea').fill('使用默认工作区')
  await expect(folder(page)).toHaveText('')
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled()
  await screenshot(page, 'default-draft-390')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect.poll(() => requests.length).toBe(1)
  expect(requests[0]).not.toHaveProperty('workspace')
  await expect.poll(() => page.evaluate(() => (window as any).personWorkspaceFixture.sent)).toEqual(['使用默认工作区'])
  await expect(page.locator('.n-dialog')).toHaveCount(0)
  expect(errors).toEqual([])
})

test('preserves manual directory selection in the create request', async ({ page }) => {
  const { requests, errors } = await openFixture(page)
  await selectWorkspace(page, '/fixture/manual')
  await folder(page).click()
  await expect(page.locator('.folder-path-input input')).toHaveValue('/fixture/manual')
  await page.getByRole('button', { name: '取消', exact: true }).click()
  await page.locator('.new-chat-compose textarea').fill('使用手动目录')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect.poll(() => requests.length).toBe(1)
  expect(requests[0].workspace).toBe('/fixture/manual')
  await expect.poll(() => page.evaluate(() => (window as any).personWorkspaceFixture.sent)).toEqual(['使用手动目录'])
  expect(errors).toEqual([])
})

test('allows clearing a draft selection back to automatic default', async ({ page }) => {
  const { requests, errors } = await openFixture(page)
  await selectWorkspace(page, '/fixture/manual')
  await folder(page).click()
  await expect(page.getByText('不选择目录时，会像单聊一样自动创建独立工作区，也可以在此手动选择目录。', { exact: true })).toBeVisible()
  await page.locator('.folder-path-input input').fill('')
  await expect(page.getByRole('button', { name: '确定', exact: true })).toBeEnabled()
  await screenshot(page, 'clear-to-default')
  await page.getByRole('button', { name: '确定', exact: true }).click()
  await page.locator('.new-chat-compose textarea').fill('回到默认工作区')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect.poll(() => requests.length).toBe(1)
  expect(requests[0]).not.toHaveProperty('workspace')
  expect(errors).toEqual([])
})

test('shows provisioning failure, retains the draft and supports retry', async ({ page }) => {
  const { requests, errors } = await openFixture(page, 1)
  await page.locator('.new-chat-compose textarea').fill('保留此消息重试')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.locator('.person-alert')).toContainText('Failed to create the default Bot workspace: permission denied')
  await expect(page.locator('.new-chat-compose textarea')).toHaveValue('保留此消息重试')
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled()
  await screenshot(page, 'provisioning-failure')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect.poll(() => requests.length).toBe(2)
  await expect.poll(() => page.evaluate(() => (window as any).personWorkspaceFixture.sent)).toEqual(['保留此消息重试'])
  expect(errors).toEqual([])
})
