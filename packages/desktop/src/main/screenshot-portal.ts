import { randomUUID } from 'node:crypto'
import { open } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { nativeImage } from 'electron'
import type { Message, MessageBus } from 'dbus-next'
import { screenshotBitmap } from './screenshot-bitmap'
import { waitForScreenshot, type ScreenshotFrame } from './screenshot-platform'

const destination = 'org.freedesktop.portal.Desktop'
const path = '/org/freedesktop/portal/desktop'
const screenshotInterface = 'org.freedesktop.portal.Screenshot'
const requestInterface = 'org.freedesktop.portal.Request'
const maxBytes = 64 * 1024 * 1024

export interface PortalCapabilities { version: number; target?: 1 | 4 }

export function portalScreenshotTarget(version: number, targets?: number): PortalCapabilities {
  if (!Number.isInteger(version) || version < 1) throw new Error('SCREENSHOT_PORTAL_UNAVAILABLE')
  if (version < 3) return { version }
  if (targets && (targets & 4)) return { version, target: 4 }
  if (targets && (targets & 1)) return { version, target: 1 }
  throw new Error('SCREENSHOT_PORTAL_UNAVAILABLE')
}

async function withPortal<T>(signal: AbortSignal, operation: (bus: MessageBus, dbus: typeof import('dbus-next'), signal: AbortSignal) => Promise<T>): Promise<T> {
  const dbus = await import('dbus-next')
  if (signal.aborted) throw signal.reason
  const bus = dbus.sessionBus()
  const controller = new AbortController()
  const abort = () => controller.abort(signal.reason)
  signal.addEventListener('abort', abort, { once: true })
  // Keep the error listener until the disconnected socket is released.
  bus.on('error', () => controller.abort(new Error('SCREENSHOT_PORTAL_UNAVAILABLE')))
  try {
    if (!(bus as MessageBus & { name?: string }).name) {
      let connected!: () => void
      try {
        await waitForScreenshot(new Promise<void>(resolve => { connected = resolve; bus.once('connect', connected) }), controller.signal)
      } finally { bus.removeListener('connect', connected) }
    }
    return await operation(bus, dbus, controller.signal)
  } finally {
    signal.removeEventListener('abort', abort)
    bus.disconnect()
  }
}

async function properties(bus: MessageBus, dbus: typeof import('dbus-next'), signal: AbortSignal): Promise<PortalCapabilities> {
  const get = async (name: string) => {
    const reply = await waitForScreenshot(bus.call(new dbus.Message({ destination, path, interface: 'org.freedesktop.DBus.Properties', member: 'Get', signature: 'ss', body: [screenshotInterface, name] })), signal)
    return reply?.body[0]?.value
  }
  const version = await get('version')
  return portalScreenshotTarget(version, version >= 3 ? await get('AvailableTargets') : undefined)
}

export async function probeScreenshotPortal(signal = new AbortController().signal): Promise<PortalCapabilities> {
  return withPortal(signal, properties)
}

/** Only consume a URI supplied by the trusted system response, never a renderer path. */
export async function readPortalScreenshot(uri: unknown, signal: AbortSignal): Promise<ScreenshotFrame['bitmap']> {
  if (typeof uri !== 'string') throw new Error('SCREENSHOT_INVALID_IMAGE')
  const url = new URL(uri)
  if (url.protocol !== 'file:' || (url.hostname && url.hostname !== 'localhost') || url.search || url.hash) throw new Error('SCREENSHOT_INVALID_IMAGE')
  const file = await open(fileURLToPath(url), 'r')
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size < 24 || stat.size > maxBytes) throw new Error('SCREENSHOT_INVALID_IMAGE')
    // A bounded read also limits allocation if the file grows after stat().
    const bytes = Buffer.alloc(stat.size + 1)
    let length = 0
    while (length < bytes.length) {
      if (signal.aborted) throw signal.reason
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, null)
      if (!bytesRead) break
      length += bytesRead
    }
    if (length !== stat.size) throw new Error('SCREENSHOT_INVALID_IMAGE')
    const png = bytes.subarray(0, length)
    if (!png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || png.toString('ascii', 12, 16) !== 'IHDR') throw new Error('SCREENSHOT_INVALID_IMAGE')
    const width = png.readUInt32BE(16), height = png.readUInt32BE(20)
    if (!width || !height || width * height * 4 > maxBytes) throw new Error('SCREENSHOT_INVALID_IMAGE')
    const image = nativeImage.createFromBuffer(png)
    if (image.isEmpty()) throw new Error('SCREENSHOT_INVALID_IMAGE')
    const bitmap = screenshotBitmap(image)
    if (bitmap.width !== width || bitmap.height !== height) throw new Error('SCREENSHOT_INVALID_IMAGE')
    return bitmap
  } finally { await file.close() }
}

