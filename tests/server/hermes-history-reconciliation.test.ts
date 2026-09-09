import { beforeEach, describe, expect, it, vi } from 'vitest'

const getSessionDetailMock = vi.fn()
const addMessagesMock = vi.fn()
const updateSessionStatsMock = vi.fn()
const deleteCompressionSnapshotMock = vi.fn()
const getHermesSessionDetailForProfileMock = vi.fn()

vi.mock('../../packages/server/src/modules/studio/repositories/session-store', () => ({
  getSessionDetail: getSessionDetailMock,
  addMessages: addMessagesMock,
  updateSessionStats: updateSessionStatsMock,
}))

vi.mock('../../packages/server/src/modules/studio/repositories/compression-snapshot', () => ({
  deleteCompressionSnapshot: deleteCompressionSnapshotMock,
}))

vi.mock('../../packages/server/src/modules/studio/public/session-agent-runtime', () => ({
  getHermesSessionDetailForProfile: getHermesSessionDetailForProfileMock,
}))

vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({
  logger: { warn: vi.fn() },
}))

describe('Hermes native continuation history reconciliation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('preserves local-only messages and imports one native continuation tool turn idempotently', async () => {
    let localMessages: any[] = [
      { id: 10, session_id: 'studio-root', role: 'user', content: 'root request', timestamp: 10 },
      { id: 11, session_id: 'studio-root', role: 'assistant', content: 'Studio-only bridge note', timestamp: 11 },
    ]
    getSessionDetailMock.mockImplementation(() => ({
      id: 'studio-root', profile: 'research', source: 'cli', messages: localMessages,
    }))
    addMessagesMock.mockImplementation((messages: any[]) => {
      localMessages = [...localMessages, ...messages.map((message, index) => ({ ...message, id: 20 + index }))]
      return messages.map((_message, index) => 20 + index)
    })
    getHermesSessionDetailForProfileMock.mockResolvedValue({
      id: 'studio-root',
      thread_session_count: 2,
      messages: [
        { id: 1, session_id: 'studio-root', role: 'user', content: 'root request', timestamp: 10 },
        {
          id: 2,
          session_id: 'native-tip',
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }],
          timestamp: 20,
        },
        { id: 3, session_id: 'native-tip', role: 'tool', content: 'result', tool_call_id: 'call-1', tool_name: 'lookup', timestamp: 21 },
        { id: 4, session_id: 'native-tip', role: 'assistant', content: 'continued answer', timestamp: 22 },
      ],
    })
    const invalidate = vi.fn()
    const { reconcileHermesSessionHistory } = await import(
      '../../packages/server/src/modules/studio/services/history/reconcile-hermes-history'
    )

    await expect(reconcileHermesSessionHistory('studio-root', {
      profile: 'research', invalidateCachedHistory: invalidate,
    })).resolves.toEqual({ changed: true, added: 3 })
    await expect(reconcileHermesSessionHistory('studio-root', {
      profile: 'research', invalidateCachedHistory: invalidate,
    })).resolves.toEqual({ changed: false, added: 0 })

    expect(localMessages.map(message => message.content)).toEqual([
      'root request',
      'Studio-only bridge note',
      '',
      'result',
      'continued answer',
    ])
    expect(localMessages.filter(message => message.role === 'tool')).toHaveLength(1)
    expect(localMessages.filter(message => message.content === 'continued answer')).toHaveLength(1)
    expect(localMessages.slice(2).map(message => message.run_marker)).toEqual([
      'hermes_lineage:native-tip:2',
      'hermes_lineage:native-tip:3',
      'hermes_lineage:native-tip:4',
    ])
    expect(deleteCompressionSnapshotMock).toHaveBeenCalledTimes(1)
    expect(updateSessionStatsMock).toHaveBeenCalledTimes(1)
    expect(invalidate).toHaveBeenCalledTimes(1)
  })

  it('imports an incrementally appended identical native turn with a distinct timestamp and id exactly once', async () => {
    let localMessages: any[] = [
      { id: 10, session_id: 'incremental-root', role: 'user', content: 'repeat', timestamp: 10 },
    ]
    let nativeMessages: any[] = [
      { id: 1, session_id: 'incremental-root', role: 'user', content: 'repeat', timestamp: 10 },
      { id: 2, session_id: 'native-tip', role: 'assistant', content: 'same answer', timestamp: 20 },
    ]
    getSessionDetailMock.mockImplementation(() => ({
      id: 'incremental-root', profile: 'default', source: 'cli', messages: localMessages,
    }))
    addMessagesMock.mockImplementation((messages: any[]) => {
      localMessages = [...localMessages, ...messages.map((message, index) => ({ ...message, id: 20 + localMessages.length + index }))]
      return messages.map((_message, index) => 20 + index)
    })
    getHermesSessionDetailForProfileMock.mockImplementation(async () => ({
      id: 'incremental-root', thread_session_count: 2, messages: nativeMessages,
    }))
    const { reconcileHermesSessionHistory } = await import(
      '../../packages/server/src/modules/studio/services/history/reconcile-hermes-history'
    )

    await expect(reconcileHermesSessionHistory('incremental-root')).resolves.toEqual({ changed: true, added: 1 })
    nativeMessages = [
      ...nativeMessages,
      { id: 3, session_id: 'native-tip', role: 'assistant', content: 'same answer', timestamp: 21 },
    ]
    await expect(reconcileHermesSessionHistory('incremental-root')).resolves.toEqual({ changed: true, added: 1 })
    await expect(reconcileHermesSessionHistory('incremental-root')).resolves.toEqual({ changed: false, added: 0 })

    expect(localMessages.filter(message => message.content === 'same answer')).toHaveLength(2)
    expect(localMessages.filter(message => message.run_marker === 'hermes_lineage:native-tip:3')).toHaveLength(1)
  })

  it('does not read another profile or rewrite an active session', async () => {
    getSessionDetailMock.mockReturnValue({
      id: 'isolated-root', profile: 'work', source: 'api_server', messages: [],
    })
    const { reconcileHermesSessionHistory } = await import(
      '../../packages/server/src/modules/studio/services/history/reconcile-hermes-history'
    )

    await expect(reconcileHermesSessionHistory('isolated-root', { profile: 'personal' }))
      .resolves.toEqual({ changed: false, added: 0 })
    await expect(reconcileHermesSessionHistory('isolated-root', {
      profile: 'work', isSessionActive: () => true,
    })).resolves.toEqual({ changed: false, added: 0 })

    expect(getHermesSessionDetailForProfileMock).not.toHaveBeenCalled()
    expect(addMessagesMock).not.toHaveBeenCalled()
  })

  it('ignores native history without a lineage-selected compression continuation', async () => {
    getSessionDetailMock.mockReturnValue({
      id: 'plain-root', profile: 'default', source: 'cli', messages: [],
    })
    getHermesSessionDetailForProfileMock.mockResolvedValue({
      id: 'plain-root',
      thread_session_count: 1,
      messages: [{ id: 1, session_id: 'plain-root', role: 'user', content: 'plain turn' }],
    })
    const { reconcileHermesSessionHistory } = await import(
      '../../packages/server/src/modules/studio/services/history/reconcile-hermes-history'
    )

    await expect(reconcileHermesSessionHistory('plain-root', { profile: 'default' }))
      .resolves.toEqual({ changed: false, added: 0 })
    expect(addMessagesMock).not.toHaveBeenCalled()
    expect(deleteCompressionSnapshotMock).not.toHaveBeenCalled()
  })
})
