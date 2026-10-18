import { randomUUID } from 'node:crypto'
import { app, desktopCapturer, ipcMain, screen, systemPreferences, type BrowserWindow, type Display, type IpcMainEvent } from 'electron'
import { screenshotPixelRegion, type ScreenshotOverlayLabels } from './screenshot-overlay'
import { prepareScreenshotOverlays, prepareScreenshotImageEditor, type ScreenshotOverlayWindow } from './screenshot-windows'
import { screenshotBitmap } from './screenshot-bitmap'
import { screenshotEnvironment, waitForScreenshot, type ScreenshotCapabilities, type ScreenshotFrame } from './screenshot-platform'
import { capturePortalScreenshot, probeScreenshotPortal } from './screenshot-portal'

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
      !['select', 'rectangle', 'ellipse', 'arrow', 'pen', 'text', 'mosaic', 'undo', 'redo', 'color', 'lineWidth', 'textPlaceholder', 'zoomIn', 'zoomOut', 'fit', 'source'].includes(key)
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

export async function getScreenshotCapabilities(signal = new AbortController().signal): Promise<ScreenshotCapabilities> {
  const capabilities = screenshotEnvironment()
  if (capabilities.capture === 'portal-screenshot') {
    try { await probeScreenshotPortal(signal) }
    catch (error) {
      if (signal.aborted) throw error
      return { ...capabilities, capture: 'unavailable' }
    }
  }
  return capabilities
}

