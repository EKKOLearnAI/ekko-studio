import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getCompressionSnapshotMock = vi.fn()
const saveCompressionSnapshotMock = vi.fn()
const deleteCompressionSnapshotMock = vi.fn()
const bridgeRequestMock = vi.fn()
const bridgeDestroyMock = vi.fn()
const ekkoRuntimeOptionsMock = vi.fn()
const ekkoRuntimeRunMock = vi.fn()
const getGlobalEkkoAgentMock = vi.fn()
const createModelClientMock = vi.fn()
const resolveModelProviderConfigsMock = vi.fn()
const resolveEkkoProviderRuntimeConfigMock = vi.fn()

vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}))

vi.mock('../../packages/server/src/modules/studio/repositories/compression-snapshot', () => ({
  getCompressionSnapshot: getCompressionSnapshotMock,
  saveCompressionSnapshot: saveCompressionSnapshotMock,
  deleteCompressionSnapshot: deleteCompressionSnapshotMock,
}))

vi.mock('../../packages/server/src/modules/hermes/services/bridge/index', () => ({
  AgentBridgeClient: class {
    request = bridgeRequestMock
    destroy = bridgeDestroyMock
  },
}))

vi.mock('../../packages/server/src/modules/ekko/services/provider-runtime', () => ({
  resolveEkkoProviderRuntimeConfig: resolveEkkoProviderRuntimeConfigMock,
}))

vi.mock('../../packages/server/src/modules/ekko/services/manager', () => ({
  getGlobalEkkoAgent: getGlobalEkkoAgentMock,
}))

vi.mock('../../packages/ekko-agent/src', () => ({
  createModelClient: createModelClientMock,
  resolveModelProviderConfigs: resolveModelProviderConfigsMock,
}))

vi.mock('../../packages/server/src/modules/studio/public/chat-agent-runtime', () => ({
  createChatEkkoAuthorizedProviderFetch: vi.fn(() => vi.fn()),
  createPrimaryAgentBridge: vi.fn(() => ({
    request: bridgeRequestMock,
    destroy: bridgeDestroyMock,
  })),
  getChatEkkoAgent: getGlobalEkkoAgentMock,
  createChatEkkoModelClient: createModelClientMock,
  resolveChatEkkoModelProviderConfigs: resolveModelProviderConfigsMock,
  resolveChatEkkoProviderRuntimeConfig: resolveEkkoProviderRuntimeConfigMock,
}))

