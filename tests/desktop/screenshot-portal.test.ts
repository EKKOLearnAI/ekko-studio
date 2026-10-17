import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ version: 3, targets: 5, bus: undefined as any, uri: '', code: 0, early: true, changedHandle: false, screenshot: vi.fn() }))

vi.mock('dbus-next', async () => {
  const { EventEmitter } = await import('node:events')
  class Message { constructor(value: unknown) { Object.assign(this, value) } }
  class Variant { constructor(public signature: string, public value: unknown) {} }
  return {
    Message, Variant, MessageType: { SIGNAL: 4 }, MessageFlag: { NO_REPLY_EXPECTED: 1 },
    sessionBus: () => {
      const bus = Object.assign(new EventEmitter(), {
        name: ':1.42', disconnect: vi.fn(), send: vi.fn(),
        call: vi.fn(async (message: any) => {
          if (message.member === 'Get') return { body: [{ value: message.body[1] === 'version' ? state.version : state.targets }] }
          if (message.member === 'GetNameOwner') return { body: [':1.5'] }
          if (message.member === 'Screenshot') {
            state.screenshot(message)
            const handle = `/org/freedesktop/portal/desktop/request/1_42/${state.changedHandle ? 'actual_handle' : message.body[1].handle_token.value}`
            if (state.early) bus.emit('message', { type: 4, sender: ':1.5', interface: 'org.freedesktop.portal.Request', member: 'Response', path: handle, body: [state.code, { uri: new Variant('s', state.uri) }] })
            return { body: [handle] }
          }
          return { body: [] }
        }),
      })
      state.bus = bus
      return bus
    },
  }
})
vi.mock('electron', () => ({ nativeImage: {
  createFromBuffer: (value: Buffer) => {
    const width = value.readUInt32BE(16), height = value.readUInt32BE(20)
    return { isEmpty: () => false, getScaleFactors: () => [1], getSize: () => ({ width, height }), toBitmap: () => Buffer.from(Array.from({ length: width * height }, () => [149, 83, 17, 255]).flat()) }
  },
} }))

import { capturePortalScreenshot, probeScreenshotPortal, readPortalScreenshot } from '../../packages/desktop/src/main/screenshot-portal'

let directory: string
function png(width = 2, height = 1) {
  const value = Buffer.alloc(24)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(value)
  value.write('IHDR', 12)
  value.writeUInt32BE(width, 16)
  value.writeUInt32BE(height, 20)
  return value
}
beforeEach(async () => {
  vi.useFakeTimers()
  state.version = 3; state.targets = 5; state.code = 0; state.early = true; state.changedHandle = false
  state.screenshot.mockReset()
  state.bus = undefined
  directory = await mkdtemp(join(tmpdir(), 'studio-portal-'))
  const file = join(directory, '截图 with space.png')
  await writeFile(file, png())
  state.uri = pathToFileURL(file).href
})
afterEach(async () => { vi.useRealTimers(); await rm(directory, { recursive: true, force: true }) })

