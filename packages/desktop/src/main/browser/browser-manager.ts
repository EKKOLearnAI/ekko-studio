import { BrowserDownloadHistory, type DownloadFileIdentity } from './browser-download-history'
import { downloadBrowserFile } from './browser-download'
import { t } from '../desktop-i18n'
import { realpathSync, mkdirSync, statSync, lstatSync } from 'node:fs'
import { isAbsolute, relative } from 'node:path'
import { BrowserProfileLeases } from './browser-profile-lease'
import { applyBrowserColorScheme, browserBackground, type BrowserColorScheme } from './browser-theme'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import {
  BrowserWindow,
  app,
  dialog,
  Menu,
  session,
  shell,
  WebContentsView,
  type DownloadItem,
  type ProxyConfig,
  type Session,
  type WebContents,
} from 'electron'
import { BrowserAutomation } from './browser-automation'
import { BrowserProfileStore } from './browser-profile-store'
import { BrowserSessionCookieStore } from './browser-session-cookie-store'
import { MAX_BROWSER_TABS } from './browser-types'
import { BROWSER_BATCH_TIMEOUT_MS, parseBrowserBatchActions } from './browser-batch'
import { observeBrowserState, type BrowserObservedState, type BrowserObservedTarget } from './browser-observation'
import {
  BrowserDownloadStore,
  MAX_BROWSER_DOWNLOAD_BYTES,
  fileNameFromResponse,
  readLimitedBody,
  type BrowserDownloadChunk,
  type BrowserDownloadInfo,
  type BrowserUploadFile,
  type BrowserUploadMethod,
  type BrowserUploadResult,
} from './browser-files'
import type {
  BrowserNetworkEntry,
  BrowserPageDialog,
  BrowserAgentControl,
  BrowserBatchResult,
  BrowserBounds,
  BrowserConsoleEntry,
  BrowserBatchAction,
  BrowserInteractAction,
  BrowserInteractionResult,
  BrowserProfileCreateInput,
  BrowserProfileSwitchImpact,
  BrowserProfileUpdateInput,
  BrowserReadTextOptions,
  BrowserSnapshotOptions,
  BrowserSelection,
  BrowserWaitOptions,
  BrowserWaitResult,
  BrowserSitePermission,
  DesktopBrowserDownload,
  DesktopBrowserProfile,
  DesktopBrowserState,
  DesktopBrowserTab,
} from './browser-types'
import { isAllowedBrowserRequest, isAllowedBrowserSubresource, normalizeBrowserUrl, publicBrowserUrl, redactBrowserText } from './browser-url'

interface TabRecord {
  tab: DesktopBrowserTab
  view: WebContentsView
  console: BrowserConsoleEntry[]
  htmlPreviewTitle?: string
  ephemeral?: boolean
  documentGeneration?: number
  openerTabId?: string
  /** Agent right-clicks must reach the page without popping the annotation menu. */
  suppressContextMenuUntil?: number
  /** alert/confirm opened while the agent controls the tab; answered via DevTools instead of a native box. */
  heldDialog?: { info: unknown; callback: unknown }
  /** Electron's own JavaScript dialog handlers, which show the native message box. */
  nativeDialogListeners?: Array<(...args: unknown[]) => void>
}

const AGENT_CONTEXT_MENU_GRACE_MS = 1500

interface BrowserManagerOptions {
  selectElementLabel: string
  selectRegionLabel: string
  onAnnotationRequest: (tabId: string, mode: 'element' | 'region') => void
}

const CONSOLE_LIMIT = 500
const ANNOTATION_WORLD_ID = 999
const ANNOTATION_CANCEL_EVENT = '__hermes_browser_cancel_annotation__'
const ANNOTATION_STATE_KEY = '__hermes_browser_annotation_state__'
const SESSION_COOKIE_PERSIST_DELAY_MS = 750
const SESSION_SHUTDOWN_TIMEOUT_MS = 2_000
const HTML_PREVIEW_MAX_BYTES = 10 * 1024 * 1024

function copyTab(tab: DesktopBrowserTab): DesktopBrowserTab {
  return { ...tab }
}

function nextDownloadPath(directory: string, fileName: string): string {
  const safeFileName = basename(fileName).replace(/[\u0000-\u001f]/g, '_') || 'download'
  const initial = join(directory, safeFileName)
  if (!existsSync(initial)) return initial
  const extension = extname(safeFileName)
  const stem = safeFileName.slice(0, safeFileName.length - extension.length)
  for (let index = 1; index < 10_000; index += 1) {
    const candidate = join(directory, `${stem} (${index})${extension}`)
    if (!existsSync(candidate)) return candidate
  }
  return join(directory, `${stem}-${Date.now()}${extension}`)
}

function proxyConfig(profile: DesktopBrowserProfile): ProxyConfig {
  if (profile.proxyMode === 'system') return { mode: 'system' }
  if (profile.proxyMode === 'fixed_servers') {
    return { mode: 'fixed_servers', proxyRules: profile.proxyRules }
  }
  return { mode: 'direct' }
}

export class BrowserManager {
  private colorScheme: BrowserColorScheme = 'light'
  readonly automation = new BrowserAutomation()
  private readonly profileStore: BrowserProfileStore
  private readonly records = new Map<string, TabRecord>()
  private tabMutationQueue: Promise<void> = Promise.resolve()
  private readonly downloads: DesktopBrowserDownload[] = []
  private readonly downloadedFileIdentities = new Map<string, DownloadFileIdentity>()
  private readonly downloadHistory: BrowserDownloadHistory
  private downloadHistoryCheckpoint = 0
  private readonly downloadActions = new Set<string>()
  private readonly downloadItems = new Map<string, DownloadItem>()
  private readonly agentDownloads = new BrowserDownloadStore()
  private readonly permissions: BrowserSitePermission[] = []
  private readonly browserSessions = new Map<string, Session>()
  private readonly sessionCookieStore = new BrowserSessionCookieStore()
  private readonly sessionCookieRestorePromises = new Map<string, Promise<void>>()
  private readonly sessionCookiePersistQueues = new Map<string, Promise<void>>()
  private readonly sessionCookiePersistTimers = new Map<string, NodeJS.Timeout>()
  private readonly sessionCookieChangeListeners = new Map<string, () => void>()
  private readonly configuredSessions = new Set<string>()
  private readonly configuredSessionProxies = new Map<string, string>()
  private readonly automationVisibleTabs = new Set<string>()
  private readonly attachedTabs = new Set<string>()
  private readonly automationHosts = new Map<string, BrowserWindow>()
  private readonly profileLeases = new BrowserProfileLeases(release => app.once('will-quit', release))
  private readonly activeAnnotationTabs = new Set<string>()
  private readonly annotationMarkerCounts = new Map<string, number>()
  private readonly stateListeners = new Set<(state: DesktopBrowserState) => void>()
  private activeProfileId = ''
  private activeTabId: string | undefined
  private visible = false
  private bounds: BrowserBounds = { x: 0, y: 0, width: 800, height: 600 }

  constructor(private readonly window: BrowserWindow, stateRoot: string, private readonly options?: BrowserManagerOptions) {
    this.profileStore = new BrowserProfileStore(stateRoot)
    this.downloadHistory = new BrowserDownloadHistory(stateRoot)
  }

  async initialize(): Promise<void> {
    await this.profileStore.initialize()
    for (const entry of this.downloadHistory.load(new Set(this.profileStore.list().map(p => p.id)))) {
      this.downloads.push(entry.download)
      if (entry.identity) this.downloadedFileIdentities.set(entry.download.id, entry.identity)
    }
    const profile = this.profileStore.active()
    this.activeProfileId = profile.id
    await this.restoreTabs(profile)
    this.emitState()
  }

  onStateChange(listener: (state: DesktopBrowserState) => void): () => void {
    this.stateListeners.add(listener)
    return () => this.stateListeners.delete(listener)
  }

  state(): DesktopBrowserState {
    return {
      available: true,
      activeProfileId: this.activeProfileId,
      activeTabId: this.activeTabId,
      tabs: [...this.records.values()].map(record => copyTab(record.tab)),
      profiles: this.profileStore.list(),
      downloads: this.downloads.map(item => ({ ...item })),
      permissions: this.permissions.map(item => ({ ...item })),
      visible: this.visible,
      maxTabs: MAX_BROWSER_TABS,
    }
  }

  async setColorScheme(scheme: BrowserColorScheme): Promise<void> {
    this.colorScheme = scheme
    await Promise.all([...this.records.values()].map(record => applyBrowserColorScheme(record.view, scheme)))
  }

  setViewport(bounds: BrowserBounds, visible: boolean): DesktopBrowserState {
    this.bounds = {
      x: Math.max(0, Math.round(bounds.x)),
      y: Math.max(0, Math.round(bounds.y)),
      width: Math.max(1, Math.round(bounds.width)),
      height: Math.max(1, Math.round(bounds.height)),
    }
    this.visible = visible
    this.syncViews()
    this.emitState()
    return this.state()
  }

  async createTab(url = 'about:blank', activate = true): Promise<DesktopBrowserTab> {
    return this.openTab(url, activate, true)
  }

