import { expect, test } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi, TEST_ACCESS_KEY, TEST_MODEL_GROUP } from './fixtures'
import catalog from '../../config/agents.json'
import { expectNewChatEffectsMoving, selectNewChatAgent } from './new-chat-helpers'

for (const mobile of [false, true]) test(`Agent loop preserves card scale when clicking Ekko and Zcode (${mobile ? 'mobile' : 'desktop'})`, async ({ page }) => {
  await page.setViewportSize(mobile ? {width:390,height:844} : {width:1440,height:1000})
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  await mockHermesApi(page)
  await mockChatSocket(page)
  await page.route('**/api/agents/availability', route => route.fulfill({json:{
    revision:1, updatedAt:new Date().toISOString(), agents:catalog.agents.map(agent => ({id:agent.id,installed:true,source:'user-cli'})),
  }}))
  await page.goto('/#/hermes/chat')
  if (mobile) await page.getByRole('button',{name:'Menu',exact:true}).click()
  await page.getByRole('button',{name:'New Chat',exact:true}).click()
  await expect(page.locator('.agent-card.active')).toHaveAttribute('data-agent','ekko-agent')
  await expect(page.locator('.page-loading-overlay:visible')).toHaveCount(0)
  await page.waitForTimeout(200)
  for (const agent of ['zcode','ekko-agent','zcode']) {
    const point = await page.locator('.agent-card-viewport').evaluate((viewport, agent) => {
      const bounds=viewport.getBoundingClientRect()
      const card=Array.from(viewport.querySelectorAll<HTMLElement>('.agent-card')).find(card => {
        const r=card.getBoundingClientRect()
        return card.dataset.agent===agent&&Math.min(r.right,bounds.right)-Math.max(r.left,bounds.left)>8
      })!
      const r=card.getBoundingClientRect()
      const x=(Math.max(r.left,bounds.left)+Math.min(r.right,bounds.right))/2,y=r.top+r.height/2
      const hit=document.elementFromPoint(x,y) as HTMLElement
      return {x,y,hitAgent:hit.closest<HTMLElement>('.agent-card')?.dataset.agent,hit:hit.className}
    },agent)
    expect(point.hitAgent,JSON.stringify(point)).toBe(agent)
    await page.evaluate(() => {
      const state={frames:[] as {agent:string;position:number;scale:number}[],until:performance.now()+900}
      ;(window as any).agentLoopFrames=state
      const sample=()=>{
        const card=document.querySelector<HTMLElement>('.agent-card.active')!
        state.frames.push({agent:card.dataset.agent!,position:Array.from(document.querySelectorAll('.agent-card-slot')).indexOf(card.parentElement!),scale:new DOMMatrix(getComputedStyle(card).transform).a})
        if(performance.now()<state.until) requestAnimationFrame(sample)
      }
      requestAnimationFrame(sample)
    })
    await page.mouse.click(point.x,point.y)
    await page.waitForTimeout(950)
    const frames=await page.evaluate(()=>(window as any).agentLoopFrames.frames as {agent:string;position:number;scale:number}[])
    await expect(page.locator('.agent-card.active'),JSON.stringify(frames.filter((frame,i)=>!i||frame.position!==frames[i-1].position))).toHaveAttribute('data-agent',agent)
    const selected=frames.filter(frame=>frame.agent===agent)
    expect(selected.length).toBeGreaterThan(10)
    for(let i=1;i<selected.length;i++) expect(selected[i].scale,JSON.stringify(selected.slice(Math.max(0,i-2),i+2))).toBeGreaterThanOrEqual(selected[i-1].scale-.01)
    if(agent==='zcode') expect(new Set(selected.map(frame=>frame.position)).size,'click crosses the repeat boundary').toBeGreaterThan(1)
  }
})

