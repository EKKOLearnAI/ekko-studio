/**
 * Browser session / tab model on top of the CDP client (spec-03).
 *
 * One `BrowserSession` owns one CDP browser context
 * (`Target.createBrowserContext`), which is real storage isolation: cookies,
 * localStorage and caches cannot leak between sessions (soft isolation such as
 * clearing cookies is explicitly not acceptable).
 *
 * `tab_id` is the CDP `Target.targetId` verbatim — no extra mapping table — so
 * the Web panel and the MCP browser toolset share the desktop contract.
 */

import { logger } from '../../public/logging'
import type {
  CdpAttachedToTargetEvent,
  CdpFrameNavigatedEvent,
  CdpNavigationHistoryResult,
  CdpTargetCreatedEvent,
  CdpTargetDestroyedEvent,
  CdpTargetInfo,
  CdpTargetInfoChangedEvent,
} from './cdp-types'

export const MAX_TABS_PER_SESSION = 8
export const MAX_BROWSER_SESSIONS = 4
export const DEFAULT_BROWSER_SESSION_IDLE_TTL_MS = 30 * 60 * 1000

/** Same wording as the desktop manager so clients do not branch per surface. */
export function browserTabCapMessage(maxTabs: number = MAX_TABS_PER_SESSION): string {
  return `Browser supports at most ${maxTabs} tabs per profile`
}

export class BrowserTabCapError extends Error {
  constructor(maxTabs: number = MAX_TABS_PER_SESSION) {
    super(browserTabCapMessage(maxTabs))
    this.name = 'BrowserTabCapError'
  }
}

export interface BrowserSessionCdp {
  send<T = any>(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<T>
  on<T = any>(
    method: string,
    handler: (params: T, meta: { sessionId?: string, method: string }) => void,
  ): () => void
}

export type BrowserAgentControl = 'idle' | 'active' | 'waiting-for-user'

export interface BrowserTabState {
  /** CDP `Target.targetId` — the public `tab_id`. */
  id: string
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  crashed: boolean
  /** Who is driving the tab (set by the broker lease). */
  agentControl: BrowserAgentControl
}

function emptyTabState(id: string): BrowserTabState {
  return {
    id,
    url: 'about:blank',
    title: '',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    crashed: false,
    agentControl: 'idle',
  }
}

export class BrowserTab {
  private state: BrowserTabState
  private sessionId: string | null

  constructor(targetId: string, sessionId: string | null = null) {
    this.state = emptyTabState(targetId)
    this.sessionId = sessionId
  }

  get id(): string {
    return this.state.id
  }

  get cdpSessionId(): string | null {
    return this.sessionId
  }

  setCdpSessionId(sessionId: string | null): void {
    this.sessionId = sessionId
  }

  snapshot(): BrowserTabState {
    return { ...this.state }
  }

  update(patch: Partial<Omit<BrowserTabState, 'id'>>): BrowserTabState {
    this.state = { ...this.state, ...patch }
    return this.snapshot()
  }

  applyTargetInfo(info: CdpTargetInfo): BrowserTabState {
    return this.update({
      url: info.url || this.state.url,
      title: info.title ?? this.state.title,
    })
  }
}

export interface BrowserSessionOptions {
  cdp: BrowserSessionCdp
  sessionKey: string
  maxTabs?: number
  idleTtlMs?: number
  now?: () => number
}

export class BrowserSession {
  readonly key: string
  private readonly cdp: BrowserSessionCdp
  private readonly maxTabs: number
  private readonly idleTtlMs: number
  private readonly now: () => number
  private readonly tabs = new Map<string, BrowserTab>()
  private readonly unsubscribers: Array<() => void> = []
  private contextId: string | null = null
  private activeTabId: string | null = null
  private lastUsedAt: number
  private disposed = false

  private constructor(options: BrowserSessionOptions) {
    this.cdp = options.cdp
    this.key = options.sessionKey
    this.maxTabs = options.maxTabs ?? MAX_TABS_PER_SESSION
    this.idleTtlMs = options.idleTtlMs ?? DEFAULT_BROWSER_SESSION_IDLE_TTL_MS
    this.now = options.now ?? (() => Date.now())
    this.lastUsedAt = this.now()
  }

  static async create(options: BrowserSessionOptions): Promise<BrowserSession> {
    const session = new BrowserSession(options)
    await session.initialize()
    return session
  }

  get browserContextId(): string {
    return this.contextId as string
  }

