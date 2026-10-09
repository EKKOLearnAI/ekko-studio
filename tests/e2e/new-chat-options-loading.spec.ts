import { selectNewChatAgent, selectNewChatLaunchMode, sendNewChatMessage } from './new-chat-helpers'
import { expect, test, type Page } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'
import agentCatalog from '../../config/agents.json'

function gate() {
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  return { pending, release }
}

async function warmDraft(page: Page) {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  await mockHermesApi(page)
  await mockChatSocket(page)
  await page.goto('/#/hermes/chat')
  await page.getByRole('button', { name: 'New Chat', exact: true }).click()
  const draft = page.locator('.new-chat-page')
  await draft.locator('textarea').fill('Hello')
  await expect(draft.getByRole('button', { name: 'Send', exact: true })).toBeEnabled()
  await draft.locator('textarea').focus()
  await page.keyboard.press('Escape')
  await expect(draft).toBeHidden()
  return draft
}

test('cached configuration stays usable while installation and category refreshes are pending', async ({ page }) => {
  const draft = await warmDraft(page)
  const delayed = gate()
  let pendingRequests = 0
  for (const endpoint of ['/api/agents/availability', '/api/studio/session-categories']) {
    await page.route(`**${endpoint}`, async route => {
      pendingRequests++
      await delayed.pending
      await route.fallback()
    })
  }
  try {
    await page.getByRole('button', { name: 'New Chat', exact: true }).click()
    await expect.poll(() => pendingRequests).toBe(2)
    await draft.locator('textarea').fill('Hello')
    await draft.getByRole('button', { name: 'Chat settings', exact: true }).click()
    const profile = page.locator('.new-chat-field').filter({ hasText: /^Profiles/ })
    await expect(profile).toContainText('research')
    await expect(profile.locator('.n-base-loading__container')).toHaveCount(0)
    const category = page.locator('.new-chat-field').filter({ hasText: /^Category/ })
    await expect(category.locator('.n-base-loading__container')).toBeVisible()
    await expect(draft.locator('.input-model-button')).toContainText('test-model')
    await expect(draft.getByRole('button', { name: 'Send', exact: true })).toBeEnabled()
    await profile.locator('.n-base-selection').click()
    await page.locator('.n-base-select-option:visible').filter({ hasText: /^default$/ }).click()
    await expect(profile).toContainText('default')
    delayed.release()
    await expect(category.locator('.n-base-loading__container')).toHaveCount(0)
    await expect(profile).toContainText('default')
  } finally {
    delayed.release()
  }
})

test('a closed draft cannot apply its late installation response to a reopened draft', async ({ page }) => {
  const draft = await warmDraft(page)
  const oldRequest = gate()
  let requests = 0
  await page.route('**/api/agents/availability', async route => {
    if (++requests !== 1) return route.fallback()
    await oldRequest.pending
    await route.fulfill({ json: { revision: 2, updatedAt: new Date().toISOString(), agents: [
      { id: 'ekko-agent', installed: true, source: 'built-in' },
      { id: 'codex', installed: false, source: 'not-installed' },
    ] } })
  })
  try {
    await page.getByRole('button', { name: 'New Chat', exact: true }).click()
    await expect.poll(() => requests).toBe(1)
    await draft.locator('textarea').focus()
    await page.keyboard.press('Escape')
    await expect(draft).toBeHidden()
    const newResponse = page.waitForResponse('**/api/agents/availability')
    await page.getByRole('button', { name: 'New Chat', exact: true }).click()
    await newResponse
    const agent = draft.locator('.agent-card.active')
    await selectNewChatAgent(page, 'Codex')
    const oldResponse = page.waitForResponse('**/api/agents/availability')
    oldRequest.release()
    await oldResponse
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())))
    await expect(agent).toContainText('Codex')
    await draft.locator('textarea').fill('Hello')
    await expect(draft.getByRole('button', { name: 'Send', exact: true })).toBeEnabled()
  } finally {
    oldRequest.release()
  }
})

