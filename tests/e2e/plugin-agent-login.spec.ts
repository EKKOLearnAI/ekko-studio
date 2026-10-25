import { expect, test } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'
import { selectNewChatAgent, selectNewChatLaunchMode, sendNewChatMessage } from './new-chat-helpers'
import catalog from '../../config/agents.json'

// Instance management was removed from the user flow. Native PTY protocol and
// reconnect/retry semantics remain covered by the server management suites.
const plugins = catalog.agents.filter(agent => agent.modes.includes('global'))
for (const [index, agent] of plugins.entries()) test(`${agent.name} uses the native account without plugin ownership or setup`, async ({ page }) => {
  const mobile = index % 2 === 1, profile = mobile ? 'research' : 'default'
  await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 })
  await authenticate(page, TEST_ACCESS_KEY, profile)
  const api = await mockHermesApi(page)
  await mockChatSocket(page)
  await page.route('**/api/agents/availability', route => route.fulfill({ json: {
    revision: 1, updatedAt: new Date().toISOString(), agents: catalog.agents.map(agent => ({ id: agent.id, installed: true, source: 'user-cli' })),
  } }))
  await page.goto('/#/hermes/chat')
  if (mobile) await page.getByRole('button', { name: 'Menu', exact: true }).click()
  await page.getByRole('button', { name: 'New Chat', exact: true }).click()
  await selectNewChatAgent(page, agent.name)
  if (agent.modes.length > 1) await selectNewChatLaunchMode(page, 'global')
  else await expect(page.getByRole('radiogroup', { name: 'Launch mode', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Manage instances', exact: true })).toHaveCount(0)
  await expect(page.locator('.instance-manager-modal:visible')).toHaveCount(0)
  await sendNewChatMessage(page, 'Continue with the native account')
  await expect.poll(() => page.evaluate(() => (window as any).__PW_CHAT_SOCKET__.emitted.find((entry: any) => entry.event === 'run')?.payload))
    .toMatchObject({ input: 'Continue with the native account', profile, managed_agent_protocol: 1 })
  const bindings = api.requests.filter(request => request.pathname === '/api/studio/agent-chats')
  expect(bindings).toHaveLength(1)
  expect(JSON.parse(bindings[0].postData!)).toMatchObject({ agentTypeId: agent.id, mode: 'global' })
  expect(api.requests.filter(request => /\/api\/studio\/(?:plugins|bundled-agent-plugins|agent-instances|agent-types)/.test(request.pathname))).toEqual([])
  expect(api.unexpectedRequests).toEqual([])
})
