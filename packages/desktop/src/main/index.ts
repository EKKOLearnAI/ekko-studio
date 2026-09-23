import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  screen,
  session,
  shell,
  systemPreferences,
  Tray,
  type MessageBoxOptions,
  type OpenDialogOptions,
  type IpcMainInvokeEvent,
  type WebContents,
} from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  getToken,
  setWebUiRestartRequestHandler,
  setWebUiUnexpectedExitHandler,
  startWebUiServer,
  stopWebUiServer,
} from './webui-server'
import { bundledNode, desktopIcon, desktopLinuxTrayIcon, desktopMacTrayIcon, desktopRuntimeVersion, desktopWindowsTrayIcon, runtimeStorageRoot, webuiDir, webUiHome } from './paths'
import { checkForDesktopUpdates, initAutoUpdater } from './updater'
import { t } from './desktop-i18n'
import { resetDesktopDefaultLogin } from './desktop-login-reset'
import { installHermesStudioCliShim, installHermesStudioMcpShim } from './cli-shim'
import { parseHermesCliArgs, runBundledHermesCli } from './hermes-cli'
import { installSelectionContextMenu } from './selection-context-menu'
import { groupChatAgentLinkPopupResponse } from './group-chat-agent-popup'
import { isTrustedDesktopAppUrl, normalizeExternalHttpUrl } from './window-open-policy'
import {
  ensureDesktopRuntime,
  isDesktopRuntimeReady,
  migratePendingRuntimeRoot,
  repairUpdatedDesktopRuntimeLaunchers,
  writeActiveRuntimeVersion,
  type RuntimeDownloadSource,
  type RuntimeProgress,
} from './runtime-manager'
import { BrowserManager } from './browser/browser-manager'
import { BrowserBroker } from './browser/browser-broker'
import type { BrowserBounds } from './browser/browser-types'
import { migratePendingLegacyWindowsData } from './legacy-windows-data-migration'
import { createDesktopAppLifecycle } from './app-lifecycle'
import { configureDesktopIdentity } from './desktop-identity'
import { migrateWindowsLoginItem } from './login-item-migration'

configureDesktopIdentity(app)

const PORT = Number(process.env.HERMES_DESKTOP_PORT) || 8748
const START_HIDDEN = process.argv.includes('--hidden')
const QUIT_EXISTING = process.argv.includes('--quit')
const APP_USER_MODEL_ID = 'com.hermeswebui.studio'
const PET_WINDOW_DEFAULT_WIDTH = 300
const PET_WINDOW_DEFAULT_HEIGHT = 320
const PET_WINDOW_MIN_SIZE = 72
const PET_WINDOW_MAX_SIZE = 1200
const PET_WINDOW_REFRESH_CHANNEL = 'hermes-desktop:pet-window-refresh'
const WINDOW_STATE_CHANGE_CHANNEL = 'hermes-desktop:window-state-change'
const BROWSER_STATE_CHANGE_CHANNEL = 'hermes-desktop:browser-state-change'
const BROWSER_ANNOTATION_REQUEST_CHANNEL = 'hermes-desktop:browser-annotation-request'
const DESKTOP_DISABLED_CHROMIUM_FEATURES = ['CompressionDictionaryTransport', 'CompressionDictionaryTransportBackend']
const FAILURE_RECOVERY_WINDOW_MS = 60_000
type WindowControlAction = 'minimize' | 'toggle-maximize' | 'close'
type DesktopWindowBounds = { x: number; y: number; width: number; height: number }

let mainWindow: BrowserWindow | null = null
let petWindow: BrowserWindow | null = null
let petWindowLoadPromise: Promise<void> | null = null
const chatWindows = new Map<string, BrowserWindow>()
let serverUrl: string | null = null
let tray: Tray | null = null
let appShutdownPromise: Promise<void> | null = null
let isBootstrapping = false
let isResettingLogin = false
let windowFadeTimer: NodeJS.Timeout | null = null
let browserManager: BrowserManager | null = null
let browserBroker: BrowserBroker | null = null
const activeNotifications = new Set<Notification>()
let unexpectedWebUiExitCount = 0
let unexpectedWebUiExitWindowStartedAt = 0
let rendererRecoveryCount = 0
let rendererRecoveryWindowStartedAt = 0
const appLifecycle = createDesktopAppLifecycle(app)

// Custom Session paths do not need Chromium's optional compression-dictionary
// disk cache; disabling it leaves the normal HTTP cache enabled and isolated.
const existingDisabledFeatures = app.commandLine.getSwitchValue('disable-features')
  .split(',')
  .map(value => value.trim())
  .filter(Boolean)
app.commandLine.appendSwitch('disable-features', [...new Set([...existingDisabledFeatures, ...DESKTOP_DISABLED_CHROMIUM_FEATURES])].join(','))

if (process.platform === 'win32') {
  app.setAppUserModelId(APP_USER_MODEL_ID)
}

function cancelWindowFade() {
  if (windowFadeTimer) {
    clearInterval(windowFadeTimer)
    windowFadeTimer = null
  }
}

function showWindowWithFade(focus = true) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()

  cancelWindowFade()
  const showWindow = focus ? () => mainWindow.show() : () => mainWindow.showInactive()
  if (process.platform !== 'win32' || mainWindow.isVisible()) {
    mainWindow.setOpacity(1)
    showWindow()
    if (focus) mainWindow.focus()
    return
  }

  const durationMs = 180
  const startedAt = Date.now()
  mainWindow.setOpacity(0)
  showWindow()
  if (focus) mainWindow.focus()
  windowFadeTimer = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      cancelWindowFade()
      return
    }
    const progress = Math.min(1, (Date.now() - startedAt) / durationMs)
    mainWindow.setOpacity(progress)
    if (progress >= 1) {
      mainWindow.setOpacity(1)
      cancelWindowFade()
    }
  }, 16)
}

function showMainWindow() {
  if (!mainWindow) {
    void createWindow()
  }
  if (!mainWindow) return
  showWindowWithFade(true)
}

function quitApp() {
  appLifecycle.quit()
}

function scheduleAppRestart(delayMs = 100): boolean {
  return appLifecycle.scheduleRestart(delayMs)
}

async function prepareAppShutdown(): Promise<void> {
  appLifecycle.prepareShutdown()
  if (!appShutdownPromise) {
    appShutdownPromise = (async () => {
      cancelWindowFade()
      await showShutdownSplash()
      await browserBroker?.stop().catch(() => undefined)
      await browserManager?.destroy().catch(() => undefined)
      browserBroker = null
      browserManager = null
      await stopWebUiServer().catch(() => undefined)
    })()
  }
  await appShutdownPromise
}

