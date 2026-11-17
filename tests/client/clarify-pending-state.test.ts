// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { useChatStore, type Session } from '@/stores/hermes/chat'

const api = vi.hoisted(() => ({ respond: vi.fn(), approve: vi.fn(), peer: vi.fn() }))
vi.mock('@/api/client', () => ({ getActiveProfileName: () => 'default', hasApiKey: () => false }))
vi.mock('@/api/studio/background-status', () => ({ observeBackgroundStatus: () => () => {} }))
vi.mock('@/api/studio/chat', () => ({
  respondClarify: api.respond, respondToolApproval: api.approve, onPeerUserMessage: api.peer,
  onUnobservedRunStarted: () => () => {}, onPersonUpdated: () => () => {}, onSessionCommand: () => () => {},
  onSessionTitleUpdated: () => () => {}, onSessionWorkspaceUpdated: () => () => {}, onSessionSettingsUpdated: () => () => {}, onRunUsageUpdated: () => () => {},
}))
vi.mock('@/stores/hermes/profiles', () => ({ useProfilesStore: () => ({ activeProfileName: 'default' }) }))
vi.mock('@/stores/hermes/settings', () => ({ useSettingsStore: () => ({ display: {} }) }))
vi.mock('@/stores/hermes/app', () => ({ useAppStore: () => ({}) }))

let pinia: ReturnType<typeof createPinia>
beforeEach(() => { vi.clearAllMocks(); api.peer.mockReturnValue(() => {}); localStorage.clear(); pinia = createPinia(); setActivePinia(pinia) })
afterEach(() => disposePinia(pinia))
function setup(sid: string) {
  const store = useChatStore()
  store.sessions = [{ id: sid, profile: 'work', messages: [] } as unknown as Session]
  store.activeSessionId = sid
  const receive = api.peer.mock.calls[0][0] as (event: any) => void
  const question = { event: 'clarify.requested', session_id: sid, clarify_id: 'question', question: 'Which?', choices: ['A', 'B'] }
  receive(question)
  return { store, receive, question }
}
function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

it.each(['session', 'person-main-bot'])('retains the question across navigation until accepted (%s)', async sid => {
  const { store, receive, question } = setup(sid), delivery = deferred()
  api.respond.mockReturnValueOnce(delivery.promise)
  const result = store.respondToClarify('B')
  expect(store.activePendingClarify).toMatchObject({ submitting: true, initialResponse: 'B' })
  expect(api.respond).toHaveBeenCalledWith(sid, 'question', 'B', 'chat-run', 'work')
  store.activeSessionId = 'elsewhere'
  receive(question)
  store.activeSessionId = sid
  expect(store.activePendingClarify).toMatchObject({ submitting: true, initialResponse: 'B' })
  await store.respondToClarify('A')
  expect(api.respond).toHaveBeenCalledOnce()
  delivery.resolve()
  expect(await result).toBe('submitted')
  expect(store.activePendingClarify).toBeNull()
})

it('keeps a failed answer visible and retryable after navigating away and back', async () => {
  const { store, receive, question } = setup('session')
  api.respond.mockRejectedValueOnce(new Error('transport closed'))
  await expect(store.respondToClarify('B')).rejects.toThrow('transport closed')
  store.activeSessionId = 'elsewhere'
  receive(question)
  store.activeSessionId = 'session'
  expect(store.activePendingClarify).toMatchObject({ initialResponse: 'B', submissionFailed: true, submitting: false })
  api.respond.mockResolvedValueOnce(undefined)
  expect(await store.respondToClarify('B')).toBe('submitted')
  expect(store.activePendingClarify).toBeNull()
})

it('does not erase a newer question when an old response completes late', async () => {
  const { store, receive, question } = setup('session'), delivery = deferred()
  api.respond.mockReturnValueOnce(delivery.promise)
  const result = store.respondToClarify('B')
  receive({ ...question, clarify_id: 'new-question' })
  delivery.resolve()
  await result
  expect(store.activePendingClarify?.clarifyId).toBe('new-question')
})

it.each([
  { reason: 'timed_out' },
  { error: "'unknown clarify request: question'" },
])('removes an expired Hermes question (%j)', detail => {
  const { store, receive } = setup('session')
  receive({ event: 'clarify.resolved', session_id: 'session', clarify_id: 'question', resolved: false, ...detail })
  expect(store.activePendingClarify).toBeNull()
})

it('keeps approval retryable across navigation until the owning profile accepts it', async () => {
  const { store, receive } = setup('session'), delivery = deferred()
  const request = { event: 'approval.requested', session_id: 'session', approval_id: 'request', command: 'Execute', choices: ['once', 'deny'] }
  receive(request)
  api.approve.mockReturnValueOnce(delivery.promise)
  const result = store.respondApproval('once')
  expect(store.activePendingApproval?.submitting).toBe(true)
  expect(api.approve).toHaveBeenCalledWith('session', 'request', 'once', 'chat-run', 'work')
  await store.respondApproval('deny')
  expect(api.approve).toHaveBeenCalledOnce()
  store.activeSessionId = 'elsewhere'
  receive(request)
  store.activeSessionId = 'session'
  expect(store.activePendingApproval?.submitting).toBe(true)
  delivery.reject(new Error('connection closed'))
  await expect(result).rejects.toThrow('connection closed')
  expect(store.activePendingApproval).toMatchObject({ submitting: false, submissionFailed: true })
  api.approve.mockResolvedValueOnce(undefined)
  expect(await store.respondApproval('deny')).toBe('submitted')
  expect(store.activePendingApproval).toBeNull()
})

it('does not erase a newer approval when an old response completes late', async () => {
  const { store, receive } = setup('session'), delivery = deferred()
  const request = { event: 'approval.requested', session_id: 'session', approval_id: 'request', command: 'Execute' }
  receive(request)
  api.approve.mockReturnValueOnce(delivery.promise)
  const result = store.respondApproval('once')
  receive({ ...request, approval_id: 'new-request' })
  delivery.resolve()
  await result
  expect(store.activePendingApproval?.approvalId).toBe('new-request')
})
