// @vitest-environment jsdom
// Manual unread in the session-state store: only an intentional open clears the mark.
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, nextTick, ref } from 'vue'
import { mount } from '@vue/test-utils'
import { createRouter, createWebHashHistory } from 'vue-router'

const transport = vi.hoisted(() => ({ sockets: [] as any[], invalidate: null as null | (() => void) }))
vi.mock('@/api/studio/session-state', () => ({ connectSessionState: () => {
  const handlers = new Map<string, Function>()
  const socket: any = { connected: true, handlers, on: vi.fn((event, handler) => handlers.set(event, handler)),
    emit: vi.fn(), removeAllListeners: vi.fn(), disconnect: vi.fn() }
  socket.timeout = vi.fn(() => socket)
  transport.sockets.push(socket)
  return socket
} }))
vi.mock('@/api/auth-invalidation', () => ({ onAuthInvalidated: (handler: () => void) => {
  transport.invalidate = handler
  return () => { transport.invalidate = null }
} }))
import { trackSessionOpens, useSessionStateStore } from '@/stores/hermes/session-state'
import { useSessionReadState } from '@/composables/useSessionReadState'

const status = (sessionId: string, changes = {}) => ({ sessionId, working: false, backgroundPending: 0,
  lastMessageId: 10, readMessageId: 0, unread: true, ...changes })
beforeEach(() => {
  setActivePinia(createPinia()); transport.sockets = []
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
})
afterEach(() => useSessionStateStore().stop())

