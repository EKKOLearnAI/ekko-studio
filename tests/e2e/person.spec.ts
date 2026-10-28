import { expect, test, type Page } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi } from './fixtures'
import sharp from 'sharp'

async function setup(page: Page, mode: 'light' | 'dark', wallpaper = true, customAppearance = true) {
  await authenticate(page)
  await mockChatSocket(page)
  await mockHermesApi(page, { theme: { brightness: mode, ...(wallpaper ? { background: { name: 'person.png', mime: 'image/png', updatedAt: 1 } } : {}), ...(customAppearance ? { appearance: { global: { opacity: 0.5 }, regions: { card: { opacity: 0.65, blur: 12 } } } } : {}) } })
  const image = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#345678' } }).png().toBuffer()
  await page.route('**/api/theme/background?*', route => route.request().method() === 'GET'
    ? route.fulfill({ contentType: 'image/png', body: image }) : route.fallback())
  const globalModel = { model: 'global-model', provider: 'provider', profile: 'default' }
  const state: any = { settings: { workspace: '', model: globalModel, reasoningEffort: 'low', timezone: 'UTC', compressionThreshold: null, maxSteps: 12, maxConcurrentTasks: 2, agents: [{ id: 'worker', name: 'Research assistant', description: 'Research and write reports', selection: { runtime: 'ekko', mode: 'scoped', profile: 'default', provider: 'provider', model: 'global-model', reasoningEffort: '' } }] }, contextTokens: 200000, compression: { enabled: true, threshold: 0.5, globalThreshold: 0.5 }, inherits_global_model: true, reasoning_efforts: ['none', 'low', 'high'], revision: 0, busy: false, history_revision: 0, can_clear: false, tasks: [{ id: 'task1', title: 'Check report', summary: 'Verify a report', status: 'open', revision: 0, execution_id: 'execution1', execution_state: 'running', running: true }], schedules: [], memories: [], interactions: [] }
  state.session = { id: 'person-main-1', source: 'builtin_agent', agent: 'ekko-agent', agent_preset: 'person', agent_mode: 'scoped', profile: 'default', title: 'Person', workspace: '/tmp/person/default', model: 'global-model', provider: 'provider', started_at: 1, ended_at: null, message_count: 0, tool_call_count: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0, billing_provider: null, estimated_cost_usd: 0, actual_cost_usd: null, cost_status: '' }
  await page.addInitScript(() => { (window as any).__PW_CHAT_SOCKET_RESUMES__ = { 'person-main-1': { session_id: 'person-main-1', messages: [], isWorking: false, events: [] } } })
  const operations: any[] = []
  await page.route(/^https?:\/\/[^/]+\/api\/studio\/person(?:\/|\?|$)/, async route => {
    const req = route.request(); const path = new URL(req.url()).pathname; const body = req.postDataJSON()
    operations.push({ path, body, headers: req.headers() })
    if (path.endsWith('/capabilities')) return route.fulfill({ json: { agents: [{ runtime: 'ekko', installed: true }, { runtime: 'codex', installed: true }], native_allowed: true } })
    if (path.endsWith('/models') || path.endsWith('/agent-models')) return route.fulfill({ json: { groups: [{ provider: 'provider', profile: 'default', label: 'My provider', models: ['global-model', 'fast-model'], model_meta: { 'global-model': { reasoning_efforts: ['none', 'low', 'high'] }, 'fast-model': { reasoning: false } } }] } })
    if (path.endsWith('/settings')) {
      if (body.expected_revision !== state.revision) return route.fulfill({ status: 409, json: { error: 'Settings changed' } })
      for (const key of ['compressionThreshold', 'maxSteps', 'maxConcurrentTasks', 'timezone']) if (body[key] !== undefined) state.settings[key] = body[key]
      if (body.workspace !== undefined) { state.settings.workspace = body.workspace; state.session.workspace = body.workspace || '/tmp/person/default' }
      if (body.agents) state.settings.agents = body.agents
      if (body.model) { state.settings.model = body.model; state.inherits_global_model = false; state.reasoning_efforts = []; state.settings.reasoningEffort = '' }
      if (body.reasoning_effort !== undefined) state.settings.reasoningEffort = body.reasoning_effort
      if (body.use_global_default) { state.settings.model = globalModel; state.inherits_global_model = true; state.reasoning_efforts = ['none', 'low', 'high'] }
      state.contextTokens = state.settings.model.model === 'fast-model' ? 128000 : 200000
      state.compression.threshold = state.settings.compressionThreshold ?? state.compression.globalThreshold
      state.revision++
      return route.fulfill({ json: { contextTokens: state.contextTokens, compression: state.compression, settings: state.settings, revision: state.revision, inherits_global_model: state.inherits_global_model, reasoning_efforts: state.reasoning_efforts } })
    }
    if (path.endsWith('/clear')) {
      if (body.expected_history_revision !== state.history_revision || state.busy || state.tasks.some((task: any) => task.running)) return route.fulfill({ status: 409, json: { error: 'Wait for Person tasks and result delivery to finish' } })
      state.tasks = []; state.schedules = []; state.interactions = []; state.history_revision++
      await page.evaluate(() => {
        (window as any).__PW_CHAT_SOCKET_RESUMES__['person-main-1'].messages = []
        ;(window as any).__PW_CHAT_SOCKET__.broadcast('session.command', { event: 'session.command', session_id: 'person-main-1', command: 'clear', action: 'clear', ok: true, clearHistory: true })
      })
      return route.fulfill({ json: { cleared: true } })
    }
    if (path.endsWith('/tasks/task1/chat')) {
      if (req.method() === 'POST') { state.tasks[0].running = true; state.tasks[0].status = 'open'; state.tasks[0].execution_state = 'queued'; state.tasks[0].execution_id = 'execution2'; state.tasks[0].revision++ }
      return route.fulfill({ json: { task: state.tasks[0], session: { ...state.session, id: 'person-task-task1', title: state.tasks[0].title } } })
    }
    if (path.endsWith('/tasks/apply')) {
      if (body.expected_revision !== state.tasks[0].revision || (body.action === 'stop' && body.execution_id !== state.tasks[0].execution_id)) return route.fulfill({ status: 409, json: { error: 'Execution changed' } })
      if (body.action === 'stop') state.tasks[0].execution_state = 'stopping'
      else state.tasks[0].status = body.action === 'close' ? 'closed' : 'open'
      state.tasks[0].revision++
      return route.fulfill({ json: { task: state.tasks[0] } })
    }
    if (path.endsWith('/schedules/apply')) {
      if (body.action === 'create') state.schedules.push({ ...body, id: `schedule${state.schedules.length + 1}`, state: 'active', next_at: Date.now() + 86400000, revision: 0 })
      else {
        const schedule = state.schedules.find((item: any) => item.id === body.schedule_id)
        if (!schedule || body.expected_revision !== schedule.revision) return route.fulfill({ status: 409, json: { error: 'Schedule changed' } })
        if (body.action === 'update') Object.assign(schedule, body)
        else schedule.state = { pause: 'paused', resume: 'active', cancel: 'cancelled' }[body.action as string]
        schedule.revision++
      }
      return route.fulfill({ json: {} })
    }
    if (path.endsWith('/memory')) { state.memories = state.memories.filter((m: any) => m.id !== body.id); return route.fulfill({ json: {} }) }
    state.can_clear = !state.busy && !state.tasks.some((task: any) => task.running)
    state.session.model = state.settings.model?.model || ''; state.session.provider = state.settings.model?.provider || ''; state.session.reasoning_effort = state.settings.reasoningEffort
    return route.fulfill({ json: state })
  })
  return { state, operations }
}

async function backgroundTaskCount(page: Page, count: number, state = 'searching') {
  await expect.poll(() => page.evaluate(() => (window as any).__PW_CHAT_SOCKET__?.allSockets?.some((socket: any) => String(socket.url).endsWith('/person-presence')))).toBe(true)
  await page.evaluate(({ count, state }) => {
    const socket = (window as any).__PW_CHAT_SOCKET__.allSockets.find((socket: any) => String(socket.url).endsWith('/person-presence'))
    socket.__trigger('person.presence', { state, backgroundTaskCount: count, lastActivityAt: 1, sleepAt: 600001 })
  }, { count, state })
}

for (const mode of ['light', 'dark'] as const) {
  test(`Person background-task island expands from the center and updates live in ${mode}`, async ({ page }) => {
    const { state } = await setup(page, mode, mode === 'dark', false)
    state.tasks[0].running = false; state.tasks[0].status = 'completed'; state.tasks[0].execution_state = 'finished'
    await page.setViewportSize({ width: mode === 'dark' ? 360 : 1440, height: 900 })
    await page.goto('/#/person')
    await expect(page.locator('.person-title')).toBeVisible()
    await expect(page.locator('.person-view')).toHaveAttribute('aria-busy', 'false')
    const island = page.locator('.person-task-island')
    await expect(island).toHaveCount(0)
    const messages = page.locator('.person-view .message-list-shell')
    const composer = page.locator('.person-compose')
    const messageBounds = await messages.boundingBox(), composerBounds = await composer.boundingBox()
    await page.evaluate(async () => { const image = new Image(); image.src = '/person/searching.gif'; await image.decode() })
    await backgroundTaskCount(page, 3)
    const animations = await page.evaluate(async () => {
      await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame)
      const animations = document.querySelector('.person-task-activity')!.getAnimations({ subtree: true })
      for (const animation of animations) { animation.pause(); animation.currentTime = 100 }
      return animations.length
    })
    expect(animations).toBeGreaterThan(0)
    await page.screenshot({ path: `/tmp/person-task-island-enter-${mode}.png` })
    await page.evaluate(() => document.querySelector('.person-task-activity')!.getAnimations({ subtree: true }).forEach(animation => animation.finish()))
    await expect(page.getByRole('button', { name: 'zhezhe · Background tasks · 3', exact: true })).toBeVisible()
    await expect(island.locator('img')).toHaveAttribute('src', '/person/searching.gif')
    const box = await island.boundingBox()
    expect(Math.abs(box!.x + box!.width / 2 - page.viewportSize()!.width / 2)).toBeLessThan(1)
    await expect(page.locator('.person-task-activity')).toHaveCSS('position', 'fixed')
    expect(await messages.boundingBox()).toEqual(messageBounds)
    expect(await composer.boundingBox()).toEqual(composerBounds)
    const headerBounds = await page.locator('.person-header').boundingBox()
    expect(box!.y).toBeGreaterThanOrEqual(headerBounds!.y + headerBounds!.height)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: `/tmp/person-task-island-expanded-${mode}.png`, animations: 'disabled' })
    await island.evaluate(element => { (element as HTMLElement).dataset.instance = 'same-task-animation' })
    // The server count can exceed the current task-list page; feedback never hides active tasks.
    await backgroundTaskCount(page, 24, 'done')
    await expect(page.getByRole('button', { name: 'zhezhe · Background tasks · 24', exact: true })).toBeVisible()
    await expect(island).toHaveAttribute('data-instance', 'same-task-animation')
    await expect(island.locator('img')).toHaveAttribute('src', '/person/searching.gif')
    await island.click()
    await expect(page.locator('.session-tasks-drawer')).toBeVisible()
    await expect(island).toHaveAttribute('aria-expanded', 'true')
    await page.keyboard.press('Escape')
    await expect(page.locator('.session-tasks-drawer')).not.toBeVisible()
    await backgroundTaskCount(page, 0, 'idle')
    await expect(island).toHaveCount(0)
    expect(await messages.boundingBox()).toEqual(messageBounds)
    expect(await composer.boundingBox()).toEqual(composerBounds)
    await backgroundTaskCount(page, 1)
    await expect(island).toBeVisible()
    await page.setViewportSize({ width: mode === 'dark' ? 1440 : 360, height: 900 })
    await expect.poll(async () => {
      const resized = await island.boundingBox()
      return Math.abs(resized!.x + resized!.width / 2 - page.viewportSize()!.width / 2)
    }).toBeLessThan(1)
    await page.locator('.person-compose textarea').click()
    await expect(page.locator('.person-compose textarea')).toBeFocused()
    await island.focus(); await page.keyboard.press('Enter')
    await expect(page.locator('.session-tasks-drawer')).toBeVisible()
    await page.keyboard.press('Escape')
    await page.goto('/#/hermes/theme')
    await expect(island).toHaveCount(0)
  })

  test(`Person background-task island follows wallpaper, regional and reset themes in ${mode}`, async ({ page }) => {
    await setup(page, mode, true, false)
    const island = page.locator('.person-task-island')
    async function open() { await page.goto('/#/person'); await backgroundTaskCount(page, 2); await expect(island).toBeVisible() }
    const wallpaper = mode === 'light' ? 'rgba(255, 255, 255, 0.72)' : 'rgba(42, 42, 42, 0.72)'
    await open()
    await expect(island).toHaveCSS('background-color', wallpaper)
    await page.goto('/#/hermes/theme')
    await page.getByTestId('theme-global-backgroundColor').fill('#223344')
    await page.getByTestId('theme-global-opacity').fill('0.4')
    await page.getByTestId('theme-global-opacity').dispatchEvent('change')
    await open()
    await expect(island).toHaveCSS('background-color', 'rgba(34, 51, 68, 0.4)')
    await page.goto('/#/hermes/theme')
    await page.getByTestId('theme-scope').selectOption('card')
    await page.getByTestId('theme-card-backgroundColor').fill('#336699')
    await page.getByTestId('theme-card-opacity').fill('0')
    await page.getByTestId('theme-card-opacity').dispatchEvent('change')
    await page.getByTestId('theme-card-radius').fill('18')
    await page.getByTestId('theme-card-radius').dispatchEvent('change')
    await page.getByTestId('theme-card-blur').fill('4')
    await page.getByTestId('theme-card-blur').dispatchEvent('change')
    await open()
    await expect(island).toHaveCSS('background-color', 'rgba(51, 102, 153, 0)')
    await expect(island).toHaveCSS('border-radius', '18px')
    await expect(island).toHaveCSS('opacity', '1')
    await expect(island).toHaveCSS('backdrop-filter', /blur\(4px\)/)
    await page.goto('/#/hermes/theme')
    await page.getByRole('button', { name: 'Restore defaults', exact: true }).click()
    await open()
    await expect(island).toHaveCSS('background-color', wallpaper)
    await page.goto('/#/hermes/theme')
    await page.getByRole('button', { name: 'Remove', exact: true }).click()
    await open()
    await expect(island).toHaveCSS('background-color', mode === 'light' ? 'rgb(255, 255, 255)' : 'rgb(42, 42, 42)')
  })
}

