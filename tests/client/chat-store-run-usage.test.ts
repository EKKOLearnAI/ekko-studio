import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('@/api/hermes/chat', () => ({
  startRunViaSocket: vi.fn(),
  resumeSession: vi.fn(),
  registerSessionHandlers: vi.fn(),
  unregisterSessionHandlers: vi.fn(),
  getChatRunSocket: vi.fn(() => null),
  respondToolApproval: vi.fn(),
  onPeerUserMessage: vi.fn(() => () => {}),
  onSessionCommand: vi.fn(() => () => {}),
  onSessionTitleUpdated: vi.fn(() => () => {}),
  onSessionWorkspaceUpdated: vi.fn(() => () => {}),
  respondClarify: vi.fn(),
}))

vi.mock('@/api/hermes/sessions', () => ({
  archiveSession: vi.fn(),
  deleteSession: vi.fn(),
  fetchSessionMessagesPage: vi.fn(),
  fetchSessions: vi.fn(async () => ([
    {
      id: 'session-1',
      source: 'cli',
      model: 'test',
      title: 'S1',
      started_at: 1,
      ended_at: null,
      message_count: 2,
      tool_call_count: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: null,
      estimated_cost_usd: 0,
      actual_cost_usd: null,
      cost_status: '',
    },
  ])),
  fetchWorkspaceRunChangeFile: vi.fn(),
  fetchWorkspaceRunChangesForSession: vi.fn(async () => []),
  setSessionModel: vi.fn(),
}))

vi.mock('@/api/client', () => ({
  getActiveProfileName: () => 'default',
}))

vi.mock('@/api/hermes/download', () => ({
  getDownloadUrl: (path: string) => path,
}))

vi.mock('@/utils/completion-sound', () => ({
  primeCompletionSound: vi.fn(),
  playCompletionSound: vi.fn(),
}))

vi.mock('@/utils/completion-notification', () => ({
  showCompletionNotification: vi.fn(),
}))

import { useChatStore } from '@/stores/hermes/chat'

describe('chat store run usage binding', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('does not let session list 0/0 overwrite runtime session usage', async () => {
    const store = useChatStore()
    store.sessions = [{
      id: 'session-1',
      title: 'S1',
      messages: [],
      createdAt: 1,
      updatedAt: 1,
      inputTokens: 17247,
      outputTokens: 1014,
    }] as any
    store.activeSessionId = 'session-1'
    store.activeSession = store.sessions[0]

    await store.refreshSessionListOnly()

    expect(store.sessions[0].inputTokens).toBe(17247)
    expect(store.sessions[0].outputTokens).toBe(1014)
  })
})
