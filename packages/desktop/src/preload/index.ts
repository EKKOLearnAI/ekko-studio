import { contextBridge, ipcRenderer } from 'electron'
import type { DesktopUpdateState } from '../main/updater-types'
import type { BrowserBounds, BrowserProfileCreateInput, BrowserProfileSwitchImpact, BrowserProfileUpdateInput, BrowserSelection, DesktopBrowserProfile, DesktopBrowserState, DesktopBrowserTab } from '../main/browser/browser-types'

type DesktopWindowKind = 'main' | 'pet' | 'chat'

function desktopWindowKind(): DesktopWindowKind {
  const arg = process.argv.find(item => item.startsWith('--hermes-window-kind='))
  const kind = arg?.slice('--hermes-window-kind='.length)
  return kind === 'pet' || kind === 'chat' ? kind : 'main'
}

contextBridge.exposeInMainWorld('hermesDesktop', {
  updater: {
    getState: (): Promise<DesktopUpdateState> => ipcRenderer.invoke('hermes-desktop:update-get-state'),
    cancel: (): Promise<DesktopUpdateState> => ipcRenderer.invoke('hermes-desktop:update-cancel'),
    download: (): Promise<DesktopUpdateState> => ipcRenderer.invoke('hermes-desktop:update-download'),
    install: (): Promise<DesktopUpdateState> => ipcRenderer.invoke('hermes-desktop:update-install'),
    onStateChange: (callback: (state: DesktopUpdateState) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, state: DesktopUpdateState) => callback(state)
      ipcRenderer.on('hermes-desktop:update-state-change', listener)
      return () => ipcRenderer.removeListener('hermes-desktop:update-state-change', listener)
    },
  },
  getToken: (): Promise<string> => ipcRenderer.invoke('hermes-desktop:get-token'),
  retryBootstrap: (source?: 'cf' | 'github'): Promise<void> => ipcRenderer.invoke('hermes-desktop:retry-bootstrap', source),
  restartApp: (): Promise<boolean> => ipcRenderer.invoke('hermes-desktop:restart-app'),
  selectRuntimeDirectory: (defaultPath?: string): Promise<string | null> => ipcRenderer.invoke('hermes-desktop:select-runtime-directory', defaultPath),
  notifyCompletion: (payload: { title: string; body?: string; icon?: string; tag?: string; clickUrl?: string }): Promise<boolean> => ipcRenderer.invoke('hermes-desktop:notify-completion', payload),
  openExternalUrl: (url: string): Promise<boolean> => ipcRenderer.invoke('hermes-desktop:open-external-url', url),
  openChatWindow: (sessionId: string, profile?: string): Promise<void> => ipcRenderer.invoke('hermes-desktop:open-chat-window', sessionId, profile),
  ensureAuth: async (): Promise<boolean> => {
    const token = await ipcRenderer.invoke('hermes-desktop:get-token')
    if (token) {
      try { localStorage.setItem('AUTH_TOKEN', token) } catch { /* */ }
    }
    return !!localStorage.getItem(API_KEY_LS)
  },
  getWindowState: (): Promise<{ isMaximized: boolean }> => ipcRenderer.invoke('hermes-desktop:get-window-state'),
  windowControl: (action: 'minimize' | 'toggle-maximize' | 'close'): Promise<{ isMaximized: boolean }> => ipcRenderer.invoke('hermes-desktop:window-control', action),
  onWindowStateChange: (callback: (state: { isMaximized: boolean }) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: { isMaximized: boolean }) => callback(state)
    ipcRenderer.on('hermes-desktop:window-state-change', listener)
    return () => ipcRenderer.removeListener('hermes-desktop:window-state-change', listener)
  },
  getPetWindowState: () => ipcRenderer.invoke('hermes-desktop:get-pet-window-state'),
  setPetWindowBounds: (bounds: { x: number; y: number; width: number; height: number }) => ipcRenderer.invoke('hermes-desktop:set-pet-window-bounds', bounds),
  setPetWindowVisible: (visible: boolean) => ipcRenderer.invoke('hermes-desktop:set-pet-window-visible', visible),
  onPetWindowRefresh: (callback: () => void): (() => void) => {
    const listener = () => callback()
    ipcRenderer.on('hermes-desktop:pet-window-refresh', listener)
    return () => ipcRenderer.removeListener('hermes-desktop:pet-window-refresh', listener)
  },
  ...(desktopWindowKind() === 'main' ? { browser: {
    getState: (): Promise<DesktopBrowserState> => ipcRenderer.invoke('hermes-desktop:browser-get-state'),
    setViewport: (bounds: BrowserBounds, visible: boolean): Promise<DesktopBrowserState> => ipcRenderer.invoke('hermes-desktop:browser-set-viewport', bounds, visible),
    createTab: (url?: string, activate?: boolean): Promise<DesktopBrowserTab> => ipcRenderer.invoke('hermes-desktop:browser-create-tab', url, activate),
    createHtmlPreviewTab: (html: string, title: string, activate?: boolean): Promise<DesktopBrowserTab> => ipcRenderer.invoke('hermes-desktop:browser-create-html-preview-tab', html, title, activate),
    closeTab: (tabId: string): Promise<DesktopBrowserState> => ipcRenderer.invoke('hermes-desktop:browser-close-tab', tabId),
    activateTab: (tabId: string): Promise<DesktopBrowserState> => ipcRenderer.invoke('hermes-desktop:browser-activate-tab', tabId),
    navigate: (tabId: string, url: string): Promise<DesktopBrowserTab> => ipcRenderer.invoke('hermes-desktop:browser-navigate', tabId, url),
    navigationAction: (tabId: string, action: 'back' | 'forward' | 'reload' | 'stop'): Promise<DesktopBrowserTab> => ipcRenderer.invoke('hermes-desktop:browser-navigation-action', tabId, action),
    createProfile: (input: BrowserProfileCreateInput): Promise<DesktopBrowserProfile> => ipcRenderer.invoke('hermes-desktop:browser-create-profile', input),
    chooseProfileRootDirectory: (defaultPath?: string): Promise<string | null> => ipcRenderer.invoke('hermes-desktop:browser-choose-profile-root-directory', defaultPath),
    renameProfile: (profileId: string, name: string): Promise<DesktopBrowserProfile> => ipcRenderer.invoke('hermes-desktop:browser-rename-profile', profileId, name),
    profileSwitchImpact: (): Promise<BrowserProfileSwitchImpact> => ipcRenderer.invoke('hermes-desktop:browser-profile-switch-impact'),
    switchProfile: (profileId: string, force?: boolean): Promise<DesktopBrowserState> => ipcRenderer.invoke('hermes-desktop:browser-switch-profile', profileId, force),
    updateProfile: (profileId: string, input: BrowserProfileUpdateInput): Promise<DesktopBrowserProfile> => ipcRenderer.invoke('hermes-desktop:browser-update-profile', profileId, input),
    deleteProfile: (profileId: string): Promise<DesktopBrowserState> => ipcRenderer.invoke('hermes-desktop:browser-delete-profile', profileId),
    clearProfileData: (profileId: string, kind: 'cache' | 'site-data' | 'permission-audit'): Promise<DesktopBrowserState> => ipcRenderer.invoke('hermes-desktop:browser-clear-profile-data', profileId, kind),
    cancelDownload: (downloadId: string): Promise<DesktopBrowserState> => ipcRenderer.invoke('hermes-desktop:browser-cancel-download', downloadId),
    takeOver: (tabId: string): Promise<boolean> => ipcRenderer.invoke('hermes-desktop:browser-take-over', tabId),
    annotate: (tabId: string, mode: 'element' | 'region'): Promise<BrowserSelection> => ipcRenderer.invoke('hermes-desktop:browser-annotate', tabId, mode),
    cancelAnnotation: (tabId: string): Promise<boolean> => ipcRenderer.invoke('hermes-desktop:browser-cancel-annotation', tabId),
    updateAnnotationNote: (tabId: string, marker: number, note: string): Promise<boolean> => ipcRenderer.invoke('hermes-desktop:browser-update-annotation-note', tabId, marker, note),
    captureAnnotations: (tabId: string): Promise<BrowserSelection['screenshot']> => ipcRenderer.invoke('hermes-desktop:browser-capture-annotations', tabId),
    clearAnnotations: (tabId: string): Promise<boolean> => ipcRenderer.invoke('hermes-desktop:browser-clear-annotations', tabId),
    removeAnnotation: (tabId: string, marker: number): Promise<boolean> => ipcRenderer.invoke('hermes-desktop:browser-remove-annotation', tabId, marker),
    onAnnotationRequest: (callback: (request: { tabId: string; mode: 'element' | 'region' }) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, request: { tabId: string; mode: 'element' | 'region' }) => callback(request)
      ipcRenderer.on('hermes-desktop:browser-annotation-request', listener)
      return () => ipcRenderer.removeListener('hermes-desktop:browser-annotation-request', listener)
    },
    onStateChange: (callback: (state: DesktopBrowserState) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, state: DesktopBrowserState) => callback(state)
      ipcRenderer.on('hermes-desktop:browser-state-change', listener)
      return () => ipcRenderer.removeListener('hermes-desktop:browser-state-change', listener)
    },
  } } : {}),
  platform: process.platform,
  isDesktop: true,
  windowKind: desktopWindowKind(),
})