test('Person background-task island supports reduced motion and hides for main-chat activity alone', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await setup(page, 'light', false, false)
  await page.goto('/#/person')
  await backgroundTaskCount(page, 0, 'thinking')
  await expect(page.locator('.person-task-island')).toHaveCount(0)
  await backgroundTaskCount(page, 1)
  const island = page.getByRole('button', { name: 'zhezhe · Background tasks · 1', exact: true })
  await expect(island).toBeVisible()
  await expect(island.locator('img')).toHaveAttribute('src', '/coding-agents/person.jpg')
  expect(await island.evaluate(element => element.getAnimations().length)).toBe(0)
  await island.click()
  await expect(page.locator('.session-tasks-drawer')).toBeVisible()
})

test('Person general settings save independently, survive refresh and retain drafts across tabs', async ({ page }) => {
  const { state, operations } = await setup(page, 'light', false, false)
  const originalAgents = structuredClone(state.settings.agents)
  await page.goto('/#/person')
  await page.locator('.person-header-actions').getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(page.getByRole('tab', { name: 'General', exact: true })).toHaveAttribute('aria-selected', 'true')
  const panel = page.locator('.person-general-settings')
  const save = panel.getByRole('button', { name: 'Save', exact: true })
  await expect(save).toBeDisabled()
  await expect(panel.locator('.model-context-capacity')).toContainText('200,000')
  await expect(panel.getByRole('textbox', { name: 'Compression Threshold' })).toBeDisabled()
  await panel.getByRole('switch', { name: 'Follow global threshold' }).click()
  await panel.getByRole('textbox', { name: 'Compression Threshold' }).fill('60')
  await panel.getByRole('textbox', { name: 'Maximum steps per reply' }).fill('20')
  await panel.getByRole('textbox', { name: 'Concurrent background tasks' }).fill('3')
  await panel.locator('.n-select').click()
  await panel.locator('.n-base-selection-input').fill('Asia/Shanghai')
  await page.locator('.n-base-select-option__content:visible').getByText('Asia/Shanghai', { exact: true }).click()
  await page.getByRole('tab', { name: /^Agents/ }).click()
  await expect(page.locator('.agent-card')).toHaveCount(1)
  await page.getByRole('tab', { name: 'General', exact: true }).click()
  await expect(panel.getByRole('textbox', { name: 'Compression Threshold' })).toHaveValue('60')
  await save.click()
  await expect(panel.getByRole('status')).toHaveText('Settings saved')
  expect(operations.filter(op => op.path.endsWith('/settings')).at(-1).body).toEqual({ compressionThreshold: 0.6, maxSteps: 20, maxConcurrentTasks: 3, timezone: 'Asia/Shanghai', expected_revision: 0 })
  expect(state.settings.agents).toEqual(originalAgents)
  expect(state.settings.model.model).toBe('global-model')
  await page.reload()
  await page.locator('.person-header-actions').getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(panel.getByRole('textbox', { name: 'Compression Threshold' })).toHaveValue('60')
  await expect(panel.getByRole('textbox', { name: 'Maximum steps per reply' })).toHaveValue('20')
  await expect(panel.getByRole('textbox', { name: 'Concurrent background tasks' })).toHaveValue('3')
  await expect(panel.locator('.n-select')).toContainText('Asia/Shanghai')
})

test('Person general settings preserve edits on conflicts and prevent writes during a reply', async ({ page }) => {
  const { state, operations } = await setup(page, 'dark')
  await page.goto('/#/person')
  await page.locator('.person-header-actions').getByRole('button', { name: 'Settings', exact: true }).click()
  const panel = page.locator('.person-general-settings')
  const threshold = panel.getByRole('textbox', { name: 'Compression Threshold' })
  await panel.getByRole('switch', { name: 'Follow global threshold' }).click()
  const save = panel.getByRole('button', { name: 'Save', exact: true })
  await threshold.fill('65')
  state.settings.maxConcurrentTasks = 4; state.revision++
  await save.click()
  await expect(panel.getByRole('alert')).toContainText('Settings changed')
  await expect(threshold).toHaveValue('65')
  await expect(panel.getByRole('textbox', { name: 'Concurrent background tasks' })).toHaveValue('4')
  await expect(panel.getByRole('status')).toHaveText('Unsaved changes')
  await save.click()
  await expect(panel.getByRole('status')).toHaveText('Settings saved')
  expect(operations.filter(op => op.path.endsWith('/settings')).at(-1).body).toEqual({ compressionThreshold: 0.65, expected_revision: 1 })
  await panel.getByRole('textbox', { name: 'Maximum steps per reply' }).fill('')
  await panel.getByRole('textbox', { name: 'Maximum steps per reply' }).press('Tab')
  await expect(save).toBeDisabled()
  await panel.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(threshold).toHaveValue('65')
  await threshold.fill('55')
  await threshold.press('Tab')
  await emit(page, 'run.started', {})
  await expect(save).toBeDisabled()
  await expect(panel.getByRole('alert')).toContainText('Settings can be saved after the current reply finishes.')
  await emit(page, 'run.completed', { output: 'Done' })
  await expect(save).toBeEnabled()
})

test('Person compression follows the interaction model and can restore the global threshold', async ({ page }) => {
  const { state, operations } = await setup(page, 'light', false, false)
  await page.goto('/#/person')
  const settings = page.locator('.person-header-actions').getByRole('button', { name: 'Settings', exact: true })
  const panel = page.locator('.person-general-settings')
  await settings.click()
  await panel.getByRole('switch', { name: 'Follow global threshold' }).click()
  await panel.getByRole('textbox', { name: 'Compression Threshold' }).fill('60')
  await panel.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(panel).toContainText('120,000 tokens')
  await page.keyboard.press('Escape')
  await page.locator('.input-model-button').click()
  await page.locator('.model-cascader:visible').getByRole('menuitemradio').filter({ hasText: 'fast-model' }).click()
  await settings.click()
  await expect(panel.locator('.model-context-name')).toHaveText('fast-model')
  await expect(panel.locator('.model-context-capacity')).toContainText('128,000')
  await expect(panel).toContainText('76,800 tokens')
  // The interaction model changed; the independent worker preset is unchanged.
  expect(state.settings.agents[0].selection.model).toBe('global-model')
  state.compression.globalThreshold = 0.7
  await panel.getByRole('switch', { name: 'Follow global threshold' }).click()
  await panel.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(panel.getByRole('textbox', { name: 'Compression Threshold' })).toHaveValue('70')
  await expect(panel.getByRole('textbox', { name: 'Compression Threshold' })).toBeDisabled()
  await expect(panel).toContainText('89,600 tokens')
  expect(operations.filter(op => op.path.endsWith('/settings')).at(-1).body).toEqual({ compressionThreshold: null, expected_revision: 2 })
})

for (const mode of ['light', 'dark'] as const) {
  test(`Person general cards follow global, regional and restored themes in ${mode}`, async ({ page }) => {
    await setup(page, mode, true, false)
    const card = page.locator('.person-general-settings .context-card')
    async function openSettings() {
      await page.goto('/#/person')
      await page.locator('.person-header-actions').getByRole('button', { name: 'Settings', exact: true }).click()
      await expect(card).toBeVisible()
    }
    const wallpaper = mode === 'light' ? 'rgba(255, 255, 255, 0.72)' : 'rgba(42, 42, 42, 0.72)'
    await openSettings()
    await expect(card).toHaveCSS('background-color', wallpaper)
    await page.keyboard.press('Escape')
    await page.goto('/#/hermes/theme')
    await page.getByTestId('theme-global-backgroundColor').fill('#223344')
    await page.getByTestId('theme-global-opacity').fill('0.4')
    await page.getByTestId('theme-global-opacity').dispatchEvent('change')
    await openSettings()
    await expect(card).toHaveCSS('background-color', 'rgba(34, 51, 68, 0.4)')
    await page.keyboard.press('Escape')
    await page.goto('/#/hermes/theme')
    await page.getByTestId('theme-scope').selectOption('card')
    await page.getByTestId('theme-card-opacity').fill('0')
    await page.getByTestId('theme-card-opacity').dispatchEvent('change')
    await openSettings()
    await expect(card).toHaveCSS('background-color', 'rgba(34, 51, 68, 0)')
    await expect(card).toHaveCSS('opacity', '1')
    await page.keyboard.press('Escape')
    await page.goto('/#/hermes/theme')
    await page.getByRole('button', { name: 'Restore defaults', exact: true }).click()
    await openSettings()
    await expect(card).toHaveCSS('background-color', wallpaper)
    await page.keyboard.press('Escape')
    await page.goto('/#/hermes/theme')
    await page.getByRole('button', { name: 'Remove', exact: true }).click()
    await openSettings()
    await expect(card).toHaveCSS('background-color', mode === 'light' ? 'rgb(255, 255, 255)' : 'rgb(42, 42, 42)')
  })
}