  get lastUsedAtMs(): number {
    return this.lastUsedAt
  }

  isDisposed(): boolean {
    return this.disposed
  }

  private async initialize(): Promise<void> {
    const context = await this.cdp.send<{ browserContextId: string }>(
      'Target.createBrowserContext',
      { disposeOnDetach: true },
    )
    this.contextId = context.browserContextId

    // Target discovery is browser-wide; it is what lets us see tabs created by
    // the page itself (window.open) and tabs closed by the page.
    await this.cdp.send('Target.setDiscoverTargets', { discover: true }).catch(err => {
      logger.warn(err, '[browser] Target.setDiscoverTargets failed')
    })

    this.unsubscribers.push(
      this.cdp.on<CdpTargetCreatedEvent>('Target.targetCreated', params => {
        void this.handleTargetUpsert(params.targetInfo)
      }),
      this.cdp.on<CdpTargetInfoChangedEvent>('Target.targetInfoChanged', params => {
        void this.handleTargetUpsert(params.targetInfo)
      }),
      this.cdp.on<CdpTargetDestroyedEvent>('Target.targetDestroyed', params => {
        this.handleTargetDestroyed(params.targetId)
      }),
      this.cdp.on<CdpAttachedToTargetEvent>('Target.attachedToTarget', params => {
        this.handleAttached(params)
      }),
      this.cdp.on<CdpFrameNavigatedEvent>('Page.frameNavigated', (params, meta) => {
        this.handleFrameNavigated(params, meta.sessionId)
      }),
      this.cdp.on<{ frameId: string }>('Page.frameStartedLoading', (_params, meta) => {
        const tab = this.tabByCdpSession(meta.sessionId)
        if (tab) tab.update({ loading: true })
      }),
      this.cdp.on('Page.loadEventFired', (_params, meta) => {
        const tab = this.tabByCdpSession(meta.sessionId)
        if (!tab) return
        tab.update({ loading: false })
        void this.syncNavigationState(tab.id)
      }),
      this.cdp.on('Inspector.targetCrashed', (_params, meta) => {
        const tab = this.tabByCdpSession(meta.sessionId)
        if (tab) tab.update({ crashed: true })
      }),
    )
  }

  private isOwnTarget(info: CdpTargetInfo): boolean {
    return info.type === 'page' && info.browserContextId === this.contextId
  }

  private async handleTargetUpsert(info: CdpTargetInfo): Promise<void> {
    if (this.disposed || !this.isOwnTarget(info)) return
    const existing = this.tabs.get(info.targetId)
    if (existing) {
      existing.applyTargetInfo(info)
      return
    }
    if (this.tabs.size >= this.maxTabs) {
      // A page opened a tab beyond the cap: refuse it instead of tracking it.
      logger.warn('[browser] refusing page-created tab beyond the cap: %s', info.targetId)
      await this.cdp.send('Target.closeTarget', { targetId: info.targetId }).catch(() => {})
      return
    }
    const tab = new BrowserTab(info.targetId)
    tab.applyTargetInfo(info)
    this.tabs.set(info.targetId, tab)
  }

  private handleTargetDestroyed(targetId: string): void {
    if (!this.tabs.delete(targetId)) return
    if (this.activeTabId === targetId) {
      this.activeTabId = this.tabs.size > 0 ? [...this.tabs.keys()][0] : null
    }
  }

  private handleAttached(params: CdpAttachedToTargetEvent): void {
    if (!params?.targetInfo || !this.isOwnTarget(params.targetInfo)) return
    const tab = this.tabs.get(params.targetInfo.targetId)
    if (tab) {
      tab.setCdpSessionId(params.sessionId)
      return
    }
    if (this.tabs.size >= this.maxTabs) return
    const created = new BrowserTab(params.targetInfo.targetId, params.sessionId)
    created.applyTargetInfo(params.targetInfo)
    this.tabs.set(created.id, created)
  }

  private handleFrameNavigated(params: CdpFrameNavigatedEvent, sessionId?: string): void {
    const tab = this.tabByCdpSession(sessionId)
    if (!tab) return
    // Only main-frame navigations change the tab URL.
    if (params.frame?.parentId) return
    tab.update({ url: params.frame?.url || tab.snapshot().url })
    void this.syncNavigationState(tab.id)
  }

  private tabByCdpSession(sessionId?: string): BrowserTab | null {
    if (!sessionId) return null
    for (const tab of this.tabs.values()) {
      if (tab.cdpSessionId === sessionId) return tab
    }
    return null
  }