  async createHtmlPreviewTab(html: string, title: string, activate = true): Promise<DesktopBrowserTab> {
    const size = Buffer.byteLength(html, 'utf8')
    if (size > HTML_PREVIEW_MAX_BYTES) throw new Error('HTML preview is too large')
    const previewTitle = String(title || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 256) || 'HTML Preview'
    const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
    return this.openTab('about:blank', activate, true, { dataUrl, title: previewTitle })
  }

  private async openTab(
    url: string,
    activate: boolean,
    waitForLoad: boolean,
    htmlPreview?: { dataUrl: string; title: string },
    openerTabId?: string,
  ): Promise<DesktopBrowserTab> {
    const normalizedUrl = normalizeBrowserUrl(url, { allowBlank: true })
    const { record, loading } = await this.mutateTabs(async () => {
      const profile = this.requireProfile(this.activeProfileId)
      const record = await this.buildTab(profile, normalizedUrl)
      record.openerTabId = openerTabId
      // Map insertion order is creation order, independent of tab activation.
      while (this.records.size >= MAX_BROWSER_TABS) {
        await this.closeTabRecord(this.records.keys().next().value!)
      }
      if (htmlPreview) {
        record.htmlPreviewTitle = htmlPreview.title
        record.ephemeral = true
        record.tab.title = htmlPreview.title
      }
      this.records.set(record.tab.id, record)
      if (activate || !this.activeTabId) this.activeTabId = record.tab.id
      this.syncViews()
      const loading = record.view.webContents.loadURL(htmlPreview?.dataUrl || normalizedUrl).catch(() => {
        record.tab.loading = false
        this.refreshTab(record)
        this.emitState()
      })
      await this.persistTabs()
      this.emitState()
      return { record, loading }
    })
    // A slow page must not block another tab's creation or closure.
    if (waitForLoad) await loading
    return copyTab(record.tab)
  }

