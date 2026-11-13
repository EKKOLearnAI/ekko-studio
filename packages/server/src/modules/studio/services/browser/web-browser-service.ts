/**
 * Service behind the Web Broker (spec-05): the `BrokerBrowserService` contract
 * implemented on top of the spec-02 runtime, spec-03 session and spec-04
 * automation.
 *
 * One browser session (one browser context) backs the broker, because the
 * broker's contract is "a browser with tabs" — per-client isolation stays the
 * MCP layer's business. Sessions are created lazily: no browser process is
 * started until the first tab is created.
 */

import { logger } from '../../public/logging'
import { getHeadlessBrowserRuntime, type HeadlessRuntime } from './runtime'
import { connectBrowserSession, type ConnectedBrowserSession } from './connect'
import { BrowserAutomation, type BrowserInteractAction, type BrowserReadTextOptions, type BrowserReadTextResult, type BrowserScreenshot, type BrowserConsoleEntry } from './automation'
import { BrowserSession, type BrowserAgentControl } from './session'
import {
  normalizeBrowserUrl,
  tryNormalizeBrowserUrl,
  publicBrowserUrl,
} from './url-policy'
import type { BrowserSnapshot } from './snapshot'
import type { BrokerBrowserService } from './broker-server'
import { BROKER_MAX_TABS, type BrokerStateInput, type BrokerTabState } from './broker-projections'

export const BROKER_SESSION_KEY = 'browser-broker'
/** How long a navigation is given to settle before the redirect re-check. */
export const NAVIGATION_SETTLE_TIMEOUT_MS = 1_500
const NAVIGATION_POLL_INTERVAL_MS = 50

export interface WebBrowserServiceOptions {
  runtime?: HeadlessRuntime
  sessionKey?: string
  profileId?: string
  maxTabs?: number
  idleTtlMs?: number
  /** Injected for tests. */
  connect?: (options: {
    runtime: HeadlessRuntime
    sessionKey: string
    maxTabs?: number
    idleTtlMs?: number
  }) => Promise<ConnectedBrowserSession>
  wait?: (ms: number) => Promise<void>
}

export class WebBrowserService implements BrokerBrowserService {
  private readonly options: WebBrowserServiceOptions
  private connected: ConnectedBrowserSession | null = null
  private automation: BrowserAutomation | null = null
  private connecting: Promise<ConnectedBrowserSession> | null = null
  private detachConsole: (() => void) | null = null

  constructor(options: WebBrowserServiceOptions = {}) {
    this.options = options
  }

  private get runtime(): HeadlessRuntime {
    return this.options.runtime ?? getHeadlessBrowserRuntime()
  }

  private get wait(): (ms: number) => Promise<void> {
    return this.options.wait ?? ((ms: number) => new Promise(resolve => setTimeout(resolve, ms)))
  }

  /** Wire (or reuse) the runtime connection. */
  async ensureConnected(): Promise<{ connection: ConnectedBrowserSession, automation: BrowserAutomation }> {
    if (this.connected && !this.connected.client.isClosed && this.automation) {
      return { connection: this.connected, automation: this.automation }
    }
    if (this.connecting) {
      const connection = await this.connecting
      return { connection, automation: this.automation as BrowserAutomation }
    }

    this.connecting = (this.options.connect ?? connectBrowserSession)({
      runtime: this.runtime,
      sessionKey: this.options.sessionKey ?? BROKER_SESSION_KEY,
      maxTabs: this.options.maxTabs ?? BROKER_MAX_TABS,
      idleTtlMs: this.options.idleTtlMs,
    })

    try {
      const connection = await this.connecting
      const automation = new BrowserAutomation({
        send: (method, params, sessionId) => connection.client.send(method, params, sessionId),
        getTab: tabId => connection.session.tabInfo(tabId),
      })
      this.detachConsole = automation.attachConsole(
        connection.client,
        sessionId => connection.session.findTabIdByCdpSession(sessionId),
      )
      this.connected = connection
      this.automation = automation
      return { connection, automation }
    } finally {
      this.connecting = null
    }
  }

  /** Tabs backed by a live session; empty before the first tab is created. */
  private tabs(): BrokerTabState[] {
    const session = this.connected?.session
    if (!session || session.isDisposed()) return []
    return session.listTabs().map(state => ({
      id: state.id,
      url: state.url,
      title: state.title,
      loading: state.loading,
      canGoBack: state.canGoBack,
      canGoForward: state.canGoForward,
      crashed: state.crashed,
      agentControl: state.agentControl,
    }))
  }

  state(): BrokerStateInput {
    const session = this.connected?.session
    return {
      activeTabId: session && !session.isDisposed() ? session.activeTab?.id ?? null : null,
      maxTabs: this.options.maxTabs ?? BROKER_MAX_TABS,
      tabs: this.tabs(),
    }
  }

  hasTab(tabId: string): boolean {
    return Boolean(this.connected?.session.tabInfo(tabId))
  }

  private requireTabState(tabId: string): BrokerTabState {
    const tab = this.tabs().find(candidate => candidate.id === tabId)
    if (!tab) throw new Error('Browser tab is closed')
    return tab
  }

  async createTab(url: string, activate: boolean): Promise<BrokerTabState> {
    const target = normalizeBrowserUrl(url || 'about:blank')
    const { connection } = await this.ensureConnected()
    const created = await connection.session.createTab(target, activate)
    return this.requireTabState(created.id)
  }

  activateTab(tabId: string): void {
    const session = this.connected?.session
    if (!session || !session.activateTab(tabId)) throw new Error('Browser tab is closed')
  }

  async closeTab(tabId: string): Promise<void> {
    const session = this.connected?.session
    if (!session) return
    this.automation?.forgetTab(tabId)
    await session.closeTab(tabId)
  }

