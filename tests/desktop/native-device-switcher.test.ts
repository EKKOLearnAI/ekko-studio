import { beforeEach, describe, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => any>(), windows: [] as any[] }))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  class Contents extends EventEmitter {
    mainFrame = { url: '' }
    session = { setPermissionRequestHandler: vi.fn() }
    isDestroyed = vi.fn(() => false)
    close = vi.fn()
    insertCSS = vi.fn(async () => '')
    send = vi.fn()
    focus = vi.fn()
    getURL = vi.fn(() => 'data:text/html,splash')
    executeJavaScriptInIsolatedWorld = vi.fn(async () => null)
    setWindowOpenHandler = vi.fn()
    loadURL = vi.fn(async (url: string) => { this.mainFrame.url = url })
  }
  class Window extends EventEmitter {
    webContents = new Contents()
    contentView = { addChildView: vi.fn(), removeChildView: vi.fn() }
    getContentSize = () => [1000, 700]
    isDestroyed = () => false
    isVisible = () => true
    setProgressBar = vi.fn()
    setTitle = vi.fn()
    destroy = vi.fn(() => this.emit('closed'))
    close = vi.fn(() => {
      const event = { prevented: false, preventDefault() { this.prevented = true } }
      this.emit('close', event)
      if (!event.prevented) this.emit('closed')
    })
    hide = vi.fn()
    show = vi.fn()
    focus = vi.fn()
    constructor() { super();mock.windows.push(this) }
  }
  return {
    app: { getLocale: () => 'en' }, BrowserWindow: Window,
    WebContentsView: class { webContents = new Contents();setBackgroundColor = vi.fn();setBounds = vi.fn();setVisible = vi.fn() },
    ipcMain: { handle: (name: string, handler: (...args: any[]) => any) => mock.handlers.set(name, handler), removeHandler: (name: string) => mock.handlers.delete(name) },
  }
})
import { BrowserWindow } from 'electron'
import { NativeDeviceSwitcher, nativeDeviceSwitcherLayout } from '../../packages/desktop/src/main/native-device-switcher'
import type { DesktopRemoteDevices } from '../../packages/desktop/src/main/remote-devices'

beforeEach(() => { vi.clearAllMocks();mock.handlers.clear();mock.windows.length = 0 })
function setup(quitting: () => boolean = () => false) {
  const state = { devices: [{ id: 'home', name: 'Home', serverUrl: 'https://home.example.com' }, { id: 'office', name: 'Office', serverUrl: 'https://office.example.com' }], activeDeviceId: 'home', activeServerUrl: 'https://home.example.com' }
  const manager = { state: vi.fn(() => state), add: vi.fn(), remove: vi.fn(), openInNewInstance: vi.fn(async () => {}), switchTo: vi.fn(async () => {}) }
  const window = new BrowserWindow()
  const control = new NativeDeviceSwitcher(window, () => manager as unknown as DesktopRemoteDevices, 'win32', quitting)
  const contents = control.view.webContents
  const event = { sender: contents, senderFrame: contents.mainFrame }
  const fromWindow = (window: any) => ({ sender: window.webContents, senderFrame: window.webContents.mainFrame })
  const call = (method: string, from = event, input?: unknown) => mock.handlers.get(`studio-native-devices:${method}`)!(from, input)
  return { control, manager, window, event, fromWindow, call }
}

