import { expect, test } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi, TEST_MODEL_GROUP } from './fixtures'

for (const [levels, expected, label] of [
  [['none', 'low', 'high', 'xhigh'], 'low', 'Low'],
  [['medium', 'high'], 'medium', 'Medium'],
  [[], '', 'None'],
] as const) {
  test(`group Agent defaults to ${label} and saves the displayed selection`, async ({ page }) => {
    await authenticate(page)
    await mockChatSocket(page)
    await mockHermesApi(page, { modelGroups: [{ ...TEST_MODEL_GROUP,
      model_meta: { 'test-model': { reasoning: levels.length > 0, reasoning_efforts: [...levels] } },
    }] })
    const room = { id: 'effort-room', name: 'Effort Room', canManage: true, createdAt: 1, lastActiveAt: 1 }
    await page.route('**/api/studio/group-chat/rooms', route => route.fulfill({ json: { rooms: [room] } }))
    await page.route(/\/api\/studio\/group-chat\/rooms\/effort-room(?:\?.*)?$/, route => route.fulfill({ json: {
      room, messages: [], agents: [], members: [], total: 0, hasMore: false,
    } }))
    await page.route('**/api/studio/group-chat/rooms/effort-room/agent-link-requests', route => route.fulfill({ json: { requests: [] } }))
    await page.route('**/api/studio/group-chat/rooms/effort-room/summary', route => route.fulfill({ json: {
      summary: { roomId: room.id, summary: '', status: 'idle' }, review: null, anchor: null,
    } }))
    const saved: any[] = []
    await page.route('**/api/studio/group-chat/rooms/effort-room/agents', async route => {
      saved.push(route.request().postDataJSON())
      await route.fulfill({ json: { agent: { ...saved.at(-1), id: 'worker', agentId: 'worker', roomId: room.id } } })
    })
    await page.goto('/#/hermes/group-chat/room/effort-room')
    await page.getByRole('button', { name: 'Add Agent', exact: true }).click()
    const drawer = page.locator('.n-drawer:visible')
    await expect(drawer.locator('[aria-label="Reasoning effort"]')).toContainText(label)
    await drawer.getByRole('button', { name: 'Add', exact: true }).click()
    await expect.poll(() => saved.at(-1)?.reasoningEffort).toBe(expected)
  })
}