  private async requireSession(tabId: string): Promise<BrowserSession> {
    const { connection } = await this.ensureConnected()
    if (!connection.session.tabInfo(tabId)) throw new Error('Browser tab is closed')
    return connection.session
  }

  private async cdpSessionId(tabId: string): Promise<string> {
    const session = await this.requireSession(tabId)
    const sessionId = session.tabInfo(tabId)?.cdpSessionId
    if (!sessionId) throw new Error('Browser tab is closed')
    return sessionId
  }

  async navigate(tabId: string, url: string): Promise<BrokerTabState> {
    const target = normalizeBrowserUrl(url)
    const { connection, automation } = await this.ensureConnected()
    const sessionId = await this.cdpSessionId(tabId)
    await connection.client.send('Page.navigate', { url: target }, sessionId)
    automation.snapshots.invalidate(tabId)
    await this.awaitNavigation(tabId)
    await this.enforcePostNavigationUrl(tabId, connection)
    return this.requireTabState(tabId)
  }

  async navigationAction(
    tabId: string,
    action: 'back' | 'forward' | 'reload' | 'stop',
  ): Promise<BrokerTabState> {
    const { connection, automation } = await this.ensureConnected()
    const sessionId = await this.cdpSessionId(tabId)

    if (action === 'reload') {
      await connection.client.send('Page.reload', {}, sessionId)
    } else if (action === 'stop') {
      await connection.client.send('Page.stopLoading', {}, sessionId)
    } else {
      const history = await connection.client.send<{
        currentIndex: number
        entries: Array<{ id: number }>
      }>('Page.getNavigationHistory', {}, sessionId)
      const entries = history?.entries ?? []
      const index = history?.currentIndex ?? 0
      const targetIndex = action === 'back' ? index - 1 : index + 1
      if (targetIndex >= 0 && targetIndex < entries.length) {
        await connection.client.send(
          'Page.navigateToHistoryEntry',
          { entryId: entries[targetIndex].id },
          sessionId,
        )
      }
    }

    automation.snapshots.invalidate(tabId)
    await connection.session.syncNavigationState(tabId)
    return this.requireTabState(tabId)
  }

  private async awaitNavigation(tabId: string): Promise<void> {
    const deadline = Date.now() + NAVIGATION_SETTLE_TIMEOUT_MS
    while (Date.now() < deadline) {
      const tab = this.connected?.session.getTab(tabId)?.snapshot()
      if (!tab || !tab.loading) return
      await this.wait(NAVIGATION_POLL_INTERVAL_MS)
    }
  }

  /**
   * Redirect guard (spec-04 acceptance 14): the page may have been sent
   * somewhere the policy forbids, so the resulting URL is validated again and
   * loading is stopped when it fails. Request-level interception is spec-09.
   */
  private async enforcePostNavigationUrl(tabId: string, connection: ConnectedBrowserSession): Promise<void> {
    const sessionId = await this.cdpSessionId(tabId)
    await connection.session.syncNavigationState(tabId)
    const url = connection.session.tabInfo(tabId)?.url ?? ''
    if (!url || url === 'about:blank') return
    if (tryNormalizeBrowserUrl(url)) return

    await connection.client.send('Page.stopLoading', {}, sessionId).catch(() => undefined)
    logger.warn('[browser] navigation landed on a blocked url: %s', publicBrowserUrl(url))
    throw new Error(`Browser navigation rejected (blocked-host): ${publicBrowserUrl(url)}`)
  }

  async snapshot(tabId: string): Promise<BrowserSnapshot> {
    const { automation } = await this.ensureConnected()
    await this.requireSession(tabId)
    return automation.snapshot(tabId)
  }

  async readText(
    tabId: string,
    options: BrowserReadTextOptions & { snapshotId: string, ref: string },
  ): Promise<BrowserReadTextResult> {
    const { automation } = await this.ensureConnected()
    await this.requireSession(tabId)
    return automation.readText(tabId, options)
  }

  async interact(tabId: string, action: BrowserInteractAction): Promise<BrokerTabState> {
    const { automation } = await this.ensureConnected()
    await this.requireSession(tabId)
    await automation.interact(tabId, action)
    return this.requireTabState(tabId)
  }

  async screenshot(tabId: string, fullPage: boolean): Promise<BrowserScreenshot> {
    const { automation } = await this.ensureConnected()
    await this.requireSession(tabId)
    return automation.screenshot(tabId, fullPage)
  }

  consoleEntries(tabId: string): BrowserConsoleEntry[] {
    return this.automation?.consoleEntriesFor(tabId) ?? []
  }

  clearConsole(tabId: string): void {
    this.automation?.clearConsole(tabId)
  }

  setAgentControl(tabId: string, control: BrowserAgentControl): void {
    const session = this.connected?.session
    if (!session) return
    session.setAgentControl(tabId, control)
  }

  revokeAgentControl(tabId: string): void {
    this.connected?.session.revokeAgentControl(tabId)
  }

  /** User takeover: cancel the tab's in-flight automation (best effort). */
  cancelAgentOperation(tabId: string): void {
    this.automation?.forgetTab(tabId)
    const connection = this.connected
    const sessionId = connection?.session.tabInfo(tabId)?.cdpSessionId
    if (connection && sessionId) {
      void connection.client.send('Page.stopLoading', {}, sessionId).catch(() => undefined)
    }
  }

  /** Drop the runtime connection (shutdown, or after a crash). */
  async dispose(): Promise<void> {
    const connection = this.connected
    this.connected = null
    this.automation = null
    this.detachConsole?.()
    this.detachConsole = null
    if (!connection) return
    await connection.close().catch(err => logger.warn(err, '[browser] closing the broker session failed'))
  }
}