function defaultPetWindowBounds(): DesktopWindowBounds {
  const { workArea } = screen.getPrimaryDisplay()
  return {
    x: Math.round(workArea.x + workArea.width - PET_WINDOW_DEFAULT_WIDTH - 28),
    y: Math.round(workArea.y + workArea.height - PET_WINDOW_DEFAULT_HEIGHT - 28),
    width: PET_WINDOW_DEFAULT_WIDTH,
    height: PET_WINDOW_DEFAULT_HEIGHT,
  }
}

function petWindowState() {
  const target = petWindow && !petWindow.isDestroyed() ? petWindow : null
  return {
    bounds: target?.getBounds() || defaultPetWindowBounds(),
    visible: !!target?.isVisible(),
  }
}

function sanitizePetWindowBounds(input: unknown): DesktopWindowBounds | null {
  if (!input || typeof input !== 'object') return null
  const value = input as Partial<DesktopWindowBounds>
  const x = Number(value.x)
  const y = Number(value.y)
  const width = Number(value.width)
  const height = Number(value.height)
  if (![x, y, width, height].every(Number.isFinite)) return null
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(Math.min(PET_WINDOW_MAX_SIZE, Math.max(PET_WINDOW_MIN_SIZE, width))),
    height: Math.round(Math.min(PET_WINDOW_MAX_SIZE, Math.max(PET_WINDOW_MIN_SIZE, height))),
  }
}

function webUiHashUrl(hashPath: string): string | null {
  if (!serverUrl) return null
  const normalizedHash = hashPath.startsWith('/') ? hashPath : `/${hashPath}`
  return `${serverUrl.replace(/#.*$/, '').replace(/\/$/, '')}/#${normalizedHash}`
}

function mainRouteUrl(): string | null {
  return webUiHashUrl('/hermes/chat')
}

function petRouteUrl(): string | null {
  return webUiHashUrl('/desktop-pet')
}

function chatRouteUrl(sessionId: string, profile?: string): string | null {
  const query = profile ? `?profile=${encodeURIComponent(profile)}` : ''
  return webUiHashUrl(`/desktop-chat/${encodeURIComponent(sessionId)}${query}`)
}

function ensurePetWindow(): BrowserWindow {
  if (petWindow && !petWindow.isDestroyed()) return petWindow

  petWindow = new BrowserWindow({
    ...defaultPetWindowBounds(),
    title: 'Hermes Pet',
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    ...(process.platform === 'darwin' ? { roundedCorners: false } : {}),
    ...(process.platform === 'win32' ? { thickFrame: false } : {}),
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    acceptFirstMouse: true,
    autoHideMenuBar: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      additionalArguments: ['--hermes-window-kind=pet'],
    },
  })
  petWindow.setBackgroundColor('#00000000')
  petWindow.setHasShadow(false)
  petWindow.setAlwaysOnTop(true, process.platform === 'darwin' ? 'floating' : 'normal')
  if (process.platform === 'darwin') {
    petWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false })
  }
  petWindow.on('closed', () => {
    petWindow = null
    petWindowLoadPromise = null
  })
  petWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isTrustedDesktopAppUrl(url, serverUrl)) {
      return { action: 'allow' }
    }
    shell.openExternal(url).catch(() => undefined)
    return { action: 'deny' }
  })
  return petWindow
}

async function loadPetWindowRoute(): Promise<void> {
  const url = petRouteUrl()
  if (!url) return
  const target = ensurePetWindow()
  if (target.webContents.getURL() === url) return
  if (!petWindowLoadPromise) {
    petWindowLoadPromise = target.loadURL(url)
      .catch(err => {
        console.warn('[desktop-pet] failed to load pet window:', err)
      })
      .finally(() => {
        petWindowLoadPromise = null
      })
  }
  await petWindowLoadPromise
}

function windowState(target: BrowserWindow | null = mainWindow) {
  return {
    isMaximized: !!target && !target.isDestroyed() && target.isMaximized(),
  }
}

function notifyWindowStateChanged(target: BrowserWindow | null) {
  if (!target || target.isDestroyed()) return
  target.webContents.send(WINDOW_STATE_CHANGE_CHANNEL, windowState(target))
}

function handleWindowControl(target: BrowserWindow | null, action: WindowControlAction) {
  if (!target || target.isDestroyed()) return windowState(target)
  if (action === 'minimize') {
    target.minimize()
  } else if (action === 'toggle-maximize') {
    if (target.isMaximized()) target.unmaximize()
    else target.maximize()
  } else if (action === 'close') {
    target.close()
  }
  return windowState(target)
}

function hasQuitRequest(data: unknown): boolean {
  return typeof data === 'object'
    && data !== null
    && (data as { quit?: unknown }).quit === true
}

function loginItemOptions() {
  return {
    path: process.execPath,
    args: ['--hidden'],
  }
}

function getOpenAtLogin(): boolean {
  return app.getLoginItemSettings(loginItemOptions()).openAtLogin
}

function setOpenAtLogin(openAtLogin: boolean) {
  app.setLoginItemSettings({
    ...loginItemOptions(),
    openAtLogin,
    openAsHidden: true,
  })
}

async function clearWebLoginSession() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  await mainWindow.webContents.executeJavaScript(`
    try {
      localStorage.removeItem('hermes_api_key');
      sessionStorage.clear();
      window.location.hash = '#/login';
    } catch {
      window.location.hash = '#/login';
    }
  `).catch(() => undefined)
}

function showDesktopMessageBox(options: MessageBoxOptions) {
  if (mainWindow && !mainWindow.isDestroyed()) return dialog.showMessageBox(mainWindow, options)
  return dialog.showMessageBox(options)
}

async function handleResetDefaultLogin() {
  if (isResettingLogin || (isBootstrapping && !serverUrl)) return

  const choice = await showDesktopMessageBox({
    type: 'warning',
    buttons: [t('tray.resetLogin'), t('common.cancel')],
    defaultId: 0,
    cancelId: 1,
    title: t('loginReset.confirmTitle'),
    message: t('loginReset.confirmMessage'),
    detail: t('loginReset.confirmDetail'),
  })
  if (choice.response !== 0) return

  isResettingLogin = true
  updateTrayMenu()
  showMainWindow()

  try {
    await clearWebLoginSession()
    if (mainWindow && !mainWindow.isDestroyed()) {
      await mainWindow.loadURL(splashHtml(t('loginReset.resetting')))
    }
    await stopWebUiServer()
    serverUrl = null
    const credentials = await resetDesktopDefaultLogin()
    const url = await startWebUiServer(PORT)
    serverUrl = url
    if (mainWindow && !mainWindow.isDestroyed()) await mainWindow.loadURL(url)
    await loadPetWindowRoute()
    await clearWebLoginSession()
    await showDesktopMessageBox({
      type: 'info',
      buttons: [t('common.ok')],
      defaultId: 0,
      title: t('loginReset.successTitle'),
      message: t('loginReset.successMessage', credentials),
    })
  } catch (err) {
    console.error('[desktop-login-reset] failed:', err)
    await showDesktopMessageBox({
      type: 'error',
      buttons: [t('common.ok')],
      defaultId: 0,
      title: t('loginReset.failedTitle'),
      message: t('loginReset.failedMessage'),
      detail: err instanceof Error ? err.message : String(err),
    })
  } finally {
    isResettingLogin = false
    updateTrayMenu()
  }
}