  private mutateTabs<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tabMutationQueue.then(operation)
    this.tabMutationQueue = result.then(() => undefined, () => undefined)
    return result
  }

  async closeTab(tabId: string): Promise<DesktopBrowserState> {
    return this.mutateTabs(() => this.closeTabRecord(tabId))
  }

  private async closeTabRecord(tabId: string): Promise<DesktopBrowserState> {
    const record = this.requireTab(tabId)
    await this.clearAnnotations(tabId, false)
    const ids = [...this.records.keys()]
    const index = ids.indexOf(tabId)
    const contents = record.view.webContents
    this.window.contentView.removeChildView(record.view)
    this.automation.detach(tabId, contents)
    this.automationHosts.get(tabId)?.contentView.removeChildView(record.view)
    this.automationHosts.get(tabId)?.destroy()
    this.automationHosts.delete(tabId)
    this.attachedTabs.delete(tabId)
    this.automationVisibleTabs.delete(tabId)
    if (contents && !contents.isDestroyed()) contents.close()
    this.records.delete(tabId)
    if (this.activeTabId === tabId) this.activeTabId = [...this.records.keys()][Math.max(0, index - 1)]
    await this.persistTabs()
    this.syncViews()
    this.emitState()
    return this.state()
  }

  activateTab(tabId: string): DesktopBrowserState {
    this.requireTab(tabId)
    this.activeTabId = tabId
    this.syncViews()
    this.emitState()
    return this.state()
  }

  async navigate(tabId: string, url: string): Promise<DesktopBrowserTab> {
    const record = this.requireTab(tabId)
    const normalized = normalizeBrowserUrl(url)
    await record.view.webContents.loadURL(normalized)
    return copyTab(record.tab)
  }

  async navigationAction(tabId: string, action: 'back' | 'forward' | 'reload' | 'stop'): Promise<DesktopBrowserTab> {
    const record = this.requireTab(tabId)
    const navigation = record.view.webContents.navigationHistory
    if (action === 'back' && navigation.canGoBack()) navigation.goBack()
    else if (action === 'forward' && navigation.canGoForward()) navigation.goForward()
    else if (action === 'reload') record.view.webContents.reload()
    else if (action === 'stop') record.view.webContents.stop()
    return copyTab(record.tab)
  }

  async createProfile(input: BrowserProfileCreateInput): Promise<DesktopBrowserProfile> {
    if (input.rootDirectory) {
      const sessionPath = join(input.rootDirectory, 'data')
      this.validateSessionScope(sessionPath)
      await this.profileLeases.acquire(sessionPath)
    }
    const profile = await this.profileStore.create(input)
    this.emitState()
    return profile
  }

  async chooseProfileRootDirectory(defaultPath?: string): Promise<string | null> {
    const result = await dialog.showOpenDialog(this.window, {
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: String(defaultPath || '').trim() || app.getPath('documents'),
    })
    return result.canceled ? null : result.filePaths[0] || null
  }

  async renameProfile(profileId: string, name: string): Promise<DesktopBrowserProfile> {
    const profile = await this.profileStore.renameProfile(profileId, name)
    this.emitState()
    return profile
  }

  profileSwitchImpact(): BrowserProfileSwitchImpact {
    const pendingAnnotations = new Set([...this.activeAnnotationTabs, ...this.annotationMarkerCounts.keys()]).size
    return {
      activeAgentRuns: [...this.records.values()].filter(record => record.tab.agentControl !== 'idle').length,
      activeDownloads: this.downloads.filter(item => item.state === 'progressing').length,
      pendingAnnotations,
      openTabs: this.records.size,
      requiresConfirmation: pendingAnnotations > 0 || this.downloads.some(item => item.state === 'progressing') || [...this.records.values()].some(record => record.tab.agentControl !== 'idle'),
    }
  }

  async switchProfile(profileId: string, force = false): Promise<DesktopBrowserState> {
    if (profileId === this.activeProfileId) return this.state()
    const impact = this.profileSwitchImpact()
    if (impact.requiresConfirmation && !force) throw new Error('Profile switch requires confirmation while an Agent or download is active')
    await Promise.all([...new Set([...this.activeAnnotationTabs, ...this.annotationMarkerCounts.keys()])].map(tabId => this.clearAnnotations(tabId)))
    await this.persistTabs()
    await this.flushProfileSession(this.requireProfile(this.activeProfileId))
    this.destroyViews()
    const profile = await this.profileStore.setActive(profileId)
    this.activeProfileId = profile.id
    await this.restoreTabs(profile)
    this.emitState()
    return this.state()
  }

  async updateProfile(profileId: string, input: BrowserProfileUpdateInput): Promise<DesktopBrowserProfile> {
    const previous = { ...this.requireProfile(profileId), tabs: [...this.requireProfile(profileId).tabs] }
    const nextRoot = String(input.rootDirectory || previous.rootPath).trim()
    const nextProxyMode = input.proxyMode || previous.proxyMode
    const nextProxyRules = nextProxyMode === 'fixed_servers'
      ? String(input.proxyRules ?? previous.proxyRules).trim()
      : ''
    const rootChanged = resolve(nextRoot) !== resolve(previous.rootPath)
    if (rootChanged) {
      this.validateSessionScope(join(nextRoot, 'data'))
      await this.profileLeases.acquire(previous.sessionPath)
      await this.profileLeases.acquire(join(nextRoot, 'data'))
    }
    const connectionChanged = rootChanged
      || nextProxyMode !== previous.proxyMode
      || nextProxyRules !== previous.proxyRules
    const rebuildActiveProfile = profileId === this.activeProfileId && connectionChanged
    if (rebuildActiveProfile) {
      await this.persistTabs()
      await this.flushProfileSession(previous)
    }
    const profile = await this.profileStore.update(profileId, input)
    if (rebuildActiveProfile) {
      this.destroyViews()
      if (rootChanged) this.releaseProfileSession(previous.sessionPath)
      await this.restoreTabs(profile)
    }
    this.emitState()
    return profile
  }

  async deleteProfile(profileId: string): Promise<DesktopBrowserState> {
    if (profileId === this.activeProfileId) throw new Error('Switch away from a profile before deleting it')
    await this.profileLeases.acquire(this.requireProfile(profileId).sessionPath)
    const removed = await this.profileStore.deleteProfile(profileId)
    for (let i = this.downloads.length - 1; i >= 0; i--) {
      if (this.downloads[i].profileId === profileId) {
        this.downloadedFileIdentities.delete(this.downloads[i].id)
        this.downloads.splice(i, 1)
      }
    }
    this.persistDownloadHistory()
    const managedRoot = resolve(this.profileStore.root, 'profiles')
    if (resolve(removed.sessionPath).startsWith(`${managedRoot}${process.platform === 'win32' ? '\\' : '/'}`)) {
      await shell.trashItem(dirname(removed.sessionPath)).catch(() => undefined)
    }
    this.emitState()
    return this.state()
  }

  async clearProfileData(profileId: string, kind: 'cache' | 'site-data' | 'permission-audit'): Promise<DesktopBrowserState> {
    const profile = this.requireProfile(profileId)
    if (kind === 'permission-audit') {
      for (let index = this.permissions.length - 1; index >= 0; index -= 1) {
        if (this.permissions[index].profileId === profileId) this.permissions.splice(index, 1)
      }
    } else {
      const browserSession = await this.profileSession(profile)
      await this.waitForSessionCookieRestore(profile)
      if (kind === 'cache') await browserSession.clearCache()
      else {
        await browserSession.clearStorageData()
        await this.persistSessionCookies(profile, browserSession)
        browserSession.flushStorageData()
        await browserSession.cookies.flushStore()
      }
      if (profileId === this.activeProfileId) {
        for (const record of this.records.values()) record.view.webContents.reload()
      }
    }
    this.emitState()
    return this.state()
  }

  private persistDownloadHistory(checkpoint = false): void {
    if (checkpoint && Date.now() - this.downloadHistoryCheckpoint < 1000) return
    try {
      this.downloadHistory.save(this.downloads, this.downloadedFileIdentities)
      this.downloadHistoryCheckpoint = Date.now()
    } catch (error) { console.warn('[desktop-browser] unable to persist download history:', error) }
  }

  refreshDownloads(): DesktopBrowserState {
    for (const item of this.downloads) {
      if (item.state !== 'completed' || this.downloadItems.has(item.id)) continue
      item.fileAvailable = false
      try {
        if (!item.savePath || !isAbsolute(item.savePath)) continue
        const current = lstatSync(item.savePath)
        const original = this.downloadedFileIdentities.get(item.id)
        item.fileAvailable = current.isFile() && !!original && (
          current.dev === original.dev && current.ino === original.ino && current.size === original.size
          && current.mtimeMs === original.mtimeMs)
      } catch { /* File moved/deleted externally; keep the history record. */ }
    }
    this.emitState()
    return this.state()
  }

  async downloadAction(downloadId: string, action: 'open' | 'reveal' | 'remove' | 'trash'): Promise<DesktopBrowserState> {
    if (!['open', 'reveal', 'remove', 'trash'].includes(action)) throw new Error('BROWSER_DOWNLOAD_INVALID_ACTION')
    if (this.downloadActions.has(downloadId)) throw new Error('BROWSER_DOWNLOAD_ACTIVE')
    this.downloadActions.add(downloadId)
    try { return await this.performDownloadAction(downloadId, action) }
    finally { this.downloadActions.delete(downloadId) }
  }

  private async performDownloadAction(downloadId: string, action: 'open' | 'reveal' | 'remove' | 'trash'): Promise<DesktopBrowserState> {
    const download = this.downloads.find(item => item.id === downloadId)
    if (!download) throw new Error('BROWSER_DOWNLOAD_NOT_FOUND')
    // Resolve only Desktop-owned records, never a path supplied by the renderer.
    if (this.downloadItems.has(downloadId) || download.state === 'progressing') throw new Error('BROWSER_DOWNLOAD_ACTIVE')
    if (action === 'remove') {
      this.downloads.splice(this.downloads.indexOf(download), 1)
      this.downloadedFileIdentities.delete(downloadId)
    } else {
      const path = download.savePath
      if (download.state !== 'completed' || !path || !isAbsolute(path)) throw new Error('BROWSER_DOWNLOAD_FILE_UNAVAILABLE')
      let regular = false
      let identity: ReturnType<typeof lstatSync> | undefined
      try { identity = lstatSync(path); regular = identity.isFile() } catch { /* moved or deleted outside Desktop */ }
      const original = this.downloadedFileIdentities.get(downloadId)
      if (!original) regular = false
      if (original && identity && (original.dev !== identity.dev || original.ino !== identity.ino
        || original.size !== identity.size || original.mtimeMs !== identity.mtimeMs)) regular = false
      if (!regular) throw new Error('BROWSER_DOWNLOAD_FILE_UNAVAILABLE')
      if (action === 'open') {
        if (await shell.openPath(path)) throw new Error('BROWSER_DOWNLOAD_OPEN_FAILED')
      } else if (action === 'reveal') {
        shell.showItemInFolder(path)
      } else if (action === 'trash') {
        const result = await dialog.showMessageBox(this.window, {
          type: 'warning', title: t('browser.trashDownloadTitle'),
          message: t('browser.trashDownloadMessage', { name: download.fileName }),
          buttons: [t('common.cancel'), t('browser.trashDownloadConfirm')], defaultId: 0, cancelId: 0,
        })
        if (result.response !== 1) return this.state()
        // Revalidate after the asynchronous native confirmation. Never trash a directory/symlink.
        try {
          const current = lstatSync(path)
          regular = current.isFile() && current.dev === identity?.dev && current.ino === identity?.ino
            && current.mtimeMs === identity?.mtimeMs && current.size === identity?.size
        } catch { regular = false }
        if (!regular) throw new Error('BROWSER_DOWNLOAD_FILE_UNAVAILABLE')
        await shell.trashItem(path)
        // Other records can point at the same overwritten destination; leave their history intact.
        this.downloads.splice(this.downloads.indexOf(download), 1)
        this.downloadedFileIdentities.delete(downloadId)
      } else throw new Error('BROWSER_DOWNLOAD_INVALID_ACTION')
    }
    this.persistDownloadHistory()
    this.emitState()
    return this.state()
  }

  cancelDownload(downloadId: string): DesktopBrowserState {
    const download = this.downloads.find(item => item.id === downloadId)
    if (!download) throw new Error('Browser download not found')
    if (download.state !== 'progressing') return this.state()
    const item = this.downloadItems.get(downloadId)
    if (!item) throw new Error('Browser download is no longer active')
    download.state = 'cancelled'
    this.downloadItems.delete(downloadId)
    item.cancel()
    this.persistDownloadHistory()
    this.emitState()
    return this.state()
  }

  async snapshot(tabId: string, options: BrowserSnapshotOptions = {}) {
    const record = this.requireTab(tabId)
    let snapshot = await this.automation.snapshot(tabId, record.view.webContents, options)
    // Loading tabs can expose only the document root for a short time. Never retry an action.
    for (let attempt = 0; !options.snapshotId && snapshot.totalNodes! <= 1 && attempt < 3; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 100))
      snapshot = await this.automation.snapshot(tabId, record.view.webContents, options)
    }
    return snapshot
  }

  async readText(tabId: string, options: BrowserReadTextOptions) {
    const record = this.requireTab(tabId)
    return this.automation.readText(tabId, record.view.webContents, options)
  }

  async interact(tabId: string, action: BrowserInteractAction, assertActive: () => void = () => {}): Promise<BrowserInteractionResult> {
    assertActive()
    const record = this.requireTab(tabId)
    const before = this.automation.observedState(tabId)
    const options = this.automation.snapshotSelection(tabId)
    const targets = this.automation.observedTargets(tabId, 'snapshot_id' in action ? action.snapshot_id : undefined, [action])
    const generation = record.documentGeneration || 0
    const tabs = new Set(this.records.keys())
    const started = Date.now()
    return this.withAutomationView(record, async () => {
      this.allowAgentContextMenu(record, [action])
      await this.automation.interact(tabId, record.view.webContents, action, assertActive)
      const pointer = this.automation.lastPointer(record.view.webContents)
      const evidence = await this.observeOperation(record, before, targets, options, generation, tabs, assertActive, started)
      if (pointer && evidence.observation) evidence.observation.pointer = pointer
      return { ...copyTab(record.tab), ...evidence }
    })
  }

  private allowAgentContextMenu(record: TabRecord, actions: Array<BrowserInteractAction | BrowserBatchAction>): void {
    if (actions.some(action => action.action === 'right_click' || action.action === 'click_at' && action.button === 'right')) {
      record.suppressContextMenuUntil = Date.now() + AGENT_CONTEXT_MENU_GRACE_MS
    }
  }

  /**
   * While the agent controls a tab, alert/confirm stay off the user's screen: the agent sees
   * them as observation.dialog and answers through DevTools. Electron's internal -run-dialog
   * handler (which shows the native box) is only used for the user's own browsing, or when
   * the user takes over while a dialog is still unanswered.
   */
  private routePageDialogs(record: TabRecord): void {
    const emitter = record.view.webContents as unknown as NodeJS.EventEmitter
    if (typeof emitter.listeners !== 'function') return
    const native = emitter.listeners('-run-dialog') as Array<(...args: unknown[]) => void>
    if (!native.length) return
    record.nativeDialogListeners = native
    emitter.removeAllListeners('-run-dialog')
    emitter.on('-run-dialog', (info: unknown, callback: unknown) => {
      if (record.tab.agentControl === 'active') {
        record.heldDialog = { info, callback }
        return
      }
      for (const listener of native) listener.call(emitter, info, callback)
    })
  }

  private releaseHeldDialog(record: TabRecord): void {
    const held = record.heldDialog
    if (!held) return
    record.heldDialog = undefined
    // Only hand an unanswered dialog to the user; the page would otherwise stay blocked.
    if (!this.automation.pageDialog(record.view.webContents)) return
    for (const listener of record.nativeDialogListeners || []) listener.call(record.view.webContents, held.info, held.callback)
  }

  pageDialog(tabId: string): BrowserPageDialog | undefined {
    return this.automation.pageDialog(this.requireTab(tabId).view.webContents)
  }

  async handleDialog(tabId: string, accept: boolean, promptText?: string): Promise<BrowserInteractionResult & { dialog: BrowserPageDialog }> {
    const record = this.requireTab(tabId)
    const before = this.automation.observedState(tabId)
    const options = this.automation.snapshotSelection(tabId)
    const generation = record.documentGeneration || 0
    const tabs = new Set(this.records.keys())
    const dialog = await this.automation.handleDialog(tabId, record.view.webContents, accept, promptText)
    // DevTools already answered the page; Electron's callback for the held dialog is dropped, as it
    // is when Electron aborts its own box.
    record.heldDialog = undefined
    const evidence = await this.observeOperation(record, before, [], options, generation, tabs, () => {}, Date.now())
    return { ...copyTab(record.tab), ...evidence, dialog }
  }

  networkEntries(tabId: string): BrowserNetworkEntry[] {
    return this.automation.networkEntries(this.requireTab(tabId).view.webContents)
  }

  clearNetwork(tabId: string): void {
    this.automation.clearNetwork(this.requireTab(tabId).view.webContents)
  }

  private async observeOperation(
    record: TabRecord, before: BrowserObservedState | undefined, targets: BrowserObservedTarget[],
    options: BrowserSnapshotOptions, generation: number, tabs: Set<string>, assertActive: () => void, started = Date.now(),
  ): Promise<Pick<BrowserInteractionResult, 'snapshot' | 'snapshotError' | 'observation'>> {
    const tabId = record.tab.id
    const contents = record.view.webContents
    // The page is blocked until the dialog is answered, so report it instead of reading a snapshot.
    const dialog = this.automation.pageDialog(contents)
    if (dialog) {
      return { observation: { status: 'observed', tabId, changed: true, dialog,
        hint: `The page opened a ${dialog.type} dialog and is blocked until it is answered. Call ekko_studio_browser_dialog with action=accept or action=dismiss, then take a new snapshot.` } }
    }
    try {
      assertActive()
      const newDocument = () => (record.documentGeneration || 0) !== generation
      const read = async () => {
        try { return await this.snapshot(tabId, newDocument() ? {} : options) }
        catch (error) {
          // A clicked control may remove its own scoped region.
          if (!options.selector) throw error
          assertActive()
          return this.snapshot(tabId)
        }
      }
      const observe = () => observeBrowserState(newDocument() ? undefined : before,
        this.automation.observedState(tabId)!, newDocument() ? [] : targets)
      let snapshot = await read()
      let observation = observe()
      // Read-only settling catches async rendering and popup creation; dispatched actions are never replayed.
      for (let attempt = 0; attempt < 3; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 100))
        assertActive()
        snapshot = await read()
        observation = observe()
        if (observation.changed && !record.view.webContents.isLoading()) break
      }
      const openedTabs = [...this.records.values()].filter(item => !tabs.has(item.tab.id) && item.openerTabId === tabId)
        .map(item => ({ id: item.tab.id, title: redactBrowserText(item.tab.title), url: publicBrowserUrl(item.tab.url) }))
      observation.tabId = tabId
      observation.navigation = newDocument() ? 'new_document' : before && before.url !== snapshot.url ? 'same_document' : undefined
      if (newDocument()) observation.changed = true
      if (openedTabs.length) {
        observation.openedTabs = openedTabs
        observation.changed = true
        observation.hint = 'A new tab opened. Use its tab_id and snapshot to inspect the destination; the originating tab is not destination evidence.'
        if (openedTabs.length === 1) snapshot = await this.snapshot(openedTabs[0].id)
      }
      const fileChooser = this.automation.fileChooserSince(contents, started)
      if (fileChooser) {
        observation.fileChooser = fileChooser
        observation.changed = true
        observation.hint = `The page tried to open a file picker; the OS dialog was suppressed. Call ekko_studio_browser_upload without ref to give it ${fileChooser.multiple ? 'files' : 'one file'}.`
      }
      assertActive()
      return { snapshot, observation }
    } catch (error) {
      const lateDialog = this.automation.pageDialog(contents)
      if (lateDialog) {
        return { observation: { status: 'observed', tabId, changed: true, dialog: lateDialog,
          hint: `The page opened a ${lateDialog.type} dialog. Call ekko_studio_browser_dialog with action=accept or action=dismiss, then take a new snapshot.` } }
      }
      assertActive()
      const message = redactBrowserText(error instanceof Error ? error.message : String(error), 500)
      return { snapshotError: message, observation: { status: 'unavailable',
        hint: 'The action was already dispatched, but follow-up evidence is unavailable. Read a fresh snapshot before deciding what to do; do not replay the action automatically.' } }
    }
  }

  async interactBatch(tabId: string, input: unknown, snapshotId: unknown, assertControl: () => void): Promise<BrowserBatchResult> {
    assertControl()
    const record = this.requireTab(tabId)
    return this.withAutomationView(record, () => this.runBatch(tabId, input, snapshotId, assertControl))
  }

  private async runBatch(tabId: string, input: unknown, snapshotId: unknown, assertControl: () => void): Promise<BrowserBatchResult> {
    const actions = parseBrowserBatchActions(input)
    const record = this.requireTab(tabId)
    const snapshotOptions = this.automation.snapshotSelection(tabId)
    const prepared = this.automation.prepareBatch(tabId, snapshotId, actions)
    const before = this.automation.observedState(tabId)
    const targets = this.automation.observedTargets(tabId, snapshotId, actions)
    const tabs = new Set(this.records.keys())
    const generation = record.documentGeneration || 0
    const deadline = Date.now() + BROWSER_BATCH_TIMEOUT_MS
    const assertActive = () => {
      assertControl()
      if (Date.now() >= deadline) throw new Error('Browser batch timed out; remaining actions were skipped')
      if (this.records.get(tabId) !== record || record.view.webContents.isDestroyed()) throw new Error('Browser tab is closed')
      if ((record.documentGeneration || 0) !== generation) {
        throw new Error('Browser page navigated; take a new snapshot before continuing')
      }
    }
    const result: BrowserBatchResult = { tabId, completed: 0, total: actions.length, results: [] }
    const started = Date.now()
    this.allowAgentContextMenu(record, actions)
    for (let index = 0; index < prepared.length; index += 1) {
      const action = actions[index].action
      // A page dialog blocks the page; the remaining steps would act on an unknown state.
      if (result.completed !== index || this.automation.pageDialog(record.view.webContents)) {
        result.results.push({ index, action, status: 'skipped' })
        continue
      }
      try {
        assertActive()
        const resolved = await this.automation.resolveBatchAction(tabId, record.view.webContents, prepared[index])
        assertActive()
        await this.automation.interact(tabId, record.view.webContents, resolved, assertActive)
        result.completed += 1
        result.results.push({ index, action, status: 'completed' })
      } catch (error) {
        result.results.push({ index, action, status: 'failed', error: redactBrowserText(error instanceof Error ? error.message : String(error), 500) })
      }
    }
    try {
      assertControl()
      if (Date.now() >= deadline) throw new Error('Browser batch timed out')
      Object.assign(result, await this.observeOperation(record, before, targets.filter(target => target.actionIndex < result.completed), snapshotOptions, generation, tabs, () => {
        assertControl()
        if (Date.now() >= deadline) throw new Error('Browser batch timed out')
      }, started))
      assertControl()
    } catch (error) {
      delete result.snapshot
      result.snapshotError = redactBrowserText(error instanceof Error ? error.message : String(error), 500)
    }
    return result
  }

  async upload(
    tabId: string, snapshotId: string | undefined, ref: string | undefined, files: BrowserUploadFile[], method: BrowserUploadMethod,
    assertActive: () => void = () => {},
  ): Promise<BrowserInteractionResult & { upload: BrowserUploadResult }> {
    assertActive()
    const record = this.requireTab(tabId)
    const before = this.automation.observedState(tabId)
    const options = this.automation.snapshotSelection(tabId)
    const generation = record.documentGeneration || 0
    const tabs = new Set(this.records.keys())
    return this.withAutomationView(record, async () => {
      const upload = await this.automation.upload(tabId, record.view.webContents, snapshotId, ref, files, method, assertActive)
      const evidence = await this.observeOperation(record, before, [], options, generation, tabs, assertActive)
      return { ...copyTab(record.tab), ...evidence, upload }
    })
  }

  async wait(tabId: string, options: BrowserWaitOptions, assertActive: () => void = () => {}): Promise<BrowserWaitResult> {
    const record = this.requireTab(tabId)
    return this.withAutomationView(record, () => this.automation.wait(tabId, record.view.webContents, options, () => {
      assertActive()
      if (this.records.get(tabId) !== record || record.view.webContents.isDestroyed()) throw new Error('Browser tab is closed')
    }))
  }

  /** Fetch a link/media target with the tab's own session and hold it in memory for chunked reads. */
  async downloadStart(tabId: string, source: { url?: string; snapshotId?: string; ref?: string }): Promise<BrowserDownloadInfo> {
    const record = this.requireTab(tabId)
    const contents = record.view.webContents
    let url = source.url || ''
    let suggested = ''
    if (!url) {
      if (!source.snapshotId || !source.ref) throw new Error('url or snapshot_id and ref are required')
      ;({ url, fileName: suggested } = await this.automation.downloadSource(tabId, contents, source.snapshotId, source.ref))
    } else if (!/^(?:blob|data):/i.test(url)) {
      url = new URL(url, contents.getURL()).toString()
    }
    if (/^blob:/i.test(url)) {
      const blob = await this.automation.readPageBlob(contents, url, MAX_BROWSER_DOWNLOAD_BYTES)
      return this.agentDownloads.add(blob.data, { fileName: suggested || 'download', mimeType: blob.type, sourceUrl: 'blob:' })
    }
    if (/^data:/i.test(url)) {
      const response = await fetch(url)
      const data = await readLimitedBody(response, MAX_BROWSER_DOWNLOAD_BYTES)
      return this.agentDownloads.add(data, { fileName: suggested || 'download', mimeType: (response.headers.get('content-type') || '').split(';')[0], sourceUrl: 'data:' })
    }
    // The tab session carries the page's cookies and proxy, so authenticated files download like a user click.
    // Redirects are followed manually so every hop passes the same address policy as navigation.
    const referer = /^https?:/i.test(contents.getURL()) ? `${new URL(contents.getURL()).origin}/` : undefined
    const downloaded = await downloadBrowserFile(contents.session, url, referer)
    return this.agentDownloads.add(downloaded.data, {
      fileName: fileNameFromResponse(downloaded.url, downloaded.contentDisposition, suggested),
      mimeType: downloaded.mimeType, sourceUrl: publicBrowserUrl(downloaded.url),
    })
  }

  downloadRead(downloadId: string, offset: number): BrowserDownloadChunk {
    return this.agentDownloads.read(downloadId, offset)
  }

  async screenshot(tabId: string, fullPage = false) {
    const record = this.requireTab(tabId)
    return this.withAutomationView(record, () => this.automation.screenshot(tabId, record.view.webContents, fullPage))
  }

  consoleEntries(tabId: string): BrowserConsoleEntry[] {
    return this.requireTab(tabId).console.map(entry => ({ ...entry }))
  }

  clearConsole(tabId: string): void {
    this.requireTab(tabId).console = []
  }

  setAgentControl(tabId: string, control: BrowserAgentControl, label?: string, action?: string): void {
    const record = this.requireTab(tabId)
    const tab = record.tab
    if ((tab.agentControl === 'active') !== (control === 'active')) {
      // Agent clicks on upload buttons must not open the OS file dialog on the user's screen.
      void this.automation.setFileChooserInterception(record.view.webContents, control === 'active').catch(() => undefined)
    }
    tab.agentControl = control
    if (control !== 'active') this.releaseHeldDialog(record)
    tab.agentLabel = label
    tab.agentAction = action
    this.emitState()
  }

  revokeAgentControl(tabId: string): void {
    this.setAgentControl(tabId, 'idle')
  }

  cancelAgentOperation(tabId: string): void {
    const record = this.requireTab(tabId)
    if (record.view.webContents.isLoading()) record.view.webContents.stop()
    this.automation.invalidate(tabId)
    this.revokeAgentControl(tabId)
  }

  async annotate(tabId: string, mode: 'element' | 'region'): Promise<BrowserSelection> {
    const record = this.requireTab(tabId)
    if (this.activeAnnotationTabs.has(tabId)) throw new Error('An annotation is already active in this tab')
    const marker = (this.annotationMarkerCounts.get(tabId) || 0) + 1
    this.visible = true
    this.activeTabId = tabId
    this.syncViews()
    this.activeAnnotationTabs.add(tabId)
    this.emitState()
    try {
      const selected = await record.view.webContents.executeJavaScriptInIsolatedWorld(ANNOTATION_WORLD_ID, [{
      code: `new Promise((resolve, reject) => {
        const mode = ${JSON.stringify(mode)};
        const marker = ${marker};
        const annotationStateKey = ${JSON.stringify(ANNOTATION_STATE_KEY)};
        const root = document.documentElement;
        let annotationState = globalThis[annotationStateKey];
        if (!annotationState || !annotationState.host?.isConnected) {
          const host = document.createElement('div');
          Object.assign(host.style, { position:'fixed', inset:'0', zIndex:'2147483646', pointerEvents:'none' });
          root.appendChild(host);
          const shadowRoot = host.attachShadow({ mode:'closed' });
          const marks = new Map();
          let refreshFrame = 0;
          const positionMark = mark => {
            let r;
            if (mark.target?.isConnected) {
              const rect=mark.target.getBoundingClientRect();
              r={x:rect.left,y:rect.top,width:rect.width,height:rect.height};
            } else if (mark.documentRegion) {
              r={x:mark.documentRegion.x-scrollX,y:mark.documentRegion.y-scrollY,width:mark.documentRegion.width,height:mark.documentRegion.height};
            } else return;
            Object.assign(mark.box.style, { display:'block', left:r.x+'px', top:r.y+'px', width:r.width+'px', height:r.height+'px' });
            const below=innerHeight-(r.y+r.height)>=64;
            Object.assign(mark.badge.style, below ? { top:'calc(100% + 4px)', bottom:'auto' } : { top:'auto', bottom:'calc(100% + 4px)' });
            const alignRight=r.x+300>innerWidth;
            Object.assign(mark.badge.style, alignRight ? { left:'auto', right:'-2px' } : { left:'-2px', right:'auto' });
          };
          const refresh = () => { marks.forEach(positionMark); };
          const track = () => { refresh(); refreshFrame=requestAnimationFrame(track); };
          const destroy = () => {
            if(refreshFrame)cancelAnimationFrame(refreshFrame);
            host.remove();
            delete globalThis[annotationStateKey];
          };
          annotationState = { host, root:shadowRoot, marks, positionMark, refresh, destroy };
          globalThis[annotationStateKey] = annotationState;
          refreshFrame=requestAnimationFrame(track);
        }
        const overlay = document.createElement('div');
        const box = document.createElement('div');
        const badge = document.createElement('span');
        Object.assign(overlay.style, { position:'fixed', inset:'0', zIndex:'2147483647', cursor:'crosshair', background:'rgba(59,130,246,.04)' });
        Object.assign(box.style, { position:'fixed', display:'none', pointerEvents:'none', border:'2px solid #3b82f6', background:'rgba(59,130,246,.14)', boxSizing:'border-box' });
        Object.assign(badge.style, { position:'absolute', left:'-2px', top:'calc(100% + 4px)', maxWidth:'min(300px, calc(100vw - 16px))', maxHeight:'52px', padding:'3px 7px', overflow:'hidden', color:'#fff', background:'rgba(37,99,235,.96)', borderRadius:'6px', boxShadow:'0 3px 12px rgba(15,23,42,.28)', whiteSpace:'pre-wrap', overflowWrap:'anywhere', font:'600 12px/16px system-ui,sans-serif', boxSizing:'border-box' });
        badge.textContent = String(marker);
        box.setAttribute('data-hermes-browser-annotation-mark', String(marker));
        box.appendChild(badge);
        root.appendChild(overlay);
        annotationState.root.appendChild(box);
        const mark = { box, badge, target:null, documentRegion:null };
        annotationState.marks.set(marker, mark);
        let start = null, moveHandler = null, clickHandler = null, finished = false;
        const removePersistentMark = () => { box.remove(); annotationState.marks.delete(marker); if(!annotationState.marks.size)annotationState.destroy(); };
        const cleanup = removeMark => { overlay.remove(); if(removeMark)removePersistentMark(); removeEventListener('keydown', onKey, true); removeEventListener(${JSON.stringify(ANNOTATION_CANCEL_EVENT)}, onCancel, true); if(moveHandler)removeEventListener('mousemove',moveHandler,true); if(clickHandler)removeEventListener('click',clickHandler,true); };
        const draw = r => { Object.assign(box.style, { display:'block', left:r.x+'px', top:r.y+'px', width:r.width+'px', height:r.height+'px' }); const below=innerHeight-(r.y+r.height)>=64; Object.assign(badge.style, below ? { top:'calc(100% + 4px)', bottom:'auto' } : { top:'auto', bottom:'calc(100% + 4px)' }); const alignRight=r.x+300>innerWidth; Object.assign(badge.style, alignRight ? { left:'auto', right:'-2px' } : { left:'-2px', right:'auto' }); };
        const finish = (region, element, target) => { if(finished)return; finished=true; mark.target=target || null; mark.documentRegion={x:region.x+scrollX,y:region.y+scrollY,width:region.width,height:region.height}; annotationState.positionMark(mark); overlay.onpointerdown=null; overlay.onpointermove=null; overlay.onpointerup=null; cleanup(false); resolve({ region, element, viewport:{ width:innerWidth, height:innerHeight, scaleFactor:devicePixelRatio || 1 } }); };
        const onKey = event => { if (event.key === 'Escape') { event.preventDefault(); cleanup(true); reject(new Error('Annotation cancelled')); } };
        const onCancel = () => { cleanup(true); reject(new Error('Annotation cancelled')); };
        addEventListener('keydown', onKey, true);
        addEventListener(${JSON.stringify(ANNOTATION_CANCEL_EVENT)}, onCancel, true);
        if (mode === 'element') {
          const elementBelow = (x, y) => { overlay.style.visibility='hidden'; box.style.visibility='hidden'; const target=document.elementFromPoint(x,y); overlay.style.visibility=''; box.style.visibility=''; return target; };
          moveHandler = event => {
            if(finished)return;
            const target = elementBelow(event.clientX, event.clientY);
            if (!target || target === overlay || target === box) return;
            const r = target.getBoundingClientRect(); draw({ x:r.left, y:r.top, width:r.width, height:r.height });
          };
          clickHandler = event => {
            if(finished)return;
            event.preventDefault(); event.stopImmediatePropagation();
            const target = elementBelow(event.clientX, event.clientY);
            if (!target) return;
            const r = target.getBoundingClientRect();
            const safeIdentifier = value => { const text=String(value||'').slice(0,80); return text && /^[A-Za-z0-9_-]+$/.test(text) && !/(token|secret|password|auth|session|key)/i.test(text) ? text : undefined; };
            finish({ x:r.left, y:r.top, width:r.width, height:r.height }, { role:String(target.getAttribute('role') || '').slice(0,40) || undefined, name:String(target.getAttribute('aria-label') || target.textContent || '').trim().slice(0,120) || undefined, tag:target.tagName.toLowerCase(), id:safeIdentifier(target.id), classNames:[...target.classList].map(safeIdentifier).filter(Boolean).slice(0,8) }, target);
          };
          addEventListener('mousemove', moveHandler, true);
          addEventListener('click', clickHandler, true);
        } else {
          overlay.onpointerdown = event => { if(finished)return; start = { x:event.clientX, y:event.clientY }; overlay.setPointerCapture(event.pointerId); };
          overlay.onpointermove = event => { if (finished || !start) return; const x=Math.min(start.x,event.clientX), y=Math.min(start.y,event.clientY); draw({x,y,width:Math.abs(event.clientX-start.x),height:Math.abs(event.clientY-start.y)}); };
          overlay.onpointerup = event => { if (finished || !start) return; const region={x:Math.min(start.x,event.clientX),y:Math.min(start.y,event.clientY),width:Math.abs(event.clientX-start.x),height:Math.abs(event.clientY-start.y)}; if(region.width<4||region.height<4){cleanup(true);reject(new Error('Selection is too small'));return;} finish(region); };
        }
      })`,
      }], true) as { region: BrowserBounds; element?: BrowserSelection['element']; viewport: BrowserSelection['viewport'] }
      const whole = await this.automation.screenshot(tabId, record.view.webContents, false)
      this.annotationMarkerCounts.set(tabId, marker)
      return {
        tabId,
        marker,
        mode,
        url: publicBrowserUrl(record.tab.url),
        title: redactBrowserText(record.tab.title),
        viewport: selected.viewport,
        region: selected.region,
        element: selected.element ? {
          ...selected.element,
          role: selected.element.role ? redactBrowserText(selected.element.role, 40) : undefined,
          name: selected.element.name ? redactBrowserText(selected.element.name, 120) : undefined,
        } : undefined,
        // Keep the full visible browser viewport. Completed numbered marks stay
        // rendered until the annotation session is sent or cleared, so one
        // screenshot can explain multiple selections to the vision model.
        screenshot: whole,
      }
    } catch (error) {
      await this.cleanupAnnotationPage(tabId, `(()=>{const state=globalThis[${JSON.stringify(ANNOTATION_STATE_KEY)}];const mark=state?.marks?.get(${marker});if(mark){mark.box.remove();state.marks.delete(${marker});if(!state.marks.size)state.destroy()}})()`)
      throw error
    } finally {
      await this.cleanupAnnotationPage(tabId, `dispatchEvent(new CustomEvent(${JSON.stringify(ANNOTATION_CANCEL_EVENT)}))`)
      this.activeAnnotationTabs.delete(tabId)
      this.emitState()
    }
  }

  async cancelAnnotation(tabId: string): Promise<boolean> {
    if (!this.activeAnnotationTabs.has(tabId)) return false
    const contents = this.records.get(tabId)?.view.webContents
    if (!contents || contents.isDestroyed()) {
      this.activeAnnotationTabs.delete(tabId)
      this.emitState()
      return false
    }
    await this.cleanupAnnotationPage(tabId, `dispatchEvent(new CustomEvent(${JSON.stringify(ANNOTATION_CANCEL_EVENT)}))`)
    return true
  }

  async updateAnnotationNote(tabId: string, marker: number, note: string): Promise<boolean> {
    const record = this.requireTab(tabId)
    if (!this.annotationMarkerCounts.has(tabId)) return false
    const normalized = note.trim().slice(0, 500)
    return record.view.webContents.executeJavaScriptInIsolatedWorld(ANNOTATION_WORLD_ID, [{
      code: `(()=>{const state=globalThis[${JSON.stringify(ANNOTATION_STATE_KEY)}];const mark=state?.marks?.get(${marker});if(!mark)return false;mark.badge.textContent=${JSON.stringify(String(marker))}+(${JSON.stringify(normalized)}?' · '+${JSON.stringify(normalized)}:'');state.positionMark(mark);return true})()`,
    }], true).then(Boolean).catch(() => false)
  }

  async captureAnnotations(tabId: string) {
    if (!this.annotationMarkerCounts.has(tabId)) throw new Error('Browser annotation session not found')
    const record = this.requireTab(tabId)
    await record.view.webContents.executeJavaScriptInIsolatedWorld(ANNOTATION_WORLD_ID, [{
      code: `globalThis[${JSON.stringify(ANNOTATION_STATE_KEY)}]?.refresh?.()`,
    }], true).catch(() => undefined)
    return this.screenshot(tabId, false)
  }

  async removeAnnotation(tabId: string, marker: number): Promise<boolean> {
    if (!Number.isSafeInteger(marker) || marker < 1) throw new Error('Invalid browser annotation marker')
    if (this.activeAnnotationTabs.has(tabId)) throw new Error('An annotation is already active in this tab')
    const contents = this.requireTab(tabId).view.webContents
    if (!contents || contents.isDestroyed()) throw new Error('Browser tab is no longer available')
    const remaining = await contents.executeJavaScriptInIsolatedWorld(ANNOTATION_WORLD_ID, [{
      code: `(()=>{const state=globalThis[${JSON.stringify(ANNOTATION_STATE_KEY)}];if(!state)return [];const mark=state.marks.get(${marker});if(mark){mark.box.remove();state.marks.delete(${marker})}const remaining=[...state.marks.keys()];if(!remaining.length)state.destroy();return remaining})()`,
    }], true) as number[]
    if (this.records.get(tabId)?.view.webContents !== contents || contents.isDestroyed()) return true
    // Keep surviving marker numbers stable so their notes and submitted refs agree.
    if (remaining.length) this.annotationMarkerCounts.set(tabId, Math.max(...remaining))
    else this.annotationMarkerCounts.delete(tabId)
    this.emitState()
    return true
  }

  private async cleanupAnnotationPage(tabId: string, code: string): Promise<void> {
    const contents = this.records.get(tabId)?.view.webContents
    if (!contents || contents.isDestroyed()) return
    try {
      await contents.executeJavaScriptInIsolatedWorld(ANNOTATION_WORLD_ID, [{ code }], true)
    } catch { /* the renderer may disappear while annotation cleanup is running */ }
  }

  async clearAnnotations(tabId: string, waitForPage = true): Promise<boolean> {
    const wasActive = this.activeAnnotationTabs.has(tabId)
    const hadMarks = this.annotationMarkerCounts.has(tabId)
    if (!wasActive && !hadMarks) return false
    const cleanup = this.cleanupAnnotationPage(tabId, `dispatchEvent(new CustomEvent(${JSON.stringify(ANNOTATION_CANCEL_EVENT)}));globalThis[${JSON.stringify(ANNOTATION_STATE_KEY)}]?.destroy?.()`)
    if (waitForPage) await cleanup
    else void cleanup
    this.activeAnnotationTabs.delete(tabId)
    this.annotationMarkerCounts.delete(tabId)
    if (wasActive || hadMarks) this.emitState()
    return wasActive || hadMarks
  }

  async destroy(timeoutMs = SESSION_SHUTDOWN_TIMEOUT_MS): Promise<void> {
    for (const item of this.downloadItems.values()) item.cancel()
    this.downloadItems.clear()
    this.destroyViews()
    for (const timer of this.sessionCookiePersistTimers.values()) clearTimeout(timer)
    this.sessionCookiePersistTimers.clear()
    const profiles = (() => {
      try {
        return this.profileStore.list().filter(profile => this.browserSessions.has(profile.sessionPath))
      } catch {
        return []
      }
    })()
    let timeout: NodeJS.Timeout | undefined
    const flushed = await Promise.race([
      Promise.all(profiles.map(profile => this.flushProfileSession(profile)))
        .then(() => true)
        .catch(error => {
          console.warn('[desktop-browser] failed to persist browser sessions during shutdown:', error)
          return true
        }),
      new Promise<boolean>(resolveTimeout => {
        timeout = setTimeout(() => resolveTimeout(false), Math.max(0, timeoutMs))
      }),
    ])
    if (timeout) clearTimeout(timeout)
    if (!flushed) console.warn(`[desktop-browser] browser session shutdown exceeded ${timeoutMs}ms; continuing app exit`)
    for (const [sessionPath, browserSession] of this.browserSessions) {
      const listener = this.sessionCookieChangeListeners.get(sessionPath)
      if (listener) browserSession.cookies.off('changed', listener)
    }
    this.browserSessions.clear()
    this.sessionCookieRestorePromises.clear()
    this.sessionCookiePersistQueues.clear()
    this.sessionCookieChangeListeners.clear()
    this.stateListeners.clear()
  }

  private async buildTab(profile: DesktopBrowserProfile, url: string): Promise<TabRecord> {
    const id = randomUUID()
    const browserSession = await this.profileSession(profile)
    await this.configureSession(profile, browserSession)
    const view = new WebContentsView({
      webPreferences: {
        session: browserSession,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        spellcheck: true,
      },
    })
    view.setBackgroundColor(browserBackground(this.colorScheme))

    const tab: DesktopBrowserTab = {
      id,
      profileId: profile.id,
      title: url === 'about:blank' ? 'New Tab' : url,
      url,
      loading: false,
      canGoBack: false,
      canGoForward: false,
      crashed: false,
      agentControl: 'idle',
    }
    const record: TabRecord = { tab, view, console: [] }
    const contents = view.webContents
    this.routePageDialogs(record)
    contents.on('dom-ready', () => {
      void applyBrowserColorScheme(view, this.colorScheme).catch(error => {
        console.warn('[desktop-browser] color scheme update failed', error)
      })
    })
    contents.setWindowOpenHandler(details => {
      if (!isAllowedBrowserRequest(details.url)) return { action: 'deny' }
      void this.openTab(details.url, true, false, undefined, id).catch(error => {
        console.warn('[desktop-browser] failed to open popup:', error)
      })
      return { action: 'deny' }
    })
    contents.on('context-menu', event => {
      event.preventDefault()
      if ((record.suppressContextMenuUntil || 0) > Date.now()) return
      if (!this.options || contents.isDestroyed()) return
      Menu.buildFromTemplate([
        { label: this.options.selectElementLabel, click: () => this.options?.onAnnotationRequest(id, 'element') },
        { label: this.options.selectRegionLabel, click: () => this.options?.onAnnotationRequest(id, 'region') },
      ]).popup({ window: this.window })
    })
    contents.on('will-navigate', details => {
      if (record.htmlPreviewTitle && details.url.startsWith('data:text/html')) return
      if (!isAllowedBrowserRequest(details.url)) details.preventDefault()
    })
    const invalidateDocument = () => {
      record.documentGeneration = (record.documentGeneration || 0) + 1
      this.automation.invalidate(id)
    }
    contents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) invalidateDocument()
    })
    contents.on('did-start-loading', () => { tab.loading = true; this.emitState() })
    contents.on('did-stop-loading', () => { tab.loading = false; this.refreshTab(record); this.emitState() })
    contents.on('did-fail-load', () => { tab.loading = false; this.refreshTab(record); this.emitState() })
    const persistNavigation = () => { void this.persistTabs().catch(error => console.warn('[desktop-browser] failed to persist tabs:', error)) }
    contents.on('did-navigate', () => { this.refreshTab(record); invalidateDocument(); persistNavigation(); this.emitState() })
    contents.on('did-navigate-in-page', () => { this.refreshTab(record); this.automation.invalidate(id); persistNavigation(); this.emitState() })
    contents.on('page-title-updated', (_event, title) => {
      const isHtmlPreview = !!record.htmlPreviewTitle && contents.getURL().startsWith('data:text/html')
      tab.title = title || (isHtmlPreview ? record.htmlPreviewTitle || 'HTML Preview' : tab.url)
      this.emitState()
    })
    contents.on('page-favicon-updated', (_event, favicons) => { tab.faviconUrl = favicons[0]; this.emitState() })
    contents.on('render-process-gone', () => { tab.crashed = true; tab.loading = false; invalidateDocument(); this.emitState() })
    if (!contents.isDestroyed()) {
      contents.debugger.on('detach', () => {
        invalidateDocument()
        tab.agentControl = 'idle'
        tab.agentLabel = undefined
        tab.agentAction = undefined
        this.emitState()
      })
    }
    contents.on('console-message', details => {
      const levelNumber = ({ debug: 0, info: 1, warning: 2, error: 3 } as Record<string, number>)[details.level] ?? 1
      record.console.push({ level: levelNumber, message: details.message, line: details.lineNumber, sourceId: details.sourceId, timestamp: new Date().toISOString() })
      if (record.console.length > CONSOLE_LIMIT) record.console.splice(0, record.console.length - CONSOLE_LIMIT)
    })
    return record
  }

  private validateSessionScope(sessionPath: string): void {
    if (process.platform === 'darwin') {
      const root = realpathSync(app.getPath('sessionData'))
      let parent = resolve(sessionPath)
      const suffix: string[] = []
      while (!existsSync(parent)) { suffix.unshift(basename(parent));parent = dirname(parent) }
      const candidate = resolve(realpathSync(parent), ...suffix)
      const subpath = relative(root, candidate)
      if (subpath === '..' || subpath.startsWith('../') || isAbsolute(subpath)) throw new Error(t('browser.profileOutsideStorage', { root }))
    }
  }

  private async profileSession(profile: DesktopBrowserProfile): Promise<Session> {
    this.validateSessionScope(profile.sessionPath)
    await this.profileLeases.acquire(profile.sessionPath)
    const existing = this.browserSessions.get(profile.sessionPath)
    if (existing) return existing
    const sessionProfile = { ...profile, tabs: [...profile.tabs] }
    const browserSession = session.fromPath(profile.sessionPath, { cache: true })
    const actualPath = browserSession.getStoragePath()
    const normalizePath = (pathname: string) => process.platform === 'win32' ? resolve(pathname).toLowerCase() : resolve(pathname)
    if (!browserSession.isPersistent() || !actualPath || normalizePath(actualPath) !== normalizePath(profile.sessionPath)) {
      throw new Error(`Browser profile Session is not persistent at its configured data path: ${profile.sessionPath}`)
    }
    this.browserSessions.set(profile.sessionPath, browserSession)
    const restore = this.sessionCookieStore.restore(sessionProfile.sessionPath, browserSession.cookies)
      .then(result => {
        if (result.failed > 0) {
          console.warn(`[desktop-browser] failed to restore ${result.failed} session cookies for profile ${sessionProfile.id}`)
        }
      })
      .catch(error => {
        console.warn(`[desktop-browser] failed to restore session cookies for profile ${sessionProfile.id}:`, error)
      })
      .then(() => {
        if (this.browserSessions.get(sessionProfile.sessionPath) !== browserSession) return
        const listener = () => this.scheduleSessionCookiePersist(sessionProfile, browserSession)
        browserSession.cookies.on('changed', listener)
        this.sessionCookieChangeListeners.set(sessionProfile.sessionPath, listener)
      })
    this.sessionCookieRestorePromises.set(sessionProfile.sessionPath, restore)
    return browserSession
  }

  private async flushProfileSession(profile: DesktopBrowserProfile): Promise<void> {
    const browserSession = await this.profileSession(profile)
    this.clearSessionCookiePersistTimer(profile.sessionPath)
    await this.waitForSessionCookieRestore(profile)
    await this.persistSessionCookies(profile, browserSession)
    browserSession.flushStorageData()
    await browserSession.cookies.flushStore()
  }

  private async waitForSessionCookieRestore(profile: DesktopBrowserProfile): Promise<void> {
    await this.sessionCookieRestorePromises.get(profile.sessionPath)
  }

  private clearSessionCookiePersistTimer(sessionPath: string): void {
    const timer = this.sessionCookiePersistTimers.get(sessionPath)
    if (timer) clearTimeout(timer)
    this.sessionCookiePersistTimers.delete(sessionPath)
  }

  private scheduleSessionCookiePersist(profile: DesktopBrowserProfile, browserSession: Session): void {
    this.clearSessionCookiePersistTimer(profile.sessionPath)
    const timer = setTimeout(() => {
      this.sessionCookiePersistTimers.delete(profile.sessionPath)
      void this.persistSessionCookies(profile, browserSession).catch(error => {
        console.warn(`[desktop-browser] failed to persist session cookies for profile ${profile.id}:`, error)
      })
    }, SESSION_COOKIE_PERSIST_DELAY_MS)
    timer.unref?.()
    this.sessionCookiePersistTimers.set(profile.sessionPath, timer)
  }

  private async persistSessionCookies(profile: DesktopBrowserProfile, browserSession: Session): Promise<void> {
    const previous = this.sessionCookiePersistQueues.get(profile.sessionPath) || Promise.resolve()
    const next = previous.catch(() => undefined).then(async () => {
      await this.sessionCookieStore.persist(profile.sessionPath, browserSession.cookies)
    })
    this.sessionCookiePersistQueues.set(profile.sessionPath, next)
    try {
      await next
    } finally {
      if (this.sessionCookiePersistQueues.get(profile.sessionPath) === next) {
        this.sessionCookiePersistQueues.delete(profile.sessionPath)
      }
    }
  }

  private releaseProfileSession(sessionPath: string): void {
    this.clearSessionCookiePersistTimer(sessionPath)
    const browserSession = this.browserSessions.get(sessionPath)
    const listener = this.sessionCookieChangeListeners.get(sessionPath)
    if (browserSession && listener) browserSession.cookies.off('changed', listener)
    this.browserSessions.delete(sessionPath)
    this.sessionCookieRestorePromises.delete(sessionPath)
    this.sessionCookiePersistQueues.delete(sessionPath)
    this.sessionCookieChangeListeners.delete(sessionPath)
    this.configuredSessions.delete(sessionPath)
    this.configuredSessionProxies.delete(sessionPath)
  }

  private async configureSession(profile: DesktopBrowserProfile, browserSession: Session): Promise<void> {
    await this.waitForSessionCookieRestore(profile)
    const proxy = proxyConfig(profile)
    const proxySignature = JSON.stringify(proxy)
    if (this.configuredSessionProxies.get(profile.sessionPath) !== proxySignature) {
      await browserSession.setProxy(proxy)
      await browserSession.closeAllConnections()
      this.configuredSessionProxies.set(profile.sessionPath, proxySignature)
    }
    if (this.configuredSessions.has(profile.sessionPath)) return
    this.configuredSessions.add(profile.sessionPath)
    browserSession.setDownloadPath(profile.downloadPath)
    browserSession.setPermissionCheckHandler((contents, permission, origin) => {
      this.recordPermission(profile.id, origin || contents?.getURL() || 'unknown', permission)
      return false
    })
    browserSession.setPermissionRequestHandler((contents, permission, callback) => {
      const origin = (() => { try { return new URL(contents.getURL()).origin } catch { return 'unknown' } })()
      this.recordPermission(profile.id, origin, permission)
      callback(false)
    })
    browserSession.setDisplayMediaRequestHandler((_request, callback) => callback({}))
    browserSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !isAllowedBrowserSubresource(details.url) }))
    browserSession.on('will-download', (_event, item, contents) => {
      try {
        this.handleDownload(this.requireProfile(profile.id), item, contents)
      } catch (error) {
        item.cancel()
        console.warn('[desktop-browser] failed to prepare download:', error)
      }
    })
  }

  private handleDownload(profile: DesktopBrowserProfile, item: DownloadItem, contents: WebContents): void {
    const record = [...this.records.values()].find(candidate => candidate.view.webContents === contents)
    if (!record || record.tab.profileId !== profile.id) { item.cancel(); return }
    const safeFileName = basename(item.getFilename()).replace(/[\u0000-\u001f]/g, '_') || 'download'
    let directory = profile.downloadPath
    if (profile.lastDownloadDirectory) {
      try { if (statSync(profile.lastDownloadDirectory).isDirectory()) directory = profile.lastDownloadDirectory } catch { /* unavailable drive: use the managed directory */ }
    }
    const basePath = join(directory, safeFileName)
    const savePath = profile.downloadConflictPolicy === 'uniquify' ? nextDownloadPath(directory, safeFileName) : basePath
    const askForPath = profile.askBeforeDownload
      || (profile.downloadConflictPolicy === 'ask' && existsSync(basePath))
    // Electron only supports configuring the destination while will-download is
    // running. Its own dialog must handle prompted downloads; awaiting a separate
    // dialog here leaves macOS temporary files that never reach the selected path.
    if (askForPath) item.setSaveDialogOptions({ defaultPath: savePath })
    else item.setSavePath(savePath)
    const download: DesktopBrowserDownload = {
      id: randomUUID(), profileId: profile.id, fileName: item.getFilename(), sourceUrl: item.getURL(),
      ...(askForPath ? {} : { savePath }),
      receivedBytes: 0, totalBytes: item.getTotalBytes(), state: 'progressing', startedAt: new Date().toISOString(),
    }
    this.downloads.unshift(download)
    this.downloadItems.set(download.id, item)
    this.persistDownloadHistory()
    const rememberDirectory = () => {
      const path = item.getSavePath()
      // A cancelled save dialog has no confirmed destination. Never copy another profile's preference.
      if (!path || !isAbsolute(path) || item.getState() === 'cancelled') return
      void this.profileStore.rememberDownloadDirectory(profile.id, dirname(path)).catch(error => {
        console.warn('[desktop-browser] failed to remember download directory:', error)
      })
    }
    item.on('updated', (_event, state) => {
      if (!this.downloadItems.has(download.id)) return
      download.receivedBytes = item.getReceivedBytes()
      download.totalBytes = item.getTotalBytes()
      download.savePath = item.getSavePath() || download.savePath
      rememberDirectory()
      const currentState = item.getState()
      download.state = currentState === 'progressing'
        ? (state === 'interrupted' ? 'interrupted' : 'progressing')
        : currentState
      this.persistDownloadHistory(true)
      this.emitState()
    })
    item.once('done', (_event, state) => {
      this.downloadItems.delete(download.id)
      download.receivedBytes = item.getReceivedBytes()
      download.totalBytes = item.getTotalBytes()
      download.savePath = item.getSavePath() || download.savePath
      download.state = state
      if (state === 'completed') {
        rememberDirectory()
        try {
          if (download.savePath) this.downloadedFileIdentities.set(download.id, lstatSync(download.savePath))
        } catch { /* file may already have been moved outside Desktop */ }
      }
      this.persistDownloadHistory()
      this.emitState()
    })
    this.emitState()
  }

  private async restoreTabs(profile: DesktopBrowserProfile): Promise<void> {
    await Promise.all(profile.tabs.slice(-MAX_BROWSER_TABS).map(url => this.openTab(url, false, false)))
    this.activeTabId = [...this.records.keys()][0]
    this.syncViews()
  }

  private async persistTabs(): Promise<void> {
    if (!this.activeProfileId) return
    await this.profileStore.setTabs(
      this.activeProfileId,
      [...this.records.values()].filter(record => !record.ephemeral).map(record => record.tab.url),
    )
  }

  private refreshTab(record: TabRecord): void {
    const contents = record.view.webContents
    if (!contents || contents.isDestroyed()) return
    const currentUrl = contents.getURL() || 'about:blank'
    const isHtmlPreview = !!record.htmlPreviewTitle && currentUrl.startsWith('data:text/html')
    if (record.htmlPreviewTitle) record.ephemeral = isHtmlPreview
    record.tab.url = isHtmlPreview ? 'about:blank' : currentUrl
    record.tab.title = contents.getTitle() || (isHtmlPreview ? record.htmlPreviewTitle || 'HTML Preview' : record.tab.url)
    record.tab.canGoBack = contents.navigationHistory.canGoBack()
    record.tab.canGoForward = contents.navigationHistory.canGoForward()
    record.tab.crashed = false
  }

  private syncViews(): void {
    for (const [id, record] of this.records) {
      const userVisible = this.visible && id === this.activeTabId
      // Attaching a WebContentsView can make it the native first responder on
      // macOS, even when hidden. Only user-visible tabs belong to the host tree.
      if (userVisible && !this.attachedTabs.has(id)) {
        this.automationHosts.get(id)?.contentView.removeChildView(record.view)
        this.window.contentView.addChildView(record.view)
        this.attachedTabs.add(id)
      } else if (!userVisible && this.attachedTabs.delete(id)) {
        this.window.contentView.removeChildView(record.view)
      }
      if (!userVisible && this.automationVisibleTabs.has(id)) {
        let host = this.automationHosts.get(id)
        if (!host) {
          host = new BrowserWindow({
            show: false, focusable: false, skipTaskbar: true,
            width: this.bounds.width, height: this.bounds.height,
            webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false },
          })
          this.automationHosts.set(id, host)
        }
        host.setSize(this.bounds.width, this.bounds.height)
        host.contentView.addChildView(record.view)
      }
      record.view.setBounds(userVisible ? this.bounds : { x: 0, y: 0, width: this.bounds.width, height: this.bounds.height })
      record.view.setVisible(userVisible || this.automationVisibleTabs.has(id))
    }
  }

  private async withAutomationView<T>(record: TabRecord, operation: () => Promise<T>): Promise<T> {
    const tabId = record.tab.id
    const contents = record.view.webContents
    const throttled = contents.getBackgroundThrottling()
    // Background/occluded windows otherwise delay page timers past the observation window.
    contents.setBackgroundThrottling(false)
    const alreadyRendering = this.visible && this.activeTabId === tabId
    try {
      if (!alreadyRendering) {
        this.automationVisibleTabs.add(tabId)
        this.syncViews()
        await new Promise(resolve => setTimeout(resolve, 16))
      }
      // CDP targets this WebContents directly. Native focus belongs to the user:
      // even read-only waits/screenshots must not steal it from another app/view.
      // DOM element focus for typing is handled inside the target page.
      return await operation()
    } finally {
      if (!contents.isDestroyed()) contents.setBackgroundThrottling(throttled)
      if (!alreadyRendering) {
        this.automationVisibleTabs.delete(tabId)
        this.syncViews()
      }
    }
  }

  private destroyViews(): void {
    for (const [id, record] of this.records) {
      const contents = record.view.webContents
      this.window.contentView.removeChildView(record.view)
      this.automationHosts.get(id)?.contentView.removeChildView(record.view)
      this.automationHosts.get(id)?.destroy()
      this.automation.detach(id, contents)
      if (contents && !contents.isDestroyed()) contents.close()
    }
    this.records.clear()
    this.automationVisibleTabs.clear()
    this.attachedTabs.clear()
    this.automationHosts.clear()
    this.activeAnnotationTabs.clear()
    this.annotationMarkerCounts.clear()
    this.activeTabId = undefined
  }

  private requireTab(tabId: string): TabRecord {
    const record = this.records.get(tabId)
    if (!record) throw new Error('Browser tab not found')
    return record
  }

  private requireProfile(profileId: string): DesktopBrowserProfile {
    const profile = this.profileStore.get(profileId)
    if (!profile) throw new Error('Browser profile not found')
    return profile
  }

  private recordPermission(profileId: string, input: string, permission: string): void {
    const origin = (() => { try { return new URL(input).origin } catch { return input.slice(0, 500) || 'unknown' } })()
    const existing = this.permissions.find(item => item.profileId === profileId && item.origin === origin && item.permission === permission)
    if (existing) existing.lastRequestedAt = new Date().toISOString()
    else this.permissions.unshift({ id: randomUUID(), profileId, origin, permission, allowed: false, lastRequestedAt: new Date().toISOString() })
    if (this.permissions.length > 500) this.permissions.length = 500
    this.emitState()
  }

  private emitState(): void {
    const state = this.state()
    for (const listener of this.stateListeners) listener(state)
  }
}
