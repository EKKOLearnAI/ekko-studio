import { BrowserWindow, screen, type Display } from 'electron'
import { join } from 'node:path'
import { screenshotOverlayHtml } from './screenshot-overlay'

export interface ScreenshotOverlayWindow {
  window: BrowserWindow
  display: Display
  loaded: Promise<void>
}

const windows = new Map<number, ScreenshotOverlayWindow>()

/** Preload the small editor document. Screenshots are supplied only for an active request. */
export async function prepareScreenshotOverlays(displays = screen.getAllDisplays()): Promise<ScreenshotOverlayWindow[]> {
  for (const [id, entry] of windows) {
    const display = displays.find(item => item.id === id)
    if (!display || JSON.stringify(display.bounds) !== JSON.stringify(entry.display.bounds) || display.scaleFactor !== entry.display.scaleFactor) {
      windows.delete(id)
      if (!entry.window.isDestroyed()) entry.window.destroy()
    }
  }
  const entries = displays.map(display => {
    const existing = windows.get(display.id)
    if (existing && !existing.window.isDestroyed()) return existing
    const window = new BrowserWindow({
      ...display.bounds, frame: false, show: false, resizable: false, movable: false,
      minimizable: false, maximizable: false, skipTaskbar: true, alwaysOnTop: true,
      hasShadow: false, enableLargerThanScreen: true, backgroundColor: '#000000',
      ...(process.platform === 'darwin' ? { type: 'panel' } : {}),
      webPreferences: {
        preload: join(__dirname, '../preload/screenshot-overlay.js'),
        contextIsolation: true, nodeIntegration: false, sandbox: true,
        backgroundThrottling: false,
      },
    })
    window.setAlwaysOnTop(true, 'screen-saver')
    // macOS's default process-type transformation briefly hides every app window and the Dock.
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
    window.setMenu(null)
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', event => event.preventDefault())
    window.webContents.on('render-process-gone', () => { if (!window.isDestroyed()) window.destroy() })
    window.once('closed', () => { if (windows.get(display.id)?.window === window) windows.delete(display.id) })
    const loaded = window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(screenshotOverlayHtml())}`)
    const entry = { window, display, loaded }
    windows.set(display.id, entry)
    void loaded.catch(() => { if (!window.isDestroyed()) window.destroy() })
    return entry
  })
  await Promise.all(entries.map(entry => entry.loaded))
  return entries
}

export function disposeScreenshotOverlays() {
  const entries = [...windows.values()]
  windows.clear()
  for (const entry of entries) if (!entry.window.isDestroyed()) entry.window.destroy()
}
