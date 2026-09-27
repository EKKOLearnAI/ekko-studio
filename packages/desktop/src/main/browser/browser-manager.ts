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
import { BROWSER_BATCH_TIMEOUT_MS, parseBrowserBatchActions } from './browser-batch'
import type {
  BrowserAgentControl,
  BrowserBatchResult,
  BrowserBounds,
  BrowserConsoleEntry,
  BrowserInteractAction,
  BrowserProfileCreateInput,
  BrowserProfileSwitchImpact,
  BrowserProfileUpdateInput,
  BrowserReadTextOptions,
  BrowserSelection,
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
}

interface BrowserManagerOptions {
  selectElementLabel: string
  selectRegionLabel: string
  onAnnotationRequest: (tabId: string, mode: 'element' | 'region') => void
}

const MAX_TABS = 8
const CONSOLE_LIMIT = 500
const ANNOTATION_WORLD_ID = 999
const ANNOTATION_CANCEL_EVENT = '__hermes_browser_cancel_annotation__'
const ANNOTATION_STATE_KEY = '__hermes_browser_annotation_state__'
const SESSION_COOKIE_PERSIST_DELAY_MS = 750
const SESSION_SHUTDOWN_TIMEOUT_MS = 2_000
const HTML_PREVIEW_MAX_BYTES = 10 * 1024 * 1024

const RISK_DIALOG_COPY = {
  de: ['Agent-Aktion bestätigen', 'Diese Browser-Aktion kann eine wichtige Änderung ausführen:', 'Abbrechen', 'Einmal erlauben'],
  en: ['Confirm Agent action', 'This browser action may perform an important change:', 'Cancel', 'Allow once'],
  es: ['Confirmar acción del Agent', 'Esta acción del navegador puede realizar un cambio importante:', 'Cancelar', 'Permitir una vez'],
  fr: ["Confirmer l’action de l’Agent", 'Cette action du navigateur peut effectuer une modification importante :', 'Annuler', 'Autoriser une fois'],
  ja: ['Agent 操作を確認', 'このブラウザ操作は重要な変更を実行する可能性があります：', 'キャンセル', '今回のみ許可'],
  ko: ['Agent 작업 확인', '이 브라우저 작업은 중요한 변경을 수행할 수 있습니다:', '취소', '한 번 허용'],
  pt: ['Confirmar ação do Agent', 'Esta ação do navegador pode fazer uma alteração importante:', 'Cancelar', 'Permitir uma vez'],
  ru: ['Подтвердите действие Agent', 'Это действие браузера может внести важное изменение:', 'Отмена', 'Разрешить один раз'],
  'zh-TW': ['確認 Agent 操作', '此瀏覽器操作可能會執行重要變更：', '取消', '僅允許這一次'],
  zh: ['确认 Agent 操作', '此浏览器操作可能会执行重要变更：', '取消', '仅允许这一次'],
} as const

