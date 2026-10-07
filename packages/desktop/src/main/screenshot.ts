import { desktopCapturer, ipcMain, screen, systemPreferences, type BrowserWindow, type Display, type IpcMainEvent } from 'electron'
import { screenshotPixelRegion, type ScreenshotOverlayLabels } from './screenshot-overlay'
import { prepareScreenshotOverlays, type ScreenshotOverlayWindow } from './screenshot-windows'
import { screenshotBitmap } from './screenshot-bitmap'

interface ScreenshotResult { dataUrl: string; width: number; height: number }
interface ScreenshotRequest { requestId: string; hideWindows?: boolean; labels: ScreenshotOverlayLabels }
let activeCapture: { ownerId: number; requestId: string; cancel: () => void } | null = null

function checkScreenPermission() {
  if (process.platform !== 'darwin') return
  const status = systemPreferences.getMediaAccessStatus('screen')
  if (status === 'denied' || status === 'restricted') throw new Error('SCREENSHOT_PERMISSION_DENIED')
}

export function parseScreenshotRequest(value: unknown): ScreenshotRequest {
  const request = value as ScreenshotRequest | null
  if (!request || typeof request.requestId !== 'string' || request.requestId.length > 100 || !request.requestId
    || (request.hideWindows !== undefined && typeof request.hideWindows !== 'boolean')
    || !request.labels || !['hint', 'confirm', 'cancel', 'reset'].every(key => {
      const label = request.labels[key as 'hint' | 'confirm' | 'cancel' | 'reset']
      return typeof label === 'string' && label.length > 0 && label.length <= 300
    }) || (request.labels.tools && Object.entries(request.labels.tools).some(([key, label]) =>
      !['select', 'rectangle', 'ellipse', 'arrow', 'pen', 'text', 'mosaic', 'undo', 'redo', 'color', 'lineWidth', 'textPlaceholder'].includes(key)
      || typeof label !== 'string' || !label || label.length > 300))) throw new Error('Invalid screenshot request')
  return { ...request, hideWindows: request.hideWindows === true }
}

export function cancelRegionScreenshot(ownerId: number, requestId: string): boolean {
  if (activeCapture?.ownerId !== ownerId || activeCapture.requestId !== requestId) return false
  activeCapture.cancel()
  return true
}

/** Accept only PNGs with exactly the expected crop dimensions, without decoding/re-encoding them. */
export function screenshotPngSize(value: unknown): { width: number; height: number } {
  if (!(value instanceof Uint8Array) || value.byteLength < 24 || value.byteLength > 64 * 1024 * 1024) throw new Error('SCREENSHOT_INVALID_IMAGE')
  const png = Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  if (!png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || png.toString('ascii', 12, 16) !== 'IHDR') throw new Error('SCREENSHOT_INVALID_IMAGE')
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
}