for (const mode of ['light', 'dark'] as const) {
  for (const width of [1440, 390]) {
    test(`Person general settings preview in ${mode} at ${width}px`, async ({ page }) => {
      const { state } = await setup(page, mode, mode === 'dark', mode === 'dark')
      await page.addInitScript(() => localStorage.setItem('hermes_locale', 'zh'))
      await page.setViewportSize({ width, height: 960 })
      await page.goto('/#/person')
      await page.locator('.person-header-actions').getByRole('button', { name: '设置', exact: true }).click()
      const panel = page.locator('.person-general-settings')
      await expect(panel.getByRole('heading', { name: '通用设置' })).toBeVisible()
      await expect(panel.locator('.model-context-capacity')).toContainText('200,000')
      await expect(panel.getByRole('textbox', { name: '压缩阈值' })).toHaveValue('50')
      await expect(panel).toContainText('100,000 tokens')
      await page.mouse.move(100, 200)
      await page.evaluate(async () => { await Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))) })
      const drawer = page.locator('.person-workspace-drawer')
      expect(await drawer.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
      expect(await panel.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
      await page.screenshot({ path: `/tmp/person-general-${mode}-${width}.png`, animations: 'disabled' })
      await page.getByRole('tab', { name: /智能体/ }).click()
      await expect(page.locator('.agent-card')).toHaveCount(1)
    })
  }
}

for (const { locale, title, width } of [
  { locale: 'zh', title: '个人助理', width: 1280 },
  { locale: 'zh', title: '个人助理', width: 390 },
  { locale: 'ja', title: 'パーソナルアシスタント', width: 390 },
  { locale: 'ar', title: 'المساعد الشخصي', width: 390 },
]) {
  test(`localizes the assistant title and keeps zhezhe's identity in ${locale} at ${width}px`, async ({ page }) => {
    await setup(page, 'light', false)
    await page.addInitScript(value => localStorage.setItem('hermes_locale', value), locale)
    await page.setViewportSize({ width, height: 844 })
    await page.goto('/#/person')
    await expect(page.locator('.person-title')).toHaveText(title)
    await expect(page.locator('.empty-logo--person')).toHaveAttribute('alt', 'zhezhe')
    await expect(page.locator('.input-settings-button')).toHaveCount(0)
    await expect(page.locator('.person-header-actions')).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect(await page.locator('.person-header-actions').evaluate(el => {
      const bounds = el.getBoundingClientRect()
      return bounds.left >= 0 && bounds.right <= innerWidth
    })).toBe(true)
    await page.screenshot({ path: `/tmp/person-interface-${locale}-${width}.png`, animations: 'disabled' })
  })
}

for (const mode of ['light', 'dark'] as const) {
  test(`Person reuses single chat controls, inherits defaults and switches models in ${mode}`, async ({ page }) => {
    const { state, operations } = await setup(page, mode)
    await page.goto('/#/person')
    const input = page.getByPlaceholder('Type a message... (Enter to send, Shift+Enter for new line)')
    await expect(page.locator('.person-title')).toHaveText('Personal assistant')
    await expect(page.locator('.input-settings-button')).toHaveCount(0)
    await expect(page.locator('.input-model-button')).toHaveAttribute('aria-label', 'global-model')
    await expect(page.getByRole('heading', { name: 'Choose a model' })).toHaveCount(0)
    await expect(input).toBeVisible()
    await page.screenshot({ path: `/tmp/person-chat-${mode}-empty.png`, animations: 'disabled' })
    await page.locator('.reasoning-effort-button').click()
    const slider = page.getByRole('slider')
    await expect(slider).toHaveAttribute('aria-valuemax', '2')
    await slider.focus()
    for (let step = 0; step < 3; step++) await page.keyboard.press('ArrowRight')
    await expect(page.locator('.reasoning-effort-button')).toHaveAttribute('aria-label', /high/i)
    await page.keyboard.press('Escape')
    await input.fill('Check the report')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect.poll(() => page.evaluate(() => (window as any).__PW_CHAT_SOCKET__.emitted.filter((e: any) => e.event === 'run').length)).toBe(1)
    const run = await page.evaluate(() => (window as any).__PW_CHAT_SOCKET__.emitted.find((e: any) => e.event === 'run').payload)
    expect(run).toMatchObject({ session_id: 'person-main-1', agent_id: 'ekko-agent', model: 'global-model', reasoning_effort: 'high' })
    await emit(page, 'run.started', { run_id: 'person-run' })
    await expect(page.locator('.thinking-avatar')).toHaveAttribute('src', '/person/thinking.gif')
    await expect.poll(() => page.locator('.thinking-avatar').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true)
    await emit(page, 'reasoning.delta', { delta: 'Checking the task requirements.' })
    await expect(page.locator('.live-reasoning-detail')).toContainText('Checking the task requirements.')
    await page.mouse.move(600, 30)
    await page.locator('.thinking-avatar').scrollIntoViewIfNeeded()
    await page.screenshot({ path: `/tmp/person-animation-thinking-${mode}.png`, animations: 'disabled' })
    await emit(page, 'tool.started', { tool_call_id: 'tasks-query', tool: 'bot_tasks_query', arguments: {} })
    await expect(page.locator('.tool-call-name')).toHaveCount(0)
    await emit(page, 'tool.completed', { tool_call_id: 'tasks-query', tool: 'bot_tasks_query', output: '{"tasks":[]}' })
    await emit(page, 'message.delta', { delta: 'I will follow up on your task.' })
    await emit(page, 'run.completed', { run_id: 'person-run', output: 'I will follow up on your task.' })
    await expect(page.locator('.streaming-indicator .thinking-status')).toHaveCount(0)
    await expect(page.getByText('I will follow up on your task.')).toBeVisible()
    await expect(page.locator('.tool-run-card')).toHaveCount(0)
    await expect(page.getByText('bot_tasks_query', { exact: true })).toHaveCount(0)
    await expect(page.locator('.assistant-message-author .message-author-name')).toHaveText('zhezhe')
    expect(operations.some(op => op.path.endsWith('/chat'))).toBe(false)
    expect(operations.filter(op => op.path.endsWith('/settings')).at(-1).body.reasoning_effort).toBe('high')
    await page.mouse.move(600, 30)
    await page.screenshot({ path: `/tmp/person-chat-${mode}-desktop.png`, animations: 'disabled' })

    await page.locator('.input-model-button').click()
    const menu = page.locator('.model-cascader:visible')
    await expect(menu).toBeVisible()
    await page.screenshot({ path: `/tmp/person-chat-${mode}-models.png`, animations: 'disabled' })
    await menu.getByRole('menuitemradio').filter({ hasText: 'fast-model' }).click()
    await expect(page.locator('.input-model-button')).toHaveAttribute('aria-label', 'fast-model')
    await page.reload()
    await expect(page.locator('.input-model-button')).toHaveAttribute('aria-label', 'fast-model')
    await page.locator('.reasoning-effort-button').click()
    await expect(page.getByRole('slider')).toHaveAttribute('aria-disabled', 'true')
    await page.keyboard.press('Escape')
    await page.locator('.input-model-button').click()
    await page.getByRole('button', { name: 'Use global default model', exact: true }).click()
    await expect(page.locator('.input-model-button')).toHaveAttribute('aria-label', 'global-model')

    await page.getByRole('button', { name: 'Tasks', exact: true }).click()
    await expect(page.locator('[role=status]:visible')).toContainText('Running')
    await expect(page.locator('.task-row button[aria-haspopup=menu]:visible')).toBeDisabled()
    await expect(page.getByRole('button', { name: /^(Pause|Resume|Cancel run|Accept result|Details)$/ })).toHaveCount(0)
    await page.screenshot({ path: `/tmp/person-tasks-${mode}-running.png`, animations: 'disabled' })
    await page.keyboard.press('Escape')
    state.memories = [{ id: 'saved-memory', revision: 2, content: 'Keep responses short' }]
    await page.locator('.person-header-actions').getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('tab', { name: /Memory/ }).click()
    await expect(page.getByText('Keep responses short', { exact: true })).toBeVisible()
    await expect(page.getByText('Tell zhezhe what to remember or correct', { exact: false })).toBeVisible()
    await expect(page.getByRole('textbox', { name: 'Memory', exact: true })).toHaveCount(0)
    await page.evaluate(async () => {
      await Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity)
        .map(animation => animation.finished.catch(() => {})))
    })
    await page.screenshot({ path: `/tmp/person-memory-${mode}.png` })
    await page.getByRole('button', { name: 'Forget', exact: true }).click()
    await expect(page.getByText('Keep responses short', { exact: true })).toHaveCount(0)
    expect(operations.filter(op => op.path.endsWith('/memory')).at(-1).body).toEqual({ id: 'saved-memory', expected_revision: 2, forget: true })
    await page.keyboard.press('Escape')
    await expect(page.locator('.n-drawer:visible')).toHaveCount(0)
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(input).toBeVisible()
    await expect(page.locator('.input-model-button')).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.screenshot({ path: `/tmp/person-chat-${mode}-mobile.png`, animations: 'disabled' })
    await page.locator('.input-model-button').click()
    await expect(menu.getByRole('menuitemradio').filter({ hasText: 'global-model' })).toBeVisible()
    await page.keyboard.press('Escape')
    expect(operations.every(op => !op.headers['x-hermes-profile'])).toBe(true)
    expect(operations.some(op => op.path.endsWith('/tasks/apply'))).toBe(false)
  })
}