  listTabs(): BrowserTabState[] {
    return [...this.tabs.values()].map(tab => tab.snapshot())
  }

  get activeTab(): BrowserTabState | null {
    if (!this.activeTabId) return null
    return this.tabs.get(this.activeTabId)?.snapshot() ?? null
  }

  /** Set the agent-control flag shown by the broker projection. */
  setAgentControl(tabId: string, control: BrowserAgentControl): BrowserTabState | null {
    const tab = this.tabs.get(tabId)
    if (!tab) return null
    return tab.update({ agentControl: control })
  }

  revokeAgentControl(tabId: string): void {
    this.tabs.get(tabId)?.update({ agentControl: 'idle' })
  }

  get maxTabsCount(): number {
    return this.maxTabs
  }

  async createTab(url = 'about:blank', activate = true): Promise<BrowserTabState> {
    this.assertUsable()
    if (this.tabs.size >= this.maxTabs) throw new BrowserTabCapError(this.maxTabs)

    const created = await this.cdp.send<{ targetId: string }>('Target.createTarget', {
      url,
      browserContextId: this.contextId,
    })
    const attached = await this.cdp.send<{ sessionId: string }>('Target.attachToTarget', {
      targetId: created.targetId,
      flatten: true,
    })

    const tab = new BrowserTab(created.targetId, attached.sessionId)
    tab.update({ url })
    this.tabs.set(tab.id, tab)
    if (activate || !this.activeTabId) this.activeTabId = tab.id

    await this.cdp.send('Page.enable', {}, attached.sessionId).catch(err => {
      logger.warn(err, '[browser] Page.enable failed for %s', created.targetId)
    })

    this.touch()
    return tab.snapshot()
  }

  async closeTab(tabId: string): Promise<void> {
    const tab = this.tabs.get(tabId)
    if (!tab) return
    this.tabs.delete(tabId)
    if (this.activeTabId === tabId) {
      this.activeTabId = this.tabs.size > 0 ? [...this.tabs.keys()][0] : null
    }
    await this.cdp.send('Target.closeTarget', { targetId: tabId }).catch(err => {
      logger.warn(err, '[browser] closing tab %s failed', tabId)
    })
    this.touch()
  }

  activateTab(tabId: string): BrowserTabState | null {
    if (!this.tabs.has(tabId)) return null
    this.activeTabId = tabId
    this.touch()
    return this.tabs.get(tabId)?.snapshot() ?? null
  }

  get activeTabIdValue(): string | null {
    return this.activeTabId
  }

  getTab(tabId: string): BrowserTab | null {
    return this.tabs.get(tabId) ?? null
  }

  /** Tab id that owns a flattened CDP session (console/event routing). */
  findTabIdByCdpSession(sessionId?: string): string | null {
    return this.tabByCdpSession(sessionId)?.id ?? null
  }

  /** Projection consumed by the automation layer (spec-04). */
  tabInfo(tabId: string): { id: string, url: string, title: string, cdpSessionId: string | null } | null {
    const tab = this.tabs.get(tabId)
    if (!tab) return null
    const state = tab.snapshot()
    return {
      id: state.id,
      url: state.url,
      title: state.title,
      cdpSessionId: tab.cdpSessionId,
    }
  }

  /** Refresh `canGoBack` / `canGoForward` from the page's own history. */
  async syncNavigationState(tabId: string): Promise<BrowserTabState | null> {
    const tab = this.tabs.get(tabId)
    if (!tab || !tab.cdpSessionId) return null
    try {
      const history = await this.cdp.send<CdpNavigationHistoryResult>(
        'Page.getNavigationHistory',
        {},
        tab.cdpSessionId,
      )
      const entries = history?.entries ?? []
      const index = history?.currentIndex ?? 0
      tab.update({
        canGoBack: index > 0,
        canGoForward: index < entries.length - 1,
        url: entries[index]?.url || tab.snapshot().url,
        title: entries[index]?.title || tab.snapshot().title,
      })
    } catch (err) {
      logger.debug(err, '[browser] navigation history refresh failed for %s', tabId)
    }
    return tab.snapshot()
  }

  touch(): void {
    this.lastUsedAt = this.now()
  }

  idleMs(at: number = this.now()): number {
    return at - this.lastUsedAt
  }

