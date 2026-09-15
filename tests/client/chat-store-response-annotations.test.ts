// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const chatApi = vi.hoisted(() => ({
  startRunViaSocket: vi.fn(),
  resumeSession: vi.fn(),
  registerSessionHandlers: vi.fn(),
  unregisterSessionHandlers: vi.fn(),
  getChatRunSocket: vi.fn(() => ({ emit: vi.fn() })),
}))

vi.mock('@/api/studio/chat', () => ({
  startRunViaSocket: chatApi.startRunViaSocket,
  resumeSession: chatApi.resumeSession,
  registerSessionHandlers: chatApi.registerSessionHandlers,
  unregisterSessionHandlers: chatApi.unregisterSessionHandlers,
  getChatRunSocket: chatApi.getChatRunSocket,
  respondToolApproval: vi.fn(),
  respondClarify: vi.fn(),
  onPeerUserMessage: vi.fn(() => vi.fn()),
  onSessionCommand: vi.fn(() => vi.fn()),
  onSessionTitleUpdated: vi.fn(() => vi.fn()),
  onSessionWorkspaceUpdated: vi.fn(() => vi.fn()),
  onSessionSettingsUpdated: vi.fn(() => vi.fn()),
}))

vi.mock('@/api/client', () => ({
  getActiveProfileName: () => 'default',
  hasApiKey: function hasApiKey() { return false },
}))

vi.mock('@/api/studio/sessions', () => ({
  archiveSession: vi.fn(),
  deleteSession: vi.fn(),
  fetchSession: vi.fn(),
  fetchSessions: vi.fn(async () => []),
  fetchWorkspaceRunChangesForSession: vi.fn(async () => []),
  fetchWorkspaceRunChangeFile: vi.fn(async () => null),
  setSessionModel: vi.fn(async () => true),
  setSessionPushEnabled: vi.fn(async () => true),
  setSessionReasoningEffort: vi.fn(async () => true),
}))

vi.mock('@/api/studio/download', () => ({
  getDownloadUrl: (path: string) => `/download?path=${encodeURIComponent(path)}`,
}))

vi.mock('@/utils/completion-sound', () => ({
  primeCompletionSound: vi.fn(),
  playCompletionSound: vi.fn(),
}))

import { useChatStore, type Message, type Session } from '@/stores/hermes/chat'
import {
  parseResponseAnnotationDisplayEnvelope,
  responseAnnotationSourceHash,
  type ResponseAnnotation,
} from '@/utils/chat-response-annotations'