export async function captureRegionScreenshot(owner: BrowserWindow, request: ScreenshotRequest, studioWindows: BrowserWindow[]): Promise<ScreenshotResult | null> {
  if (activeCapture) throw new Error('SCREENSHOT_BUSY')
  checkScreenPermission()
  let cancelled = false
  let dismiss: (() => void) | null = null
  const cancel = () => { cancelled = true; dismiss?.() }
  const onDisplayMetricsChanged = (_event: unknown, _display: Display, metrics: string[]) => {
    if (metrics.some(metric => ['bounds', 'scaleFactor', 'rotation'].includes(metric))) cancel()
  }
  activeCapture = { ownerId: owner.webContents.id, requestId: request.requestId, cancel }
  const hiddenWindows = request.hideWindows === true ? studioWindows.filter(window => !window.isDestroyed() && window.isVisible()) : []
  const opacities = new Map<BrowserWindow, number>()
  owner.once('closed', cancel)
  screen.on('display-removed', cancel)
  screen.on('display-metrics-changed', onDisplayMetricsChanged)
  let entries: ScreenshotOverlayWindow[] = []
  try {
    const displays = screen.getAllDisplays()
    if (!displays.length) throw new Error('SCREENSHOT_SOURCE_UNAVAILABLE')
    const preparing = prepareScreenshotOverlays(displays)
    // Start window preparation in parallel; its rejection is handled below even if capture fails.
    void preparing.catch(() => undefined)
    if (hiddenWindows.length) {
      for (const window of hiddenWindows) {
        opacities.set(window, window.getOpacity())
        // Native hide animations can remain in screen captures after isVisible() becomes false.
        window.setOpacity(0)
        window.hide()
      }
      const refreshRates = displays.map(display => display.displayFrequency).filter(rate => Number.isFinite(rate) && rate > 0)
      // Let the compositor publish the opacity change on even the slowest connected display.
      const frameDelay = Math.ceil(2000 / (refreshRates.length ? Math.min(...refreshRates) : 60))
      await new Promise(resolve => setTimeout(resolve, frameDelay))
    }
    if (cancelled) return null
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: Math.max(...displays.map(display => Math.ceil(display.size.width * display.scaleFactor))),
        height: Math.max(...displays.map(display => Math.ceil(display.size.height * display.scaleFactor))),
      },
    })
    checkScreenPermission()
    if (cancelled) return null
    const captures = displays.map(display => {
      const source = sources.find(item => item.display_id === String(display.id))
        || (displays.length === 1 && sources.length === 1 ? sources[0] : undefined)
      if (!source || source.thumbnail.isEmpty()) throw new Error('SCREENSHOT_SOURCE_UNAVAILABLE')
      const bitmap = screenshotBitmap(source.thumbnail)
      return { display, bitmap, size: { width: bitmap.width, height: bitmap.height } }
    })
    entries = await preparing
    if (cancelled) return null
    return await new Promise<ScreenshotResult | null>((resolve, reject) => {
      const overlays = new Map(entries.map(entry => [entry.window.webContents.id, entry]))
      const prepared = new Set<number>()
      let settled = false
      let shown = false
      const loadTimeout = setTimeout(() => finish(null, new Error('SCREENSHOT_CAPTURE_FAILED')), 10_000)
      const closed = () => finish(null)
      const finish = (result: ScreenshotResult | null, error?: Error) => {
        if (settled) return
        settled = true
        clearTimeout(loadTimeout)
        ipcMain.removeListener('hermes-desktop:screenshot-overlay-submit', submit)
        ipcMain.removeListener('hermes-desktop:screenshot-overlay-cancel', onCancel)
        ipcMain.removeListener('hermes-desktop:screenshot-overlay-select', select)
        ipcMain.removeListener('hermes-desktop:screenshot-overlay-ready', ready)
        for (const entry of entries) entry.window.removeListener('closed', closed)
        dismiss = null
        error ? reject(error) : resolve(result)
      }
      const trustedOverlay = (event: IpcMainEvent) => event.senderFrame === event.sender.mainFrame ? overlays.get(event.sender.id) : undefined
      const submit = (event: IpcMainEvent, value: unknown) => {
        const overlay = trustedOverlay(event)
        const payload = value as { requestId?: unknown; region?: unknown; png?: unknown } | null
        if (!overlay || !payload || payload.requestId !== request.requestId) return
        try {
          const capture = captures.find(item => item.display.id === overlay.display.id)!
          const region = screenshotPixelRegion(payload.region, overlay.display.bounds, capture.size)
          const size = screenshotPngSize(payload.png)
          if (size.width !== region.width || size.height !== region.height) return
          const png = Buffer.from(payload.png as Uint8Array)
          finish({ dataUrl: `data:image/png;base64,${png.toString('base64')}`, ...size })
        } catch {
          // Ignore malformed payloads; the editor remains available for a valid region or Esc.
        }
      }
      const onCancel = (event: IpcMainEvent) => { if (trustedOverlay(event)) finish(null) }
      const select = (event: IpcMainEvent) => {
        if (!trustedOverlay(event)) return
        for (const [id, entry] of overlays) if (id !== event.sender.id && !entry.window.isDestroyed()) entry.window.webContents.send('hermes-desktop:screenshot-overlay-reset')
      }
      const ready = (event: IpcMainEvent, requestId: unknown) => {
        if (!trustedOverlay(event) || requestId !== request.requestId || settled || shown) return
        prepared.add(event.sender.id)
        if (prepared.size !== entries.length) return
        shown = true
        clearTimeout(loadTimeout)
        const activeDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
        for (const entry of entries) entry.window.showInactive()
        entries.find(entry => entry.display.id === activeDisplay.id)?.window.focus()
      }
      dismiss = () => finish(null)
      ipcMain.on('hermes-desktop:screenshot-overlay-submit', submit)
      ipcMain.on('hermes-desktop:screenshot-overlay-cancel', onCancel)
      ipcMain.on('hermes-desktop:screenshot-overlay-select', select)
      ipcMain.on('hermes-desktop:screenshot-overlay-ready', ready)
      for (const entry of entries) {
        entry.window.once('closed', closed)
        const capture = captures.find(item => item.display.id === entry.display.id)!
        entry.window.webContents.send('hermes-desktop:screenshot-overlay-init', { requestId: request.requestId, bitmap: capture.bitmap, labels: request.labels })
      }
    })
  } finally {
    activeCapture = null
    owner.removeListener('closed', cancel)
    screen.removeListener('display-removed', cancel)
    screen.removeListener('display-metrics-changed', onDisplayMetricsChanged)
    // Hide without destroying Chromium; also release the previous screenshot's renderer memory.
    for (const entry of entries) if (!entry.window.isDestroyed()) {
      entry.window.hide()
      entry.window.webContents.send('hermes-desktop:screenshot-overlay-clear')
    }
    for (const window of hiddenWindows) if (!window.isDestroyed()) {
      const opacity = opacities.get(window)
      if (opacity !== undefined) window.setOpacity(opacity)
      window.showInactive()
    }
    if (!owner.isDestroyed()) owner.focus()
  }
}