  isIdle(at: number = this.now()): boolean {
    return this.idleMs(at) >= this.idleTtlMs
  }

  /** Close every tab and dispose the browser context. Idempotent. */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true

    for (const unsubscriber of this.unsubscribers.splice(0)) {
      try {
        unsubscriber()
      } catch {
        // unsubscribe is best effort
      }
    }

    const tabIds = [...this.tabs.keys()]
    this.tabs.clear()
    this.activeTabId = null

    for (const tabId of tabIds) {
      await this.cdp.send('Target.closeTarget', { targetId: tabId }).catch(() => {})
    }

    if (this.contextId) {
      await this.cdp
        .send('Target.disposeBrowserContext', { browserContextId: this.contextId })
        .catch(err => logger.warn(err, '[browser] disposing the browser context failed'))
      this.contextId = null
    }
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error(`browser session ${this.key} is disposed`)
  }
}

export interface BrowserSessionPoolOptions {
  cdp: BrowserSessionCdp
  maxSessions?: number
  maxTabs?: number
  idleTtlMs?: number
  now?: () => number
}

/**
 * Global registry: at most `maxSessions` live sessions (the desktop broker
 * hard-codes 4), sessions idle beyond the TTL are disposed.
 *
 * This is a spec-03 acceptance 10 deliverable ("会话回收：空闲 TTL + 全局并发上限；
 * 回收必须 kill 对应 browser context，且不得影响其他会话"), covered by
 * `tests/server/browser-session.test.ts`. The production consumer is
 * deliberately narrow: `WebBrowserService` (spec-05) backs the broker with
 * **one** session, because the broker contract is "a browser with tabs" and
 * spec-09 ratchets the device to 并发会话数 = 1. The pool is what keeps that cap
 * configurable (`maxSessions`), so it must not be deleted as dead code.
 */
export class BrowserSessionPool {
  private readonly options: BrowserSessionPoolOptions
  private readonly sessions = new Map<string, BrowserSession>()

  constructor(options: BrowserSessionPoolOptions) {
    this.options = options
  }

  get maxSessions(): number {
    return this.options.maxSessions ?? MAX_BROWSER_SESSIONS
  }

  get idleTtlMs(): number {
    return this.options.idleTtlMs ?? DEFAULT_BROWSER_SESSION_IDLE_TTL_MS
  }

  size(): number {
    return this.sessions.size
  }

  keys(): string[] {
    return [...this.sessions.keys()]
  }

  peek(key: string): BrowserSession | null {
    return this.sessions.get(key) ?? null
  }

  async acquire(key: string): Promise<BrowserSession> {
    const existing = this.sessions.get(key)
    if (existing && !existing.isDisposed()) {
      existing.touch()
      return existing
    }
    if (existing) this.sessions.delete(key)

    if (this.sessions.size >= this.maxSessions) {
      const evicted = await this.evictOne()
      if (!evicted) {
        throw new Error(`Browser session limit reached (${this.maxSessions} in use)`)
      }
    }

    const session = await BrowserSession.create({
      cdp: this.options.cdp,
      sessionKey: key,
      maxTabs: this.options.maxTabs,
      idleTtlMs: this.idleTtlMs,
      now: this.options.now,
    })
    this.sessions.set(key, session)
    return session
  }

  async release(key: string): Promise<void> {
    const session = this.sessions.get(key)
    if (!session) return
    this.sessions.delete(key)
    await session.dispose()
  }

  /** Dispose idle sessions; returns the keys that were reclaimed. */
  async sweepIdle(at: number = (this.options.now ?? (() => Date.now()))()): Promise<string[]> {
    const reclaimed: string[] = []
    for (const [key, session] of [...this.sessions.entries()]) {
      if (!session.isIdle(at)) continue
      this.sessions.delete(key)
      await session.dispose()
      reclaimed.push(key)
    }
    return reclaimed
  }

  private async evictOne(): Promise<boolean> {
    const now = (this.options.now ?? (() => Date.now()))()
    const candidates = [...this.sessions.values()].sort((a, b) => a.lastUsedAtMs - b.lastUsedAtMs)
    const victim = candidates.find(session => session.isIdle(now)) ?? null
    if (!victim) return false
    this.sessions.delete(victim.key)
    await victim.dispose()
    return true
  }

  async disposeAll(): Promise<void> {
    const all = [...this.sessions.values()]
    this.sessions.clear()
    await Promise.all(all.map(session => session.dispose()))
  }
}