describe('manual unread in the session state store', () => {
  it('offers manual unread only for read conversations the server can mark and reports the outcome', async () => {
    const store = useSessionStateStore(); store.start()
    const socket = transport.sockets[0]
    const read = { readMessageId: 10, unread: false, manualUnread: false, unreadRevision: 0, generation: 'g' }
    socket.handlers.get('sessions.state.snapshot')({ sessions: [status('chat', read), status('busy', { ...read, working: true }),
      status('fresh', { unreadRevision: 0, generation: 'g' }), status('legacy', { readMessageId: 10, unread: false })] })
    expect(['chat', 'busy', 'fresh', 'legacy', 'missing'].map(id => store.canMarkUnread(id))).toEqual([true, false, false, false, false])
    const outcomes: Array<[Error | null, any, boolean]> = [[null, { ok: true, changed: true }, true],
      [null, { ok: true, changed: false }, false], [null, { ok: false }, false], [new Error('operation has timed out'), undefined, false]]
    for (const [error, result, expected] of outcomes) {
      const pending = store.markUnread('chat')
      expect(socket.timeout).toHaveBeenLastCalledWith(expect.any(Number))
      expect(socket.emit).toHaveBeenLastCalledWith('sessions.unread', { sessionId: 'chat', unreadRevision: 0, generation: 'g' }, expect.any(Function))
      socket.emit.mock.lastCall[2](error, result)
      expect(await pending).toBe(expected)
    }
    socket.emit.mockClear()
    expect(await store.markUnread('fresh')).toBe(false)
    socket.connected = false
    expect(await store.markUnread('chat')).toBe(false)
    expect(socket.emit).not.toHaveBeenCalled()
  })

  it('keeps a manual mark through passive views until the conversation is opened again', async () => {
    const viewed = ref<string | null>(null)
    const store = useSessionStateStore()
    mount(defineComponent({ setup() { useSessionReadState(() => viewed.value); return () => null } }))
    const socket = transport.sockets[0]
    const update = (changes: Record<string, unknown>) => socket.handlers.get('sessions.state.updated')(status('chat', { generation: 'g', ...changes }))
    socket.handlers.get('sessions.state.snapshot')({ sessions: [status('chat', { readMessageId: 10, unread: false, manualUnread: false, unreadRevision: 0, generation: 'g' })] })
    store.acknowledge('chat')
    viewed.value = 'chat'; await nextTick()
    expect(socket.emit).not.toHaveBeenCalled()
    // Marked unread here or on another device while the conversation stays on screen.
    update({ readMessageId: 10, unread: true, manualUnread: true, unreadRevision: 5 }); await nextTick()
    window.dispatchEvent(new Event('focus'))
    document.dispatchEvent(new Event('visibilitychange'))
    expect(socket.emit).not.toHaveBeenCalled()
    expect(store.isUnread('chat')).toBe(true)
    // New replies are still acknowledged, but without permission to clear the mark.
    update({ lastMessageId: 11, readMessageId: 10, unread: true, manualUnread: true, unreadRevision: 5 }); await nextTick()
    expect(socket.emit).toHaveBeenCalledTimes(1)
    expect(socket.emit).toHaveBeenLastCalledWith('sessions.read', { sessionId: 'chat', messageId: 11 }, expect.any(Function))
    update({ lastMessageId: 11, readMessageId: 11, unread: true, manualUnread: true, unreadRevision: 5 }); await nextTick()
    // A reconnect snapshot does not count as opening the conversation.
    socket.handlers.get('sessions.state.snapshot')({ sessions: [status('chat', { lastMessageId: 11, readMessageId: 11, unread: true, manualUnread: true, unreadRevision: 5, generation: 'g' })] })
    await nextTick()
    expect(socket.emit).toHaveBeenCalledTimes(1)
    // Selecting it again, even while it is already open, reads the mark.
    store.acknowledge('chat'); await nextTick()
    expect(socket.emit).toHaveBeenLastCalledWith('sessions.read', { sessionId: 'chat', messageId: 11, unreadRevision: 5, generation: 'g' }, expect.any(Function))
    store.acknowledge('chat'); await nextTick()
    expect(socket.emit).toHaveBeenCalledTimes(2)
    update({ lastMessageId: 11, readMessageId: 11, unread: false, manualUnread: false, unreadRevision: 5 }); await nextTick()
    expect(socket.emit).toHaveBeenCalledTimes(2)
    // A later mark of the same cursors is a new receipt rather than a duplicate.
    update({ lastMessageId: 11, readMessageId: 11, unread: true, manualUnread: true, unreadRevision: 6 }); await nextTick()
    expect(socket.emit).toHaveBeenCalledTimes(2)
    store.acknowledge('chat'); await nextTick()
    expect(socket.emit).toHaveBeenLastCalledWith('sessions.read', { sessionId: 'chat', messageId: 11, unreadRevision: 6, generation: 'g' }, expect.any(Function))
  })

  it('does not let an open made before any state clear a mark that may be newer, and forgets opens after logout', async () => {
    const store = useSessionStateStore(); store.start()
    let socket = transport.sockets[0]
    const marked = status('chat', { readMessageId: 10, unread: true, manualUnread: true, unreadRevision: 3, generation: 'g' })
    store.acknowledge('chat') // Selected before the first snapshot; another device marks it meanwhile.
    socket.handlers.get('sessions.state.snapshot')({ sessions: [marked] })
    store.markRead('chat')
    expect(socket.emit).not.toHaveBeenCalled()
    store.acknowledge('chat')
    store.markRead('chat')
    expect(socket.emit).toHaveBeenLastCalledWith('sessions.read', { sessionId: 'chat', messageId: 10, unreadRevision: 3, generation: 'g' }, expect.any(Function))
    transport.invalidate!()
    store.start()
    socket = transport.sockets[1]
    socket.handlers.get('sessions.state.snapshot')({ sessions: [marked] })
    store.markRead('chat')
    expect(socket.emit).not.toHaveBeenCalled()
  })

  it('does not let an open made before any state clear a mark that arrives while loading', async () => {
    const viewed = ref<string | null>(null)
    const store = useSessionStateStore()
    mount(defineComponent({ setup() { useSessionReadState(() => viewed.value); return () => null } }))
    const socket = transport.sockets[0]
    store.acknowledge('chat')
    socket.handlers.get('sessions.state.snapshot')({ sessions: [status('chat', { readMessageId: 10, unread: false, manualUnread: false, unreadRevision: 0, generation: 'g' })] })
    // Marked unread while the transcript is still loading.
    socket.handlers.get('sessions.state.updated')(status('chat', { readMessageId: 10, unread: true, manualUnread: true, unreadRevision: 1, generation: 'g' }))
    viewed.value = 'chat'; await nextTick()
    expect(socket.emit).not.toHaveBeenCalled()
    store.acknowledge('chat'); await nextTick()
    expect(socket.emit).toHaveBeenLastCalledWith('sessions.read', { sessionId: 'chat', messageId: 10, unreadRevision: 1, generation: 'g' }, expect.any(Function))
  })

  it('reads a mark only after a selection or a history move, never after pushes, replacements or the initial route', async () => {
    const store = useSessionStateStore(); store.start()
    const socket = transport.sockets[0]
    const component = { render: () => null }
    const router = createRouter({ history: createWebHashHistory(), routes: [{ path: '/', name: 'home', component },
      { path: '/hermes/session/:sessionId', name: 'hermes.session', component }, { path: '/person', name: 'hermes.person', component }] })
    trackSessionOpens(router)
    const marked = (sessionId: string, unreadRevision: number) => status(sessionId, { readMessageId: 10, unread: true, manualUnread: true, unreadRevision, generation: 'g' })
    socket.handlers.get('sessions.state.snapshot')({ sessions: [marked('chat', 3), marked('person-main-one', 4)] })
    await router.push('/hermes/session/chat') // The page's initial route, e.g. after a refresh.
    store.markRead('chat')
    await router.push('/')
    await router.replace({ name: 'hermes.person', query: { session: 'person-main-one' } }) // An automatic selection.
    store.markRead('person-main-one')
    await router.push('/hermes/session/chat') // Programmatic navigation without a selection.
    store.markRead('chat')
    expect(socket.emit).not.toHaveBeenCalled()
    store.acknowledge('chat') // e.g. selecting the open row again
    store.markRead('chat')
    expect(socket.emit).toHaveBeenLastCalledWith('sessions.read', { sessionId: 'chat', messageId: 10, unreadRevision: 3, generation: 'g' }, expect.any(Function))
  })

  it('does not let an open of a deleted session clear a mark on a recreated one', async () => {
    const viewed = ref<string | null>(null)
    const store = useSessionStateStore()
    mount(defineComponent({ setup() { useSessionReadState(() => viewed.value); return () => null } }))
    const socket = transport.sockets[0]
    socket.handlers.get('sessions.state.snapshot')({ sessions: [status('chat', { readMessageId: 10, unread: false, manualUnread: false, unreadRevision: 1, generation: 'g1' })] })
    store.acknowledge('chat')
    viewed.value = 'chat'; await nextTick()
    // Reconnected after the session was recreated with the same id and marked at the same revision.
    socket.handlers.get('sessions.state.snapshot')({ sessions: [status('chat', { readMessageId: 10, unread: true, manualUnread: true, unreadRevision: 1, generation: 'g2' })] })
    await nextTick()
    expect(socket.emit).not.toHaveBeenCalled()
    store.acknowledge('chat'); await nextTick()
    expect(socket.emit).toHaveBeenLastCalledWith('sessions.read', { sessionId: 'chat', messageId: 10, unreadRevision: 1, generation: 'g2' }, expect.any(Function))
  })

  it('treats Back and Forward as opening a conversation, even into a replaced history entry', async () => {
    const store = useSessionStateStore(); store.start()
    const socket = transport.sockets[0]
    const component = { render: () => null }
    const router = createRouter({ history: createWebHashHistory(), routes: [{ path: '/', name: 'home', component },
      { path: '/hermes/session/:sessionId', name: 'hermes.session', component }, { path: '/person', name: 'hermes.person', component }] })
    trackSessionOpens(router)
    const read = (sessionId: string) => status(sessionId, { readMessageId: 10, unread: false, manualUnread: false, unreadRevision: 0, generation: 'g' })
    const marked = (sessionId: string) => status(sessionId, { readMessageId: 10, unread: true, manualUnread: true, unreadRevision: 1, generation: 'g' })
    socket.handlers.get('sessions.state.snapshot')({ sessions: [read('chat'), read('other')] })
    const settled = () => new Promise<void>(resolve => { const off = router.afterEach(() => { off(); resolve() }) })
    await router.push('/hermes/session/chat') // Initial entry.
    await router.push('/hermes/session/other')
    await router.replace({ path: '/hermes/session/other', query: { tasks: '1' } }) // Replaced entry, e.g. a drawer.
    await router.push('/hermes/session/chat')
    socket.handlers.get('sessions.state.updated')(marked('other'))
    let moved = settled(); router.back(); await moved
    store.markRead('other')
    expect(socket.emit).toHaveBeenLastCalledWith('sessions.read', { sessionId: 'other', messageId: 10, unreadRevision: 1, generation: 'g' }, expect.any(Function))
    socket.handlers.get('sessions.state.updated')(marked('chat'))
    moved = settled(); router.back(); await moved // Back to the page's initial entry.
    store.markRead('chat')
    expect(socket.emit).toHaveBeenLastCalledWith('sessions.read', { sessionId: 'chat', messageId: 10, unreadRevision: 1, generation: 'g' }, expect.any(Function))
  })

  it('keeps the mark an explicit selection saw when its navigation finishes after a slow load', async () => {
    const store = useSessionStateStore(); store.start()
    const socket = transport.sockets[0]
    const component = { render: () => null }
    const router = createRouter({ history: createWebHashHistory(), routes: [{ path: '/', name: 'home', component },
      { path: '/hermes/session/:sessionId', name: 'hermes.session', component }] })
    trackSessionOpens(router)
    socket.handlers.get('sessions.state.snapshot')({ sessions: [status('chat', { readMessageId: 10, unread: false, manualUnread: false, unreadRevision: 0, generation: 'g' }), status('other')] })
    await router.push('/hermes/session/other')
    store.acknowledge('chat') // e.g. a search result, which loads the transcript before navigating
    // Unrelated navigations while it loads, then another device marks the conversation.
    await router.replace({ path: '/hermes/session/other', query: { tasks: '1' } })
    await router.push({ path: '/hermes/session/other', query: { tasks: '1' } }).catch(() => undefined)
    socket.handlers.get('sessions.state.updated')(status('chat', { readMessageId: 10, unread: true, manualUnread: true, unreadRevision: 1, generation: 'g' }))
    await router.push('/hermes/session/chat')
    store.markRead('chat')
    expect(socket.emit).not.toHaveBeenCalledWith('sessions.read', expect.objectContaining({ sessionId: 'chat' }), expect.any(Function))
    store.acknowledge('chat')
    store.markRead('chat')
    expect(socket.emit).toHaveBeenLastCalledWith('sessions.read', { sessionId: 'chat', messageId: 10, unreadRevision: 1, generation: 'g' }, expect.any(Function))
  })

  it('does not let a failed Back navigation open the next automatically selected conversation', async () => {
    const store = useSessionStateStore(); store.start()
    const socket = transport.sockets[0]
    const component = { render: () => null }
    const router = createRouter({ history: createWebHashHistory(), routes: [{ path: '/', name: 'home', component },
      { path: '/hermes/session/:sessionId', name: 'hermes.session', component }] })
    trackSessionOpens(router)
    let fail = false
    router.beforeEach(() => { if (fail) throw new Error('blocked') })
    const failed = new Promise<void>(resolve => router.onError(() => resolve()))
    const marked = (sessionId: string) => status(sessionId, { readMessageId: 10, unread: true, manualUnread: true, unreadRevision: 1, generation: 'g' })
    socket.handlers.get('sessions.state.snapshot')({ sessions: [marked('a'), marked('b'), marked('c')] })
    await router.push('/hermes/session/a')
    await router.push('/hermes/session/b')
    fail = true; router.back(); await failed; fail = false
    await router.replace('/hermes/session/c') // e.g. the fallback after deleting a conversation
    store.markRead('c')
    expect(socket.emit).not.toHaveBeenCalled()
  })

})
