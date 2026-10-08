import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveCatalogModel } from '../../packages/server/src/modules/studio/services/models/model-metadata'

const getSessionDetailMock = vi.fn()
const getSessionMock = vi.fn()
const getSessionContextMessagesMock = vi.fn()
const getSessionContextMessageMock = vi.fn()
const getCompressionSnapshotMock = vi.fn()
const getUsageMock = vi.fn()
const getModelContextLengthMock = vi.fn()
const calcAndUpdateUsageMock = vi.fn()
const estimateUsageTokensFromMessagesMock = vi.fn()
const updateMessageContextTokenUsageMock = vi.fn((sid: string, state: any, emit: any, messageTokens: number, usage?: { inputTokens: number; outputTokens: number }) => {
  state.contextTokens = messageTokens
  emit('usage.updated', {
    event: 'usage.updated',
    session_id: sid,
    inputTokens: usage?.inputTokens ?? state.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? state.outputTokens ?? 0,
    contextTokens: messageTokens,
  })
  return messageTokens
})
const compressorCompressMock = vi.fn()
const readConfigYamlForProfileMock = vi.fn()
const compressorConstructorMock = vi.fn()

vi.mock('../../packages/server/src/modules/studio/repositories/session-store', () => ({
  getSessionDetail: getSessionDetailMock,
  getSession: getSessionMock,
  getSessionContextMessages: getSessionContextMessagesMock,
  getSessionContextMessage: getSessionContextMessageMock,
}))

vi.mock('../../packages/server/src/modules/studio/repositories/compression-snapshot', () => ({
  getCompressionSnapshot: getCompressionSnapshotMock,
}))

vi.mock('../../packages/server/src/modules/studio/repositories/usage-store', () => ({
  getUsage: getUsageMock,
}))

vi.mock('../../packages/server/src/modules/studio/services/context-compressor', () => ({
  SUMMARY_PREFIX: '[Previous context summary]',
  ChatContextCompressor: class {
    constructor(opts?: any) {
      compressorConstructorMock(opts)
    }
    compress = compressorCompressMock
  },
}))

vi.mock('../../packages/server/src/modules/studio/public/provider-runtime', () => ({
  getModelContextLength: getModelContextLengthMock,
}))

vi.mock('../../packages/server/src/modules/studio/public/profile-config', () => ({
  readConfigYamlForProfile: readConfigYamlForProfileMock,
}))

vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  bridgeLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/usage', () => ({
  calcAndUpdateUsage: calcAndUpdateUsageMock,
  estimateUsageTokensFromMessages: estimateUsageTokensFromMessagesMock,
  updateMessageContextTokenUsage: updateMessageContextTokenUsageMock,
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/message-format', () => ({
  isAssistantMessageSendable: vi.fn(() => true),
}))