test('Person replays single-chat questions and uses the same reply, approval and abort events', async ({ page }) => {
  await setup(page, 'light', false)
  await page.addInitScript(() => {
    (window as any).__PW_CHAT_SOCKET_RESUMES__['person-main-1'] = {
      session_id: 'person-main-1', messages: [{ id: 1, role: 'user', content: 'Check report', timestamp: 1 }], isWorking: true,
      events: [{ event: 'clarify.requested', data: { event: 'clarify.requested', session_id: 'person-main-1', clarify_id: 'person-interaction:q:0', question: 'Which report?', choices: ['Weekly', 'Monthly'], durable: true } }],
    }
  })
  await page.goto('/#/person')
  await expect(page.getByText('Which report?', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Weekly', exact: true })).toHaveCount(1)
  await expect(page.locator('.pending-interaction-countdown:visible')).toHaveCount(0)
  await page.getByRole('button', { name: 'Weekly', exact: true }).click()
  await expect.poll(() => emitted(page, 'clarify.respond')).toEqual([expect.objectContaining({ session_id: 'person-main-1', clarify_id: 'person-interaction:q:0', response: 'Weekly' })])
  await emit(page, 'clarify.resolved', { clarify_id: 'person-interaction:q:0', resolved: true })
  await emit(page, 'approval.requested', { approval_id: 'person-interaction:a:0', command: 'Publish report', description: 'Allow publishing this report?', choices: ['once','deny'], allow_permanent: false })
  await expect(page.getByText('Allow publishing this report?')).toBeVisible()
  await page.getByRole('button', { name: 'Allow once', exact: true }).click()
  await expect.poll(() => emitted(page, 'approval.respond')).toEqual([expect.objectContaining({ session_id: 'person-main-1', approval_id: 'person-interaction:a:0', choice: 'once' })])
  await emit(page, 'approval.resolved', { approval_id: 'person-interaction:a:0', resolved: true, choice: 'once' })
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Stop', exact: true }).click()
  await expect.poll(() => emitted(page, 'abort')).toEqual([expect.objectContaining({ session_id: 'person-main-1' })])
  await emit(page, 'abort.completed', { synced: true })
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible()
  expect(await emitted(page, 'run')).toEqual([])
})

async function emit(page: Page, event: string, payload: Record<string, unknown>) {
  await page.evaluate(({ event, payload }) => (window as any).__PW_CHAT_SOCKET__.broadcast(event, { event, session_id: 'person-main-1', run_id: 'person-run', ...payload }), { event, payload })
}
async function emitted(page: Page, event: string) {
  return page.evaluate(event => (window as any).__PW_CHAT_SOCKET__.emitted.filter((e: any) => e.event === event).map((e: any) => e.payload), event)
}

test('Person displays a delivered screenshot while keeping the artifact tool hidden', async ({ page }) => {
  await setup(page, 'light', false)
  const path = '/Users/tester/person/workspace/桌面 screenshot.png'
  const png = await sharp({ create: { width: 320, height: 180, channels: 3, background: '#f9ad42' } }).png().toBuffer()
  let downloadedPath = ''
  await page.route('**/api/studio/files/download?*', route => {
    downloadedPath = new URL(route.request().url()).searchParams.get('path') || ''
    return route.fulfill({ contentType: 'image/png', body: png })
  })
  await page.goto('/#/person')
  const input = page.getByPlaceholder('Type a message... (Enter to send, Shift+Enter for new line)')
  await input.fill('你桌面截个图发我')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect.poll(() => emitted(page, 'run')).toHaveLength(1)
  await emit(page, 'run.started', {})
  await emit(page, 'tool.started', { tool_call_id: 'screenshot', tool: 'bot_artifact_read', arguments: { path } })
  await emit(page, 'tool.completed', { tool_call_id: 'screenshot', tool: 'bot_artifact_read', output: JSON.stringify({ absolute_path: path, kind: 'image', size: png.length }) })
  const output = `![桌面截图](<${path}>)`
  await emit(page, 'message.delta', { delta: output })
  await emit(page, 'run.completed', { output })
  const image = page.getByRole('img', { name: '桌面截图', exact: true })
  await expect(image).toBeVisible()
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(320)
  expect(downloadedPath).toBe(path)
  await expect(page.locator('.tool-run-card')).toHaveCount(0)
  await expect(page.getByText('bot_artifact_read', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible()
})

for (const mode of ['light', 'dark'] as const) {
  test(`Person navigation follows account presence on desktop and mobile in ${mode}`, async ({ page }) => {
    await setup(page, mode, mode === 'dark')
    await page.goto('/#/person')
    const avatar = page.locator('.studio-navigation-rail__avatar:visible')
    for (const state of ['idle', 'thinking', 'searching', 'done', 'error', 'sleeping']) {
      await expect.poll(() => page.evaluate(() => (window as any).__PW_CHAT_SOCKET__?.allSockets?.some((socket: any) => String(socket.url).endsWith('/person-presence')))).toBe(true)
      await page.evaluate(state => {
        const socket = (window as any).__PW_CHAT_SOCKET__.allSockets.find((socket: any) => String(socket.url).endsWith('/person-presence'))
        socket.__trigger('person.presence', { state, lastActivityAt: 1, sleepAt: 600001 })
      }, state)
      await expect(avatar).toHaveAttribute('src', `/person/${state}.gif`)
      await expect.poll(() => avatar.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true)
      await page.screenshot({ path: `/tmp/person-animation-${mode}-${state}.png`, animations: 'disabled' })
    }
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByRole('button', { name: 'Menu', exact: true }).click()
    await expect(page.locator('.studio-mobile-drawer')).toBeVisible()
    await expect(avatar).toBeInViewport()
    await expect(avatar).toHaveAttribute('src', '/person/sleeping.gif')
    await expect.poll(() => avatar.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true)
    await page.screenshot({ path: `/tmp/person-animation-${mode}-mobile.png`, animations: 'disabled' })
    await expect.poll(() => page.evaluate(() => (window as any).__PW_CHAT_SOCKET__.emitted.some((event: any) => event.event === 'person.activity'))).toBe(true)
    await page.getByRole('link', { name: 'Your account assistant', exact: true }).click()
    await expect(page.locator('.studio-mobile-drawer')).not.toBeVisible()
  })
}

for (const mode of ['light', 'dark'] as const) {
  test(`Person shows a durable task return card above usage and opens the task drawer in ${mode}`, async ({ page }) => {
    const { state } = await setup(page, mode, false, false)
    state.tasks[0].running = false
    state.tasks[0].status = 'completed'
    state.tasks[0].execution_state = 'finished'
    const summary = 'Verify the report against the original source material.\nInclude a concise explanation of the findings, supporting evidence and any remaining questions so the user can review the full result.'
    const agent = mode === 'light' ? 'codex' : 'ekko'
    state.tasks[0].summary = summary
    state.tasks[0].selection_json = JSON.stringify({ runtime: agent })
    const receipt = { taskId: 'task1', executionId: 'execution1', assistantMessageId: '42', title: 'Check report', summary, agent, state: 'finished' }
    const usage = { runId: 'return-run', assistantMessageId: '42', inputTokens: 120, outputTokens: 35, isEstimated: false }
    await page.goto('/#/person')
    await expect(page.locator('.person-compose .input-textarea')).toBeVisible()
    await emit(page, 'run.started', { run_id: 'return-run', autonomous: true })
    await emit(page, 'message.delta', { run_id: 'return-run', delta: 'Your report is ready.' })
    await emit(page, 'run.completed', { run_id: 'return-run', message_id: '42', output: 'Your report is ready.', person_task_return: receipt, run_usage: usage })
    const card = page.locator('.person-task-return-card')
    await expect(card).toHaveCount(1)
    await expect(card.getByRole('status')).toHaveText('Completed')
    await expect(card.getByRole('img', { name: mode === 'light' ? 'Codex' : 'Ekko' })).toBeVisible()
    await expect(card).toContainText('Check report')
    expect(await card.evaluate(element => element.nextElementSibling?.classList.contains('run-usage-card'))).toBe(true)
    await page.addInitScript(({ receipt, usage }) => {
      (window as any).__PW_CHAT_SOCKET_RESUMES__['person-main-1'] = {
        session_id: 'person-main-1', isWorking: false, events: [], messages: [
          { id: 40, role: 'assistant', content: 'Unrelated reply', timestamp: 1 },
          { id: 42, role: 'assistant', content: 'Your report is ready.', timestamp: 2, person_task_return: receipt, run_usage: usage },
        ],
      }
      ;(window as any).__PW_CHAT_SOCKET_RESUMES__['person-task-task1'] = {
        session_id: 'person-task-task1', isWorking: false, events: [], messages: [{ id: 50, role: 'assistant', content: 'Task output', timestamp: 1 }],
      }
    }, { receipt, usage })
    await page.reload()
    await expect(card).toHaveCount(1)
    await expect(card).toBeVisible()
    expect(await card.evaluate(element => element.nextElementSibling?.classList.contains('run-usage-card'))).toBe(true)
    await page.locator('.person-compose .input-textarea').fill('Keep draft')
    await page.screenshot({ path: `/tmp/person-return-card-${mode}.png`, animations: 'disabled' })
    const details = card.locator('details')
    await expect(details).not.toHaveAttribute('open')
    await details.locator('summary').click()
    await expect(details).toHaveAttribute('open')
    await expect(page.locator('.person-task-chat')).toHaveCount(0)
    expect(await card.locator('.task-return-description').evaluate(el => getComputedStyle(el).whiteSpace)).toBe('pre-wrap')
    await page.screenshot({ path: `/tmp/person-return-card-${mode}-expanded.png`, animations: 'disabled' })
    await details.locator('summary').click()
    await expect(details).not.toHaveAttribute('open')
    const tagStyle = await card.getByRole('status').evaluate(el => {
      const s = getComputedStyle(el); return [s.color, s.backgroundColor, s.borderRadius, s.padding, s.fontSize]
    })
    await page.getByRole('button', { name: 'Tasks', exact: true }).click()
    expect(await page.locator('.status-cell .task-status').evaluate(el => {
      const s = getComputedStyle(el); return [s.color, s.backgroundColor, s.borderRadius, s.padding, s.fontSize]
    })).toEqual(tagStyle)
    await page.keyboard.press('Escape')
    await card.getByRole('button', { name: 'View in conversation: Check report' }).click()
    const drawer = page.locator('.person-task-chat')
    await expect(drawer.getByText('Task output', { exact: true })).toBeVisible()
    await expect(page.locator('.person-compose .input-textarea')).toHaveValue('Keep draft')
    expect(await page.evaluate(() => localStorage.getItem('hermes_active_session_default'))).toBe('person-main-1')
    await page.keyboard.press('Escape')
    await expect(drawer).toHaveCount(0)
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(card).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await details.locator('summary').click()
    await expect(details).toHaveAttribute('open')
    await page.screenshot({ path: `/tmp/person-return-card-${mode}-mobile.png`, animations: 'disabled' })
    await card.getByRole('button', { name: 'View in conversation: Check report' }).click()
    await expect(drawer.getByText('Task output', { exact: true })).toBeVisible()
  })
}

test('Person offers model selection when the global default is unavailable', async ({ page }) => {
  const { state } = await setup(page, 'dark', false)
  state.settings.model = null; state.reasoning_efforts = []
  await page.goto('/#/person')
  await page.screenshot({ path: '/tmp/person-chat-dark-preset.png', animations: 'disabled' })
  await page.locator('.input-textarea').fill('Hello')
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Global default model is unavailable. Choose a model.' }).click()
  await page.getByRole('menuitemradio').filter({ hasText: 'fast-model' }).click()
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled()
})


test('Person saves agent presets, preserves unsaved edits and only offers opening or closing idle tasks', async ({ page }) => {
  const { state, operations } = await setup(page, 'light')
  await page.goto('/#/person')
  await page.locator('.person-header-actions').getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('tab', { name: /^Agents/ }).click()
  await expect(page.locator('.agent-card')).toContainText('Research assistant')
  await page.getByRole('button', { name: 'Add agent', exact: true }).click()
  await page.getByRole('textbox', { name: 'Agent name', exact: true }).fill('Research assistant')
  await page.getByRole('textbox', { name: 'Purpose', exact: true }).fill('Research and write reports')
  await emit(page, 'person.updated', {})
  await expect(page.getByRole('textbox', { name: 'Agent name', exact: true })).toHaveValue('Research assistant')
  await page.getByRole('button', { name: 'Codex', exact: true }).click()
  await page.locator('.person-agent-settings .scoped-model-selector button').click()
  await page.getByRole('menuitemradio').filter({ hasText: 'global-model' }).click()
  await page.locator('.person-agent-settings .n-select').last().click()
  await page.locator('.n-base-select-option__content:visible').getByText('High', { exact: true }).click()
  state.revision++ // Another window changed settings; keep the draft retryable.
  await page.locator('.person-agent-settings').getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.locator('.person-agent-settings .n-alert')).toContainText('Settings changed')
  await expect(page.getByRole('textbox', { name: 'Agent name', exact: true })).toHaveValue('Research assistant')
  await page.locator('.person-agent-settings').getByRole('button', { name: 'Save', exact: true }).click()
  await expect.poll(() => state.settings.agents.length).toBe(2)
  expect(state.settings.agents[1]).toMatchObject({ name: 'Research assistant', description: 'Research and write reports', selection: { runtime: 'codex', mode: 'scoped', provider: 'provider', model: 'global-model', reasoningEffort: 'high' } })
  await page.screenshot({ path: '/tmp/person-agent-settings.png', animations: 'disabled' })
  await page.reload()
  await page.locator('.person-header-actions').getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('tab', { name: /^Agents/ }).click()
  await expect(page.locator('.agent-card').last()).toContainText('Research assistant')
  await page.locator('.agent-card').last().getByRole('button', { name: 'Edit', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Agent name', exact: true })).toHaveValue('Research assistant')
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: '/tmp/person-agent-settings-mobile.png', animations: 'disabled' })
  await page.locator('.person-agent-settings').getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.locator('.agent-card').last().getByRole('button', { name: 'Delete', exact: true }).click()
  await page.locator('.person-agent-settings').getByRole('button', { name: 'Save', exact: true }).click()
  await expect.poll(() => state.settings.agents.length).toBe(1)
  Object.assign(state.tasks[0], { execution_state: 'finished', status: 'completed', running: false })
  await emit(page, 'person.updated', {})
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Tasks', exact: true }).click()
  await expect(page.locator('[role=status]:visible')).toContainText('Completed')
  await expect(page.getByRole('button', { name: 'Accept result', exact: true })).toHaveCount(0)
  const status = page.locator('.task-row button[aria-haspopup=menu]:visible')
  await status.click()
  await expect(page.getByRole('menuitem')).toHaveCount(2)
  await page.getByRole('menuitem', { name: 'Closed', exact: true }).click()
  await expect(page.locator('[role=status]:visible')).toContainText('Closed')
  await status.click()
  await page.getByRole('menuitem', { name: 'Incomplete', exact: true }).click()
  await expect(page.locator('[role=status]:visible')).toContainText('Open')
  await page.screenshot({ path: '/tmp/person-tasks-mobile.png', animations: 'disabled' })
  expect(operations.filter(op => op.path.endsWith('/tasks/apply')).map(op => op.body.action)).toEqual(['close', 'reopen'])
})

for (const scenario of ['after-request', 'reconnect', 'idle-schedule'] as const) {
  test(`Person streams a background result to the main window (${scenario})`, async ({ page }) => {
    const { state, operations } = await setup(page, 'light', false)
    if (scenario === 'reconnect') {
      await page.addInitScript(() => { (window as any).__PW_CHAT_SOCKET_RESUMES__['person-main-1'].backgroundPending = 1 })
    }
    await page.goto('/#/person')
    const input = page.locator('.input-textarea')
    await expect(input).toBeVisible()
    if (scenario === 'after-request') {
      await input.fill('Check Xiamen weather')
      await page.getByRole('button', { name: 'Send', exact: true }).click()
      await emit(page, 'run.started', { run_id: 'foreground' })
      await emit(page, 'message.delta', { run_id: 'foreground', delta: 'I have started the background task.' })
      await page.evaluate(() => { (window as any).__PW_CHAT_SOCKET_RESUMES__['person-main-1'].backgroundPending = 1 })
      await emit(page, 'run.completed', { run_id: 'foreground', output: 'I have started the background task.', background_pending: 1 })
      await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible()
    }
    await emit(page, 'run.started', { run_id: 'callback', autonomous: true })
    await emit(page, 'message.delta', { run_id: 'callback', delta: 'Xiamen is sunny, 25°C.' })
    await expect(page.getByText('Xiamen is sunny, 25°C.', { exact: true })).toBeVisible()
    await emit(page, 'run.completed', { run_id: 'callback', output: 'Xiamen is sunny, 25°C.', autonomous: true, background_pending: 0 })
    Object.assign(state.tasks[0], { execution_state: 'finished', status: 'completed', running: false })
    await emit(page, 'person.updated', {})
    await expect(page.getByText('Xiamen is sunny, 25°C.', { exact: true })).toHaveCount(1)
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Tasks', exact: true }).click()
    await expect(page.locator('[role=status]:visible')).toContainText('Completed')
    expect(operations.some(op => op.path.endsWith('/tasks/apply'))).toBe(false)
    if (scenario === 'after-request') await page.screenshot({ path: '/tmp/person-background-return.png', animations: 'disabled' })
  })
}

test('opens a hidden task in a right drawer, continues it and restores the Person window', async ({ page }) => {
  const { state, operations } = await setup(page, 'light', false)
  Object.assign(state.tasks[0], { status: 'completed', running: false, execution_state: 'finished', updated_at: Date.now() })
  await page.addInitScript(() => {
    (window as any).__PW_CHAT_SOCKET_RESUMES__['person-task-task1'] = { session_id: 'person-task-task1', messages: [
      { id: 'previous-user', role: 'user', content: 'Remember report code LIME-42', timestamp: 1 },
      { id: 'previous-tool', role: 'tool', content: 'Stored the code', tool_name: 'write_file', tool_call_id: 'save-report', timestamp: 1.5 },
      { id: 'previous-answer', role: 'assistant', content: 'Saved report code LIME-42.', timestamp: 2 },
    ], isWorking: false, events: [] }
    ;(window as any).__PW_CHAT_SOCKET_RESUMES__['person-main-1'].messages = [{ id: 'main-answer', role: 'assistant', content: 'The report task has finished.', timestamp: 1 }]
  })
  await page.goto('/#/person')
  await page.locator('.person-compose .input-textarea').fill('Keep my main conversation draft')
  await page.getByRole('button', { name: 'Tasks', exact: true }).click()
  await expect(page.locator('.task-list')).toBeVisible()
  await expect(page.locator('.task-pagination')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^(Previous|More)$/ })).toHaveCount(0)
  await page.getByRole('button', { name: 'View in conversation: Check report', exact: true }).click()
  const dialog = page.locator('.person-task-chat')
  await expect(dialog.getByText('Saved report code LIME-42.', { exact: true })).toBeVisible()
  await expect(dialog.locator('.input-settings-button')).toHaveCount(0)
  await expect(dialog.locator('.message.tool, .tool-run-card')).toHaveCount(0)
  await expect(dialog.locator('.assistant-message-author .message-author-name')).toHaveText('Ekko')
  await expect(page.locator('.n-modal')).toHaveCount(0)
  const bounds = await dialog.boundingBox()
  expect(bounds?.y).toBeLessThanOrEqual(48)
  expect(bounds?.height).toBeGreaterThanOrEqual(page.viewportSize()!.height - 48)
  expect(bounds && Math.round(bounds.x + bounds.width)).toBe(page.viewportSize()!.width)
  await expect(page.locator('.person-compose')).toHaveCount(1)
  await expect(page.locator('.person-compose .input-textarea')).toHaveValue('Keep my main conversation draft')
  await expect(page.locator('.person-view').getByText('The report task has finished.', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('hermes_active_session_default'))).toBe('person-main-1')
  await dialog.locator('.input-textarea').fill('What code did I give you?')
  await dialog.getByRole('button', { name: 'Send', exact: true }).click()
  await expect.poll(() => operations.filter(op => op.path.endsWith('/tasks/task1/chat') && op.body).length).toBe(1)
  expect(operations.find(op => op.path.endsWith('/tasks/task1/chat') && op.body).body).toMatchObject({ input: [{ type: 'text', text: 'What code did I give you?' }], expected_revision: 0 })
  expect(await emitted(page, 'run')).toEqual([])
  await emit(page, 'run.started', { session_id: 'person-task-task1', run_id: 'task-followup' })
  await emit(page, 'tool.started', { session_id: 'person-task-task1', run_id: 'task-followup', tool_call_id: 'read-report', tool: 'read_file', arguments: {} })
  await expect(dialog.locator('.tool-call-name')).toHaveCount(0)
  await emit(page, 'tool.completed', { session_id: 'person-task-task1', run_id: 'task-followup', tool_call_id: 'read-report', tool: 'read_file', output: 'LIME-42' })
  await emit(page, 'message.delta', { session_id: 'person-task-task1', run_id: 'task-followup', delta: 'Your code was LIME-42.' })
  await expect(dialog.getByText('Your code was LIME-42.', { exact: true })).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled()
  await page.screenshot({ path: '/tmp/person-task-chat-desktop.png', animations: 'disabled' })
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: '/tmp/person-task-chat-mobile.png', animations: 'disabled' })
  await emit(page, 'run.started', { run_id: 'return-to-main', autonomous: true })
  await emit(page, 'message.delta', { run_id: 'return-to-main', delta: 'The follow-up result is LIME-42.' })
  await emit(page, 'run.completed', { run_id: 'return-to-main', output: 'The follow-up result is LIME-42.', background_pending: 0 })
  await expect(page.locator('.person-view').getByText('The follow-up result is LIME-42.', { exact: true })).toBeVisible()
  await expect(dialog.getByText('Your code was LIME-42.', { exact: true })).toBeVisible()
  await expect(dialog.getByText('The follow-up result is LIME-42.', { exact: true })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(page.locator('.person-compose .input-textarea')).toHaveValue('Keep my main conversation draft')
  await expect(page.getByText('The follow-up result is LIME-42.', { exact: true })).toBeVisible()

})


