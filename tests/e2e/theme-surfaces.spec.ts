import { expect, test } from '@playwright/test'
import sharp from 'sharp'
import { authenticate, mockChatSocket, mockHermesApi } from './fixtures'

for (const brightness of ['light', 'dark']) {
  for (const blur of [0, 16, 30]) {
    test(`frame has no navigation-header seam in ${brightness} mode with blur ${blur}`, async ({ page }) => {
      await authenticate(page)
      await mockHermesApi(page, { theme: {
        brightness,
        background: { name: 'horizontal-stripes.png', mime: 'image/png', updatedAt: 1 },
        appearance: { global: { opacity: 0.2, blur }, regions: { chrome: { backgroundColor: '#8caacc', radius: 12, shadow: 2 } } },
      } })
      // The wallpaper varies vertically, so horizontally adjacent frame pixels
      // must stay equal even where separately positioned controls meet.
      const wallpaper = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"><defs><pattern id="p" width="1280" height="48" patternUnits="userSpaceOnUse"><path fill="#172b4d" d="M0 0h1280v24H0z"/><path fill="#e8c88c" d="M0 24h1280v24H0z"/></pattern></defs><path fill="url(#p)" d="M0 0h1280v720H0z"/></svg>')).png().toBuffer()
      await page.route('**/api/theme/background?*', route => route.fulfill({ contentType: 'image/png', body: wallpaper }))
      await page.goto('/#/hermes/theme')
      await expect(page.locator('.app-shell')).toHaveClass(/app-shell--custom-background/)
      await expect(page.locator('.studio-page-header')).toBeVisible()
      await expect.poll(async () => {
        const screenshot = await page.screenshot({ animations: 'disabled', path: `/tmp/studio-frame-seam-${brightness}-${blur}.png` })
        const { data, info } = await sharp(screenshot).raw().toBuffer({ resolveWithObject: true })
        let maxDifference = 0
        for (let y = 2; y < 38; y++) {
          for (let channel = 0; channel < 3; channel++) {
            const left = data[(y * info.width + 62) * info.channels + channel]
            const right = data[(y * info.width + 66) * info.channels + channel]
            maxDifference = Math.max(maxDifference, Math.abs(left - right))
          }
        }
        return maxDifference
      }).toBeLessThanOrEqual(2)
    })
  }
}

