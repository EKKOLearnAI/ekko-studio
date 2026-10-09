import { expect, test, type Page } from '@playwright/test'
import { expectNewChatEffectsMoving } from './new-chat-helpers'
import { authenticate, mockChatSocket, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

type DesktopPlatform = 'darwin' | 'linux' | 'win32'
type DesktopWindowKind = 'main' | 'chat'

async function installDesktopBridge(page: Page, platform: DesktopPlatform, withBrowser = false, windowKind: DesktopWindowKind = 'main', initialTabCount = 1) {
  await page.addInitScript(({ desktopPlatform, includeBrowser, desktopWindowKind, tabCount }) => {
    const state = {
      actions: [] as string[],
      isMaximized: false,
      chatWindows: [] as Array<{ sessionId: string; profile?: string }>,
    }
    ;(window as typeof window & { __PW_DESKTOP_WINDOW__?: typeof state }).__PW_DESKTOP_WINDOW__ = state
    const browserState = {
      available: true,
      activeProfileId: 'profile-default',
      activeTabId: 'tab-1',
      tabs: Array.from({ length: tabCount }, (_, index) => ({
        id: `tab-${index + 1}`, profileId: 'profile-default', title: index ? `New Tab ${index + 1}` : 'New Tab', url: 'about:blank',
        loading: false, canGoBack: false, canGoForward: false, crashed: false, agentControl: 'idle',
      })),
      profiles: [{
        id: 'profile-default', name: 'Default', rootPath: '/tmp/hermes-browser', sessionPath: '/tmp/hermes-browser/data',
        downloadPath: '/tmp/hermes-browser/download', proxyMode: 'direct', proxyRules: '', askBeforeDownload: true,
        downloadConflictPolicy: 'uniquify', createdAt: '2026-01-01T00:00:00.000Z',
        lastUsedAt: '2026-01-01T00:00:00.000Z', tabs: ['tab-1'],
      }, {
        id: 'profile-work', name: 'Work', rootPath: '/tmp/hermes-browser-work', sessionPath: '/tmp/hermes-browser-work/data',
        downloadPath: '/tmp/hermes-browser-work/download', proxyMode: 'system', proxyRules: '', askBeforeDownload: false,
        downloadConflictPolicy: 'uniquify', createdAt: '2026-01-02T00:00:00.000Z',
        lastUsedAt: '2026-01-02T00:00:00.000Z', tabs: [],
      }],
      downloads: [{
        id: 'download-1', profileId: 'profile-default', fileName: 'report.pdf', sourceUrl: 'https://example.test/report.pdf',
        savePath: '/tmp/hermes-browser/download/report.pdf', receivedBytes: 25, totalBytes: 100,
        state: 'progressing', startedAt: '2026-01-03T00:00:00.000Z',
      }], permissions: [], visible: false, maxTabs: 12,
    }
    const browserHarness = {
      viewportCalls: [] as Array<{ bounds: unknown; visible: boolean }>,
      annotationCount: 0,
      clearAnnotationCalls: 0,
      captureAnnotationCalls: 0,
      annotationNotes: {} as Record<number, string>,
      removedAnnotations: [] as number[],
      markers: [] as number[],
      capturedMarkers: [] as number[],
      failRemoval: false,
      failCapture: false,
      requestAnnotation: undefined as undefined | ((request: { tabId: string; mode: 'element' | 'region' }) => void),
    }
    ;(window as typeof window & { __PW_DESKTOP_BROWSER__?: typeof browserHarness }).__PW_DESKTOP_BROWSER__ = browserHarness
    let nextTabNumber = tabCount
    let stateListener: ((state: typeof browserState) => void) | undefined
    const browser = includeBrowser ? {
      getState: async () => browserState,
      setViewport: async (bounds: unknown, visible: boolean) => {
        browserHarness.viewportCalls.push({ bounds, visible })
        browserState.visible = visible
        return browserState
      },
      createTab: async () => {
        nextTabNumber += 1
        const tab = { ...browserState.tabs[0], id: `tab-${nextTabNumber}`, title: `New Tab ${nextTabNumber}` }
        browserState.tabs = [...browserState.tabs, tab].slice(-browserState.maxTabs)
        browserState.activeTabId = tab.id
        stateListener?.({ ...browserState })
        return tab
      },
      closeTab: async () => browserState,
      activateTab: async () => browserState,
      navigate: async () => browserState.tabs[0],
      navigationAction: async () => browserState.tabs[0],
      createProfile: async () => browserState.profiles[0],
      chooseProfileRootDirectory: async () => '/tmp/hermes-browser-new',
      renameProfile: async () => browserState.profiles[0],
      profileSwitchImpact: async () => ({ activeAgentRuns: 0, activeDownloads: 0, pendingAnnotations: 0, openTabs: 1, requiresConfirmation: false }),
      switchProfile: async (profileId: string) => { browserState.activeProfileId = profileId; return { ...browserState } },
      updateProfile: async () => browserState.profiles[0],
      deleteProfile: async () => browserState,
      clearProfileData: async () => browserState,
      cancelDownload: async (downloadId: string) => {
        const download = browserState.downloads.find(item => item.id === downloadId)
        if (download) download.state = 'cancelled'
        return { ...browserState, downloads: browserState.downloads.map(item => ({ ...item })) }
      },
      takeOver: async () => true,
      annotate: async (_tabId: string, mode: 'element' | 'region') => {
        browserHarness.annotationCount += 1
        const marker = browserHarness.annotationCount
        browserHarness.markers.push(marker)
        return {
          tabId: 'tab-1', marker, mode, url: 'about:blank', title: 'New Tab',
          viewport: { width: 800, height: 600, scaleFactor: 1 },
          region: marker === 1 ? { x: 160, y: 120, width: 240, height: 90 } : { x: 480, y: 300, width: 160, height: 120 },
          screenshot: { mediaType: 'image/png', data: '', width: 800, height: 600 },
        }
      },
      cancelAnnotation: async () => true,
      removeAnnotation: async (_tabId: string, marker: number) => {
        if (browserHarness.failRemoval) throw new Error('Could not remove annotation')
        browserHarness.removedAnnotations.push(marker)
        browserHarness.markers = browserHarness.markers.filter(value => value !== marker)
        delete browserHarness.annotationNotes[marker]
        return true
      },
      updateAnnotationNote: async (_tabId: string, marker: number, note: string) => {
        browserHarness.annotationNotes[marker] = note
        return true
      },
      captureAnnotations: async () => {
        if (browserHarness.failCapture) throw new Error('Could not capture annotations')
        browserHarness.captureAnnotationCalls += 1
        browserHarness.capturedMarkers = [...browserHarness.markers]
        return { mediaType: 'image/png', data: '', width: 800, height: 600 }
      },
      clearAnnotations: async () => { browserHarness.clearAnnotationCalls += 1; return true },
      onAnnotationRequest: (callback: (request: { tabId: string; mode: 'element' | 'region' }) => void) => {
        browserHarness.requestAnnotation = callback
        return () => { if (browserHarness.requestAnnotation === callback) browserHarness.requestAnnotation = undefined }
      },
      onStateChange: (callback: (state: typeof browserState) => void) => {
        stateListener = callback
        return () => { stateListener = undefined }
      },
    } : undefined
    Object.defineProperty(window, 'hermesDesktop', {
      configurable: true,
      value: {
        isDesktop: true,
        platform: desktopPlatform,
        windowKind: desktopWindowKind,
        getWindowState: async () => ({ isMaximized: state.isMaximized }),
        windowControl: async (action: string) => {
          state.actions.push(action)
          if (action === 'toggle-maximize') state.isMaximized = !state.isMaximized
          return { isMaximized: state.isMaximized }
        },
        openChatWindow: async (sessionId: string, profile?: string) => {
          state.chatWindows.push({ sessionId, profile })
        },
        ...(browser ? { browser } : {}),
      },
    })
  }, { desktopPlatform: platform, includeBrowser: withBrowser, desktopWindowKind: windowKind, tabCount: initialTabCount })
}

async function openDesktopJobs(page: Page, platform: DesktopPlatform) {
  await installDesktopBridge(page, platform)
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  await mockHermesApi(page)
  await page.goto('/#/hermes/jobs')
  await expect(page.getByRole('heading', { name: 'Scheduled Jobs' })).toBeVisible()
}

async function topGutterDragRegion(page: Page) {
  return page.locator('.app-shell').evaluate((shell) => {
    const style = getComputedStyle(shell, '::before')
    return {
      appRegion: style.getPropertyValue('-webkit-app-region'),
      height: style.height,
    }
  })
}

async function openDesktopPageSidebar(page: Page, platform: DesktopPlatform, path: string) {
  await installDesktopBridge(page, platform)
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  await mockChatSocket(page)
  await mockHermesApi(page)
  await page.goto(path)
}

const softwareTest = test.extend({ launchOptions: { args: ['--disable-gpu'] } })

softwareTest.describe('Windows new-chat effects with software rendering', () => {
  for (const reducedMotion of ['no-preference', 'reduce'] as const) softwareTest(`Windows new-chat cards keep animating with ${reducedMotion} motion settings`, async ({ page }) => {
    await installDesktopBridge(page, 'win32')
    await page.setViewportSize({ width: 1280, height: 720 })
    await page.emulateMedia({ reducedMotion })
    await authenticate(page, TEST_ACCESS_KEY, 'research')
    await mockChatSocket(page)
    await mockHermesApi(page)
    await page.goto('/#/hermes/chat')
    await page.getByRole('button', { name: 'New Chat', exact: true }).click()
    const draft = page.locator('.new-chat-page')
    await expect(draft.locator('.agent-cards')).toHaveAttribute('aria-busy', 'false')
    // Verify visible movement even when the desktop environment disables CSS animations.
    await page.addStyleTag({ content: '* { animation: none !important; transition: none !important; }' })
    await expectNewChatEffectsMoving(page)
    const halo = draft.locator('.agent-card.active .agent-card-halo').first()
    const initialOpacity = await halo.evaluate(el => Number(getComputedStyle(el).opacity))
    await expect.poll(() => halo.evaluate(el => Number(getComputedStyle(el).opacity))).not.toBe(initialOpacity)
    await expect.poll(() => draft.evaluate(el => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1)
    if (reducedMotion === 'no-preference') await page.screenshot({ path: '/tmp/studio-windows-stars.png', animations: 'allow' })
  })
})

for (const platform of ['win32', 'linux'] as const) {
  test(`keeps browser settings header actions visible at the minimum ${platform} width`, async ({ page }) => {
    await installDesktopBridge(page, platform, true)
    await authenticate(page)
    await mockHermesApi(page)
    await page.setViewportSize({ width: 769, height: 900 })
    await page.goto('/#/hermes/browser')
    const header = page.locator('.studio-page-header > .page-header')
    const create = header.getByRole('button').last()
    await expect(create).toBeVisible()
    const bounds = (await create.boundingBox())!
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(769 - 138)
    expect(bounds.y).toBeGreaterThanOrEqual(0)
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(40)
    await create.click()
    await expect(page.getByRole('dialog')).toBeVisible()
  })

  test(`places ${platform} window controls inside the header right edge and keeps page actions clickable`, async ({ page }) => {
    await openDesktopJobs(page, platform)

    const controls = page.locator('.studio-page-header > .desktop-titlebar')
    const header = page.locator('.page-header')
    const sidebar = page.locator('aside.hermes-config-sidebar')
    await expect(controls).toBeVisible()
    await expect(controls.locator('.desktop-window-btn')).toHaveCount(3)
    await expect(controls.locator('img')).toHaveCount(0)
    await expect(controls).not.toContainText('Ekko Studio')

    const [controlsBox, headerBox] = await Promise.all([
      controls.boundingBox(),
      header.boundingBox(),
    ])
    expect(controlsBox).not.toBeNull()
    expect(headerBox).not.toBeNull()
    expect(controlsBox!.y).toBe(0)
    expect(headerBox!.y).toBe(0)
    expect(headerBox!.height).toBe(40)
    const windowButtonsBox = await controls.locator('.desktop-titlebar__controls').boundingBox()
    expect(headerBox!.x + headerBox!.width).toBeLessThanOrEqual(windowButtonsBox!.x)
    expect(controlsBox!.width).toBe(138)
    expect(controlsBox!.x + controlsBox!.width).toBe(page.viewportSize()!.width)
    expect((await sidebar.boundingBox())?.y).toBe(40)
    await expect(header).toHaveCSS('padding-right', '16px')
    await expect(page.locator('.app-main .page-header')).toHaveCount(0)
    await expect(header.getByRole('button').last()).toHaveCSS('-webkit-app-region', 'no-drag')
    await header.getByRole('button').last().click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect.poll(() => topGutterDragRegion(page)).toEqual({ appRegion: 'drag', height: '40px' })

    await controls.getByRole('button', { name: 'Minimize' }).click()
    await controls.locator('.desktop-window-btn').nth(1).click()
    await expect(controls.getByRole('button', { name: 'Restore' })).toBeVisible()
    const close = controls.getByRole('button', { name: 'Close' })
    await close.hover()
    await expect(close).toHaveCSS('border-radius', '0px')
    await expect.poll(() => close.evaluate(button => {
      const hover = getComputedStyle(button, '::before')
      return { background: hover.backgroundColor, radius: hover.borderRadius }
    })).toEqual({ background: 'rgb(196, 43, 28)', radius: '0px' })
    await expect.poll(() => controls.evaluate(bar => getComputedStyle(bar, '::after').display)).toBe('none')
    await close.click()
    await expect.poll(() => page.evaluate(() => (
      window as typeof window & { __PW_DESKTOP_WINDOW__?: { actions: string[] } }
    ).__PW_DESKTOP_WINDOW__?.actions)).toEqual(['minimize', 'toggle-maximize', 'close'])
  })

  test(`keeps ${platform} controls physically stable when the app language is RTL`, async ({ page }) => {
    await openDesktopJobs(page, platform)

    const titleBar = page.locator('.studio-page-header > .desktop-titlebar')
    const controls = titleBar.locator('.desktop-titlebar__controls')
    const buttonPositions = async () => controls.locator('.desktop-window-btn').evaluateAll(buttons =>
      buttons.map(button => Math.round(button.getBoundingClientRect().left)),
    )
    await expect(titleBar).toBeVisible()
    await expect(controls.locator('.desktop-window-btn')).toHaveCount(3)
    const ltrPositions = await buttonPositions()

    await page.evaluate(() => document.documentElement.setAttribute('dir', 'rtl'))

    await expect(titleBar).toHaveCSS('direction', 'ltr')
    await expect.poll(buttonPositions).toEqual(ltrPositions)
    await expect(controls).toHaveCSS('border-left-width', '0px')
    await expect(controls).toHaveCSS('border-right-width', '0px')
    await expect(controls).toHaveCSS('border-top-right-radius', '0px')
  })
}

test('matches Windows controls to the header glass over custom backgrounds', async ({ page }) => {
  await installDesktopBridge(page, 'win32', true)
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  await page.addInitScript(() => {
    window.localStorage.setItem('hermes_brightness', 'dark')
  })
  const api = await mockHermesApi(page, {
    theme: {
      accentColor: '#3366ff',
      background: {
        name: 'theme-background.png',
        mime: 'image/png',
        updatedAt: 101,
      },
    },
  })

  await page.goto('/#/hermes/browser')

  const controls = page.locator('.desktop-titlebar')
  const header = page.locator('.page-header')
  await expect(page.locator('.app-shell')).toHaveClass(/app-shell--custom-background/)
  await expect(page.getByRole('heading', { name: 'Browser' })).toBeVisible()
  await expect(header).toHaveCSS('height', '40px')
  await expect(header).not.toContainText('Browser Settings')
  await expect(page.locator('.app-main--card')).toHaveCSS('background-color', 'rgba(42, 42, 42, 0.82)')
  await expect(page.locator('.settings-card')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await expect(page.locator('.profile-card.active')).toHaveCSS('border-color', 'rgba(51, 102, 255, 0.55)')
  await expect(page.locator('.profile-card.active .active-badge')).toHaveCSS('color', 'rgb(51, 102, 255)')
  await expect(controls).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  const railBackground = await page.locator('.studio-navigation-rail').evaluate(el => getComputedStyle(el).backgroundColor)
  const headerGlass = await page.locator('.app-box').evaluate(el => {
    const style = getComputedStyle(el, '::before')
    return { background: style.backgroundColor, backdrop: style.backdropFilter }
  })
  expect(headerGlass).toEqual({ background: railBackground, backdrop: 'blur(16px) saturate(1.1)' })
  expect(api.unexpectedRequests).toEqual([])
})

test('reserves the macOS traffic-light area above the avatar in LTR and RTL', async ({ page }) => {
  await openDesktopJobs(page, 'darwin')

  await expect(page.locator('.desktop-titlebar')).toHaveCount(0)
  expect((await page.locator('.app-layout').boundingBox())?.y).toBe(40)
  expect((await page.locator('aside.hermes-config-sidebar').boundingBox())?.y).toBe(40)
  await expect(page.locator('aside.hermes-config-sidebar')).toHaveCSS('padding-top', '8px')
  await expect(page.locator('.studio-navigation-rail')).toHaveCSS('padding-top', '44px')
  expect((await page.locator('.studio-navigation-rail').boundingBox())?.y).toBe(0)
  await expect(page.locator('.studio-navigation-rail')).toHaveCSS('border-right-width', '0px')
  for (const direction of ['ltr', 'rtl']) {
    await page.evaluate(dir => document.documentElement.setAttribute('dir', dir), direction)
    const rail = (await page.locator('.studio-navigation-rail').boundingBox())!
    const avatar = (await page.locator('.studio-navigation-rail .page-sidebar-account-btn').boundingBox())!
    expect(rail.x).toBe(0)
    expect(rail.width).toBe(64)
    expect(avatar.y).toBeGreaterThanOrEqual(44)
    expect(avatar.x + avatar.width / 2).toBe(32)
  }
  await expect.poll(() => topGutterDragRegion(page)).toEqual({ appRegion: 'drag', height: '40px' })
})

test('keeps chat and group actions below the shared macOS header', async ({ page }) => {
  await openDesktopPageSidebar(page, 'darwin', '/#/hermes/chat')

  const chatSidebar = page.locator('.chat-panel > .session-list')
  const newChat = chatSidebar.locator('.page-sidebar-tab').first()
  await expect(newChat).toBeVisible()
  expect((await chatSidebar.boundingBox())?.y).toBe(40)
  expect((await newChat.boundingBox())?.x).toBeGreaterThanOrEqual(64)
  expect((await page.locator('.studio-navigation-rail .page-sidebar-account-btn').boundingBox())?.y).toBeGreaterThanOrEqual(44)

  await page.goto('/#/hermes/group-chat')
  const groupSidebar = page.locator('.group-chat-panel > .room-sidebar')
  const newRoom = groupSidebar.locator('.page-sidebar-tab').first()
  await expect(newRoom).toBeVisible()
  expect((await groupSidebar.boundingBox())?.y).toBe(40)
  expect((await newRoom.boundingBox())?.x).toBeGreaterThanOrEqual(64)
})

test('renders a native-chrome desktop chat route with only messages and input', async ({ page }) => {
  const session = {
    id: 'desktop-chat-1',
    title: 'Focused Desktop Chat',
    source: 'cli',
    model: 'test-model',
    provider: 'test-provider',
    profile: 'research',
    started_at: 1_800_000_000,
    ended_at: null,
    last_active: 1_800_000_100,
    message_count: 0,
  }
  await installDesktopBridge(page, 'darwin', false, 'chat')
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  await page.addInitScript(() => {
    ;(window as typeof window & { __PW_CHAT_SOCKET_RESUMES__?: Record<string, unknown> }).__PW_CHAT_SOCKET_RESUMES__ = {
      'desktop-chat-1': {
        session_id: 'desktop-chat-1',
        messages: [],
        isWorking: false,
        messageLoadedCount: 0,
        messageTotal: 0,
      },
    }
  })
  await mockChatSocket(page)
  await mockHermesApi(page, { sessions: [session] })
  await page.goto('/#/desktop-chat/desktop-chat-1?profile=research')

  await expect(page.locator('.desktop-titlebar')).toHaveCount(0)
  await expect.poll(() => topGutterDragRegion(page)).toEqual({ appRegion: 'drag', height: '46px' })
  await expect(page.locator('.message-list-shell')).toBeVisible()
  await expect(page.locator('.chat-input-area')).toBeVisible()
  await expect(page.locator('.session-list')).toHaveCount(0)
  await expect(page.locator('.chat-header')).toHaveCount(0)
  await expect(page.locator('aside.sidebar')).toHaveCount(0)
})

test('routes the desktop session popup action to the native chat window bridge', async ({ page }) => {
  const session = {
    id: 'desktop-popup-1',
    title: 'Popup Session',
    source: 'cli',
    model: 'test-model',
    provider: 'test-provider',
    profile: 'research',
    started_at: 1_800_000_000,
    ended_at: null,
    last_active: 1_800_000_100,
    message_count: 0,
  }
  await installDesktopBridge(page, 'darwin')
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  await page.addInitScript(() => {
    ;(window as typeof window & { __PW_CHAT_SOCKET_RESUMES__?: Record<string, unknown> }).__PW_CHAT_SOCKET_RESUMES__ = {
      'desktop-popup-1': {
        session_id: 'desktop-popup-1',
        messages: [],
        isWorking: false,
        messageLoadedCount: 0,
        messageTotal: 0,
      },
    }
  })
  await mockChatSocket(page)
  await mockHermesApi(page, { sessions: [session] })
  await page.goto('/#/hermes/chat')

  await page.locator('.session-item').first().click({ button: 'right' })
  await page.getByText('Open in new window', { exact: true }).click()

  await expect.poll(() => page.evaluate(() => (
    window as typeof window & {
      __PW_DESKTOP_WINDOW__?: { chatWindows: Array<{ sessionId: string; profile?: string }> }
    }
  ).__PW_DESKTOP_WINDOW__?.chatWindows)).toEqual([
    { sessionId: 'desktop-popup-1', profile: 'research' },
  ])
})

test('keeps the macOS workflow sidebar and main content flush', async ({ page }) => {
  await openDesktopPageSidebar(page, 'darwin', '/#/hermes/workflow')

  const workflowSidebar = page.locator('.workflow-view .workflow-sidebar')
  const workflowMain = page.locator('.workflow-view .workflow-main')
  await expect(workflowMain).toBeVisible()
  expect((await workflowSidebar.boundingBox())?.y).toBe(40)
  expect((await workflowMain.boundingBox())?.y).toBe(40)
})

test('does not reserve macOS traffic-light spacing in Windows chat sidebars', async ({ page }) => {
  await openDesktopPageSidebar(page, 'win32', '/#/hermes/chat')

  const sidebar = page.locator('.chat-panel > .session-list')
  const sidebarTop = page.locator('.chat-panel > .session-list > .page-sidebar-top')
  const newChat = sidebarTop.locator('.page-sidebar-tab').first()
  const main = page.locator('.chat-panel > .chat-main')
  const controls = page.locator('.desktop-titlebar')
  await expect(sidebarTop).toHaveCSS('padding-top', '12px')
  await expect(sidebarTop).toHaveCSS('-webkit-app-region', 'drag')
  await expect(newChat).toHaveCSS('-webkit-app-region', 'no-drag')
  expect((await sidebar.boundingBox())?.y).toBe(40)
  expect((await main.boundingBox())?.y).toBe(40)
  expect((await controls.boundingBox())!.x + (await controls.boundingBox())!.width).toBe(page.viewportSize()!.width)
  await expect(page.locator('.studio-page-header > .desktop-titlebar')).toHaveCount(1)
})

test('keeps the Linux sidebar flush below the shared window-control header', async ({ page }) => {
  await openDesktopJobs(page, 'linux')

  await expect(page.locator('.studio-page-header > .desktop-titlebar')).toBeVisible()
  expect((await page.locator('.app-layout').boundingBox())?.y).toBe(40)
  expect((await page.locator('aside.hermes-config-sidebar').boundingBox())?.y).toBe(40)
  await expect(page.locator('aside.hermes-config-sidebar')).toHaveCSS('padding-top', '8px')
  await expect.poll(() => topGutterDragRegion(page)).toEqual({ appRegion: 'drag', height: '40px' })
})

test('keeps the chat tool drawer unchanged in LTR and mirrors its resize seam in RTL', async ({ page }) => {
  await installDesktopBridge(page, 'darwin', true)
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  await mockChatSocket(page)
  await mockHermesApi(page)
  await page.goto('/#/hermes/chat')

  await page.locator('.header-tool-toggle').click()
  const wrapper = page.locator('.chat-content-wrapper')
  const panel = page.locator('.chat-tool-panel')
  const handle = page.locator('.chat-tool-resize-handle')
  await expect(panel).toBeVisible()
  await expect(panel).not.toHaveClass(/tool-panel-enter-active/)

  const geometry = async () => {
    const [wrapperBox, panelBox, handleBox] = await Promise.all([
      wrapper.boundingBox(),
      panel.boundingBox(),
      handle.boundingBox(),
    ])
    if (!wrapperBox || !panelBox || !handleBox) throw new Error('drawer geometry unavailable')
    return {
      wrapperLeft: wrapperBox.x,
      wrapperRight: wrapperBox.x + wrapperBox.width,
      panelLeft: panelBox.x,
      panelRight: panelBox.x + panelBox.width,
      panelWidth: panelBox.width,
      handleCenter: handleBox.x + handleBox.width / 2,
      handleY: handleBox.y + handleBox.height / 2,
    }
  }

  const ltr = await geometry()
  expect(Math.abs(ltr.panelRight - ltr.wrapperRight)).toBeLessThanOrEqual(1)
  expect(Math.abs(ltr.handleCenter - ltr.panelLeft)).toBeLessThanOrEqual(1)
  await page.mouse.move(ltr.handleCenter, ltr.handleY)
  await page.mouse.down()
  await page.mouse.move(ltr.handleCenter + 32, ltr.handleY)
  await page.mouse.up()
  await expect.poll(async () => (await geometry()).panelWidth).toBeLessThan(ltr.panelWidth)

  await page.evaluate(() => document.documentElement.setAttribute('dir', 'rtl'))
  await expect.poll(async () => {
    const current = await geometry()
    return Math.abs(current.panelLeft - current.wrapperLeft) <= 1
  }).toBe(true)
  const rtlGeometry = await geometry()
  expect(Math.abs(rtlGeometry.panelLeft - rtlGeometry.wrapperLeft)).toBeLessThanOrEqual(1)
  expect(Math.abs(rtlGeometry.handleCenter - rtlGeometry.panelRight)).toBeLessThanOrEqual(1)
  await page.mouse.move(rtlGeometry.handleCenter, rtlGeometry.handleY)
  await page.mouse.down()
  await page.mouse.move(rtlGeometry.handleCenter - 32, rtlGeometry.handleY)
  await page.mouse.up()
  await expect.poll(async () => (await geometry()).panelWidth).toBeLessThan(rtlGeometry.panelWidth)
})

test('shows the mobile file tree from the inline start edge in LTR and RTL', async ({ page }) => {
  await page.setViewportSize({ width: 600, height: 800 })
  await installDesktopBridge(page, 'darwin', true)
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  await page.addInitScript(() => window.localStorage.setItem('hermes_locale', 'en'))
  await mockChatSocket(page)
  await mockHermesApi(page)
  await page.goto('/#/hermes/chat')

  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr')
  await page.locator('.header-tool-toggle').click()
  const panel = page.locator('.chat-tool-panel')
  const tree = panel.locator('.files-tree-panel')
  await expect(tree).toBeVisible()
  await expect(panel.locator('.sidebar-toggle')).toBeHidden()

  await expect.poll(async () => {
    const box = await tree.boundingBox()
    return box ? Math.round(box.x) : null
  }).toBe(0)

  await page.evaluate(() => document.documentElement.setAttribute('dir', 'rtl'))
  await expect.poll(async () => {
    const box = await tree.boundingBox()
    return box ? Math.round(box.x + box.width) : null
  }).toBe(600)
})

test('allows creating a tab at capacity and displays the replacement state', async ({ page }) => {
  await installDesktopBridge(page, 'darwin', true, 'main', 12)
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  await mockChatSocket(page)
  await mockHermesApi(page)
  await page.goto('/#/hermes/chat')
  await page.locator('.header-tool-toggle').click()
  const panel = page.locator('.chat-tool-panel')
  await panel.getByRole('tab', { name: 'Browser' }).click()
  const tabs = panel.locator('.tab-strip .tab')
  await expect(tabs).toHaveCount(12)
  await expect(tabs.first()).toContainText('New Tab')
  const create = panel.locator('.new-tab')
  await expect(create).toBeEnabled()
  await create.click()
  await expect(tabs).toHaveCount(12)
  await expect(tabs.first()).toContainText('New Tab 2')
  await expect(tabs.last()).toContainText('New Tab 13')
  await expect(tabs.last()).toHaveClass(/active/)
  await expect(create).toBeEnabled()
})

test('embeds the desktop browser beside workspace and terminal', async ({ page }) => {
  await installDesktopBridge(page, 'darwin', true)
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  await mockChatSocket(page)
  await mockHermesApi(page)
  await page.goto('/#/hermes/chat')

  await page.locator('.header-tool-toggle').click()
  const toolPanel = page.locator('.chat-tool-panel')
  await expect(toolPanel.getByRole('tab')).toHaveCount(3)
  await expect(toolPanel.getByRole('tab', { name: 'Workspace' })).toBeVisible()
  await expect(toolPanel.getByRole('tab', { name: 'Terminal' })).toBeVisible()
  await expect(toolPanel.getByRole('tab', { name: 'Browser' })).toBeVisible()

  await toolPanel.getByRole('tab', { name: 'Browser' }).click()
  await expect(toolPanel.locator('.browser-panel')).toBeVisible()
  await expect(toolPanel.locator('.native-viewport')).toBeVisible()
  await expect.poll(() => page.evaluate(() => {
    const calls = (window as typeof window & { __PW_DESKTOP_BROWSER__?: { viewportCalls: Array<{ visible: boolean }> } }).__PW_DESKTOP_BROWSER__?.viewportCalls || []
    return calls.at(-1)?.visible
  })).toBe(true)

  const profileSwitcher = toolPanel.getByTestId('browser-profile-switcher')
  await expect(profileSwitcher).toContainText('Default')
  await toolPanel.getByRole('button', { name: 'Downloads' }).click()
  const downloadPopover = page.locator('.download-popover')
  await expect(downloadPopover).toContainText('report.pdf')
  await expect(downloadPopover).toContainText('25%')
  await downloadPopover.getByRole('button', { name: 'Cancel' }).click()
  await expect(downloadPopover).toContainText('Cancelled')
  await expect(downloadPopover.getByRole('button', { name: 'Cancel' })).toHaveCount(0)
  await toolPanel.getByRole('button', { name: 'Downloads' }).click()

  await profileSwitcher.click()
  await page.locator('.n-base-select-option').filter({ hasText: 'Work' }).click()
  await expect(profileSwitcher).toContainText('Work')
  await profileSwitcher.click()
  await page.locator('.n-base-select-option').filter({ hasText: 'Default' }).click()
  await expect(profileSwitcher).toContainText('Default')

  await page.getByRole('button', { name: 'New Chat', exact: true }).click()
  await expect(page.locator('.new-chat-page')).toBeVisible()
  await expect.poll(() => page.evaluate(() => {
    const calls = (window as typeof window & { __PW_DESKTOP_BROWSER__?: { viewportCalls: Array<{ visible: boolean }> } }).__PW_DESKTOP_BROWSER__?.viewportCalls || []
    return calls.at(-1)?.visible
  })).toBe(false)
  await page.keyboard.press('Escape')
  await expect(page.locator('.new-chat-page')).not.toBeVisible()
  await expect.poll(() => page.evaluate(() => {
    const calls = (window as typeof window & { __PW_DESKTOP_BROWSER__?: { viewportCalls: Array<{ visible: boolean }> } }).__PW_DESKTOP_BROWSER__?.viewportCalls || []
    return calls.at(-1)?.visible
  })).toBe(true)

  await page.evaluate(() => {
    const overlay = document.createElement('div')
    overlay.className = 'image-preview-overlay'
    overlay.dataset.browserImagePreviewTest = 'true'
    Object.assign(overlay.style, { position: 'fixed', inset: '0' })
    document.body.appendChild(overlay)
  })
  await expect.poll(() => page.evaluate(() => {
    const calls = (window as typeof window & { __PW_DESKTOP_BROWSER__?: { viewportCalls: Array<{ visible: boolean }> } }).__PW_DESKTOP_BROWSER__?.viewportCalls || []
    return calls.at(-1)?.visible
  })).toBe(false)
  await page.evaluate(() => document.querySelector('[data-browser-image-preview-test]')?.remove())
  await expect.poll(() => page.evaluate(() => {
    const calls = (window as typeof window & { __PW_DESKTOP_BROWSER__?: { viewportCalls: Array<{ visible: boolean }> } }).__PW_DESKTOP_BROWSER__?.viewportCalls || []
    return calls.at(-1)?.visible
  })).toBe(true)

  await page.evaluate(() => {
    const overlay = document.createElement('div')
    overlay.className = 'n-modal-body-wrapper'
    overlay.dataset.browserOverlayTest = 'true'
    Object.assign(overlay.style, { position: 'fixed', inset: '0' })
    document.body.appendChild(overlay)
  })
  await expect.poll(() => page.evaluate(() => {
    const calls = (window as typeof window & { __PW_DESKTOP_BROWSER__?: { viewportCalls: Array<{ visible: boolean }> } }).__PW_DESKTOP_BROWSER__?.viewportCalls || []
    return calls.at(-1)?.visible
  })).toBe(false)
  await page.evaluate(() => document.querySelector('[data-browser-overlay-test]')?.remove())
  await expect.poll(() => page.evaluate(() => {
    const calls = (window as typeof window & { __PW_DESKTOP_BROWSER__?: { viewportCalls: Array<{ visible: boolean }> } }).__PW_DESKTOP_BROWSER__?.viewportCalls || []
    return calls.at(-1)?.visible
  })).toBe(true)

  await page.evaluate(() => {
    const harness = (window as typeof window & {
      __PW_DESKTOP_BROWSER__?: { requestAnnotation?: (request: { tabId: string; mode: 'element' | 'region' }) => void }
    }).__PW_DESKTOP_BROWSER__
    harness?.requestAnnotation?.({ tabId: 'tab-1', mode: 'element' })
  })
  await expect(toolPanel.locator('.annotation-editor')).toBeVisible()
  await expect(toolPanel.locator('.annotation-popover')).toBeVisible()
  await expect(toolPanel.locator('.annotation-preview')).toHaveCSS('--annotation-left', '20%')
  await expect(toolPanel.locator('.annotation-preview')).toHaveCSS('--annotation-bottom', '35%')
  await expect(page.locator('.chat-input-area .attachment-preview')).toHaveCount(0)
  const firstNote = toolPanel.locator('.annotation-editor textarea')
  await firstNote.fill('Make this button more prominent')
  await firstNote.blur()
  await expect(toolPanel.locator('.annotation-editor')).toHaveCount(0)
  await expect(toolPanel.locator('.annotation-session-bar')).toContainText('1 annotation')
  await expect(toolPanel.locator('.native-viewport')).toBeVisible()
  await page.evaluate(() => {
    const harness = (window as typeof window & {
      __PW_DESKTOP_BROWSER__?: { requestAnnotation?: (request: { tabId: string; mode: 'element' | 'region' }) => void }
    }).__PW_DESKTOP_BROWSER__
    harness?.requestAnnotation?.({ tabId: 'tab-1', mode: 'region' })
  })
  await expect(toolPanel.locator('.annotation-popover')).toContainText('Annotation 2')
  await toolPanel.locator('.annotation-editor textarea').fill('Keep this card aligned with annotation one')
  await toolPanel.locator('.annotation-session-bar').getByRole('button', { name: 'Send' }).click()
  await expect(toolPanel.locator('.annotation-session-bar')).toHaveCount(0)
  await expect(page.locator('.chat-input-area .attachment-preview')).toHaveCount(0)
  await expect(page.locator('.chat-input-area textarea')).toHaveValue('')
  const sentSelection = page.locator('.message.user .msg-attachment.image').last()
  await expect(sentSelection).toBeVisible()
  const selectionData = sentSelection.locator('.msg-attachment-context')
  await expect(selectionData).not.toHaveAttribute('open', '')
  await selectionData.locator('summary').click()
  await expect(selectionData).toHaveAttribute('open', '')
  await expect(selectionData.locator('pre')).toContainText('browser_selection')
  await expect(selectionData.locator('pre')).toContainText('Make this button more prominent')
  await expect(selectionData.locator('pre')).toContainText('Keep this card aligned with annotation one')
  await expect(selectionData.locator('pre')).toContainText('"marker": 2')
  await expect.poll(() => page.evaluate(() => {
    const harness = (window as typeof window & {
      __PW_DESKTOP_BROWSER__?: { annotationNotes: Record<number, string>; captureAnnotationCalls: number }
    }).__PW_DESKTOP_BROWSER__
    return { notes: harness?.annotationNotes, captures: harness?.captureAnnotationCalls }
  })).toEqual({
    notes: { 1: 'Make this button more prominent', 2: 'Keep this card aligned with annotation one' },
    captures: 1,
  })

  await toolPanel.getByRole('tab', { name: 'Workspace' }).click()
  await expect(toolPanel.locator('.browser-panel')).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => {
    const calls = (window as typeof window & { __PW_DESKTOP_BROWSER__?: { viewportCalls: Array<{ visible: boolean }> } }).__PW_DESKTOP_BROWSER__?.viewportCalls || []
    return calls.at(-1)?.visible
  })).toBe(false)

  await page.goto('/#/hermes/browser')
  await expect(page.locator('.browser-settings-page')).toBeVisible()
  await expect(page.locator('.browser-settings-page .native-viewport')).toHaveCount(0)
})

async function openAnnotationPanel(page: Page) {
  await installDesktopBridge(page, 'darwin', true)
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  await mockChatSocket(page)
  await mockHermesApi(page)
  await page.goto('/#/hermes/chat')
  await page.locator('.header-tool-toggle').click()
  const panel = page.locator('.chat-tool-panel')
  await panel.getByRole('tab', { name: 'Browser' }).click()
  await expect(panel.locator('.native-viewport')).toBeVisible()
  return panel
}

async function requestTestAnnotation(page: Page) {
  await page.evaluate(() => (window as any).__PW_DESKTOP_BROWSER__.requestAnnotation({ tabId: 'tab-1', mode: 'element' }))
  await expect(page.locator('.annotation-editor')).toBeVisible()
}

test('deletes individual annotations and sends only surviving notes and visual markers', async ({ page }) => {
  const panel = await openAnnotationPanel(page)
  for (const note of ['Keep first', 'Wrong middle', 'Keep last']) {
    await requestTestAnnotation(page)
    await panel.locator('.annotation-editor textarea').fill(note)
    await panel.getByRole('button', { name: 'Done', exact: true }).click()
    await expect(panel.locator('.annotation-editor')).toHaveCount(0)
  }
  await panel.locator('.annotation-list').getByRole('button', { name: 'Delete annotation 2', exact: true }).click()
  await expect(panel.locator('.annotation-item')).toHaveCount(2)
  await expect(panel.locator('.annotation-list')).toContainText('Annotation 1 · Keep first')
  await expect(panel.locator('.annotation-list')).toContainText('Annotation 3 · Keep last')
  await expect(panel.locator('.annotation-list')).not.toContainText('Wrong middle')
  await panel.locator('.annotation-session-bar').getByRole('button', { name: 'Send', exact: true }).click()
  const context = page.locator('.message.user .msg-attachment.image').last().locator('.msg-attachment-context')
  await expect(context).toBeVisible()
  await context.locator('summary').click()
  await expect(context.locator('pre')).toContainText('Keep first')
  await expect(context.locator('pre')).toContainText('Keep last')
  await expect(context.locator('pre')).not.toContainText('Wrong middle')
  await expect(context.locator('pre')).not.toContainText('"marker": 2')
  expect(await page.evaluate(() => (window as any).__PW_DESKTOP_BROWSER__.capturedMarkers)).toEqual([1, 3])
})

test('undoes pending and completed annotations without clearing earlier selections', async ({ page }) => {
  const panel = await openAnnotationPanel(page)
  await requestTestAnnotation(page)
  await panel.locator('.annotation-editor textarea').fill('Keep this note')
  await panel.getByRole('button', { name: 'Done', exact: true }).click()
  await requestTestAnnotation(page)
  await panel.locator('.annotation-editor textarea').fill('Discard this pending note')
  await panel.getByRole('button', { name: 'Undo last', exact: true }).click()
  await expect(panel.locator('.annotation-editor')).toHaveCount(0)
  await expect(panel.locator('.annotation-item')).toHaveCount(1)
  await expect(panel.locator('.annotation-list')).toContainText('Keep this note')
  await panel.getByRole('button', { name: 'Undo last', exact: true }).click()
  await expect(panel.locator('.annotation-session-bar')).toHaveCount(0)
  await expect(panel.locator('.native-viewport')).toBeVisible()
  expect(await page.evaluate(() => (window as any).__PW_DESKTOP_BROWSER__.removedAnnotations)).toEqual([2, 1])
  expect(await page.evaluate(() => (window as any).__PW_DESKTOP_BROWSER__.clearAnnotationCalls)).toBe(0)
  await requestTestAnnotation(page)
  await expect(panel.locator('.annotation-item')).toHaveCount(1)
  await panel.locator('.annotation-actions').getByRole('button', { name: 'Delete annotation 3', exact: true }).click()
  await expect(panel.locator('.annotation-session-bar')).toHaveCount(0)
})

test('keeps annotations retryable on deletion failure and refuses a stale screenshot on capture failure', async ({ page }) => {
  const panel = await openAnnotationPanel(page)
  await requestTestAnnotation(page)
  await panel.locator('.annotation-editor textarea').fill('Keep pending text')
  await page.evaluate(() => { (window as any).__PW_DESKTOP_BROWSER__.failRemoval = true })
  await panel.getByRole('button', { name: 'Undo last', exact: true }).click()
  await expect(page.getByText('Could not remove annotation', { exact: true })).toBeVisible()
  await expect(panel.locator('.annotation-list')).toContainText('Keep pending text')
  await expect(panel.locator('.annotation-item')).toHaveCount(1)
  await page.evaluate(() => { (window as any).__PW_DESKTOP_BROWSER__.failCapture = true })
  await panel.locator('.annotation-session-bar').getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByText('Could not capture annotations', { exact: true })).toBeVisible()
  await expect(panel.locator('.annotation-item')).toHaveCount(1)
  await expect(panel.locator('.annotation-list')).toContainText('Keep pending text')
  await expect(page.locator('.message.user .msg-attachment.image')).toHaveCount(0)
  await page.evaluate(() => { (window as any).__PW_DESKTOP_BROWSER__.failRemoval = false })
  await panel.getByRole('button', { name: 'Undo last', exact: true }).click()
  await expect(panel.locator('.annotation-session-bar')).toHaveCount(0)
})

