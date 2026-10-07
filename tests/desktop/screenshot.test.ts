import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { screenshotPixelRegion, screenshotOverlayHtml } from '../../packages/desktop/src/main/screenshot-overlay'

const state = vi.hoisted(() => ({
  overlays: [] as any[],
  getSources: vi.fn(),
  getDisplays: vi.fn(),
  permission: vi.fn(() => 'granted'),
  load: vi.fn(),
}))

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  class Overlay extends EventEmitter {
    destroyed = false
    webContents = Object.assign(new EventEmitter(), {
      id: 100 + state.overlays.length,
      mainFrame: {},
      send: vi.fn(),
      setWindowOpenHandler: vi.fn(),
    })
    constructor(public options: unknown) { super(); state.overlays.push(this) }
    setAlwaysOnTop = vi.fn()
    setVisibleOnAllWorkspaces = vi.fn()
    setMenu = vi.fn()
    loadURL = state.load
    showInactive = vi.fn()
    hide = vi.fn()
    focus = vi.fn()
    isDestroyed = () => this.destroyed
    destroy = () => { this.destroyed = true; this.emit('closed') }
  }
  return {
    BrowserWindow: Overlay,
    nativeImage: { createFromBuffer: () => ({ toBitmap: () => Buffer.from([149, 83, 17, 255]) }) },
    desktopCapturer: { getSources: state.getSources },
    ipcMain: new EventEmitter(),
    systemPreferences: { getMediaAccessStatus: state.permission },
    screen: Object.assign(new EventEmitter(), {
      getAllDisplays: state.getDisplays,
      getDisplayNearestPoint: () => ({ id: 2 }),
      getCursorScreenPoint: () => ({ x: -400, y: 200 }),
    }),
  }
})

import { ipcMain, screen } from 'electron'
import { cancelRegionScreenshot, captureRegionScreenshot, parseScreenshotRequest, screenshotPngSize } from '../../packages/desktop/src/main/screenshot'
import { disposeScreenshotOverlays } from '../../packages/desktop/src/main/screenshot-windows'
import { screenshotBitmap } from '../../packages/desktop/src/main/screenshot-bitmap'

const labels = { hint: 'Drag', confirm: 'Confirm', cancel: 'Cancel', reset: 'Reselect' }
const request = { requestId: 'capture-1', labels }

function owner() {
  return Object.assign(new EventEmitter(), {
    webContents: { id: 1 }, isDestroyed: () => false, isVisible: () => true,
    hide: vi.fn(), showInactive: vi.fn(), focus: vi.fn(),
    getOpacity: vi.fn(() => 0.85), setOpacity: vi.fn(),
  }) as unknown as BrowserWindow
}

function image(width: number, height: number) {
  return {
    isEmpty: () => false, toPNG: vi.fn(() => png(width, height)), toBitmap: () => Buffer.alloc(width * height * 4),
    toDataURL: () => 'data:image/png;base64,aW1hZ2U=', getSize: () => ({ width, height }), getScaleFactors: () => [1],
    crop: vi.fn((region: { width: number; height: number }) => image(region.width, region.height)),
  }
}

function png(width: number, height: number) {
  const value = Buffer.alloc(24)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(value)
  value.write('IHDR', 12)
  value.writeUInt32BE(width, 16)
  value.writeUInt32BE(height, 20)
  return value
}

async function openCapture(hideWindows = false) {
  const window = owner()
  const result = captureRegionScreenshot(window, { ...request, hideWindows }, [window])
  await vi.advanceTimersByTimeAsync(34)
  for (const overlay of state.overlays) emit('hermes-desktop:screenshot-overlay-ready', overlay, request.requestId)
  return { window, result }
}

function emit(channel: string, overlay: any, region?: unknown, frame = overlay.webContents.mainFrame) {
  ipcMain.emit(channel, { sender: overlay.webContents, senderFrame: frame }, region)
}

beforeEach(() => {
  vi.useFakeTimers()
  state.overlays.length = 0
  state.permission.mockReturnValue('granted')
  state.load.mockResolvedValue(undefined)
  state.getDisplays.mockReturnValue([
    { id: 1, bounds: { x: 0, y: 0, width: 1440, height: 900 }, size: { width: 1440, height: 900 }, scaleFactor: 2 },
    { id: 2, bounds: { x: -1920, y: 0, width: 1920, height: 1080 }, size: { width: 1920, height: 1080 }, scaleFactor: 1 },
  ])
  state.getSources.mockResolvedValue([
    { display_id: '1', thumbnail: image(2880, 1800) },
    { display_id: '2', thumbnail: image(1920, 1080) },
  ])
})

