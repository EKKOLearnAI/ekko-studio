import { describe, expect, it, vi } from 'vitest'
import {
  BrowserSession,
  BrowserSessionPool,
  BrowserTabCapError,
  MAX_BROWSER_SESSIONS,
  MAX_TABS_PER_SESSION,
  browserTabCapMessage,
  type BrowserSessionCdp,
} from '../../packages/server/src/modules/studio/services/browser/session'

type Handler = (params: any, meta: { sessionId?: string, method: string }) => void

interface Command {
  method: string
  params?: Record<string, unknown>
  sessionId?: string
}

class FakeCdp implements BrowserSessionCdp {
  readonly commands: Command[] = []
  readonly handlers = new Map<string, Set<Handler>>()
  private contextSeq = 0
  private targetSeq = 0
  navigationHistory: { currentIndex: number, entries: Array<{ id: number, url: string, userTypedURL: string, title: string, transitionType: string }> } = {
    currentIndex: 0,
    entries: [{ id: 1, url: 'about:blank', userTypedURL: '', title: '', transitionType: 'typed' }],
  }

  async send<T = any>(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<T> {
    this.commands.push({ method, params, sessionId })
    switch (method) {
      case 'Target.createBrowserContext':
        this.contextSeq += 1
        return { browserContextId: `ctx-${this.contextSeq}` } as T
      case 'Target.createTarget':
        this.targetSeq += 1
        return { targetId: `tab-${this.targetSeq}` } as T
      case 'Target.attachToTarget': {
        const targetId = String(params?.targetId || '')
        return { sessionId: `sess-${targetId}` } as T
      }
      case 'Page.getNavigationHistory':
        return this.navigationHistory as T
      default:
        return {} as T
    }
  }

  on<T = any>(method: string, handler: Handler): () => void {
    let set = this.handlers.get(method)
    if (!set) {
      set = new Set()
      this.handlers.set(method, set)
    }
    set.add(handler as Handler)
    return () => set?.delete(handler as Handler)
  }

  emit(method: string, params: any, sessionId?: string): void {
    for (const handler of this.handlers.get(method) ?? []) {
      handler(params, { method, sessionId })
    }
  }

  countOf(method: string): number {
    return this.commands.filter(command => command.method === method).length
  }
}

async function createSession(cdp: FakeCdp, overrides: Record<string, unknown> = {}) {
  return BrowserSession.create({ cdp, sessionKey: 's1', ...overrides })
}

describe('browser session', () => {
  it('creates one browser context per session', async () => {
    const cdp = new FakeCdp()
    const session = await createSession(cdp)

    expect(session.browserContextId).toBe('ctx-1')
    expect(cdp.commands[0].method).toBe('Target.createBrowserContext')
    expect(session.listTabs()).toEqual([])
  })

  it('creates a tab from the CDP target id and enables Page on its session', async () => {
    const cdp = new FakeCdp()
    const session = await createSession(cdp)

    const tab = await session.createTab('https://example.com')

    expect(tab.id).toBe('tab-1')
    expect(tab.url).toBe('https://example.com')
    expect(session.listTabs()).toHaveLength(1)
    expect(session.activeTab?.id).toBe('tab-1')

    const createTarget = cdp.commands.find(command => command.method === 'Target.createTarget')
    expect(createTarget?.params).toMatchObject({
      url: 'https://example.com',
      browserContextId: 'ctx-1',
    })
    const enable = cdp.commands.find(command => command.method === 'Page.enable')
    expect(enable?.sessionId).toBe('sess-tab-1')
  })

  it(`caps a session at ${MAX_TABS_PER_SESSION} tabs with the desktop wording`, async () => {
    const cdp = new FakeCdp()
    const session = await createSession(cdp)

    for (let index = 0; index < MAX_TABS_PER_SESSION; index += 1) {
      await session.createTab()
    }

    await expect(session.createTab()).rejects.toBeInstanceOf(BrowserTabCapError)
    await expect(session.createTab()).rejects.toThrow(browserTabCapMessage())
    expect(session.listTabs()).toHaveLength(MAX_TABS_PER_SESSION)
  })

  it('closes tabs and keeps the active tab pointing at a live one', async () => {
    const cdp = new FakeCdp()
    const session = await createSession(cdp)
    const first = await session.createTab()
    const second = await session.createTab()

    await session.closeTab(second.id)

    expect(session.listTabs().map(tab => tab.id)).toEqual([first.id])
    expect(session.activeTab?.id).toBe(first.id)
    expect(cdp.countOf('Target.closeTarget')).toBe(1)

    // Closing an unknown tab is a no-op, not an error.
    await session.closeTab('missing')
    expect(cdp.countOf('Target.closeTarget')).toBe(1)
  })

  it('disposes idempotently: every tab closed, context disposed, listeners dropped', async () => {
    const cdp = new FakeCdp()
    const session = await createSession(cdp)
    await session.createTab()
    await session.createTab()

    await session.dispose()
    await session.dispose()

    expect(cdp.countOf('Target.closeTarget')).toBe(2)
    expect(cdp.countOf('Target.disposeBrowserContext')).toBe(1)
    expect(session.isDisposed()).toBe(true)
    expect(session.listTabs()).toEqual([])
    await expect(session.createTab()).rejects.toThrow(/disposed/)

    // Events after disposal must not resurrect state.
    cdp.emit('Target.targetCreated', {
      targetInfo: { targetId: 'tab-99', type: 'page', url: 'https://late', title: '', browserContextId: 'ctx-1' },
    })
    expect(session.listTabs()).toEqual([])
  })
})

describe('browser session target discovery', () => {
  const ownTarget = (id: string, url: string) => ({
    targetInfo: { targetId: id, type: 'page', url, title: '', browserContextId: 'ctx-1' },
  })

  it('adopts page-created targets in its own context and forgets destroyed ones', async () => {
    const cdp = new FakeCdp()
    const session = await createSession(cdp)

    cdp.emit('Target.targetCreated', ownTarget('tab-x', 'https://x.test'))
    expect(session.listTabs().map(tab => tab.id)).toEqual(['tab-x'])

    cdp.emit('Target.targetInfoChanged', {
      targetInfo: { targetId: 'tab-x', type: 'page', url: 'https://x.test/2', title: 'X', browserContextId: 'ctx-1' },
    })
    expect(session.listTabs()[0]).toMatchObject({ url: 'https://x.test/2', title: 'X' })

    cdp.emit('Target.targetDestroyed', { targetId: 'tab-x' })
    expect(session.listTabs()).toEqual([])
  })

  it('ignores targets from another browser context', async () => {
    const cdp = new FakeCdp()
    const session = await createSession(cdp)

    cdp.emit('Target.targetCreated', {
      targetInfo: { targetId: 'foreign', type: 'page', url: 'https://other', title: '', browserContextId: 'ctx-999' },
    })

    expect(session.listTabs()).toEqual([])
  })

  it('refuses a page-created tab beyond the cap instead of tracking it', async () => {
    const cdp = new FakeCdp()
    const session = await createSession(cdp)
    for (let index = 0; index < MAX_TABS_PER_SESSION; index += 1) await session.createTab()

    cdp.emit('Target.targetCreated', ownTarget('tab-overflow', 'https://popup.test'))
    await new Promise(resolve => setImmediate(resolve))

    expect(session.listTabs()).toHaveLength(MAX_TABS_PER_SESSION)
    expect(cdp.commands.some(command => (
      command.method === 'Target.closeTarget' && command.params?.targetId === 'tab-overflow'
    ))).toBe(true)
  })

  it('tracks url, loading and navigation state from tab-scoped events', async () => {
    const cdp = new FakeCdp()
    const session = await createSession(cdp)
    const tab = await session.createTab()
    const cdpSessionId = `sess-${tab.id}`

    cdp.emit('Page.frameStartedLoading', { frameId: 'f1' }, cdpSessionId)
    expect(session.listTabs()[0].loading).toBe(true)

    cdp.emit('Page.frameNavigated', { frame: { id: 'f1', url: 'https://nav.test' }, type: 'Navigation' }, cdpSessionId)
    cdp.navigationHistory = {
      currentIndex: 1,
      entries: [
        { id: 1, url: 'about:blank', userTypedURL: '', title: 'Blank', transitionType: 'typed' },
        { id: 2, url: 'https://nav.test', userTypedURL: '', title: 'Nav', transitionType: 'link' },
      ],
    }
    cdp.emit('Page.loadEventFired', {}, cdpSessionId)
    await session.syncNavigationState(tab.id)

    const state = session.listTabs()[0]
    expect(state).toMatchObject({
      url: 'https://nav.test',
      title: 'Nav',
      loading: false,
      canGoBack: true,
      canGoForward: false,
    })

    cdp.emit('Inspector.targetCrashed', { status: 'crashed', errorCode: 5 }, cdpSessionId)
    expect(session.listTabs()[0].crashed).toBe(true)
  })

  it('ignores frame events from a foreign session id', async () => {
    const cdp = new FakeCdp()
    const session = await createSession(cdp)
    await session.createTab()

    cdp.emit('Page.frameNavigated', { frame: { id: 'f1', url: 'https://foreign' }, type: 'Navigation' }, 'sess-other')

    expect(session.listTabs()[0].url).toBe('about:blank')
  })
})

describe('browser session isolation', () => {
  it('gives two sessions distinct contexts and keeps their commands apart', async () => {
    const cdp = new FakeCdp()
    const first = await createSession(cdp)
    const second = await BrowserSession.create({ cdp, sessionKey: 's2' })

    expect(first.browserContextId).not.toBe(second.browserContextId)

    const firstTab = await first.createTab('https://one.test')
    const secondTab = await second.createTab('https://two.test')

    const createTargets = cdp.commands.filter(command => command.method === 'Target.createTarget')
    expect(createTargets[0].params?.browserContextId).toBe(first.browserContextId)
    expect(createTargets[1].params?.browserContextId).toBe(second.browserContextId)

    expect(first.listTabs().map(tab => tab.id)).toEqual([firstTab.id])
    expect(second.listTabs().map(tab => tab.id)).toEqual([secondTab.id])
  })
})

describe('browser session pool', () => {
  it('reuses a live session for the same key', async () => {
    const cdp = new FakeCdp()
    const pool = new BrowserSessionPool({ cdp })

    const first = await pool.acquire('chat-1')
    const second = await pool.acquire('chat-1')

    expect(second).toBe(first)
    expect(cdp.countOf('Target.createBrowserContext')).toBe(1)
  })

  it(`refuses a new session when ${MAX_BROWSER_SESSIONS} busy sessions exist`, async () => {
    const cdp = new FakeCdp()
    const pool = new BrowserSessionPool({ cdp })

    for (let index = 0; index < MAX_BROWSER_SESSIONS; index += 1) {
      await pool.acquire(`chat-${index}`)
    }

    await expect(pool.acquire('chat-overflow')).rejects.toThrow(/session limit reached/i)
  })

  it('reclaims the least recently used idle session to admit a new one', async () => {
    const cdp = new FakeCdp()
    let now = 1_000
    const pool = new BrowserSessionPool({ cdp, idleTtlMs: 100, now: () => now })

    for (let index = 0; index < MAX_BROWSER_SESSIONS; index += 1) {
      const session = await pool.acquire(`chat-${index}`)
      session.touch()
    }
    now += 500

    const session = await pool.acquire('chat-new')

    expect(session.isDisposed()).toBe(false)
    expect(pool.size()).toBe(MAX_BROWSER_SESSIONS)
    expect(cdp.countOf('Target.disposeBrowserContext')).toBe(1)
  })

  it('sweeps only idle sessions', async () => {
    const cdp = new FakeCdp()
    let now = 5_000
    const pool = new BrowserSessionPool({ cdp, idleTtlMs: 1_000, now: () => now })

    const stale = await pool.acquire('stale')
    now += 5_000
    const fresh = await pool.acquire('fresh')

    const reclaimed = await pool.sweepIdle()

    expect(reclaimed).toEqual(['stale'])
    expect(stale.isDisposed()).toBe(true)
    expect(fresh.isDisposed()).toBe(false)
    expect(pool.keys()).toEqual(['fresh'])
  })

  it('disposes every session on shutdown', async () => {
    const cdp = new FakeCdp()
    const pool = new BrowserSessionPool({ cdp })
    await pool.acquire('a')
    await pool.acquire('b')

    await pool.disposeAll()

    expect(pool.size()).toBe(0)
    expect(cdp.countOf('Target.disposeBrowserContext')).toBe(2)
  })

  it('releases a single session without touching the others', async () => {
    const cdp = new FakeCdp()
    const pool = new BrowserSessionPool({ cdp })
    const kept = await pool.acquire('kept')
    const dropped = await pool.acquire('dropped')

    await pool.release('dropped')

    expect(dropped.isDisposed()).toBe(true)
    expect(kept.isDisposed()).toBe(false)
    expect(pool.keys()).toEqual(['kept'])

    const spy = vi.fn()
    await pool.release('missing').then(spy)
    expect(spy).toHaveBeenCalled()
  })
})