function riskDialogCopy(): readonly [string, string, string, string] {
  const locale = app.getLocale().toLowerCase()
  if (locale.startsWith('zh-tw') || locale.startsWith('zh-hk')) return RISK_DIALOG_COPY['zh-TW']
  const language = locale.split('-')[0] as keyof typeof RISK_DIALOG_COPY
  return RISK_DIALOG_COPY[language] || RISK_DIALOG_COPY.en
}

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
  readonly automation = new BrowserAutomation()
  private readonly profileStore: BrowserProfileStore
  private readonly records = new Map<string, TabRecord>()
  private readonly downloads: DesktopBrowserDownload[] = []
  private readonly downloadItems = new Map<string, DownloadItem>()
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
  private readonly activeAnnotationTabs = new Set<string>()
  private readonly annotationMarkerCounts = new Map<string, number>()
  private readonly agentDownloadGuardUntil = new Map<string, number>()
  private readonly stateListeners = new Set<(state: DesktopBrowserState) => void>()
  private activeProfileId = ''
  private activeTabId: string | undefined
  private visible = false
  private bounds: BrowserBounds = { x: 0, y: 0, width: 800, height: 600 }

  constructor(private readonly window: BrowserWindow, stateRoot: string, private readonly options?: BrowserManagerOptions) {
    this.profileStore = new BrowserProfileStore(stateRoot)
  }

  async initialize(): Promise<void> {
    await this.profileStore.initialize()
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
      maxTabs: MAX_TABS,
    }
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
  ): Promise<DesktopBrowserTab> {
    if (this.records.size >= MAX_TABS) throw new Error(`Browser supports at most ${MAX_TABS} tabs per profile`)
    const normalizedUrl = normalizeBrowserUrl(url, { allowBlank: true })
    const profile = this.requireProfile(this.activeProfileId)
    const record = await this.buildTab(profile, normalizedUrl)
    if (htmlPreview) {
      record.htmlPreviewTitle = htmlPreview.title
      record.ephemeral = true
      record.tab.title = htmlPreview.title
    }
    this.records.set(record.tab.id, record)
    this.window.contentView.addChildView(record.view)
    if (activate || !this.activeTabId) this.activeTabId = record.tab.id
    this.syncViews()
    const loading = record.view.webContents.loadURL(htmlPreview?.dataUrl || normalizedUrl).catch(() => {
      record.tab.loading = false
      this.refreshTab(record)
      this.emitState()
    })
    if (waitForLoad) await loading
    await this.persistTabs()
    this.emitState()
    return copyTab(record.tab)
  }

  async closeTab(tabId: string): Promise<DesktopBrowserState> {
    const record = this.requireTab(tabId)
    await this.clearAnnotations(tabId, false)
    const ids = [...this.records.keys()]
    const index = ids.indexOf(tabId)
    const contents = record.view.webContents
    this.window.contentView.removeChildView(record.view)
    this.automation.detach(tabId, contents)
    this.automationVisibleTabs.delete(tabId)
    this.agentDownloadGuardUntil.delete(tabId)
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
    const removed = await this.profileStore.deleteProfile(profileId)
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
      const browserSession = this.profileSession(profile)
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

  cancelDownload(downloadId: string): DesktopBrowserState {
    const download = this.downloads.find(item => item.id === downloadId)
    if (!download) throw new Error('Browser download not found')
    if (download.state !== 'progressing') return this.state()
    const item = this.downloadItems.get(downloadId)
    if (!item) throw new Error('Browser download is no longer active')
    download.state = 'cancelled'
    this.downloadItems.delete(downloadId)
    item.cancel()
    this.emitState()
    return this.state()
  }

  async snapshot(tabId: string) {
    const record = this.requireTab(tabId)
    return this.automation.snapshot(tabId, record.view.webContents)
  }

  async readText(tabId: string, options: BrowserReadTextOptions) {
    const record = this.requireTab(tabId)
    return this.automation.readText(tabId, record.view.webContents, options)
  }

  async interact(tabId: string, action: BrowserInteractAction, assertActive: () => void = () => {}): Promise<DesktopBrowserTab> {
    assertActive()
    const record = this.requireTab(tabId)
    const risk = this.automation.interactionRisk(tabId, action)
    if (risk) {
      const [title, message, cancel, allow] = riskDialogCopy()
      const previousLabel = record.tab.agentLabel
      this.setAgentControl(tabId, 'waiting-for-user', previousLabel, risk.kind)
      let confirmationTimer: NodeJS.Timeout | undefined
      let result: Awaited<ReturnType<typeof dialog.showMessageBox>>
      try {
        result = await Promise.race([
          dialog.showMessageBox(this.window, {
            type: 'warning',
            title,
            message,
            detail: risk.label,
            buttons: [cancel, allow],
            defaultId: 0,
            cancelId: 0,
            noLink: true,
          }),
          new Promise<never>((_resolve, reject) => {
            confirmationTimer = setTimeout(() => reject(new Error('High-risk browser confirmation timed out')), 25_000)
            confirmationTimer.unref?.()
          }),
        ])
        assertActive()
      } catch (error) {
        if (this.records.get(tabId) === record && record.tab.agentControl === 'waiting-for-user' && record.tab.agentLabel === previousLabel) {
          this.setAgentControl(tabId, 'idle')
        }
        throw error
      } finally {
        if (confirmationTimer) clearTimeout(confirmationTimer)
      }
      if (result.response !== 1) {
        this.setAgentControl(tabId, 'idle')
        throw new Error('High-risk browser action was declined by the user')
      }
      this.setAgentControl(tabId, 'active', previousLabel, action.action)
    }
    await this.withAutomationView(record, () => this.automation.interact(tabId, record.view.webContents, action, assertActive))
    return copyTab(record.tab)
  }

  async interactBatch(tabId: string, input: unknown, snapshotId: unknown, assertControl: () => void): Promise<BrowserBatchResult> {
    const actions = parseBrowserBatchActions(input)
    const record = this.requireTab(tabId)
    const prepared = this.automation.prepareBatch(tabId, snapshotId, actions)
    const generation = record.documentGeneration || 0
    const originalUrl = record.view.webContents.getURL()
    const deadline = Date.now() + BROWSER_BATCH_TIMEOUT_MS
    const assertActive = () => {
      assertControl()
      if (Date.now() >= deadline) throw new Error('Browser batch timed out; remaining actions were skipped')
      if (this.records.get(tabId) !== record || record.view.webContents.isDestroyed()) throw new Error('Browser tab is closed')
      if ((record.documentGeneration || 0) !== generation || record.view.webContents.getURL() !== originalUrl) {
        throw new Error('Browser page navigated; take a new snapshot before continuing')
      }
    }
    const result: BrowserBatchResult = { tabId, completed: 0, total: actions.length, results: [] }
    for (let index = 0; index < prepared.length; index += 1) {
      const action = actions[index].action
      if (result.completed !== index) {
        result.results.push({ index, action, status: 'skipped' })
        continue
      }
      try {
        assertActive()
        const resolved = await this.automation.resolveBatchAction(tabId, record.view.webContents, prepared[index])
        assertActive()
        await this.interact(tabId, resolved, assertActive)
        result.completed += 1
        result.results.push({ index, action, status: 'completed' })
      } catch (error) {
        result.results.push({ index, action, status: 'failed', error: redactBrowserText(error instanceof Error ? error.message : String(error), 500) })
      }
    }
    try {
      assertControl()
      if (Date.now() >= deadline) throw new Error('Browser batch timed out')
      result.snapshot = await this.snapshot(tabId)
      assertControl()
    } catch (error) {
      delete result.snapshot
      result.snapshotError = redactBrowserText(error instanceof Error ? error.message : String(error), 500)
    }
    return result
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
    const tab = this.requireTab(tabId).tab
    if (control !== 'idle') this.agentDownloadGuardUntil.set(tabId, Date.now() + 5 * 60 * 1000)
    tab.agentControl = control
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
    const browserSession = this.profileSession(profile)
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
    view.setBackgroundColor('#ffffff')
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
    contents.setWindowOpenHandler(details => {
      if (!isAllowedBrowserRequest(details.url)) return { action: 'deny' }
      void this.createTab(details.url, true).catch(error => {
        console.warn('[desktop-browser] failed to open popup:', error)
      })
      return { action: 'deny' }
    })
    contents.on('context-menu', event => {
      event.preventDefault()
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
    contents.on('did-start-loading', () => { tab.loading = true; invalidateDocument(); this.emitState() })
    contents.on('did-stop-loading', () => { tab.loading = false; this.refreshTab(record); this.emitState() })
    contents.on('did-fail-load', () => { tab.loading = false; this.refreshTab(record); this.emitState() })
    const persistNavigation = () => { void this.persistTabs().catch(error => console.warn('[desktop-browser] failed to persist tabs:', error)) }
    contents.on('did-navigate', () => { this.refreshTab(record); invalidateDocument(); persistNavigation(); this.emitState() })
    contents.on('did-navigate-in-page', () => { this.refreshTab(record); invalidateDocument(); persistNavigation(); this.emitState() })
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

  private profileSession(profile: DesktopBrowserProfile): Session {
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
    const browserSession = this.profileSession(profile)
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
    const basePath = join(profile.downloadPath, safeFileName)
    const savePath = profile.downloadConflictPolicy === 'uniquify' ? nextDownloadPath(profile.downloadPath, safeFileName) : basePath
    const askForPath = (this.agentDownloadGuardUntil.get(record.tab.id) || 0) > Date.now()
      || profile.askBeforeDownload
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
    item.on('updated', (_event, state) => {
      if (!this.downloadItems.has(download.id)) return
      download.receivedBytes = item.getReceivedBytes()
      download.totalBytes = item.getTotalBytes()
      download.savePath = item.getSavePath() || download.savePath
      const currentState = item.getState()
      download.state = currentState === 'progressing'
        ? (state === 'interrupted' ? 'interrupted' : 'progressing')
        : currentState
      this.emitState()
    })
    item.once('done', (_event, state) => {
      this.downloadItems.delete(download.id)
      download.receivedBytes = item.getReceivedBytes()
      download.totalBytes = item.getTotalBytes()
      download.savePath = item.getSavePath() || download.savePath
      download.state = state
      this.emitState()
    })
    this.emitState()
  }

  private async restoreTabs(profile: DesktopBrowserProfile): Promise<void> {
    await Promise.all(profile.tabs.slice(0, MAX_TABS).map(url => this.openTab(url, false, false)))
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
      if (userVisible) {
        record.view.setBounds(this.bounds)
        record.view.setVisible(true)
      } else if (this.automationVisibleTabs.has(id)) {
        record.view.setBounds({
          x: -Math.max(10_000, this.bounds.width + 100),
          y: -Math.max(10_000, this.bounds.height + 100),
          width: this.bounds.width,
          height: this.bounds.height,
        })
        record.view.setVisible(true)
      } else {
        record.view.setBounds(this.bounds)
        record.view.setVisible(false)
      }
    }
  }

  private async withAutomationView<T>(record: TabRecord, operation: () => Promise<T>): Promise<T> {
    const tabId = record.tab.id
    const alreadyRendering = this.visible && this.activeTabId === tabId
    if (!alreadyRendering) {
      this.automationVisibleTabs.add(tabId)
      this.syncViews()
      await new Promise(resolve => setTimeout(resolve, 16))
    }
    record.view.webContents.focus()
    try {
      return await operation()
    } finally {
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
      this.automation.detach(id, contents)
      if (contents && !contents.isDestroyed()) contents.close()
    }
    this.records.clear()
    this.automationVisibleTabs.clear()
    this.activeAnnotationTabs.clear()
    this.annotationMarkerCounts.clear()
    this.agentDownloadGuardUntil.clear()
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