test('manages desktop browser profiles with switchable cards and editor modals', async ({ page }) => {
  await installDesktopBridge(page, 'darwin', true)
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  await mockHermesApi(page)
  await page.goto('/#/hermes/browser')

  await expect(page.getByRole('heading', { name: 'Browser' })).toBeVisible()
  const profileCard = page.locator('.profile-card')
  await expect(profileCard).toHaveCount(2)
  await expect(profileCard.first()).toContainText('Default')
  await expect(profileCard.first()).toContainText('Active profile')

  await profileCard.first().getByRole('button', { name: 'Edit' }).click()
  await expect(page.getByRole('dialog')).toContainText('Edit profile')
  await expect(page.getByRole('dialog').locator('input').first()).toHaveValue('Default')
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click()

  await page.getByRole('button', { name: 'Add profile' }).click()
  await expect(page.getByRole('dialog')).toContainText('Add profile')
  await page.getByRole('dialog').getByPlaceholder('Profile name').fill('Work')
  const createButton = page.getByRole('dialog').getByRole('button', { name: 'Create' })
  await expect(createButton).toBeDisabled()
  await page.getByRole('dialog').getByTestId('choose-browser-profile-root').click()
  await expect(page.getByRole('dialog')).toContainText('/tmp/hermes-browser-new/data')
  await expect(page.getByRole('dialog')).toContainText('/tmp/hermes-browser-new/download')
  await expect(createButton).toBeEnabled()
})
