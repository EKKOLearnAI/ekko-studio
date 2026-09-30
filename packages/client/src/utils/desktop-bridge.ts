export interface DesktopWindowBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface DesktopPetWindowState {
  bounds: DesktopWindowBounds
  visible: boolean
}

export interface DesktopBrowserTab {
  id: string
  profileId: string
  title: string
  url: string
  faviconUrl?: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  crashed: boolean
  agentControl: 'idle' | 'active' | 'waiting-for-user'
  agentLabel?: string
  agentAction?: string
}

export interface DesktopBrowserProfile {
  id: string
  name: string
  rootPath: string
  sessionPath: string
  downloadPath: string
  proxyMode: 'direct' | 'system' | 'fixed_servers'
  proxyRules: string
  askBeforeDownload: boolean
  downloadConflictPolicy: 'ask' | 'uniquify'
  createdAt: string
  lastUsedAt: string
  tabs: string[]
}

export interface DesktopBrowserDownload {
  id: string
  profileId: string
  fileName: string
  sourceUrl: string
  savePath?: string
  receivedBytes: number
  totalBytes: number
  state: 'blocked' | 'progressing' | 'completed' | 'cancelled' | 'interrupted'
  startedAt: string
}

export interface DesktopBrowserState {
  available: boolean
  activeProfileId: string
  activeTabId?: string
  tabs: DesktopBrowserTab[]
  profiles: DesktopBrowserProfile[]
  downloads: DesktopBrowserDownload[]
  permissions: Array<{ id: string; profileId: string; origin: string; permission: string; allowed: boolean; lastRequestedAt: string }>
  visible: boolean
  maxTabs: number
}

export interface DesktopBrowserSelection {
  tabId: string
  marker: number
  mode: 'element' | 'region'
  url: string
  title: string
  viewport: {
    width: number
    height: number
    scaleFactor: number
  }
  region: DesktopWindowBounds
  element?: { role?: string; name?: string; tag?: string; id?: string; classNames?: string[] }
  screenshot: { mediaType: 'image/png' | 'image/jpeg'; data: string; width: number; height: number }
}

export interface DesktopBrowserBridge {
  getState: () => Promise<DesktopBrowserState>
  setViewport: (bounds: DesktopWindowBounds, visible: boolean) => Promise<DesktopBrowserState>
  createTab: (url?: string, activate?: boolean) => Promise<DesktopBrowserTab>
  createHtmlPreviewTab?: (html: string, title: string, activate?: boolean) => Promise<DesktopBrowserTab>
  closeTab: (tabId: string) => Promise<DesktopBrowserState>
  activateTab: (tabId: string) => Promise<DesktopBrowserState>
  navigate: (tabId: string, url: string) => Promise<DesktopBrowserTab>
  navigationAction: (tabId: string, action: 'back' | 'forward' | 'reload' | 'stop') => Promise<DesktopBrowserTab>
  createProfile: (input: {
    name: string
    rootDirectory: string
    proxyMode?: 'direct' | 'system' | 'fixed_servers'
    proxyRules?: string
  }) => Promise<DesktopBrowserProfile>
  chooseProfileRootDirectory: (defaultPath?: string) => Promise<string | null>
  renameProfile: (profileId: string, name: string) => Promise<DesktopBrowserProfile>
  profileSwitchImpact: () => Promise<{ activeAgentRuns: number; activeDownloads: number; pendingAnnotations: number; openTabs: number; requiresConfirmation: boolean }>
  switchProfile: (profileId: string, force?: boolean) => Promise<DesktopBrowserState>
  updateProfile: (profileId: string, input: {
    rootDirectory?: string
    proxyMode?: 'direct' | 'system' | 'fixed_servers'
    proxyRules?: string
    askBeforeDownload?: boolean
    downloadConflictPolicy?: 'ask' | 'uniquify'
  }) => Promise<DesktopBrowserProfile>
  deleteProfile: (profileId: string) => Promise<DesktopBrowserState>
  clearProfileData: (profileId: string, kind: 'cache' | 'site-data' | 'permission-audit') => Promise<DesktopBrowserState>
  cancelDownload: (downloadId: string) => Promise<DesktopBrowserState>
  takeOver: (tabId: string) => Promise<boolean>
  annotate: (tabId: string, mode: 'element' | 'region') => Promise<DesktopBrowserSelection>
  cancelAnnotation: (tabId: string) => Promise<boolean>
  updateAnnotationNote: (tabId: string, marker: number, note: string) => Promise<boolean>
  captureAnnotations: (tabId: string) => Promise<DesktopBrowserSelection['screenshot']>
  clearAnnotations: (tabId: string) => Promise<boolean>
  removeAnnotation?: (tabId: string, marker: number) => Promise<boolean>
  onAnnotationRequest: (callback: (request: { tabId: string; mode: 'element' | 'region' }) => void) => () => void
  onStateChange: (callback: (state: DesktopBrowserState) => void) => () => void
}

