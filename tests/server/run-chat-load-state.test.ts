import { beforeEach, describe, expect, it, vi } from 'vitest'

const getSessionMock = vi.fn()
const getSessionDetailPaginatedMock = vi.fn()
const getCompressionSnapshotMock = vi.fn()
const estimateUsageTokensFromMessagesMock = vi.fn()
const buildDbHistoryMock = vi.fn()
const buildSnapshotAwareHistoryMock = vi.fn()
const getRecordedUsageTotalsMock = vi.fn()
const getUsageMock = vi.fn()

vi.mock('../../packages/server/src/modules/studio/repositories/session-store', () => ({
  getSession: getSessionMock,
  createSession: vi.fn(),
  addMessage: vi.fn(),
  updateSessionStats: vi.fn(),
  getSessionDetailPaginated: getSessionDetailPaginatedMock,
}))

vi.mock('../../packages/server/src/modules/studio/repositories/usage-store', () => ({
  updateUsage: vi.fn(),
  getRecordedUsageTotals: getRecordedUsageTotalsMock,
  getUsage: getUsageMock,
}))

vi.mock('../../packages/server/src/modules/studio/repositories/compression-snapshot', () => ({
  getCompressionSnapshot: getCompressionSnapshotMock,
}))

vi.mock('../../packages/server/src/modules/studio/services/context-compressor', () => ({
  SUMMARY_PREFIX: '[Previous context summary]',
  countTokens: vi.fn(() => 0),
}))

vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/compression', () => ({
  buildCompressedHistory: vi.fn(),
  buildDbHistory: buildDbHistoryMock,
  buildSnapshotAwareHistory: buildSnapshotAwareHistoryMock,
  getOrCreateSession: vi.fn(),
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/usage', () => ({
  calcAndUpdateUsage: vi.fn(),
  estimateUsageTokensFromMessages: estimateUsageTokensFromMessagesMock,
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/message-format', () => ({
  handleMessage: vi.fn((messages: any[]) => messages),
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/content-blocks', () => ({
  contentBlocksToString: vi.fn((value: any) => String(value || '')),
  extractTextForPreview: vi.fn((value: any) => String(value || '')),
  isContentBlockArray: vi.fn(() => false),
  convertContentBlocks: vi.fn(),
}))

vi.mock('../../packages/server/src/modules/studio/public/runs/prompt', () => ({
  getSystemPrompt: vi.fn(() => 'system prompt'),
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/sse-utils', () => ({
  readSseFrames: vi.fn(),
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/response-utils', () => ({
  extractResponseText: vi.fn(),
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/response-stream', () => ({
  applyResponseStreamEvent: vi.fn(),
  flushResponseRunToDb: vi.fn(),
}))

describe('loadSessionStateFromDb', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getSessionMock.mockReturnValue({
      id: 'session-1',
      profile: 'default',
      model: 'gpt-test',
      provider: 'openai',
      source: 'cli',
      context_tokens: 6_543,
    })
    getSessionDetailPaginatedMock.mockReturnValue({
      messages: [
        { role: 'user', content: 'old large context' },
        { role: 'assistant', content: 'old large answer' },
        { role: 'user', content: 'new tail' },
      ],
    })
    getCompressionSnapshotMock.mockReturnValue({
      summary: 'small summary',
      lastMessageIndex: 0,
      messageCountAtTime: 1,
    })
    buildDbHistoryMock.mockResolvedValue([
      { role: 'user', content: 'old large context' },
      { role: 'assistant', content: 'old large answer' },
      { role: 'user', content: 'new tail' },
    ])
    buildSnapshotAwareHistoryMock.mockResolvedValue([
      { role: 'user', content: '[Previous context summary]\n\nsmall summary' },
      { role: 'user', content: 'new tail' },
    ])
    estimateUsageTokensFromMessagesMock.mockImplementation((messages: any[]) => {
      if (messages?.[0]?.content?.includes('small summary')) {
        return { inputTokens: 9_000, outputTokens: 0 }
      }
      return { inputTokens: 28_000, outputTokens: 0 }
    })
    getRecordedUsageTotalsMock.mockReturnValue({
      inputTokens: 28_000,
      outputTokens: 2_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      apiCalls: 1,
    })
    getUsageMock.mockReturnValue({ input_tokens: 8_000, output_tokens: 1_000 })
  })

  it('hydrates persisted usage without reconstructing complete history on resume', async () => {
    const { loadSessionStateFromDb } = await import('../../packages/server/src/modules/studio/services/chat-run/load-state')

    const state = await loadSessionStateFromDb('session-1', new Map())

    expect(buildDbHistoryMock).not.toHaveBeenCalled()
    expect(buildSnapshotAwareHistoryMock).not.toHaveBeenCalled()
    expect(state.inputTokens).toBe(28_000)
    expect(state.outputTokens).toBe(2_000)
    expect(state.contextTokens).toBe(6_543)
  })

  it('restores the persisted tool-result anchor for a Hermes background delegation', async () => {
    getSessionDetailPaginatedMock.mockReturnValue({
      messages: [{
        id: 42,
        role: 'tool',
        content: JSON.stringify({
          mode: 'background',
          delegation_id: 'delegation-1',
          goals: ['Inspect the task'],
        }),
        display_content: null,
        tool_call_id: 'delegate-call-1',
        tool_name: 'delegate_task',
        timestamp: 100,
      }],
    })
    const { loadSessionStateFromDb } = await import('../../packages/server/src/modules/studio/services/chat-run/load-state')

    const state = await loadSessionStateFromDb('session-1', new Map())

    expect(state.backgroundDelegations).toEqual({
      'delegation-1': expect.objectContaining({
        delegationId: 'delegation-1',
        status: 'running',
        messageId: 42,
        toolCallId: 'delegate-call-1',
        dispatchPayload: expect.objectContaining({ mode: 'background' }),
      }),
    })
  })
})
