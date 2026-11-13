// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { useChatStore, type Attachment, type Session } from '../../packages/client/src/stores/hermes/chat'
import { invalidateAuth } from '../../packages/client/src/api/auth-invalidation'

const transport = vi.hoisted(() => ({
  start: vi.fn(), emit: vi.fn(), abort: vi.fn(), modelsReady: vi.fn(), observe: vi.fn(), register: vi.fn(),
}))
vi.mock('@/stores/hermes/app', () => ({ useAppStore: () => ({
  waitForModelsForRun: transport.modelsReady, selectedModel: 'test-model', selectedProvider: 'test-provider',
  profileModelGroups: [], modelGroups: [],
}) }))
vi.mock('@/stores/hermes/profiles', () => ({ useProfilesStore: () => ({ activeProfileName: 'default' }) }))
vi.mock('@/stores/hermes/settings', () => ({ useSettingsStore: () => ({ display: {} }) }))
vi.mock('@/api/studio/chat', () => ({
  startRunViaSocket: transport.start,
  getChatRunSocket: () => ({ emit: transport.emit }),
  registerSessionHandlers: transport.register, unregisterSessionHandlers: vi.fn(), resumeSession: vi.fn(),
  onUnobservedRunStarted: (listener: unknown) => { transport.observe(listener); return () => {} },
  onPeerUserMessage: vi.fn(), onPersonUpdated: vi.fn(),
  onSessionCommand: vi.fn(), onSessionTitleUpdated: vi.fn(), onSessionWorkspaceUpdated: vi.fn(),
  onSessionSettingsUpdated: vi.fn(), onRunUsageUpdated: vi.fn(),
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

const attachment: Attachment = {
  id: 'audio', name: 'wrong.wav', type: 'audio/wav', size: 5, url: 'blob:fixture',
  file: new File(['audio'], 'wrong.wav', { type: 'audio/wav' }),
}
const uploadResponse = () => ({ ok: true, json: async () => ({ files: [{ name: 'wrong.wav', path: '/uploads/wrong.wav' }] }) })
let pinia: ReturnType<typeof createPinia>
let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  pinia = createPinia()
  setActivePinia(pinia)
  transport.start.mockReturnValue({ abort: transport.abort })
  transport.modelsReady.mockResolvedValue(undefined)
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { disposePinia(pinia); vi.unstubAllGlobals() })

function chat() {
  const store = useChatStore()
  store.sessions.push({ id: 'session-a', title: 'Test', messages: [], source: 'cli', agent: 'hermes',
    profile: 'default', model: 'test-model', provider: 'test-provider', messageCount: 1, isLocalOnly: true,
    createdAt: Date.now(), updatedAt: Date.now(),
  } as Session)
  store.activeSessionId = 'session-a'
  store.activeSession = store.sessions[0]!
  return store
}

it('does not dispatch an attachment message after Stop during upload', async () => {
  const upload = deferred<ReturnType<typeof uploadResponse>>()
  fetchMock.mockReturnValueOnce(upload.promise)
  const store = chat()
  const send = store.sendMessage('', [attachment])
  expect(fetchMock).toHaveBeenCalledOnce()
  expect(store.isStreaming).toBe(true)
  store.stopStreaming()
  expect(fetchMock.mock.calls[0]![1].signal.aborted).toBe(true)
  expect(store.messages).toHaveLength(0)
  expect(store.cancelledAttachmentDrafts.get('session-a')).toMatchObject({ content: '', attachments: [attachment] })
  expect(store.isStreaming).toBe(false)
  expect(store.runStartedAt.has('session-a')).toBe(false)
  expect(transport.emit).not.toHaveBeenCalled()
  upload.resolve(uploadResponse())
  await send
  expect(transport.start).not.toHaveBeenCalled()
  expect(store.isStreaming).toBe(false)
  expect(store.isAborting).toBe(false)
})

it('honors Stop while model preparation is still pending after upload', async () => {
  const models = deferred<void>()
  transport.modelsReady.mockReturnValueOnce(models.promise)
  fetchMock.mockResolvedValueOnce(uploadResponse())
  const store = chat()
  const send = store.sendMessage('process this', [attachment])
  await vi.waitFor(() => expect(transport.modelsReady).toHaveBeenCalledOnce())
  store.stopStreaming()
  expect(store.messages).toHaveLength(0)
  expect(store.cancelledAttachmentDrafts.get('session-a')?.content).toBe('process this')
  models.resolve()
  await send
  expect(transport.start).not.toHaveBeenCalled()
  expect(store.isStreaming).toBe(false)
  expect(store.isAborting).toBe(false)
})

it('does not let a cancelled upload response clear a replacement send', async () => {
  const oldUpload = deferred<ReturnType<typeof uploadResponse>>()
  const replacementUpload = deferred<ReturnType<typeof uploadResponse>>()
  fetchMock.mockReturnValueOnce(oldUpload.promise).mockReturnValueOnce(replacementUpload.promise)
  const store = chat()
  const oldSend = store.sendMessage('', [attachment])
  store.stopStreaming()
  const replacementSend = store.sendMessage('replacement', [attachment])
  oldUpload.resolve(uploadResponse())
  await oldSend
  expect(store.isStreaming).toBe(true)
  store.stopStreaming()
  expect(fetchMock.mock.calls[1]![1].signal.aborted).toBe(true)
  replacementUpload.resolve(uploadResponse())
  await replacementSend
  expect(transport.start).not.toHaveBeenCalled()
  expect(store.isStreaming).toBe(false)
})

it('suppresses a late upload failure after Stop and allows a new run', async () => {
  const upload = deferred<ReturnType<typeof uploadResponse>>()
  fetchMock.mockReturnValueOnce(upload.promise)
  const store = chat()
  const oldSend = store.sendMessage('', [attachment])
  store.stopStreaming()
  await store.sendMessage('replacement')
  upload.reject(new DOMException('aborted', 'AbortError'))
  await oldSend
  expect(transport.start).toHaveBeenCalledOnce()
  expect(transport.start.mock.calls[0]![0].input).toBe('replacement')
  expect(store.messages.filter(message => message.role === 'user').map(message => message.content)).toEqual(['replacement'])
  expect(store.isStreaming).toBe(true)
  expect(store.messages.some(message => message.role === 'system')).toBe(false)
  store.stopStreaming()
  expect(transport.abort).toHaveBeenCalledOnce()
})

it('dispatches attachment-only input without a delay when Stop is not pressed', async () => {
  fetchMock.mockResolvedValueOnce(uploadResponse())
  const store = chat()
  await store.sendMessage('', [attachment])
  expect(transport.start).toHaveBeenCalledOnce()
  expect(transport.start.mock.calls[0]![0]).toMatchObject({ session_id: 'session-a', input: [
    { type: 'file', path: '/uploads/wrong.wav', name: 'wrong.wav', media_type: 'audio/wav' },
  ] })
  store.stopStreaming()
  expect(transport.abort).toHaveBeenCalledOnce()
  expect(store.isAborting).toBe(true)
})

it('keeps another session\'s pending attachment send independent of Stop', async () => {
  const upload = deferred<ReturnType<typeof uploadResponse>>()
  fetchMock.mockReturnValueOnce(upload.promise)
  const store = chat()
  const send = store.sendMessage('', [attachment])
  const original = store.activeSession
  store.activeSessionId = 'session-b'
  store.activeSession = { ...original!, id: 'session-b' }
  store.stopStreaming()
  expect(fetchMock.mock.calls[0]![1].signal.aborted).toBe(false)
  store.activeSessionId = 'session-a'
  store.activeSession = original
  upload.resolve(uploadResponse())
  await send
  expect(transport.start).toHaveBeenCalledOnce()
  expect(store.isSessionLive('session-a')).toBe(true)
})

it('also stops a run started by another client while the local upload was pending', async () => {
  const upload = deferred<ReturnType<typeof uploadResponse>>()
  fetchMock.mockReturnValueOnce(upload.promise)
  const store = chat()
  const send = store.sendMessage('', [attachment])
  const event = { event: 'run.started', session_id: 'session-a', run_id: 'peer-run' }
  transport.observe.mock.calls[0]![0](event)
  transport.register.mock.lastCall![1].onRunStarted(event)
  store.stopStreaming()
  expect(transport.emit).toHaveBeenCalledWith('abort', { session_id: 'session-a' })
  expect(store.isAborting).toBe(true)
  upload.resolve(uploadResponse())
  await send
  expect(transport.start).not.toHaveBeenCalled()
})

it('preserves manual queued attachment sends when stopping the active run', async () => {
  const upload = deferred<ReturnType<typeof uploadResponse>>()
  fetchMock.mockReturnValueOnce(upload.promise)
  const store = chat()
  await store.sendMessage('active run')
  const send = store.sendMessage('', [attachment])
  store.stopStreaming()
  expect(transport.abort).toHaveBeenCalledOnce()
  upload.resolve(uploadResponse())
  await send
  expect(transport.start).toHaveBeenCalledTimes(2)
  expect(store.queuedUserMessages.get('session-a')).toHaveLength(1)
})

it('still reports genuine upload errors and releases the optimistic busy state', async () => {
  fetchMock.mockRejectedValueOnce(new Error('upload unavailable'))
  const store = chat()
  await store.sendMessage('', [attachment])
  expect(transport.start).not.toHaveBeenCalled()
  expect(store.isStreaming).toBe(false)
  expect(store.messages.at(-1)?.content).toBe('Error: upload unavailable')
})

it('cancels pending uploads when authentication is invalidated', async () => {
  const upload = deferred<ReturnType<typeof uploadResponse>>()
  fetchMock.mockReturnValueOnce(upload.promise)
  const store = chat()
  const send = store.sendMessage('', [attachment])
  invalidateAuth()
  expect(fetchMock.mock.calls[0]![1].signal.aborted).toBe(true)
  upload.resolve(uploadResponse())
  await send
  expect(transport.start).not.toHaveBeenCalled()
  expect(store.isStreaming).toBe(false)
})

it('can retry a cancelled attachment draft without duplicating its unsent message', async () => {
  const upload = deferred<ReturnType<typeof uploadResponse>>()
  fetchMock.mockReturnValueOnce(upload.promise).mockResolvedValueOnce(uploadResponse())
  const store = chat()
  const send = store.sendMessage('retry this', [attachment])
  store.stopStreaming()
  const draft = store.cancelledAttachmentDrafts.get('session-a')!
  expect(store.messages).toHaveLength(0)
  store.cancelledAttachmentDrafts.delete('session-a')
  await store.sendMessage(draft.content, draft.attachments)
  upload.resolve(uploadResponse())
  await send
  expect(transport.start).toHaveBeenCalledOnce()
  expect(store.messages.filter(message => message.role === 'user')).toHaveLength(1)
  expect(store.messages[0]?.content).toBe('retry this')
})