test('Person uses the single-chat task drawer with search and filters but no pagination controls', async ({ page }) => {
  const { state, operations } = await setup(page, 'dark', false)
  state.tasks = Array.from({ length: 60 }, (_, i) => ({ ...state.tasks[0], id: `task${i}`, title: `Report ${i + 1}`, updated_at: Date.now() - i * 1000, running: false, execution_state: 'finished', status: 'completed' }))
  await page.goto('/#/person')
  await page.getByRole('button', { name: 'Tasks', exact: true }).click()
  await expect(page.locator('.session-tasks-drawer .task-row')).toHaveCount(60)
  await expect(page.locator('.task-pagination')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^(Previous|More)$/ })).toHaveCount(0)
  expect(operations.find(op => op.path.endsWith('/tasks/query')).body.limit).toBe(100)
  await page.getByRole('button', { name: 'Filter task status' }).click()
  await page.getByRole('menuitem', { name: 'Completed', exact: true }).click()
  await expect.poll(() => operations.filter(op => op.path.endsWith('/tasks/query')).at(-1).body.status).toBe('completed')
  await page.getByRole('button', { name: 'Search tasks or conversations' }).click()
  await page.getByRole('textbox', { name: 'Search tasks or conversations' }).fill('Report 60')
  await expect.poll(() => operations.filter(op => op.path.endsWith('/tasks/query')).at(-1).body.search).toBe('Report 60')
})

for (const mode of ['light', 'dark'] as const) {
  test(`stops a Person task from the list and waits for acknowledgement in ${mode}`, async ({ page }) => {
    const { state, operations } = await setup(page, mode)
    if (mode === 'dark') await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/#/person')
    await page.getByRole('button', { name: 'Tasks', exact: true }).click()
    await page.getByRole('button', { name: 'Stop task', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Stopping', exact: true })).toBeDisabled()
    expect(operations.filter(op => op.path.endsWith('/tasks/apply')).map(op => op.body)).toEqual([
      { action: 'stop', task_id: 'task1', execution_id: 'execution1', expected_revision: 0, idempotency_key: expect.any(String) },
    ])
    await expect(page.locator('.task-row button[aria-haspopup=menu]:visible')).toBeDisabled()
    await page.mouse.move(2, 940)
        await page.evaluate(async () => { await Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))) })
    await page.screenshot({ path: `/tmp/person-stop-list-${mode}.png` })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    Object.assign(state.tasks[0], { running: false, execution_state: 'interrupted' })
    await emit(page, 'person.updated', {})
    await expect(page.locator('[role=status]:visible')).toContainText('Interrupted')
    await expect(page.getByRole('button', { name: 'Stopping', exact: true })).toHaveCount(0)
    await expect(page.locator('.task-row button[aria-haspopup=menu]:visible')).toBeEnabled()
    expect(await emitted(page, 'abort')).toEqual([])
  })
}

test('stops a waiting task inside its conversation, then continues it without stopping Person', async ({ page }) => {
  const { state, operations } = await setup(page, 'light', false)
  state.tasks[0].execution_state = 'waiting_user'
  await page.addInitScript(() => {
    (window as any).__PW_CHAT_SOCKET_RESUMES__['person-task-task1'] = { session_id: 'person-task-task1', messages: [], isWorking: false, events: [] }
  })
  await page.goto('/#/person')
  await page.locator('.person-compose .input-textarea').fill('Keep my draft')
  await emit(page, 'run.started', { run_id: 'main-active' })
  await page.getByRole('button', { name: 'Tasks', exact: true }).click()
  await page.getByRole('button', { name: 'View in conversation: Check report', exact: true }).click()
  const drawer = page.locator('.person-task-chat')
  await drawer.getByRole('button', { name: 'Stop task', exact: true }).click()
  await expect(drawer.getByRole('button', { name: 'Stopping', exact: true })).toBeDisabled()
  await expect(drawer.getByRole('button', { name: 'Stop', exact: true })).toBeDisabled()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.mouse.move(2, 940)
        await page.evaluate(async () => { await Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))) })
  await page.screenshot({ path: '/tmp/person-stop-chat-mobile.png' })
  Object.assign(state.tasks[0], { running: false, execution_state: 'interrupted' })
  await emit(page, 'person.updated', {})
  await expect(drawer.getByRole('button', { name: 'Stopping', exact: true })).toHaveCount(0)
  await drawer.locator('.input-textarea').fill('Continue from the saved result')
  await drawer.getByRole('button', { name: 'Send', exact: true }).click()
  expect(operations.find(op => op.path.endsWith('/tasks/task1/chat') && op.body).body.expected_revision).toBe(1)
  await expect(drawer.getByRole('button', { name: 'Stop task', exact: true })).toBeEnabled()
  expect(await emitted(page, 'abort')).toEqual([])
  await page.keyboard.press('Escape')
  await expect(page.locator('.person-compose .input-textarea')).toHaveValue('Keep my draft')
  await emit(page, 'message.delta', { run_id: 'main-active', delta: 'Person is still responding.' })
  await expect(page.locator('.person-view').getByText('Person is still responding.', { exact: true })).toBeVisible()
})