for (const mobile of [false, true]) test(`new chat uses cards and the existing composer (${mobile ? 'mobile' : 'desktop'})`, async ({ page }) => {
  await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 })
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const api = await mockHermesApi(page)
  await mockChatSocket(page)
  await page.route('**/api/agents/availability', route => route.fulfill({ json: {
    revision: 1, updatedAt: new Date().toISOString(), agents: catalog.agents.map(agent => ({ id: agent.id, installed: true, source: 'user-cli' })),
  } }))
  await page.goto('/#/hermes/chat')
  if (mobile) await page.getByRole('button', { name: 'Menu', exact: true }).click()
  await page.getByRole('button', { name: 'New Chat', exact: true }).click()
  const draft = page.locator('.new-chat-page')
  await expect(draft).toBeVisible()
  await expect(draft.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(0)
  const actions = await draft.locator('.new-chat-config-actions').boundingBox()
  const composer = await draft.locator('.input-wrapper').boundingBox()
  expect(Math.abs(actions!.x - composer!.x)).toBeLessThanOrEqual(1)
  await expect(draft.locator('.new-chat-config-actions')).toHaveCSS('justify-content', 'flex-start')
  await expect(draft.locator('.new-chat-config-bar img, .new-chat-selected-agent')).toHaveCount(0)
  await expect(draft.locator('.reasoning-effort-button')).toBeVisible()
  await expect(page.locator('.n-drawer:visible')).toHaveCount(0)
  await expect(draft.locator('.agent-card.active')).toHaveAttribute('data-agent', 'ekko-agent')
  await expectNewChatEffectsMoving(page)
  await expect(draft.locator('.agent-card:not(.active) .agent-card-ember')).toHaveCount(0)
  await expect(draft.locator('.input-wrapper')).toBeVisible()
  await expect(draft.getByRole('button', { name: 'Send', exact: true })).toBeDisabled()
  await expect(page.locator('.message-list')).toHaveCount(0)
  await draft.getByRole('button', { name: 'Chat settings', exact: true }).click()
  const settings = page.getByRole('dialog', { name: 'Chat settings', exact: true })
  await expect(settings).toContainText('research')
  await expect(settings).toHaveAttribute('aria-modal', 'true')
  await settings.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(settings).toBeHidden()
  await draft.locator('.input-model-button').click()
  const models = page.getByRole('dialog').filter({ hasText: 'Set Session Model' })
  await expect(models.locator('.session-model-list')).toContainText('Test Provider')
  await models.locator('.session-model-search input').focus()
  await page.keyboard.press('Escape')
  await expect(models).toBeHidden()
  await expect(draft).toBeVisible()
  await draft.getByRole('button', { name: 'Workspace', exact: true }).click()
  const workspace = page.getByRole('dialog').filter({ hasText: 'Set Session Workspace' })
  await expect(workspace.locator('.folder-picker')).toBeVisible()
  await workspace.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(workspace).toBeHidden()
  await page.screenshot({ path: `/tmp/studio-new-chat-${mobile ? 'mobile' : 'desktop'}.png`, animations: 'allow' })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await draft.locator('textarea').fill('Start a fresh conversation')
  await draft.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(draft).toBeHidden()
  await expect(page.locator('.agent-card-ember')).toHaveCount(0)
  await expect(page).toHaveURL(/#\/hermes\/session\//)
  const sessionId = new URL(page.url()).hash.split('/').pop()!
  await expect.poll(() => page.evaluate(() => (window as any).__PW_CHAT_SOCKET__?.emitted?.find((item: any) => item.event === 'run')?.payload)).toMatchObject({
    session_id: sessionId, agent_id: 'ekko-agent', input: 'Start a fresh conversation',
  })
  await expect(page.locator('.input-wrapper')).toBeVisible()
  await expect(page.locator('textarea')).toHaveValue('')
  expect(await page.evaluate(id => (window as any).__PW_CHAT_SOCKET__.emitted.filter((item: any) => item.event === 'resume' && item.payload.session_id === id), sessionId)).toEqual([])
  expect(api.unexpectedRequests).toEqual([])
})