describe('Screenshot Portal lifecycle', () => {
  it.each([false, true])('subscribes before capture and handles an early response (changed handle: %s)', async changed => {
    state.changedHandle = changed
    const frame = await capturePortalScreenshot(new AbortController().signal)
    expect(frame).toMatchObject({ bitmap: { width: 2, height: 1 }, initialSelection: { x: 0, y: 0, width: 2, height: 1 } })
    const calls = state.bus.call.mock.calls.map(([message]: any[]) => message.member)
    expect(calls.indexOf('AddMatch')).toBeLessThan(calls.indexOf('Screenshot'))
    expect(state.screenshot.mock.calls[0][0].body).toMatchObject(['', { target: { value: 4 } }])
    expect(state.bus.disconnect).toHaveBeenCalledOnce()
    expect(state.bus.listenerCount('message')).toBe(0)
    expect(state.bus.send).not.toHaveBeenCalled()
  })
  it.each([1, 2])('does not send v3 target to v%s', async version => {
    state.version = version
    const frame = await capturePortalScreenshot(new AbortController().signal)
    const options = state.screenshot.mock.calls[0][0].body[1]
    expect(options.target).toBeUndefined()
    expect(options.interactive?.value).toBe(version === 2 ? true : undefined)
    expect(frame?.initialSelection).toMatchObject({ width: 2, height: 1 })
  })
  it('leaves a Screen result unselected for Studio region selection', async () => {
    state.targets = 1
    expect((await capturePortalScreenshot(new AbortController().signal))?.initialSelection).toBeUndefined()
    expect(state.screenshot.mock.calls[0][0].body[1].target.value).toBe(1)
  })
  it('returns null for system cancellation and treats other response codes as failures', async () => {
    state.code = 1
    await expect(capturePortalScreenshot(new AbortController().signal)).resolves.toBeNull()
    state.code = 2
    await expect(capturePortalScreenshot(new AbortController().signal)).rejects.toThrow('SCREENSHOT_CAPTURE_FAILED')
  })
  it('closes and settles locally on cancel without expecting a Response signal', async () => {
    state.early = false
    const controller = new AbortController()
    const capture = capturePortalScreenshot(controller.signal)
    const assertion = expect(capture).rejects.toThrow('cancelled')
    await vi.waitFor(() => expect(state.screenshot).toHaveBeenCalled())
    controller.abort(new Error('cancelled'))
    await assertion
    expect(state.bus.send).toHaveBeenCalledWith(expect.objectContaining({ member: 'Close', flags: 1 }))
    expect(state.bus.disconnect).toHaveBeenCalledOnce()
    expect(state.bus.listenerCount('message')).toBe(0)
  })
  it('allows 120 seconds for system interaction and then closes the request', async () => {
    state.early = false
    const capture = capturePortalScreenshot(new AbortController().signal)
    const assertion = expect(capture).rejects.toThrow('SCREENSHOT_TIMEOUT')
    await vi.waitFor(() => expect(state.screenshot).toHaveBeenCalled())
    await vi.advanceTimersByTimeAsync(10_001)
    expect(state.bus.disconnect).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(110_000)
    await assertion
    expect(state.bus.send).toHaveBeenCalledWith(expect.objectContaining({ member: 'Close' }))
  })
  it('does not invoke Screenshot when the backend offers no Area or Screen target', async () => {
    state.targets = 2
    await expect(probeScreenshotPortal()).rejects.toThrow('SCREENSHOT_PORTAL_UNAVAILABLE')
    expect(state.screenshot).not.toHaveBeenCalled()
  })
  it('ignores responses from another sender or request', async () => {
    state.early = false
    const controller = new AbortController()
    const capture = capturePortalScreenshot(controller.signal)
    await vi.waitFor(() => expect(state.screenshot).toHaveBeenCalled())
    const handle = state.bus.call.mock.calls.find(([message]: any[]) => message.member === 'Screenshot')[0].body[1].handle_token.value
    const message = { type: 4, sender: ':1.5', interface: 'org.freedesktop.portal.Request', member: 'Response', path: `/org/freedesktop/portal/desktop/request/1_42/${handle}`, body: [0, { uri: { value: state.uri } }] }
    state.bus.emit('message', { ...message, sender: ':1.6' })
    state.bus.emit('message', { ...message, path: `${message.path}_other` })
    expect(state.bus.disconnect).not.toHaveBeenCalled()
    state.bus.emit('message', message)
    await expect(capture).resolves.toMatchObject({ bitmap: { width: 2 } })
  })
  it('reads local encoded paths, rejects remote URIs and oversized images, and preserves the portal file', async () => {
    const signal = new AbortController().signal
    await expect(readPortalScreenshot(state.uri, signal)).resolves.toMatchObject({ width: 2, height: 1 })
    for (const uri of ['https://example.com/image.png', 'file://remote/tmp/image.png', 'file:///tmp/image.png?query']) await expect(readPortalScreenshot(uri, signal)).rejects.toThrow('SCREENSHOT_INVALID_IMAGE')
    const huge = join(directory, 'huge.png')
    await writeFile(huge, png(100_000, 100_000))
    await expect(readPortalScreenshot(pathToFileURL(huge).href, signal)).rejects.toThrow('SCREENSHOT_INVALID_IMAGE')
    await expect(readPortalScreenshot(state.uri, signal)).resolves.toMatchObject({ width: 2 })
  })
})