for (const brightness of ['light', 'dark']) {
  for (const wallpaper of [false, true]) {
    test(`group member rail follows sidebar appearance in ${brightness} mode with wallpaper ${wallpaper}`, async ({ page }) => {
      await authenticate(page)
      await mockChatSocket(page)
      const api = await mockHermesApi(page, { theme: {
        brightness,
        ...(wallpaper ? { background: { name: 'solid.png', mime: 'image/png', updatedAt: 1 } } : {}),
        appearance: {
          global: { opacity: 0.4 },
          regions: {
            sidebar: { backgroundColor: '#8caacc', opacity: 0.65, blur: 12, radius: 6, borderColor: '#6688aa', shadow: 0 },
            content: { backgroundColor: '#cc2244', opacity: 0.9 },
          },
        },
      } })
      if (wallpaper) {
        const image = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#204060' } }).png().toBuffer()
        await page.route('**/api/theme/background?*', route => route.fulfill({ contentType: 'image/png', body: image }))
      }
      const room = { id: 'theme-room', name: 'Theme Room', canManage: true, createdAt: 1, lastActiveAt: 1 }
      await page.route('**/api/studio/group-chat/rooms', route => route.fulfill({ json: { rooms: [room] } }))
      await page.route(/\/api\/studio\/group-chat\/rooms\/theme-room(?:\?.*)?$/, route => route.fulfill({ json: {
        room, messages: [], agents: [], members: [], total: 0, hasMore: false,
      } }))
      await page.route('**/api/studio/group-chat/rooms/theme-room/agent-link-requests', route => route.fulfill({ json: { requests: [] } }))
      await page.route('**/api/studio/group-chat/rooms/theme-room/summary', route => route.fulfill({ json: {
        summary: { roomId: room.id, summary: '', status: 'idle' }, review: null, anchor: null,
      } }))
      const roomPath = '/#/hermes/group-chat/room/theme-room'
      await page.goto(roomPath)
      const rail = page.locator('.agent-avatar-rail')
      const sidebar = page.locator('.room-sidebar')
      await expect(rail).toBeVisible()
      const expectMatchingSurfaces = async (opacity: number) => {
        for (const surface of [rail, sidebar]) {
          await expect(surface).toHaveCSS('background-color', `rgba(140, 170, 204, ${opacity})`)
          await expect(surface).toHaveCSS('backdrop-filter', 'blur(12px) saturate(1.1)')
          await expect(surface).toHaveCSS('border-radius', '6px')
          await expect(surface).toHaveCSS('border-right-color', `rgba(102, 136, 170, ${opacity})`)
          await expect(surface).toHaveCSS('box-shadow', 'none')
        }
        // A content tint beneath the avatar rail must not change its visible color.
        await expect.poll(async () => {
          const screenshot = await page.screenshot({ animations: 'disabled' })
          const samples = await Promise.all([rail, sidebar].map(async surface => {
            const box = (await surface.boundingBox())!
            return sharp(await sharp(screenshot).extract({
              left: Math.round(box.x + 10), top: Math.round(box.y + box.height * 0.6), width: 2, height: 2,
            }).toBuffer()).stats()
          }))
          return Math.max(...samples[0].channels.slice(0, 3).map((channel, index) => Math.abs(channel.mean - samples[1].channels[index].mean)))
        }).toBeLessThanOrEqual(1)
      }
      await expectMatchingSurfaces(0.65)
      await expect(rail).toHaveCSS('width', '72px')
      await page.goto('/#/hermes/theme')
      await page.getByTestId('theme-scope').selectOption('sidebar')
      await page.getByRole('button', { name: 'Reset Background opacity', exact: true }).click()
      await page.goto(roomPath)
      await expectMatchingSurfaces(0.4)
      await page.reload()
      await expectMatchingSurfaces(0.4)
      await page.goto('/#/hermes/theme')
      await page.getByRole('button', { name: 'Restore defaults', exact: true }).click()
      await page.goto(roomPath)
      const presetColor = wallpaper
        ? brightness === 'dark' ? 'rgba(26, 26, 26, 0.78)' : 'rgba(255, 255, 255, 0.78)'
        : brightness === 'dark' ? 'rgb(26, 26, 26)' : 'rgb(255, 255, 255)'
      for (const surface of [rail, sidebar]) {
        await expect(surface).toHaveCSS('background-color', presetColor)
        await expect(surface).toHaveCSS('backdrop-filter', wallpaper ? 'blur(12px) saturate(1.1)' : 'none')
      }
      expect(api.unexpectedRequests).toEqual([])
    })
  }
}

