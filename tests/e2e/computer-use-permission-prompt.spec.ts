import { expect, test, type Page } from '@playwright/test'
import { DEFAULT_EKKO_CONFIG } from '../../packages/ekko-agent/src/config'
import { authenticate, mockChatSocket, mockHermesApi } from './fixtures'

const sessionId = 'computer-permission-chat'
async function setup(page: Page, options: { platform?: string; remote?: boolean; web?: boolean; granted?: boolean; agent?: string; replay?: boolean; idle?: boolean; standalone?: boolean; brightness?: string; locale?: string; wallpaper?: boolean } = {}) {
  const state = {
    status: { supported: true, accessibility: options.granted ? 'granted' : 'denied', screenRecording: options.granted ? 'granted' : 'not-determined' },
    claimed: false, checks: 0, requests: [] as string[],
  }
  await page.exposeFunction('__claimComputerPermission', () => {
    state.checks++
    if (state.claimed || ![state.status.accessibility, state.status.screenRecording].some(value => value !== 'granted')) return null
    state.claimed = true
    return state.status
  })
  await page.exposeFunction('__getComputerPermissions', () => state.status)
  await page.exposeFunction('__requestComputerPermission', (key: string) => { state.requests.push(key) })
  await authenticate(page)
  await mockChatSocket(page)
  await mockHermesApi(page, {
    sessions: [{ id: sessionId, profile: 'default', source: options.agent === 'hermes' ? 'cli' : 'builtin_agent', agent: options.agent || 'ekko-agent', agent_mode: 'scoped', model: 'gpt-test', provider: 'openai', title: 'Computer Use', started_at: 100, last_active: 101, message_count: 1 }],
    theme: { brightness: options.brightness || 'light', ...(options.wallpaper ? {
      background: { name: 'prompt.svg', mime: 'image/svg+xml', updatedAt: 1 },
      appearance: { global: { opacity: 0.4 }, regions: { overlay: { opacity: 0.85, radius: 16, blur: 12 } } },
    } : {}) },
  })
  if (options.wallpaper) await page.route('**/api/theme/background?*', route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><path fill="#728da0" d="M0 0h10v10H0z"/></svg>' }))
  await page.route('**/api/ekko/config', route => route.fulfill({ json: { ok: true, schemaVersion: 15, configPath: '/fixture/ekko.json', config: DEFAULT_EKKO_CONFIG, providers: [] } }))
  await page.addInitScript(({ options, sessionId }) => {
    localStorage.setItem('hermes_locale', options.locale || 'en')
    if (!options.web) (window as any).hermesDesktop = {
      isDesktop: true, platform: options.platform || 'darwin', remoteMode: !!options.remote,
      windowKind: options.standalone ? 'chat' : 'main', getWindowState: async () => ({ isMaximized: false }),
      computerUsePermissions: {
        claimReminder: () => (window as any).__claimComputerPermission(),
        getStatus: () => (window as any).__getComputerPermissions(),
        request: (key: string) => (window as any).__requestComputerPermission(key),
      },
    }
    ;(window as any).__PW_CHAT_SOCKET_RESUMES__ = { [sessionId]: {
      session_id: sessionId, messages: [{ id: 1, role: 'user', content: 'Computer Use session ready', timestamp: 100 }], isWorking: !options.idle, queueLength: 0,
      events: options.replay ? [{ data: { event: 'tool.started', tool: 'computer_use', arguments: { action: 'call', tool: 'list_apps' } } }] : [],
    } }
  }, { options, sessionId })
  await page.goto(options.standalone ? `/#/desktop-chat/${sessionId}` : `/#/hermes/session/${sessionId}`)
  await expect(page.getByText('Computer Use session ready', { exact: true })).toBeVisible()
  return state
}

async function toolStarted(page: Page, action = 'call', name = 'computer_use') {
  await page.evaluate(({ sessionId, action, name }) => {
    const socket = (window as any).__PW_CHAT_SOCKET__.latest
    socket.__trigger('tool.started', { event: 'tool.started', session_id: sessionId, tool: name, arguments: { action, tool: 'list_apps' }, tool_call_id: crypto.randomUUID() })
  }, { sessionId, action, name })
}

test('prompts on live use, never on replay/discovery, and Not now survives later calls and reloads', async ({ page }) => {
  const state = await setup(page, { replay: true })
  const prompt = page.getByTestId('computer-use-permission-prompt')
  await expect(prompt).toHaveCount(0)
  expect(state.checks).toBe(0)
  await toolStarted(page, 'list')
  await toolStarted(page, 'describe')
  await toolStarted(page, 'close')
  await toolStarted(page, 'call', 'read_file')
  await expect(prompt).toHaveCount(0)
  expect(state.checks).toBe(0)
  await toolStarted(page)
  await expect(prompt).toBeVisible()
  await expect(prompt.locator('li')).toHaveText(['Accessibility', 'Screen Recording'])
  expect(state.requests).toEqual([])
  await page.getByTestId('permission-prompt-later').click()
  await expect(prompt).toHaveCount(0)
  await toolStarted(page)
  await expect.poll(() => state.checks).toBe(2)
  await expect(prompt).toHaveCount(0)
  await page.reload()
  await expect(page.getByText('Computer Use session ready', { exact: true })).toBeVisible()
  await toolStarted(page)
  await expect.poll(() => state.checks).toBe(3)
  await expect(prompt).toHaveCount(0)
  expect(state.requests).toEqual([])
})

test('a newly sent run opens the guide without automatically requesting OS permission', async ({ page }) => {
  const state = await setup(page, { idle: true })
  await page.getByPlaceholder('Type a message... (Enter to send, Shift+Enter for new line)').fill('Use the desktop')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as any).__PW_CHAT_SOCKET__.emitted.filter((item: any) => item.event === 'run').length)).toBe(1)
  await toolStarted(page)
  await expect(page.getByTestId('computer-use-permission-prompt')).toBeVisible()
  await page.getByTestId('permission-prompt-authorize').click()
  await expect(page).toHaveURL(/ekko\/settings\?tab=tools/)
  await expect(page.getByTestId('computer-use-permissions')).toBeVisible()
  expect(state.requests).toEqual([])
  await page.getByRole('button', { name: 'Authorize · Accessibility' }).click()
  expect(state.requests).toEqual(['accessibility'])
})

