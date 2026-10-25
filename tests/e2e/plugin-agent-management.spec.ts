import { expect, test, type Page } from '@playwright/test'
import sharp from 'sharp'
import { authenticate, mockHermesApi, mockChatSocket, TEST_ACCESS_KEY } from './fixtures'
import { selectNewChatAgent, selectNewChatLaunchMode, sendNewChatMessage } from './new-chat-helpers'

const agents = ['claude-code', 'codex', 'pi', 'grok', 'opencode', 'dsh', 'cursor', 'antigravity', 'qwen', 'kimi', 'codebuddy', 'qoder', 'copilot', 'zcode']
async function setup(page: Page, brightness = 'light', wallpaper = false, sessions: any[] = []) {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const api = await mockHermesApi(page, { sessions, theme: { brightness,
    background: wallpaper ? { name: 'wall.png', mime: 'image/png', updatedAt: 1 } : null,
    appearance: { global: { opacity: 0.4 }, regions: { card: { opacity: wallpaper ? 0 : 0.8, blur: 8, radius: 14 }, overlay: { opacity: 0.85 }, input: { opacity: 0.5 } } },
  } })
  if (wallpaper) {
    const png = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#204060' } }).png().toBuffer()
    await page.route('**/api/theme/background?*', route => route.fulfill({ contentType: 'image/png', body: png }))
  }
  const checks: string[] = []
  page.on('request', request => { if (/\/api\/studio\/(?:agent-instances|bundled-agent-plugins|agent-types)/.test(new URL(request.url()).pathname)) checks.push(request.url()) })
  return { ...api, checks }
}

for (const brightness of ['light', 'dark']) for (const wallpaper of [false, true]) test(`all plugins use the existing CLI cards without instance setup (${brightness}, wallpaper ${wallpaper})`, async ({ page }, info) => {
  await page.setViewportSize(wallpaper ? { width: 390, height: 844 } : { width: 1440, height: 1000 })
  const api = await setup(page, brightness, wallpaper)
  const tools = agents.map(id => ({ id, installed: id === 'codex', version: id === 'codex' ? '1.0.0' : '', source: id === 'codex' ? 'user-cli' : 'not-installed', path: id === 'codex' ? '/native/codex' : '' }))
  await page.route('**/api/agents/status', route => route.fulfill({ json: { revision: 1, agents: tools } }))
  await page.route('**/api/coding-agents', route => route.fulfill({ json: { tools } }))
  const installs: string[] = []
  await page.route('**/api/coding-agents/*/install', route => {
    const id = new URL(route.request().url()).pathname.split('/').at(-2)!
    expect(route.request().method()).toBe('POST')
    installs.push(id)
    const tool = tools.find(item => item.id === id)!
    tool.installed = true; tool.version = id === 'codex' ? '1.0.1' : '1.0.0'
    return route.fulfill({ json: { success: true, tools } })
  })
  await page.route('**/api/coding-agents/codex/check-update', route => route.fulfill({ json: { success: true, updateAvailable: true, latestVersion: '1.0.1', tool: tools.find(item => item.id === 'codex') } }))
  await page.goto('/#/studio/agents')
  await expect(page.locator('.page-loading-overlay:visible')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Manage instances', exact: true })).toHaveCount(0)
  await expect(page.locator('.instance-manager-modal')).toHaveCount(0)
  for (const id of agents) {
    const card = page.getByTestId(`agent-card-${id}`)
    await expect(card).toBeAttached()
    if (id === 'codex') await expect(card.getByRole('button', { name: 'Check for update', exact: true })).toBeAttached()
    else await expect(card.getByRole('button', { name: /Install/ })).toBeAttached()
  }
  expect(installs).toEqual([])
  await page.screenshot({ path: info.outputPath('agent-cli-cards.png') })
  const qwen = page.getByTestId('agent-card-qwen')
  await qwen.getByRole('button', { name: /Install/ }).click()
  await expect(qwen.getByText('Installed', { exact: true })).toBeVisible()
  expect(installs).toEqual(['qwen'])
  const codex = page.getByTestId('agent-card-codex')
  await codex.getByRole('button', { name: 'Check for update', exact: true }).click()
  await codex.getByRole('button', { name: 'Update to v1.0.1', exact: true }).click()
  await expect(codex.locator('.agent-version')).toHaveText('v1.0.1')
  expect(installs).toEqual(['qwen', 'codex'])
  await codex.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(page).toHaveURL(/\/studio\/agents\/codex\/settings$/)
  await expect(page.locator('.settings-editor-panel textarea')).toHaveCount(2)
  await expect(page.getByRole('button', { name: 'Manage instances', exact: true })).toHaveCount(0)
  await expect(page.getByLabel('Agent instance', { exact: true })).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect(api.checks).toEqual([])
  expect(api.unexpectedRequests).toEqual([])
})

for (const mobile of [false, true]) for (const mode of ['scoped', 'global'] as const) test(`new chat retains Agent and ${mode} selection without an instance (${mobile ? 'mobile' : 'desktop'})`, async ({ page }) => {
  await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 })
  const api = await setup(page, mobile ? 'dark' : 'light', mobile)
  await mockChatSocket(page)
  await page.goto('/#/hermes/chat')
  if (mobile) await page.getByRole('button', { name: 'Menu', exact: true }).click()
  await page.getByRole('button', { name: 'New Chat', exact: true }).click()
  await selectNewChatAgent(page, 'Codex')
  await selectNewChatLaunchMode(page, mode)
  const draft = page.locator('.new-chat-page')
  await expect(draft.locator('.input-model-button')).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Manage instances', exact: true })).toHaveCount(0)
  await sendNewChatMessage(page, 'Use the selected launch mode')
  await expect(page).toHaveURL(/\/hermes\/session\//)
  await expect.poll(() => page.evaluate(() => (window as any).__PW_CHAT_SOCKET__.emitted.find((item: any) => item.event === 'run')?.payload))
    .toMatchObject({ input: 'Use the selected launch mode', managed_agent_protocol: 1 })
  expect(JSON.parse(api.requests.find(item => item.pathname === '/api/studio/agent-chats')!.postData!)).toMatchObject({ agentTypeId: 'codex', mode, ...(mode === 'scoped' ? { model: 'test-model' } : {}) })
  expect(api.checks).toEqual([])
  expect(api.unexpectedRequests).toEqual([])
})

