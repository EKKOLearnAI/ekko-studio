import { expect, test, type Page } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

const command = { id: 'example.echo/echo', name: 'echo', aliases: ['say'], qualifiedName: 'example.echo:echo', description: 'Echo via plugin handler', argsHint: '<text>', revision: 'one', provider: { kind: 'plugin', pluginId: 'example.echo', version: '1.0.0', generation: 'one' } }
const sessionId = 'plugin-commands'
const inputSelector = '.input-textarea'
async function setup(page: Page, brightness = 'light', wallpaper = false, managed = false) {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const current = { id: sessionId, profile: 'research', source: 'coding_agent', agent: 'cursor', agent_mode: 'global', model: '', provider: '', title: 'Plugin commands', started_at: 100, last_active: 101, message_count: 1,
    ...(managed ? { agent_instance_id: 'instance', agent_instance_revision: 1 } : {}) }
  const api = await mockHermesApi(page, { sessions: [current], theme: { brightness,
    background: wallpaper ? { name: 'wall.png', mime: 'image/png', updatedAt: 1 } : null,
    appearance: { global: { opacity: 0.6 }, regions: { overlay: { opacity: wallpaper ? 0 : 0.85, blur: 8, radius: 12 }, input: { opacity: 0.5 } } },
  } })
  await page.addInitScript(sid => { (window as any).__PW_CHAT_SOCKET_RESUMES__ = { [sid]: { session_id: sid, messages: [{ id: 1, role: 'user', content: 'Plugin session ready', timestamp: 100 }], isWorking: false, events: [] } } }, sessionId)
  await mockChatSocket(page)
  let catalog = [command], error = false, hold: Promise<void> | undefined
  const submissions: any[] = []
  let polls = 0, status = 'completed'
  const result = { event: 'session.command', session_id: sessionId, commandCallId: 'call', commandSequence: 0, messageId: 3, command: command.qualifiedName, action: 'echo', ok: true, message: 'Plugin handler result', terminal: true }
  const receipt = () => ({ id: 'call', inputMessageId: 2, sessionId, commandId: command.id, status, results: status === 'running' ? [] : [result], errorCode: null })
  await page.route('**/api/studio/commands?*', async route => {
    if (hold) await hold
    await route.fulfill({ status: error ? 503 : 200, json: error ? { ok: false, error: { message: 'Plugin temporarily unavailable' } } : { ok: true, data: catalog } })
  })
  await page.route('**/api/studio/command-calls?*', async route => {
    submissions.push(route.request().postDataJSON())
    expect(new URL(route.request().url()).searchParams.get('profile')).toBe('research')
    await route.fulfill({ json: { ok: true, data: receipt() } })
  })
  await page.route('**/api/studio/command-calls/call?*', async route => { polls++; await route.fulfill({ json: { ok: true, data: receipt() } }) })
  await page.route('**/api/studio/command-calls/call/cancel?*', async route => { status = 'cancelled'; await route.fulfill({ json: { ok: true, data: receipt() } }) })
  await page.goto(`/#/hermes/session/${sessionId}`)
  await expect(page.getByText('Plugin session ready')).toBeVisible()
  return { ...api, submissions, result, setCatalog: (value: typeof catalog) => { catalog = value }, setError: (value: boolean) => { error = value }, setHold: (value?: Promise<void>) => { hold = value }, setStatus: (value: string) => { status = value }, polls: () => polls }
}

for (const brightness of ['light', 'dark']) test(`managed instance commands use unambiguous native names (${brightness})`, async ({ page }, testInfo) => {
  if (brightness === 'dark') await page.setViewportSize({ width: 390, height: 844 })
  const api = await setup(page, brightness, brightness === 'dark', true)
  const input = page.locator(inputSelector)
  await input.fill('/echo')
  const item = page.locator('.slash-command-item').filter({ has: page.locator('.slash-command-name', { hasText: /^\/echo$/ }) })
  await expect(item).toBeVisible()
  await expect(page.locator('.slash-command-dropdown')).toHaveCSS('opacity', '1')
  await expect(item.locator('.slash-command-name')).toHaveAttribute('title', command.qualifiedName)
  expect(api.submissions).toEqual([])
  expect(await page.evaluate(() => (window as any).__PW_CHAT_SOCKET__.emitted.filter((item: any) => item.event === 'run'))).toEqual([])
  await page.screenshot({ path: testInfo.outputPath('managed-command-menu.png') })
  await item.click()
  await expect(input).toHaveValue('/echo ')
  await input.fill('/echo  "native arguments"')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByText('Plugin handler result', { exact: true })).toBeVisible()
  expect(api.submissions).toEqual([expect.objectContaining({ commandId: command.id, text: '/echo  "native arguments"' })])
  api.setCatalog([command, { ...command, id: 'other.plugin/echo', qualifiedName: 'other.plugin:echo' }])
  await input.fill('/echo conflict')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(input).toHaveValue('/echo conflict')
  expect(api.submissions).toHaveLength(1)
  await input.fill('/echo')
  await expect(page.locator('.slash-command-name').filter({ hasText: '/example.echo:echo' })).toBeVisible()
  await expect(page.locator('.slash-command-name').filter({ hasText: '/other.plugin:echo' })).toBeVisible()
  expect(api.unexpectedRequests).toEqual([])
})

