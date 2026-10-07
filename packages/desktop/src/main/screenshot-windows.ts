import { BrowserWindow, screen, type Display } from 'electron'
import { join } from 'node:path'
import { screenshotOverlayHtml } from './screenshot-overlay'
import { screenshotEnvironment } from './screenshot-platform'

export interface ScreenshotOverlayWindow {
  window: BrowserWindow
  display?: Display
  mode: 'desktop-overlay' | 'image-editor'
  loaded: Promise<void>
}

const windows = new Map<number, ScreenshotOverlayWindow>()
let imageEditor: ScreenshotOverlayWindow | undefined

function loadEditor(window: BrowserWindow) {
  window.setMenu(null)
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', event => event.preventDefault())
  window.webContents.on('render-process-gone', () => { if (!window.isDestroyed()) window.destroy() })
  const loaded = window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(screenshotOverlayHtml())}`)
  void loaded.catch(() => { if (!window.isDestroyed()) window.destroy() })
  return loaded
}

const webPreferences = () => ({
  preload: join(__dirname, '../preload/screenshot-overlay.js'),
  contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false,
})

export async function prepareScreenshotImageEditor(): Promise<ScreenshotOverlayWindow[]> {
  if (!imageEditor || imageEditor.window.isDestroyed()) {
    const window = new BrowserWindow({
      width: 1000, height: 740, minWidth: 600, minHeight: 480, show: false,
      title: 'Ekko Studio',
      useContentSize: true, autoHideMenuBar: true, backgroundColor: '#181b22',
      webPreferences: webPreferences(),
    })
    // Closing this editor is cancellation; the next request creates a fresh window.
    window.once('closed', () => { if (imageEditor?.window === window) imageEditor = undefined })
    imageEditor = { window, loaded: loadEditor(window), mode: 'image-editor' }
  }
  const entry = imageEditor
  await entry.loaded
  return [entry]
}

export function warmScreenshotEditor() {
  return screenshotEnvironment().presentation === 'desktop-overlay' ? prepareScreenshotOverlays() : prepareScreenshotImageEditor()
}

/** Preload the small editor document. Screenshots are supplied only for an active request. */
export async function prepareScreenshotOverlays(displays = screen.getAllDisplays()): Promise<ScreenshotOverlayWindow[]> {
  for (const [id, entry] of windows) {
    const display = displays.find(item => item.id === id)
    if (!display || JSON.stringify(display.bounds) !== JSON.stringify(entry.display!.bounds) || display.scaleFactor !== entry.display!.scaleFactor) {
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
      webPreferences: webPreferences(),
    })
    window.setAlwaysOnTop(true, 'screen-saver')
    // macOS's default process-type transformation briefly hides every app window and the Dock.
    if (process.platform === 'darwin') window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
    else if (process.platform === 'linux') window.setVisibleOnAllWorkspaces(true)
    window.once('closed', () => { if (windows.get(display.id)?.window === window) windows.delete(display.id) })
    const loaded = loadEditor(window)
    const entry: ScreenshotOverlayWindow = { window, display, loaded, mode: 'desktop-overlay' }
    windows.set(display.id, entry)
    return entry
  })
  await Promise.all(entries.map(entry => entry.loaded))
  return entries
}

export function disposeScreenshotOverlays() {
  const entries = [...windows.values()]
  if (imageEditor) entries.push(imageEditor)
  imageEditor = undefined
  windows.clear()
  for (const entry of entries) if (!entry.window.isDestroyed()) entry.window.destroy()
}