function session(): Session {
  return {
    id: 'session-1',
    title: 'Annotation session',
    source: 'cli',
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

function annotation(): ResponseAnnotation {
  return {
    id: 'annotation-1',
    ordinal: 1,
    selectedText: 'precise excerpt',
    comment: 'Explain this',
    sourceMessageId: 'assistant-1',
    sourceHash: responseAnnotationSourceHash('A precise excerpt in the answer'),
    start: 2,
    end: 17,
    prefix: 'A ',
    suffix: ' in the answer',
    files: [],
  }
}

describe('chat store response annotation submission', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    setActivePinia(createPinia())
    localStorage.clear()
    chatApi.startRunViaSocket.mockReturnValue({ abort: vi.fn() })
  })

  it('sends an annotation-only turn with separate model/storage and display representations', async () => {
    const store = useChatStore()
    const active = session()
    store.sessions = [active]
    store.activeSessionId = active.id
    store.activeSession = active

    chatApi.startRunViaSocket.mockReturnValueOnce({ abort: vi.fn(), accepted: Promise.resolve(true) })
    await expect(store.sendMessage('', undefined, [annotation()])).resolves.toBe(true)

    const payload = chatApi.startRunViaSocket.mock.calls.at(-1)?.[0]
    expect(payload.input).toContain('<response_annotations>')
    expect(payload.input).toContain('precise excerpt')
    expect(payload.input).toContain('untrusted user-quoted context')
    expect(payload.storage_message).toBe(payload.input)
    const parsedDisplay = parseResponseAnnotationDisplayEnvelope(payload.display_input)
    expect(parsedDisplay).toEqual({ body: '', annotations: [annotation()] })

    expect(active.messages).toHaveLength(1)
    expect(parseResponseAnnotationDisplayEnvelope(active.messages[0].content)).toEqual(parsedDisplay)
    expect(chatApi.startRunViaSocket.mock.calls.at(-1)?.[5]).toEqual(expect.objectContaining({
      trackAcceptance: true,
    }))
  })

  it('retains the draft boundary when the socket rejects before run acceptance', async () => {
    const store = useChatStore()
    const active = session()
    store.sessions = [active]
    store.activeSessionId = active.id
    store.activeSession = active
    chatApi.startRunViaSocket.mockReturnValueOnce({ abort: vi.fn(), accepted: Promise.resolve(false) })

    await expect(store.sendMessage('', undefined, [annotation()])).resolves.toBe(false)
    expect(active.messages.filter((message: Message) => message.role === 'user')).toEqual([])
  })

  it('materializes annotation-owned uploads without persisting download URLs or generic attachment tiles', async () => {
    const store = useChatStore()
    const active = session()
    store.sessions = [active]
    store.activeSessionId = active.id
    store.activeSession = active
    const proof = new File(['proof'], 'proof.txt', { type: 'text/plain' })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ files: [{ name: 'proof.txt', path: '/uploads/proof.txt' }] }),
    }))

    await expect(store.sendMessage('', [{
      id: 'annotation-file-1', name: 'proof.txt', type: 'text/plain', size: proof.size,
      url: 'blob:local-only', file: proof, annotationId: 'annotation-1',
    }], [annotation()])).resolves.toBe(true)

    const payload = chatApi.startRunViaSocket.mock.calls.at(-1)?.[0]
    expect(Array.isArray(payload.display_input)).toBe(true)
    const displayBlocks = payload.display_input as Array<Record<string, any>>
    const parsed = parseResponseAnnotationDisplayEnvelope(displayBlocks.find(block => block.type === 'text')?.text)
    expect(parsed?.annotations[0].files).toEqual([{
      id: 'annotation-file-1', name: 'proof.txt', type: 'text/plain', size: proof.size, path: '/uploads/proof.txt',
    }])
    expect(JSON.stringify(payload.display_input)).not.toContain('blob:local-only')
    expect(JSON.stringify(payload.display_input)).not.toContain('api_key')
    expect(payload.storage_message).toContain('"annotation_id":"annotation-1"')
    expect(active.messages[0].attachments).toBeUndefined()
    vi.unstubAllGlobals()
  })

  it('renders an ordinary attachment only once when sent with an annotation', async () => {
    const store = useChatStore()
    const active = session()
    store.sessions = [active]
    store.activeSessionId = active.id
    store.activeSession = active
    const screenshot = new File(['image'], 'screen.png', { type: 'image/png' })
    const proof = new File(['proof'], 'proof.txt', { type: 'text/plain' })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ files: [
        { name: 'screen.png', path: '/uploads/screen.png' },
        { name: 'proof.txt', path: '/uploads/proof.txt' },
      ] }),
    }))

    await expect(store.sendMessage('', [
      {
        id: 'ordinary-file', name: 'screen.png', type: 'image/png', size: screenshot.size,
        url: 'blob:screen', file: screenshot,
      },
      {
        id: 'annotation-file', name: 'proof.txt', type: 'text/plain', size: proof.size,
        url: 'blob:proof', file: proof, annotationId: 'annotation-1',
      },
    ], [annotation()])).resolves.toBe(true)

    expect(active.messages[0].attachments).toBeUndefined()
    const displayBlocks = JSON.parse(active.messages[0].content) as Array<Record<string, unknown>>
    expect(displayBlocks.filter(block => block.name === 'screen.png')).toHaveLength(1)
    expect(displayBlocks.filter(block => block.name === 'proof.txt')).toHaveLength(1)
    expect(displayBlocks.find(block => block.name === 'screen.png')?.annotation_id).toBeUndefined()
    expect(displayBlocks.find(block => block.name === 'proof.txt')?.annotation_id).toBe('annotation-1')
    vi.unstubAllGlobals()
  })

  it('removes the optimistic user turn when an annotation upload fails before dispatch', async () => {
    const store = useChatStore()
    const active = session()
    store.sessions = [active]
    store.activeSessionId = active.id
    store.activeSession = active
    const proof = new File(['proof'], 'proof.txt', { type: 'text/plain' })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 500, statusText: 'Upload failed',
      text: async () => 'upload rejected',
    }))

    await expect(store.sendMessage('', [{
      id: 'annotation-file-1', name: 'proof.txt', type: 'text/plain', size: proof.size,
      url: 'blob:local-only', file: proof, annotationId: 'annotation-1',
    }], [annotation()])).resolves.toBe(false)

    expect(active.messages.filter((message: Message) => message.role === 'user')).toEqual([])
    expect(active.messages.some((message: Message) => message.role === 'system')).toBe(true)
    vi.unstubAllGlobals()
  })

  it('preserves the existing optimistic turn for a failed ordinary attachment upload', async () => {
    const store = useChatStore()
    const active = session()
    store.sessions = [active]
    store.activeSessionId = active.id
    store.activeSession = active
    const screenshot = new File(['image'], 'selection.png', { type: 'image/png' })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 404, statusText: 'Not found',
      text: async () => 'upload route unavailable',
    }))

    await expect(store.sendMessage('', [{
      id: 'browser-selection-1', name: 'selection.png', type: 'image/png', size: screenshot.size,
      url: 'blob:browser-selection', file: screenshot,
    }])).resolves.toBe(false)

    expect(active.messages.filter((message: Message) => message.role === 'user')).toEqual([
      expect.objectContaining({
        attachments: [expect.objectContaining({ id: 'browser-selection-1' })],
      }),
    ])
    expect(store.isStreaming).toBe(false)
    vi.unstubAllGlobals()
  })

  it('keeps ordinary sends free of annotation transport metadata', async () => {
    const store = useChatStore()
    const active = session()
    store.sessions = [active]
    store.activeSessionId = active.id
    store.activeSession = active

    chatApi.startRunViaSocket.mockReturnValueOnce({
      abort: vi.fn(),
      accepted: new Promise<boolean>(() => {}),
    })
    await expect(store.sendMessage('ordinary message')).resolves.toBe(true)
    const payload = chatApi.startRunViaSocket.mock.calls.at(-1)?.[0]
    expect(payload.input).toBe('ordinary message')
    expect(payload.display_input).toBeUndefined()
    expect(payload.storage_message).toBeUndefined()
    expect(chatApi.startRunViaSocket.mock.calls.at(-1)?.[5]).toEqual(expect.not.objectContaining({
      trackAcceptance: true,
    }))
  })
})