describe('desktop-owned native device switcher', () => {
  it('uses a compact control with an 8px header gap on every platform', () => {
    expect(nativeDeviceSwitcherLayout(1000, 'win32')).toEqual({ bounds: { x: 734, y: 0, width: 120, height: 40 }, inset: 266 })
    expect(nativeDeviceSwitcherLayout(1000, 'darwin')).toEqual({ bounds: { x: 872, y: 0, width: 120, height: 40 }, inset: 128 })
    expect(nativeDeviceSwitcherLayout(769, 'linux').bounds.x).toBe(503)
  })

  it('keeps the native menu independent and returns header space after dismissal', () => {
    const { control, window, call } = setup()
    expect(call('state').state.activeDeviceId).toBe('home')
    window.webContents.emit('dom-ready')
    expect(window.webContents.insertCSS).toHaveBeenCalledWith(expect.stringContaining('padding-right: 266px'))
    expect(control.view.webContents.setWindowOpenHandler).toHaveBeenCalled()
    control.setVisible(true);call('menu')
    expect(call('state').menuOpen).toBe(true)
    expect(control.view.setBounds).toHaveBeenLastCalledWith({ x: 630, y: 0, width: 224, height: 340 })
    window.webContents.emit('before-mouse-event', {}, { type: 'mouseDown' })
    expect(call('state').menuOpen).toBe(false)
    expect(control.view.setBounds).toHaveBeenLastCalledWith({ x: 734, y: 0, width: 120, height: 40 })
    control.dispose()
  })

  it.each(['remote page', 'foreign local view', 'subframe', 'navigated native view'])('denies native IPC from a %s', async kind => {
    const { control, call, event, window, manager } = setup()
    const bad = { ...event }
    if (kind === 'remote page') bad.sender = window.webContents
    if (kind === 'foreign local view') bad.sender = { ...event.sender } as any
    if (kind === 'subframe') bad.senderFrame = { ...event.senderFrame } as any
    if (kind === 'navigated native view') (event.senderFrame as any).url = 'https://remote.example.com'
    for (const method of ['state', 'menu', 'dismiss', 'manage', 'add', 'remove', 'switch', 'confirm', 'cancel']) await expect(Promise.resolve().then(() => call(method, bad))).rejects.toThrow('desktop-owned view')
    expect(manager.state).not.toHaveBeenCalled()
    control.dispose()
  })

  it('requires consent in the current action window and lets cancellation leave the connection unchanged', () => {
    const { control, call, event, manager, fromWindow } = setup()
    expect(() => call('add', event, {})).toThrow('local manager')
    control.openManager()
    const managerEvent = fromWindow(mock.windows[1])
    call('add', managerEvent, { name: 'Office', serverUrl: 'http://office' })
    expect(manager.add).toHaveBeenCalledWith({ name: 'Office', serverUrl: 'http://office' })
    call('switch', event, null)
    const operation = call('state').operation
    expect(operation.stage).toBe('confirm')
    expect(call('state').busy).toBe(false)
    expect(manager.switchTo).not.toHaveBeenCalled()
    expect(() => call('confirm', managerEvent, operation.token)).toThrow('current local action window')
    const actionEvent = fromWindow(mock.windows[2])
    expect(() => call('add', actionEvent, {})).toThrow('local manager')
    expect(() => call('remove', actionEvent, 'office')).toThrow('local manager')
    expect(() => call('confirm', actionEvent, 'stale-token')).toThrow('current local action window')
    call('cancel', actionEvent, operation.token)
    expect(call('state').operation).toBeNull()
    expect(manager.switchTo).not.toHaveBeenCalled()
    control.dispose()
  })

  it('shows checking until the request settles, blocks duplicates, and keeps restart feedback visible', async () => {
    const { control, call, manager, fromWindow, window } = setup()
    let finish!: () => void
    manager.switchTo.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
    call('switch', undefined, 'office')
    const actionEvent = fromWindow(mock.windows[1])
    const token = call('state').operation.token
    const request = call('confirm', actionEvent, token)
    expect(call('state')).toMatchObject({ busy: true, operation: { stage: 'checking', target: { id: 'office' }, startedAt: expect.any(Number) } })
    expect(window.setProgressBar).toHaveBeenCalledWith(2)
    expect(() => call('switch', undefined, null)).toThrow('BUSY')
    expect(() => call('cancel', actionEvent, token)).toThrow('BUSY')
    await expect(call('confirm', actionEvent, token)).rejects.toThrow('BUSY')
    mock.windows[1].close()
    expect(call('state').operation.stage).toBe('checking')
    finish();await request
    expect(call('state')).toMatchObject({ busy: true, operation: { stage: 'restarting' } })
    expect(manager.switchTo).toHaveBeenCalledExactlyOnceWith('office')
    control.dispose()
  })

  it('allows application shutdown to close a checking window', async () => {
    let quitting = false, finish!: () => void
    const { control, call, manager, fromWindow } = setup(() => quitting)
    manager.switchTo.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
    call('switch', undefined, 'office')
    const action = mock.windows[1]
    const request = call('confirm', fromWindow(action), call('state').operation.token)
    quitting = true;action.close()
    expect(call('state').operation.stage).toBe('checking')
    expect(() => call('confirm', fromWindow(action), 'stale')).toThrow('desktop-owned view')
    control.dispose();finish();await request
  })

  it('shows connection failures in the same window and allows a successful retry', async () => {
    const { control, call, manager, fromWindow, window } = setup()
    manager.switchTo.mockRejectedValueOnce(new Error('REMOTE_DEVICE_UNREACHABLE'))
    call('switch', undefined, null)
    const actionEvent = fromWindow(mock.windows[1]), token = call('state').operation.token
    await call('confirm', actionEvent, token)
    expect(call('state')).toMatchObject({ busy: false, operation: { stage: 'error', error: 'REMOTE_DEVICE_UNREACHABLE' } })
    expect(window.setProgressBar).toHaveBeenLastCalledWith(-1)
    await call('confirm', actionEvent, token)
    expect(call('state')).toMatchObject({ busy: true, operation: { stage: 'restarting' } })
    control.dispose()
  })

  it('uses local confirmation for deletion and protects the active device', async () => {
    const { control, call, manager, fromWindow } = setup()
    control.openManager();const managerEvent = fromWindow(mock.windows[1])
    expect(() => call('remove', managerEvent, 'home')).toThrow('ACTIVE')
    call('remove', managerEvent, 'office')
    expect(manager.remove).not.toHaveBeenCalled()
    await call('confirm', fromWindow(mock.windows[2]), call('state').operation.token)
    expect(manager.remove).toHaveBeenCalledExactlyOnceWith('office')
    expect(call('state').operation).toBeNull()
    control.dispose()
  })

  it('hides the splash while keeping stalled reload and recovery controls available', () => {
    const { control, window, call } = setup()
    expect(control.view.setVisible).toHaveBeenLastCalledWith(false)
    call('menu');expect(call('state').menuOpen).toBe(false)
    control.setVisible(true);call('menu')
    window.webContents.emit('did-start-navigation', {}, 'https://offline.example.com', false, true)
    expect(control.view.setVisible).toHaveBeenLastCalledWith(true)
    expect(call('state').menuOpen).toBe(false)
    window.webContents.emit('did-start-navigation', {}, 'data:text/html,splash', false, true)
    expect(control.view.setVisible).toHaveBeenLastCalledWith(false)
    control.setVisible(true)
    control.dispose()
    expect(mock.handlers.size).toBe(0)
    expect(window.contentView.removeChildView).toHaveBeenCalledWith(control.view)
    expect(control.view.webContents.close).toHaveBeenCalledOnce()
  })
})

it('closes successful new-instance confirmation and allows another launch', async () => {
  const { control, manager, call, fromWindow } = setup()
  for (let index = 0; index < 2; index++) {
    call('switch', undefined, 'office')
    const action = mock.windows.at(-1)
    const token = call('state').operation.token
    await mock.handlers.get('studio-native-devices:confirm')!(fromWindow(action), token, 'new')
    expect(call('state').operation).toBeNull()
    expect(call('state').busy).toBe(false)
  }
  for (const action of mock.windows.slice(1)) {
    expect(action.hide).toHaveBeenCalled()
    expect(action.hide.mock.invocationCallOrder[0]).toBeLessThan(action.close.mock.invocationCallOrder[0])
  }
  expect(manager.openInNewInstance).toHaveBeenCalledTimes(2)
  expect(manager.switchTo).not.toHaveBeenCalled()
  control.dispose()
})