describe('run chat compression trigger', () => {
  beforeEach(() => {
    getSessionDetailMock.mockReset()
    getSessionMock.mockReset()
    getSessionContextMessagesMock.mockReset()
    getSessionContextMessageMock.mockReset()
    getCompressionSnapshotMock.mockReset()
    getUsageMock.mockReset()
    getModelContextLengthMock.mockReset()
    calcAndUpdateUsageMock.mockReset()
    estimateUsageTokensFromMessagesMock.mockReset()
    updateMessageContextTokenUsageMock.mockClear()
    compressorCompressMock.mockReset()
    compressorConstructorMock.mockReset()
    readConfigYamlForProfileMock.mockReset()

    getSessionMock.mockReturnValue({ id: 'session-1', profile: 'default', history_revision: 0 })
    getSessionContextMessagesMock.mockImplementation((_sessionId: string, options: { afterId?: number; throughId?: number } = {}) => {
      const rows = getSessionDetailMock()?.messages || []
      return rows.filter((row: any) => (
        ['user', 'assistant', 'tool'].includes(row.role) &&
        (options.afterId == null || Number(row.id) > options.afterId) &&
        (options.throughId == null || Number(row.id) <= options.throughId)
      ))
    })
    getSessionContextMessageMock.mockImplementation((sessionId: string, messageId: number) => (
      getSessionContextMessagesMock(sessionId).find((row: any) => Number(row.id) === messageId) || null
    ))
    getModelContextLengthMock.mockReturnValue(256_000)
    calcAndUpdateUsageMock.mockResolvedValue({ inputTokens: 1_000, outputTokens: 0 })
    estimateUsageTokensFromMessagesMock.mockReturnValue({ inputTokens: 0, outputTokens: 0 })
    getCompressionSnapshotMock.mockReturnValue(null)
    readConfigYamlForProfileMock.mockResolvedValue({})
  })

  it('manual Ekko compression includes the latest turn and preserves configured token budgets', async () => {
    getSessionDetailMock.mockReturnValue({ messages: [
      { id: 1, role: 'user', content: 'latest question' },
      { id: 2, role: 'assistant', content: 'latest answer' },
    ] })
    compressorCompressMock.mockResolvedValue({ messages: [{ role: 'user', content: 'summary' }], meta: {
      totalMessages: 2, compressed: true, llmCompressed: true, summaryTokenEstimate: 1, verbatimCount: 0, compressedStartIndex: 1,
    } })
    const { forceCompressBridgeHistory } = await import('../../packages/server/src/modules/studio/services/chat-run/compression')
    await forceCompressBridgeHistory('session-1', 'default', [], undefined, {
      model: 'ekko-model', provider: 'openai', apiMode: 'responses', force: true, excludeLastUser: false, allowHermesFallback: false,
    })
    expect(compressorCompressMock).toHaveBeenCalledWith([
      expect.objectContaining({ role: 'user', content: 'latest question' }),
      expect.objectContaining({ role: 'assistant', content: 'latest answer' }),
    ], '', undefined, 'session-1', expect.objectContaining({ model: 'ekko-model', provider: 'openai', apiMode: 'responses', force: true, allowHermesFallback: false }))
    expect(compressorConstructorMock.mock.calls[0][0].config.triggerTokens).toBeGreaterThan(0)
  })

  const endpointCatalog = {
    maker: { api: 'https://maker.test/v1', models: { shared: { canonical_model_id: 'maker/shared', limit: { context: 100_000 } } } },
    relay: { api: 'https://relay.test/v1', models: { shared: { canonical_model_id: 'maker/shared', limit: { context: 500_000 } } } },
  }
  function useEndpointCatalog() {
    getModelContextLengthMock.mockImplementation(input => resolveCatalogModel(endpointCatalog, input)?.model.limit?.context || 256_000)
  }

  it.each([
    ['unknown', 'https://relay.test/v1', false],
    ['maker', 'https://relay.test/v1', true],
    ['unknown', '', true],
  ])('uses the resolved window for automatic compression while retaining provider and URL-less fallbacks (%s, %s)', async (provider, upstream, shouldCompress) => {
    useEndpointCatalog()
    getSessionDetailMock.mockReturnValue({ messages: Array.from({ length: 10 }, (_, index) => ({
      id: index + 1, role: index % 2 === 0 ? 'user' : 'assistant', content: `message ${index}`,
    })) })
    calcAndUpdateUsageMock.mockResolvedValue({ inputTokens: 70_000, outputTokens: 0 })
    compressorCompressMock.mockResolvedValue({ messages: [{ role: 'user', content: 'summary' }], meta: {
      totalMessages: 10, compressed: true, llmCompressed: true, summaryTokenEstimate: 1, verbatimCount: 0, compressedStartIndex: 0,
    } })
    const { buildCompressedHistory } = await import('../../packages/server/src/modules/studio/services/chat-run/compression')
    const history = await buildCompressedHistory('session-1', 'default', upstream, undefined, vi.fn(), new Map(), { provider, model: 'shared' })
    expect(compressorCompressMock.mock.calls.length > 0).toBe(shouldCompress)
    expect(history).toHaveLength(shouldCompress ? 1 : 8)
  })

  it('uses the endpoint window for manual compression and preserves threshold, summary ratio and protected messages', async () => {
    useEndpointCatalog()
    getSessionDetailMock.mockReturnValue({ messages: [
      { id: 1, role: 'user', content: 'question' }, { id: 2, role: 'assistant', content: 'answer' },
    ] })
    readConfigYamlForProfileMock.mockResolvedValue({ compression: { threshold: 0.25, target_ratio: 0.1, protect_first_n: 2, protect_last_n: 7 } })
    compressorCompressMock.mockResolvedValue({ messages: [{ role: 'user', content: 'summary' }], meta: {
      totalMessages: 2, compressed: true, llmCompressed: true, summaryTokenEstimate: 1, verbatimCount: 0, compressedStartIndex: 0,
    } })
    const { forceCompressBridgeHistory } = await import('../../packages/server/src/modules/studio/services/chat-run/compression')
    await forceCompressBridgeHistory('session-1', 'default', [], undefined, { provider: 'unknown', model: 'shared', upstream: 'https://relay.test/v1', force: true, excludeLastUser: false, allowHermesFallback: false })
    expect(compressorConstructorMock.mock.calls[0][0].config).toEqual({ triggerTokens: 125_000, summaryBudget: 50_000, headMessageCount: 2, tailMessageCount: 7 })
  })

  it('preserves empty assistant reasoning_content in bridge history', async () => {
    getSessionDetailMock.mockReturnValue({
      messages: [
        {
          id: 1,
          session_id: 'session-1',
          role: 'assistant',
          content: 'called a tool',
          timestamp: 1,
          tool_call_id: null,
          tool_calls: null,
          tool_name: null,
          finish_reason: null,
          reasoning_content: '',
        },
        {
          id: 2,
          session_id: 'session-1',
          role: 'user',
          content: 'next',
          timestamp: 2,
          tool_call_id: null,
          tool_calls: null,
          tool_name: null,
          finish_reason: null,
          reasoning_content: null,
        },
      ],
    })

    const { buildCompressedHistory } = await import('../../packages/server/src/modules/studio/services/chat-run/compression')
    const history = await buildCompressedHistory(
      'session-1',
      'default',
      'http://upstream',
      undefined,
      vi.fn(),
      new Map(),
    )

    expect(history).toEqual([
      { role: 'assistant', content: 'called a tool', reasoning_content: '' },
    ])
  })

  it('keeps the latest stored user when the current input is not persisted', async () => {
    getSessionDetailMock.mockReturnValue({
      messages: [
        {
          id: 1,
          session_id: 'session-1',
          role: 'user',
          content: 'latest persisted user',
          timestamp: 1,
        },
      ],
    })

    const { buildCompressedHistory } = await import('../../packages/server/src/modules/studio/services/chat-run/compression')
    const history = await buildCompressedHistory(
      'session-1',
      'default',
      'http://upstream',
      undefined,
      vi.fn(),
      new Map(),
      {},
      undefined,
      0,
      false,
    )

    expect(history).toEqual([
      { role: 'user', content: 'latest persisted user' },
    ])
  })

  it('builds a cursor snapshot run from protected head and post-cursor rows without a full-history read', async () => {
    const rows = [
      { id: 1, session_id: 'session-1', role: 'user', content: 'protected head', timestamp: 1 },
      { id: 6, session_id: 'session-1', role: 'assistant', content: 'new answer', timestamp: 6 },
      { id: 7, session_id: 'session-1', role: 'user', content: 'follow up', timestamp: 7 },
      { id: 8, session_id: 'session-1', role: 'user', content: 'current input', timestamp: 8 },
    ]
    getSessionDetailMock.mockImplementation(() => {
      throw new Error('full history must not be read')
    })
    getSessionContextMessagesMock.mockImplementation((_sessionId: string, options: { afterId?: number; throughId?: number } = {}) => (
      rows.filter(row => (
        (options.afterId == null || row.id > options.afterId) &&
        (options.throughId == null || row.id <= options.throughId)
      ))
    ))
    getSessionContextMessageMock.mockImplementation((_sessionId: string, messageId: number) => (
      messageId === 5
        ? { id: 5, session_id: 'session-1', role: 'assistant', content: 'cursor row', timestamp: 5 }
        : rows.find(row => row.id === messageId) || null
    ))
    getCompressionSnapshotMock.mockReturnValue({
      summary: 'previous summary',
      lastMessageIndex: 4,
      messageCountAtTime: 5,
      compressedThroughMessageId: 5,
      protectedHeadThroughMessageId: 1,
      historyRevision: 0,
    })
    calcAndUpdateUsageMock.mockResolvedValue({ inputTokens: 100, outputTokens: 100 })
    estimateUsageTokensFromMessagesMock.mockReturnValue({ inputTokens: 100, outputTokens: 100 })

    const { buildCompressedHistory } = await import('../../packages/server/src/modules/studio/services/chat-run/compression')
    const history = await buildCompressedHistory(
      'session-1',
      'default',
      'http://upstream',
      undefined,
      vi.fn(),
      new Map(),
    )

    expect(history).toEqual([
      { role: 'user', content: 'protected head' },
      { role: 'user', content: '[Previous context summary]\n\nprevious summary' },
      { role: 'assistant', content: 'new answer' },
      { role: 'user', content: 'follow up' },
    ])
    expect(getSessionDetailMock).not.toHaveBeenCalled()
    expect(compressorCompressMock).not.toHaveBeenCalled()
  })

  it('excludes persisted MoA display rows from bridge history', async () => {
    getSessionDetailMock.mockReturnValue({
      messages: [
        {
          id: 1,
          session_id: 'session-1',
          role: 'user',
          content: 'start',
          timestamp: 1,
        },
        {
          id: 2,
          session_id: 'session-1',
          role: 'moa',
          display_role: 'tool',
          content: JSON.stringify({ preview: '1/2 grok', text: 'reference answer' }),
          tool_call_id: 'moa:reference:run-1:1',
          tool_name: 'moa_reference',
          timestamp: 2,
        },
        {
          id: 3,
          session_id: 'session-1',
          role: 'assistant',
          content: 'final answer',
          timestamp: 3,
        },
      ],
    })

    const { buildDbHistory } = await import('../../packages/server/src/modules/studio/services/chat-run/compression')
    await expect(buildDbHistory('session-1')).resolves.toEqual([
      { role: 'user', content: 'start' },
      { role: 'assistant', content: 'final answer' },
    ])
  })

  it('projects complete persisted tool results into a 5500-character bridge history', async () => {
    const completeToolResult = `HEAD-${'x'.repeat(7_000)}-TAIL`
    const detail = {
      messages: [
        {
          id: 1,
          session_id: 'session-1',
          role: 'tool',
          content: completeToolResult,
          tool_call_id: 'tool-call-1',
          tool_name: 'session_get',
          timestamp: 1,
        },
      ],
    }
    getSessionDetailMock.mockReturnValue(detail)

    const { buildDbHistory } = await import('../../packages/server/src/modules/studio/services/chat-run/compression')
    const history = await buildDbHistory('session-1')
    const projected = String(history[0]?.content || '')

    expect(projected).toHaveLength(5_500)
    expect(projected).toContain('... [truncated]')
    expect(projected).toMatch(/^HEAD-/)
    expect(projected).toMatch(/-TAIL$/)
    expect(detail.messages[0].content).toBe(completeToolResult)
  })

  it('uses the 5500-character bridge history for context tokens instead of complete DB usage', async () => {
    const completeToolResult = `HEAD-${'x'.repeat(70_000)}-TAIL`
    getSessionDetailMock.mockReturnValue({
      messages: [
        {
          id: 1,
          session_id: 'session-1',
          role: 'tool',
          content: completeToolResult,
          tool_call_id: 'tool-call-1',
          tool_name: 'session_get',
          timestamp: 1,
        },
      ],
    })
    calcAndUpdateUsageMock.mockResolvedValue({
      inputTokens: 0,
      outputTokens: 500_000,
      contextInputTokens: 0,
      contextOutputTokens: 5_500,
    })
    estimateUsageTokensFromMessagesMock.mockImplementation((messages: any[]) => ({
      inputTokens: 0,
      outputTokens: messages.reduce((sum, message) => sum + String(message.content || '').length, 0),
    }))
    const contextTokenEstimator = vi.fn(async (_messages: any[], messageTokens: number) => messageTokens)

    const { buildCompressedHistory } = await import('../../packages/server/src/modules/studio/services/chat-run/compression')
    const history = await buildCompressedHistory(
      'session-1',
      'default',
      'http://upstream',
      undefined,
      vi.fn(),
      new Map(),
      {},
      contextTokenEstimator,
    )

    expect(String(history[0]?.content || '')).toHaveLength(5_500)
    expect(calcAndUpdateUsageMock).toHaveBeenCalledWith(
      'session-1',
      expect.any(Object),
      expect.any(Function),
      { truncateToolResultsForContext: true },
    )
    expect(contextTokenEstimator).toHaveBeenCalledWith(expect.any(Array), 5_500)
    expect(compressorCompressMock).not.toHaveBeenCalled()
  })

  it('does not compress long low-token history just because it has more than 150 messages', async () => {
    const messages = Array.from({ length: 152 }, (_, index) => ({
      id: index + 1,
      session_id: 'session-1',
      role: index === 151 ? 'user' : index % 2 === 0 ? 'user' : 'assistant',
      content: `m${index}`,
      timestamp: index + 1,
      tool_call_id: null,
      tool_calls: null,
      tool_name: null,
      finish_reason: null,
      reasoning_content: null,
    }))
    getSessionDetailMock.mockReturnValue({ messages })

    const { buildCompressedHistory } = await import('../../packages/server/src/modules/studio/services/chat-run/compression')
    const history = await buildCompressedHistory(
      'session-1',
      'default',
      'http://upstream',
      undefined,
      vi.fn(),
      new Map(),
    )

    expect(history).toHaveLength(151)
    expect(history[0]).toEqual({ role: 'user', content: 'm0' })
    expect(history.at(-1)).toEqual({ role: 'user', content: 'm150' })
    expect(compressorCompressMock).not.toHaveBeenCalled()
  })

  it('uses configured threshold before triggering compression', async () => {
    const messages = Array.from({ length: 10 }, (_, index) => ({
      id: index + 1,
      session_id: 'session-1',
      role: index === 9 ? 'user' : index % 2 === 0 ? 'user' : 'assistant',
      content: `message ${index}`,
      timestamp: index + 1,
      tool_call_id: null,
      tool_calls: null,
      tool_name: null,
      finish_reason: null,
      reasoning_content: null,
    }))
    getSessionDetailMock.mockReturnValue({ messages })
    readConfigYamlForProfileMock.mockResolvedValue({
      compression: { threshold: 0.25, target_ratio: 0.1, protect_last_n: 7, protect_first_n: 2 },
    })
    calcAndUpdateUsageMock.mockResolvedValue({ inputTokens: 70_000, outputTokens: 0 })
    compressorCompressMock.mockResolvedValue({
      messages: [{ role: 'user', content: 'compressed' }],
      meta: {
        compressed: true,
        llmCompressed: true,
        totalMessages: 9,
        summaryTokenEstimate: 1,
        verbatimCount: 0,
        compressedStartIndex: 0,
      },
    })

    const { buildCompressedHistory } = await import('../../packages/server/src/modules/studio/services/chat-run/compression')
    const history = await buildCompressedHistory(
      'session-1',
      'default',
      'http://upstream',
      undefined,
      vi.fn(),
      new Map(),
    )

    expect(history).toEqual([{ role: 'user', content: 'compressed' }])
    expect(compressorCompressMock).toHaveBeenCalledWith(
      expect.any(Array),
      'http://upstream',
      undefined,
      'session-1',
      expect.objectContaining({
        profile: 'default',
        allowHermesFallback: true,
      }),
    )
  })

  it('passes an Ekko-only summarizer policy through the shared compressor', async () => {
    compressorCompressMock.mockResolvedValue({
      messages: [{ role: 'user', content: 'compressed' }],
      meta: {
        compressed: true,
        llmCompressed: true,
        totalMessages: 5,
        summaryTokenEstimate: 1,
        verbatimCount: 0,
        compressedStartIndex: 0,
      },
    })
    const state = { messages: [], isWorking: true, events: [], queue: [] }
    const sessionMap = new Map([['session-1', state as any]])
    const { compressHistory } = await import('../../packages/server/src/modules/studio/services/chat-run/compression')

    await compressHistory(
      Array.from({ length: 5 }, (_, index) => ({
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `message ${index}`,
      })),
      null,
      'session-1',
      'http://upstream',
      undefined,
      state as any,
      160_000,
      vi.fn(),
      sessionMap,
      { model: 'session-model', provider: 'session-provider', allowHermesFallback: false },
    )

    expect(compressorCompressMock).toHaveBeenCalledWith(
      expect.any(Array),
      'http://upstream',
      undefined,
      'session-1',
      expect.objectContaining({
        model: 'session-model',
        provider: 'session-provider',
        sessionId: 'session-1',
        allowHermesFallback: false,
      }),
    )
  })

  it('uses the session model for compression when auxiliary compression is auto', async () => {
    const messages = Array.from({ length: 10 }, (_, index) => ({
      id: index + 1,
      session_id: 'session-1',
      role: index === 9 ? 'user' : index % 2 === 0 ? 'user' : 'assistant',
      content: `message ${index}`,
      timestamp: index + 1,
      tool_call_id: null,
      tool_calls: null,
      tool_name: null,
      finish_reason: null,
      reasoning_content: null,
    }))
    getSessionDetailMock.mockReturnValue({ messages })
    getSessionMock.mockReturnValue({
      id: 'session-1',
      profile: 'default',
      model: 'session-model',
      provider: 'session-provider',
    })
    readConfigYamlForProfileMock.mockResolvedValue({
      auxiliary: { compression: { provider: 'auto' } },
    })
    calcAndUpdateUsageMock.mockResolvedValue({ inputTokens: 160_000, outputTokens: 0 })
    compressorCompressMock.mockResolvedValue({
      messages: [{ role: 'user', content: 'compressed' }],
      meta: {
        compressed: true,
        llmCompressed: true,
        totalMessages: 9,
        summaryTokenEstimate: 1,
        verbatimCount: 0,
        compressedStartIndex: 0,
      },
    })

    const { buildCompressedHistory } = await import('../../packages/server/src/modules/studio/services/chat-run/compression')
    await buildCompressedHistory(
      'session-1',
      'default',
      'http://upstream',
      undefined,
      vi.fn(),
      new Map(),
    )

    expect(compressorCompressMock).toHaveBeenCalledWith(
      expect.any(Array),
      'http://upstream',
      undefined,
      'session-1',
      expect.objectContaining({
        model: 'session-model',
        provider: 'session-provider',
      }),
    )
  })

  it('uses the profile default model for compression when auxiliary compression is main', async () => {
    const messages = Array.from({ length: 10 }, (_, index) => ({
      id: index + 1,
      session_id: 'session-1',
      role: index === 9 ? 'user' : index % 2 === 0 ? 'user' : 'assistant',
      content: `message ${index}`,
      timestamp: index + 1,
      tool_call_id: null,
      tool_calls: null,
      tool_name: null,
      finish_reason: null,
      reasoning_content: null,
    }))
    getSessionDetailMock.mockReturnValue({ messages })
    getSessionMock.mockReturnValue({
      id: 'session-1',
      profile: 'default',
      model: 'session-model',
      provider: 'session-provider',
    })
    readConfigYamlForProfileMock.mockResolvedValue({
      model: { default: 'main-model', provider: 'main-provider' },
      auxiliary: { compression: { provider: 'main' } },
    })
    calcAndUpdateUsageMock.mockResolvedValue({ inputTokens: 160_000, outputTokens: 0 })
    compressorCompressMock.mockResolvedValue({
      messages: [{ role: 'user', content: 'compressed' }],
      meta: {
        compressed: true,
        llmCompressed: true,
        totalMessages: 9,
        summaryTokenEstimate: 1,
        verbatimCount: 0,
        compressedStartIndex: 0,
      },
    })

    const { buildCompressedHistory } = await import('../../packages/server/src/modules/studio/services/chat-run/compression')
    await buildCompressedHistory(
      'session-1',
      'default',
      'http://upstream',
      undefined,
      vi.fn(),
      new Map(),
    )

    expect(compressorCompressMock).toHaveBeenCalledWith(
      expect.any(Array),
      'http://upstream',
      undefined,
      'session-1',
      expect.objectContaining({
        model: 'main-model',
        provider: 'main-provider',
      }),
    )
  })

  it('uses the configured auxiliary compression provider and model when set', async () => {
    const messages = Array.from({ length: 10 }, (_, index) => ({
      id: index + 1,
      session_id: 'session-1',
      role: index === 9 ? 'user' : index % 2 === 0 ? 'user' : 'assistant',
      content: `message ${index}`,
      timestamp: index + 1,
      tool_call_id: null,
      tool_calls: null,
      tool_name: null,
      finish_reason: null,
      reasoning_content: null,
    }))
    getSessionDetailMock.mockReturnValue({ messages })
    getSessionMock.mockReturnValue({
      id: 'session-1',
      profile: 'default',
      model: 'session-model',
      provider: 'session-provider',
    })
    readConfigYamlForProfileMock.mockResolvedValue({
      auxiliary: {
        compression: {
          provider: 'compress-provider',
          model: 'compress-model',
        },
      },
    })
    calcAndUpdateUsageMock.mockResolvedValue({ inputTokens: 160_000, outputTokens: 0 })
    compressorCompressMock.mockResolvedValue({
      messages: [{ role: 'user', content: 'compressed' }],
      meta: {
        compressed: true,
        llmCompressed: true,
        totalMessages: 9,
        summaryTokenEstimate: 1,
        verbatimCount: 0,
        compressedStartIndex: 0,
      },
    })

    const { buildCompressedHistory } = await import('../../packages/server/src/modules/studio/services/chat-run/compression')
    await buildCompressedHistory(
      'session-1',
      'default',
      'http://upstream',
      undefined,
      vi.fn(),
      new Map(),
    )

    expect(compressorCompressMock).toHaveBeenCalledWith(
      expect.any(Array),
      'http://upstream',
      undefined,
      'session-1',
      expect.objectContaining({
        model: 'compress-model',
        provider: 'compress-provider',
      }),
    )
  })

  it('uses local context estimates for compression threshold decisions', async () => {
    const messages = Array.from({ length: 10 }, (_, index) => ({
      id: index + 1,
      session_id: 'session-1',
      role: index === 9 ? 'user' : index % 2 === 0 ? 'user' : 'assistant',
      content: `message ${index}`,
      timestamp: index + 1,
      tool_call_id: null,
      tool_calls: null,
      tool_name: null,
      finish_reason: null,
      reasoning_content: null,
    }))
    getSessionDetailMock.mockReturnValue({ messages })
    calcAndUpdateUsageMock.mockResolvedValue({ inputTokens: 1_000, outputTokens: 0 })
    compressorCompressMock.mockResolvedValue({
      messages: [{ role: 'user', content: 'compressed by local context estimate' }],
      meta: {
        compressed: true,
        llmCompressed: true,
        totalMessages: 9,
        summaryTokenEstimate: 1,
        verbatimCount: 0,
        compressedStartIndex: 0,
      },
    })

    const emit = vi.fn()
    const { buildCompressedHistory } = await import('../../packages/server/src/modules/studio/services/chat-run/compression')
    const history = await buildCompressedHistory(
      'session-1',
      'default',
      'http://upstream',
      undefined,
      emit,
      new Map(),
      {},
      vi.fn(async () => 160_000),
    )

    expect(history).toEqual([{ role: 'user', content: 'compressed by local context estimate' }])
    expect(compressorCompressMock).toHaveBeenCalledTimes(1)
    expect(updateMessageContextTokenUsageMock).toHaveBeenCalledWith(
      'session-1',
      expect.any(Object),
      emit,
      1_000,
      { inputTokens: 1_000, outputTokens: 0 },
    )
  })

  it('uses the latest real Hermes prompt size as a floor when it is newer than the snapshot', async () => {
    const messages = Array.from({ length: 10 }, (_, index) => ({
      id: index + 1,
      session_id: 'session-1',
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `message ${index}`,
      timestamp: index + 1,
    }))
    getSessionDetailMock.mockReturnValue({ messages })
    compressorCompressMock.mockResolvedValue({
      messages: [{ role: 'user', content: 'compressed by real usage' }],
      meta: { compressed: true, llmCompressed: true, totalMessages: 9, summaryTokenEstimate: 1, verbatimCount: 0, compressedStartIndex: 0 },
    })
    // Local estimate says 1k; the provider already reported 160k of prompt (input + cache) for this session.
    getUsageMock.mockReturnValue({ input_tokens: 10_000, cache_read_tokens: 140_000, cache_write_tokens: 10_000, created_at: 2_000 })
    const { buildCompressedHistory } = await import('../../packages/server/src/modules/studio/services/chat-run/compression')
    const run = () => buildCompressedHistory('session-1', 'default', 'http://upstream', undefined, vi.fn(), new Map(), {}, vi.fn(async () => 1_000))

    expect(await run()).toEqual([{ role: 'user', content: 'compressed by real usage' }])
    expect(getUsageMock).toHaveBeenCalledWith('session-1', 'hermes')
    expect(compressorCompressMock).toHaveBeenCalledTimes(1)

    // Usage recorded before the latest compression snapshot describes the old, uncompressed context.
    compressorCompressMock.mockClear()
    getCompressionSnapshotMock.mockReturnValue({ summary: 'previous summary', lastMessageIndex: 4, messageCountAtTime: 5, compressedThroughMessageId: null, protectedHeadThroughMessageId: null, historyRevision: 0, updatedAt: 3_000 })
    await run()
    expect(compressorCompressMock).not.toHaveBeenCalled()
  })

  it('emits local context token usage when the local estimate is under threshold', async () => {
    const messages = Array.from({ length: 10 }, (_, index) => ({
      id: index + 1,
      session_id: 'session-1',
      role: index === 9 ? 'user' : index % 2 === 0 ? 'user' : 'assistant',
      content: `message ${index}`,
      timestamp: index + 1,
      tool_call_id: null,
      tool_calls: null,
      tool_name: null,
      finish_reason: null,
      reasoning_content: null,
    }))
    getSessionDetailMock.mockReturnValue({ messages })
    calcAndUpdateUsageMock.mockResolvedValue({ inputTokens: 1_000, outputTokens: 900 })
    const emit = vi.fn()
    const contextTokenEstimator = vi.fn(async () => 19_379)

    const { buildCompressedHistory } = await import('../../packages/server/src/modules/studio/services/chat-run/compression')
    const history = await buildCompressedHistory(
      'session-1',
      'default',
      'http://upstream',
      undefined,
      emit,
      new Map(),
      {},
      contextTokenEstimator,
    )

    expect(history).toHaveLength(9)
    expect(contextTokenEstimator).toHaveBeenCalledWith(
      expect.arrayContaining([{ role: 'user', content: 'message 0' }]),
      1_900,
    )
    expect(emit).toHaveBeenCalledWith('usage.updated', expect.objectContaining({
      event: 'usage.updated',
      session_id: 'session-1',
      inputTokens: 1_000,
      outputTokens: 900,
      contextTokens: 19_379,
    }))
    expect(compressorCompressMock).not.toHaveBeenCalled()
  })

  it('includes current input tokens when estimating snapshot-aware context', async () => {
    const messages = Array.from({ length: 10 }, (_, index) => ({
      id: index + 1,
      session_id: 'session-1',
      role: index === 9 ? 'user' : index % 2 === 0 ? 'user' : 'assistant',
      content: `message ${index}`,
      timestamp: index + 1,
      tool_call_id: null,
      tool_calls: null,
      tool_name: null,
      finish_reason: null,
      reasoning_content: null,
    }))
    getSessionDetailMock.mockReturnValue({ messages })
    getCompressionSnapshotMock.mockReturnValue({
      summary: 'previous summary',
      lastMessageIndex: 4,
      messageCountAtTime: 5,
    })
    calcAndUpdateUsageMock.mockResolvedValue({ inputTokens: 10, outputTokens: 0 })
    estimateUsageTokensFromMessagesMock.mockReturnValue({ inputTokens: 1_000, outputTokens: 0 })
    const emit = vi.fn()
    const contextTokenEstimator = vi.fn(async (_messages, messageTokens: number) => 20_000 + messageTokens)

    const { buildCompressedHistory } = await import('../../packages/server/src/modules/studio/services/chat-run/compression')
    await buildCompressedHistory(
      'session-1',
      'default',
      'http://upstream',
      undefined,
      emit,
      new Map(),
      {},
      contextTokenEstimator,
      700,
    )

    expect(contextTokenEstimator).toHaveBeenCalledWith(expect.any(Array), 1_700)
    expect(emit).toHaveBeenCalledWith('usage.updated', expect.objectContaining({
      contextTokens: 21_700,
    }))
    expect(compressorCompressMock).not.toHaveBeenCalled()
  })

  it('keeps current input tokens in the compression completed context total', async () => {
    const messages = Array.from({ length: 10 }, (_, index) => ({
      id: index + 1,
      session_id: 'session-1',
      role: index === 9 ? 'user' : index % 2 === 0 ? 'user' : 'assistant',
      content: `message ${index}`,
      timestamp: index + 1,
      tool_call_id: null,
      tool_calls: null,
      tool_name: null,
      finish_reason: null,
      reasoning_content: null,
    }))
    getSessionDetailMock.mockReturnValue({ messages })
    calcAndUpdateUsageMock.mockResolvedValue({ inputTokens: 100, outputTokens: 0 })
    estimateUsageTokensFromMessagesMock.mockImplementation((items: any[]) => {
      if (items?.[0]?.content === 'compressed result') return { inputTokens: 1_000, outputTokens: 0 }
      return { inputTokens: 100, outputTokens: 0 }
    })
    compressorCompressMock.mockResolvedValue({
      messages: [{ role: 'user', content: 'compressed result' }],
      meta: {
        compressed: true,
        llmCompressed: true,
        totalMessages: 9,
        summaryTokenEstimate: 1,
        verbatimCount: 0,
        compressedStartIndex: 0,
      },
    })
    const emit = vi.fn()

    const { buildCompressedHistory } = await import('../../packages/server/src/modules/studio/services/chat-run/compression')
    await buildCompressedHistory(
      'session-1',
      'default',
      'http://upstream',
      undefined,
      emit,
      new Map(),
      {},
      vi.fn(async () => 160_000),
      700,
    )

    expect(updateMessageContextTokenUsageMock).toHaveBeenCalledWith(
      'session-1',
      expect.any(Object),
      emit,
      1_700,
      { inputTokens: 100, outputTokens: 0 },
    )
    expect(emit).toHaveBeenCalledWith('compression.completed', expect.objectContaining({
      afterTokens: 1_700,
      contextTokens: 1_700,
    }))
  })

  it('throws when fixed prompt and tool schemas exceed threshold before any history exists', async () => {
    getSessionDetailMock.mockReturnValue({ messages: [] })
    const emit = vi.fn()

    const { buildCompressedHistory, ContextWindowTooSmallError } = await import('../../packages/server/src/modules/studio/services/chat-run/compression')

    await expect(buildCompressedHistory(
      'session-1',
      'default',
      'http://upstream',
      undefined,
      emit,
      new Map(),
      {},
      vi.fn(async () => 160_000),
    )).rejects.toBeInstanceOf(ContextWindowTooSmallError)

    expect(emit).not.toHaveBeenCalledWith('usage.updated', expect.anything())
    expect(compressorCompressMock).not.toHaveBeenCalled()
  })

  it('throws instead of compressing when full context is over threshold but history is too short', async () => {
    const messages = Array.from({ length: 5 }, (_, index) => ({
      id: index + 1,
      session_id: 'session-1',
      role: index === 4 ? 'user' : index % 2 === 0 ? 'user' : 'assistant',
      content: `message ${index}`,
      timestamp: index + 1,
      tool_call_id: null,
      tool_calls: null,
      tool_name: null,
      finish_reason: null,
      reasoning_content: null,
    }))
    getSessionDetailMock.mockReturnValue({ messages })
    calcAndUpdateUsageMock.mockResolvedValue({ inputTokens: 1_000, outputTokens: 0 })

    const { buildCompressedHistory, ContextWindowTooSmallError } = await import('../../packages/server/src/modules/studio/services/chat-run/compression')

    await expect(buildCompressedHistory(
      'session-1',
      'default',
      'http://upstream',
      undefined,
      vi.fn(),
      new Map(),
      {},
      vi.fn(async () => 160_000),
    )).rejects.toBeInstanceOf(ContextWindowTooSmallError)

    expect(compressorCompressMock).not.toHaveBeenCalled()
  })

  it('merges partial compression config with defaults', async () => {
    const messages = Array.from({ length: 10 }, (_, index) => ({
      id: index + 1,
      session_id: 'session-1',
      role: index === 9 ? 'user' : index % 2 === 0 ? 'user' : 'assistant',
      content: `message ${index}`,
      timestamp: index + 1,
      tool_call_id: null,
      tool_calls: null,
      tool_name: null,
      finish_reason: null,
      reasoning_content: null,
    }))
    getSessionDetailMock.mockReturnValue({ messages })
    readConfigYamlForProfileMock.mockResolvedValue({
      compression: { protect_last_n: 5 },
    })
    calcAndUpdateUsageMock.mockResolvedValue({ inputTokens: 160_000, outputTokens: 0 })
    compressorCompressMock.mockResolvedValue({
      messages: [{ role: 'user', content: 'compressed' }],
      meta: {
        compressed: true,
        llmCompressed: true,
        totalMessages: 9,
        summaryTokenEstimate: 1,
        verbatimCount: 0,
        compressedStartIndex: 0,
      },
    })

    const { buildCompressedHistory } = await import('../../packages/server/src/modules/studio/services/chat-run/compression')
    await buildCompressedHistory(
      'session-1',
      'default',
      'http://upstream',
      undefined,
      vi.fn(),
      new Map(),
    )

    expect(compressorConstructorMock).toHaveBeenCalledWith({
      config: {
        triggerTokens: 128_000,
        summaryBudget: 51_200,
        headMessageCount: 3,
        tailMessageCount: 5,
      },
    })
    expect(compressorCompressMock).toHaveBeenCalledTimes(1)
  })

  it('uses stale snapshot summary plus safe tail instead of full history when under threshold', async () => {
    const messages = Array.from({ length: 10 }, (_, index) => ({
      id: index + 1,
      session_id: 'session-1',
      role: index === 9 ? 'user' : index % 2 === 0 ? 'user' : 'assistant',
      content: `message ${index}`,
      timestamp: index + 1,
      tool_call_id: null,
      tool_calls: null,
      tool_name: null,
      finish_reason: null,
      reasoning_content: null,
    }))
    getSessionDetailMock.mockReturnValue({ messages })
    getCompressionSnapshotMock.mockReturnValue({
      summary: 'old summary',
      lastMessageIndex: 99,
      messageCountAtTime: 100,
    })
    readConfigYamlForProfileMock.mockResolvedValue({
      compression: { protect_first_n: 2, protect_last_n: 3 },
    })
    estimateUsageTokensFromMessagesMock.mockReturnValue({ inputTokens: 1_000, outputTokens: 0 })

    const { buildCompressedHistory } = await import('../../packages/server/src/modules/studio/services/chat-run/compression')
    const history = await buildCompressedHistory(
      'session-1',
      'default',
      'http://upstream',
      undefined,
      vi.fn(),
      new Map(),
    )

    expect(history.map(m => m.content)).toEqual([
      'message 0',
      'message 1',
      '[Previous context summary]\n\nold summary',
      'message 6',
      'message 7',
      'message 8',
    ])
    expect(compressorCompressMock).not.toHaveBeenCalled()
  })

  it('compresses stale snapshot safe tail instead of full history when stale assembly exceeds threshold', async () => {
    const messages = Array.from({ length: 10 }, (_, index) => ({
      id: index + 1,
      session_id: 'session-1',
      role: index === 9 ? 'user' : index % 2 === 0 ? 'user' : 'assistant',
      content: `message ${index}`,
      timestamp: index + 1,
      tool_call_id: null,
      tool_calls: null,
      tool_name: null,
      finish_reason: null,
      reasoning_content: null,
    }))
    getSessionDetailMock.mockReturnValue({ messages })
    getCompressionSnapshotMock.mockReturnValue({
      summary: 'old summary',
      lastMessageIndex: 99,
      messageCountAtTime: 100,
    })
    readConfigYamlForProfileMock.mockResolvedValue({
      compression: { protect_first_n: 2, protect_last_n: 3 },
    })
    estimateUsageTokensFromMessagesMock.mockReturnValue({ inputTokens: 160_000, outputTokens: 0 })
    compressorCompressMock.mockResolvedValue({
      messages: [{ role: 'user', content: 'updated stale compressed' }],
      meta: {
        compressed: true,
        llmCompressed: true,
        totalMessages: 9,
        summaryTokenEstimate: 1,
        verbatimCount: 0,
        compressedStartIndex: 8,
      },
    })

    const { buildCompressedHistory } = await import('../../packages/server/src/modules/studio/services/chat-run/compression')
    const history = await buildCompressedHistory(
      'session-1',
      'default',
      'http://upstream',
      undefined,
      vi.fn(),
      new Map(),
    )

    expect(history).toEqual([{ role: 'user', content: 'updated stale compressed' }])
    expect(compressorCompressMock).toHaveBeenCalledWith(
      expect.arrayContaining([{ role: 'user', content: 'message 0' }]),
      'http://upstream',
      undefined,
      'session-1',
      expect.objectContaining({ profile: 'default' }),
    )
  })

  it('does not compress when compression is disabled', async () => {
    const messages = Array.from({ length: 10 }, (_, index) => ({
      id: index + 1,
      session_id: 'session-1',
      role: index === 9 ? 'user' : index % 2 === 0 ? 'user' : 'assistant',
      content: `message ${index}`,
      timestamp: index + 1,
      tool_call_id: null,
      tool_calls: null,
      tool_name: null,
      finish_reason: null,
      reasoning_content: null,
    }))
    getSessionDetailMock.mockReturnValue({ messages })
    readConfigYamlForProfileMock.mockResolvedValue({
      compression: { enabled: false, threshold: 0.01 },
    })
    calcAndUpdateUsageMock.mockResolvedValue({ inputTokens: 180_000, outputTokens: 0 })

    const { buildCompressedHistory } = await import('../../packages/server/src/modules/studio/services/chat-run/compression')
    const history = await buildCompressedHistory(
      'session-1',
      'default',
      'http://upstream',
      undefined,
      vi.fn(),
      new Map(),
    )

    expect(history).toHaveLength(9)
    expect(compressorCompressMock).not.toHaveBeenCalled()
    expect(calcAndUpdateUsageMock).not.toHaveBeenCalled()
  })
})