describe('ChatContextCompressor', () => {
  let originalFetch: typeof global.fetch

  beforeEach(() => {
    originalFetch = global.fetch
    getCompressionSnapshotMock.mockReset()
    saveCompressionSnapshotMock.mockReset()
    deleteCompressionSnapshotMock.mockReset()
    bridgeRequestMock.mockReset()
    bridgeDestroyMock.mockReset()
    ekkoRuntimeOptionsMock.mockReset()
    ekkoRuntimeRunMock.mockReset()
    getGlobalEkkoAgentMock.mockReset()
    createModelClientMock.mockReset()
    resolveModelProviderConfigsMock.mockReset()
    resolveEkkoProviderRuntimeConfigMock.mockReset()
    bridgeRequestMock.mockRejectedValue(new Error('summarizer failed'))
    bridgeDestroyMock.mockResolvedValue(undefined)
    ekkoRuntimeRunMock.mockRejectedValue(new Error('ekko summarizer failed'))
    getGlobalEkkoAgentMock.mockImplementation(() => ({
      runIsolated: (options: unknown, input: unknown) => {
        ekkoRuntimeOptionsMock(options)
        return ekkoRuntimeRunMock(input)
      },
    }))
    resolveEkkoProviderRuntimeConfigMock.mockResolvedValue({
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'profile-key',
      apiMode: 'chat_completions',
    })
    resolveModelProviderConfigsMock.mockReturnValue({
      providerConfig: { id: 'openrouter', defaultModel: 'summary-model' },
    })
    createModelClientMock.mockReturnValue({
      provider: 'openrouter',
      requestStyle: 'openai-chat',
      capabilities: {
        streaming: true,
        tools: true,
        vision: false,
        jsonMode: false,
        systemPrompt: true,
      },
      create: vi.fn(),
      stream: vi.fn(),
    })
  })

  afterEach(() => {
    global.fetch = originalFetch
  })

  it('uses a fresh prompt-isolated, tool-free, skill-free Ekko agent for summarization', async () => {
    const { callSummarizer } = await import('../../packages/server/src/modules/studio/services/context-compressor')
    ekkoRuntimeRunMock.mockResolvedValue({
      output: { role: 'assistant', content: 'ekko summary', finishReason: 'stop' },
    })

    const result = await callSummarizer(
      '',
      undefined,
      'Summarize these turns.',
      [],
      12_000,
      undefined,
      {
        profile: 'work',
        model: 'summary-model',
        provider: 'openrouter',
        sessionId: 'session-1',
      },
    )

    expect(result).toBe('ekko summary')
    expect(ekkoRuntimeOptionsMock).toHaveBeenCalledWith(expect.objectContaining({
      modelClient: expect.objectContaining({
        capabilities: expect.objectContaining({ streaming: true }),
      }),
      toolsEnabled: false,
      skillsEnabled: false,
      runtimeInstructions: [],
      maxSteps: 1,
      maxModelRetries: 0,
      modelDefaults: expect.objectContaining({
        model: 'summary-model',
      }),
    }))
    expect(ekkoRuntimeOptionsMock.mock.calls[0]?.[0]?.modelDefaults).not.toHaveProperty('toolChoice')
    expect(ekkoRuntimeRunMock).toHaveBeenCalledWith(expect.objectContaining({
      memoryEnabled: false,
      messages: [
        { role: 'user', content: 'Summarize these turns.' },
        { role: 'user', content: 'Generate the context checkpoint summary now.' },
      ],
      metadata: {
        purpose: 'context-compression',
        profile: 'work',
        session_id: 'session-1',
      },
      logContext: {
        profile: 'work',
        sessionId: 'session-1',
      },
    }))
    expect(bridgeRequestMock).not.toHaveBeenCalled()
    expect(bridgeDestroyMock).not.toHaveBeenCalled()
  })

  it('falls back to the existing Hermes summarizer when the caller allows it', async () => {
    const { callSummarizer } = await import('../../packages/server/src/modules/studio/services/context-compressor')
    ekkoRuntimeRunMock.mockRejectedValueOnce(new Error('provider unavailable'))
    bridgeRequestMock.mockResolvedValue({
      status: 'completed',
      result: { final_response: 'hermes fallback summary' },
    })

    const result = await callSummarizer(
      '',
      undefined,
      'Summarize these turns.',
      [],
      12_000,
      undefined,
      {
        profile: 'default',
        model: 'summary-model',
        provider: 'openrouter',
        workerKey: 'default:compression:session-1',
      },
    )

    expect(result).toBe('hermes fallback summary')
    expect(ekkoRuntimeRunMock).toHaveBeenCalledTimes(1)
    expect(bridgeRequestMock).toHaveBeenCalledTimes(1)
  })

  it.each([false, true])('reports manual summarizer failure without replacing the snapshot (incremental=%s)', async incremental => {
    const { ChatContextCompressor } = await import('../../packages/server/src/modules/studio/services/context-compressor')
    getCompressionSnapshotMock.mockReturnValue(incremental ? { summary: 'old summary', lastMessageIndex: 0, messageCountAtTime: 1 } : null)
    const compressor = new ChatContextCompressor({ config: { tailMessageCount: 10 } })
    await expect(compressor.compress([
      { role: 'user', content: 'old' }, { role: 'assistant', content: 'answer' }, { role: 'user', content: 'new' },
    ], '', undefined, 'session-1', { profile: 'default', model: 'summary-model', provider: 'openrouter', force: true, allowHermesFallback: false })).rejects.toThrow('ekko summarizer failed')
    expect(saveCompressionSnapshotMock).not.toHaveBeenCalled()
    expect(bridgeRequestMock).not.toHaveBeenCalled()
  })

  it('does not fall back to Hermes when the caller disables it', async () => {
    const { callSummarizer } = await import('../../packages/server/src/modules/studio/services/context-compressor')
    ekkoRuntimeRunMock.mockRejectedValueOnce(new Error('provider unavailable'))

    await expect(callSummarizer(
      '',
      undefined,
      'Summarize these turns.',
      [],
      12_000,
      undefined,
      {
        profile: 'default',
        model: 'summary-model',
        provider: 'openrouter',
        allowHermesFallback: false,
      },
    )).rejects.toThrow('provider unavailable')

    expect(ekkoRuntimeRunMock).toHaveBeenCalledTimes(1)
    expect(bridgeRequestMock).not.toHaveBeenCalled()
    expect(bridgeDestroyMock).not.toHaveBeenCalled()
  })

  it('keeps full history when full summarization fails', async () => {
    const { ChatContextCompressor } = await import('../../packages/server/src/modules/studio/services/context-compressor')
    const compressor = new ChatContextCompressor({ config: { tailMessageCount: 3 } })
    const messages = Array.from({ length: 8 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `message ${i}`,
    }))

    getCompressionSnapshotMock.mockReturnValue(null)

    const result = await compressor.compress(messages, 'http://upstream', undefined, 's1')

    expect(result.messages).toHaveLength(messages.length)
    expect(result.messages.map(m => m.content)).toEqual(messages.map(m => m.content))
    expect(result.meta.compressed).toBe(false)
    expect(result.meta.llmCompressed).toBe(false)
    expect(saveCompressionSnapshotMock).not.toHaveBeenCalled()
  })

  it('keeps all new messages when incremental summarization fails', async () => {
    const { ChatContextCompressor, SUMMARY_PREFIX } = await import('../../packages/server/src/modules/studio/services/context-compressor')
    const compressor = new ChatContextCompressor({ config: { tailMessageCount: 3 } })
    const messages = Array.from({ length: 8 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `message ${i}`,
    }))

    getCompressionSnapshotMock.mockReturnValue({
      summary: 'previous summary',
      lastMessageIndex: 1,
      messageCountAtTime: 2,
    })

    const result = await compressor.compress(messages, 'http://upstream', undefined, 's1')

    expect(result.messages).toHaveLength(7)
    expect(result.messages[0]).toEqual({
      role: 'user',
      content: `${SUMMARY_PREFIX}\n\nprevious summary`,
    })
    expect(result.messages.slice(1).map(m => m.content)).toEqual(messages.slice(2).map(m => m.content))
    expect(result.meta.compressed).toBe(true)
    expect(result.meta.llmCompressed).toBe(false)
    expect(result.meta.compressedStartIndex).toBe(1)
    expect(result.meta.verbatimCount).toBe(6)
    expect(saveCompressionSnapshotMock).not.toHaveBeenCalled()
  })

  it('does not call the summarizer when snapshot has only tail messages after it', async () => {
    const { ChatContextCompressor, SUMMARY_PREFIX } = await import('../../packages/server/src/modules/studio/services/context-compressor')
    const compressor = new ChatContextCompressor({ config: { tailMessageCount: 10 } })
    const messages = Array.from({ length: 6 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `message ${i}`,
    }))
    const fetchMock = vi.fn()

    getCompressionSnapshotMock.mockReturnValue({
      summary: 'previous summary',
      lastMessageIndex: 3,
      messageCountAtTime: 4,
    })
    global.fetch = fetchMock as any

    const result = await compressor.compress(messages, 'http://upstream', undefined, 's1')

    expect(fetchMock).not.toHaveBeenCalled()
    expect(result.messages).toHaveLength(3)
    expect(result.messages[0].content).toBe(`${SUMMARY_PREFIX}\n\nprevious summary`)
    expect(result.messages.slice(1).map(m => m.content)).toEqual(['message 4', 'message 5'])
    expect(result.meta.llmCompressed).toBe(false)
    expect(result.meta.compressedStartIndex).toBe(3)
    expect(saveCompressionSnapshotMock).not.toHaveBeenCalled()
  })

  it('keeps configured first and last messages during full compression', async () => {
    const { ChatContextCompressor, SUMMARY_PREFIX } = await import('../../packages/server/src/modules/studio/services/context-compressor')
    const compressor = new ChatContextCompressor({
      config: { headMessageCount: 2, tailMessageCount: 3, summaryBudget: 1000 },
    })
    const messages = Array.from({ length: 10 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `message ${i}`,
    }))

    getCompressionSnapshotMock.mockReturnValue(null)
    bridgeRequestMock.mockResolvedValue({
      status: 'completed',
      result: { final_response: 'compressed summary' },
    })

    const result = await compressor.compress(messages, 'http://upstream', undefined, 's1')

    expect(result.messages.map(m => m.content)).toEqual([
      'message 0',
      'message 1',
      `${SUMMARY_PREFIX}\n\ncompressed summary`,
      'message 7',
      'message 8',
      'message 9',
    ])
    expect(result.meta.compressed).toBe(true)
    expect(result.meta.llmCompressed).toBe(true)
    expect(result.meta.verbatimCount).toBe(5)
    expect(saveCompressionSnapshotMock).toHaveBeenCalledWith('s1', 'compressed summary', 6, 10)
  })

  it('routes summarization through the provided worker key and destroys only the temporary agent session', async () => {
    const { ChatContextCompressor } = await import('../../packages/server/src/modules/studio/services/context-compressor')
    const compressor = new ChatContextCompressor({
      config: { headMessageCount: 0, tailMessageCount: 1, summaryBudget: 1000 },
    })
    const messages = [
      { role: 'user', content: 'old context' },
      { role: 'assistant', content: 'old response' },
      { role: 'user', content: 'tail' },
    ]
    getCompressionSnapshotMock.mockReturnValue(null)
    bridgeRequestMock.mockResolvedValue({
      status: 'completed',
      result: { final_response: 'compressed summary' },
    })

    await compressor.compress(messages, 'http://upstream', undefined, 's1', {
      profile: 'default',
      workerKey: 'default:compression:s1',
    })

    expect(bridgeRequestMock).toHaveBeenCalledWith(expect.objectContaining({
      action: 'chat',
      profile: 'default',
      worker_key: 'default:compression:s1',
      message: 'Generate the context checkpoint summary now.',
      wait: true,
    }), expect.any(Object))
    const request = bridgeRequestMock.mock.calls[0][0]
    expect(request.conversation_history[0]).toEqual(expect.objectContaining({
      role: 'user',
      content: expect.stringContaining('TURNS TO SUMMARIZE:'),
    }))
    const compressSessionId = bridgeRequestMock.mock.calls[0][0].session_id
    expect(String(compressSessionId)).toMatch(/^compress_/)
    expect(bridgeDestroyMock).toHaveBeenCalledWith(
      compressSessionId,
      'default',
      'default:compression:s1',
    )
  })

  it('does not pre-prune tool results before sending them to the summarizer', async () => {
    const { ChatContextCompressor } = await import('../../packages/server/src/modules/studio/services/context-compressor')
    const compressor = new ChatContextCompressor({
      config: { headMessageCount: 0, tailMessageCount: 1, summaryBudget: 1000 },
    })
    const longToolOutput = `${'x'.repeat(180)}KEEP_MARKER${'y'.repeat(180)}`
    const messages = [
      {
        role: 'assistant',
        content: 'calling terminal',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'terminal', arguments: '{}' } }],
      },
      { role: 'tool', name: 'terminal', tool_call_id: 'call_1', content: longToolOutput },
      { role: 'user', content: 'tail' },
    ]

    getCompressionSnapshotMock.mockReturnValue(null)
    bridgeRequestMock.mockResolvedValue({
      status: 'completed',
      result: { final_response: 'compressed summary' },
    })

    await compressor.compress(messages, 'http://upstream', undefined, 's1')

    const request = bridgeRequestMock.mock.calls[0][0]
    const serializedHistory = JSON.stringify(request.conversation_history)
    expect(serializedHistory).toContain('KEEP_MARKER')
    expect(serializedHistory).not.toContain('[terminal] ')
  })

  it('keeps protected head tool results verbatim after successful full compression', async () => {
    const { ChatContextCompressor, SUMMARY_PREFIX } = await import('../../packages/server/src/modules/studio/services/context-compressor')
    const compressor = new ChatContextCompressor({
      config: { headMessageCount: 2, tailMessageCount: 1, summaryBudget: 1000 },
    })
    const longToolOutput = `${'head-tool-output '.repeat(30)}KEEP_HEAD_TOOL`
    const messages = [
      {
        role: 'assistant',
        content: 'calling terminal',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'terminal', arguments: '{}' } }],
      },
      { role: 'tool', name: 'terminal', tool_call_id: 'call_1', content: longToolOutput },
      { role: 'user', content: 'middle' },
      { role: 'assistant', content: 'tail' },
    ]

    getCompressionSnapshotMock.mockReturnValue(null)
    bridgeRequestMock.mockResolvedValue({
      status: 'completed',
      result: { final_response: 'compressed summary' },
    })

    const result = await compressor.compress(messages, 'http://upstream', undefined, 's1')

    expect(result.messages.map(m => m.content)).toEqual([
      'calling terminal',
      longToolOutput,
      `${SUMMARY_PREFIX}\n\ncompressed summary`,
      'tail',
    ])
  })

  it('uses the previous summary plus a safe tail when an existing snapshot index is stale', async () => {
    const { ChatContextCompressor, SUMMARY_PREFIX } = await import('../../packages/server/src/modules/studio/services/context-compressor')
    const compressor = new ChatContextCompressor({
      config: { headMessageCount: 2, tailMessageCount: 3, summaryBudget: 1000 },
    })
    const messages = Array.from({ length: 8 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `message ${i}`,
    }))

    getCompressionSnapshotMock.mockReturnValue({
      summary: 'stale previous summary',
      lastMessageIndex: 20,
      messageCountAtTime: 21,
    })
    bridgeRequestMock.mockResolvedValue({
      status: 'completed',
      result: { final_response: 'rebuilt summary' },
    })

    const result = await compressor.compress(messages, 'http://upstream', undefined, 's1')

    expect(deleteCompressionSnapshotMock).not.toHaveBeenCalled()
    expect(bridgeRequestMock).not.toHaveBeenCalled()
    expect(result.messages.map(m => m.content)).toEqual([
      'message 0',
      'message 1',
      `${SUMMARY_PREFIX}\n\nstale previous summary`,
      'message 5',
      'message 6',
      'message 7',
    ])
    expect(saveCompressionSnapshotMock).not.toHaveBeenCalled()
  })

  it('folds a stale snapshot safe tail into a new summary when it still exceeds budget', async () => {
    const { ChatContextCompressor, SUMMARY_PREFIX } = await import('../../packages/server/src/modules/studio/services/context-compressor')
    const compressor = new ChatContextCompressor({
      config: { triggerTokens: 800, headMessageCount: 2, tailMessageCount: 3, summaryBudget: 1000 },
    })
    const largeTail = 'tail-token '.repeat(200)
    const messages = [
      { role: 'user', content: 'message 0' },
      { role: 'assistant', content: 'message 1' },
      { role: 'user', content: 'message 2' },
      { role: 'assistant', content: 'message 3' },
      { role: 'user', content: 'message 4' },
      { role: 'assistant', content: largeTail },
      { role: 'user', content: largeTail },
      { role: 'assistant', content: largeTail },
    ]

    getCompressionSnapshotMock.mockReturnValue({
      summary: 'stale previous summary',
      lastMessageIndex: 20,
      messageCountAtTime: 21,
    })
    bridgeRequestMock.mockResolvedValue({
      status: 'completed',
      result: { final_response: 'updated stale summary' },
    })

    const result = await compressor.compress(messages, 'http://upstream', undefined, 's1')

    expect(deleteCompressionSnapshotMock).not.toHaveBeenCalled()
    expect(bridgeRequestMock).toHaveBeenCalledTimes(1)
    expect(result.messages.map(m => m.content)).toEqual([
      'message 0',
      'message 1',
      `${SUMMARY_PREFIX}\n\nupdated stale summary`,
    ])
    expect(saveCompressionSnapshotMock).toHaveBeenCalledWith('s1', 'updated stale summary', 7, 8)
  })

  it('compresses the full history when protected windows cover all messages', async () => {
    const { ChatContextCompressor, SUMMARY_PREFIX } = await import('../../packages/server/src/modules/studio/services/context-compressor')
    const compressor = new ChatContextCompressor({
      config: { headMessageCount: 3, tailMessageCount: 20, summaryBudget: 1000 },
    })
    const messages = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `message ${i}`,
    }))

    getCompressionSnapshotMock.mockReturnValue(null)
    bridgeRequestMock.mockResolvedValue({
      status: 'completed',
      result: { final_response: 'compressed all messages' },
    })

    const result = await compressor.compress(messages, 'http://upstream', undefined, 's1')

    expect(bridgeRequestMock).toHaveBeenCalledTimes(1)
    expect(result.messages.map(m => m.content)).toEqual([
      `${SUMMARY_PREFIX}\n\ncompressed all messages`,
    ])
    expect(result.meta.compressed).toBe(true)
    expect(result.meta.llmCompressed).toBe(true)
    expect(result.meta.verbatimCount).toBe(0)
    expect(result.meta.compressedStartIndex).toBe(19)
    expect(saveCompressionSnapshotMock).toHaveBeenCalledWith('s1', 'compressed all messages', 19, 20)
  })

  it('drops protected messages when compressed output still exceeds the trigger budget', async () => {
    const { ChatContextCompressor, SUMMARY_PREFIX } = await import('../../packages/server/src/modules/studio/services/context-compressor')
    const compressor = new ChatContextCompressor({
      config: { triggerTokens: 200, headMessageCount: 2, tailMessageCount: 2, summaryBudget: 100 },
    })
    const largeText = 'tail-token '.repeat(500)
    const messages = [
      { role: 'user', content: 'head 0' },
      { role: 'assistant', content: 'head 1' },
      { role: 'user', content: 'middle 2' },
      { role: 'assistant', content: 'middle 3' },
      { role: 'user', content: largeText },
      { role: 'assistant', content: largeText },
    ]

    getCompressionSnapshotMock.mockReturnValue(null)
    bridgeRequestMock.mockResolvedValue({
      status: 'completed',
      result: { final_response: 'short summary' },
    })

    const result = await compressor.compress(messages, 'http://upstream', undefined, 's1')

    expect(result.messages.map(m => m.content)).toEqual([
      `${SUMMARY_PREFIX}\n\nshort summary`,
    ])
    expect(result.meta.compressed).toBe(true)
    expect(result.meta.llmCompressed).toBe(true)
    expect(result.meta.verbatimCount).toBe(0)
  })

  it('truncates the summary when the summary alone exceeds the trigger budget', async () => {
    const { ChatContextCompressor, SUMMARY_PREFIX, countTokens } = await import('../../packages/server/src/modules/studio/services/context-compressor')
    const compressor = new ChatContextCompressor({
      config: { triggerTokens: 120, headMessageCount: 2, tailMessageCount: 2, summaryBudget: 100 },
    })
    const messages = Array.from({ length: 6 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `message ${i}`,
    }))
    const longSummary = 'summary-token '.repeat(500)

    getCompressionSnapshotMock.mockReturnValue(null)
    bridgeRequestMock.mockResolvedValue({
      status: 'completed',
      result: { final_response: longSummary },
    })

    const result = await compressor.compress(messages, 'http://upstream', undefined, 's1')

    expect(result.messages).toHaveLength(1)
    expect(String(result.messages[0].content)).toContain('[Summary truncated to fit context budget]')
    expect(String(result.messages[0].content).startsWith(SUMMARY_PREFIX)).toBe(true)
    expect(countTokens(String(result.messages[0].content))).toBeLessThanOrEqual(140)
    expect(result.meta.verbatimCount).toBe(0)
  })

  it('keeps configured first messages when incremental compression reuses an existing snapshot', async () => {
    const { ChatContextCompressor, SUMMARY_PREFIX } = await import('../../packages/server/src/modules/studio/services/context-compressor')
    const compressor = new ChatContextCompressor({
      config: { headMessageCount: 2, tailMessageCount: 10 },
    })
    const messages = Array.from({ length: 6 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `message ${i}`,
    }))

    getCompressionSnapshotMock.mockReturnValue({
      summary: 'previous summary',
      lastMessageIndex: 3,
      messageCountAtTime: 4,
    })

    const result = await compressor.compress(messages, 'http://upstream', undefined, 's1')

    expect(bridgeRequestMock).not.toHaveBeenCalled()
    expect(result.messages.map(m => m.content)).toEqual([
      'message 0',
      'message 1',
      `${SUMMARY_PREFIX}\n\nprevious summary`,
      'message 4',
      'message 5',
    ])
    expect(result.meta.verbatimCount).toBe(4)
    expect(saveCompressionSnapshotMock).not.toHaveBeenCalled()
  })

  it('folds all new messages into the summary when incremental tail protection would exceed budget', async () => {
    const { ChatContextCompressor, SUMMARY_PREFIX } = await import('../../packages/server/src/modules/studio/services/context-compressor')
    const compressor = new ChatContextCompressor({
      config: { triggerTokens: 1000, headMessageCount: 3, tailMessageCount: 20, summaryBudget: 100 },
    })
    const largeText = 'new-token '.repeat(80)
    const messages = [
      { role: 'user', content: 'head 0' },
      { role: 'assistant', content: 'head 1' },
      { role: 'user', content: 'head 2' },
      ...Array.from({ length: 20 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `${largeText}${i}`,
      })),
    ]

    getCompressionSnapshotMock.mockReturnValue({
      summary: 'previous summary',
      lastMessageIndex: 2,
      messageCountAtTime: 3,
    })
    bridgeRequestMock.mockResolvedValue({
      status: 'completed',
      result: { final_response: 'updated summary' },
    })

    const result = await compressor.compress(messages, 'http://upstream', undefined, 's1')

    expect(bridgeRequestMock).toHaveBeenCalledTimes(1)
    const request = bridgeRequestMock.mock.calls[0][0]
    expect(request.message).toBe('Generate the context checkpoint summary now.')
    expect(request.conversation_history.slice(0, 3)).toEqual([
      { role: 'user', content: '[Previous summary]\nprevious summary' },
      { role: 'assistant', content: 'Understood, I will update the summary.' },
      expect.objectContaining({
        role: 'user',
        content: expect.stringContaining('NEW TURNS TO INCORPORATE:'),
      }),
    ])
    expect(result.messages.map(m => m.content)).toEqual([
      'head 0',
      'head 1',
      'head 2',
      `${SUMMARY_PREFIX}\n\nupdated summary`,
    ])
    expect(result.meta.compressed).toBe(true)
    expect(result.meta.llmCompressed).toBe(true)
    expect(result.meta.verbatimCount).toBe(3)
    expect(result.meta.compressedStartIndex).toBe(22)
    expect(saveCompressionSnapshotMock).toHaveBeenCalledWith('s1', 'updated summary', 22, 23)
  })

  it('stores message cursors on the first successful compression', async () => {
    const { ChatContextCompressor } = await import('../../packages/server/src/modules/studio/services/context-compressor')
    const compressor = new ChatContextCompressor({
      config: { headMessageCount: 2, tailMessageCount: 2, summaryBudget: 1000 },
    })
    const messages = Array.from({ length: 8 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `message ${index}`,
      cursorId: 101 + index,
    }))
    getCompressionSnapshotMock.mockReturnValue(null)
    bridgeRequestMock.mockResolvedValue({
      status: 'completed',
      result: { final_response: 'cursor summary' },
    })

    const result = await compressor.compress(messages, '', undefined, 's1', {
      profile: 'default',
      historyRevision: 3,
    })

    expect(result.meta).toEqual(expect.objectContaining({
      compressedThroughCursor: 106,
      protectedHeadThroughCursor: 102,
    }))
    expect(saveCompressionSnapshotMock).toHaveBeenCalledWith(
      's1',
      'cursor summary',
      5,
      8,
      {
        compressedThroughMessageId: 106,
        protectedHeadThroughMessageId: 102,
        expectedHistoryRevision: 3,
      },
    )
  })

  it('does not advance a cursor when only the protected tail follows it', async () => {
    const { ChatContextCompressor, SUMMARY_PREFIX } = await import('../../packages/server/src/modules/studio/services/context-compressor')
    const compressor = new ChatContextCompressor({ config: { tailMessageCount: 10 } })
    getCompressionSnapshotMock.mockReturnValue({
      summary: 'previous summary',
      lastMessageIndex: 4,
      messageCountAtTime: 5,
      compressedThroughMessageId: 105,
      protectedHeadThroughMessageId: 101,
      historyRevision: 2,
    })
    const messages = [
      { role: 'user', content: 'head', cursorId: 101 },
      { role: 'user', content: `${SUMMARY_PREFIX}\n\nprevious summary` },
      { role: 'assistant', content: 'new answer', cursorId: 106 },
      { role: 'user', content: 'new question', cursorId: 107 },
    ]

    const result = await compressor.compress(messages, '', undefined, 's1')

    expect(result.meta).toEqual(expect.objectContaining({
      compressedThroughCursor: 105,
      protectedHeadThroughCursor: 101,
      llmCompressed: false,
    }))
    expect(saveCompressionSnapshotMock).not.toHaveBeenCalled()
    expect(bridgeRequestMock).not.toHaveBeenCalled()
  })

  it('moves a cursor tail boundary backward instead of orphaning tool results', async () => {
    const { ChatContextCompressor } = await import('../../packages/server/src/modules/studio/services/context-compressor')
    const compressor = new ChatContextCompressor({ config: { tailMessageCount: 3 } })
    getCompressionSnapshotMock.mockReturnValue({
      summary: 'previous summary',
      lastMessageIndex: 3,
      messageCountAtTime: 4,
      compressedThroughMessageId: 104,
      protectedHeadThroughMessageId: null,
      historyRevision: 0,
    })
    const messages = [
      {
        role: 'assistant',
        content: 'calling tool',
        cursorId: 105,
        tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read', arguments: '{}' } }],
      },
      { role: 'tool', content: 'tool result', cursorId: 106, tool_call_id: 'call-1' },
      { role: 'user', content: 'follow up', cursorId: 107 },
      { role: 'assistant', content: 'answer', cursorId: 108 },
    ]

    const result = await compressor.compress(messages, '', undefined, 's1')

    expect(result.messages.map(message => message.content)).toEqual([
      expect.stringContaining('previous summary'),
      'calling tool',
      'tool result',
      'follow up',
      'answer',
    ])
    expect(saveCompressionSnapshotMock).not.toHaveBeenCalled()
    expect(bridgeRequestMock).not.toHaveBeenCalled()
  })

  it('upgrades a legacy snapshot to a cursor only during a successful compression cycle', async () => {
    const { ChatContextCompressor } = await import('../../packages/server/src/modules/studio/services/context-compressor')
    const compressor = new ChatContextCompressor({
      config: { triggerTokens: 100, headMessageCount: 1, tailMessageCount: 1, summaryBudget: 100 },
    })
    const messages = Array.from({ length: 7 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `large ${index} ${'token '.repeat(80)}`,
      cursorId: 201 + index,
    }))
    getCompressionSnapshotMock.mockReturnValue({
      summary: 'legacy summary',
      lastMessageIndex: 1,
      messageCountAtTime: 2,
      compressedThroughMessageId: null,
      protectedHeadThroughMessageId: null,
      historyRevision: 0,
    })
    bridgeRequestMock.mockResolvedValue({
      status: 'completed',
      result: { final_response: 'upgraded summary' },
    })

    await compressor.compress(messages, '', undefined, 's1', {
      profile: 'default',
      historyRevision: 4,
    })

    expect(saveCompressionSnapshotMock).toHaveBeenCalledWith(
      's1',
      'upgraded summary',
      5,
      7,
      {
        compressedThroughMessageId: 206,
        protectedHeadThroughMessageId: 201,
        expectedHistoryRevision: 4,
      },
    )
  })

  it('reuses a cursor summary for export without applying the legacy index to bounded input', async () => {
    const { ExportCompressor } = await import('../../packages/server/src/modules/studio/services/context-compressor/export-compressor')
    const compressor = new ExportCompressor()
    getCompressionSnapshotMock.mockReturnValue({
      summary: 'existing cursor summary',
      lastMessageIndex: 999,
      messageCountAtTime: 1_000,
      compressedThroughMessageId: 500,
      protectedHeadThroughMessageId: 1,
      historyRevision: 0,
    })
    bridgeRequestMock.mockResolvedValue({
      status: 'completed',
      result: { final_response: 'export summary' },
    })

    const result = await compressor.compress([
      { role: 'user', content: 'protected head' },
      { role: 'assistant', content: 'post cursor answer' },
    ], '', undefined, 's1')

    expect(result.messages).toEqual([{ role: 'user', content: 'export summary' }])
    const serializedRequest = JSON.stringify(bridgeRequestMock.mock.calls[0]?.[0])
    expect(serializedRequest).toContain('protected head')
    expect(serializedRequest).toContain('post cursor answer')
    expect(serializedRequest).toContain('existing cursor summary')
  })
})

