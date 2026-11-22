import type { BrowserWindow, WebContentsView } from 'electron'
import { createRequire } from 'node:module'
import { expect, it, vi } from 'vitest'
import type { BrowserBounds, DesktopBrowserTab } from '../../packages/desktop/src/main/browser/browser-types'

const createWindow = vi.fn()
const desktopRequire = createRequire(new URL('../../packages/desktop/package.json', import.meta.url))
let electronModule = 'electron'
try {
  electronModule = desktopRequire.resolve('electron')
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') throw error
}
vi.doMock(electronModule, () => ({
  BrowserWindow: function (options: unknown) { return createWindow(options) },
}))
const { BrowserManager } = await import('../../packages/desktop/src/main/browser/browser-manager')

function fixture() {
  const root = { contentView: { addChildView: vi.fn(), removeChildView: vi.fn() } }
  const host = { contentView: { addChildView: vi.fn() }, setSize: vi.fn() }
  createWindow.mockReset().mockReturnValue(host)
  const view = {
    setBounds: vi.fn<(bounds: BrowserBounds) => void>(),
    setVisible: vi.fn(),
    webContents: {
      getBackgroundThrottling: () => true,
      setBackgroundThrottling: vi.fn(),
      isDestroyed: () => false,
    },
  }
  const manager = new BrowserManager(root as unknown as BrowserWindow, '.')
  vi.spyOn(manager['profileStore'], 'list').mockReturnValue([])
  const tab: DesktopBrowserTab = {
    id: 'tab', profileId: 'profile', title: 'Fixture', url: 'about:blank',
    loading: false, canGoBack: false, canGoForward: false, crashed: false, agentControl: 'idle',
  }
  manager['records'].set(tab.id, { tab, view: view as unknown as WebContentsView, console: [] })
  manager.activateTab(tab.id)
  return { manager, tab, root, host, view }
}

it('uses the default native size for a CDP capture when no usable panel size has been shown', async () => {
  const { manager, tab, root, host, view } = fixture()
  manager.setViewport({ x: 0, y: 0, width: 1, height: 1 }, false)
  vi.spyOn(manager.automation, 'sendPluginCdp').mockImplementationOnce(async () => {
    expect(createWindow).toHaveBeenCalledWith(expect.objectContaining({
      width: 800, height: 600, show: false, focusable: false,
    }))
    expect(host.setSize).toHaveBeenLastCalledWith(800, 600)
    expect(host.contentView.addChildView).toHaveBeenCalledWith(view)
    expect(view.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 800, height: 600 })
    expect(view.setVisible).toHaveBeenLastCalledWith(true)
    return {}
  })

  await manager.sendPluginCdp(tab.id, 'Page.captureScreenshot', { fromSurface: false })
  expect(root.contentView.addChildView).not.toHaveBeenCalled()
  expect(view.setVisible).toHaveBeenLastCalledWith(false)
  expect(view.webContents.setBackgroundThrottling).toHaveBeenLastCalledWith(true)
})

it('uses the last usable visible size for background screenshots across panel size and hide updates', async () => {
  const { manager, tab, root, host, view } = fixture()
  const panel = { x: 30, y: 70, width: 1280, height: 900 }
  manager.setViewport(panel, true)
  expect(root.contentView.addChildView).toHaveBeenCalledWith(view)
  expect(view.setBounds).toHaveBeenLastCalledWith(panel)
  manager.setViewport({ ...panel, width: 0 }, true)
  manager.setViewport({ x: 0, y: 0, width: 320, height: 480 }, false)
  manager.setViewport({ x: 0, y: 0, width: 1, height: 1 }, false)

  const error = new Error('Screenshot failed')
  vi.spyOn(manager.automation, 'screenshot').mockImplementationOnce(async () => {
    expect(host.setSize).toHaveBeenLastCalledWith(1280, 900)
    expect(view.setBounds).toHaveBeenLastCalledWith({ ...panel, x: 0, y: 0 })
    throw error
  })
  await expect(manager.screenshot(tab.id)).rejects.toThrow(error)
  expect(root.contentView.removeChildView).toHaveBeenCalledWith(view)
  expect(view.setVisible).toHaveBeenLastCalledWith(false)
  expect(view.webContents.setBackgroundThrottling).toHaveBeenLastCalledWith(true)
})
