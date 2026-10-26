import { expect, test } from '@playwright/test'
import { AGENT_OPTIONS } from '../../packages/client/src/utils/agent-options'
import { authenticate, mockChatSocket, mockHermesApi } from './fixtures'

for (const brightness of ['light', 'dark']) {
  for (const wallpaper of [false, true]) {
    for (const width of [320, 390, 1280]) {
      test(`empty group shows all agents at ${width}px in ${brightness}, wallpaper ${wallpaper}`, async ({ page }, testInfo) => {
        await page.setViewportSize({ width, height: 844 })
        await authenticate(page)
        await mockChatSocket(page)
        await mockHermesApi(page, { theme: {
          brightness,
          ...(wallpaper ? { background: { name: 'wallpaper.png', mime: 'image/png', updatedAt: 1 } } : {}),
          appearance: {
            global: { opacity: 0.4 },
            regions: { content: { opacity: 0, blur: 8, radius: 6 } },
          },
        } })
        const room = { id: 'empty-room', name: 'Empty Room', canManage: true, createdAt: 1, lastActiveAt: 1 }
        await page.route('**/api/studio/group-chat/rooms', route => route.fulfill({ json: { rooms: [room] } }))
        await page.route(/\/api\/studio\/group-chat\/rooms\/empty-room(?:\?.*)?$/, route => route.fulfill({ json: {
          room, messages: [], agents: [], members: [], total: 0, hasMore: false,
        } }))
        await page.route('**/api/studio/group-chat/rooms/empty-room/agent-link-requests', route => route.fulfill({ json: { requests: [] } }))
        await page.route('**/api/studio/group-chat/rooms/empty-room/summary', route => route.fulfill({ json: {
          summary: { roomId: room.id, summary: '', status: 'idle' }, review: null, anchor: null,
        } }))
        await page.goto('/#/hermes/group-chat/room/empty-room')
        const avatars = page.locator('.empty-agent-avatar img')
        await expect(avatars).toHaveCount(AGENT_OPTIONS.length)
        await expect(avatars.first()).toBeVisible()
        expect(await avatars.evaluateAll(images => images.map(image => image.getAttribute('alt'))))
          .toEqual(AGENT_OPTIONS.map(agent => agent.label))
        await expect.poll(() => avatars.evaluateAll(images =>
          images.every(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0),
        )).toBe(true)

        await expect.poll(() => page.locator('.empty-agent-avatar').evaluateAll(elements => {
          if (!elements.length) return null
          const rows = new Map<number, number>()
          const boxes = elements.map(element => element.getBoundingClientRect())
          boxes.forEach(box => rows.set(Math.round(box.top), (rows.get(Math.round(box.top)) || 0) + 1))
          const container = elements[0].closest('.empty-state')!.getBoundingClientRect()
          return {
            rows: [...rows.values()],
            sized: boxes.every(box => box.width > 0 && box.width <= (innerWidth <= 640 ? 36 : 44) && Math.abs(box.width - box.height) < 1),
            bounded: boxes.every(box => box.left >= Math.max(0, container.left) && box.right <= Math.min(innerWidth, container.right) + 1),
          }
        })).toEqual({
          rows: [8, 8],
          sized: true,
          bounded: true,
        })
        await page.screenshot({ path: testInfo.outputPath('empty-group.png') })
      })
    }
  }
}
