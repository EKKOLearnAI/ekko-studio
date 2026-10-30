import type { Page } from '@playwright/test'

export type DesktopPlatform = 'darwin' | 'linux' | 'win32'
export type DesktopWindowKind = 'main' | 'chat'

export async function installDesktopBridge(page: Page, platform: DesktopPlatform, withBrowser = false, windowKind: DesktopWindowKind = 'main', initialTabCount = 1, completedDownload = false) {
  await page.addInitScript(({ desktopPlatform, includeBrowser, desktopWindowKind, tabCount, completedDownload }) => {
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
        savePath: '/tmp/hermes-browser/download/report.pdf', receivedBytes: completedDownload ? 100 : 25, totalBytes: 100,
        fileAvailable: true, state: completedDownload ? 'completed' : 'progressing', startedAt: '2026-01-03T00:00:00.000Z',
      }], permissions: [], visible: false, maxTabs: 12,
    }
    const browserHarness = {
      browserState,
      refreshCount: 0,
      downloadActions: [] as Array<{ id: string; action: string }>,
      failDownloadAction: false,
      viewportCalls: [] as Array<{ bounds: unknown; visible: boolean }>,
      createdProfiles: [] as Array<{ name: string; proxyMode?: string }>,
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
    Object.assign(browserHarness, { emitState: () => stateListener?.({ ...browserState }) })
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
      createProfile: async (input: { name: string; proxyMode?: string }) => {
        browserHarness.createdProfiles.push(input)
        return browserState.profiles[0]
      },
      chooseProfileRootDirectory: async () => '/tmp/hermes-browser-new',
      renameProfile: async () => browserState.profiles[0],
      profileSwitchImpact: async () => ({ activeAgentRuns: 0, activeDownloads: 0, pendingAnnotations: 0, openTabs: 1, requiresConfirmation: false }),
      switchProfile: async (profileId: string) => { browserState.activeProfileId = profileId; return { ...browserState } },
      updateProfile: async () => browserState.profiles[0],
      deleteProfile: async () => browserState,
      clearProfileData: async () => browserState,
      refreshDownloads: async () => { browserHarness.refreshCount++; return { ...browserState } },
      downloadAction: async (id: string, action: string) => {
        browserHarness.downloadActions.push({ id, action })
        if (browserHarness.failDownloadAction) throw new Error('BROWSER_DOWNLOAD_FILE_UNAVAILABLE')
        if (action === 'remove' || action === 'trash') browserState.downloads = browserState.downloads.filter(item => item.id !== id)
        return { ...browserState, downloads: [...browserState.downloads] }
      },
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
  }, { desktopPlatform: platform, includeBrowser: withBrowser, desktopWindowKind: windowKind, tabCount: initialTabCount, completedDownload })
}
