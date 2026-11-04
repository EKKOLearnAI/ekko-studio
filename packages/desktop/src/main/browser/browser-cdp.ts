import type { WebContents } from 'electron'
import type { BrowserNetworkEntry, BrowserPageDialog } from './browser-types'
import { publicBrowserUrl, redactBrowserText } from './browser-url'

// Per-tab DevTools state shared by automation: out-of-process iframe sessions,
// a blocking page dialog, an intercepted file chooser and a bounded network log.
export const NETWORK_LOG_LIMIT = 300
const MAX_FRAME_SESSIONS = 32

export interface FrameSession {
  sessionId: string
  /** For an out-of-process iframe the target id is also its frame id. */
  targetId: string
  parentSessionId?: string
  ready: Promise<void>
}

export interface InterceptedFileChooser {
  backendNodeId: number
  sessionId?: string
  multiple: boolean
  openedAt: number
}

interface PendingRequest {
  entry: BrowserNetworkEntry
  started: number
}

export class CdpTabState {
  readonly sessions = new Map<string, FrameSession>()
  dialog?: BrowserPageDialog & { sessionId?: string }
  fileChooser?: InterceptedFileChooser
  interceptFileChooser = false
  /** Whether the root session has its domains and iframe auto-attach enabled. */
  configured = false
  network: BrowserNetworkEntry[] = []
  lastPointer?: { x: number; y: number; to_x?: number; to_y?: number }
  onDragIntercepted?: (data: unknown) => void
  private readonly requests = new Map<string, PendingRequest>()
  private readonly dialogWaiters = new Set<() => void>()
  private listener?: (...args: any[]) => void
  private detachListener?: () => void

  constructor(private readonly contents: WebContents) {}