test('refreshes a stale stop without automatically cancelling a newer execution', async ({ page }) => {
  const { state, operations } = await setup(page, 'light', false)
  await page.goto('/#/person')
  await page.getByRole('button', { name: 'Tasks', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeVisible()
  Object.assign(state.tasks[0], { execution_id: 'execution2', revision: 2 })
  await page.getByRole('button', { name: 'Stop task', exact: true }).click()
  await expect(page.getByText('Could not update task status. Refresh and try again.')).toBeVisible()
  expect(operations.filter(op => op.path.endsWith('/tasks/apply'))).toHaveLength(1)
  expect(state.tasks[0].execution_state).toBe('running')
  await page.getByRole('button', { name: 'Stop task', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Stopping', exact: true })).toBeDisabled()
  expect(operations.filter(op => op.path.endsWith('/tasks/apply')).at(-1).body).toMatchObject({ execution_id: 'execution2', expected_revision: 2 })
})

for (const executionState of ['running', 'queued', 'waiting_user'] as const) {
  test(`stops ${executionState} Person work from the composer with a saved draft`, async ({ page }) => {
    const { state, operations } = await setup(page, executionState === 'queued' ? 'dark' : 'light', false)
    state.tasks[0].execution_state = executionState
    if (executionState !== 'running') await page.setViewportSize({ width: 390, height: 844 })
    await page.addInitScript(({ streaming }) => {
      (window as any).__PW_CHAT_SOCKET_RESUMES__['person-task-task1'] = { session_id: 'person-task-task1', messages: [], isWorking: streaming, events: [] }
    }, { streaming: executionState === 'running' })
    await page.goto('/#/person')
    await page.getByRole('button', { name: 'Tasks', exact: true }).click()
    await page.getByRole('button', { name: 'View in conversation: Check report', exact: true }).click()
    const drawer = page.locator('.person-task-chat')
    const composer = drawer.locator('.input-textarea')
    await composer.fill('Keep this follow-up draft')
    const stop = drawer.locator('.input-actions').getByRole('button', { name: 'Stop', exact: true })
    await expect(stop).toBeEnabled()
    await composer.press('Enter')
    expect(operations.filter(op => op.path.endsWith('/tasks/task1/chat') && op.body)).toHaveLength(0)
    await page.mouse.move(2, 940)
        await page.evaluate(async () => { await Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))) })
    await page.screenshot({ path: `/tmp/person-composer-stop-${executionState}.png` })
    await stop.click()
    await expect(stop).toBeDisabled()
    await expect(stop).toHaveAttribute('aria-busy', 'true')
    await expect(drawer.getByRole('button', { name: 'Stopping', exact: true })).toBeDisabled()
    await expect(composer).toHaveValue('Keep this follow-up draft')
    expect(operations.filter(op => op.path.endsWith('/tasks/apply')).map(op => op.body)).toEqual([
      { action: 'stop', task_id: 'task1', execution_id: 'execution1', expected_revision: 0, idempotency_key: expect.any(String) },
    ])
    expect(await emitted(page, 'abort')).toEqual([])
    await emit(page, 'run.failed', { session_id: 'person-task-task1', error: 'Person task stopped' })
    // The socket ending alone cannot restore Send before the durable stop acknowledgement.
    await expect(stop).toBeDisabled()
    Object.assign(state.tasks[0], { running: false, execution_state: 'interrupted' })
    await emit(page, 'person.updated', {})
    const send = drawer.locator('.input-actions').getByRole('button', { name: 'Send', exact: true })
    await expect(send).toBeEnabled()
    await expect(composer).toHaveValue('Keep this follow-up draft')
    await send.click()
    await expect.poll(() => operations.filter(op => op.path.endsWith('/tasks/task1/chat') && op.body).length).toBe(1)
    expect(operations.find(op => op.path.endsWith('/tasks/task1/chat') && op.body).body).toMatchObject({ expected_revision: 1, input: [{ type: 'text', text: 'Keep this follow-up draft' }] })
  })
}

for (const mode of ['light', 'dark'] as const) {
  for (const width of [1440, 390]) {
    test(`Person card workspace in ${mode} at ${width}px`, async ({ page }) => {
      const { state } = await setup(page, mode, false, false)
      await page.addInitScript(() => localStorage.setItem('hermes_locale', 'zh'))
      await page.setViewportSize({ width, height: 960 })
      state.tasks = [
        { id: 'task1', title: '每天一份 AI 行业简报', status: 'open' },
        { id: 'task2', title: '整理本周项目进展', status: 'open' },
        { id: 'task3', title: '检查产品反馈与新需求', status: 'open' },
        { id: 'task4', title: '月度阅读清单', status: 'open' },
      ]
      state.schedules = state.tasks.map((task: any, index: number) => ({ id: `s${index}`, task_id: task.id, expression: ['0 9 * * *', '0 18 * * 1-5', '30 10 * * 1-5', '2026-11-01T10:00:00+08:00'][index], timezone: 'Asia/Shanghai', next_at: Date.parse('2026-10-28T09:00:00+08:00') + index * 3600000, state: index === 2 ? 'paused' : 'active', revision: 0 }))
      state.memories = [
        '回答优先使用中文，先给结论，再补充必要的解释。',
        '我正在做 Ekko Studio，希望产品简单、清晰，让每个人都能用好 AI。',
        '界面喜欢有留白的卡片布局，注重排版和信息层次。',
        '技术调研优先查官方文档。重要结论附上来源，方便我继续阅读。',
        '通常在上午处理需要专注的工作，下午安排讨论和沟通。',
        '交付前请检查实际效果，涉及界面时给我看截图。',
      ].map((content, index) => ({ id: `m${index}`, content, revision: 0 }))
      state.settings.agents = [
        { id: 'research', name: '研究助理', description: '查找可靠来源，整理行业动态与技术资料，让每个结论都有依据。', selection: { runtime: 'ekko', mode: 'scoped', model: 'deepseek-chat', provider: 'provider', profile: 'default', reasoningEffort: 'high' } },
        { id: 'coder', name: '开发搭档', description: '处理代码实现、问题排查和测试验证，把想法变成可以运行的产品。', selection: { runtime: 'codex', mode: 'scoped', model: 'gpt-5-codex', provider: 'provider', profile: 'default', reasoningEffort: 'high' } },
      ]
      await page.route('**/api/studio/person/agent-models', route => route.fulfill({ json: { groups: [{ provider: 'provider', profile: 'default', label: '团队模型', models: ['deepseek-chat', 'gpt-5-codex'] }] } }))
      await page.goto('/#/person')
      await expect(page.locator('.person-header-actions').getByRole('button', { name: /定时计划|记忆/ })).toHaveCount(0)
      await page.locator('.person-header-actions').getByRole('button', { name: '设置', exact: true }).click()
      await page.getByRole('tab', { name: /定时计划/ }).click()
      const drawer = page.locator('.person-workspace-drawer')
      await expect(drawer.locator('.schedule-tile')).toHaveCount(4)
      await expect.poll(async () => (await drawer.boundingBox())?.width || 0).toBeGreaterThan(width === 390 ? 389 : 1100)
      const capture = async (name: string) => {
        await page.mouse.move(2, 940)
        await page.evaluate(async () => { await Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))) })
        expect(await drawer.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
        await page.screenshot({ path: `/tmp/person-ui-${name}-${mode}-${width}.png`, animations: 'disabled' })
      }
      await capture('schedules')
      await page.getByRole('tab', { name: /记忆/ }).click()
      await expect(drawer.locator('.memory-tile')).toHaveCount(6)
      await capture('memory')
      await page.getByRole('textbox', { name: '搜索', exact: true }).fill('官方文档')
      await expect(drawer.locator('.memory-tile')).toHaveCount(1)
      await page.getByRole('textbox', { name: '搜索', exact: true }).fill('不存在的记忆')
      await expect(drawer.locator('.memory-tile')).toHaveCount(0)
      await expect(drawer.locator('.panel-empty')).toBeVisible()
      await page.getByRole('tab', { name: /智能体/ }).click()
      await expect(drawer.locator('.agent-card')).toHaveCount(2)
      await capture('agents')
      await drawer.getByRole('button', { name: '添加 Agent', exact: true }).click()
      await drawer.locator('.runtime-option').filter({ hasText: 'Ekko' }).click()
      await page.getByRole('textbox', { name: 'Agent 名称', exact: true }).fill('新搭档')
      await page.getByRole('textbox', { name: '用途说明', exact: true }).fill('整理会议纪要，提炼关键决策，并持续跟进待办事项。')
      await drawer.locator('.scoped-model-selector button').click()
      await page.getByRole('menuitemradio').filter({ hasText: 'deepseek-chat' }).click()
      await capture('agent-editor')
      await drawer.getByRole('button', { name: '取消', exact: true }).click()
      await expect(drawer.locator('.agent-card')).toHaveCount(2)
    })
  }
}

test('Person schedule cards create, edit, pause, resume and cancel without losing a failed edit', async ({ page }) => {
  const { state, operations } = await setup(page, 'light', false)
  state.tasks[0].running = false
  await page.goto('/#/person')
  await page.locator('.person-header-actions').getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('tab', { name: /Schedules/ }).click()
  const drawer = page.locator('.person-workspace-drawer')
  await expect(drawer.locator('.panel-empty')).toBeVisible()
  await drawer.getByRole('button', { name: 'New schedule', exact: true }).click()
  await drawer.locator('.panel-editor .n-select').first().click()
  await page.locator('.n-base-select-option__content:visible').getByText('Check report', { exact: true }).click()
  await drawer.locator('.panel-editor').getByRole('button', { name: 'Save', exact: true }).click()
  await expect(drawer.locator('.schedule-tile')).toHaveCount(1)
  expect(state.schedules[0].expression).toBe('0 9 * * *')
  await expect(drawer.locator('.panel-editor')).toHaveCount(0)
  await drawer.getByRole('button', { name: 'Pause', exact: true }).click()
  await expect(drawer.locator('.n-tag')).toHaveText('Paused')
  await drawer.getByRole('button', { name: 'Resume', exact: true }).click()
  await expect(drawer.locator('.n-tag')).toHaveText('Active')
  await drawer.locator('.schedule-tile').getByRole('button', { name: 'Edit', exact: true }).click()
  await drawer.getByRole('textbox', { name: 'Timezone', exact: true }).fill('Asia/Shanghai')
  state.schedules[0].revision++
  await drawer.locator('.panel-editor').getByRole('button', { name: 'Save', exact: true }).click()
  await expect(drawer.locator('.workspace-error')).toContainText('Schedule changed')
  await expect(drawer.getByRole('textbox', { name: 'Timezone', exact: true })).toHaveValue('Asia/Shanghai')
  await drawer.locator('.panel-editor').getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.keyboard.press('Escape')
  await page.locator('.person-header-actions').getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('tab', { name: /Schedules/ }).click()
  await drawer.locator('.schedule-tile').getByRole('button', { name: 'Edit', exact: true }).click()
  await drawer.getByRole('textbox', { name: 'Timezone', exact: true }).fill('Asia/Shanghai')
  await drawer.locator('.panel-editor').getByRole('button', { name: 'Save', exact: true }).click()
  await expect(drawer.locator('.panel-editor')).toHaveCount(0)
  expect(state.schedules[0].timezone).toBe('Asia/Shanghai')
  await drawer.getByRole('button', { name: 'Cancel schedule', exact: true }).click()
  await expect(drawer.locator('.n-tag')).toHaveText('Cancelled')
  expect(operations.filter(op => op.path.endsWith('/schedules/apply')).map(op => op.body.action)).toEqual(['create', 'pause', 'resume', 'update', 'update', 'cancel'])
})

