import { test, expect, type Page } from '@playwright/test'
import { resolve } from 'node:path'

const agent = (id: string, name: string) => ({ id, name, description: `${name} purpose`,
  selection: { runtime: 'ekko', mode: 'scoped', profile: 'default', provider: 'fixture', model: 'test-model', reasoningEffort: '' } })
const teams = [
  { id: 'team-default', name: 'Default', revision: 1, created_at: 1, agents: [agent('worker-a', 'Worker A')] },
  { id: 'team-web', name: 'Web Project', revision: 2, created_at: 2, agents: [agent('worker-b', 'Worker B')] },
]
const memories = {
  'team-default': [{ id: 'm1', content: 'Default team memory', revision: 1 }],
  'team-web': [{ id: 'm2', content: 'Web team memory', revision: 1 }],
} as Record<string, { id: string; content: string; revision: number }[]>

async function openFixture(page: Page, options: { createFirst?: boolean; teamId?: string; teams?: typeof teams } = {}) {
  const teamList = options.teams || teams
  const created: Record<string, any>[] = []
  const memoryQueries: string[] = []
  const agentSaves: Record<string, any>[] = []
  const errors: string[] = []
  let active: Record<string, any> | null = null
  page.on('pageerror', error => { errors.push(error.message) })
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  page.on('response', response => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`) })
  await page.addInitScript(() => { localStorage.setItem('hermes_locale', 'zh'); (window as any).__APP_VERSION__ = 'test' })
  await page.routeWebSocket('**/socket.io/**', () => {})
  await page.route(url => url.pathname.startsWith('/api/'), route => {
    const u = new URL(route.request().url())
    const method = route.request().method()
    if (u.pathname === '/api/studio/person/conversations' && method === 'POST') {
      const body = route.request().postDataJSON(); created.push(body)
      active = { id: 'person-main-new', title: body.title, bot_type: body.bot_type, profile: 'default',
        source: 'builtin_agent', agent: 'ekko-agent', agent_preset: 'person', agent_mode: 'scoped',
        workspace: '/fixture/ws', history_revision: 0, started_at: 1, last_active: 1 }
      return route.fulfill({ json: active })
    }
    if (u.pathname === '/api/studio/person/teams/apply') { agentSaves.push(route.request().postDataJSON()); return route.fulfill({ json: { teams } }) }
    if (/^\/api\/studio\/person\/teams\/[^/]+\/usage$/.test(u.pathname)) {
      return route.fulfill({ json: { team_id: 'team-web', default: false, total: 12, tasks: 3,
        conversations: Array.from({ length: 10 }, (_, index) => ({ id: `c${index}`, title: `Web chat ${index + 1}` })) } })
    }
    let json: any = {}
    if (u.pathname === '/api/auth/me') json = { user: { id: 1, username: 'fixture', role: 'super_admin' } }
    else if (u.pathname === '/api/auth/avatar') json = { avatar: '' }
    else if (u.pathname === '/api/studio/person/conversations') json = { sessions: [], next_offset: null }
    else if (u.pathname === '/api/studio/sessions') json = { sessions: [], next_offset: null }
    else if (u.pathname === '/api/studio/person/teams') json = { teams: teamList }
    else if (u.pathname === '/api/studio/person/memory') {
      const teamId = u.searchParams.get('team_id') || 'team-default'
      memoryQueries.push(teamId)
      return route.fulfill({ json: { memories: memories[teamId] || [] } })
    }
    else if (u.pathname === '/api/studio/person/agent-models') json = { groups: [{ profile: 'default', provider: 'fixture', label: 'Fixture', models: ['test-model'], api_mode: 'chat_completions', model_meta: {} }], profiles: ['default'] }
    else if (u.pathname === '/api/studio/person/capabilities') json = { agents: [{ runtime: 'ekko', installed: true }], native_allowed: true }
    else if (u.pathname === '/api/studio/person/models') json = { groups: [] }
    else if (u.pathname === '/api/studio/workspace/directories') json = { directories: [] }
    else if (u.pathname === '/api/studio/workspace/folders') json = { base: '/fixture', current: '', folders: [] }
    else if (u.pathname === '/api/studio/person') json = {
      session: u.searchParams.get('session_id') ? active : null, teams: teamList, revision: 3,
      settings: { model: { profile: 'default', provider: 'fixture', model: 'test-model' }, reasoningEffort: '',
        agents: (teamList.find(team => team.id === (options.teamId || 'team-default')) || teamList[0]).agents,
        teamId: options.teamId || 'team-default', workspace: '', timezone: 'Asia/Shanghai', maxSteps: 12,
        maxConcurrentTasks: 6, taskTimeoutMinutes: 60, compressionThreshold: null },
      busy: false, history_revision: 0, can_clear: false, inherits_global_model: true, reasoning_efforts: [],
      compression: { enabled: false, threshold: 0.8, globalThreshold: 0.8 }, contextTokens: 16000,
      tasks: [], active_tasks: [], schedules: [], memories: memories[options.teamId || 'team-default'], interactions: [], flows: [],
    }
    return route.fulfill({ json })
  })
  const entry = '/@fs/' + resolve('tests/e2e/fixtures/person-agent-teams.ts').replaceAll('\\', '/').replace(/^\//, '')
  await page.route('**/__person_teams__', route => route.fulfill({ contentType: 'text/html',
    body: `<!doctype html><html lang="zh"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div><script type="module" src="${entry}"></script></body></html>` }))
  await page.goto('/__person_teams__')
  try { await expect(page.locator('.person-new-name-input')).toBeVisible({ timeout: 15_000 }) }
  catch (error) { throw new Error(`${(error as Error).message}\nPage errors:\n${errors.join('\n')}`) }
  if (options.createFirst) {
    await page.locator('.new-chat-compose textarea').fill('Open a conversation')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect.poll(() => created.length).toBe(1)
    await expect(page.getByRole('button', { name: '设置', exact: true })).toBeVisible({ timeout: 15_000 })
  }
  return { created, memoryQueries, agentSaves, errors }
}

test('creates a conversation bound to the selected team', async ({ page }) => {
  const { created } = await openFixture(page)
  const picker = page.locator('.person-team-picker')
  await expect(picker).toBeVisible()
  await picker.locator('[aria-label="智能体团队"]').click()
  await page.getByText('Web Project', { exact: true }).last().click()
  await page.locator('.new-chat-compose textarea').fill('Web project task')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect.poll(() => created.length).toBe(1)
  expect(created[0].team_id).toBe('team-web')
})

test('keeps the team picker visible when the account has only one team', async ({ page }) => {
  // A fresh account owns a single default team; hiding the picker then left the
  // whole feature undiscoverable from the new-conversation screen.
  await openFixture(page, { teams: [teams[0]] })
  const picker = page.locator('.person-team-picker')
  await expect(picker).toBeVisible()
  await expect(picker).toContainText('智能体团队')
  await expect(picker).toContainText('Default')
})

test('validates the chosen team, not the default team, when starting a conversation', async ({ page }) => {
  // Regression: the draft read the sessionless snapshot, so it judged the default
  // team's (empty) agent list even after the user picked a team that has agents.
  const emptyDefault = [{ ...teams[0], agents: [] }, teams[1]]
  const { created } = await openFixture(page, { teams: emptyDefault })
  await page.locator('.new-chat-compose textarea').fill('hello')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByText('请先添加执行智能体')).toBeVisible()
  expect(created).toHaveLength(0)

  await page.getByRole('button', { name: '取消' }).click()
  await page.locator('.person-team-picker [aria-label="智能体团队"]').click()
  await page.getByText('Web Project', { exact: true }).last().click()
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect.poll(() => created.length).toBe(1)
  expect(created[0].team_id).toBe('team-web')
})

test('lists teams in settings and previews affected conversations before deleting one', async ({ page }) => {
  const { agentSaves } = await openFixture(page, { createFirst: true, teamId: 'team-web' })
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.locator('.n-tabs-tab', { hasText: '智能体' }).click()
  const sidebar = page.locator('.person-agent-settings .team-list')
  await expect(sidebar.locator('.team-item')).toHaveCount(2)
  await expect(sidebar).toContainText('Default')
  await expect(sidebar).toContainText('Web Project')
  // The conversation's own team is preselected, not the first team in the list.
  await expect(sidebar.locator('.team-item', { hasText: 'Web Project' })).toHaveClass(/selected/)
  // Only the selected team's agents are offered to the model.
  await expect(page.locator('.person-agent-settings')).toContainText('Worker B')
  await expect(page.locator('.person-agent-settings')).not.toContainText('Worker A')
  await sidebar.getByText('Default', { exact: true }).click()
  await expect(page.locator('.person-agent-settings')).toContainText('Worker A')
  // Renaming is offered on every team, including the default one, and prefills the current name.
  const webRow = sidebar.locator('.team-item', { hasText: 'Web Project' })
  await webRow.locator('[aria-label="重命名团队"]').click()
  const renameDialog = page.locator('.n-dialog').filter({ hasText: '重命名团队' })
  await expect(renameDialog.locator('input')).toHaveValue('Web Project')
  await renameDialog.locator('input').fill('Web Revamp')
  await renameDialog.getByRole('button', { name: '保存' }).click()
  await expect.poll(() => agentSaves.map(save => save.action)).toContain('rename')
  expect(agentSaves.find(save => save.action === 'rename')).toMatchObject({ team_id: 'team-web', name: 'Web Revamp' })
  // Only the default team is protected from deletion.
  await expect(sidebar.locator('.team-item', { hasText: 'Default' }).locator('.team-delete')).toHaveCount(0)
  // Deleting asks first and lists at most ten affected conversations.
  await sidebar.locator('.team-item', { hasText: 'Web Project' }).locator('.team-delete').click()
  const dialog = page.locator('.n-dialog').filter({ hasText: '删除团队' })
  await expect(dialog).toContainText('Web chat 1')
  await expect(dialog.locator('.team-usage-list li')).toHaveCount(10)
  await expect(dialog).toContainText('另有 2 个会话未显示')
})

test('loads memory per team instead of the whole account', async ({ page }) => {
  const { memoryQueries } = await openFixture(page, { createFirst: true })
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.locator('.n-tabs-tab', { hasText: '记忆' }).click()
  const panel = page.locator('.person-panel').filter({ hasText: '记忆' })
  await expect(panel).toContainText('Default team memory')
  await panel.locator('.team-item', { hasText: 'Web Project' }).click()
  await expect(panel).toContainText('Web team memory')
  await expect(panel).not.toContainText('Default team memory')
  await expect.poll(() => memoryQueries).toContain('team-web')
})