test('exiting or selecting a session restores the current conversation without creating an empty chat', async ({ page }) => {
  const session = { id: 'existing-chat', title: 'Existing conversation', source: 'cli', profile: 'research', model: 'test-model', provider: 'test-provider', started_at: 100, last_active: 101, message_count: 1 }
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  await page.addInitScript(id => {
    (window as any).__PW_CHAT_SOCKET_RESUMES__ = { [id]: { session_id: id, messages: [{ id: 'answer', role: 'assistant', content: 'Previous answer', timestamp: 101 }], isWorking: true, messageLoadedCount: 1, messageTotal: 1 } }
  }, session.id)
  await mockHermesApi(page, { sessions: [session] })
  await mockChatSocket(page)
  await page.goto(`/#/hermes/session/${session.id}`)
  await expect(page.locator('.page-loading-overlay:visible')).toHaveCount(0)
  await expect(page.getByText('Previous answer', { exact: true })).toBeVisible()
  await page.locator('textarea').fill('Keep my previous draft')
  await page.getByRole('button', { name: 'New Chat', exact: true }).click()
  const draft = page.locator('.new-chat-page')
  await expect(draft.locator('textarea')).toHaveValue('')
  await expect(draft.getByRole('button', { name: 'Send', exact: true })).toBeDisabled()
  await expect(draft.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)
  await draft.locator('textarea').fill('Do not create this conversation')
  await draft.locator('textarea').focus()
  await page.keyboard.press('Escape')
  await expect(page.locator('textarea')).toHaveValue('Keep my previous draft')
  await expect(page.getByText('Previous answer', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'New Chat', exact: true }).click()
  await page.locator('.session-item').filter({ hasText: 'Existing conversation' }).first().click()
  await expect(draft).toBeHidden()
  await expect(page.locator('textarea')).toHaveValue('Keep my previous draft')
  await expect(page).toHaveURL(new RegExp(`/hermes/session/${session.id}$`))
  expect(await page.evaluate(() => (window as any).__PW_CHAT_SOCKET__.emitted.filter((item: any) => item.event === 'run'))).toEqual([])
})

test('Agent cards stop dragging after a fast exit and mouse release outside the list', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  await mockHermesApi(page)
  await mockChatSocket(page)
  await page.route('**/api/agents/availability', route => route.fulfill({ json: {
    revision: 1, updatedAt: new Date().toISOString(), agents: catalog.agents.map(agent => ({ id: agent.id, installed: true, source: 'user-cli' })),
  } }))
  await page.goto('/#/hermes/chat')
  await page.getByRole('button', { name: 'New Chat', exact: true }).click()
  const viewport = page.locator('.agent-card-viewport')
  await expect(page.locator('.agent-card.active')).toHaveAttribute('data-agent', 'ekko-agent')
  await expect(page.locator('.page-loading-overlay:visible')).toHaveCount(0)
  const card = (await page.locator('.agent-card.active').boundingBox())!
  const bounds = (await viewport.boundingBox())!
  const x = card.x + card.width / 2, y = card.y + card.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  // One move skips the drag threshold inside the viewport, so capture has not started.
  await page.mouse.move(x - 120, bounds.y - 20)
  await page.mouse.up()
  const releasedLeft = await viewport.evaluate(el => el.scrollLeft)
  await page.mouse.move(x - 120, y)
  await page.mouse.move(x + 120, y)
  expect(await viewport.evaluate(el => el.scrollLeft)).toBe(releasedLeft)

  // A fresh drag still scrolls, and releasing its captured pointer stops it too.
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x - 80, y, { steps: 4 })
  await expect.poll(() => viewport.evaluate(el => el.scrollLeft)).not.toBe(releasedLeft)
  await page.mouse.move(x - 120, bounds.y - 20)
  await page.mouse.up()
  const draggedLeft = await viewport.evaluate(el => el.scrollLeft)
  await page.mouse.move(x + 120, y)
  expect(await viewport.evaluate(el => el.scrollLeft)).toBe(draggedLeft)
  await selectNewChatAgent(page, 'Codex')
  await expect(page.locator('.agent-card.active')).toHaveAttribute('data-agent', 'codex')
})

test('Agent cards support keyboard selection and continuous scrolling in dark mode', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  await page.addInitScript(() => localStorage.setItem('hermes_brightness', 'dark'))
  await mockHermesApi(page)
  await mockChatSocket(page)
  await page.route('**/api/agents/availability', route => route.fulfill({ json: {
    revision: 1, updatedAt: new Date().toISOString(), agents: catalog.agents.map(agent => ({ id: agent.id, installed: true, source: 'user-cli' })),
  } }))
  await page.goto('/#/hermes/chat')
  await page.getByRole('button', { name: 'New Chat', exact: true }).click()
  const active = page.locator('.agent-card.active')
  await expect(active).toHaveAttribute('data-agent', 'ekko-agent')
  await expect(active.locator('.agent-card-surface')).toHaveCSS('color', 'rgb(255, 251, 234)')
  await expect(active.locator('.agent-card-surface')).toHaveCSS('background-image', /linear-gradient\(145deg/)
  await expect(page.locator('.agent-card:not(.active)').first()).toHaveCSS('opacity', '1')
  await active.focus()
  await page.keyboard.press('ArrowRight')
  await expect(active).toHaveAttribute('data-agent', 'hermes')
  await page.keyboard.press('ArrowLeft')
  await expect(active).toHaveAttribute('data-agent', 'ekko-agent')
  const viewport = page.locator('.agent-card-viewport')
  // Scroll through the boundary between the repeated batches without snapping back.
  await viewport.hover()
  await page.mouse.wheel(3300, 0)
  await expect.poll(() => page.locator('.agent-card.active').innerText()).not.toBe('Ekko')
  await expect(active).toHaveAttribute('aria-pressed', 'true')
  await page.locator('.new-chat-page textarea').focus()
  await page.screenshot({ path: '/tmp/studio-new-chat-dark.png', animations: 'allow' })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expectNewChatEffectsMoving(page)
})