for (const brightness of ['light', 'dark']) {
  for (const wallpaper of [false, true]) {
    test(`navigation and top bar share opacity in ${brightness} mode with wallpaper ${wallpaper}`, async ({ page }) => {
      await authenticate(page)
      const api = await mockHermesApi(page, { theme: {
        brightness,
        ...(wallpaper ? { background: { name: 'solid.png', mime: 'image/png', updatedAt: 1 } } : {}),
        appearance: { global: {}, regions: {
          chrome: { backgroundColor: '#8caacc' },
          sidebar: { backgroundColor: '#aa3322', opacity: 1 },
        } },
      } })
      if (wallpaper) {
        const image = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#204060' } }).png().toBuffer()
        await page.route('**/api/theme/background?*', route => route.fulfill({ contentType: 'image/png', body: image }))
      }
      await page.goto('/#/hermes/theme')
      const rail = page.locator('.studio-navigation-rail')
      const header = page.locator('.studio-page-header')
      const frame = page.locator('.studio-frame-surface')
      await expect(header).toBeVisible()
      if (wallpaper) await expect(page.locator('.app-shell')).toHaveClass(/app-shell--custom-background/)
      const setOpacity = async (scope: string, value: string) => {
        await page.getByTestId('theme-scope').selectOption(scope)
        await page.getByTestId(`theme-${scope}-opacity`).fill(value)
        await page.getByTestId(`theme-${scope}-opacity`).dispatchEvent('change')
      }
      const expectMatchingFrame = async (opacity: number) => {
        const color = `rgba(140, 170, 204, ${opacity})`
        await expect(frame).toHaveCSS('background-color', color)
        for (const controls of [rail, header]) {
          await expect(controls).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
          await expect(controls).toHaveCSS('backdrop-filter', 'none')
        }
        // Check actual composited pixels as well as the shared background token.
        await expect.poll(async () => {
          const screenshot = await page.screenshot({ animations: 'disabled' })
          const railPixels = await sharp(await sharp(screenshot).extract({ left: 3, top: 180, width: 2, height: 2 }).toBuffer()).stats()
          const headerPixels = await sharp(await sharp(screenshot).extract({ left: 1100, top: 3, width: 2, height: 2 }).toBuffer()).stats()
          return Math.max(...railPixels.channels.slice(0, 3).map((channel, index) => Math.abs(channel.mean - headerPixels.channels[index].mean)))
        }).toBeLessThanOrEqual(1)
      }
      await setOpacity('global', '0.25')
      await expectMatchingFrame(0.25)
      await setOpacity('chrome', '0.7')
      await expectMatchingFrame(0.7)
      await setOpacity('global', '0.1')
      await expectMatchingFrame(0.7)
      await setOpacity('sidebar', '0')
      await expectMatchingFrame(0.7)
      await page.getByTestId('theme-scope').selectOption('chrome')
      await page.getByRole('button', { name: 'Reset Background opacity', exact: true }).click()
      await expectMatchingFrame(0.1)
      await page.reload()
      await expectMatchingFrame(0.1)
      await page.getByTestId('theme-scope').selectOption('global')
      await page.getByRole('button', { name: 'Reset Background opacity', exact: true }).click()
      await page.getByTestId('theme-scope').selectOption('chrome')
      await page.getByRole('button', { name: 'Reset Background color', exact: true }).click()
      const presetColor = wallpaper
        ? brightness === 'dark' ? 'rgba(26, 26, 26, 0.9)' : 'rgba(250, 250, 250, 0.6)'
        : brightness === 'dark' ? 'rgb(32, 32, 32)' : 'rgb(245, 245, 245)'
      await expect(frame).toHaveCSS('background-color', presetColor)
      expect(api.unexpectedRequests).toEqual([])
    })
  }
}

for (const customized of [false, true]) {
  test(`keeps shell page headers borderless with ${customized ? 'custom' : 'preset'} wallpaper styling`, async ({ page }) => {
    await authenticate(page)
    const api = await mockHermesApi(page, { theme: {
      background: { name: 'wallpaper.png', mime: 'image/png', updatedAt: 1 },
      ...(customized ? { appearance: {
        global: { borderWidth: 4, borderColor: '#ff0000', shadow: 2 },
        regions: { chrome: { backgroundColor: '#ccddee', opacity: 0.5, shadow: 2 } },
      } } : {}),
    } })
    await page.goto('/#/hermes/theme')
    await expect(page.locator('.app-shell')).toHaveClass(/app-shell--custom-background/)
    const header = page.locator('.studio-page-header--shell-sidebar')
    await expect(header).toBeVisible()
    for (const side of ['top', 'right', 'bottom', 'left']) {
      await expect(header).toHaveCSS(`border-${side}-width`, '0px')
    }
    await expect(header).toHaveCSS('box-shadow', 'none')
    await expect(header).toHaveCSS('height', '40px')
    if (customized) {
      await expect(header).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
      await expect(page.locator('.studio-frame-surface')).toHaveCSS('background-color', 'rgba(204, 221, 238, 0.5)')
      await expect(page.locator('.theme-card').first()).toHaveCSS('border-top-width', '4px')
      await expect(page.locator('.theme-card').first()).not.toHaveCSS('box-shadow', 'none')
      await expect(page.locator('.studio-frame-surface')).not.toHaveCSS('box-shadow', 'none')
      await expect(page.locator('.studio-navigation-rail')).toHaveCSS('box-shadow', 'none')
    }
    expect(api.unexpectedRequests).toEqual([])
  })
}