test('an unavailable inventory disables creation without holding the configuration spinner', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  await mockHermesApi(page)
  await mockChatSocket(page)
  await page.route('**/api/agents/availability', route => route.fulfill({ status: 503, json: { error: 'Inventory unavailable' } }))
  await page.goto('/#/hermes/chat')
  const failedResponse = page.waitForResponse('**/api/agents/availability')
  await page.getByRole('button', { name: 'New Chat', exact: true }).click()
  await failedResponse
  const draft = page.locator('.new-chat-page')
  await draft.getByRole('button', { name: 'Chat settings', exact: true }).click()
  const profile = page.locator('.new-chat-field').filter({ hasText: /^Profiles/ })
  await expect(profile).toContainText('research')
  await expect(profile.locator('.n-base-loading__container')).toHaveCount(0)
  await expect(draft.getByRole('button', { name: 'Send', exact: true })).toBeDisabled()
})

for (const mode of ['scoped', 'global']) {
  test(`creating a ${mode} Coding Agent chat does not wait for CLI version probes`, async ({ page }) => {
    await authenticate(page, TEST_ACCESS_KEY, 'research')
    const api = await mockHermesApi(page)
    await mockChatSocket(page)
    const probes = gate()
    let probeRequests = 0
    let availabilityRequests = 0
    await page.route('**/api/coding-agents', async route => {
      probeRequests++
      await probes.pending
      await route.fallback()
    })
    await page.route('**/api/agents/availability', async route => {
      availabilityRequests++
      await route.fallback()
    })
    try {
      await page.goto('/#/hermes/chat')
      await page.getByRole('button', { name: 'New Chat', exact: true }).click()
      const draft = page.locator('.new-chat-page')
      const agent = draft.locator('.agent-card.active')
      await selectNewChatAgent(page, 'Codex')
      if (mode === 'global') await selectNewChatLaunchMode(page, 'global')
      await sendNewChatMessage(page, 'Start coding')
      // The probe gate remains closed until the chat is created.
      await expect(draft).toBeHidden()
      await expect(page).toHaveURL(/#\/hermes\/session\//)
      expect(probeRequests).toBe(0)
      expect(availabilityRequests).toBe(2)
      await expect.poll(() => page.evaluate(() => (window as any).__PW_CHAT_SOCKET__?.emitted
        ?.find((item: any) => item.event === 'run')?.payload)).toMatchObject({ coding_agent_id: 'codex', mode })
      expect(api.unexpectedRequests).toEqual([])
    } finally {
      probes.release()
    }
  })
}

for (const entry of ['/hermes/chat', '/studio/agents']) {
  test(`a new chat from ${entry} is ready without resuming server history`, async ({ page }) => {
    await authenticate(page, TEST_ACCESS_KEY, 'research')
    const api = await mockHermesApi(page)
    // There is no resumed payload for the new session, just as the server has no history yet.
    await mockChatSocket(page)
    await page.goto(`/#${entry}`)
    if (entry !== '/hermes/chat') await page.getByRole('link', { name: 'Chat', exact: true }).click()
    await page.getByRole('button', { name: 'New Chat', exact: true }).click()
    const draft = page.locator('.new-chat-page')
    await sendNewChatMessage(page)
    await expect(page).toHaveURL(/#\/hermes\/session\//)
    const sessionId = new URL(page.url()).hash.split('/').pop()!
    const input = page.getByPlaceholder('Type a message... (Enter to send, Shift+Enter for new line)')
    await expect(input).toBeVisible({ timeout: 2000 })
    await expect(page.locator('.chat-view > .page-loading-overlay')).toHaveCount(0)
    expect(await page.evaluate(sid => (window as any).__PW_CHAT_SOCKET__?.emitted
      ?.filter((item: any) => item.event === 'resume' && item.payload.session_id === sid) || [], sessionId)).toEqual([])
    await expect.poll(() => page.evaluate(() => (window as any).__PW_CHAT_SOCKET__?.emitted
      ?.find((item: any) => item.event === 'run')?.payload)).toMatchObject({ session_id: sessionId, agent_id: 'ekko-agent' })
    expect(api.unexpectedRequests).toEqual([])
  })
}

for (const agent of agentCatalog.agents) {
  for (const mode of agent.modes) {
    test(`${agent.name} ${mode} new chat skips history resume and starts its first run`, async ({ page }) => {
      await authenticate(page, TEST_ACCESS_KEY, 'research')
      const api = await mockHermesApi(page)
      await mockChatSocket(page)
      await page.route('**/api/agents/availability', route => route.fulfill({ json: {
        revision: 1,
        updatedAt: new Date().toISOString(),
        agents: agentCatalog.agents.map(item => ({
          id: item.id, installed: true, source: item.kind === 'built-in' ? 'built-in' : 'user-cli',
        })),
      } }))
      await page.goto('/#/hermes/chat')
      await page.getByRole('button', { name: 'New Chat', exact: true }).click()
      const draft = page.locator('.new-chat-page')
      if (agent.id !== 'ekko-agent') {
        await selectNewChatAgent(page, agent.name)
      }
      if (mode === 'global' && agent.modes.includes('scoped')) await selectNewChatLaunchMode(page, 'global')
      await sendNewChatMessage(page)
      await expect(page).toHaveURL(/#\/hermes\/session\//)
      const sessionId = new URL(page.url()).hash.split('/').pop()!
      expect(await page.evaluate(sid => (window as any).__PW_CHAT_SOCKET__?.emitted
        ?.filter((item: any) => item.event === 'resume' && item.payload.session_id === sid) || [], sessionId)).toEqual([])
      const input = page.getByPlaceholder('Type a message... (Enter to send, Shift+Enter for new line)')
      await expect(input).toBeVisible({ timeout: 2000 })
      await expect.poll(() => page.evaluate(() => (window as any).__PW_CHAT_SOCKET__?.emitted
        ?.find((item: any) => item.event === 'run')?.payload)).toMatchObject({
          session_id: sessionId,
          ...(agent.kind === 'coding-agent' ? { coding_agent_id: agent.id, mode }
            : agent.kind === 'built-in' ? { agent_id: agent.id } : { source: 'cli' }),
        })
      expect(api.unexpectedRequests).toEqual([])
    })
  }
}

for (const failure of ['not-installed', 'unavailable']) {
  test(`creation stops when the latest Coding Agent inventory is ${failure}`, async ({ page }) => {
    await authenticate(page, TEST_ACCESS_KEY, 'research')
    await mockHermesApi(page)
    await mockChatSocket(page)
    await page.goto('/#/hermes/chat')
    await page.getByRole('button', { name: 'New Chat', exact: true }).click()
    const draft = page.locator('.new-chat-page')
    await selectNewChatAgent(page, 'Codex')
    await page.route('**/api/agents/availability', route => route.fulfill(failure === 'unavailable'
      ? { status: 503, json: { error: 'Inventory unavailable' } }
      : { json: { revision: 2, updatedAt: new Date().toISOString(), agents: [
        { id: 'codex', installed: false, source: 'not-installed' },
      ] } }))
    const response = page.waitForResponse('**/api/agents/availability')
    await sendNewChatMessage(page)
    await response
    if (failure === 'unavailable') {
      await expect(page.locator('.n-message')).toContainText('Failed to inspect coding agents')
      await expect(draft.getByRole('button', { name: 'Send', exact: true })).toBeEnabled()
      await expect(draft).toBeVisible()
      await expect(page).toHaveURL(/#\/hermes\/chat$/)
    } else {
      await expect(page.locator('.n-message')).toContainText('Codex')
      await expect(page).toHaveURL(/#\/studio\/agents$/)
      await expect(draft).toBeHidden()
    }
  })
}