  send<T = any>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    return (sessionId
      ? this.contents.debugger.sendCommand(method, params, sessionId)
      : this.contents.debugger.sendCommand(method, params)) as Promise<T>
  }

  /** Subscribe once per attach; Electron delivers child-session events with their session id. */
  listen(): void {
    const api = this.contents.debugger as WebContents['debugger'] & { on?: unknown; removeListener?: unknown }
    if (this.listener || typeof api.on !== 'function') return
    this.listener = (_event: unknown, method: string, params: any, sessionId?: string) => this.handle(method, params || {}, sessionId || undefined)
    this.detachListener = () => this.reset()
    api.on('message', this.listener)
    api.on('detach', this.detachListener)
  }

  /** Forget session-bound state after the debugger detaches; the next attach reconfigures. */
  reset(): void {
    this.configured = false
    this.sessions.clear()
    this.requests.clear()
    this.dialog = undefined
    this.fileChooser = undefined
    this.notifyDialog()
  }

  dispose(): void {
    const api = this.contents.debugger as WebContents['debugger'] & { removeListener?: unknown }
    if (typeof api.removeListener === 'function') {
      if (this.listener) api.removeListener('message', this.listener)
      if (this.detachListener) api.removeListener('detach', this.detachListener)
    }
    this.listener = undefined
    this.detachListener = undefined
    this.reset()
  }

  /** Resolves when a page dialog opens; used to stop waiting on a command the dialog blocks. */
  async untilDialog<T>(operation: Promise<T>): Promise<T | 'dialog'> {
    if (this.dialog) {
      operation.catch(() => undefined)
      return 'dialog'
    }
    let release!: () => void
    const opened = new Promise<'dialog'>(resolve => {
      release = () => { if (this.dialog) resolve('dialog') }
      this.dialogWaiters.add(release)
    })
    try {
      const result = await Promise.race([operation, opened])
      if (result === 'dialog') operation.catch(() => undefined)
      return result
    } finally {
      this.dialogWaiters.delete(release)
    }
  }

  async configureSession(sessionId?: string): Promise<void> {
    const commands: Array<[string, Record<string, unknown>]> = [
      ['Page.enable', {}], ['DOM.enable', {}], ['Network.enable', { maxTotalBufferSize: 0, maxResourceBufferSize: 0 }],
      ['Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true, filter: [{ type: 'iframe' }] }],
    ]
    if (this.interceptFileChooser) commands.push(['Page.setInterceptFileChooserDialog', { enabled: true }])
    for (const [method, params] of commands) await this.send(method, params, sessionId).catch(() => undefined)
  }

  async setFileChooserInterception(enabled: boolean): Promise<void> {
    this.interceptFileChooser = enabled
    if (!enabled) this.fileChooser = undefined
    if (!this.contents.debugger.isAttached()) return
    await Promise.all([undefined, ...this.sessions.keys()].map(sessionId =>
      this.send('Page.setInterceptFileChooserDialog', { enabled }, sessionId).catch(() => undefined)))
  }

  clearNetwork(): void {
    this.network = []
    this.requests.clear()
  }

  private notifyDialog(): void {
    for (const waiter of [...this.dialogWaiters]) waiter()
  }

  private handle(method: string, params: any, sessionId?: string): void {
    switch (method) {
      case 'Target.attachedToTarget': {
        const child = params.sessionId as string
        // Electron emits this synchronously from inside Chromium's auto-attach loop;
        // sending a command re-entrantly there crashes the browser process.
        if (params.targetInfo?.type !== 'iframe' || this.sessions.size >= MAX_FRAME_SESSIONS) {
          setImmediate(() => void this.send('Target.detachFromTarget', { sessionId: child }, sessionId).catch(() => undefined))
          return
        }
        const session: FrameSession = { sessionId: child, targetId: params.targetInfo.targetId, parentSessionId: sessionId, ready: Promise.resolve() }
        session.ready = new Promise<void>(resolve => setImmediate(resolve)).then(() =>
          this.sessions.has(child) ? this.configureSession(child) : undefined)
        this.sessions.set(child, session)
        return
      }
      case 'Target.detachedFromTarget': {
        const removed = [params.sessionId as string]
        while (removed.length) {
          const id = removed.pop()!
          this.sessions.delete(id)
          for (const item of this.sessions.values()) if (item.parentSessionId === id) removed.push(item.sessionId)
        }
        return
      }
      case 'Page.javascriptDialogOpening':
        this.dialog = {
          type: params.type, message: redactBrowserText(params.message, 2000), url: publicBrowserUrl(String(params.url || '')),
          ...(params.type === 'prompt' ? { defaultPrompt: redactBrowserText(params.defaultPrompt, 500) } : {}),
          openedAt: new Date().toISOString(), sessionId,
        }
        this.notifyDialog()
        return
      case 'Page.javascriptDialogClosed':
        if (this.dialog?.sessionId === sessionId) this.dialog = undefined
        return
      case 'Page.fileChooserOpened':
        if (typeof params.backendNodeId === 'number') {
          this.fileChooser = { backendNodeId: params.backendNodeId, sessionId, multiple: params.mode === 'selectMultiple', openedAt: Date.now() }
        }
        return
      case 'Input.dragIntercepted':
        this.onDragIntercepted?.(params.data)
        return
      case 'Network.requestWillBeSent': {
        const key = `${sessionId || ''}#${params.requestId}`
        // Redirects reuse the request id; finish the previous hop first.
        const previous = this.requests.get(key)
        if (previous && params.redirectResponse) this.finish(key, { status: params.redirectResponse.status })
        const entry: BrowserNetworkEntry = {
          method: String(params.request?.method || 'GET'), url: publicBrowserUrl(String(params.request?.url || '')),
          type: String(params.type || 'Other'), startedAt: new Date().toISOString(),
          ...(sessionId ? { frame: 'iframe' } : {}),
        }
        this.requests.set(key, { entry, started: Date.now() })
        this.push(entry)
        return
      }
      case 'Network.responseReceived': {
        const pending = this.requests.get(`${sessionId || ''}#${params.requestId}`)
        if (!pending) return
        pending.entry.status = params.response?.status
        pending.entry.mimeType = String(params.response?.mimeType || '').slice(0, 100)
        if (params.response?.fromDiskCache || params.response?.fromServiceWorker) pending.entry.fromCache = true
        return
      }
      case 'Network.loadingFinished':
        this.finish(`${sessionId || ''}#${params.requestId}`, { encodedBytes: params.encodedDataLength })
        return
      case 'Network.loadingFailed':
        this.finish(`${sessionId || ''}#${params.requestId}`, {
          failed: true, error: params.canceled ? 'canceled' : redactBrowserText(params.errorText || params.blockedReason || 'failed', 200),
        })
        return
    }
  }

  private finish(key: string, update: Partial<BrowserNetworkEntry>): void {
    const pending = this.requests.get(key)
    if (!pending) return
    this.requests.delete(key)
    Object.assign(pending.entry, update, { durationMs: Date.now() - pending.started })
    if (typeof pending.entry.encodedBytes === 'number') pending.entry.encodedBytes = Math.max(0, Math.round(pending.entry.encodedBytes))
  }

  private push(entry: BrowserNetworkEntry): void {
    this.network.push(entry)
    if (this.network.length > NETWORK_LOG_LIMIT) this.network.splice(0, this.network.length - NETWORK_LOG_LIMIT)
    if (this.requests.size > NETWORK_LOG_LIMIT) {
      for (const key of [...this.requests.keys()].slice(0, this.requests.size - NETWORK_LOG_LIMIT)) this.requests.delete(key)
    }
  }
}