export async function captureRegionScreenshot(owner: BrowserWindow, request: ScreenshotRequest, studioWindows: BrowserWindow[], beforeHide?: () => void): Promise<ScreenshotResult | null> {
  if (activeCapture) throw new Error('SCREENSHOT_BUSY')
  checkScreenPermission()
  const controller = new AbortController()
  const signal = controller.signal
  let dismiss: (() => void) | null = null
  const cancel = () => { controller.abort(new Error('SCREENSHOT_CANCELLED')); dismiss?.() }
  let usesDesktopBounds = false
  const onDisplayMetricsChanged = (_event: unknown, _display: Display, metrics: string[]) => {
    if (usesDesktopBounds && metrics.some(metric => ['bounds', 'scaleFactor', 'rotation'].includes(metric))) cancel()
  }
  const onDisplayRemoved = () => { if (usesDesktopBounds) cancel() }
  activeCapture = { ownerId: owner.webContents.id, requestId: request.requestId, cancel }
  const hidden = new Map<BrowserWindow, number>()
  owner.once('closed', cancel)
  app.once('before-quit', cancel)
  screen.on('display-removed', onDisplayRemoved)
  screen.on('display-metrics-changed', onDisplayMetricsChanged)
  let entries: ScreenshotOverlayWindow[] = []
  try {
    if (request.hideWindows && !screenshotEnvironment().hideWindows) throw new Error('SCREENSHOT_HIDE_UNAVAILABLE')
    const capabilities = await getScreenshotCapabilities(signal)
    if (capabilities.capture === 'unavailable') throw new Error('SCREENSHOT_PORTAL_UNAVAILABLE')
    if (signal.aborted) return null
    const displays = screen.getAllDisplays()
    usesDesktopBounds = capabilities.presentation === 'desktop-overlay'
    if (usesDesktopBounds && !displays.length) throw new Error('SCREENSHOT_SOURCE_UNAVAILABLE')
    const preparing = usesDesktopBounds ? prepareScreenshotOverlays(displays) : prepareScreenshotImageEditor()
    void preparing.catch(() => undefined)
    if (request.hideWindows) {
      beforeHide?.()
      for (const window of new Set(studioWindows)) {
        if (window.isDestroyed() || !window.isVisible() || window.isMinimized()) continue
        hidden.set(window, window.getOpacity())
        window.setOpacity(0)
        window.hide()
      }
      if (hidden.size) {
        const rates = displays.map(display => display.displayFrequency).filter(rate => Number.isFinite(rate) && rate > 0)
        // Windows/macOS only. Linux has no validated compositor hiding strategy.
        const delay = Math.ceil(2000 / (rates.length ? Math.min(...rates) : 60))
        await waitForScreenshot(new Promise(resolve => setTimeout(resolve, delay)), signal)
      }
    }
    let frames: ScreenshotFrame[]
    if (capabilities.capture === 'portal-screenshot') {
      const frame = await capturePortalScreenshot(signal)
      if (!frame) return null
      frames = [frame]
    } else {
      const sources = await waitForScreenshot(desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: {
          width: Math.max(...displays.map(display => Math.ceil(display.size.width * display.scaleFactor))),
          height: Math.max(...displays.map(display => Math.ceil(display.size.height * display.scaleFactor))),
        },
      }), signal)
      checkScreenPermission()
      if (signal.aborted) return null
      const ids = sources.map(source => source.display_id)
      const mapped = sources.length === displays.length && ids.every(id => !!id && displays.some(display => String(display.id) === id)) && new Set(ids).size === ids.length
      usesDesktopBounds = usesDesktopBounds && mapped
      frames = sources.filter(source => !source.thumbnail.isEmpty()).map(source => {
        const display = usesDesktopBounds ? displays.find(display => String(display.id) === source.display_id) : undefined
        return {
          id: randomUUID(), bitmap: screenshotBitmap(source.thumbnail),
          ...(display ? { displayId: String(display.id), desktopBounds: display.bounds } : {}),
        }
      })
      if (!frames.length || (usesDesktopBounds && frames.length !== displays.length)) throw new Error('SCREENSHOT_SOURCE_UNAVAILABLE')
    }
    // An unmapped source is an independent image; never infer a monitor by name or order.
    entries = await waitForScreenshot(usesDesktopBounds ? preparing : prepareScreenshotImageEditor(), signal)
    if (signal.aborted) return null
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
      const fail = (reason: unknown) => finish(null, reason instanceof Error ? reason : new Error('SCREENSHOT_CAPTURE_FAILED', { cause: reason }))
      const trustedOverlay = (event: IpcMainEvent) => event.senderFrame === event.sender.mainFrame ? overlays.get(event.sender.id) : undefined
      const submit = (event: IpcMainEvent, value: unknown) => {
        const overlay = trustedOverlay(event)
        const payload = value as { requestId?: unknown; frameId?: unknown; region?: unknown; png?: unknown } | null
        if (!overlay || !payload || payload.requestId !== request.requestId) return
        try {
          const frame = frames.find(frame => frame.id === payload.frameId && (!usesDesktopBounds || frame.displayId === String(overlay.display?.id)))
          if (!frame) return
          // Both editors submit original image pixels, independent of DPI, zoom, or window size.
          const region = screenshotPixelRegion(payload.region, frame.bitmap, frame.bitmap)
          const size = screenshotPngSize(payload.png)
          if (size.width !== region.width || size.height !== region.height) return
          const png = Buffer.from(payload.png as Uint8Array)
          finish({ dataUrl: `data:image/png;base64,${png.toString('base64')}`, ...size })
        } catch { /* Malformed messages do not terminate a valid editor session. */ }
      }
      const onCancel = (event: IpcMainEvent) => { if (trustedOverlay(event)) finish(null) }
      const select = (event: IpcMainEvent) => {
        if (!trustedOverlay(event)) return
        try {
          for (const [id, entry] of overlays) if (id !== event.sender.id && !entry.window.isDestroyed()) entry.window.webContents.send('hermes-desktop:screenshot-overlay-reset')
        } catch (error) { fail(error) }
      }
      const ready = (event: IpcMainEvent, requestId: unknown) => {
        if (!trustedOverlay(event) || requestId !== request.requestId || settled || shown) return
        prepared.add(event.sender.id)
        if (prepared.size !== entries.length) return
        shown = true
        clearTimeout(loadTimeout)
        try {
          if (usesDesktopBounds) {
            const activeDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
            for (const entry of entries) entry.window.showInactive()
            entries.find(entry => entry.display?.id === activeDisplay.id)?.window.focus()
          } else entries[0].window.show()
        } catch (error) { fail(error) }
      }
      dismiss = () => finish(null)
      ipcMain.on('hermes-desktop:screenshot-overlay-submit', submit)
      ipcMain.on('hermes-desktop:screenshot-overlay-cancel', onCancel)
      ipcMain.on('hermes-desktop:screenshot-overlay-select', select)
      ipcMain.on('hermes-desktop:screenshot-overlay-ready', ready)
      try {
        for (const entry of entries) {
          entry.window.once('closed', closed)
          const frame = usesDesktopBounds ? frames.find(frame => frame.displayId === String(entry.display?.id))! : frames[0]
          entry.window.webContents.send('hermes-desktop:screenshot-overlay-init', {
            requestId: request.requestId, frameId: frame.id, bitmap: frame.bitmap,
            presentation: usesDesktopBounds ? 'desktop-overlay' : 'image-editor',
            initialSelection: frame.initialSelection, labels: request.labels,
            ...(!usesDesktopBounds && frames.length > 1 ? { frames } : {}),
          })
        }
      } catch (error) { fail(error) }
      if (signal.aborted) finish(null)
    })
  } catch (error) {
    if (signal.aborted) return null
    throw error
  } finally {
    activeCapture = null
    owner.removeListener('closed', cancel)
    app.removeListener('before-quit', cancel)
    screen.removeListener('display-removed', onDisplayRemoved)
    screen.removeListener('display-metrics-changed', onDisplayMetricsChanged)
    for (const entry of entries) if (!entry.window.isDestroyed()) {
      try {
        entry.window.hide()
        entry.window.webContents.send('hermes-desktop:screenshot-overlay-clear')
      } catch (error) {
        // An unusable overlay must not prevent restoring the chat windows below it.
        console.warn('[screenshot] could not clear overlay:', error)
        try { entry.window.destroy() } catch (error) { console.warn('[screenshot] could not dispose overlay:', error) }
      }
    }
    // Restore only windows actually changed, including if hiding failed partway through.
    for (const [window, opacity] of hidden) if (!window.isDestroyed()) {
      try { window.setOpacity(opacity) } catch (error) { console.warn('[screenshot] could not restore opacity:', error) }
      try { window.showInactive() } catch (error) { console.warn('[screenshot] could not restore window:', error) }
    }
    if (!owner.isDestroyed() && owner.isVisible() && !owner.isMinimized()) {
      try { owner.focus() } catch (error) { console.warn('[screenshot] could not restore focus:', error) }
    }
  }
}