export async function capturePortalScreenshot(signal: AbortSignal): Promise<ScreenshotFrame | null> {
  return withPortal(signal, async (bus, dbus, localSignal) => {
    const capabilities = await properties(bus, dbus, localSignal)
    const sender = (bus as MessageBus & { name: string }).name
    if (!/^:[0-9]+\.[0-9]+$/.test(sender)) throw new Error('SCREENSHOT_PORTAL_UNAVAILABLE')
    const token = `studio_${randomUUID().replace(/-/g, '')}`
    const prefix = `${path}/request/${sender.slice(1).replace(/\./g, '_')}/`
    let handle = `${prefix}${token}`
    let returned = false
    let completed = false
    const early = new Map<string, Message>()
    const service = await waitForScreenshot(bus.call(new dbus.Message({ destination: 'org.freedesktop.DBus', path: '/org/freedesktop/DBus', interface: 'org.freedesktop.DBus', member: 'GetNameOwner', signature: 's', body: [destination] })), localSignal)
    const serviceOwner = service?.body[0]
    const rule = `type='signal',sender='${destination}',interface='${requestInterface}',member='Response',path_namespace='${prefix.slice(0, -1)}'`
    const match = (member: string) => bus.call(new dbus.Message({ destination: 'org.freedesktop.DBus', path: '/org/freedesktop/DBus', interface: 'org.freedesktop.DBus', member, signature: 's', body: [rule] }))
    let resolveResponse!: (message: Message) => void
    const response = new Promise<Message>(resolve => { resolveResponse = resolve })
    const listener = (message: Message) => {
      if (message.type !== dbus.MessageType.SIGNAL || message.sender !== serviceOwner || message.interface !== requestInterface || message.member !== 'Response' || !message.path.startsWith(prefix)) return
      if (!returned) { if (early.size < 8) early.set(message.path, message); return }
      if (message.path === handle) resolveResponse(message)
    }
    bus.on('message', listener)
    const close = () => {
      try { bus.send(new dbus.Message({ destination, path: handle, interface: requestInterface, member: 'Close', flags: dbus.MessageFlag.NO_REPLY_EXPECTED })) } catch { /* Connection may already have closed. */ }
    }
    try {
      // Install the match before Screenshot(), including responses arriving before its reply.
      await waitForScreenshot(match('AddMatch'), localSignal)
      const options: Record<string, InstanceType<typeof dbus.Variant>> = { handle_token: new dbus.Variant('s', token), modal: new dbus.Variant('b', false) }
      if (capabilities.version >= 2) options.interactive = new dbus.Variant('b', true)
      if (capabilities.target) options.target = new dbus.Variant('u', capabilities.target)
      // Electron does not export a valid Wayland xdg_foreign parent handle.
      const reply = await waitForScreenshot(bus.call(new dbus.Message({ destination, path, interface: screenshotInterface, member: 'Screenshot', signature: 'sa{sv}', body: ['', options] })), localSignal)
      const actual = reply?.body[0]
      if (typeof actual !== 'string' || !actual.startsWith(prefix) || !/^\w+$/.test(actual.slice(prefix.length))) throw new Error('SCREENSHOT_PORTAL_UNAVAILABLE')
      handle = actual
      returned = true
      if (early.has(handle)) resolveResponse(early.get(handle)!)
      const message = await waitForScreenshot(response, localSignal, 120_000)
      completed = true
      const [code, results] = message.body
      if (code === 1) return null
      if (code !== 0) throw new Error('SCREENSHOT_CAPTURE_FAILED')
      const bitmap = await waitForScreenshot(readPortalScreenshot(results?.uri?.value, localSignal), localSignal)
      return {
        id: token, bitmap,
        ...(capabilities.target !== 1 ? { initialSelection: { x: 0, y: 0, width: bitmap.width, height: bitmap.height } } : {}),
      }
    } finally {
      if (!completed) close()
      bus.removeListener('message', listener)
      // Disconnect removes the match even if the service disappears during cleanup.
      void match('RemoveMatch').catch(() => undefined)
      early.clear()
    }
  })
}