test('Person schedule editor preserves weekday, custom and one-time expressions', async ({ page }) => {
  const { state, operations } = await setup(page, 'light', false, false)
  await page.goto('/#/person')
  await page.locator('.person-header-actions').getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('tab', { name: /Schedules/ }).click()
  const drawer = page.locator('.person-workspace-drawer')
  await drawer.getByRole('button', { name: 'New schedule', exact: true }).click()
  await drawer.locator('.panel-editor .n-select').first().click()
  await page.locator('.n-base-select-option__content:visible').getByText('Check report', { exact: true }).click()
  await drawer.locator('.panel-editor .n-select').nth(2).click()
  await page.locator('.n-base-select-option__content:visible').getByText('Weekdays', { exact: true }).click()
  await drawer.locator('.panel-editor').getByRole('button', { name: 'Save', exact: true }).click()
  await expect(drawer.locator('.schedule-tile')).toHaveCount(1)
  expect(state.schedules[0].expression).toBe('0 9 * * 1-5')
  await drawer.locator('.schedule-tile').getByRole('button', { name: 'Edit', exact: true }).click()
  await drawer.locator('.panel-editor .n-select').nth(2).click()
  await page.locator('.n-base-select-option__content:visible').getByText('Custom', { exact: true }).click()
  await drawer.getByRole('textbox', { name: 'Schedule expression', exact: true }).fill('15 10 * * 1,3,5')
  await drawer.locator('.panel-editor').getByRole('button', { name: 'Save', exact: true }).click()
  await expect(drawer.locator('.panel-editor')).toHaveCount(0)
  expect(state.schedules[0].expression).toBe('15 10 * * 1,3,5')
  await drawer.locator('.schedule-tile').getByRole('button', { name: 'Edit', exact: true }).click()
  await expect(drawer.getByRole('textbox', { name: 'Schedule expression', exact: true })).toHaveValue('15 10 * * 1,3,5')
  await drawer.locator('.panel-editor .n-select').nth(1).click()
  await page.locator('.n-base-select-option__content:visible').getByText('Once', { exact: true }).click()
  const dateInput = drawer.locator('.n-date-picker input')
  await dateInput.fill('2099-12-01 09:30:00')
  await dateInput.press('Enter')
  await drawer.getByRole('textbox', { name: 'Timezone', exact: true }).click()
  await drawer.locator('.panel-editor').getByRole('button', { name: 'Save', exact: true }).click()
  await expect(drawer.locator('.panel-editor')).toHaveCount(0)
  const expected = await page.evaluate(() => new Date(2099, 11, 1, 9, 30).toISOString())
  expect(operations.filter(op => op.path.endsWith('/schedules/apply')).at(-1).body).toMatchObject({ kind: 'once', expression: expected })
  await drawer.locator('.schedule-tile').getByRole('button', { name: 'Edit', exact: true }).click()
  await expect(dateInput).toHaveValue('2099-12-01 09:30:00')
})

for (const width of [1440, 390]) {
  test(`Person keeps long agent names compact at ${width}px`, async ({ page }) => {
    const { state } = await setup(page, 'light', false, false)
    const longName = 'Research and engineering coordination assistant for complex cross-team requirements and delivery work'
    state.settings.agents = [
      { id: 'long', name: longName, description: 'Research tasks', selection: { runtime: 'ekko', mode: 'scoped', model: 'global-model', provider: 'provider', profile: 'default', reasoningEffort: '' } },
      { id: 'short', name: 'Assistant', description: 'Research tasks', selection: { runtime: 'codex', mode: 'scoped', model: 'global-model', provider: 'provider', profile: 'default', reasoningEffort: '' } },
    ]
    await page.route('**/api/studio/person/capabilities', route => route.fulfill({ json: { agents: ['ekko', 'codex', 'dsh', 'copilot', 'claude-code', 'opencode'].map(runtime => ({ runtime, installed: true })), native_allowed: true } }))
    await page.setViewportSize({ width, height: 960 })
    await page.goto('/#/person')
    const settings = page.locator('.person-header-actions').getByRole('button', { name: 'Settings', exact: true })
    await expect(settings).toHaveText('')
    await settings.click()
    await expect(settings).toHaveAttribute('aria-expanded', 'true')
    const drawer = page.locator('.person-workspace-drawer')
    await drawer.getByRole('tab', { name: /^Agents/ }).click()
    const names = drawer.locator('.agent-card h3')
    await expect(names.first()).toHaveText(longName)
    await expect(names.first()).toHaveAttribute('title', longName)
    const first = await names.first().boundingBox()
    const second = await names.nth(1).boundingBox()
    expect(first!.height).toBeLessThanOrEqual(second!.height + 1)
    const cards = await drawer.locator('.agent-card').evaluateAll(elements => elements.map(el => el.getBoundingClientRect().height))
    expect(Math.abs(cards[0]! - cards[1]!)).toBeLessThanOrEqual(1)
    const inset = await drawer.evaluate(el => el.querySelector('.panel-grid')!.getBoundingClientRect().left - el.getBoundingClientRect().left)
    expect(inset).toBeLessThanOrEqual(width === 390 ? 17 : 25)
    await drawer.locator('.agent-card').first().getByRole('button', { name: 'Edit', exact: true }).click()
    const title = drawer.locator('.editor-heading h3')
    expect((await title.boundingBox())!.height).toBeLessThan(30)
    await expect(drawer.locator('.runtime-option')).toHaveCount(6)
    const sizes = await drawer.locator('.runtime-option').evaluateAll(elements => elements.map(el => el.getBoundingClientRect().height))
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1)
    await drawer.getByRole('button', { name: 'DeepSeek Harness', exact: true }).click()
    await expect(drawer.getByRole('button', { name: 'DeepSeek Harness', exact: true })).toHaveAttribute('aria-pressed', 'true')
    expect(await drawer.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
    await page.screenshot({ path: `/tmp/person-ui-long-names-${width}.png`, animations: 'disabled' })
    await drawer.getByRole('button', { name: 'Cancel', exact: true }).click()
    await page.getByRole('tab', { name: /Memory/ }).click()
    await expect(settings).toHaveAttribute('aria-expanded', 'true')
  })
}

for (const width of [1440, 390]) {
  test(`Person requires a saved Agent preset before chatting at ${width}px`, async ({ page }) => {
    const { state } = await setup(page, 'light', false, false)
    state.settings.agents = []
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/#/person')
    const dialog = page.getByRole('dialog', { name: 'Set up your first Agent' })
    await expect(dialog).toBeVisible()
    await expect(dialog).toHaveCSS('width', `${Math.min(420, width - 32)}px`)
    await expect(dialog).toHaveCSS('padding', '32px')
    await expect(page.locator('.person-header-actions').getByRole('button')).toHaveCount(4)
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled()
    await page.keyboard.press('Escape')
    await expect(dialog).toBeVisible()
    await page.screenshot({ path: `/tmp/person-agent-setup-${width}.png`, animations: 'disabled' })
    await dialog.getByRole('button', { name: 'Go to settings' }).click()
    await expect(dialog).not.toBeVisible()
    const drawer = page.locator('.person-workspace-drawer')
    await expect(drawer.getByRole('tab', { name: /Agent/ })).toHaveAttribute('aria-selected', 'true')
    await expect(drawer.getByText('No Agents yet', { exact: true })).toBeVisible()
    await expect(drawer.locator('.agent-card')).toHaveCount(0)
    await expect(drawer.locator('.panel-count strong')).toHaveText('0')
    await page.screenshot({ path: `/tmp/person-agent-setup-drawer-${width}.png`, animations: 'disabled' })
    await drawer.getByRole('button', { name: 'Add agent', exact: true }).click()
    await expect(drawer.locator('.runtime-option[aria-pressed=true]')).toHaveCount(0)
    await expect(drawer.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
    await drawer.getByRole('textbox', { name: 'Agent name', exact: true }).fill('My research partner')
    await drawer.getByRole('textbox', { name: 'Purpose', exact: true }).fill('Research and write reports')
    await drawer.getByRole('button', { name: 'Codex', exact: true }).click()
    await drawer.locator('.scoped-model-selector button').click()
    await page.getByRole('menuitemradio').filter({ hasText: 'global-model' }).click()
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled()
    // Trigger Enter directly on the composer while the drawer covers it: drafts must not unlock send.
    await page.locator('.input-textarea').fill('Not configured yet', { force: true })
    await page.locator('.input-textarea').dispatchEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true })
    expect(await emitted(page, 'run')).toEqual([])
    state.revision++
    await drawer.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(drawer.locator('.n-alert')).toContainText('Settings changed')
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled()
    await expect(drawer.getByRole('textbox', { name: 'Agent name', exact: true })).toHaveValue('My research partner')
    await drawer.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(drawer.locator('.agent-card')).toHaveCount(1)
    await page.keyboard.press('Escape')
    await expect(drawer).not.toBeVisible()
    await expect(dialog).not.toBeVisible()
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect.poll(() => emitted(page, 'run')).toHaveLength(1)
    await page.reload()
    await expect(page.locator('.person-title')).toBeVisible()
    await expect(dialog).not.toBeVisible()
    await page.locator('.person-header-actions').getByRole('button', { name: 'Settings', exact: true }).click()
    await drawer.getByRole('tab', { name: /^Agents/ }).click()
    await drawer.getByRole('button', { name: 'Delete', exact: true }).click()
    expect(state.settings.agents).toHaveLength(1)
    await drawer.locator('.person-agent-settings').getByRole('button', { name: 'Save', exact: true }).click()
    await expect.poll(() => state.settings.agents.length).toBe(0)
    await page.keyboard.press('Escape')
    await expect(dialog).toBeVisible()
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled()
    await page.reload()
    await expect(dialog).toBeVisible()
  })
}

for (const { width, mode } of [{ width: 1440, mode: 'light' }, { width: 390, mode: 'dark' }] as const) {
  test(`previews the first Agent setup in Chinese in ${mode} at ${width}px`, async ({ page }) => {
    const { state } = await setup(page, mode, false, false)
    state.settings.agents = []
    await page.addInitScript(() => localStorage.setItem('hermes_locale', 'zh'))
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/#/person')
    const dialog = page.getByRole('dialog', { name: '先配置你的第一个 Agent' })
    await expect(dialog).toBeVisible()
    await page.screenshot({ path: `/tmp/person-agent-setup-zh-${mode}-${width}.png`, animations: 'disabled' })
    await dialog.getByRole('button', { name: '去设置' }).click()
    await expect(page.locator('.person-workspace-drawer .panel-empty')).toBeVisible()
    await page.screenshot({ path: `/tmp/person-agent-setup-drawer-zh-${mode}-${width}.png`, animations: 'disabled' })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  })
}