for (const brightness of ['light', 'dark']) for (const wallpaper of [false, true]) {
  test(`plugin completion, loading and failure states (${brightness}, wallpaper ${wallpaper})`, async ({ page }, testInfo) => {
    if (wallpaper) await page.setViewportSize({ width: 390, height: 844 })
    const api = await setup(page, brightness, wallpaper)
    let release!: () => void
    api.setHold(new Promise(resolve => { release = resolve }))
    await page.locator(inputSelector).fill('/echo')
    await expect(page.locator('.plugin-command-feedback .n-spin')).toBeVisible()
    release(); api.setHold()
    const item = page.locator('.slash-command-item').filter({ hasText: '/example.echo:echo' })
    await expect(item).toBeVisible()
    await expect(page.locator('.slash-command-dropdown')).toHaveCSS('opacity', '1')
    await page.screenshot({ path: testInfo.outputPath('plugin-command-menu.png') })
    await item.click()
    await expect(page.locator(inputSelector)).toHaveValue('/example.echo:echo ')
    const raw = '/example.echo:echo  "quoted"\n tail '
    await page.locator(inputSelector).fill(raw)
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(page.getByText('Plugin handler result', { exact: true })).toBeVisible()
    expect(api.submissions).toEqual([expect.objectContaining({ sessionId, commandId: command.id, revision: 'one', text: raw })])
    expect(await page.evaluate(() => (window as any).__PW_CHAT_SOCKET__.emitted.filter((item: any) => item.event === 'run'))).toEqual([])
    await expect(page.locator(inputSelector)).toHaveValue('')
    api.setError(true)
    await page.locator(inputSelector).fill('/example.echo:echo retry')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(page.locator('.plugin-command-feedback')).toContainText('Unable to load plugin commands.')
    await expect(page.locator(inputSelector)).toHaveValue('/example.echo:echo retry')
    await page.screenshot({ path: testInfo.outputPath('plugin-command-error.png') })
    expect(api.submissions).toHaveLength(1)
    api.setError(false); api.setCatalog([])
    await page.locator('.plugin-command-feedback button').click()
    await expect(page.locator('.plugin-command-feedback')).toHaveCount(0)
    await page.locator(inputSelector).fill('/echo')
    await expect(page.locator('.slash-command-dropdown')).toHaveCount(0)
    expect(api.unexpectedRequests).toEqual([])
  })
}

test('stale selection and ambiguous aliases retain the draft; platform short names keep their handler', async ({ page }) => {
  const api = await setup(page)
  const input = page.locator(inputSelector)
  await input.fill('/echo')
  await page.locator('.slash-command-item').filter({ hasText: '/example.echo:echo' }).click()
  api.setCatalog([{ ...command, revision: 'two' }])
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(input).toHaveValue('/example.echo:echo ')
  expect(api.submissions).toHaveLength(0)
  api.setCatalog([command, { ...command, id: 'other.plugin/echo', qualifiedName: 'other.plugin:echo' }])
  await input.fill('/say hello')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(input).toHaveValue('/say hello')
  expect(api.submissions).toHaveLength(0)
  api.setCatalog([{ ...command, name: 'status', aliases: [] }])
  await input.fill('/status')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as any).__PW_CHAT_SOCKET__.emitted.filter((item: any) => item.event === 'run').length)).toBe(1)
  expect(api.submissions).toHaveLength(0)
})

test('deduplicates socket and polling results and stops an active command through its own call', async ({ page }) => {
  const api = await setup(page)
  api.setStatus('running')
  await page.locator(inputSelector).fill('/say hello')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect.poll(() => api.polls()).toBeGreaterThan(0)
  await page.evaluate(result => { (window as any).__PW_CHAT_SOCKET__.latest.__trigger('session.command', result) }, api.result)
  await expect(page.getByText('Plugin handler result', { exact: true })).toHaveCount(1)
  await page.getByRole('button', { name: 'Stop', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)
  await expect(page.getByText('Plugin handler result', { exact: true })).toHaveCount(1)
  expect(await page.evaluate(() => (window as any).__PW_CHAT_SOCKET__.emitted.filter((item: any) => item.event === 'abort'))).toEqual([])
})