for (const contentBlur of [0, 8]) {
  test(`card blur changes the rendered wallpaper with content blur ${contentBlur}px`, async ({ page }) => {
    await authenticate(page)
    const api = await mockHermesApi(page, { theme: {
      background: { name: 'stripes.png', mime: 'image/png', updatedAt: 1 },
      appearance: { global: { opacity: 0.15 }, regions: { content: { blur: contentBlur }, card: { blur: 0 } } },
    } })
    const wallpaper = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="960" height="720"><defs><pattern id="p" width="48" height="48" patternUnits="userSpaceOnUse"><path fill="#222" d="M0 0h24v48H0z"/><path fill="#ddd" d="M24 0h24v48H24z"/></pattern></defs><path fill="url(#p)" d="M0 0h960v720H0z"/></svg>')).png().toBuffer()
    await page.route('**/api/theme/background?*', route => route.fulfill({ contentType: 'image/png', body: wallpaper }))
    await page.goto('/#/hermes/theme')
    await expect(page.locator('.app-shell')).toHaveClass(/app-shell--custom-background/)
    await page.getByTestId('theme-scope').selectOption('card')
    const card = page.locator('.theme-card').first()
    await card.scrollIntoViewIfNeeded()
    const rect = (await card.boundingBox())!
    const clip = { x: rect.x + rect.width / 2, y: rect.y + 5, width: 200, height: 8 }
    const before = await sharp(await page.screenshot({ clip })).stats()
    expect(before.channels[0].stdev).toBeGreaterThan(10)
    await page.getByTestId('theme-card-blur').evaluate(element => {
      const input = element as HTMLInputElement
      input.value = '30'
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await expect(card).toHaveCSS('backdrop-filter', 'blur(30px) saturate(1.1)')
    const after = await sharp(await page.screenshot({ clip })).stats()
    expect(after.channels[0].stdev).toBeLessThan(before.channels[0].stdev * 0.5)
    await expect(page.locator('.theme-library')).toHaveCSS('backdrop-filter', 'blur(30px) saturate(1.1)')
    await expect(page.locator('.theme-appearance-editor')).toHaveCSS('backdrop-filter', 'blur(30px) saturate(1.1)')
    expect(api.requests.filter(request => request.method === 'PUT' && request.pathname === '/api/theme')).toHaveLength(0)
    await page.getByTestId('theme-card-blur').dispatchEvent('change')
    await page.reload()
    await expect(card).toHaveCSS('backdrop-filter', 'blur(30px) saturate(1.1)')
    await page.getByTestId('theme-scope').selectOption('card')
    await page.getByRole('button', { name: 'Reset Background blur', exact: true }).click()
    await expect(page.locator('html')).not.toHaveClass(/theme-card-filter/)
    await expect(page.locator('.app-main--card')).toHaveCSS('backdrop-filter', `blur(${contentBlur}px) saturate(1.1)`)
    await expect(page.locator('.app-main--card')).toHaveCSS('background-color', 'rgba(255, 255, 255, 0.15)')
    expect(api.unexpectedRequests).toEqual([])
  })
}

for (const brightness of ['light', 'dark']) {
  test(`version preview follows regional card colors and transparency in ${brightness} mode`, async ({ page }) => {
    await authenticate(page)
    const api = await mockHermesApi(page, { theme: {
      brightness,
      appearance: { global: {}, regions: { card: { backgroundColor: '#336699', opacity: 0.25, blur: 12, radius: 16, borderColor: '#6688aa', shadow: 0 } } },
    } })
    await page.route('**/api/studio/update/preview', route => route.fulfill({ json: {
      preview_dir: '/tmp/studio-preview', webui_home: '/tmp/studio-preview-home',
      current_tag: 'v0.7.35', has_package: true, installed: true, running: false,
      frontend_url: 'http://localhost:8650', action_log_path: '/tmp/action.log', dev_log_path: '/tmp/dev.log',
      action_log: 'Dependencies installed.', dev_log: 'Preview ready.', active_action: null,
    } }))
    await page.route('**/api/studio/update/preview/tags', route => route.fulfill({ json: { tags: [{ name: 'v0.7.35', sha: 'abc123' }] } }))
    await page.goto('/#/hermes/version-preview')
    const table = page.locator('.status-table .n-descriptions-table-wrapper')
    await expect(table).toBeVisible()
    for (const surface of [table, page.locator('.log-output')]) {
      await expect(surface).toHaveCSS('background-color', 'rgba(51, 102, 153, 0.25)')
      await expect(surface).toHaveCSS('backdrop-filter', 'blur(12px) saturate(1.1)')
      await expect(surface).toHaveCSS('border-radius', '16px')
      await expect(surface).toHaveCSS('border-top-color', 'rgba(102, 136, 170, 0.25)')
    }
    const tint = brightness === 'dark' ? 'rgba(224, 224, 224, 0.04)' : 'rgba(26, 26, 26, 0.04)'
    await expect(table.locator('th').first()).toHaveCSS('background-color', tint)
    await expect(table.locator('td').first()).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    await expect(table.locator('.n-descriptions-table-content').first()).toHaveCSS('border-bottom-width', '1px')
    await expect(table.locator('.n-descriptions-table-content').first()).toHaveCSS('border-bottom-color', 'rgba(102, 136, 170, 0.25)')
    await expect(page.locator('.log-output-header')).toHaveCSS('border-bottom-color', 'rgba(102, 136, 170, 0.25)')
    await expect(page.locator('.log-title').first()).toHaveCSS('background-color', tint)
    await expect(page.locator('.log-box pre').first()).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    await page.screenshot({ path: `/tmp/studio-version-preview-theme-${brightness}.png`, fullPage: true })
    await page.locator('.log-output').scrollIntoViewIfNeeded()
    await page.screenshot({ path: `/tmp/studio-version-preview-logs-${brightness}.png` })
    expect(api.unexpectedRequests).toEqual([])
  })
}

for (const brightness of ['light', 'dark']) {
  test(`native card opt-in owns wallpaper defaults without a local fallback in ${brightness} mode`, async ({ page }) => {
    await authenticate(page)
    const api = await mockHermesApi(page, { theme: {
      brightness, background: { name: 'wall.png', mime: 'image/png', updatedAt: 1 },
    } })
    const card = page.locator('.app-connections-panel > .cloud-route-setting')
    async function openCard() {
      await page.goto('/#/hermes/connections?view=list')
      await expect(card).toBeVisible()
      // Model the documented contract: a native card with just a preset fill.
      // Regional/wallpaper behavior must come from the shared surface attribute.
      await page.addStyleTag({ content: '.cloud-route-setting.cloud-route-setting { background: var(--bg-card); }' })
    }
    await openCard()
    const wallpaper = brightness === 'light' ? 'rgba(255, 255, 255, 0.72)' : 'rgba(42, 42, 42, 0.72)'
    await expect(card).toHaveCSS('background-color', wallpaper)
    await card.evaluate(element => element.removeAttribute('data-theme-surface'))
    await expect(card).toHaveCSS('background-color', brightness === 'light' ? 'rgb(255, 255, 255)' : 'rgb(42, 42, 42)')
    await card.evaluate(element => element.setAttribute('data-theme-surface', 'card'))
    await expect(card).toHaveCSS('background-color', wallpaper)
    await page.goto('/#/hermes/theme')
    await page.getByTestId('theme-global-backgroundColor').fill('#223344')
    await page.getByTestId('theme-global-opacity').fill('0.4')
    await page.getByTestId('theme-global-opacity').dispatchEvent('change')
    await openCard()
    await expect(card).toHaveCSS('background-color', 'rgba(34, 51, 68, 0.4)')
    await page.goto('/#/hermes/theme')
    await page.getByTestId('theme-scope').selectOption('card')
    await page.getByTestId('theme-card-opacity').fill('0')
    await page.getByTestId('theme-card-opacity').dispatchEvent('change')
    await openCard()
    await expect(card).toHaveCSS('background-color', 'rgba(34, 51, 68, 0)')
    await expect(card).toHaveCSS('opacity', '1')
    await page.goto('/#/hermes/theme')
    await page.getByRole('button', { name: 'Restore defaults', exact: true }).click()
    await openCard()
    await expect(card).toHaveCSS('background-color', wallpaper)
    await page.goto('/#/hermes/theme')
    await page.getByRole('button', { name: 'Remove', exact: true }).click()
    await openCard()
    await expect(card).toHaveCSS('background-color', brightness === 'light' ? 'rgb(255, 255, 255)' : 'rgb(42, 42, 42)')
    expect(api.unexpectedRequests).toEqual([])
  })
}
