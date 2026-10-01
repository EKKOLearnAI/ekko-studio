import { withRunUsage } from '../../packages/server/src/modules/studio/repositories/run-usage-store'
import { describe, expect, it, vi } from 'vitest'
import '../../packages/server/src/bootstrap/coding-agent-adapters'
import { initAllHermesTables } from '../../packages/server/src/modules/studio/infrastructure/database/schemas'
import { createSession, getSessionDetail } from '../../packages/server/src/modules/studio/repositories/session-store'
import { updateUsage } from '../../packages/server/src/modules/studio/repositories/usage-store'
import { handleAbort } from '../../packages/server/src/modules/studio/services/chat-run/abort'
import { onRunUsageUpdated } from '../../packages/server/src/modules/studio/repositories/run-usage-store'
import { recordBridgeToolStarted } from '../../packages/server/src/modules/studio/services/chat-run/bridge-message'
import * as chatRuntime from '../../packages/server/src/modules/studio/public/chat-agent-runtime'

describe('Hermes interrupted usage cards', () => {
  it.each(['text', 'reasoning', 'tool-only', 'no-output'])('persists a stopped %s reply and updates its card when usage arrives late', async kind => {
    initAllHermesTables()
    const sid = `abort-hermes-${kind}-${Date.now()}`
    createSession({ id: sid, profile: 'default', source: 'cli', agent: 'hermes' })
    const state: any = { messages: [], events: [], queue: [], isWorking: true, profile: 'default', source: 'cli',
      runId: 'hermes-run', activeRunMarker: 'marker',
      bridgePendingAssistantContent: kind === 'text' ? 'partial reply' : '',
      bridgePendingReasoningContent: kind === 'reasoning' ? 'partial reasoning' : '' }
    if (kind === 'tool-only') recordBridgeToolStarted(state, sid, 'marker', 'terminal', { command: 'pwd' }, 'tool-1')
    updateUsage(sid, { source: 'hermes', runId: 'request-1', parentRunId: 'hermes-run', inputTokens: 10, outputTokens: 4, apiDuration: 2 })
    const events = vi.fn()
    const updates = vi.fn()
    const off = onRunUsageUpdated(updates)
    vi.spyOn(chatRuntime.chatCodingAgentRunManager, 'hasSession').mockReturnValue(false)
    vi.spyOn(chatRuntime, 'hasChatEkkoBackgroundTasks').mockReturnValue(false)
    try {
      await handleAbort({ to: () => ({ emit: events }), adapter: { rooms: new Map([[`session:${sid}`, new Set(['socket'])]]) } } as any,
        { connected: true, emit: events } as any, sid, new Map([[sid, state]]), { interrupt: vi.fn(async () => ({ synced: true })) }, vi.fn())
      const completed = events.mock.calls.find(([event]) => event === 'abort.completed')![1]
      expect(completed.run_usage).toMatchObject({ inputTokens: 10, outputTokens: 4, tokensPerSecond: 2, runId: 'hermes-run' })
      expect(completed.run_usage.assistantMessageId).toBeTruthy()
      updateUsage(sid, { source: 'hermes', runId: 'request-2', parentRunId: 'hermes-run', inputTokens: 20, outputTokens: 6, apiDuration: 3 })
      expect(updates).toHaveBeenCalledWith(sid, expect.objectContaining({ assistantMessageId: completed.run_usage.assistantMessageId, inputTokens: 30, outputTokens: 10 }))
      const messages = withRunUsage(sid, getSessionDetail(sid)!.messages)
      expect(messages.filter(message => (message as any).run_usage)).toHaveLength(1)
      expect(messages.filter(message => message.role === 'assistant')).toHaveLength(1)
      const assistant = messages.find(message => message.role === 'assistant')!
      expect(assistant).toHaveProperty('run_usage.outputTokens', 10)
      if (kind === 'text') expect(assistant.content).toBe('partial reply')
      if (kind === 'reasoning') expect(assistant.reasoning).toBe('partial reasoning')
    } finally { off(); vi.restoreAllMocks() }
  })
})