test('only lists missing permissions and supports the standalone chat window', async ({ page }) => {
  const state = await setup(page, { standalone: true })
  state.status.accessibility = 'granted'
  await toolStarted(page, 'status')
  const prompt = page.getByTestId('computer-use-permission-prompt')
  await expect(prompt).toBeVisible()
  await expect(prompt.locator('li')).toHaveText(['Screen Recording'])
  await page.keyboard.press('Escape')
  await expect(prompt).toHaveCount(0)
  await toolStarted(page)
  await expect.poll(() => state.checks).toBe(2)
  await expect(prompt).toHaveCount(0)
})

for (const [name, options] of Object.entries({ granted: { granted: true }, Windows: { platform: 'win32' }, Linux: { platform: 'linux' }, remote: { remote: true }, web: { web: true }, Hermes: { agent: 'hermes' } })) {
  test(`does not prompt for ${name}`, async ({ page }) => {
    const state = await setup(page, options)
    await toolStarted(page)
    await expect(page.locator('.tool-call-name').filter({ hasText: 'computer_use' }).first()).toBeVisible()
    await expect(page.getByTestId('computer-use-permission-prompt')).toHaveCount(0)
    expect(state.claimed).toBe(false)
    expect(state.requests).toEqual([])
    if (name === 'granted') await expect.poll(() => state.checks).toBe(1)
    else expect(state.checks).toBe(0)
  })
}

for (const brightness of ['light', 'dark']) {
  for (const wallpaper of [false, true]) {
    test(`permission reminder appearance in ${brightness}, wallpaper ${wallpaper}`, async ({ page }) => {
      await setup(page, { brightness, wallpaper, locale: 'zh' })
      await toolStarted(page)
      const prompt = page.getByTestId('computer-use-permission-prompt')
      await expect(prompt).toBeVisible()
      await expect(prompt.getByRole('button')).toHaveText(['暂不', '去授权'])
      await expect(prompt.locator('li')).toHaveText(['辅助功能', '屏幕录制'])
      const suffix = `${brightness}${wallpaper ? '-wallpaper' : ''}`
      if (wallpaper) await expect(prompt).toHaveCSS('border-radius', '16px')
      await prompt.screenshot({ path: `/tmp/ekko-permission-prompt-${suffix}.png` })
      await page.screenshot({ path: `/tmp/ekko-permission-prompt-${suffix}-page.png` })
      await page.setViewportSize({ width: 390, height: 844 })
      expect(await prompt.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
      await prompt.screenshot({ path: `/tmp/ekko-permission-prompt-${suffix}-narrow.png` })
      await page.getByTestId('permission-prompt-later').click()
      await expect(prompt).toHaveCount(0)
    })
  }
}
