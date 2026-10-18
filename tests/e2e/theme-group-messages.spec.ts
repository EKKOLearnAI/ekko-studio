import { expect, test } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi } from './fixtures'

for (const brightness of ['light', 'dark']) {
  for (const wallpaper of [false, true]) {
    test(`group message backgrounds paint once in ${brightness} mode with wallpaper ${wallpaper}`, async ({ page }) => {
      await authenticate(page)
      await mockChatSocket(page)
      const api = await mockHermesApi(page, { theme: {
        brightness,
        ...(wallpaper ? { background: { name: 'wallpaper.png', mime: 'image/png', updatedAt: 1 } } : {}),
        appearance: {
          global: { opacity: 0.4 },
          regions: {
            card: { backgroundColor: '#336699', opacity: 0.25, blur: 8, radius: 6 },
            userMessage: { backgroundColor: '#224466', opacity: 0.3 },
            assistantMessage: { backgroundColor: '#884422', opacity: 0.35, blur: 12, radius: 18, borderColor: '#aa6633', shadow: 0 },
          },
        },
      } })
      const room = { id: 'bubble-room', name: 'Bubble Room', canManage: true, createdAt: 1, lastActiveAt: 1 }
      const agent = { id: 'agent-record', roomId: room.id, agentId: 'agent-one', name: 'Worker', agent: 'hermes', profile: 'default', invited: 1 }
      const tableContent = '| Name | Value |\n| --- | --- |\n| Theme | 42 |'
      const messages = [
        { id: 'self', roomId: room.id, senderId: 'auth:1', senderName: 'Me', role: 'user', content: tableContent, timestamp: 1792053000 },
        { id: 'standalone', roomId: room.id, senderId: agent.agentId, senderName: agent.name, role: 'assistant', content: tableContent, timestamp: 1792053001 },
        { id: 'reply', roomId: room.id, senderId: agent.agentId, senderName: agent.name, role: 'assistant', run_id: 'run-one', content: tableContent, timestamp: 1792053002 },
      ]
      await page.route('**/api/studio/group-chat/rooms', route => route.fulfill({ json: { rooms: [room] } }))
      await page.route(/\/api\/studio\/group-chat\/rooms\/bubble-room(?:\?.*)?$/, route => route.fulfill({ json: {
        room, messages, agents: [agent], members: [], total: messages.length, hasMore: false,
      } }))
      await page.route('**/api/studio/group-chat/rooms/bubble-room/agent-link-requests', route => route.fulfill({ json: { requests: [] } }))
      await page.route('**/api/studio/group-chat/rooms/bubble-room/summary', route => route.fulfill({ json: {
        summary: { roomId: room.id, summary: '', status: 'idle' }, review: null, anchor: null,
      } }))
      await page.goto('/#/hermes/group-chat/room/bubble-room')
      const card = page.locator('.group-agent-run .run-card')
      const embedded = card.locator('.group-message.embedded .msg-content')
      await expect(card).toHaveCSS('background-color', 'rgba(136, 68, 34, 0.35)')
      await expect(card).toHaveCSS('backdrop-filter', 'blur(12px) saturate(1.1)')
      await expect(card).toHaveCSS('border-radius', '18px')
      await expect(card).toHaveCSS('border-top-color', 'rgba(170, 102, 51, 0.35)')
      await expect(card).toHaveCSS('box-shadow', 'none')
      await expect(embedded).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
      await expect(embedded).toHaveCSS('backdrop-filter', 'none')
      await expect(page.locator('.group-message.self:not(.embedded) .msg-content')).toHaveCSS('background-color', 'rgba(34, 68, 102, 0.3)')
      await expect(page.locator('.group-message.agent:not(.embedded) .msg-content')).toHaveCSS('background-color', 'rgba(136, 68, 34, 0.35)')
      const tables = page.locator('.group-message .markdown-body table')
      await expect(tables).toHaveCount(3)
      for (const table of await tables.all()) {
        await expect(table).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
        await expect(table).toHaveCSS('backdrop-filter', 'none')
        await expect(table).toHaveCSS('box-shadow', 'none')
      }
      await expect(embedded.locator('td').first()).toHaveCSS('border-top-color', 'rgba(170, 102, 51, 0.35)')

      await page.goto('/#/hermes/theme')
      await page.getByTestId('theme-scope').selectOption('assistantMessage')
      await page.getByTestId('theme-assistantMessage-opacity').fill('0')
      await page.getByTestId('theme-assistantMessage-opacity').dispatchEvent('change')
      await page.goto('/#/hermes/group-chat/room/bubble-room')
      await expect(card).toHaveCSS('background-color', 'rgba(136, 68, 34, 0)')
      await expect(embedded).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
      await expect(embedded).toHaveCSS('backdrop-filter', 'none')
      await expect(embedded.locator('table')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
      await expect(page.locator('.group-message.agent:not(.embedded) .msg-content')).toHaveCSS('background-color', 'rgba(136, 68, 34, 0)')

      await page.goto('/#/hermes/theme')
      await page.getByTestId('theme-scope').selectOption('assistantMessage')
      await page.getByRole('button', { name: 'Reset Background opacity', exact: true }).click()
      await page.goto('/#/hermes/group-chat/room/bubble-room')
      await expect(card).toHaveCSS('background-color', 'rgba(136, 68, 34, 0.4)')
      await expect(card).toHaveCSS('border-radius', '18px')
      await expect(embedded).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
      expect(api.unexpectedRequests).toEqual([])
    })
  }
}
