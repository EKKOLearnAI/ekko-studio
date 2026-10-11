// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

function browserBridge() {
  const createTab = vi.fn().mockResolvedValue({ id: 'web-tab' })
  const createHtmlPreviewTab = vi.fn().mockResolvedValue({ id: 'html-tab' })
  const methods = [
    'getState', 'setViewport', 'closeTab', 'activateTab', 'navigate',
    'navigationAction', 'createProfile', 'chooseProfileRootDirectory', 'renameProfile', 'profileSwitchImpact',
    'switchProfile', 'updateProfile', 'deleteProfile', 'clearProfileData', 'cancelDownload',
    'takeOver', 'annotate', 'cancelAnnotation', 'updateAnnotationNote',
    'captureAnnotations', 'clearAnnotations', 'onAnnotationRequest', 'onStateChange',
  ]
  return {
    ...Object.fromEntries(methods.map(method => [method, vi.fn()])),
    createTab,
    createHtmlPreviewTab,
  }
}

afterEach(() => {
  delete (window as typeof window & { hermesDesktop?: unknown }).hermesDesktop
  window.localStorage.clear()
  vi.resetModules()
})

describe('desktop browser open helpers', () => {
  it('opens web URLs and HTML content through the trusted desktop bridge', async () => {
    const browser = browserBridge()
    ;(window as typeof window & { hermesDesktop?: unknown }).hermesDesktop = {
      isDesktop: true,
      browser,
    }
    const listener = vi.fn()
    const { OPEN_DESKTOP_BROWSER_PANEL_EVENT, openHtmlInDesktopBrowser, openUrlInDesktopBrowser } = await import(
      '../../packages/client/src/utils/desktop-browser'
    )
    window.addEventListener(OPEN_DESKTOP_BROWSER_PANEL_EVENT, listener)

    await expect(openUrlInDesktopBrowser('https://example.com')).resolves.toBe(true)
    await expect(openHtmlInDesktopBrowser('<h1>Hello</h1>', 'report.html')).resolves.toBe(true)

    expect(browser.createTab).toHaveBeenCalledWith('https://example.com', true)
    expect(browser.createHtmlPreviewTab).toHaveBeenCalledWith('<h1>Hello</h1>', 'report.html', true)
    expect(listener).toHaveBeenCalledTimes(2)
    window.removeEventListener(OPEN_DESKTOP_BROWSER_PANEL_EVENT, listener)
  })

  it('reveals the browser panel before a slow tab finishes loading', async () => {
    const browser = browserBridge()
    let resolveTab!: (tab: { id: string }) => void
    const pendingTab = new Promise<{ id: string }>(resolve => {
      resolveTab = resolve
    })
    browser.createTab.mockReturnValue(pendingTab)
    ;(window as typeof window & { hermesDesktop?: unknown }).hermesDesktop = {
      isDesktop: true,
      browser,
    }
    const listener = vi.fn()
    const { OPEN_DESKTOP_BROWSER_PANEL_EVENT, openUrlInDesktopBrowser } = await import(
      '../../packages/client/src/utils/desktop-browser'
    )
    window.addEventListener(OPEN_DESKTOP_BROWSER_PANEL_EVENT, listener)

    const opening = openUrlInDesktopBrowser('https://example.com/slow')
    await Promise.resolve()

    expect(listener).toHaveBeenCalledTimes(1)
    resolveTab({ id: 'web-tab' })
    await expect(opening).resolves.toBe(true)
    window.removeEventListener(OPEN_DESKTOP_BROWSER_PANEL_EVENT, listener)
  })

  it('opens a link externally when the embedded browser cannot create a tab', async () => {
    const browser = browserBridge()
    browser.createTab.mockRejectedValue(new Error('Browser supports at most 8 tabs per profile'))
    const openExternalUrl = vi.fn().mockResolvedValue(true)
    ;(window as typeof window & { hermesDesktop?: unknown }).hermesDesktop = {
      isDesktop: true,
      browser,
      openExternalUrl,
    }
    const { openUrlInDesktopBrowser } = await import('../../packages/client/src/utils/desktop-browser')

    await expect(openUrlInDesktopBrowser('https://example.com/full')).resolves.toBe(true)

    expect(openExternalUrl).toHaveBeenCalledWith('https://example.com/full')
  })

  it('keeps the embedded-browser error when external fallback fails', async () => {
    const browser = browserBridge()
    const embeddedError = new Error('Browser supports at most 8 tabs per profile')
    browser.createTab.mockRejectedValue(embeddedError)
    const openExternalUrl = vi.fn().mockResolvedValue(false)
    ;(window as typeof window & { hermesDesktop?: unknown }).hermesDesktop = {
      isDesktop: true,
      browser,
      openExternalUrl,
    }
    const { openUrlInDesktopBrowser } = await import('../../packages/client/src/utils/desktop-browser')

    await expect(openUrlInDesktopBrowser('https://example.com/full')).rejects.toBe(embeddedError)

    expect(openExternalUrl).toHaveBeenCalledWith('https://example.com/full')
  })

  it('leaves a message URL for the system browser when that target is stored', async () => {
    const browser = browserBridge()
    ;(window as typeof window & { hermesDesktop?: unknown }).hermesDesktop = {
      isDesktop: true,
      browser,
    }
    window.localStorage.setItem('hermes_link_open_target', 'default-browser')
    const { openHtmlInDesktopBrowser, openUrlInDesktopBrowser } = await import('../../packages/client/src/utils/desktop-browser')

    await expect(openUrlInDesktopBrowser('https://example.com')).resolves.toBe(false)
    await expect(openHtmlInDesktopBrowser('<h1>Hello</h1>', 'report.html')).resolves.toBe(true)
    expect(browser.createTab).not.toHaveBeenCalled()
    expect(browser.createHtmlPreviewTab).toHaveBeenCalledWith('<h1>Hello</h1>', 'report.html', true)
  })

  it('uses the desktop external-url bridge when the system browser target is stored', async () => {
    const browser = browserBridge()
    const openExternalUrl = vi.fn().mockResolvedValue(true)
    ;(window as typeof window & { hermesDesktop?: unknown }).hermesDesktop = {
      isDesktop: true,
      browser,
      openExternalUrl,
    }
    window.localStorage.setItem('hermes_link_open_target', 'default-browser')
    const { openUrlInDesktopBrowser } = await import('../../packages/client/src/utils/desktop-browser')

    await expect(openUrlInDesktopBrowser('http://127.0.0.1:8748/docs')).resolves.toBe(true)

    expect(openExternalUrl).toHaveBeenCalledWith('http://127.0.0.1:8748/docs')
    expect(browser.createTab).not.toHaveBeenCalled()
  })

  it('surfaces a system-browser bridge failure instead of falling back to another target', async () => {
    const browser = browserBridge()
    const openExternalUrl = vi.fn().mockResolvedValue(false)
    ;(window as typeof window & { hermesDesktop?: unknown }).hermesDesktop = {
      isDesktop: true,
      browser,
      openExternalUrl,
    }
    window.localStorage.setItem('hermes_link_open_target', 'default-browser')
    const { openUrlInDesktopBrowser } = await import('../../packages/client/src/utils/desktop-browser')

    await expect(openUrlInDesktopBrowser('http://127.0.0.1:8748/docs')).rejects.toThrow('default browser')
    expect(browser.createTab).not.toHaveBeenCalled()
  })

  it('persists a validated link-opening target for later message clicks', async () => {
    const module = await import('../../packages/client/src/utils/desktop-browser') as unknown as Record<string, unknown>
    expect(module.setLinkOpenTarget).toBeTypeOf('function')

    const setLinkOpenTarget = module.setLinkOpenTarget as (target: 'hermes-studio' | 'default-browser') => void
    const getLinkOpenTarget = module.getLinkOpenTarget as () => 'hermes-studio' | 'default-browser'
    setLinkOpenTarget('default-browser')

    expect(window.localStorage.getItem('hermes_link_open_target')).toBe('default-browser')
    expect(getLinkOpenTarget()).toBe('default-browser')
  })

  it('leaves Web UI behavior untouched without the desktop bridge', async () => {
    const { openHtmlInDesktopBrowser, openUrlInDesktopBrowser } = await import(
      '../../packages/client/src/utils/desktop-browser'
    )

    await expect(openUrlInDesktopBrowser('https://example.com')).resolves.toBe(false)
    await expect(openHtmlInDesktopBrowser('<h1>Hello</h1>', 'report.html')).resolves.toBe(false)
  })

  it('keeps URL browsing available with an older desktop bridge and falls back for HTML previews', async () => {
    const browser = browserBridge()
    delete (browser as Partial<typeof browser>).createHtmlPreviewTab
    ;(window as typeof window & { hermesDesktop?: unknown }).hermesDesktop = {
      isDesktop: true,
      browser,
    }
    const { openHtmlInDesktopBrowser, openUrlInDesktopBrowser } = await import(
      '../../packages/client/src/utils/desktop-browser'
    )

    await expect(openUrlInDesktopBrowser('https://example.com')).resolves.toBe(true)
    await expect(openHtmlInDesktopBrowser('<h1>Hello</h1>', 'report.html')).resolves.toBe(false)
    expect(browser.createTab).toHaveBeenCalledWith('https://example.com', true)
  })
})
