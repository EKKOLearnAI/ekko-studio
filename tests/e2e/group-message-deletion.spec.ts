import { expect, test, type Page } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi } from './fixtures'

async function setup(page: Page, options: { brightness?: string; wallpaper?: boolean; canManage?: boolean; unknown?: boolean } = {}) {
  await authenticate(page)
  await mockChatSocket(page)
  await mockHermesApi(page, { theme: {
    brightness: options.brightness || 'light',
    ...(options.wallpaper ? { background: { name: 'test.svg', mime: 'image/svg+xml', updatedAt: 1 }, appearance: { global: { opacity: 0.4 }, regions: { content: { opacity: 0 }, overlay: { opacity: 0.8 } } } } : {}),
  } })
  const room = { id: 'delete-group', name: 'Delete Group', canManage: options.canManage !== false, createdAt: 1, messageDeletionRevision: 0 }
  const agent = { id: 'agent-row', roomId: room.id, agentId: 'worker', name: 'Worker', agent: 'ekko', profile: 'default' }
  const msg = (id: string, timestamp: number, extra = {}) => ({ id, roomId: room.id, senderId: 'auth:1', senderName: 'Me', role: 'user', content: id, timestamp, ...extra })
  let rows = [msg('summarized', 1), msg('delete-user', 2),
    msg('run_part_0', 3, { role: 'assistant', senderId: 'worker', senderName: 'Worker', run_id: 'run', content: 'Agent first part', reasoning: 'Agent reasoning' }),
    msg('run_part_1', 4, { role: 'assistant', senderId: 'worker', senderName: 'Worker', run_id: 'run', content: 'Agent final part' }),
    msg('keep-user', 5),
  ]
  const groups = [
    { id: 'summarized', kind: 'message', messageIds: ['summarized'], deleteBlockedReason: 'summarized' },
    { id: 'delete-user', kind: 'message', messageIds: ['delete-user'] },
    { id: 'run_part_0', kind: 'run', messageIds: ['run_part_0', 'run_part_1', 'hidden-tool'] },
    { id: 'keep-user', kind: 'message', messageIds: ['keep-user'] },
  ]
  const requests: any[] = []
  await page.route('**/api/studio/group-chat/rooms', route => route.fulfill({ json: { rooms: [room] } }))
  await page.route(/\/api\/studio\/group-chat\/rooms\/delete-group(?:\?.*)?$/, route => route.fulfill({ json: { room, messages: rows, agents: [agent], members: [], total: rows.length, hasMore: false } }))
  await page.route('**/api/studio/group-chat/rooms/delete-group/agent-link-requests', route => route.fulfill({ json: { requests: [] } }))
  await page.route('**/api/studio/group-chat/rooms/delete-group/summary', route => route.fulfill({ json: { summary: { roomId: room.id, summary: 'Protected summary', status: 'success', version: 1, summaryThroughMessageId: 'summarized' }, review: null, anchor: null } }))
  await page.route('**/api/studio/group-chat/rooms/delete-group/message-selection', route => route.fulfill({ json: {
    historyRevision: 'a'.repeat(64), groups: groups.filter(group => rows.some(row => group.messageIds.includes(row.id))).map(group => options.unknown ? { ...group, deleteBlockedReason: 'summary_boundary_unknown' } : group),
  } }))
  await page.route('**/api/studio/group-chat/rooms/delete-group/messages/delete', async route => {
    const body = route.request().postDataJSON(); requests.push(body)
    const ids = groups.filter(group => body.messageIds.includes(group.id)).flatMap(group => group.messageIds)
    rows = rows.filter(row => !ids.includes(row.id)); room.messageDeletionRevision++
    await route.fulfill({ json: { roomId: room.id, messageIds: ids, messageDeletionRevision: room.messageDeletionRevision, deletedGroups: body.messageIds.length, messageCount: rows.length, totalTokens: 10 } })
  })
  if (options.wallpaper) await page.route('**/api/theme/background?*', route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><path fill="#687b91" d="M0 0h64v64H0z"/></svg>' }))
  await page.goto('/#/hermes/group-chat/room/delete-group')
  await expect(page.locator('[data-group-message-id="keep-user"]')).toBeVisible()
  return { requests }
}

async function select(page: Page) {
  await page.locator('[data-group-message-id="keep-user"]').click({ button: 'right' })
  await page.getByText('Select messages', { exact: true }).click()
  await expect(page.locator('.message-selection-row')).toHaveCount(4)
  const toolbar = page.locator('.message-selection-toolbar')
  await expect(toolbar).toBeVisible()
  await expect(toolbar).toHaveText('')
  await expect(toolbar.getByRole('button')).toHaveCount(2)
  await expect(toolbar.getByRole('button', { name: 'Delete selected', exact: true })).toBeDisabled()
  await expect(toolbar.getByRole('button', { name: 'Cancel', exact: true })).toBeEnabled()
}

for (const brightness of ['light', 'dark']) for (const wallpaper of [false, true]) {
  test(`group multi-delete preserves summary and unselected messages in ${brightness}, wallpaper ${wallpaper}`, async ({ page }) => {
    const { requests } = await setup(page, { brightness, wallpaper })
    await select(page)
    const locked = page.locator('[data-group-message-id="summarized"]')
    await expect(locked.getByRole('checkbox')).toHaveAttribute('aria-disabled', 'true')
    await expect(locked).toContainText('Already summarized; cannot delete')
    await locked.click()
    await expect(page.locator('.message-selection-row').getByRole('checkbox', { checked: true })).toHaveCount(0)
    await page.locator('[data-group-message-id="delete-user"]').click()
    await page.locator('[data-group-message-id="group-agent-run:worker:run"]').click()
    await expect(page.locator('.message-selection-row').getByRole('checkbox', { checked: true })).toHaveCount(2)
    await expect(page.locator('[data-group-message-id="delete-user"]').getByRole('checkbox')).toHaveAttribute('aria-checked', 'true')
    await expect(page.locator('[data-group-message-id="group-agent-run:worker:run"]').getByRole('checkbox')).toHaveAttribute('aria-checked', 'true')
    await page.screenshot({ path: `/tmp/group-delete-${brightness}-${wallpaper}.png`, animations: 'disabled' })
    await page.getByRole('button', { name: 'Delete selected', exact: true }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(page.locator('.message-selection-toolbar')).toHaveCount(0)
    expect(requests).toEqual([{ messageIds: ['delete-user', 'run_part_0'], historyRevision: 'a'.repeat(64) }])
    await expect(page.locator('[data-group-message-id="delete-user"]')).toHaveCount(0)
    await expect(page.locator('[data-group-message-id="group-agent-run:worker:run"]')).toHaveCount(0)
    await expect(page.locator('[data-group-message-id="summarized"]')).toBeVisible()
    await expect(page.locator('[data-group-message-id="keep-user"]')).toBeVisible()
    await page.reload()
    await expect(page.locator('[data-group-message-id="keep-user"]')).toBeVisible()
    await expect(page.locator('[data-group-message-id="delete-user"]')).toHaveCount(0)
    await selectAfterReload(page)
  })
}
async function selectAfterReload(page: Page) {
  await page.locator('[data-group-message-id="keep-user"]').click({ button: 'right' })
  await page.getByText('Select messages', { exact: true }).click()
  await expect(page.locator('[data-group-message-id="summarized"]').getByRole('checkbox')).toHaveAttribute('aria-disabled', 'true')
}

test('unknown summary boundaries lock every row and cancellation preserves history', async ({ page }) => {
  const { requests } = await setup(page, { unknown: true })
  await select(page)
  for (const row of await page.locator('.message-selection-row').all()) {
    await expect(row.getByRole('checkbox')).toHaveAttribute('aria-disabled', 'true')
    await expect(row).toContainText('Summary boundary unavailable')
  }
  await expect(page.getByRole('button', { name: 'Delete selected', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(requests).toEqual([])
  await expect(page.locator('[data-group-message-id]')).toHaveCount(4)
})

test('read-only room members have no deletion menu', async ({ page }) => {
  await setup(page, { canManage: false })
  await page.locator('[data-group-message-id="keep-user"]').click({ button: 'right' })
  await expect(page.getByText('Select messages', { exact: true })).toHaveCount(0)
})

test('busy room cancels selection and stale server rejection preserves messages', async ({ page }) => {
  await setup(page)
  await select(page)
  await page.evaluate(() => {
    const socket = (window as any).__PW_CHAT_SOCKET__.allSockets.find((s: any) => s.url.endsWith('/group-chat'))
    socket.__trigger('room_summary_updated', { roomId: 'delete-group', summary: 'Protected summary', status: 'summarizing', version: 1 })
  })
  await expect(page.locator('.message-selection-toolbar')).toHaveCount(0)
  await expect(page.getByText('Select messages', { exact: true })).toHaveCount(0)
  await page.evaluate(() => {
    const socket = (window as any).__PW_CHAT_SOCKET__.allSockets.find((s: any) => s.url.endsWith('/group-chat'))
    socket.__trigger('room_summary_updated', { roomId: 'delete-group', summary: 'Protected summary', status: 'success', version: 2 })
  })
  await select(page)
  await page.route('**/api/studio/group-chat/rooms/delete-group/messages/delete', route => route.fulfill({ status: 409, json: { error: 'History changed; select messages again' } }))
  await page.locator('[data-group-message-id="delete-user"]').click()
  await page.getByRole('button', { name: 'Delete selected', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(page.getByText('API Error 409: History changed; select messages again', { exact: true })).toBeVisible()
  await expect(page.locator('[data-group-message-id="delete-user"]')).toBeVisible()
})

test('narrow layout keeps controls usable and preserves dragged text selection', async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 820 })
  await setup(page)
  await select(page)
  await page.locator('[data-group-message-id="delete-user"] .msg-content').evaluate(el => {
    const range = document.createRange(); range.selectNodeContents(el)
    window.getSelection()?.removeAllRanges(); window.getSelection()?.addRange(range)
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await expect(page.locator('.message-selection-row').getByRole('checkbox', { checked: true })).toHaveCount(0)
  await page.evaluate(() => window.getSelection()?.removeAllRanges())
  await page.locator('[data-group-message-id="delete-user"]').getByRole('checkbox').click()
  await expect(page.locator('.message-selection-row').getByRole('checkbox', { checked: true })).toHaveCount(1)
  await expect(page.getByRole('button', { name: 'Delete selected', exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

for (const windowKind of ['main', 'chat']) {
  test(`desktop ${windowKind} native menu preserves Copy and starts group selection`, async ({ page }) => {
    await page.addInitScript(kind => {
      const requests: any[] = []
      ;(window as any).__GROUP_NATIVE_REQUESTS__ = requests
      ;(window as any).hermesDesktop = {
        isDesktop: true, platform: 'darwin', windowKind: kind,
        getWindowState: async () => ({ isMaximized: false }),
        messageContextMenu: {
          show: async (request: unknown) => { requests.push(request); return 'select-messages' },
          close: async () => {},
        },
      }
    }, windowKind)
    await setup(page)
    await page.locator('[data-group-message-id="keep-user"] .msg-content').evaluate(el => {
      const range = document.createRange(); range.selectNodeContents(el)
      window.getSelection()?.removeAllRanges(); window.getSelection()?.addRange(range)
      el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    })
    await expect(page.locator('.message-selection-row')).toHaveCount(4)
    expect(await page.evaluate(() => (window as any).__GROUP_NATIVE_REQUESTS__)).toEqual([
      { label: 'Select messages', enabled: true, hasSelection: true },
    ])
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('')
  })
}