describe('countTokens', () => {
  it('returns a positive estimate for normal text via the exact tokenizer', async () => {
    const { countTokens } = await import('../../packages/server/src/modules/studio/services/context-compressor')
    expect(countTokens('The quick brown fox jumps over the lazy dog.')).toBeGreaterThan(0)
  })

  it('does not hang on a long contiguous CJK run (quadratic BPE guard)', async () => {
    const { countTokens } = await import('../../packages/server/src/modules/studio/services/context-compressor')
    // A long run of CJK characters with no spaces forms a single huge
    // pre-tokenizer "piece". js-tiktoken's BPE merge loop is O(n^2) over the
    // bytes of that piece, which pins the event loop for seconds/minutes and
    // never throws — so the guard must short-circuit to the heuristic instead
    // of calling encode(). 30k chars would be ~90k bytes => ~8.1B ops unguarded.
    const poison = '一'.repeat(30000)
    const start = performance.now()
    const tokens = countTokens(poison)
    const elapsedMs = performance.now() - start
    expect(tokens).toBeGreaterThan(0)
    expect(elapsedMs).toBeLessThan(250)
  })

  it('bounds token estimation time for very large non-pathological text', async () => {
    const { countTokens } = await import('../../packages/server/src/modules/studio/services/context-compressor')
    const unit = 'abcdefghijklmnopqrstuvwxyz0123456789 '
    const text = unit.repeat(Math.ceil(1_000_000 / unit.length)).slice(0, 1_000_000)
    const start = performance.now()
    const tokens = countTokens(text)
    const elapsedMs = performance.now() - start
    expect(tokens).toBeGreaterThan(0)
    expect(elapsedMs).toBeLessThan(250)
  })

  it('bounds token estimation time for large separated multibyte text', async () => {
    const { countTokens } = await import('../../packages/server/src/modules/studio/services/context-compressor')
    const text = '汉 '.repeat(100_000)
    const start = performance.now()
    const tokens = countTokens(text)
    const elapsedMs = performance.now() - start
    expect(tokens).toBeGreaterThan(0)
    expect(elapsedMs).toBeLessThan(250)
  })

  it('uses the exact tokenizer through the 256 KiB UTF-8 boundary and falls back above it', async () => {
    const { countTokens, countTokensForModel } = await import('../../packages/server/src/modules/studio/services/context-compressor')
    const { getEncoding } = await import('js-tiktoken')
    const encoder = getEncoding('cl100k_base')
    const atBoundary = 'a '.repeat(131_072)
    const aboveBoundary = `${atBoundary}a`

    expect(Buffer.byteLength(atBoundary, 'utf8')).toBe(262_144)
    expect(countTokens(atBoundary)).toBe(encoder.encode(atBoundary).length)
    expect(countTokensForModel(atBoundary, 'gpt-4o')).toBeGreaterThan(0)
    expect(countTokens(aboveBoundary)).toBe(Buffer.byteLength(aboveBoundary, 'utf8'))
    expect(countTokensForModel(aboveBoundary, 'gpt-4o')).toBe(Buffer.byteLength(aboveBoundary, 'utf8'))
  })

  it('applies the 256 KiB cap by UTF-8 bytes for separated multibyte text', async () => {
    const { countTokens, countTokensForModel } = await import('../../packages/server/src/modules/studio/services/context-compressor')
    const { getEncoding } = await import('js-tiktoken')
    const encoder = getEncoding('cl100k_base')
    const atBoundary = '汉 '.repeat(65_536)
    const aboveBoundary = `${atBoundary}a`
    const heuristic = (text: string) => Buffer.byteLength(text, 'utf8')

    expect(atBoundary.length).toBe(131_072)
    expect(Buffer.byteLength(atBoundary, 'utf8')).toBe(262_144)
    expect(countTokens(atBoundary)).toBe(encoder.encode(atBoundary).length)
    expect(countTokens(aboveBoundary)).toBe(heuristic(aboveBoundary))
    expect(countTokensForModel(aboveBoundary, 'gpt-4o')).toBe(heuristic(aboveBoundary))
  })

  it('does not materialize a full regex match array for oversized heuristic input', async () => {
    const { countTokens, countTokensForModel } = await import('../../packages/server/src/modules/studio/services/context-compressor')
    const oversized = '汉字 mixed text '.repeat(100_000)
    const originalMatch = String.prototype.match
    const matchSpy = vi.spyOn(String.prototype, 'match').mockImplementation(function (this: string, regexp: any) {
      if (this.length > 262_144) {
        throw new Error('oversized input must not use String.match')
      }
      return originalMatch.call(String(this), regexp)
    } as typeof String.prototype.match)

    expect(() => countTokens(oversized)).not.toThrow()
    expect(() => countTokensForModel(oversized, 'gpt-4o')).not.toThrow()
    expect(matchSpy).not.toHaveBeenCalled()
  })

  it('samples oversized heterogeneous text across its full length', async () => {
    const { countTokens } = await import('../../packages/server/src/modules/studio/services/context-compressor')
    const ascii = 'a'.repeat(400_000)
    const cjk = '汉'.repeat(400_000)
    const tokens = countTokens(ascii + cjk)

    expect(tokens).toBe(Buffer.byteLength(ascii + cjk, 'utf8'))
  })

  it('does not let a periodic adversarial layout hide CJK from oversized estimation', async () => {
    const { countTokens } = await import('../../packages/server/src/modules/studio/services/context-compressor')
    const length = 800_000
    const adversarial = new Array<string>(length).fill('汉')
    const blockCount = 256
    const blockLength = Math.floor((64 * 1024) / blockCount)
    for (let block = 0; block < blockCount; block += 1) {
      const start = Math.floor(block * length / blockCount)
      for (let offset = 0; offset < blockLength; offset += 1) adversarial[start + offset] = 'a'
    }
    const text = adversarial.join('')
    const ascii = 64 * 1024
    const expected = Buffer.byteLength(text, 'utf8')

    expect(countTokens(text)).toBe(expected)
  })

  it('keeps oversized token estimation work bounded independently of input length', async () => {
    const { countTokens } = await import('../../packages/server/src/modules/studio/services/context-compressor')
    const small = 'a'.repeat(8 * 1024 * 1024)
    const large = 'a'.repeat(128 * 1024 * 1024)
    const smallStart = performance.now()
    countTokens(small)
    const smallMs = performance.now() - smallStart
    const largeStart = performance.now()
    countTokens(large)
    const largeMs = performance.now() - largeStart

    expect(largeMs).toBeLessThan(Math.max(100, smallMs * 4))
  })

  it('still uses the exact tokenizer for long space-separated text', async () => {
    const { countTokens } = await import('../../packages/server/src/modules/studio/services/context-compressor')
    // Long but with frequent spaces => no single piece exceeds the guard
    // threshold, so the exact tiktoken path runs and stays fast.
    const longText = 'word '.repeat(10000)
    const start = performance.now()
    const tokens = countTokens(longText)
    const elapsedMs = performance.now() - start
    expect(tokens).toBeGreaterThan(0)
    expect(elapsedMs).toBeLessThan(1000)
  })
})
