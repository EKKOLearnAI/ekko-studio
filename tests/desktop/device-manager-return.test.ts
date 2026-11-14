import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const fixture = { windows: [] as any[], handlers: new Map<string, (...args: any[]) => any>() }
async function mockElectron() {
  const { EventEmitter } = await import('node:events')
  class Contents extends EventEmitter {
    mainFrame = { url: 'https://fixture.invalid/chat' }
    loads: string[] = []
    destroyed = false
    session = { setPermissionRequestHandler() {} }
    loadURL(url: string) { this.mainFrame.url = url; this.loads.push(url); return Promise.resolve() }
    setWindowOpenHandler() {} insertCSS() { return Promise.resolve() }
    executeJavaScript() { return Promise.resolve({ ready: false }) }
    send() {} focus() {} isDestroyed() { return this.destroyed } close() { this.destroyed = true }
  }
  class Window extends EventEmitter {
    webContents = new Contents()
    destroyed = false
    visible = false
    contentView = { addChildView() {}, removeChildView() {} }
    constructor(readonly options = {}) { super(); fixture.windows.push(this) }
    getContentSize() { return [1200, 800] } isDestroyed() { return this.destroyed }
    show() { this.visible = true } hide() { this.visible = false } isVisible() { return this.visible } focus() {} setProgressBar() {} setTitle() {}
    close() {
      const event = { prevented: false, preventDefault() { this.prevented = true } }
      this.emit('close', event)
      if (!event.prevented) { this.destroyed = true; this.webContents.destroyed = true; this.emit('closed') }
    }
    destroy() { this.destroyed = true; this.emit('closed') }
  }
  class View {
    webContents = new Contents()
    setBackgroundColor() {} setVisible() {} setBounds() {}
  }
  return { app: { getLocale: () => 'en' }, BrowserWindow: Window, WebContentsView: View,
    ipcMain: { handle: (name: string, handler: (...args: any[]) => any) => fixture.handlers.set(name, handler), removeHandler: (name: string) => fixture.handlers.delete(name) } }
}

import type { NativeDeviceSwitcher as Switcher } from '../../packages/desktop/src/main/native-device-switcher'
let NativeDeviceSwitcher: typeof import('../../packages/desktop/src/main/native-device-switcher').NativeDeviceSwitcher
let BrowserWindow: Awaited<ReturnType<typeof mockElectron>>['BrowserWindow']
beforeAll(async () => {
  const desktopRequire = createRequire(resolve('packages/desktop/package.json'))
  let electronId = 'electron'
  try { electronId = desktopRequire.resolve('electron') } catch { /* Electron is optional for root-only test installs. */ }
  vi.doMock(electronId, mockElectron)
  BrowserWindow = (await import(electronId)).BrowserWindow
  NativeDeviceSwitcher = (await import('../../packages/desktop/src/main/native-device-switcher')).NativeDeviceSwitcher
})
import type { DesktopRemoteDevices } from '../../packages/desktop/src/main/remote-devices'

const controllers: Switcher[] = []
afterEach(() => { controllers.splice(0).forEach(controller => controller.dispose()); fixture.windows.length = 0; fixture.handlers.clear() })
function setup(switchTo = vi.fn(async () => 'focused')) {
  const main = new BrowserWindow()
  main.show()
  const devices = { state: () => ({ devices: [{ id: 'remote', name: 'Fixture', serverUrl: 'https://fixture.invalid' }], activeDeviceId: null, activeServerUrl: null }), switchTo }
  const controller = new NativeDeviceSwitcher(main as unknown as ConstructorParameters<typeof NativeDeviceSwitcher>[0], () => devices as unknown as DesktopRemoteDevices, 'darwin')
  controllers.push(controller)
  const event = (sender: any) => ({ sender, senderFrame: sender.mainFrame })
  const invoke = (name: string, sender: any, ...args: unknown[]) => fixture.handlers.get(`studio-native-devices:${name}`)!(event(sender), ...args)
  invoke('manage', controller.view.webContents)
  fixture.windows[1].emit('ready-to-show')
  return { main, controller, manager: fixture.windows[1], invoke, event, switchTo }
}

it('dismisses only the authenticated manager and keeps the original chat window', () => {
  const { main, manager, controller, invoke, switchTo } = setup()
  invoke('dismiss', manager.webContents)
  expect(manager.destroyed).toBe(true)
  expect(main.isDestroyed()).toBe(false)
  expect(main.isVisible()).toBe(true)
  expect(switchTo).not.toHaveBeenCalled()
  expect((main.webContents as any).loads).toEqual([])
  invoke('manage', controller.view.webContents)
  expect(fixture.windows).toHaveLength(3)
  expect(fixture.windows[2].options.parent).toBe(main)
})

it('keeps toolbar dismissal separate from closing the manager', () => {
  const { manager, controller, invoke } = setup()
  invoke('dismiss', controller.view.webContents)
  expect(manager.destroyed).toBe(false)
})

it('rejects a manager subframe or a different window as a dismissal sender', () => {
  const { manager } = setup()
  const handler = fixture.handlers.get('studio-native-devices:dismiss')!
  expect(() => handler({ sender: manager.webContents, senderFrame: { url: manager.webContents.mainFrame.url } })).toThrow()
  const other = new BrowserWindow()
  expect(() => handler({ sender: other.webContents, senderFrame: other.webContents.mainFrame })).toThrow()
  expect(manager.destroyed).toBe(false)
})

it('retains the native close guard while a confirmed switch is checking', async () => {
  let finish!: (value: string) => void
  const switchTo = vi.fn(() => new Promise<string>(resolve => { finish = resolve }))
  const { main, manager, invoke } = setup(switchTo)
  invoke('switch', manager.webContents, 'remote')
  const action = fixture.windows[2]
  expect(() => invoke('dismiss', action.webContents)).toThrow()
  const { operation } = invoke('state', action.webContents)
  const checking = invoke('confirm', action.webContents, operation.token)
  expect(switchTo).toHaveBeenCalledExactlyOnceWith('remote')
  invoke('dismiss', manager.webContents)
  expect(manager.destroyed).toBe(false)
  finish('focused'); await checking
  invoke('dismiss', manager.webContents)
  expect(manager.destroyed).toBe(true)
  expect(main.isDestroyed()).toBe(false)
})