export interface DesktopUpdateState {
  revision: number
  status: 'idle' | 'downloading' | 'cancelling' | 'cancelled' | 'preparing' | 'downloaded' | 'error' | 'installing'
  version: string
  percent: number | null
  transferred: number
  total: number
  bytesPerSecond: number
}

export interface DesktopUpdaterBridge {
  getState: () => Promise<DesktopUpdateState>
  cancel: () => Promise<DesktopUpdateState>
  download: () => Promise<DesktopUpdateState>
  install: () => Promise<DesktopUpdateState>
  onStateChange: (callback: (state: DesktopUpdateState) => void) => () => void
}

export interface HermesDesktopBridge {
  updater?: DesktopUpdaterBridge
  getToken: () => Promise<string>
  ensureAuth?: () => Promise<boolean>
  retryBootstrap: (source?: 'cf' | 'github') => Promise<void>
  restartApp?: () => Promise<boolean>
  selectRuntimeDirectory?: (defaultPath?: string) => Promise<string | null>
  notifyCompletion: (payload: { title: string; body?: string; icon?: string; tag?: string; clickUrl?: string }) => Promise<boolean>
  openExternalUrl?: (url: string) => Promise<boolean>
  openChatWindow?: (sessionId: string, profile?: string) => Promise<void>
  getWindowState: () => Promise<{ isMaximized: boolean }>
  windowControl: (action: 'minimize' | 'toggle-maximize' | 'close') => Promise<{ isMaximized: boolean }>
  onWindowStateChange?: (callback: (state: { isMaximized: boolean }) => void) => () => void
  getPetWindowState?: () => Promise<DesktopPetWindowState>
  setPetWindowBounds?: (bounds: DesktopWindowBounds) => Promise<DesktopPetWindowState>
  setPetWindowVisible?: (visible: boolean) => Promise<DesktopPetWindowState>
  onPetWindowRefresh?: (callback: () => void) => () => void
  browser?: DesktopBrowserBridge
  platform: string
  isDesktop: boolean
  windowKind?: 'main' | 'pet' | 'chat'
}

export type WindowWithHermesDesktop = Window & typeof globalThis & {
  hermesDesktop?: HermesDesktopBridge
}

export function desktopBridge(): HermesDesktopBridge | undefined {
  return (window as WindowWithHermesDesktop).hermesDesktop
}

const DESKTOP_BROWSER_METHODS: ReadonlyArray<keyof DesktopBrowserBridge> = [
  'getState', 'setViewport', 'createTab', 'closeTab', 'activateTab', 'navigate',
  'navigationAction', 'createProfile', 'chooseProfileRootDirectory', 'renameProfile', 'profileSwitchImpact',
  'switchProfile', 'updateProfile', 'deleteProfile', 'clearProfileData', 'cancelDownload',
  'takeOver', 'annotate', 'cancelAnnotation', 'updateAnnotationNote',
  'captureAnnotations', 'clearAnnotations',
  'onAnnotationRequest', 'onStateChange',
]

export function hasDesktopBrowserBridge(): boolean {
  const bridge = desktopBridge()
  const browser = bridge?.browser
  return bridge?.isDesktop === true && !!browser
    && DESKTOP_BROWSER_METHODS.every(method => typeof browser[method] === 'function')
}

export function isDesktopShell(): boolean {
  return desktopBridge()?.isDesktop === true
}

export function isDesktopPetWindow(): boolean {
  return desktopBridge()?.windowKind === 'pet'
}

export function isDesktopChatWindow(): boolean {
  return desktopBridge()?.windowKind === 'chat'
}