const API_KEY_LS = 'hermes_api_key'

// Silently strip the "你必须修改默认密码" flag from /api/auth/me responses on
// desktop. Users on a single-machine install don't benefit from a managed
// password. The Web UI client uses BOTH fetch and axios (which goes through
// XMLHttpRequest), so we patch both code paths.
function isAuthMeUrl(url: string): boolean {
  return /\/api\/auth\/me(?:\?|$)/.test(url)
}

function stripCredentialFlag(text: string): string {
  try {
    const data = JSON.parse(text)
    if (data?.user && data.user.requiresCredentialChange) {
      data.user.requiresCredentialChange = false
      return JSON.stringify(data)
    }
  } catch { /* not JSON */ }
  return text
}

function installFetchPatch(): void {
  const origFetch = window.fetch.bind(window)
  const patchedFetch = (async (input, init) => {
    const res = await origFetch(input, init)
    try {
      const url = typeof input === 'string' ? input : (input as Request).url
      if (url && isAuthMeUrl(url) && res.ok) {
        const text = await res.clone().text()
        const patched = stripCredentialFlag(text)
        if (patched !== text) {
          return new Response(patched, {
            status: res.status,
            statusText: res.statusText,
            headers: res.headers,
          })
        }
      }
    } catch { /* fall through */ }
    return res
  }) as typeof window.fetch
  window.fetch = patchedFetch

  const OrigXHR = window.XMLHttpRequest
  type XHRWithDesktop = XMLHttpRequest & { __hermesDesktopUrl?: string }
  const origOpen = OrigXHR.prototype.open
  OrigXHR.prototype.open = function (
    this: XHRWithDesktop,
    method: string,
    url: string | URL,
    ...rest: unknown[]
  ) {
    this.__hermesDesktopUrl = String(url)
    // @ts-expect-error — forwarding variadic
    return origOpen.call(this, method, url, ...rest)
  }
  const origGetResponse = Object.getOwnPropertyDescriptor(OrigXHR.prototype, 'response')
  const origGetResponseText = Object.getOwnPropertyDescriptor(OrigXHR.prototype, 'responseText')
  if (origGetResponse?.get && origGetResponseText?.get) {
    Object.defineProperty(OrigXHR.prototype, 'responseText', {
      configurable: true,
      get(this: XHRWithDesktop) {
        const raw = origGetResponseText.get!.call(this) as string
        if (this.__hermesDesktopUrl && isAuthMeUrl(this.__hermesDesktopUrl) && typeof raw === 'string') {
          return stripCredentialFlag(raw)
        }
        return raw
      },
    })
    Object.defineProperty(OrigXHR.prototype, 'response', {
      configurable: true,
      get(this: XHRWithDesktop) {
        const raw = origGetResponse.get!.call(this)
        if (this.__hermesDesktopUrl && isAuthMeUrl(this.__hermesDesktopUrl)) {
          if (typeof raw === 'string') return stripCredentialFlag(raw)
          if (raw && typeof raw === 'object' && (raw as { user?: { requiresCredentialChange?: boolean } }).user?.requiresCredentialChange) {
            return { ...(raw as object), user: { ...(raw as { user: object }).user, requiresCredentialChange: false } }
          }
        }
        return raw
      },
    })
  }
}

installFetchPatch()

window.addEventListener('DOMContentLoaded', async () => {
  try {
    const token = await ipcRenderer.invoke('hermes-desktop:get-token')
    if (token) {
      try { localStorage.setItem('AUTH_TOKEN', token) } catch { /* */ }
    }
  } catch {
    /* ignore */
  }
})