for (const { width, height, agent } of [
  { width: 1280, height: 720, agent: 'Ekko' },
  { width: 1366, height: 768, agent: 'Claude' },
  { width: 1440, height: 900, agent: 'DeepSeek Harness' },
  { width: 1024, height: 600, agent: 'DeepSeek Harness' },
  { width: 1000, height: 560, agent: 'Codex' },
  { width: 1920, height: 1080, agent: 'Ekko' },
]) test(`new chat fits one screen at ${width}x${height} with ${agent}`, async ({ page }) => {
  await page.setViewportSize({ width, height })
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  await mockHermesApi(page)
  await mockChatSocket(page)
  await page.route('**/api/agents/availability', route => route.fulfill({ json: {
    revision: 1, updatedAt: new Date().toISOString(), agents: catalog.agents.map(item => ({ id: item.id, installed: true, source: 'user-cli' })),
  } }))
  await page.goto('/#/hermes/chat')
  await page.getByRole('button', { name: 'New Chat', exact: true }).click()
  await selectNewChatAgent(page, agent)
  const draft = page.locator('.new-chat-page')
  await expect(draft.locator('.new-chat-intro > svg')).toHaveCount(0)
  await expect(draft.locator('.agent-card-hint, .new-chat-send-hint')).toHaveCount(0)
  await expect.poll(() => draft.evaluate(el => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1)
  const [surface, card, send] = await Promise.all([
    draft.boundingBox(), draft.locator('.agent-card.active').boundingBox(), draft.getByRole('button', { name: 'Send', exact: true }).boundingBox(),
  ])
  expect(card!.width).toBeLessThanOrEqual(177)
  expect(send!.y + send!.height).toBeLessThanOrEqual(surface!.y + surface!.height)
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(true)
  if (width === 1280) await page.screenshot({ path: '/tmp/studio-new-chat-compact-desktop.png', animations: 'allow' })
})

for (const { width, height } of [
  { width: 320, height: 568 },
  { width: 360, height: 640 },
  { width: 390, height: 844 },
  { width: 430, height: 900 },
  { width: 600, height: 900 },
]) test(`mobile new chat centers its content and keeps DSH options usable at ${width}x${height}`, async ({ page }) => {
  await page.setViewportSize({ width, height })
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  await page.addInitScript(() => {
    localStorage.setItem('hermes_locale', 'zh')
    localStorage.setItem('hermes_brightness', 'dark')
    localStorage.setItem('hermes_new_chat_agent_v1', 'dsh')
  })
  await mockHermesApi(page)
  await mockChatSocket(page)
  const workspace = '/workspace/hermes-studio-with-a-long-name'
  await page.route('**/api/studio/workspace/directories', route => route.fulfill({ json: { directories: [
    { path: workspace, isFavorite: true, lastUsed: Date.now(), useCount: 1, createdAt: 1, updatedAt: 1 },
  ] } }))
  await page.goto('/#/hermes/chat')
  await page.getByRole('button', { name: 'Menu', exact: true }).click()
  await page.getByRole('button', { name: '新建对话', exact: true }).click()
  const draft = page.locator('.new-chat-page')
  await expect(draft.locator('.agent-card.active')).toHaveAttribute('data-agent', 'dsh')
  await expect(draft.getByRole('button', { name: '工作区', exact: true })).toHaveAttribute('title', workspace)
  await expect(draft.getByTestId('dsh-session-preset').getByRole('button')).toHaveAttribute('data-preset', 'standard')
  await expect(draft.getByRole('button', { name: '工作区', exact: true })).toHaveText('')
  await expect(draft.getByRole('button', { name: '会话设置', exact: true })).toHaveText('')
  await expect(draft.getByTestId('dsh-session-preset').getByRole('button')).toHaveText('')
  await expect.poll(() => draft.evaluate(el => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1)
  const [surface, intro, composer, card, launch, preset, settings] = await Promise.all([
    draft.boundingBox(), draft.locator('.new-chat-intro').boundingBox(), draft.locator('.new-chat-compose').boundingBox(),
    draft.locator('.agent-card.active').boundingBox(), draft.getByRole('radiogroup', { name: '启动方式', exact: true }).boundingBox(),
    draft.getByTestId('dsh-session-preset').boundingBox(), draft.getByRole('button', { name: '会话设置', exact: true }).boundingBox(),
  ])
  expect(Math.abs((intro!.y - surface!.y) - (surface!.y + surface!.height - composer!.y - composer!.height))).toBeLessThanOrEqual(2)
  expect(Math.abs(card!.x + card!.width / 2 - (surface!.x + surface!.width / 2))).toBeLessThanOrEqual(2)
  expect(Math.abs(launch!.y + launch!.height / 2 - preset!.y - preset!.height / 2)).toBeLessThanOrEqual(1)
  expect(Math.abs(preset!.y - settings!.y)).toBeLessThanOrEqual(1)
  expect(settings!.x).toBeGreaterThanOrEqual(preset!.x + preset!.width)
  expect(launch!.x).toBeGreaterThanOrEqual(settings!.x + settings!.width)
  for (const bounds of [composer, launch, preset, settings]) {
    expect(bounds!.x).toBeGreaterThanOrEqual(0)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width)
  }
  if (width <= 480) {
    expect(card!.width).toBeGreaterThanOrEqual(width * .4)
    const visible = await draft.locator('.agent-card-viewport').evaluate(el => {
      const viewport = el.getBoundingClientRect()
      return [...el.querySelectorAll('.agent-card')].filter(card => {
        const bounds = card.getBoundingClientRect()
        return bounds.right > viewport.left && bounds.left < viewport.right
      }).length
    })
    expect(visible).toBe(3)
    expect(await draft.locator('.agent-card.active .agent-card-name').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: `/tmp/studio-new-chat-centered-${width}.png`, animations: 'allow' })
  await draft.getByRole('button', { name: '会话设置', exact: true }).click()
  const settingsPanel = page.getByRole('dialog', { name: '会话设置', exact: true })
  await expect(settingsPanel).toBeVisible()
  const bounds = await settingsPanel.boundingBox()
  expect(bounds!.x).toBeGreaterThanOrEqual(16)
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width - 16)
  expect(bounds!.y).toBeGreaterThanOrEqual(16)
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(height - 16)
  await page.screenshot({ path: `/tmp/studio-chat-settings-dark-${width}.png`, animations: 'disabled' })
  await page.keyboard.press('Escape')
  await expect(settingsPanel).toBeHidden()
  await expect(draft).toBeVisible()
})

