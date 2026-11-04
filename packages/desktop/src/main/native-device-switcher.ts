import { BrowserWindow, WebContentsView, ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { DesktopRemoteDevices, DesktopRemoteDevicesState } from './remote-devices'
import { nativeDeviceLabels, defaultNativeDeviceLocale, normalizeNativeDeviceLocale } from './native-device-messages'
import { nativeDeviceHtml } from './native-device-html'
import { readNativeDeviceAppearance } from './native-device-appearance'

const WIDTH = 120
const HEIGHT = 40
const GAP = 8
const CHANNELS = ['state', 'menu', 'dismiss', 'manage', 'add', 'remove', 'switch', 'confirm', 'cancel'] as const
const channel = (name: typeof CHANNELS[number]) => `studio-native-devices:${name}`

export function nativeDeviceSwitcherLayout(width: number, platform: NodeJS.Platform) {
  const controls = platform === 'darwin' ? 0 : 138
  return {
    bounds: { x: Math.max(0, width - controls - GAP - WIDTH), y: 0, width: WIDTH, height: HEIGHT },
    inset: controls + GAP + WIDTH,
  }
}

interface DeviceOperation {
  token: string
  kind: 'switch' | 'remove'
  target: { id: string | null; name: string; serverUrl: string | null }
  stage: 'confirm' | 'checking' | 'restarting' | 'error'
  startedAt: number | null
  error: string | null
}

export class NativeDeviceSwitcher {
  readonly view: WebContentsView
  private manager: BrowserWindow | null = null
  private actionWindow: BrowserWindow | null = null
  private operation: DeviceOperation | null = null
  private readonly documents = new Map<WebContents, string>()
  private locale = defaultNativeDeviceLocale()
  private visible = false
  private menuOpen = false
  private appearance: ReturnType<typeof readNativeDeviceAppearance> | null = null
  private readingAppearance = false
  private navigationEpoch = 0
  private loading = false
  private readonly appearanceTimer: ReturnType<typeof setInterval>
  private readonly closeMenu = () => { if (this.menuOpen) { this.menuOpen = false;this.layout();this.refresh() } }
  private readonly outsideClick = (_event: unknown, mouse: { type: string }) => { if (mouse.type === 'mouseDown') this.closeMenu() }
  private readonly navigate = (_event: unknown, url: string, inPlace: boolean, mainFrame: boolean) => {
    if (!mainFrame || inPlace) return
    this.navigationEpoch++;this.loading = true;this.closeMenu()
    // Keep recovery available during a stalled remote reload. Only desktop
    // startup/shutdown documents hide an already visible control.
    if (!/^https?:/.test(url)) this.setVisible(false)
  }
  private readonly ready = () => { this.loading = false;void this.syncAppearance() }
  private busy = false
  private disposed = false
  private readonly mainContents: WebContents
  private readonly resize = () => { this.closeMenu();this.layout() }
  private readonly style = () => {
    const { inset } = nativeDeviceSwitcherLayout(this.window.getContentSize()[0], this.platform)
    // Reserve the native view even in an older remote UI. The control itself is
    // a separate WebContentsView, so page reloads and crashes cannot remove it.
    void this.window.webContents.insertCSS(`#app .studio-page-header { padding-right: ${inset}px; --studio-header-controls-gap: 8px; box-sizing: border-box; } #app .studio-page-header > header { padding-right: 8px; } #app .studio-page-header::after { content: ''; position: fixed; top: 0; right: ${this.platform === 'darwin' ? GAP : 138 + GAP}px; width: ${WIDTH}px; height: ${HEIGHT}px; -webkit-app-region: no-drag; }`).catch(() => undefined)
  }

  constructor(private readonly window: BrowserWindow, private readonly devices: () => DesktopRemoteDevices, private readonly platform: NodeJS.Platform = process.platform, private readonly quitting: () => boolean = () => false) {
    this.mainContents = window.webContents
    const preferences = this.preferences()
    this.view = new WebContentsView({ webPreferences: preferences })
    this.view.setBackgroundColor('#00000000')
    this.window.contentView.addChildView(this.view)
    this.load(this.view.webContents, 'button')
    this.view.setVisible(false)
    this.layout()
    this.window.on('resize', this.resize)
    this.mainContents.on('dom-ready', this.style)
    this.mainContents.on('did-finish-load', this.ready)
    this.mainContents.on('did-start-navigation', this.navigate)
    this.mainContents.on('before-mouse-event', this.outsideClick)
    this.window.on('blur', this.closeMenu)
    this.appearanceTimer = setInterval(() => { void this.syncAppearance() }, 350)
    this.appearanceTimer.unref?.()
    this.window.once('closed', () => this.dispose())

    ipcMain.handle(channel('state'), event => {
      this.authorize(event)
      let state: DesktopRemoteDevicesState
      let failed = false
      try { state = this.devices().state() } catch { state = { devices: [], activeDeviceId: null, activeServerUrl: null };failed = true }
      return { state, labels: nativeDeviceLabels(this.locale), locale: this.locale, busy: this.busy, failed, menuOpen: this.menuOpen, appearance: this.appearance, operation: this.operation }
    })
    ipcMain.handle(channel('menu'), event => {
      this.authorize(event, true)
      this.openMenu()
    })
    ipcMain.handle(channel('dismiss'), event => { this.authorize(event, true);this.closeMenu() })
    ipcMain.handle(channel('manage'), event => { this.authorize(event, true);this.openManager() })
    ipcMain.handle(channel('add'), (event, input: unknown) => {
      this.authorizeManager(event)
      if (this.busy) throw new Error('REMOTE_DEVICE_BUSY')
      const state = this.devices().add(input)
      this.refresh()
      return state
    })
    ipcMain.handle(channel('remove'), (event, id: unknown) => {
      this.authorizeManager(event)
      this.requestOperation('remove', id)
    })
    ipcMain.handle(channel('switch'), (event, id: unknown) => {
      this.authorize(event)
      this.requestOperation('switch', id)
    })
    ipcMain.handle(channel('confirm'), (event, token: unknown, mode: unknown) => {
      this.authorizeAction(event, token)
      if (mode !== undefined && mode !== 'current' && mode !== 'new') throw new Error('Invalid device open mode')
      return this.confirmOperation(mode === 'new')
    })
    ipcMain.handle(channel('cancel'), (event, token: unknown) => {
      this.authorizeAction(event, token)
      if (this.busy) throw new Error('REMOTE_DEVICE_BUSY')
      this.actionWindow?.close()
    })
  }

  private preferences() {
    return { preload: join(__dirname, '..', 'preload', 'native-devices.js'), sandbox: true, contextIsolation: true, nodeIntegration: false, partition: `native-device-ui-${randomUUID()}` }
  }

  private load(contents: WebContents, kind: 'button' | 'manager' | 'action') {
    const url = 'data:text/html;charset=utf-8,' + encodeURIComponent(nativeDeviceHtml(kind))
    this.documents.set(contents, url)
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-navigate', event => event.preventDefault())
    contents.on('will-redirect', event => event.preventDefault())
    contents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    contents.on('render-process-gone', () => { if (!this.disposed && !contents.isDestroyed()) void contents.loadURL(url).catch(() => undefined) })
    void contents.loadURL(url).catch(() => undefined)
  }

  private authorize(event: IpcMainInvokeEvent, buttonOnly = false) {
    const sender = event.sender
    if (this.disposed || sender.isDestroyed() || event.senderFrame !== sender.mainFrame
      || !this.documents.has(sender) || event.senderFrame.url !== this.documents.get(sender)
      || (buttonOnly && sender !== this.view.webContents)) throw new Error('Device controls require a desktop-owned view')
  }

  private authorizeManager(event: IpcMainInvokeEvent) {
    this.authorize(event)
    if (!this.manager || event.sender !== this.manager.webContents) throw new Error('Device management requires the local manager window')
  }

  private layout() {
    if (this.disposed) return
    const [width, height] = this.window.getContentSize()
    const { bounds } = nativeDeviceSwitcherLayout(width, this.platform)
    if (this.menuOpen) {
      const popupWidth = 224
      bounds.x = Math.max(0, bounds.x + WIDTH - popupWidth)
      bounds.width = popupWidth
      bounds.height = Math.min(height, 340)
    }
    this.view.setBounds(bounds)
  }

  setVisible(visible: boolean) {
    if (this.disposed) return
    this.visible = visible
    if (!visible) this.closeMenu()
    this.view.setVisible(visible)
    if (visible) { this.style();this.raise() }
  }

  private async syncAppearance() {
    if (this.disposed || this.loading || this.readingAppearance || this.mainContents.isDestroyed() || !/^https?:/.test(this.mainContents.getURL())) return
    this.readingAppearance = true
    const epoch = this.navigationEpoch
    try {
      const next = await this.mainContents.executeJavaScriptInIsolatedWorld(974, [{ code: `(${readNativeDeviceAppearance.toString()})()` }])
      if (!this.disposed && epoch === this.navigationEpoch && next) {
        let changed = false
        const locale = normalizeNativeDeviceLocale(next.locale)
        if (locale && locale !== this.locale) { this.locale = locale;changed = true }
        if (next.ready) {
          if (!this.visible) this.setVisible(true)
          if (JSON.stringify(next) !== JSON.stringify(this.appearance)) { this.appearance = next;changed = true }
        }
        if (changed) this.refresh()
      }
    } catch { /* Keep the last theme when the remote renderer is unavailable. */ }
    finally { this.readingAppearance = false }
  }

  raise() {
    if (!this.disposed && !this.window.isDestroyed()) this.window.contentView.addChildView(this.view)
  }

  refresh() {
    if (this.disposed) return
    const labels = nativeDeviceLabels(this.locale)
    if (this.manager && !this.manager.isDestroyed()) this.manager.setTitle(labels.manageTitle)
    if (this.actionWindow && !this.actionWindow.isDestroyed()) this.actionWindow.setTitle(this.operation?.kind === 'remove' ? labels.deleteTitle : labels.switchTitle)
    for (const contents of this.documents.keys()) if (!contents.isDestroyed()) contents.send('studio-native-devices:changed')
  }

  openMenu() {
    if (!this.visible || this.busy) return
    this.menuOpen = !this.menuOpen
    this.layout();this.refresh()
    this.view.webContents.focus()
  }

  openManager() {
    this.closeMenu()
    if (this.manager && !this.manager.isDestroyed()) { this.manager.show();this.manager.focus();return }
    this.manager = new BrowserWindow({ width: 680, height: 620, minWidth: 460, minHeight: 540, parent: this.window, title: nativeDeviceLabels(this.locale).manageTitle, autoHideMenuBar: true, show: false, webPreferences: this.preferences() })
    const manager = this.manager
    this.prepareWindow(manager, 'manager')
    manager.once('closed', () => { if (this.manager === manager) this.manager = null })
  }

  private prepareWindow(window: BrowserWindow, kind: 'manager' | 'action') {
    const contents = window.webContents
    window.once('ready-to-show', () => { if (!window.isDestroyed()) window.show() })
    window.on('close', event => {
      if (!this.disposed && this.operation?.stage === 'checking' && !this.quitting()) event.preventDefault()
    })
    window.once('closed', () => this.documents.delete(contents))
    this.load(contents, kind)
  }

  private authorizeAction(event: IpcMainInvokeEvent, token: unknown) {
    this.authorize(event)
    if (event.sender !== this.actionWindow?.webContents || token !== this.operation?.token) throw new Error('Device confirmation requires the current local action window')
  }

  private requestOperation(kind: 'switch' | 'remove', id: unknown) {
    if (this.busy) throw new Error('REMOTE_DEVICE_BUSY')
    if (this.actionWindow && !this.actionWindow.isDestroyed()) { this.actionWindow.show();this.actionWindow.focus();return }
    const state = this.devices().state()
    const target = id === null && kind === 'switch' ? { id: null, name: nativeDeviceLabels(this.locale).local, serverUrl: null } : state.devices.find(device => device.id === id)
    if (!target) throw new Error('REMOTE_DEVICE_NOT_FOUND')
    const active = target.id === null ? state.activeServerUrl === null : state.activeDeviceId === target.id
    if (active) { if (kind === 'remove') throw new Error('REMOTE_DEVICE_ACTIVE');return }
    this.closeMenu()
    this.operation = { token: randomUUID(), kind, target, stage: 'confirm', startedAt: null, error: null }
    const parent = this.manager && !this.manager.isDestroyed() && this.manager.isVisible() ? this.manager : this.window
    const action = new BrowserWindow({ width: 480, height: 420, useContentSize: true, resizable: false, minimizable: false, maximizable: false, parent, modal: true, autoHideMenuBar: true, title: kind === 'switch' ? nativeDeviceLabels(this.locale).switchTitle : nativeDeviceLabels(this.locale).deleteTitle, show: false, webPreferences: this.preferences() })
    this.actionWindow = action
    this.prepareWindow(action, 'action')
    action.once('closed', () => {
      if (this.actionWindow !== action) return
      this.actionWindow = null
      if (!this.busy) this.operation = null
      this.refresh()
    })
    this.refresh()
  }

  private async confirmOperation(newInstance = false) {
    if (this.busy) throw new Error('REMOTE_DEVICE_BUSY')
    const operation = this.operation!
    if (!['confirm', 'error'].includes(operation.stage)) throw new Error('REMOTE_DEVICE_BUSY')
    if (operation.kind === 'remove') {
      try { this.devices().remove(operation.target.id);this.actionWindow?.close() }
      catch (error) { operation.stage = 'error';operation.error = this.errorCode(error) }
      this.refresh();return
    }
    this.busy = true
    operation.stage = 'checking';operation.startedAt = Date.now();operation.error = null
    this.window.setProgressBar(2)
    this.refresh()
    // The confirmation dialog must relinquish focus before another process is
    // activated. Closing it afterwards would reactivate its parent over the target.
    this.actionWindow?.hide()
    try {
      if (newInstance) {
        await this.devices().openInNewInstance(operation.target.id)
        if (this.disposed) return
        // End checking before close: the native close guard deliberately blocks
        // windows while checking, even if busy has already been reset.
        operation.stage = 'confirm'
        this.busy = false;this.window.setProgressBar(-1)
        this.actionWindow?.close()
        return
      }
      const outcome = await this.devices().switchTo(operation.target.id)
      if (outcome === 'focused' && !this.disposed) {
        operation.stage = 'confirm';this.busy = false;this.window.setProgressBar(-1);this.actionWindow?.close();return
      }
      if (this.disposed) return
      operation.stage = 'restarting'
    } catch (error) {
      if (this.disposed) return
      operation.stage = 'error';operation.error = this.errorCode(error)
      this.actionWindow?.show();this.actionWindow?.focus()
      this.busy = false
      this.window.setProgressBar(-1)
    }
    this.refresh()
  }

  private errorCode(error: unknown) {
    return (error instanceof Error ? error.message : '').match(/REMOTE_DEVICE_[A-Z_]+/)?.[0] || 'REMOTE_DEVICE_FAILED'
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.window.off('resize', this.resize)
    clearInterval(this.appearanceTimer)
    this.mainContents.off('dom-ready', this.style)
    this.mainContents.off('did-finish-load', this.ready)
    this.mainContents.off('did-start-navigation', this.navigate)
    this.mainContents.off('before-mouse-event', this.outsideClick)
    this.window.off('blur', this.closeMenu)
    for (const name of CHANNELS) ipcMain.removeHandler(channel(name))
    if (!this.window.isDestroyed()) this.window.setProgressBar(-1)
    if (this.actionWindow && !this.actionWindow.isDestroyed()) this.actionWindow.destroy()
    if (this.manager && !this.manager.isDestroyed()) this.manager.destroy()
    if (!this.window.isDestroyed()) this.window.contentView.removeChildView(this.view)
    if (!this.view.webContents.isDestroyed()) this.view.webContents.close()
    this.documents.clear()
  }
}