function updateTrayMenu() {
  if (!tray) return
  const isVisible = !!mainWindow && mainWindow.isVisible()
  const menu = Menu.buildFromTemplate([
    {
      label: isVisible ? t('tray.hide') : t('tray.show'),
      click: () => {
        if (mainWindow?.isVisible()) {
          mainWindow.hide()
        } else {
          showMainWindow()
        }
        updateTrayMenu()
      },
    },
    {
      label: t('tray.checkForUpdates'),
      click: () => {
        checkForDesktopUpdates(true).catch(err => {
          console.error('[tray] update check failed:', err)
        })
      },
    },
    {
      label: isResettingLogin ? t('loginReset.resetting') : t('tray.resetLogin'),
      enabled: !isResettingLogin && (!isBootstrapping || !!serverUrl),
      click: () => {
        handleResetDefaultLogin().catch(err => {
          console.error('[tray] reset login failed:', err)
        })
      },
    },
    {
      label: t('tray.openAtLogin'),
      type: 'checkbox',
      checked: getOpenAtLogin(),
      click: (item) => {
        setOpenAtLogin(item.checked)
        updateTrayMenu()
      },
    },
    { type: 'separator' },
    {
      label: t('tray.quit'),
      click: quitApp,
    },
  ])
  tray.setContextMenu(menu)
}

function createTray() {
  if (tray) return
  const source = process.platform === 'darwin'
    ? desktopMacTrayIcon()
    : process.platform === 'win32'
      ? desktopWindowsTrayIcon()
      : desktopLinuxTrayIcon()
  const sourceIcon = nativeImage.createFromPath(source)
  const icon = process.platform === 'darwin'
    ? sourceIcon
    : sourceIcon.resize({
        width: process.platform === 'win32' ? 24 : 16,
        height: process.platform === 'win32' ? 24 : 16,
        quality: 'best',
      })
  tray = new Tray(icon)
  tray.setToolTip('Ekko Studio')
  tray.on('click', () => {
    showMainWindow()
    updateTrayMenu()
  })
  updateTrayMenu()
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 769,
    minHeight: 600,
    title: 'Ekko Studio',
    backgroundColor: '#1a1a1a',
    autoHideMenuBar: true,
    show: false,
    ...(process.platform === 'darwin'
      ? {
          titleBarStyle: 'hiddenInset' as const,
          trafficLightPosition: { x: 20, y: 16 },
        }
      : process.platform === 'win32'
        ? {
            frame: false,
          }
        : {}),
    ...(process.platform === 'linux' ? { icon: desktopIcon() } : {}),
    webPreferences: {
      preload: join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  mainWindow.once('ready-to-show', () => {
    if (!START_HIDDEN) showWindowWithFade(false)
  })

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    if (appLifecycle.isQuitting || !mainWindow || mainWindow.isDestroyed()) return
    console.error(`[desktop] main renderer exited reason=${details.reason} code=${details.exitCode}`)
    const now = Date.now()
    if (now - rendererRecoveryWindowStartedAt > FAILURE_RECOVERY_WINDOW_MS) {
      rendererRecoveryWindowStartedAt = now
      rendererRecoveryCount = 0
    }
    rendererRecoveryCount += 1
    if (rendererRecoveryCount > 1) {
      void loadServiceFailurePage(new Error(`Desktop renderer repeatedly exited (${details.reason})`))
      return
    }
    setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed() || appLifecycle.isQuitting) return
      mainWindow.reload()
    }, 250).unref?.()
  })

  mainWindow.on('close', (event) => {
    if (appLifecycle.isQuitting) return
    event.preventDefault()
    cancelWindowFade()
    mainWindow?.hide()
    updateTrayMenu()
  })

  mainWindow.on('show', updateTrayMenu)
  mainWindow.on('hide', updateTrayMenu)
  mainWindow.on('maximize', () => notifyWindowStateChanged(mainWindow))
  mainWindow.on('unmaximize', () => notifyWindowStateChanged(mainWindow))
  mainWindow.on('restore', () => notifyWindowStateChanged(mainWindow))

  installSelectionContextMenu(mainWindow)

  // External links → system browser
  mainWindow.webContents.setWindowOpenHandler(({ url, frameName }) => {
    const agentLinkPopup = groupChatAgentLinkPopupResponse(url, frameName)
    if (agentLinkPopup) return agentLinkPopup
    if (isTrustedDesktopAppUrl(url, serverUrl)) {
      return { action: 'allow' }
    }
    shell.openExternal(url).catch(() => undefined)
    return { action: 'deny' }
  })

  // If the Web UI server is already up (re-opening window after close on
  // macOS), go straight to it. Otherwise show a loading splash; bootstrap()
  // will swap in the real URL once the server is ready.
  if (serverUrl) {
    await mainWindow.loadURL(mainRouteUrl() || serverUrl)
  } else {
    await mainWindow.loadURL(splashHtml(t('runtime.checking')))
  }
  updateTrayMenu()
}

function normalizeChatWindowValue(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) return null
  return normalized
}