for (const mobile of [false, true]) test(`missing required connection fields fit the settings panel and are used on the first send (${mobile ? 'mobile' : 'desktop'})`, async ({ page }) => {
  await page.setViewportSize(mobile ? { width: 320, height: 568 } : { width: 1280, height: 720 })
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  if (mobile) await page.addInitScript(() => localStorage.setItem('hermes_new_chat_agent_v1', 'dsh'))
  await mockHermesApi(page, { modelGroups: [{ provider: 'manual-provider', label: 'Manual Provider', models: ['manual-model'] }] })
  await mockChatSocket(page)
  await page.goto('/#/hermes/chat')
  if (mobile) await page.getByRole('button', { name: 'Menu', exact: true }).click()
  await page.getByRole('button', { name: 'New Chat', exact: true }).click()
  const draft = page.locator('.new-chat-page')
  await draft.locator('textarea').fill('Start with my configured connection')
  await expect(draft.getByRole('button', { name: 'Send', exact: true })).toBeDisabled()
  await draft.getByRole('button', { name: 'Complete the connection settings to send', exact: true }).click()
  const settings = page.getByRole('dialog', { name: 'Chat settings', exact: true })
  await expect(settings).toBeVisible()
  if (mobile) {
    await expect(settings.locator('.new-chat-field').filter({ hasText: /^Protocol/ })).toBeVisible()
    await page.setViewportSize({ width: 320, height: 360 })
    await expect.poll(() => settings.locator('.new-chat-settings-body').evaluate(el => el.scrollHeight - el.clientHeight)).toBeGreaterThan(0)
    await expect.poll(async () => { const b = await settings.boundingBox(); return b!.y + b!.height }).toBeLessThanOrEqual(344)
    const bounds = await settings.boundingBox()
    expect(bounds!.x).toBeGreaterThanOrEqual(16)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(304)
    expect(bounds!.y).toBeGreaterThanOrEqual(16)
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(344)
    expect(await settings.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
    await page.screenshot({ path: '/tmp/studio-chat-settings-short-mobile.png', animations: 'disabled' })
  } else {
    await page.screenshot({ path: '/tmp/studio-chat-settings-light-desktop.png', animations: 'disabled' })
  }
  const baseUrl = settings.locator('.new-chat-field').filter({ hasText: /^Base URL/ }).locator('input')
  const apiKey = settings.locator('.new-chat-field').filter({ hasText: /^API Key/ }).locator('input')
  await baseUrl.fill('https://example.invalid/v1')
  await expect(baseUrl).toHaveValue('https://example.invalid/v1')
  await expect(baseUrl).toBeFocused()
  await apiKey.fill('test-credential')
  await expect(apiKey).toHaveValue('test-credential')
  await expect(draft.getByRole('button', { name: 'Send', exact: true })).toBeEnabled()
  await settings.getByRole('button', { name: 'Close', exact: true }).click()
  if (mobile) await page.setViewportSize({ width: 320, height: 568 })
  await draft.getByRole('button', { name: 'Send', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as any).__PW_CHAT_SOCKET__?.emitted?.find((item: any) => item.event === 'run')?.payload)).toMatchObject({
    ...(mobile ? { coding_agent_id: 'dsh' } : { agent_id: 'ekko-agent' }), provider: 'manual-provider', model: 'manual-model', baseUrl: 'https://example.invalid/v1', apiKey: 'test-credential',
  })
})