for (const mode of ['light', 'dark'] as const) {
  test(`Person setup dialog and empty cards follow wallpaper and regional themes in ${mode}`, async ({ page }) => {
    const { state } = await setup(page, mode)
    state.settings.agents = []
    await page.goto('/#/person')
    const dialog = page.locator('.person-setup-dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog).toHaveCSS('background-color', /rgba\(.+, 0\.5\)/)
    await dialog.getByRole('button', { name: 'Go to settings' }).click()
    const empty = page.locator('.person-agent-settings .panel-empty')
    await expect(empty).toHaveCSS('background-color', /rgba\(.+, 0\.65\)/)
    await expect(empty).toHaveCSS('backdrop-filter', 'blur(12px) saturate(1.1)')
    // Persist a regional override through the mocked theme API and verify it after reload.
    await page.evaluate(async () => {
      await fetch('/api/theme', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ appearance: {
        global: { opacity: 0.3 }, regions: { overlay: { backgroundColor: '#336699', opacity: 0, radius: 18, blur: 8 }, card: { backgroundColor: '#336699', opacity: 0, radius: 18, blur: 12 } },
      } }) })
    })
    await page.reload()
    await expect(dialog).toHaveCSS('background-color', 'rgba(51, 102, 153, 0)')
    await expect(dialog).toHaveCSS('opacity', '1')
    await expect(dialog).toHaveCSS('border-radius', '18px')
    await dialog.getByRole('button', { name: 'Go to settings' }).click()
    await expect(empty).toHaveCSS('background-color', 'rgba(51, 102, 153, 0)')
    await expect(empty).toHaveCSS('opacity', '1')
    await expect(empty).toHaveCSS('border-radius', '18px')
    await page.evaluate(async () => {
      await fetch('/api/theme', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ background: null, appearance: { global: {}, regions: {} } }) })
    })
    await page.reload()
    await expect(dialog).toHaveCSS('background-color', mode === 'light' ? 'rgb(255, 255, 255)' : 'rgb(42, 42, 42)')
    await dialog.getByRole('button', { name: 'Go to settings' }).click()
    await expect(empty).toHaveCSS('background-color', mode === 'light' ? 'rgb(255, 255, 255)' : 'rgb(42, 42, 42)')
  })
}

test('Person persists the selected xhigh effort and sends it after a reload', async ({ page }) => {
  const { state, operations } = await setup(page, 'light', false, false)
  state.settings.model.model = 'gpt-6.1-sol'
  state.settings.agents[0].selection = { ...state.settings.agents[0].selection, model: 'gpt-6.1-sol', reasoningEffort: 'xhigh' }
  state.reasoning_efforts = ['low', 'medium', 'high', 'xhigh', 'max']
  await page.addInitScript(() => localStorage.setItem('hermes_locale', 'zh'))
  await page.goto('/#/person')
  const effort = page.locator('.reasoning-effort-button')
  await expect(effort).toHaveAttribute('aria-label', /低/)
  await effort.click()
  const slider = page.getByRole('slider')
  await expect(slider).toHaveAttribute('aria-valuemax', '4')
  await slider.focus()
  for (let step = 0; step < 3; step++) await page.keyboard.press('ArrowRight')
  await expect(effort).toHaveAttribute('aria-label', /超高/)
  await expect.poll(() => state.settings.reasoningEffort).toBe('xhigh')
  await page.keyboard.press('Escape')
  await page.reload()
  await expect(effort).toHaveAttribute('aria-label', /超高/)
  await page.locator('.input-textarea').fill('用超高思考强度检查报告')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect.poll(() => emitted(page, 'run')).toEqual([expect.objectContaining({ model: 'gpt-6.1-sol', reasoning_effort: 'xhigh' })])
  expect(operations.filter(op => op.path.endsWith('/settings')).at(-1).body.reasoning_effort).toBe('xhigh')
  expect(state.settings.agents[0].selection.reasoningEffort).toBe('xhigh')
})

for (const mode of ['light', 'dark'] as const) {
  test(`Person uses shared loading until its snapshot and conversation are ready in ${mode}`, async ({ page }) => {
    if (mode === 'dark') await page.setViewportSize({ width: 390, height: 844 })
    await setup(page, mode, mode === 'dark')
    await page.addInitScript(() => { delete (window as any).__PW_CHAT_SOCKET_RESUMES__['person-main-1'] })
    let releaseSnapshot!: () => void
    let releaseRefresh!: () => void
    const snapshot = new Promise<void>(resolve => { releaseSnapshot = resolve })
    const refresh = new Promise<void>(resolve => { releaseRefresh = resolve })
    let requests = 0
    await page.route(/\/api\/studio\/person(?:\?.*)?$/, async route => {
      requests++
      await (requests === 1 ? snapshot : refresh)
      await route.fallback()
    })
    await page.goto('/#/person')
    const surface = page.locator('.person-view')
    const overlay = surface.locator(':scope > .page-loading-overlay')
    await expect(overlay.locator('.studio-loading-logo')).toBeVisible()
    await expect(surface).toHaveAttribute('aria-busy', 'true')
    await expect(surface.locator(':scope > .page-loading-content')).toHaveAttribute('inert', '')
    await expect(surface.locator(':scope > .page-loading-content')).not.toBeVisible()
    await page.screenshot({ path: `/tmp/person-shared-loading-${mode}.png` })
    releaseSnapshot()
    await expect.poll(() => emitted(page, 'resume')).toEqual(expect.arrayContaining([expect.objectContaining({ session_id: 'person-main-1' })]))
    await expect(overlay.locator('.studio-loading-logo')).toBeVisible()
    await backgroundTaskCount(page, 2)
    await expect(page.locator('.person-task-island')).toHaveCount(0)
    await page.evaluate(() => (window as any).__PW_CHAT_SOCKET__.latest.__trigger('resumed', {
      session_id: 'person-main-1', isWorking: false, events: [],
      messages: [{ id: 1, role: 'user', content: 'Loaded Person history', timestamp: 1 }],
      messageTotal: 1, messageLoadedCount: 1, hasMoreBefore: false,
    }))
    await expect(overlay).toHaveCount(0)
    await expect(page.locator('.person-task-island')).toBeVisible()
    await expect(page.getByText('Loaded Person history', { exact: true })).toBeVisible()
    const input = surface.locator('.input-textarea')
    await input.fill('Keep this Person draft')
    await emit(page, 'person.updated', {})
    await expect.poll(() => requests).toBeGreaterThan(1)
    await expect(overlay).toHaveCount(0)
    await expect(input).toBeVisible()
    await expect(input).toHaveValue('Keep this Person draft')
    releaseRefresh()
  })
}

test('Person releases shared loading and displays its initial request error', async ({ page }) => {
  await setup(page, 'light', false)
  await page.route(/\/api\/studio\/person(?:\?.*)?$/, route => route.fulfill({ status: 503, json: { error: 'Person temporarily unavailable' } }))
  await page.goto('/#/person')
  await expect(page.locator('.person-view > .page-loading-overlay')).toHaveCount(0)
  await expect(page.locator('.person-alert')).toContainText('Person temporarily unavailable')
  await expect(page.getByRole('button', { name: 'Tasks', exact: true })).toBeVisible()
})

for (const mode of ['light', 'dark'] as const) {
  test(`Person selects the shared workspace and clears history and tasks with a broom in ${mode}`, async ({ page }) => {
    if (mode === 'dark') await page.setViewportSize({ width: 360, height: 780 })
    const { state, operations } = await setup(page, mode, mode === 'dark')
    state.tasks[0].running = false
    state.memories = [{ id: 'kept-memory', revision: 0, content: 'Keep my preference' }]
    await page.addInitScript(() => {
      (window as any).__PW_CHAT_SOCKET_RESUMES__['person-main-1'].messages = [{ id: 1, role: 'assistant', content: 'Old Person conversation', timestamp: 1 }]
    })
    await page.goto('/#/person')
    await expect(page.getByText('Old Person conversation', { exact: true })).toBeVisible()
    const workspace = page.getByRole('button', { name: 'Workspace', exact: true })
    const broom = page.getByRole('button', { name: 'Clear chat history and tasks', exact: true })
    await expect(workspace).toBeEnabled()
    await expect(broom).toBeEnabled()
    expect((await broom.textContent())?.trim()).toBe('')
    await workspace.click()
    const picker = page.locator('.n-modal:visible')
    await expect(picker.getByText('All background tasks use this workspace.', { exact: false })).toBeVisible()
    await picker.locator('.folder-path-input input').fill('/workspace/person-shared')
    await picker.getByRole('button', { name: 'OK', exact: true }).click()
    await expect(picker).toHaveCount(0)
    expect(operations.filter(op => op.path.endsWith('/settings')).at(-1).body.workspace).toBe('/workspace/person-shared')
    await page.reload()
    await expect(page.getByText('Old Person conversation', { exact: true })).toBeVisible()
    await workspace.click()
    await expect(picker.locator('.folder-path-input input')).toHaveValue('/workspace/person-shared')
    await picker.screenshot({ path: `/tmp/person-workspace-picker-${mode}.png` })
    await picker.getByRole('button', { name: 'Cancel', exact: true }).click()
    await broom.click()
    await expect(page.getByText('Clear Person chat history, tasks and their schedules?', { exact: false })).toBeVisible()
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    expect(operations.filter(op => op.path.endsWith('/clear'))).toHaveLength(0)
    await expect(page.getByText('Old Person conversation', { exact: true })).toBeVisible()
    await broom.click()
    await page.getByRole('button', { name: 'Confirm', exact: true }).click()
    await expect(page.getByText('Old Person conversation', { exact: true })).toHaveCount(0)
    await expect(page.getByText('Chat history and tasks cleared.', { exact: true })).toBeVisible()
    expect(operations.filter(op => op.path.endsWith('/clear'))).toEqual([expect.objectContaining({ body: { expected_history_revision: 0 } })])
    expect(state.tasks).toEqual([])
    expect(state.memories).toHaveLength(1)
    expect(state.settings.workspace).toBe('/workspace/person-shared')
    await page.getByRole('button', { name: 'Tasks', exact: true }).click()
    await expect(page.locator('.session-tasks-drawer .task-row')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(page.locator('.session-tasks-drawer:visible')).toHaveCount(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    const bounds = await broom.boundingBox()
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width)
    await page.screenshot({ path: `/tmp/person-header-controls-${mode}.png`, animations: 'disabled' })
  })
}

test('Person disables workspace and broom controls while tasks or main replies are running', async ({ page }) => {
  const { state, operations } = await setup(page, 'light', false)
  await page.goto('/#/person')
  const workspace = page.getByRole('button', { name: 'Workspace', exact: true })
  const broom = page.getByRole('button', { name: 'Clear chat history and tasks', exact: true })
  await expect(workspace).toBeDisabled(); await expect(broom).toBeDisabled()
  state.tasks[0].running = false
  await emit(page, 'person.updated', {})
  await expect(workspace).toBeEnabled(); await expect(broom).toBeEnabled()
  await emit(page, 'run.started', {})
  await expect(workspace).toBeDisabled(); await expect(broom).toBeDisabled()
  expect(operations.filter(op => op.path.endsWith('/clear'))).toHaveLength(0)
})

test('Person preserves records when work starts after opening the clear confirmation', async ({ page }) => {
  const { state, operations } = await setup(page, 'light', false)
  state.tasks[0].running = false
  await page.addInitScript(() => { (window as any).__PW_CHAT_SOCKET_RESUMES__['person-main-1'].messages = [{ id: 1, role: 'user', content: 'Keep the old conversation', timestamp: 1 }] })
  await page.goto('/#/person')
  await page.getByRole('button', { name: 'Clear chat history and tasks', exact: true }).click()
  state.tasks[0].running = true
  await page.getByRole('button', { name: 'Confirm', exact: true }).click()
  await expect(page.locator('.person-alert')).toContainText('Wait for Person tasks')
  await expect(page.getByText('Keep the old conversation', { exact: true })).toBeVisible()
  expect(state.tasks).toHaveLength(1)
  expect(operations.filter(op => op.path.endsWith('/clear'))).toHaveLength(1)
})