async function openChatWindow(sessionIdInput: unknown, profileInput?: unknown): Promise<void> {
  const sessionId = normalizeChatWindowValue(sessionIdInput, 512)
  if (!sessionId) throw new Error('Invalid chat session ID')
  const profile = profileInput == null ? undefined : normalizeChatWindowValue(profileInput, 200) || undefined
  const windowKey = `${profile || ''}\u0000${sessionId}`

  const existing = chatWindows.get(windowKey)
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore()
    existing.show()
    existing.focus()
    return
  }

  const url = chatRouteUrl(sessionId, profile)
  if (!url) throw new Error('Desktop Web UI is not ready')

  const chatWindow = new BrowserWindow({
    width: 620,
    height: 760,
    minWidth: 620,
    minHeight: 480,
    title: 'Ekko Studio',
    backgroundColor: '#1a1a1a',
    autoHideMenuBar: true,
    show: false,
    ...(process.platform === 'darwin'
      ? {
          titleBarStyle: 'hiddenInset' as const,
          trafficLightPosition: { x: 20, y: 16 },
        }
      : process.platform === 'win32'
        ? {
            titleBarStyle: 'hidden' as const,
            titleBarOverlay: { height: 46 },
          }
        : {}),
    ...(process.platform === 'linux' ? { icon: desktopIcon() } : {}),
    webPreferences: {
      preload: join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      additionalArguments: ['--hermes-window-kind=chat'],
    },
  })
  chatWindows.set(windowKey, chatWindow)

  chatWindow.once('ready-to-show', () => {
    if (chatWindow.isDestroyed()) return
    chatWindow.show()
    chatWindow.focus()
  })
  chatWindow.on('maximize', () => notifyWindowStateChanged(chatWindow))
  chatWindow.on('unmaximize', () => notifyWindowStateChanged(chatWindow))
  chatWindow.on('restore', () => notifyWindowStateChanged(chatWindow))
  chatWindow.on('closed', () => {
    if (chatWindows.get(windowKey) === chatWindow) chatWindows.delete(windowKey)
  })

  installSelectionContextMenu(chatWindow)
  chatWindow.webContents.setWindowOpenHandler(({ url: targetUrl, frameName }) => {
    const agentLinkPopup = groupChatAgentLinkPopupResponse(targetUrl, frameName)
    if (agentLinkPopup) return agentLinkPopup
    if (/^(https?:|mailto:)/i.test(targetUrl)) {
      shell.openExternal(targetUrl).catch(() => undefined)
    }
    return { action: 'deny' }
  })

  await chatWindow.loadURL(url)
}

async function initializeDesktopBrowser(): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed() || browserManager) return
  const root = join(webUiHome(), 'desktop-browser')
  const manager = new BrowserManager(mainWindow, root, {
    selectElementLabel: t('browser.selectElement'),
    selectRegionLabel: t('browser.selectRegion'),
    onAnnotationRequest: (tabId, mode) => {
      browserBroker?.revokeTab(tabId)
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(BROWSER_ANNOTATION_REQUEST_CHANNEL, { tabId, mode })
      }
    },
  })
  const broker = new BrowserBroker(manager, root)
  try {
    await manager.initialize()
    manager.onStateChange(state => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(BROWSER_STATE_CHANGE_CHANNEL, state)
    })
    await broker.start()
    browserManager = manager
    browserBroker = broker
  } catch (error) {
    await broker.stop().catch(() => undefined)
    await manager.destroy()
    throw error
  }
}

function installMicrophonePermissionHandler() {
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const isMainRenderer = !!mainWindow
      && !mainWindow.isDestroyed()
      && webContents === mainWindow.webContents
    const isChatRenderer = [...chatWindows.values()].some(window => (
      !window.isDestroyed() && webContents === window.webContents
    ))
    const isTrustedRenderer = isMainRenderer || isChatRenderer
    if (permission !== 'media') {
      callback(isTrustedRenderer)
      return
    }

    const mediaTypes = ('mediaTypes' in details ? details.mediaTypes : undefined) ?? []
    const requestsAudio = mediaTypes.length ? mediaTypes.includes('audio') : true

    if (!isTrustedRenderer || !requestsAudio) {
      callback(false)
      return
    }

    if (process.platform !== 'darwin') {
      callback(true)
      return
    }

    const status = systemPreferences.getMediaAccessStatus('microphone')
    if (status === 'granted') {
      callback(true)
      return
    }
    if (status === 'denied' || status === 'restricted') {
      callback(false)
      return
    }
    void systemPreferences.askForMediaAccess('microphone')
      .then(granted => callback(granted))
      .catch(() => callback(false))
  })
}