test('new chat shares the session model picker and sends the chosen model and protocol', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const api = await mockHermesApi(page, { modelGroups: [TEST_MODEL_GROUP, {
    ...TEST_MODEL_GROUP, provider: 'other-provider', label: 'Other Provider', models: ['other-model', 'disabled-model'],
    api_mode: 'anthropic_messages', model_meta: { 'disabled-model': { disabled: true } },
  }, { provider: 'moa', label: 'MoA', models: ['ensemble'] }] })
  await mockChatSocket(page)
  await page.goto('/#/hermes/chat')
  await page.getByRole('button', { name: 'New Chat', exact: true }).click()
  const draft = page.locator('.new-chat-page')
  await draft.locator('textarea').fill('Use the model I selected')
  await draft.locator('.input-model-button').click()
  const models = page.getByRole('dialog').filter({ hasText: 'Set Session Model' })
  await expect(models.locator('[name="session-model-kind"]')).toHaveCount(0)
  await models.locator('.session-model-search input').fill('other')
  await expect(models.locator('.session-model-group-label')).toHaveText('Other Provider')
  await models.locator('.session-model-search input').fill('disabled')
  const disabled = models.locator('.session-model-item').filter({ hasText: 'disabled-model' })
  await expect(disabled).toHaveAttribute('aria-disabled', 'true')
  await disabled.click()
  await expect(page.getByRole('dialog').filter({ hasText: 'Protocol' })).toBeHidden()
  await models.locator('.session-model-search input').fill('other-model')
  await models.locator('.session-model-item').filter({ hasText: 'other-model' }).click()
  const protocol = page.getByRole('dialog').filter({ hasText: 'Protocol' })
  await expect(protocol).toContainText('Anthropic Messages')
  await protocol.getByRole('button', { name: 'Confirm', exact: true }).click()
  await expect(models).toBeHidden()
  await expect(draft.locator('.input-model-button')).toContainText('other-model')
  await expect(draft.locator('textarea')).toHaveValue('Use the model I selected')
  expect(api.requests.filter(request => request.pathname.endsWith('/model') && request.method !== 'GET')).toEqual([])
  await draft.getByRole('button', { name: 'Send', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as any).__PW_CHAT_SOCKET__?.emitted?.find((item: any) => item.event === 'run')?.payload)).toMatchObject({
    agent_id: 'ekko-agent', model: 'other-model', provider: 'other-provider', apiMode: 'anthropic_messages', input: 'Use the model I selected',
  })
  // The same picker still works for the newly created conversation.
  await page.locator('.input-model-button').click()
  await expect(models.locator('.session-model-item.active')).toContainText('other-model')
  await expect(models).toContainText('Test Provider')
  await models.locator('.session-model-item').filter({ hasText: 'test-model' }).click()
  await protocol.getByRole('button', { name: 'Confirm', exact: true }).click()
  await expect(models).toBeHidden()
  await expect(page.locator('.input-model-button')).toContainText('test-model')
  expect(api.unexpectedRequests).toEqual([])
})

