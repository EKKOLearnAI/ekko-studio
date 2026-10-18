import { beforeEach, describe, expect, it, vi } from 'vitest'
import { configureChatAgentRuntime } from '../../packages/server/src/modules/studio/public/chat-agent-runtime'
import { projectBrowserHistory } from '../../packages/ekko-agent/src/model/browser-context'

const addMessageMock = vi.fn()
const getSessionDetailMock = vi.fn()

vi.mock('../../packages/server/src/modules/studio/repositories/session-store', () => ({
  addMessage: addMessageMock,
  getSessionDetail: getSessionDetailMock,
}))

vi.mock('../../packages/server/src/modules/studio/repositories/compression-snapshot', () => ({
  getCompressionSnapshot: vi.fn(() => null),
}))

vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}))

describe('Bridge tool result context projection', () => {
  beforeEach(() => {
    configureChatAgentRuntime({ projectBrowserHistory } as any)
    addMessageMock.mockReset()
    getSessionDetailMock.mockReset()
  })

  it('keeps the complete result in memory and persistence while context is bounded', async () => {
    addMessageMock.mockReturnValue(77)
    const completeToolResult = `HEAD-${'x'.repeat(70_000)}-TAIL`
    const state: any = {
      messages: [],
      bridgePendingTools: [{
        id: 'tool-call-1',
        name: 'session_get',
        arguments: '{}',
        startedAt: Date.now(),
      }],
    }
    const { recordBridgeToolCompleted } = await import(
      '../../packages/server/src/modules/studio/services/chat-run/bridge-message'
    )
    const { truncateToolResultForContext } = await import(
      '../../packages/server/src/modules/studio/services/chat-run/tool-result-context'
    )

    const completed = recordBridgeToolCompleted(
      state,
      'session-1',
      'run-1',
      'session_get',
      { tool_call_id: 'tool-call-1', result: completeToolResult },
    )

    expect(completed.output).toBe(completeToolResult)
    expect(completed.messageId).toBe(77)
    expect(state.messages[0].content).toBe(completeToolResult)
    expect(state.messages[0].runMarker).toBe('run-1')
    expect(addMessageMock).toHaveBeenCalledWith(expect.objectContaining({
      role: 'tool',
      content: completeToolResult,
      run_marker: 'run-1',
    }))
    expect(truncateToolResultForContext(completeToolResult)).toHaveLength(5_500)
  })

  it('bounds Bridge context tokens without changing the default Coding Agent estimate', async () => {
    const completeToolResult = `HEAD-${'x'.repeat(70_000)}-TAIL`
    getSessionDetailMock.mockReturnValue({
      messages: [{ role: 'tool', content: completeToolResult }],
    })
    const { countTokens } = await import('../../packages/server/src/modules/studio/services/context-compressor')
    const { truncateToolResultForContext } = await import(
      '../../packages/server/src/modules/studio/services/chat-run/tool-result-context'
    )
    const { calcAndUpdateUsage } = await import(
      '../../packages/server/src/modules/studio/services/chat-run/usage'
    )
    const makeState = () => ({ messages: [], isWorking: false, events: [], queue: [] }) as any

    const bridgeUsage = await calcAndUpdateUsage(
      'session-1',
      makeState(),
      vi.fn(),
      { truncateToolResultsForContext: true },
    )
    const defaultUsage = await calcAndUpdateUsage('session-1', makeState(), vi.fn())

    expect(bridgeUsage.outputTokens).toBe(countTokens(completeToolResult))
    expect(bridgeUsage.contextOutputTokens).toBe(countTokens(truncateToolResultForContext(completeToolResult)))
    expect(defaultUsage.outputTokens).toBe(countTokens(completeToolResult))
    expect(defaultUsage.contextOutputTokens).toBeUndefined()
    expect(bridgeUsage.outputTokens).toBeGreaterThan(bridgeUsage.contextOutputTokens || 0)
  })

  it('projects stale browser JSON before generic truncation and preserves current refs and DB cursors', async () => {
    const { buildDbHistoryFromContextRows } = await import('../../packages/server/src/modules/studio/services/chat-run/context-history')
    const snapshot = (id: string) => JSON.stringify({ result: { tabId: 'tab', snapshotId: id, nodes:
      Array.from({ length: 100 }, (_, i) => ({ ref: `@e${i + 1}`, role: 'button', name: `Item ${i} ${'x'.repeat(100)}` })) } }, null, 2)
    const old = snapshot('old'), current = snapshot('current')
    const rows = [
      { id: 1, role: 'tool', tool_name: 'ekko_studio_browser_toolset', tool_call_id: 'old-call', content: old },
      { id: 2, role: 'tool', tool_name: 'ekko_studio_browser_toolset', tool_call_id: 'new-call', content: current },
      { id: 3, role: 'tool', tool_name: 'other', tool_call_id: 'other-call', content: 'x'.repeat(10000) },
    ] as any
    const history = buildDbHistoryFromContextRows('session-1', rows)
    expect(JSON.parse(history[0].content as string).result.stale).toBe(true)
    expect(JSON.parse(history[1].content as string).result.nodes[99].ref).toBe('@e100')
    expect(history[2].content).toHaveLength(5500)
    expect((history[0] as any).cursorId).toBe(1)
    expect(Object.keys(history[0])).not.toContain('cursorId')
    expect(rows[0].content).toBe(old)
    expect(rows[1].content).toBe(current)
    expect(buildDbHistoryFromContextRows('session-1', rows, { truncateToolResults: false })[0].content).toBe(old)
    getSessionDetailMock.mockReturnValue({ messages: rows })
    const { calcAndUpdateUsage, estimateUsageTokensFromMessages } = await import('../../packages/server/src/modules/studio/services/chat-run/usage')
    const usage = await calcAndUpdateUsage('session-1', { messages: [], isWorking: false, events: [], queue: [] } as any,
      vi.fn(), { truncateToolResultsForContext: true })
    expect(usage.contextOutputTokens).toBe(estimateUsageTokensFromMessages(history).outputTokens)
  })
})