for (const mobile of [false, true]) test(`restores plugin chat images and approvals without an instance management button (${mobile ? 'mobile dark' : 'desktop light'})`, async ({ page }, info) => {
  if (mobile) await page.addInitScript(() => Object.defineProperty(globalThis.crypto, 'randomUUID', { value: undefined }))
  await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 })
  const api = await setup(page, mobile ? 'dark' : 'light', mobile, [{ id: 'managed-chat', profile: 'research', source: 'coding_agent', agent: 'qwen', agent_mode: 'scoped',
    agent_instance_id: 'managed', agent_instance_revision: 1, model: 'instance-model', workspace: '/owned workspace', title: 'Managed chat', started_at: 100, last_active: 100, message_count: 0,
    agent_usage: { inputTokens: null, outputTokens: null } }])
  await page.addInitScript(() => {
    ;(window as any).__PW_CHAT_SOCKET_RESUMES__ = { 'managed-chat': { session_id: 'managed-chat', messages: [], isWorking: false, events: [], managed_agent_protocol: 1,
      agent_instance_id: 'managed', agent_instance_revision: 1, agent_mode: 'scoped', model: 'instance-model', workspace: '/owned workspace', agentInteractions: [] } }
  })
  await mockChatSocket(page)
  await page.goto('/#/hermes/session/managed-chat?profile=research')
  await expect(page.locator('.chat-input-area .input-model-button')).toHaveText('instance-model')
  await expect(page.getByRole('button', { name: 'Manage instances', exact: true })).toHaveCount(0)
  const input = page.locator('.chat-input-area textarea')
  await input.fill('/status')
  await expect(page.locator('.slash-command-dropdown:visible')).toHaveCount(0)
  await input.press('Enter')
  await expect.poll(() => page.evaluate(() => (window as any).__PW_CHAT_SOCKET__.emitted.filter((item: any) => item.event === 'run').at(-1)?.payload))
    .toEqual({ session_id: 'managed-chat', profile: 'research', input: '/status', queue_id: expect.any(String), push_enabled: false, managed_agent_protocol: 1 })
  await page.evaluate(() => {
    const state = (window as any).__PW_CHAT_SOCKET__, queueId = state.emitted.filter((item: any) => item.event === 'run').at(-1).payload.queue_id
    const data = { session_id: 'managed-chat', agent_run_id: 'first', run_id: 'first', run_marker: 'first', queue_id: queueId }
    state.broadcast('run.started', { ...data, event: 'run.started' })
    state.broadcast('message.persisted', { ...data, event: 'message.persisted', messages: [
      { id: 1, role: 'user', content: '/status', timestamp: 100, run_marker: 'first' }, { id: 2, role: 'assistant', content: 'Ready.', timestamp: 100, run_marker: 'first' },
    ] })
    state.broadcast('run.completed', { ...data, event: 'run.completed', status: 'completed', queue_remaining: 0 })
  })
  await expect(page.getByText('Ready.', { exact: true })).toHaveCount(1)
  await expect(page.locator('.context-info')).toContainText('—')
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#204060' } }).png().toBuffer()
  const imageId = 'ab012345-6789-0123-4567-0123456789ab', imagePath = `agent-artifact:managed-chat/${imageId}`
  const uploads: Buffer[] = []
  await page.route('**/api/studio/agent-images?*', route => {
    expect(route.request().headers()['content-type']).toBe('application/octet-stream')
    expect(new URL(route.request().url()).searchParams.get('profile')).toBe('research')
    uploads.push(route.request().postDataBuffer()!)
    return route.fulfill({ json: { data: { id: imageId, mediaType: 'image/png', byteLength: png.length } } })
  })
  await page.route('**/api/studio/agent-chats/managed-chat/images/*?*', route => route.fulfill({ contentType: 'image/png', body: png }))
  await page.locator('.chat-input-area input[type=file]').setInputFiles({ name: 'picture.png', mimeType: 'image/png', buffer: png })
  await input.fill('Describe this image')
  await input.press('Enter')
  await expect.poll(() => page.evaluate(() => (window as any).__PW_CHAT_SOCKET__.emitted.filter((item: any) => item.event === 'run').at(-1)?.payload.input))
    .toEqual([{ type: 'text', text: 'Describe this image' }, { type: 'image', name: 'picture.png', media_type: 'image/png', path: imagePath }])
  expect(uploads).toHaveLength(1)
  expect(uploads[0].equals(png)).toBe(true)
  await page.evaluate(() => {
    const state = (window as any).__PW_CHAT_SOCKET__
    state.broadcast('run.started', { event: 'run.started', session_id: 'managed-chat', agent_run_id: 'image-run', run_marker: 'image-run' })
    state.broadcast('message.persisted', { event: 'message.persisted', session_id: 'managed-chat', agent_run_id: 'first', run_marker: 'first', replayed: true, terminal: true,
      messages: [{ id: 2, role: 'assistant', content: 'Ready. (replayed)', timestamp: 100, run_marker: 'first' }] })
    state.broadcast('run.completed', { event: 'run.completed', session_id: 'managed-chat', agent_run_id: 'first', run_marker: 'first', replayed: true, queue_remaining: 1 })
  })
  await expect(page.getByText('Ready. (replayed)', { exact: true })).toHaveCount(1)
  await expect(page.locator('.chat-input-area').getByRole('button', { name: 'Stop', exact: true })).toBeVisible()
  const messages = [{ id: 3, role: 'user', content: JSON.stringify([{ type: 'text', text: 'Describe this image' }, { type: 'image', name: 'image.png', media_type: 'image/png', path: imagePath }]), timestamp: 101, run_marker: 'image-run' },
    { id: 4, role: 'assistant', content: 'Native picture answer.', timestamp: 101, run_marker: 'image-run' }]
  const interaction = { id: 'approval', requestId: 'native-request', runId: 'image-run', kind: 'approval', prompt: 'Allow native operation?', choices: [{ id: 'allow-native-once', label: 'Allow once' }], status: 'pending', expiresAt: null }
  await page.addInitScript(({ messages, interaction }) => {
    ;(window as any).__PW_CHAT_SOCKET_RESUMES__ = { 'managed-chat': { session_id: 'managed-chat', managed_agent_protocol: 1,
      agent_instance_id: 'managed', agent_instance_revision: 1, agent_mode: 'scoped', model: 'instance-model', messages, isWorking: true, events: [], agentInteractions: [interaction] } }
  }, { messages, interaction })
  const responses: any[] = []
  await page.route('**/api/studio/agent-runs/image-run/respond?*', route => {
    responses.push(route.request().postDataJSON())
    return route.fulfill({ json: { data: { id: 'approval', runId: 'image-run', status: 'resolved' } } })
  })
  await page.reload()
  await expect(page.getByText('Native picture answer.', { exact: true })).toHaveCount(1)
  const image = page.locator(`img[src*="/agent-chats/managed-chat/images/${imageId}"]`)
  await expect(image).toHaveCount(1)
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(2)
  await expect(page.getByText('Allow native operation?', { exact: true })).toBeVisible()
  await expect(page.getByText('Review tool call before running', { exact: true })).toBeVisible()
  await expect(page.locator('.approval-float-panel .pending-interaction-countdown')).toHaveCount(0)
  await page.screenshot({ path: info.outputPath('managed-chat-image-approval.png') })
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(mobile ? 390 : 1440)
  await page.getByRole('button', { name: 'Allow once', exact: true }).click()
  expect(responses).toEqual([{ interactionId: 'approval', choiceId: 'allow-native-once', idempotencyKey: expect.any(String) }])
  expect(api.checks).toEqual([])
  expect(api.unexpectedRequests).toEqual([])
})