for (const choice of ['standard', 'custom', 'moa'] as const) test(`Hermes draft uses the shared ${choice} model selection without changing the existing conversation`, async ({ page }) => {
  const session = { id: 'existing-model-chat', title: 'Existing conversation', source: 'cli', profile: 'research', model: 'test-model', provider: 'test-provider', started_at: 100, last_active: 101, message_count: 0 }
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  await page.addInitScript(id => {
    (window as any).__PW_CHAT_SOCKET_RESUMES__ = { [id]: { session_id: id, messages: [], isWorking: false, messageLoadedCount: 0, messageTotal: 0 } }
  }, session.id)
  const api = await mockHermesApi(page, { sessions: [session], modelGroups: [
    { ...TEST_MODEL_GROUP, models: ['test-model', 'other-model'] }, { provider: 'moa', label: 'MoA', models: ['ensemble'] },
  ] })
  await mockChatSocket(page)
  await page.goto(`/#/hermes/session/${session.id}`)
  await expect(page.locator('.page-loading-overlay:visible')).toHaveCount(0)
  await page.getByRole('button', { name: 'New Chat', exact: true }).click()
  await selectNewChatAgent(page, 'Hermes')
  const draft = page.locator('.new-chat-page')
  if (choice === 'moa') {
    await draft.locator('.reasoning-effort-button').click()
    await page.getByRole('slider').focus()
    await page.keyboard.press('ArrowRight')
    await expect(draft.locator('.reasoning-effort-button')).toHaveAttribute('aria-label', /none/i)
    await page.keyboard.press('Escape')
  }
  await draft.locator('.input-model-button').click()
  const models = page.getByRole('dialog').filter({ hasText: 'Set Session Model' })
  await expect(models.locator('[name="session-model-kind"]')).toHaveCount(2)
  if (choice === 'custom') {
    await models.locator('.session-model-custom-input input').fill('custom-model')
    await models.locator('.session-model-custom-input input').press('Enter')
  } else if (choice === 'moa') {
    await models.getByText('MoA combinations', { exact: true }).click()
    await models.locator('.session-model-item').filter({ hasText: 'ensemble' }).click()
  } else {
    await models.locator('.session-model-search input').fill('other-model')
    await models.locator('.session-model-item').filter({ hasText: 'other-model' }).click()
  }
  await expect(models).toBeHidden()
  const model = choice === 'custom' ? 'custom-model' : choice === 'moa' ? 'ensemble' : 'other-model'
  const provider = choice === 'moa' ? 'moa' : 'test-provider'
  await expect(draft.locator('.input-model-button')).toContainText(model)
  if (choice === 'moa') await expect(draft.locator('.reasoning-effort-button')).toHaveCount(0)
  expect(api.requests.filter(request => request.pathname.endsWith('/model') && request.method !== 'GET')).toEqual([])
  expect(await page.evaluate(() => (window as any).__PW_CHAT_SOCKET__.emitted.filter((item: any) => item.event === 'run'))).toEqual([])
  if (choice === 'standard') {
    await draft.locator('textarea').focus()
    await page.keyboard.press('Escape')
    await expect(page.locator('.input-model-button')).toContainText('test-model')
  } else {
    await draft.locator('textarea').fill('Use my selected configuration')
    await draft.getByRole('button', { name: 'Send', exact: true }).click()
    await expect.poll(() => page.evaluate(() => (window as any).__PW_CHAT_SOCKET__?.emitted?.find((item: any) => item.event === 'run')?.payload)).toMatchObject({ model, provider, input: 'Use my selected configuration' })
    if (choice === 'moa') expect(await page.evaluate(() => (window as any).__PW_CHAT_SOCKET__.emitted.find((item: any) => item.event === 'run').payload.reasoning_effort)).toBeUndefined()
  }
  expect(api.unexpectedRequests).toEqual([])
})
