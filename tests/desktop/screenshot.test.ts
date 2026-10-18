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
  portal: vi.fn(),
  probePortal: vi.fn(),
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
    setBounds = vi.fn()
    loadURL = state.load
    showInactive = vi.fn()
    show = vi.fn()
    hide = vi.fn()
    focus = vi.fn()
    isDestroyed = () => this.destroyed
    destroy = () => { this.destroyed = true; this.emit('closed') }
  }
  return {
    app: Object.assign(new EventEmitter(), { commandLine: { getSwitchValue: () => '' } }),
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

vi.mock('../../packages/desktop/src/main/screenshot-portal', () => ({
  capturePortalScreenshot: state.portal,
  probeScreenshotPortal: state.probePortal,
}))

import { app, ipcMain, screen } from 'electron'
import { cancelRegionScreenshot, captureRegionScreenshot, getScreenshotCapabilities, parseScreenshotRequest, screenshotPngSize } from '../../packages/desktop/src/main/screenshot'
import { disposeScreenshotOverlays } from '../../packages/desktop/src/main/screenshot-windows'
import { screenshotBitmap } from '../../packages/desktop/src/main/screenshot-bitmap'

const labels = { hint: 'Drag', confirm: 'Confirm', cancel: 'Cancel', reset: 'Reselect' }
const request = { requestId: 'capture-1', labels }

function owner() {
  return Object.assign(new EventEmitter(), {
    webContents: { id: 1 }, isDestroyed: () => false, isVisible: () => true,
    isMinimized: vi.fn(() => false),
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
  if (channel === 'hermes-desktop:screenshot-overlay-submit' && region && typeof region === 'object') {
    const init = overlay.webContents.send.mock.calls.find(([name]: string[]) => name === 'hermes-desktop:screenshot-overlay-init')?.[1]
    region = { frameId: init?.frameId, ...region }
  }
  ipcMain.emit(channel, { sender: overlay.webContents, senderFrame: frame }, region)
}

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
function platform(value: string) { Object.defineProperty(process, 'platform', { ...platformDescriptor, value }) }

beforeEach(() => {
  platform('darwin')
  vi.useFakeTimers()
  state.overlays.length = 0
  state.permission.mockReturnValue('granted')
  state.load.mockResolvedValue(undefined)
  state.probePortal.mockResolvedValue({ version: 2 })
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
  Object.defineProperty(process, 'platform', platformDescriptor)
  vi.unstubAllEnvs()
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
    emit('hermes-desktop:screenshot-overlay-submit', state.overlays[0], { requestId: request.requestId, region: { x: 20, y: 40, width: 200, height: 160 }, png: png(200, 160) })
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
    await vi.advanceTimersByTimeAsync(0)
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

  it.each(['showInactive', 'focus'])('contains an overlay %s failure in the IPC callback and permits retry', async method => {
    const window = owner()
    const result = captureRegionScreenshot(window, { ...request, hideWindows: true }, [window])
    const rejected = expect(result).rejects.toThrow('native window unavailable')
    await vi.advanceTimersByTimeAsync(34)
    const overlay = state.overlays[method === 'focus' ? 1 : 0]
    overlay[method].mockImplementationOnce(() => { throw new Error('native window unavailable') })
    for (const entry of state.overlays) {
      expect(() => emit('hermes-desktop:screenshot-overlay-ready', entry, request.requestId)).not.toThrow()
    }
    await rejected
    expect(window.setOpacity).toHaveBeenLastCalledWith(0.85)
    expect(window.showInactive).toHaveBeenCalledOnce()
    expect(ipcMain.listenerCount('hermes-desktop:screenshot-overlay-ready')).toBe(0)
    const retry = await openCapture()
    cancelRegionScreenshot(1, request.requestId)
    await expect(retry.result).resolves.toBeNull()
  })

  it('releases capture IPC listeners when sending the editor initialization fails', async () => {
    state.load.mockImplementationOnce(() => {
      state.overlays[0].webContents.send.mockImplementationOnce(() => { throw new Error('renderer unavailable') })
      return Promise.resolve()
    })
    const window = owner()
    const result = captureRegionScreenshot(window, { ...request, hideWindows: true }, [window])
    const rejected = expect(result).rejects.toThrow('renderer unavailable')
    await vi.advanceTimersByTimeAsync(34)
    await rejected
    for (const channel of ['submit', 'cancel', 'select', 'ready']) {
      expect(ipcMain.listenerCount(`hermes-desktop:screenshot-overlay-${channel}`)).toBe(0)
    }
    expect(window.setOpacity).toHaveBeenLastCalledWith(0.85)
    expect(window.showInactive).toHaveBeenCalledOnce()
    const retry = await openCapture()
    cancelRegionScreenshot(1, request.requestId)
    await expect(retry.result).resolves.toBeNull()
  })

  it('contains a reset IPC failure from a second overlay', async () => {
    const { window, result } = await openCapture(true)
    const rejected = expect(result).rejects.toThrow('renderer unavailable')
    state.overlays[1].webContents.send.mockImplementationOnce(() => { throw new Error('renderer unavailable') })
    expect(() => emit('hermes-desktop:screenshot-overlay-select', state.overlays[0])).not.toThrow()
    await rejected
    expect(window.showInactive).toHaveBeenCalledOnce()
    expect(ipcMain.listenerCount('hermes-desktop:screenshot-overlay-select')).toBe(0)
  })

  it.each(['hide', 'clear'])('restores Studio and disposes a broken overlay when cleanup %s fails', async operation => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const { window, result } = await openCapture(true)
      const broken = state.overlays[0]
      const method = operation === 'hide' ? broken.hide : broken.webContents.send
      method.mockImplementationOnce(() => { throw new Error('native cleanup failure') })
      cancelRegionScreenshot(1, request.requestId)
      await expect(result).resolves.toBeNull()
      expect(broken.destroyed).toBe(true)
      expect(state.overlays[1].hide).toHaveBeenCalledOnce()
      expect(window.setOpacity).toHaveBeenLastCalledWith(0.85)
      expect(window.showInactive).toHaveBeenCalledOnce()
      const retry = await openCapture()
      cancelRegionScreenshot(1, request.requestId)
      await expect(retry.result).resolves.toBeNull()
    } finally { warning.mockRestore() }
  })

  it('restores Studio even when both hiding and destroying an overlay fail', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { window, result } = await openCapture(true)
    const destroy = vi.spyOn(state.overlays[0], 'destroy').mockImplementationOnce(() => { throw new Error('destroy failure') })
    try {
      state.overlays[0].hide.mockImplementationOnce(() => { throw new Error('hide failure') })
      cancelRegionScreenshot(1, request.requestId)
      await expect(result).resolves.toBeNull()
      expect(state.overlays[1].hide).toHaveBeenCalledOnce()
      expect(window.setOpacity).toHaveBeenLastCalledWith(0.85)
      expect(window.showInactive).toHaveBeenCalledOnce()
    } finally { destroy.mockRestore(); warning.mockRestore() }
  })

  it('preserves a successful capture when restoring owner focus fails', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const { window, result } = await openCapture(true)
      vi.mocked(window.focus).mockImplementationOnce(() => { throw new Error('focus failure') })
      emit('hermes-desktop:screenshot-overlay-submit', state.overlays[0], { requestId: request.requestId, region: { x: 0, y: 0, width: 20, height: 10 }, png: png(20, 10) })
      await expect(result).resolves.toMatchObject({ width: 20, height: 10 })
      expect(window.showInactive).toHaveBeenCalledOnce()
    } finally { warning.mockRestore() }
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
    const beforeHide = vi.fn()
    await expect(captureRegionScreenshot(window, { ...request, requestId: 'second', hideWindows: true }, [window], beforeHide)).rejects.toThrow('SCREENSHOT_BUSY')
    expect(beforeHide).not.toHaveBeenCalled()
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

  it('uses Windows window options and preserves hidden or minimized Studio windows', async () => {
    platform('win32')
    const window = owner(), minimized = owner(), invisible = owner()
    vi.mocked(minimized.isMinimized).mockReturnValue(true)
    invisible.isVisible = () => false
    const result = captureRegionScreenshot(window, { ...request, hideWindows: true }, [window, window, minimized, invisible])
    await vi.advanceTimersByTimeAsync(34)
    expect(window.hide).toHaveBeenCalledOnce()
    expect(minimized.hide).not.toHaveBeenCalled()
    expect(invisible.hide).not.toHaveBeenCalled()
    for (const entry of state.overlays) {
      expect(entry.options.type).toBeUndefined()
      expect(entry.options).toMatchObject({ thickFrame: false, roundedCorners: false, useContentSize: true })
      expect(entry.setVisibleOnAllWorkspaces).not.toHaveBeenCalled()
    }
    cancelRegionScreenshot(1, request.requestId)
    await expect(result).resolves.toBeNull()
    expect(minimized.showInactive).not.toHaveBeenCalled()
    expect(invisible.showInactive).not.toHaveBeenCalled()
  })

  it('covers each complete Windows display in DIP, including the taskbar and mixed-DPI negative origins, on every capture', async () => {
    platform('win32')
    const displays = state.getDisplays()
    displays[0].scaleFactor = 1.25
    displays[0].workArea = { x: 0, y: 0, width: 1440, height: 852 }
    displays[1].scaleFactor = 1.5
    displays[1].workArea = { x: -1880, y: 0, width: 1880, height: 1080 }
    const first = await openCapture()
    for (const [index, overlay] of state.overlays.entries()) {
      expect(overlay.setBounds).toHaveBeenCalledWith(displays[index].bounds, false)
      expect(overlay.setBounds.mock.invocationCallOrder[0]).toBeGreaterThan(state.load.mock.invocationCallOrder[index])
      expect(overlay.setBounds.mock.invocationCallOrder[0]).toBeLessThan(overlay.showInactive.mock.invocationCallOrder[0])
    }
    cancelRegionScreenshot(1, request.requestId)
    await first.result
    const second = await openCapture()
    expect(state.overlays).toHaveLength(2)
    for (const [index, overlay] of state.overlays.entries()) {
      expect(overlay.setBounds).toHaveBeenCalledTimes(2)
      expect(overlay.setBounds).toHaveBeenLastCalledWith(displays[index].bounds, false)
    }
    cancelRegionScreenshot(1, request.requestId)
    await second.result
  })

  it('edits unmapped sources as independent images, with no guessed desktop bounds', async () => {
    const sources = [{ display_id: '', thumbnail: image(800, 600) }, { display_id: '', thumbnail: image(640, 480) }]
    state.getSources.mockResolvedValueOnce(sources)
    const { result } = await openCapture()
    const editor = state.overlays.at(-1)
    const init = editor.webContents.send.mock.calls.find(([name]: string[]) => name === 'hermes-desktop:screenshot-overlay-init')[1]
    expect(init.presentation).toBe('image-editor')
    expect(init.frames).toHaveLength(2)
    expect(init.frames.every((frame: any) => !frame.desktopBounds && !frame.displayId)).toBe(true)
    expect(editor.show).toHaveBeenCalledOnce()
    ;(screen as unknown as EventEmitter).emit('display-removed')
    ;(screen as unknown as EventEmitter).emit('display-metrics-changed', {}, {}, ['bounds'])
    emit('hermes-desktop:screenshot-overlay-submit', editor, { requestId: request.requestId, frameId: init.frames[1].id, region: { x: 20, y: 30, width: 200, height: 100 }, png: png(200, 100) })
    await expect(result).resolves.toMatchObject({ width: 200, height: 100 })
  })

  it('cancels a hung native capture promptly and ignores its late result', async () => {
    let resolve!: (sources: unknown[]) => void
    state.getSources.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    const window = owner()
    const result = captureRegionScreenshot(window, request, [window])
    await vi.advanceTimersByTimeAsync(0)
    cancelRegionScreenshot(1, request.requestId)
    await expect(result).resolves.toBeNull()
    resolve([{ display_id: '1', thumbnail: image(800, 600) }])
    await vi.advanceTimersByTimeAsync(0)
    expect(state.overlays.every(entry => !entry.webContents.send.mock.calls.length)).toBe(true)
  })

  it('times out native capture and restores opacity without waiting for the callback', async () => {
    state.getSources.mockImplementationOnce(() => new Promise(() => {}))
    const window = owner()
    const result = captureRegionScreenshot(window, { ...request, hideWindows: true }, [window])
    const rejected = expect(result).rejects.toThrow('SCREENSHOT_TIMEOUT')
    await vi.advanceTimersByTimeAsync(10_034)
    await rejected
    expect(window.setOpacity).toHaveBeenLastCalledWith(0.85)
    expect(window.showInactive).toHaveBeenCalledOnce()
    expect(app.listenerCount('before-quit')).toBe(0)
  })

  it('blocks Linux hidden capture explicitly, without opacity calls or normal capture fallback', async () => {
    platform('linux')
    vi.stubEnv('XDG_SESSION_TYPE', 'x11')
    vi.stubEnv('DISPLAY', ':0')
    vi.stubEnv('WAYLAND_DISPLAY', '')
    const window = owner()
    const beforeHide = vi.fn()
    await expect(captureRegionScreenshot(window, { ...request, hideWindows: true }, [window], beforeHide)).rejects.toThrow('SCREENSHOT_HIDE_UNAVAILABLE')
    expect(beforeHide).not.toHaveBeenCalled()
    expect(state.getSources).not.toHaveBeenCalled()
    expect(window.setOpacity).not.toHaveBeenCalled()
    expect(window.hide).not.toHaveBeenCalled()
    const { result } = await openCapture()
    expect(state.getSources).toHaveBeenCalledOnce()
    cancelRegionScreenshot(1, request.requestId)
    await expect(result).resolves.toBeNull()
  })

  it('uses a Portal image in Wayland even when DISPLAY is present', async () => {
    platform('linux')
    vi.stubEnv('XDG_SESSION_TYPE', 'wayland')
    vi.stubEnv('DISPLAY', ':0')
    state.portal.mockResolvedValueOnce({ id: 'portal-frame', bitmap: { width: 20, height: 10, data: new Uint8Array(800) }, initialSelection: { x: 0, y: 0, width: 20, height: 10 } })
    const { window, result } = await openCapture()
    expect(state.getSources).not.toHaveBeenCalled()
    expect(window.hide).not.toHaveBeenCalled()
    const editor = state.overlays[0]
    expect(editor.options.frame).not.toBe(false)
    const init = editor.webContents.send.mock.calls[0][1]
    expect(init).toMatchObject({ presentation: 'image-editor', frameId: 'portal-frame', initialSelection: { width: 20, height: 10 } })
    emit('hermes-desktop:screenshot-overlay-submit', editor, { requestId: request.requestId, frameId: 'foreign-frame', region: { x: 0, y: 0, width: 20, height: 10 }, png: png(20, 10) })
    expect(editor.hide).not.toHaveBeenCalled()
    emit('hermes-desktop:screenshot-overlay-submit', editor, { requestId: request.requestId, region: { x: 0, y: 0, width: 20, height: 10 }, png: png(20, 10) })
    await expect(result).resolves.toMatchObject({ width: 20, height: 10 })
  })

  it('reports an unavailable Portal and releases the active request for a retry', async () => {
    platform('linux')
    vi.stubEnv('XDG_SESSION_TYPE', 'wayland')
    state.probePortal.mockRejectedValue(new Error('No portal'))
    expect(await getScreenshotCapabilities()).toMatchObject({ capture: 'unavailable', hideWindows: false })
    const window = owner()
    await expect(captureRegionScreenshot(window, request, [window])).rejects.toThrow('SCREENSHOT_PORTAL_UNAVAILABLE')
    await expect(captureRegionScreenshot(window, request, [window])).rejects.toThrow('SCREENSHOT_PORTAL_UNAVAILABLE')
    state.probePortal.mockResolvedValue({ version: 2 })
  })

  it('cancels Portal interaction when the owner closes and ignores a late frame', async () => {
    platform('linux')
    vi.stubEnv('XDG_SESSION_TYPE', 'wayland')
    state.portal.mockImplementationOnce((signal: AbortSignal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })))
    const window = owner()
    const result = captureRegionScreenshot(window, request, [window])
    await vi.advanceTimersByTimeAsync(0)
    window.emit('closed')
    await expect(result).resolves.toBeNull()
    expect(state.overlays[0].show).not.toHaveBeenCalled()
    expect(state.overlays[0].webContents.send).not.toHaveBeenCalled()
  })

  it('cancels an active editor when the app quits and restores hidden windows', async () => {
    const { window, result } = await openCapture(true)
    app.emit('before-quit')
    await expect(result).resolves.toBeNull()
    expect(window.setOpacity).toHaveBeenLastCalledWith(0.85)
    expect(window.showInactive).toHaveBeenCalledOnce()
    expect(app.listenerCount('before-quit')).toBe(0)
  })
})