function splashHtml(label = t('desktop.startingLocalServices')): string {
  const startingLabel = escapeHtml(label)
  const pageBackground = process.platform === 'win32' ? 'transparent' : '#1a1a1a'
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Ekko Studio</title>
<style>
  html,body{margin:0;height:100%;background:${pageBackground};color:#e5e5e5;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;-webkit-app-region:drag;}
  .surface{height:100%;background:#1a1a1a}
  .wrap{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:20px}
  .dot{width:10px;height:10px;border-radius:50%;background:#888;animation:pulse 1.2s ease-in-out infinite}
  @keyframes pulse{0%,100%{opacity:.3}50%{opacity:1}}
  .row{display:flex;gap:8px}
  .row .dot:nth-child(2){animation-delay:.2s}.row .dot:nth-child(3){animation-delay:.4s}
  .label{font-size:14px;color:#b8b8b8}
  .detail{min-height:18px;font-size:12px;color:#7f7f7f}
  .progress{width:320px;height:6px;border-radius:999px;background:#2b2b2b;overflow:hidden}
  .bar{width:0;height:100%;background:#d8d8d8;transition:width .18s ease}
  .bar.indeterminate{width:40%;animation:progress 1.2s ease-in-out infinite;transition:none}
  @keyframes progress{0%{transform:translateX(-110%)}100%{transform:translateX(360%)}}
  h1{font-weight:500;margin:0;font-size:18px}
</style></head><body><main class="surface"><div class="wrap">
<h1>Ekko Studio</h1>
<div class="row"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div>
<div id="label" class="label">${startingLabel}</div>
<div class="progress"><div id="bar" class="bar indeterminate"></div></div>
<div id="detail" class="detail"></div>
</div></main></body></html>`
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html)
}

async function showShutdownSplash() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  cancelWindowFade()
  try {
    await mainWindow.loadURL(splashHtml(t('desktop.shuttingDown')))
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.setOpacity(1)
    mainWindow.show()
    updateTrayMenu()
  } catch {
    /* best effort during app shutdown */
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char] || char))
}

function resolveRuntimeSourceLogo(): string {
  const candidates = [
    join(webuiDir(), 'dist', 'client', 'logo.png'),
    join(webuiDir(), 'packages', 'client', 'public', 'logo.png'),
    join(webuiDir(), 'logo.png'),
    desktopIcon(),
  ]
  return candidates.find(candidate => existsSync(candidate)) || desktopIcon()
}

function runtimeSourceLogoDataUri(): string {
  const logoPath = resolveRuntimeSourceLogo()
  try {
    const image = nativeImage.createFromPath(logoPath)
    if (image.isEmpty()) return ''
    return image.resize({ width: 68, height: 68, quality: 'best' }).toDataURL()
  } catch {
    return ''
  }
}

function runtimeSourceHtml(errorMessage?: string): string {
  const safeError = errorMessage ? escapeHtml(errorMessage) : ''
  const logoUrl = runtimeSourceLogoDataUri()
  const pageBackground = process.platform === 'win32' ? 'transparent' : '#191919'
  const errorBlock = safeError
    ? `<section class="error" aria-live="polite">
        <div class="error-title">${escapeHtml(t('desktop.downloadFailed'))}</div>
        <pre>${safeError}</pre>
       </section>`
    : ''
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Ekko Studio</title>
<style>
  :root{color-scheme:dark}
  *{box-sizing:border-box}
  html,body{margin:0;width:100%;height:100%;background:${pageBackground};color:#f1f1f1;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;}
  body{min-height:100%;-webkit-app-region:drag;}
  .surface{width:100%;height:100%;display:grid;place-items:center;padding:32px;background:#191919}
  .wrap{width:min(720px,100%);display:flex;flex-direction:column;align-items:center;gap:22px;text-align:center}
  .brand{display:flex;align-items:center;gap:10px;color:#f6f6f6}
  .mark{width:34px;height:34px;border-radius:8px;object-fit:contain;display:block}
  h1{font-weight:560;margin:0;font-size:22px;line-height:1.25}
  .label{max-width:520px;font-size:14px;line-height:1.6;color:#b9b9b9;margin:0}
  .actions{width:100%;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
  button{min-height:86px;border:1px solid #4c4c4c;border-radius:8px;background:#242424;color:#f2f2f2;cursor:pointer;padding:16px;text-align:left;display:flex;flex-direction:column;gap:7px;transition:background .14s ease,border-color .14s ease,transform .14s ease;-webkit-app-region:no-drag}
  button:hover{background:#2d2d2d;border-color:#747474;transform:translateY(-1px)}
  button:active{transform:translateY(0)}
  button:focus-visible{outline:2px solid #dcdcdc;outline-offset:3px}
  .button-title{font-size:15px;font-weight:650;line-height:1.2}
  .button-detail{font-size:12px;line-height:1.45;color:#aaaaaa}
  .error{width:100%;text-align:left;background:#241b1b;border:1px solid #6b3939;border-radius:8px;padding:14px}
  .error-title{font-size:13px;font-weight:650;color:#ffc3c3;margin-bottom:8px}
  pre{width:100%;max-height:180px;overflow:auto;white-space:pre-wrap;margin:0;color:#ffaaaa;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;-webkit-app-region:no-drag}
  @media (max-width:560px){
    .surface{padding:24px}
    .actions{grid-template-columns:1fr}
    button{min-height:78px}
  }
</style></head><body><main class="surface"><div class="wrap">
<div class="brand">${logoUrl ? `<img class="mark" src="${logoUrl}" alt="Ekko Studio">` : ''}<h1>Ekko Studio</h1></div>
<p class="label">${escapeHtml(t('desktop.selectRuntimeSource'))}</p>
${errorBlock}
<div class="actions">
  <button id="cf">
    <span class="button-title">${escapeHtml(t('desktop.downloadCloudflareTitle'))}</span>
    <span class="button-detail">${escapeHtml(t('desktop.downloadCloudflareDetail'))}</span>
  </button>
  <button id="github">
    <span class="button-title">${escapeHtml(t('desktop.downloadGithubTitle'))}</span>
    <span class="button-detail">${escapeHtml(t('desktop.downloadGithubDetail'))}</span>
  </button>
</div>
<script>
  document.getElementById('cf')?.addEventListener('click', () => {
    window.hermesDesktop?.retryBootstrap?.('cf')
  })
  document.getElementById('github')?.addEventListener('click', () => {
    window.hermesDesktop?.retryBootstrap?.('github')
  })
</script>
</div></main></body></html>`
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html)
}

function envRuntimeDownloadSource(): RuntimeDownloadSource | undefined {
  const source = process.env.HERMES_DESKTOP_RUNTIME_SOURCE?.trim().toLowerCase()
  return source === 'cf' || source === 'github' ? source : undefined
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = units[0]
  for (let i = 1; i < units.length && value >= 1024; i += 1) {
    value /= 1024
    unit = units[i]
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${unit}`
}

function updateSplash(progress: RuntimeProgress) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const label = progress.message
  const percent = typeof progress.percent === 'number' ? Math.round(progress.percent) : null
  let detail = progress.detail || ''
  if (progress.receivedBytes && progress.totalBytes) {
    detail = `${formatBytes(progress.receivedBytes)} / ${formatBytes(progress.totalBytes)}`
    if (percent !== null) detail += ` (${percent}%)`
  } else if (percent !== null) {
    detail = `${percent}%`
  }

  mainWindow.webContents.executeJavaScript(`
    {
      const label = document.getElementById('label');
      const detail = document.getElementById('detail');
      const bar = document.getElementById('bar');
      if (label) label.textContent = ${JSON.stringify(label)};
      if (detail) detail.textContent = ${JSON.stringify(detail)};
      if (bar) {
        bar.classList.toggle('indeterminate', ${JSON.stringify(percent === null)});
        bar.style.width = ${JSON.stringify(percent === null ? '' : `${percent}%`)};
      }
    }
  `).catch(() => undefined)
}

async function installPackagedCommandShims(): Promise<void> {
  if (!app.isPackaged) return

  const installs = [
    installHermesStudioCliShim({
      nodePath: bundledNode(),
      runtimeVersion: desktopRuntimeVersion(),
      webUiScriptPath: join(webuiDir(), 'bin', 'hermes-web-ui.mjs'),
    }),
    installHermesStudioMcpShim({
      nodePath: bundledNode(),
      scriptPath: join(webuiDir(), 'bin', 'ekko-studio-mcp.mjs'),
      webUiUrl: `http://127.0.0.1:${PORT}`,
    }),
  ]
  const results = await Promise.allSettled(installs)
  for (const result of results) {
    if (result.status === 'rejected') {
      console.warn(
        `[cli-shim] failed to install Ekko Studio command: `
        + `${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
      )
      continue
    }
    if (result.value.status === 'skipped') {
      console.warn(`[cli-shim] ${result.value.reason}: ${result.value.shimPath}`)
    }
  }
}

async function bootstrap(source?: RuntimeDownloadSource) {
  if (isBootstrapping) return
  isBootstrapping = true

  try {
    const legacyMigration = await migratePendingLegacyWindowsData()
    if (legacyMigration.completed) {
      console.log('[desktop] migrated legacy Windows Hermes data before starting local services')
    } else if (legacyMigration.retryPending) {
      console.warn(`[desktop] legacy Windows Hermes data migration will retry on the next launch: ${legacyMigration.error || 'unknown error'}`)
    }
    await migratePendingRuntimeRoot(updateSplash)
    repairUpdatedDesktopRuntimeLaunchers()
    const selectedSource = source || envRuntimeDownloadSource()
    const runtimeUrlOverride = !!process.env.HERMES_DESKTOP_RUNTIME_URL?.trim()
    const manifestOverride = !!process.env.HERMES_DESKTOP_RUNTIME_MANIFEST_URL?.trim()
    const forceUpdate = !!process.env.HERMES_DESKTOP_RUNTIME_FORCE_UPDATE
    const runtimeReady = isDesktopRuntimeReady()
    const needsRuntimeWork = !runtimeReady || forceUpdate || runtimeUrlOverride || manifestOverride
    const explicitRuntimeRequest = !!selectedSource || forceUpdate || runtimeUrlOverride || manifestOverride

    // Runtime setup is managed in Studio now. A normal desktop launch must
    // reach the Web UI first so it can detect an existing CLI before offering
    // the Runtime manager. Preserve explicit automation overrides for builds
    // and unattended installations.
    if (needsRuntimeWork && explicitRuntimeRequest) {
      await ensureDesktopRuntime(updateSplash, selectedSource)
    }
    if (isDesktopRuntimeReady()) {
      writeActiveRuntimeVersion()
      await installPackagedCommandShims()
    }
  } catch (err) {
    console.error('Failed to prepare Hermes runtime:', err)
    // Keep Studio available so Runtime recovery can happen from Agent Manager.
  }

  try {
    updateSplash({ stage: 'resolve', message: t('desktop.startingLocalServices') })
    const url = await startWebUiServer(PORT)
    serverUrl = url
    updateTrayMenu()
    if (mainWindow) await mainWindow.loadURL(mainRouteUrl() || url)
    await loadPetWindowRoute()
  } catch (err) {
    console.error('Failed to start Web UI server:', err)
    serverUrl = null
    await loadServiceFailurePage(err)
  } finally {
    isBootstrapping = false
  }
}

async function loadServiceFailurePage(error: unknown): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const msg = escapeHtml(String(error instanceof Error ? error.message : error))
  const pageBackground = process.platform === 'win32' ? 'transparent' : '#1a1a1a'
  const html = `<html><body style="margin:0;font-family:system-ui;background:${pageBackground};color:#eee">
    <main style="min-height:100vh;padding:32px;background:#1a1a1a;box-sizing:border-box">
      <h2>${escapeHtml(t('desktop.failedStartServices'))}</h2>
      <pre style="white-space:pre-wrap;color:#f88">${msg}</pre>
      <button id="retry" style="padding:8px 14px;cursor:pointer">Retry</button>
      <script>
        document.getElementById('retry').addEventListener('click', async function () {
          this.disabled = true
          try { await window.hermesDesktop.retryBootstrap() } finally { this.disabled = false }
        })
      </script>
    </main>
  </body></html>`
  await mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html)).catch(loadError => {
    console.error('[desktop] failed to display Web UI failure page:', loadError)
  })
}

async function recoverUnexpectedWebUiExit(details: { code: number | null; signal: NodeJS.Signals | null }): Promise<void> {
  if (appLifecycle.isQuitting) return
  serverUrl = null
  updateTrayMenu()

  const now = Date.now()
  if (now - unexpectedWebUiExitWindowStartedAt > FAILURE_RECOVERY_WINDOW_MS) {
    unexpectedWebUiExitWindowStartedAt = now
    unexpectedWebUiExitCount = 0
  }
  unexpectedWebUiExitCount += 1
  const error = new Error(`Web UI server exited unexpectedly code=${details.code} signal=${details.signal}`)
  if (unexpectedWebUiExitCount > 1 || isBootstrapping) {
    await loadServiceFailurePage(error)
    return
  }

  console.warn('[desktop] restarting Web UI once after an unexpected exit')
  await new Promise(resolveDelay => setTimeout(resolveDelay, 500))
  await bootstrap()
  if (!serverUrl) await loadServiceFailurePage(error)
}

ipcMain.handle('hermes-desktop:get-token', () => getToken())
ipcMain.handle('hermes-desktop:restart-app', event => {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) {
    throw new Error('Desktop restart can only be requested from the main window')
  }
  return scheduleAppRestart()
})
ipcMain.handle('hermes-desktop:open-chat-window', (event, sessionId?: unknown, profile?: unknown) => {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) {
    throw new Error('Chat windows can only be opened from the main window')
  }
  return openChatWindow(sessionId, profile)
})

function isTrustedDesktopWindowSender(sender: WebContents): boolean {
  const windows = [mainWindow, petWindow, ...chatWindows.values()]
  return windows.some(window => window && !window.isDestroyed() && window.webContents === sender)
}

ipcMain.handle('hermes-desktop:open-external-url', async (event, url?: unknown) => {
  if (!isTrustedDesktopWindowSender(event.sender)) {
    throw new Error('External URLs can only be opened from a Hermes desktop window')
  }
  const externalUrl = normalizeExternalHttpUrl(url)
  if (!externalUrl) return false

  try {
    await shell.openExternal(externalUrl)
    return true
  } catch {
    return false
  }
})

function browserForEvent(event: IpcMainInvokeEvent): BrowserManager {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) throw new Error('Desktop browser IPC is only available to the main window')
  if (!browserManager) throw new Error('Desktop browser is still starting')
  return browserManager
}

ipcMain.handle('hermes-desktop:browser-get-state', event => browserForEvent(event).state())
ipcMain.handle('hermes-desktop:browser-set-viewport', (event, bounds?: unknown, visible?: unknown) => {
  const input = bounds && typeof bounds === 'object' ? bounds as Partial<BrowserBounds> : {}
  const sanitized: BrowserBounds = {
    x: Number.isFinite(input.x) ? Number(input.x) : 0,
    y: Number.isFinite(input.y) ? Number(input.y) : 0,
    width: Number.isFinite(input.width) ? Number(input.width) : 1,
    height: Number.isFinite(input.height) ? Number(input.height) : 1,
  }
  return browserForEvent(event).setViewport(sanitized, visible === true)
})
ipcMain.handle('hermes-desktop:browser-create-tab', (event, url?: unknown, activate?: unknown) => browserForEvent(event).createTab(typeof url === 'string' ? url : 'about:blank', activate !== false))
ipcMain.handle('hermes-desktop:browser-create-html-preview-tab', (event, html?: unknown, title?: unknown, activate?: unknown) => (
  browserForEvent(event).createHtmlPreviewTab(
    typeof html === 'string' ? html : '',
    typeof title === 'string' ? title : '',
    activate !== false,
  )
))
ipcMain.handle('hermes-desktop:browser-close-tab', (event, tabId?: unknown) => browserForEvent(event).closeTab(String(tabId || '')))
ipcMain.handle('hermes-desktop:browser-activate-tab', (event, tabId?: unknown) => browserForEvent(event).activateTab(String(tabId || '')))
ipcMain.handle('hermes-desktop:browser-navigate', (event, tabId?: unknown, url?: unknown) => {
  const manager = browserForEvent(event)
  browserBroker?.revokeTab(String(tabId || ''))
  return manager.navigate(String(tabId || ''), String(url || ''))
})
ipcMain.handle('hermes-desktop:browser-navigation-action', (event, tabId?: unknown, action?: unknown) => {
  if (action !== 'back' && action !== 'forward' && action !== 'reload' && action !== 'stop') throw new Error('Invalid browser navigation action')
  const manager = browserForEvent(event)
  browserBroker?.revokeTab(String(tabId || ''))
  return manager.navigationAction(String(tabId || ''), action)
})
ipcMain.handle('hermes-desktop:browser-create-profile', (event, input?: unknown) => {
  const value = input && typeof input === 'object' ? input as Record<string, unknown> : {}
  const proxyMode = value.proxyMode === 'system' || value.proxyMode === 'fixed_servers' ? value.proxyMode : 'direct'
  return browserForEvent(event).createProfile({
    name: String(value.name || ''),
    rootDirectory: String(value.rootDirectory || ''),
    proxyMode,
    proxyRules: String(value.proxyRules || ''),
  })
})
ipcMain.handle('hermes-desktop:browser-choose-profile-root-directory', (event, defaultPath?: unknown) => (
  browserForEvent(event).chooseProfileRootDirectory(typeof defaultPath === 'string' ? defaultPath : undefined)
))
ipcMain.handle('hermes-desktop:browser-rename-profile', (event, profileId?: unknown, name?: unknown) => browserForEvent(event).renameProfile(String(profileId || ''), String(name || '')))
ipcMain.handle('hermes-desktop:browser-profile-switch-impact', event => browserForEvent(event).profileSwitchImpact())
ipcMain.handle('hermes-desktop:browser-switch-profile', (event, profileId?: unknown, force?: unknown) => {
  const manager = browserForEvent(event)
  browserBroker?.revokeAll()
  return manager.switchProfile(String(profileId || ''), force === true)
})
ipcMain.handle('hermes-desktop:browser-update-profile', (event, profileId?: unknown, input?: unknown) => {
  const value = input && typeof input === 'object' ? input as Record<string, unknown> : {}
  return browserForEvent(event).updateProfile(String(profileId || ''), {
    ...(typeof value.rootDirectory === 'string' ? { rootDirectory: value.rootDirectory } : {}),
    ...(value.proxyMode === 'direct' || value.proxyMode === 'system' || value.proxyMode === 'fixed_servers'
      ? { proxyMode: value.proxyMode }
      : {}),
    ...(typeof value.proxyRules === 'string' ? { proxyRules: value.proxyRules } : {}),
    ...(typeof value.askBeforeDownload === 'boolean' ? { askBeforeDownload: value.askBeforeDownload } : {}),
    ...(value.downloadConflictPolicy === 'ask' || value.downloadConflictPolicy === 'uniquify'
      ? { downloadConflictPolicy: value.downloadConflictPolicy }
      : {}),
  })
})
ipcMain.handle('hermes-desktop:browser-delete-profile', (event, profileId?: unknown) => browserForEvent(event).deleteProfile(String(profileId || '')))
ipcMain.handle('hermes-desktop:browser-clear-profile-data', (event, profileId?: unknown, kind?: unknown) => {
  if (kind !== 'cache' && kind !== 'site-data' && kind !== 'permission-audit') throw new Error('Invalid browser data type')
  const manager = browserForEvent(event)
  browserBroker?.revokeAll()
  return manager.clearProfileData(String(profileId || ''), kind)
})
ipcMain.handle('hermes-desktop:browser-cancel-download', (event, downloadId?: unknown) => (
  browserForEvent(event).cancelDownload(String(downloadId || ''))
))
ipcMain.handle('hermes-desktop:browser-take-over', (event, tabId?: unknown) => {
  browserForEvent(event)
  browserBroker?.revokeTab(String(tabId || ''))
  return true
})
ipcMain.handle('hermes-desktop:browser-annotate', (event, tabId?: unknown, mode?: unknown) => {
  if (mode !== 'element' && mode !== 'region') throw new Error('Invalid browser annotation mode')
  const manager = browserForEvent(event)
  browserBroker?.revokeTab(String(tabId || ''))
  return manager.annotate(String(tabId || ''), mode)
})
ipcMain.handle('hermes-desktop:browser-cancel-annotation', (event, tabId?: unknown) => browserForEvent(event).cancelAnnotation(String(tabId || '')))
ipcMain.handle('hermes-desktop:browser-update-annotation-note', (event, tabId?: unknown, marker?: unknown, note?: unknown) => {
  const value = Number(marker)
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid browser annotation marker')
  return browserForEvent(event).updateAnnotationNote(String(tabId || ''), value, String(note || '').slice(0, 500))
})
ipcMain.handle('hermes-desktop:browser-capture-annotations', (event, tabId?: unknown) => browserForEvent(event).captureAnnotations(String(tabId || '')))
ipcMain.handle('hermes-desktop:browser-clear-annotations', (event, tabId?: unknown) => browserForEvent(event).clearAnnotations(String(tabId || '')))
ipcMain.handle('hermes-desktop:browser-remove-annotation', (event, tabId?: unknown, marker?: unknown) => browserForEvent(event).removeAnnotation(String(tabId || ''), Number(marker)))
ipcMain.handle('hermes-desktop:select-runtime-directory', async (_event, defaultPath?: unknown) => {
  const options: OpenDialogOptions = {
    properties: ['openDirectory'],
    defaultPath: typeof defaultPath === 'string' && defaultPath.trim()
      ? defaultPath.trim()
      : runtimeStorageRoot(),
  }
  const result = mainWindow && !mainWindow.isDestroyed()
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options)
  return result.canceled ? null : result.filePaths[0] || null
})
ipcMain.handle('hermes-desktop:get-window-state', event => {
  return windowState(BrowserWindow.fromWebContents(event.sender))
})
ipcMain.handle('hermes-desktop:window-control', (event, action?: unknown) => {
  const target = BrowserWindow.fromWebContents(event.sender)
  if (action !== 'minimize' && action !== 'toggle-maximize' && action !== 'close') return windowState(target)
  return handleWindowControl(target, action)
})
ipcMain.handle('hermes-desktop:get-pet-window-state', () => petWindowState())
ipcMain.handle('hermes-desktop:set-pet-window-bounds', (_event, bounds?: unknown) => {
  const nextBounds = sanitizePetWindowBounds(bounds)
  if (!nextBounds) return petWindowState()
  const target = ensurePetWindow()
  target.setBounds(nextBounds, false)
  return petWindowState()
})
ipcMain.handle('hermes-desktop:set-pet-window-visible', async (_event, visible?: unknown) => {
  if (visible === false) {
    if (!petWindow || petWindow.isDestroyed()) return petWindowState()
    petWindow.hide()
    return petWindowState()
  }
  const fromPetWindow = !!petWindow && !petWindow.isDestroyed() && _event.sender === petWindow.webContents
  await loadPetWindowRoute()
  const target = ensurePetWindow()
  if (!fromPetWindow) target.webContents.send(PET_WINDOW_REFRESH_CHANNEL)
  target.showInactive()
  return petWindowState()
})
function resolveNotificationIcon(icon: unknown): string {
  if (typeof icon !== 'string') return desktopIcon()
  const normalized = icon.trim().replace(/^\/+/, '')
  if (!normalized || normalized.includes('..')) return desktopIcon()

  const candidates = [
    join(webuiDir(), 'dist', 'client', normalized),
    join(webuiDir(), 'dist', normalized),
    join(webuiDir(), 'packages', 'client', 'public', normalized),
    join(webuiDir(), normalized),
  ]
  return candidates.find(candidate => existsSync(candidate)) || desktopIcon()
}

function safeNotificationClickUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  return value.startsWith('/hermes/') && !value.includes('..') && !value.includes('\\') ? value : null
}

ipcMain.handle('hermes-desktop:notify-completion', (_event, payload?: { title?: unknown; body?: unknown; icon?: unknown; tag?: unknown; clickUrl?: unknown }) => {
  const supported = Notification.isSupported()
  if (!supported) {
    console.warn('[desktop-notification] Electron notifications are not supported on this system')
    return false
  }

  const title = typeof payload?.title === 'string' && payload.title.trim()
    ? payload.title.trim()
    : 'Ekko Studio'
  const body = typeof payload?.body === 'string' ? payload.body.trim().slice(0, 240) : ''
  const icon = resolveNotificationIcon(payload?.icon)
  const clickUrl = safeNotificationClickUrl(payload?.clickUrl)
  const notification = new Notification({
    title,
    body,
    icon,
    silent: false,
  })
  activeNotifications.add(notification)
  const releaseNotification = () => {
    activeNotifications.delete(notification)
  }
  notification.on('click', () => {
    releaseNotification()
    if (clickUrl && mainWindow && !mainWindow.isDestroyed()) {
      const target = webUiHashUrl(clickUrl)
      if (target) {
        void mainWindow.loadURL(target)
          .catch(error => console.warn('[desktop-notification] failed to open notification target', error))
          .finally(showMainWindow)
      } else showMainWindow()
      return
    }
    showMainWindow()
  })
  notification.on('close', releaseNotification)
  notification.on('failed', (_event, error) => {
    console.warn('[desktop-notification] notification failed', error)
    releaseNotification()
  })
  notification.show()
  return true
})
ipcMain.handle('hermes-desktop:retry-bootstrap', async (_event, source?: RuntimeDownloadSource) => {
  if (serverUrl) {
    await mainWindow?.loadURL(mainRouteUrl() || serverUrl)
    return
  }
  const selectedSource = source === 'cf' || source === 'github' ? source : undefined
  await mainWindow?.loadURL(splashHtml(t('runtime.downloading')))
  await bootstrap(selectedSource)
})

function runDesktopApp() {
  setWebUiRestartRequestHandler(() => {
    // Leave enough time for the authenticated relay HTTP request to flush its 202 response.
    scheduleAppRestart(250)
  })
  setWebUiUnexpectedExitHandler(details => {
    void recoverUnexpectedWebUiExit(details)
  })
  const gotLock = app.requestSingleInstanceLock(QUIT_EXISTING ? { quit: true } : undefined)
  if (!gotLock) {
    quitApp()
    return
  }

  app.on('second-instance', (_event, argv, _workingDirectory, additionalData) => {
    if (argv.includes('--quit') || hasQuitRequest(additionalData)) {
      quitApp()
      return
    }
    showMainWindow()
  })

  app.whenReady().then(async () => {
    if (QUIT_EXISTING) {
      quitApp()
      return
    }

    // Drop the default File/Edit/View/Window menu on Windows/Linux. The web
    // UI provides its own in-page controls, so the native menu bar is just
    // visual clutter. macOS keeps a menu (system requirement) but Electron's
    // default is fine there.
    if (process.platform !== 'darwin') Menu.setApplicationMenu(null)
    try {
      migrateWindowsLoginItem(app, APP_USER_MODEL_ID)
    } catch (error) {
      console.warn('[desktop] failed to migrate the Windows login item:', error)
    }
    installMicrophonePermissionHandler()
    createTray()
    await createWindow()
    await initializeDesktopBrowser().catch(error => {
      console.error('[desktop-browser] failed to initialize:', error)
    })
    void bootstrap()
    initAutoUpdater({ beforeQuitAndInstall: prepareAppShutdown })
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        void createWindow()
      } else if (mainWindow) {
        showMainWindow()
      }
    })
  }).catch(error => {
    console.error('[desktop] failed during Electron startup:', error)
    dialog.showErrorBox('Ekko Studio', String(error instanceof Error ? error.message : error))
    quitApp()
  })

  app.on('window-all-closed', () => {
    if (appLifecycle.isQuitting && process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', async (e) => {
    if (!appLifecycle.isQuitting && process.platform !== 'darwin') {
      e.preventDefault()
      mainWindow?.hide()
      updateTrayMenu()
      return
    }
    e.preventDefault()
    try {
      await prepareAppShutdown()
    } finally {
      appLifecycle.finalizeExit(0)
    }
  })
}

const hermesCliArgs = parseHermesCliArgs(process.argv)
if (hermesCliArgs) {
  runBundledHermesCli(hermesCliArgs)
    .then(code => app.exit(code))
    .catch(err => {
      console.error(`Failed to run bundled Hermes CLI: ${err instanceof Error ? err.message : String(err)}`)
      app.exit(1)
    })
} else {
  runDesktopApp()
}
