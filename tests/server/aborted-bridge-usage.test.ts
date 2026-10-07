import { completeRunUsage, withRunUsage } from '../../packages/server/src/modules/studio/repositories/run-usage-store'
import { describe, expect, it, vi } from 'vitest'
import '../../packages/server/src/bootstrap/coding-agent-adapters'
import { initAllHermesTables } from '../../packages/server/src/modules/studio/infrastructure/database/schemas'
import { createSession, getSessionDetail } from '../../packages/server/src/modules/studio/repositories/session-store'
import { updateUsage } from '../../packages/server/src/modules/studio/repositories/usage-store'
import { handleAbort } from '../../packages/server/src/modules/studio/services/chat-run/abort'
import { onRunUsageUpdated } from '../../packages/server/src/modules/studio/repositories/run-usage-store'
import { recordBridgeToolStarted } from '../../packages/server/src/modules/studio/services/chat-run/bridge-message'
import * as chatRuntime from '../../packages/server/src/modules/studio/public/chat-agent-runtime'
import { ChatRunSocket } from '../../packages/server/src/modules/studio/sockets/chat-run'

describe('late usage socket updates', () => {
  it.each(['codex', 'hermes', 'ekko-agent'])('updates %s cards without changing the active run or context', agent => {
    initAllHermesTables()
    const sid = `late-${agent}-${Date.now()}`
    const source = agent === 'codex' ? 'coding_agent' : agent === 'hermes' ? 'hermes' : 'ekko_agent'
    createSession({ id: sid, profile: 'default', source: agent === 'hermes' ? 'cli' : 'coding_agent', agent })
    vi.spyOn(chatRuntime, 'createPrimaryAgentBridge').mockReturnValue({} as any)
    const server = new ChatRunSocket({ of: () => ({}) } as any)
    const emit = vi.spyOn(server, 'emitExternalEvent').mockImplementation(() => {})
    const active = { runId: 'next', isWorking: true, inputTokens: 500, contextTokens: 999 }
    ;(server as any).sessionMap.set(sid, active)
    try {
      updateUsage(sid, { source, runId: 'first-request', parentRunId: 'first', inputTokens: 10, outputTokens: 4 })
      completeRunUsage(sid, 'first', 'reply-1')
      updateUsage(sid, { source, runId: 'next-request', parentRunId: 'next', inputTokens: 20, outputTokens: 6 })
      updateUsage(sid, { source, runId: 'late-request', parentRunId: 'first', inputTokens: 30, outputTokens: 8 })
      const payload = emit.mock.calls.at(-1)![2]
      expect(payload).toMatchObject({ run_id: 'first', run_usage: { assistantMessageId: 'reply-1', inputTokens: 40, outputTokens: 12 } })
      if (agent === 'codex') {
        expect(payload).toMatchObject({ inputTokens: 60, outputTokens: 18 })
        expect(active.inputTokens).toBe(60)
      } else {
        expect(payload).not.toHaveProperty('inputTokens')
        expect(active.inputTokens).toBe(500)
      }
      expect(active).toMatchObject({ runId: 'next', isWorking: true, contextTokens: 999 })
    } finally {
      ;(server as any).stopUsageUpdates()
      vi.restoreAllMocks()
    }
  })
})

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