afterEach(() => {
  cancelRegionScreenshot(1, request.requestId)
  disposeScreenshotOverlays()
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('desktop region screenshots', () => {
  it('maps Retina coordinates and clamps right/bottom to bitmap edges', () => {
    expect(screenshotPixelRegion({ x: 10.5, y: 20.5, width: 100, height: 80 }, { width: 1440, height: 900 }, { width: 2880, height: 1800 }))
      .toEqual({ x: 21, y: 41, width: 200, height: 160 })
    expect(screenshotPixelRegion({ x: 1400, y: 880, width: 500, height: 500 }, { width: 1440, height: 900 }, { width: 2880, height: 1800 }))
      .toEqual({ x: 2800, y: 1760, width: 80, height: 40 })
  })

  it.each([null, {}, { x: NaN, y: 0, width: 1, height: 1 }, { x: -1, y: 0, width: 1, height: 1 }, { x: 0, y: 0, width: 0, height: 1 }])('rejects invalid crop %j', region => {
    expect(() => screenshotPixelRegion(region, { width: 100, height: 100 }, { width: 200, height: 200 })).toThrow('SCREENSHOT_INVALID_REGION')
  })

  it('hides Studio, opens both displays, crops a confirmed region, and restores Studio', async () => {
    const { window, result } = await openCapture(true)
    expect(window.hide).toHaveBeenCalledOnce()
    expect(window.setOpacity).toHaveBeenNthCalledWith(1, 0)
    expect(vi.mocked(window.setOpacity).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(window.hide).mock.invocationCallOrder[0])
    expect(state.overlays).toHaveLength(2)
    expect(state.overlays[1].options.x).toBe(-1920)
    expect(state.overlays[1].focus).toHaveBeenCalledOnce()
    expect(state.overlays[0].options.webPreferences).toMatchObject({ sandbox: true, nodeIntegration: false, contextIsolation: true })
    const sources = await state.getSources.mock.results[0].value
    for (const source of sources) expect(source.thumbnail.toPNG).not.toHaveBeenCalled()
    expect(state.overlays[0].webContents.send).toHaveBeenCalledWith('hermes-desktop:screenshot-overlay-init', expect.objectContaining({ bitmap: expect.objectContaining({ width: 2880, height: 1800 }), requestId: request.requestId }))
    emit('hermes-desktop:screenshot-overlay-submit', state.overlays[0], { requestId: request.requestId, region: { x: 10, y: 20, width: 100, height: 80 }, png: png(200, 160) })
    await expect(result).resolves.toMatchObject({ width: 200, height: 160, dataUrl: expect.stringMatching(/^data:image\/png/) })
    expect(state.overlays.every(overlay => !overlay.destroyed)).toBe(true)
    expect(state.overlays[0].hide).toHaveBeenCalledOnce()
    expect(state.overlays[0].webContents.send).toHaveBeenCalledWith('hermes-desktop:screenshot-overlay-clear')
    expect(state.overlays[0].setVisibleOnAllWorkspaces).toHaveBeenCalledWith(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
    expect(window.showInactive).toHaveBeenCalledOnce()
    expect(window.setOpacity).toHaveBeenNthCalledWith(2, 0.85)
    expect(vi.mocked(window.setOpacity).mock.invocationCallOrder[1]).toBeLessThan(vi.mocked(window.showInactive).mock.invocationCallOrder[0])
    expect(window.focus).toHaveBeenCalledOnce()
    expect(ipcMain.listenerCount('hermes-desktop:screenshot-overlay-submit')).toBe(0)
  })

  it('keeps Studio visible by default without hiding or showing its windows', async () => {
    const window = owner()
    const result = captureRegionScreenshot(window, request, [window])
    await vi.advanceTimersByTimeAsync(0)
    expect(state.getSources).toHaveBeenCalledOnce()
    expect(window.hide).not.toHaveBeenCalled()
    expect(window.getOpacity).not.toHaveBeenCalled()
    expect(window.setOpacity).not.toHaveBeenCalled()
    cancelRegionScreenshot(1, request.requestId)
    await expect(result).resolves.toBeNull()
    expect(window.showInactive).not.toHaveBeenCalled()
    expect(window.focus).toHaveBeenCalledOnce()
  })

  it('waits for two compositor frames on a 30Hz display before capturing', async () => {
    for (const display of state.getDisplays()) display.displayFrequency = 30
    const window = owner()
    const result = captureRegionScreenshot(window, { ...request, hideWindows: true }, [window])
    await vi.advanceTimersByTimeAsync(66)
    expect(state.getSources).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(state.getSources).toHaveBeenCalledOnce()
    cancelRegionScreenshot(1, request.requestId)
    await expect(result).resolves.toBeNull()
    expect(window.setOpacity).toHaveBeenLastCalledWith(0.85)
  })

  it('restores opacity when cancelled during the compositor wait and does not take a screenshot', async () => {
    const window = owner()
    const result = captureRegionScreenshot(window, { ...request, hideWindows: true }, [window])
    expect(window.setOpacity).toHaveBeenLastCalledWith(0)
    cancelRegionScreenshot(1, request.requestId)
    await vi.advanceTimersByTimeAsync(34)
    await expect(result).resolves.toBeNull()
    expect(state.getSources).not.toHaveBeenCalled()
    expect(window.setOpacity).toHaveBeenLastCalledWith(0.85)
    expect(window.showInactive).toHaveBeenCalledOnce()
  })

  it('ignores other senders, subframes, and invalid selections', async () => {
    const { result } = await openCapture()
    emit('hermes-desktop:screenshot-overlay-cancel', { webContents: { id: 999, mainFrame: {} } })
    emit('hermes-desktop:screenshot-overlay-cancel', state.overlays[0], undefined, {})
    emit('hermes-desktop:screenshot-overlay-submit', state.overlays[0], { x: -1, y: 0, width: 1, height: 1 })
    emit('hermes-desktop:screenshot-overlay-submit', state.overlays[0], { requestId: 'old-capture', region: { x: 0, y: 0, width: 100, height: 80 }, png: png(200, 160) })
    emit('hermes-desktop:screenshot-overlay-submit', state.overlays[0], { requestId: request.requestId, region: { x: 0, y: 0, width: 100, height: 80 }, png: png(500, 500) })
    expect(state.overlays[0].destroyed).toBe(false)
    emit('hermes-desktop:screenshot-overlay-cancel', state.overlays[0])
    await expect(result).resolves.toBeNull()
  })

  it('resets the other display when selecting on a new display', async () => {
    const { result } = await openCapture()
    emit('hermes-desktop:screenshot-overlay-select', state.overlays[1])
    expect(state.overlays[0].webContents.send).toHaveBeenCalledWith('hermes-desktop:screenshot-overlay-reset')
    expect(state.overlays[1].webContents.send).not.toHaveBeenCalledWith('hermes-desktop:screenshot-overlay-reset')
    emit('hermes-desktop:screenshot-overlay-cancel', state.overlays[1])
    await expect(result).resolves.toBeNull()
  })

  it('cancels only the matching request and restores Studio without a screenshot', async () => {
    const { window, result } = await openCapture(true)
    expect(cancelRegionScreenshot(999, request.requestId)).toBe(false)
    expect(cancelRegionScreenshot(1, 'old-request')).toBe(false)
    expect(cancelRegionScreenshot(1, request.requestId)).toBe(true)
    await expect(result).resolves.toBeNull()
    expect(window.showInactive).toHaveBeenCalledOnce()
    expect(window.setOpacity).toHaveBeenLastCalledWith(0.85)
  })

  it('restores Studio when screen capture fails', async () => {
    state.getSources.mockRejectedValueOnce(new Error('capture failure'))
    const window = owner()
    const result = captureRegionScreenshot(window, { ...request, hideWindows: true }, [window])
    const rejection = expect(result).rejects.toThrow('capture failure')
    await vi.advanceTimersByTimeAsync(34)
    await rejection
    expect(window.showInactive).toHaveBeenCalledOnce()
    expect(window.setOpacity).toHaveBeenLastCalledWith(0.85)
  })

  it('cleans up overlays when their renderer exits', async () => {
    const { result } = await openCapture()
    state.overlays[0].webContents.emit('render-process-gone')
    await expect(result).resolves.toBeNull()
    expect(state.overlays[0].destroyed).toBe(true)
    expect(state.overlays[1].hide).toHaveBeenCalledOnce()
  })

  it('ignores work-area changes but cancels when display geometry changes', async () => {
    const { result } = await openCapture()
    ;(screen as unknown as EventEmitter).emit('display-metrics-changed', {}, {}, ['workArea'])
    expect(state.overlays[0].destroyed).toBe(false)
    ;(screen as unknown as EventEmitter).emit('display-metrics-changed', {}, {}, ['scaleFactor'])
    await expect(result).resolves.toBeNull()
  })

  it('does not allow overlapping capture operations', async () => {
    const { window, result } = await openCapture()
    await expect(captureRegionScreenshot(window, { ...request, requestId: 'second' }, [window])).rejects.toThrow('SCREENSHOT_BUSY')
    cancelRegionScreenshot(1, request.requestId)
    await expect(result).resolves.toBeNull()
  })

  it('reuses warmed windows and never loads screenshot data into their document URLs', async () => {
    const first = await openCapture()
    cancelRegionScreenshot(1, request.requestId)
    await first.result
    const second = await openCapture()
    expect(state.overlays).toHaveLength(2)
    expect(state.load).toHaveBeenCalledTimes(2)
    expect(state.load.mock.calls.every(([url]) => !String(url).includes('data%3Aimage%2Fpng%3Bbase64'))).toBe(true)
    cancelRegionScreenshot(1, request.requestId)
    await second.result
  })

  it('validates PNG dimensions before accepting an annotated crop', () => {
    expect(screenshotPngSize(png(350, 240))).toEqual({ width: 350, height: 240 })
    expect(() => screenshotPngSize(Buffer.from('not a PNG'))).toThrow('SCREENSHOT_INVALID_IMAGE')
  })

  it('converts native pixels losslessly, restores alpha, and rejects invalid bitmap dimensions', () => {
    const source = { getScaleFactors: () => [1], getSize: vi.fn(() => ({ width: 3, height: 1 })), toBitmap: vi.fn(() => Buffer.from([149, 83, 17, 255, 30, 20, 10, 128, 0, 0, 0, 0])) }
    const bitmap = screenshotBitmap(source as any)
    expect(bitmap).toMatchObject({ width: 3, height: 1 })
    expect(Array.from(bitmap.data)).toEqual([17, 83, 149, 255, 20, 40, 60, 128, 0, 0, 0, 0])
    expect(source.getSize).toHaveBeenCalledWith(1)
    expect(source.toBitmap).toHaveBeenCalledWith({ scaleFactor: 1 })
    source.getSize.mockReturnValue({ width: 4, height: 1 })
    expect(() => screenshotBitmap(source as any)).toThrow('SCREENSHOT_INVALID_IMAGE')
  })

  it.each([2, 1.5, 1.25])('keeps native pixels when Electron returns DIP dimensions at scale %s', scaleFactor => {
    const source = {
      getScaleFactors: () => [1, scaleFactor],
      getSize: vi.fn(() => ({ width: Math.floor(647 / scaleFactor), height: Math.floor(483 / scaleFactor) })),
      toBitmap: vi.fn(() => Buffer.alloc(647 * 483 * 4)),
    }
    expect(screenshotBitmap(source as any)).toMatchObject({ width: 647, height: 483 })
    expect(source.getSize).toHaveBeenCalledWith(scaleFactor)
    expect(source.toBitmap).toHaveBeenCalledWith({ scaleFactor })
  })

  it('validates labels and prevents injected HTML from ending the overlay script', () => {
    expect(parseScreenshotRequest(request).hideWindows).toBe(false)
    expect(parseScreenshotRequest({ ...request, hideWindows: true }).hideWindows).toBe(true)
    expect(() => parseScreenshotRequest({ ...request, hideWindows: 'true' })).toThrow('Invalid screenshot request')
    expect(() => parseScreenshotRequest({ requestId: 'test', labels: {} })).toThrow('Invalid screenshot request')
    const html = screenshotOverlayHtml('data:image/png;base64,aA==', { ...labels, hint: '</script><img src=x>' })
    expect(html).not.toContain('</script><img src=x>')
    expect(html).toContain('\\u003c/script>')
  })
})
