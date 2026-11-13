import { test, expect, type Page } from '@playwright/test'
import { resolve } from 'node:path'

const fullGoal = '通过已配置的 SSH 连接服务器。\n使用事务一致性备份，验证数据库完整性。\n' + '保留所有现有备份和校验记录。'.repeat(80) + '\n最后一项：生成完整验证报告。'
const taskGoal = '后台任务完整要求：核对所有表，保存校验摘要。'
async function openSchedules(page: Page, empty = false) {
  const requests: Record<string, any>[] = [], errors: string[] = []
  const bots = [
    { id: 'person-main-a', title: '开发 BOT', bot_type: 'shuishui' },
    { id: 'person-main-b', title: '备份 BOT', bot_type: 'xingxing' },
  ].map(bot => ({ ...bot, profile: 'default', source: 'builtin_agent', agent: 'ekko-agent', agent_preset: 'person', agent_mode: 'scoped', history_revision: 0, started_at: 1, last_active: 1 }))
  const base = { expression: '0 0 * * *', timezone: 'Asia/Shanghai', next_at: 2000000000000, revision: 0 }
  let schedules = empty ? [] : [
    { ...base, id: 'daily-backup', session_id: bots[1].id, session_title: bots[1].title, bot_type: bots[1].bot_type, title: '每日数据库备份', goal: fullGoal, mode: 'assistant', task_id: null, state: 'active' },
    { ...base, id: 'worker-backup', session_id: bots[1].id, session_title: bots[1].title, bot_type: bots[1].bot_type, title: '后台校验', goal: '', mode: 'worker', task_id: 'foreign-worker', task_title: '后台校验', task_goal: taskGoal, state: 'paused' },
    { ...base, id: 'cancelled', session_id: bots[0].id, session_title: bots[0].title, bot_type: bots[0].bot_type, title: '已取消的检查', goal: '保留可查看的任务详情', mode: 'assistant', task_id: null, state: 'cancelled' },
  ]
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(() => { localStorage.setItem('hermes_locale', 'zh'); (window as any).__APP_VERSION__ = 'test' })
  await page.routeWebSocket('**/socket.io/**', () => {})
  await page.route(url => url.pathname.startsWith('/api/'), async route => {
    const u = new URL(route.request().url())
    let json: any = {}
    if (u.pathname === '/api/studio/person/schedules/apply') {
      const input = route.request().postDataJSON(); requests.push(input)
      const target = schedules.find(item => item.id === input.schedule_id)
      if (input.action === 'delete') schedules = schedules.filter(item => item !== target)
      else if (target) Object.assign(target, input.action === 'update' ? { title: input.title || target.title, goal: input.goal || target.goal } : { state: { pause: 'paused', resume: 'active', cancel: 'cancelled' }[input.action] }, { revision: target.revision + 1 })
      await new Promise(done => setTimeout(done, 150))
      json = target || {}
    } else if (u.pathname === '/api/auth/me') json = { user: { id: 1, username: 'fixture', role: 'super_admin' } }
    else if (u.pathname === '/api/auth/avatar') json = { avatar: '' }
    else if (u.pathname === '/api/studio/person/conversations') json = { sessions: bots, next_offset: null }
    else if (u.pathname === '/api/studio/person') json = { session: bots.find(bot => bot.id === u.searchParams.get('session_id')) || null,
      settings: { model: { profile: 'default', provider: 'fixture', model: 'test-model' }, reasoningEffort: '', agents: [], workspace: '', timezone: 'Asia/Shanghai', maxSteps: 12, maxConcurrentTasks: 6, taskTimeoutMinutes: 60, compressionThreshold: null },
      revision: 0, busy: false, history_revision: 0, can_clear: false, inherits_global_model: true, reasoning_efforts: [], compression: { enabled: false, threshold: 0.8, globalThreshold: 0.8 }, contextTokens: 16000, tasks: [], schedules, memories: [], interactions: [], flows: [], active_tasks: [] }
    else if (u.pathname === '/api/studio/person/models') json = { groups: [] }
    else if (u.pathname === '/api/studio/workspace/directories') json = { directories: [] }
    return route.fulfill({ json })
  })
  const entry = '/@fs/' + resolve('tests/e2e/fixtures/person-schedules.ts').replaceAll('\\', '/').replace(/^\//, '')
  await page.route('**/__person_schedules__', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="zh"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div><script type="module" src="${entry}"></script></body></html>` }))
  await page.goto('/__person_schedules__')
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('tab', { name: /定时计划/ }).click()
  await expect(page.getByRole('heading', { name: '让任务，按时发生', exact: true })).toBeVisible()
  return { requests, errors }
}
const card = (page: Page, title: string) => page.locator('.schedule-tile').filter({ has: page.getByRole('heading', { name: title, exact: true }) })

test('settings show all BOTs with avatars and complete assistant/worker/cancelled details', async ({ page }) => {
  const { errors } = await openSchedules(page)
  await expect(page.locator('.schedule-tile')).toHaveCount(3)
  await expect(card(page, '每日数据库备份').locator('.schedule-owner')).toContainText('备份 BOT')
  const images = await page.locator('.schedule-tile .schedule-owner img').evaluateAll(elements => elements.map(el => (el as HTMLImageElement).src))
  expect(images[0]).not.toBe(images[2])
  for (const [title, goal] of [['每日数据库备份', fullGoal], ['后台校验', taskGoal], ['已取消的检查', '保留可查看的任务详情']]) {
    await card(page, title).getByRole('button', { name: '查看详情' }).click()
    await expect(page.locator('.schedule-goal-full')).toHaveText(goal)
    await expect(page.locator('.schedule-detail')).toContainText('Asia/Shanghai')
    await page.keyboard.press('Escape')
    await expect(page.locator('.schedule-detail')).toHaveCount(0)
  }
  expect(errors).toEqual([])
})
test('edits another BOT’s assistant and worker schedules without changing their owners', async ({ page }) => {
  const { requests, errors } = await openSchedules(page)
  await card(page, '每日数据库备份').getByRole('button', { name: '编辑', exact: true }).click()
  await expect(page.locator('.schedule-editor-owner')).toContainText('备份 BOT')
  await page.getByRole('textbox', { name: '定时任务名称', exact: true }).fill('备份新名称')
  await page.locator('.panel-editor').getByRole('button', { name: '保存', exact: true }).click()
  await expect(card(page, '备份新名称')).toBeVisible()
  expect(requests[0]).toMatchObject({ action: 'update', schedule_id: 'daily-backup', session_id: 'person-main-b' })
  await card(page, '后台校验').getByRole('button', { name: '编辑', exact: true }).click()
  await expect(page.locator('.panel-editor')).toContainText('后台校验')
  await expect(page.locator('.panel-editor')).not.toContainText('foreign-worker')
  await page.locator('.panel-editor').getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.locator('.panel-editor')).toHaveCount(0)
  expect(requests[1]).toMatchObject({ action: 'update', schedule_id: 'worker-backup', task_id: 'foreign-worker' })
  expect(errors).toEqual([])
})
test('targets the selected schedule for pause, resume, cancel and confirmed delete', async ({ page }) => {
  const { requests, errors } = await openSchedules(page)
  const target = card(page, '每日数据库备份')
  await target.getByRole('button', { name: '暂停', exact: true }).click()
  await expect(target.getByRole('button', { name: '继续', exact: true })).toBeVisible()
  await target.getByRole('button', { name: '继续', exact: true }).click()
  await expect(target.getByRole('button', { name: '暂停', exact: true })).toBeVisible()
  await target.getByRole('button', { name: '取消计划', exact: true }).click()
  await expect(target.getByRole('button', { name: '编辑', exact: true })).toBeDisabled()
  await target.getByRole('button', { name: '删除', exact: true }).click()
  await expect(page.locator('.n-dialog')).toContainText('执行记录')
  await page.locator('.n-dialog').getByRole('button', { name: '删除', exact: true }).click()
  await expect(target).toHaveCount(0)
  expect(requests.map(input => [input.schedule_id, input.action])).toEqual(['pause','resume','cancel','delete'].map(action => ['daily-backup', action]))
  expect(errors).toEqual([])
})
test('supports narrow layouts and an empty account-wide list', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const { errors } = await openSchedules(page, true)
  await expect(page.locator('.panel-empty')).toBeVisible()
  await expect(page.locator('.schedule-tile')).toHaveCount(0)
  await page.getByRole('button', { name: /新建定时任务/ }).click()
  await expect(page.locator('.panel-editor')).toBeVisible()
  expect(await page.locator('.person-workspace').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
  expect(errors).toEqual([])
})

test('keeps full details usable through theme, wallpaper and narrow layout changes', async ({ page }) => {
  await page.setViewportSize({ width: 1360, height: 920 })
  const { errors } = await openSchedules(page)
  for (const scene of ['light', 'dark', 'light-wallpaper', 'dark-wallpaper', 'reset']) {
    if (scene === 'dark-wallpaper') await page.setViewportSize({ width: 390, height: 844 })
    await page.evaluate(scene => {
      const theme = (window as any).scheduleTheme
      const wallpaper = scene.includes('wallpaper')
      theme.previewThemeSettings({ brightness: scene.startsWith('dark') ? 'dark' : 'light', appearance: wallpaper
        ? { global: { opacity: 0.65 }, regions: { card: { opacity: 0, radius: 20, blur: 4 }, overlay: { opacity: 0.8, radius: 16, blur: 8, backgroundColor: scene.startsWith('dark') ? '#202b35' : '#eef6ff' } } }
        : { global: {}, regions: {} } })
      const image = 'url("data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="800"><rect width="400" height="800" fill="#46758a"/><circle cx="100" cy="400" r="180" fill="#ddc79f"/></svg>') + '")'
      theme.backgroundImageUrl.value = wallpaper ? image : null
      if (wallpaper) document.documentElement.style.setProperty('--app-background-image', image)
      else document.documentElement.style.removeProperty('--app-background-image')
    }, scene)
    await expect(card(page, '每日数据库备份')).toBeVisible()
    await page.screenshot({ path: test.info().outputPath(`schedules-${scene}.png`), animations: 'disabled' })
    await card(page, '每日数据库备份').getByRole('button', { name: '查看详情' }).click()
    await expect(page.locator('.schedule-goal-full')).toHaveText(fullGoal)
    expect(await page.locator('.schedule-detail').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
    await page.screenshot({ path: test.info().outputPath(`details-top-${scene}.png`), animations: 'disabled' })
    await page.locator('.schedule-detail').evaluate(el => { el.scrollTop = el.scrollHeight })
    await expect(page.locator('.schedule-detail-meta')).toBeInViewport()
    await page.screenshot({ path: test.info().outputPath(`details-${scene}.png`), animations: 'disabled' })
    await page.keyboard.press('Escape')
    await expect(page.locator('.schedule-detail')).toHaveCount(0)
    await expect(page.locator('.n-modal')).toHaveCount(0)
  }
  expect(errors).toEqual([])
})