for (const mobile of [false, true]) test(`one usage card follows the completed answer across tool calls and reload (${mobile ? 'mobile dark' : 'desktop light'})`, async ({ page }) => {
  await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 })
  const id = 'managed-usage', runId = 'usage-run'
  const session = { id, profile: 'research', source: 'coding_agent', agent: 'qwen', agent_mode: 'global', agent_instance_id: 'owned-instance',
    agent_instance_revision: 1, agent_chat_settings: true, model: '', title: 'Tool usage', started_at: 100, last_active: 100, message_count: 0 }
  const api = await setup(page, mobile ? 'dark' : 'light', false, [session])
  await page.addInitScript(id => {
    const saved = localStorage.getItem('test-managed-usage-history')
    ;(window as any).__PW_CHAT_SOCKET_RESUMES__ = { [id]: saved ? JSON.parse(saved) : { session_id: id, messages: [], events: [], isWorking: false, managed_agent_protocol: 1,
      agent_instance_id: 'owned-instance', agent_instance_revision: 1, agent_chat_settings: true, agent_mode: 'global', agentInteractions: [] } }
  }, id)
  await mockChatSocket(page)
  await page.goto(`/#/hermes/session/${id}?profile=research`)
  const input = page.locator('.chat-input-area textarea')
  await expect(input).toBeVisible()
  await input.fill('Check and update files')
  await input.press('Enter')
  await expect.poll(() => page.evaluate(() => (window as any).__PW_CHAT_SOCKET__.emitted.filter((item: any) => item.event === 'run').length)).toBe(1)
  await page.evaluate(({ id, runId }) => {
    const state = (window as any).__PW_CHAT_SOCKET__, queueId = state.emitted.find((item: any) => item.event === 'run').payload.queue_id
    const base = { session_id: id, agent_run_id: runId, run_id: runId, run_marker: runId, queue_id: queueId }
    const row = (messageId: number, role: string, content: string, extra = {}) => ({ id: messageId, session_id: id, role, content, timestamp: 100, run_marker: runId, ...extra })
    const rows = [row(1, 'user', 'Check and update files'), row(2, 'assistant', 'Checking files')]
    state.broadcast('run.started', { ...base, event: 'run.started' })
    state.broadcast('message.persisted', { ...base, event: 'message.persisted', messages: rows })
    for (let index = 0; index < 3; index++) {
      const tool = `tool-${index}`
      const pair = [row(3 + index * 2, 'assistant', '', { tool_calls: [{ id: tool, type: 'function', function: { name: 'read_file', arguments: '{}' } }] }),
        row(4 + index * 2, 'tool', `File ${index}`, { tool_name: 'read_file', tool_call_id: tool })]
      rows.push(...pair)
      state.broadcast('message.persisted', { ...base, event: 'message.persisted', messages: pair })
    }
    ;(window as any).__TEST_MANAGED_USAGE_ROWS__ = { base, rows }
  }, { id, runId })
  await expect(page.locator('.tool-run-card .tool-run-count')).toHaveText('3 tools')
  await expect(page.locator('.run-usage-card')).toHaveCount(0)
  await page.evaluate(({ id, runId }) => {
    const state = (window as any).__PW_CHAT_SOCKET__, { base, rows } = (window as any).__TEST_MANAGED_USAGE_ROWS__
    const answer = { ...rows[1], content: 'Files checked and updated.', run_usage: { runId, assistantMessageId: '2', inputTokens: 20, outputTokens: 5, cacheReadTokens: 0 } }
    rows[1] = answer
    state.broadcast('message.persisted', { ...base, event: 'message.persisted', messages: [answer] })
    state.broadcast('run.completed', { ...base, event: 'run.completed', status: 'completed', queue_remaining: 0 })
    localStorage.setItem('test-managed-usage-history', JSON.stringify({ session_id: id, messages: rows, events: [], isWorking: false, managed_agent_protocol: 1,
      agent_instance_id: 'owned-instance', agent_instance_revision: 1, agent_chat_settings: true, agent_mode: 'global', agentInteractions: [] }))
  }, { id, runId })
  const cards = page.locator('.run-usage-card')
  for (const reload of [false, true]) {
    if (reload) await page.reload()
    await expect(page.getByText('Files checked and updated.', { exact: true })).toBeVisible()
    await expect(page.locator('.tool-run-card .tool-run-count')).toHaveCount(1)
    await expect(cards).toHaveCount(1)
    await expect(cards.locator('.run-usage-value').first()).toHaveText('5')
    await expect(page.locator('.message.assistant').filter({ has: cards })).toContainText('Files checked and updated.')
  }
  expect(api.unexpectedRequests).toEqual([])
})
