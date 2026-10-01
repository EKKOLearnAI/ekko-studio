import { EventEmitter } from 'events'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { PassThrough } from 'stream'
import { spawn } from 'child_process'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '../../packages/server/src/bootstrap/coding-agent-adapters'
import { CodingAgentRunManager } from '../../packages/server/src/modules/coding-agents/services/runtime/run-manager'
import { NativeTurnUsage } from '../../packages/server/src/modules/coding-agents/services/runtime/native-usage'
import * as nativeModel from '../../packages/server/src/modules/coding-agents/services/runtime/native-model'
import * as usageLedger from '../../packages/server/src/modules/studio/public/usage'
import { initAllHermesTables } from '../../packages/server/src/modules/studio/infrastructure/database/schemas'
import { getRecordedUsageTotals, getUsage, getLocalUsageStats, updateUsage } from '../../packages/server/src/modules/studio/repositories/usage-store'
import { withRunUsage } from '../../packages/server/src/modules/studio/repositories/run-usage-store'
import { createSession, getSession, getSessionDetail, getSessionDetailPaginated, listSessions, searchSessions } from '../../packages/server/src/modules/studio/repositories/session-store'
import fixtures from '../fixtures/coding-agents/global-native-usage.json'

vi.mock('child_process', async importOriginal => ({
  ...await importOriginal<typeof import('child_process')>(), spawn: vi.fn(),
}))

// Captured-event costs must not depend on a live catalog download or local cache.
vi.mock('../../packages/server/src/modules/studio/public/model-catalog', () => ({
  getModelCatalog: vi.fn(() => null),
  getModelCatalogSnapshot: vi.fn(() => undefined),
  refreshModelCatalog: vi.fn(async () => undefined),
}))

describe('global native usage accounting', () => {
  let manager: CodingAgentRunManager
  let workspace: string
  let sessionId: string
  let child: any
  let emitted: ReturnType<typeof vi.fn>
  beforeEach(() => {
    initAllHermesTables()
    workspace = mkdtempSync(join(tmpdir(), 'native-usage-'))
    sessionId = `chat-${workspace}`
    manager = new CodingAgentRunManager()
    emitted = vi.fn()
    ;(manager as any).emitToChat = emitted
    child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      exitCode: null, signalCode: null, kill: vi.fn(),
    })
    vi.mocked(spawn).mockReturnValue(child)
  })
  afterEach(async () => {
    child.exitCode = 0
    manager.shutdown()
    await new Promise(resolve => setImmediate(resolve))
    rmSync(workspace, { recursive: true, force: true })
    vi.clearAllMocks()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })
  function start(agentId: string, mode: 'global' | 'scoped' = 'global') {
    manager.start({
      agentSessionId: sessionId, sessionId, agentId, mode,
      profile: sessionId, provider: mode === 'global' ? 'global' : 'test', model: '', command: agentId,
      args: agentId === 'pi' ? ['--mode', 'rpc'] : [], shellCommand: agentId,
      workspaceDir: workspace, env: { GROK_HOME: workspace, CODEX_HOME: workspace, OPENCODE_DB: join(workspace, 'opencode.db') },
    })
    manager.send(sessionId, 'usage audit')
  }
  function emit(event: unknown) { child.stdout.write(`${JSON.stringify(event)}\n`) }
  function close(code = 0) {
    child.exitCode = code
    child.emit('exit', code)
    child.emit('close', code)
  }

  it.each(['codex', 'claude-code', 'grok', 'cursor'])('settles %s output once even when native accounting throws', async agent => {
    start(agent)
    vi.spyOn(NativeTurnUsage.prototype, 'rows').mockImplementation(() => { throw new Error('bad native usage') })
    const usage = { input_tokens: 10, output_tokens: 2 }
    const events: Record<string, unknown[]> = {
      codex: [{ type: 'item.completed', item: { id: 'a', type: 'agent_message', text: 'done' } }, { type: 'turn.completed', usage }],
      'claude-code': [{ type: 'assistant', message: { id: 'a', role: 'assistant', content: [{ type: 'text', text: 'done' }] } }, { type: 'result', subtype: 'success', result: 'done', usage }],
      grok: [{ type: 'text', data: 'done' }, { type: 'end', usage }],
      cursor: [{ type: 'assistant', timestamp_ms: 1, message: { content: [{ type: 'text', text: 'done' }] } }, { type: 'result', subtype: 'success', result: 'done', usage }],
    }
    for (const event of events[agent]) emit(event)
    close()
    await vi.waitFor(() => expect(emitted.mock.calls.filter(([, event]) => event === 'run.completed')).toHaveLength(1))
    expect(emitted.mock.calls.filter(([, event]) => event === 'run.failed')).toHaveLength(0)
    expect(getSessionDetail(sessionId)?.messages.filter(message => message.role === 'assistant').at(-1)?.content).toBe('done')
  })

  it('still stops and removes the run when cancellation accounting throws', () => {
    start('claude-code')
    vi.spyOn(NativeTurnUsage.prototype, 'rows').mockImplementation(() => { throw new Error('bad native usage') })
    expect(manager.stop(sessionId)).toBe(true)
    expect(manager.getRunInfo(sessionId)).toBeNull()
    expect(emitted.mock.calls.filter(([, event]) => event === 'run.failed')).toHaveLength(1)
  })

  it('keeps scoped chat output intact when a provider returns malformed usage', async () => {
    start('codex', 'scoped')
    expect(() => manager.handleProxyUsageEvent(sessionId, { type: 'response.completed', data: { response: {
      id: 'bad-usage', usage: { input_tokens: { valueOf: null, toString: null }, output_tokens: 2 },
    } } } as any)).not.toThrow()
    emit({ type: 'item.completed', item: { id: 'a', type: 'agent_message', text: 'done' } })
    emit({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } })
    close()
    await vi.waitFor(() => expect(emitted.mock.calls.filter(([, event]) => event === 'run.completed')).toHaveLength(1))
    expect(getSessionDetail(sessionId)?.messages.filter(message => message.role === 'assistant').at(-1)?.content).toBe('done')
    expect(getRecordedUsageTotals(sessionId, 'coding_agent').apiCalls).toBe(0)
  })

  it('releases Codex completion and permits the next turn when usage discovery never resolves', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    vi.spyOn(nativeModel, 'findRollout').mockImplementation(() => new Promise(() => {}))
    start('codex')
    emit({ type: 'thread.started', thread_id: 'native-thread' })
    emit({ type: 'item.completed', item: { id: 'a', type: 'agent_message', text: 'done' } })
    emit({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } })
    close()
    expect(() => manager.send(sessionId, 'too early')).toThrow('still completing')
    await vi.advanceTimersByTimeAsync(2_500)
    await vi.waitFor(() => expect(emitted.mock.calls.filter(([, event]) => event === 'run.completed')).toHaveLength(1))
    expect(getSessionDetail(sessionId)?.messages.filter(message => message.role === 'assistant').at(-1)?.content).toBe('done')
    child.exitCode = null
    expect(() => manager.send(sessionId, 'next')).not.toThrow()
  })

  it.each(['cursor', 'codex', 'pi', 'claude-code', 'claude', 'claude_code', 'grok', 'opencode', 'dsh'])('hydrates %s session summaries from cumulative native usage across turns and models', agent => {
    // Workflow sessions use the same native ledger, despite having a different source.
    createSession({ id: sessionId, profile: sessionId, source: 'workflow', agent, title: 'Ledger regression' })
    expect(getSession(sessionId)?.input_tokens).toBe(0)
    updateUsage(sessionId, { runId: 'one', source: 'coding_agent', agent, inputTokens: 24_003, outputTokens: 474, cacheReadTokens: 20_736, model: 'first' })
    updateUsage(sessionId, { runId: 'two', source: 'coding_agent', agent, inputTokens: 100, outputTokens: 20, cacheReadTokens: 50, cacheWriteTokens: 5, model: 'second' })
    // A different accounting source must not inflate native usage.
    updateUsage(sessionId, { source: 'hermes', inputTokens: 9999, outputTokens: 9999 })
    const expected = { input_tokens: 24_103, output_tokens: 494, cache_read_tokens: 20_786, cache_write_tokens: 5 }
    expect(getSession(sessionId)).toMatchObject(expected)
    expect(getSessionDetail(sessionId)).toMatchObject(expected)
    expect(getSessionDetailPaginated(sessionId)?.session).toMatchObject(expected)
    expect(listSessions(sessionId)).toEqual([expect.objectContaining(expected)])
    expect(searchSessions(sessionId, '')).toEqual([expect.objectContaining(expected)])
    expect(searchSessions(sessionId, 'Ledger')).toEqual([expect.objectContaining(expected)])
    const otherId = `${sessionId}-other`
    createSession({ id: otherId, profile: sessionId, source: 'coding_agent', agent })
    updateUsage(otherId, { runId: 'one', source: 'coding_agent', agent, inputTokens: 900_000, outputTokens: 10_000, cacheReadTokens: 500_000, model: 'first' })
    // Batch reads must group by session, even for the same agent, profile and model.
    const summaries = listSessions(sessionId)
    expect(summaries.find(row => row.id === sessionId)).toMatchObject(expected)
    expect(summaries.find(row => row.id === otherId)).toMatchObject({ input_tokens: 900_000, output_tokens: 10_000, cache_read_tokens: 500_000 })
    // Hermes still owns its existing summary fields.
    const hermesId = `${sessionId}-hermes`
    createSession({ id: hermesId, profile: sessionId, source: 'cli', agent: 'hermes' })
    updateUsage(hermesId, { source: 'hermes', inputTokens: 123, outputTokens: 45 })
    expect(getSession(hermesId)?.input_tokens).toBe(0)
  })

  it('preserves Cursor deltas, records native model/cache usage once, and keeps context unknown', async () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(1000)
    start('cursor')
    emit({ type: 'system', subtype: 'init', session_id: 'cursor-native', model: 'Cursor native model' })
    const text = 'abcdefghijklmnop'
    for (const timestamp_ms of [1, 2]) {
      emit({ type: 'assistant', timestamp_ms, message: { content: [{ type: 'text', text }] } })
    }
    // Buffered and final flushes must not replay the already appended deltas.
    emit({ type: 'assistant', timestamp_ms: 3, model_call_id: 'call', message: { content: [{ type: 'text', text: text + text }] } })
    emit({ type: 'assistant', message: { content: [{ type: 'text', text: text + text }] } })
    const result = { type: 'result', subtype: 'success', session_id: 'cursor-native', result: text + text,
      duration_api_ms: 2000, duration_ms: 10000,
      usage: { inputTokens: 123, outputTokens: 45, cacheReadTokens: 67, cacheWriteTokens: 8 } }
    clock.mockReturnValue(11000)
    emit(result)
    emit(result)
    close()
    await vi.waitFor(() => expect(getUsage(sessionId)?.model).toBe('Cursor native model'))
    expect(getRecordedUsageTotals(sessionId, 'coding_agent')).toMatchObject({ inputTokens: 123, outputTokens: 45, cacheReadTokens: 67, cacheWriteTokens: 8 })
    expect(getSession(sessionId)).toMatchObject({ input_tokens: 123, output_tokens: 45, cache_read_tokens: 67, cache_write_tokens: 8 })
    expect(getSessionDetail(sessionId)?.messages.filter(message => message.role === 'assistant').at(-1)?.content).toBe(text + text)
    expect(manager.getRunInfo(sessionId)?.model).toBe('Cursor native model')
    expect(emitted.mock.calls.some(([, event, payload]) => event === 'usage.updated' && payload.contextTokens != null)).toBe(false)
    await vi.waitFor(() => expect(emitted).toHaveBeenCalledWith(sessionId, 'run.completed', expect.objectContaining({
      run_usage: expect.objectContaining({ tokensPerSecond: 22.5, speedSource: 'model' }),
    })))
  })

  it('does not record made-up zero usage for older Cursor results without tokens', async () => {
    start('cursor')
    emit({ type: 'result', subtype: 'success', session_id: 'cursor-old', result: '', duration_ms: 10 })
    close()
    await new Promise(resolve => setImmediate(resolve))
    expect(getUsage(sessionId)).toBeUndefined()
  })

  it('keeps Cursor native explicit USD cost alongside measured tokens', async () => {
    start('cursor')
    emit({ type: 'result', subtype: 'success', session_id: 'cursor-cost', result: 'done',
      actual_cost_usd: 0.12, usage: { inputTokens: 10, outputTokens: 5 } })
    close()
    await vi.waitFor(() => expect(getLocalUsageStats(sessionId).cost).toBeCloseTo(0.12))
    expect(getLocalUsageStats(sessionId).cost_coverage).toEqual({ reported: 1, estimated: 0, unknown: 0 })
  })

  it('attributes Codex requests to each resumed run and includes compression without replaying cumulative totals', async () => {
    start('codex')
    const dir = join(workspace, 'sessions', '2026', '10', '01')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'rollout-native-thread.jsonl')
    const events: any[] = [{ type: 'session_meta', payload: { id: 'native-thread', model_provider: 'openai' } }]
    const turn = (id: string, counts: number[]) => {
      const timestamp = new Date().toISOString()
      events.push({ type: 'event_msg', timestamp, payload: { type: 'task_started', turn_id: id } },
        { type: 'turn_context', timestamp, payload: { model: 'actual-model' } })
      let total = 0
      counts.forEach((input, index) => {
        total += input
        events.push({ type: 'token_usage_record', timestamp, payload: { thread_id: 'native-thread', turn_id: id,
          response_id: `${id}-${index}`, usage: { input_tokens: input, output_tokens: 2, cached_input_tokens: 5 },
          turn_token_usage: { input_tokens: total, output_tokens: (index + 1) * 2, cached_input_tokens: (index + 1) * 5 } } })
      })
      writeFileSync(file, events.map(row => JSON.stringify(row)).join('\n'))
      emit({ type: 'thread.started', thread_id: 'native-thread' })
      emit({ type: 'turn.completed', usage: { input_tokens: 999999, output_tokens: 999 } })
      close()
    }
    turn('first', [10])
    await vi.waitFor(() => expect(getRecordedUsageTotals(sessionId, 'coding_agent').apiCalls).toBe(1))
    await new Promise(resolve => setTimeout(resolve, 2))
    child.exitCode = null
    manager.send(sessionId, 'next')
    turn('second', [20, 30])
    await vi.waitFor(() => expect(getRecordedUsageTotals(sessionId, 'coding_agent').apiCalls).toBe(3))
    expect(getRecordedUsageTotals(sessionId, 'coding_agent')).toMatchObject({ inputTokens: 45, outputTokens: 6, cacheReadTokens: 15 })
    expect(emitted).toHaveBeenCalledWith(sessionId, 'run.completed', expect.objectContaining({
      run_usage: expect.objectContaining({ inputTokens: 50, outputTokens: 4 }),
    }))
  })

  it.each(['response.failed', 'response.incomplete'] as const)('retains measured scoped usage on %s and deduplicates terminal events', type => {
    start('codex', 'scoped')
    const data = { response: { id: 'request-error', usage: { input_tokens: 20, output_tokens: 4, input_tokens_details: { cached_tokens: 10 } } } }
    manager.handleProxyUsageEvent(sessionId, { type, data } as any)
    manager.handleProxyUsageEvent(sessionId, { type: 'response.completed', data } as any)
    expect(getRecordedUsageTotals(sessionId, 'coding_agent')).toMatchObject({ inputTokens: 10, outputTokens: 4, cacheReadTokens: 10, apiCalls: 1 })
  })

  it('identifies Cursor when its executable is missing', async () => {
    start('cursor')
    child.emit('error', Object.assign(new Error('missing'), { code: 'ENOENT' }))
    close(1)
    await vi.waitFor(() => expect(emitted).toHaveBeenCalledWith(sessionId, 'run.failed', expect.objectContaining({
      error: expect.stringContaining('Cursor is not installed'),
    })))
  })

  it.each(['codex', 'pi', 'claude-code', 'grok'] as const)('records captured %s events with model attribution', async agentId => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(1000)
    start(agentId)
    if (agentId === 'codex') {
      const dir = join(workspace, 'sessions', '2026', '09', '11')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'rollout-test-native-thread.jsonl'), [
        { type: 'session_meta', payload: { id: 'native-thread', model_provider: 'openai' } },
        { type: 'turn_context', timestamp: '2020-01-01T00:00:00Z', payload: { model: 'old-model' } },
        { type: 'turn_context', timestamp: new Date().toISOString(), payload: { model: 'gpt-6-astra' } },
      ].map(row => JSON.stringify(row)).join('\n'))
      emit({ type: 'thread.started', thread_id: 'native-thread' })
    }
    clock.mockReturnValue(6000)
    if (agentId !== 'claude-code') emit({
      codex: { type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: 'done' } },
      pi: { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'done' } },
      grok: { type: 'text', data: 'done' },
    }[agentId])
    for (const event of fixtures[agentId]) {
      emit(event)
      if (agentId === 'claude-code' && (event as any).event?.type === 'message_start') {
        emit({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } })
        emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } } })
      }
    }
    close()
    await vi.waitFor(() => expect(getUsage(sessionId)?.model).toBe({ codex: 'gpt-6-astra', pi: 'glm-5-turbo', 'claude-code': 'glm-5.1', grok: 'grok-4.6-build' }[agentId]))
    expect(getRecordedUsageTotals(sessionId, 'coding_agent')).toMatchObject({
      codex: { inputTokens: 4855, outputTokens: 5, cacheReadTokens: 12928 },
      pi: { inputTokens: 450, outputTokens: 33, reasoningTokens: 29, apiCalls: 1 },
      'claude-code': { inputTokens: 1203, outputTokens: 3, cacheReadTokens: 4160, apiCalls: 1 },
      grok: { inputTokens: 16950, outputTokens: 42, cacheReadTokens: 640, reasoningTokens: 37, apiCalls: 1 },
    }[agentId])
    const costStats = getLocalUsageStats(sessionId, 1)
    if (agentId === 'claude-code' || agentId === 'grok') {
      expect(costStats.cost).toBeCloseTo(agentId === 'claude-code' ? 0.01027 : 0.00586024)
      expect(costStats.cost_coverage).toEqual({ reported: 0, estimated: 1, unknown: 0 })
    } else {
      expect(costStats.cost_coverage?.unknown).toBe(1)
    }
    await vi.waitFor(() => expect(emitted).toHaveBeenCalledWith(sessionId, 'usage.updated', expect.objectContaining({
      contextTokens: { codex: 17788, pi: 483, 'claude-code': 5366, grok: 17632 }[agentId],
    })))
    const speed = { codex: 1, pi: 6.6, 'claude-code': 0.6, grok: 8.4 }[agentId]
    await vi.waitFor(() => expect(emitted).toHaveBeenCalledWith(sessionId, 'run.completed', expect.objectContaining({
      run_usage: expect.objectContaining({ tokensPerSecond: speed, speedSource: 'estimated' }),
    })))
    const completed = emitted.mock.calls.find(([, event]) => event === 'run.completed')![2].run_usage
    expect(withRunUsage(sessionId, [{ id: completed.assistantMessageId, role: 'assistant' }])[0])
      .toHaveProperty('run_usage', completed)
  })

  it.each(['pi', 'claude-code', 'grok', 'codex'] as const)('%s scoped usage still comes only from the proxy', async agentId => {
    start(agentId, 'scoped')
    manager.handleProxyUsageEvent(sessionId, { type: 'response.completed', data: { response: { id: 'proxy-1', model: 'proxy-model', usage: { input_tokens: 12, output_tokens: 3, cost: 0.001 } } } }, 0.5)
    for (const event of fixtures[agentId]) emit(event)
    close()
    expect(getRecordedUsageTotals(sessionId, 'coding_agent')).toMatchObject({ inputTokens: 12, outputTokens: 3, apiCalls: 1 })
    expect(getUsage(sessionId)?.model).toBe('proxy-model')
    expect(getLocalUsageStats(sessionId, 1)).toMatchObject({ cost: 0.001, cost_coverage: { reported: 1, estimated: 0, unknown: 0 } })
    await vi.waitFor(() => expect(emitted).toHaveBeenCalledWith(sessionId, 'run.completed', expect.objectContaining({
      run_usage: expect.objectContaining({ tokensPerSecond: 6, speedSource: 'model' }),
    })))
  })

  it('does not duplicate Pi messages repeated in delivery or terminal events, and resets for another turn', () => {
    start('pi')
    const message = fixtures.pi[0]
    emit(message)
    emit(message)
    // Usage is durable before settlement, including when a user stops here.
    expect(getRecordedUsageTotals(sessionId, 'coding_agent')).toMatchObject({ inputTokens: 450, apiCalls: 1 })
    emit({ type: 'turn_end', message: message.message })
    emit({ type: 'agent_end', messages: [message.message] })
    emit({ type: 'agent_settled' })
    emit({ type: 'agent_settled' })
    expect(getRecordedUsageTotals(sessionId, 'coding_agent')).toMatchObject({ inputTokens: 450, apiCalls: 1 })
    manager.send(sessionId, 'next')
    emit({ type: 'message_end', message: { ...message.message, model: 'second-model', timestamp: 999, usage: { input: 5, output: 2 } } })
    emit({ type: 'agent_settled' })
    expect(getRecordedUsageTotals(sessionId, 'coding_agent')).toMatchObject({ inputTokens: 455, outputTokens: 35, apiCalls: 2 })
    expect(getUsage(sessionId)?.model).toBe('second-model')
  })

  it.each(['global', 'scoped'] as const)('includes cumulative Pi %s usage in each terminal event before deferred refresh', mode => {
    vi.spyOn(manager as any, 'refreshCodingAgentUsage').mockImplementation(() => new Promise(() => {}))
    updateUsage(sessionId, { source: 'hermes', inputTokens: 9999, outputTokens: 9999 })
    for (const index of [1, 2]) {
      if (index === 2) {
        child = Object.assign(new EventEmitter(), {
          stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
          exitCode: null, signalCode: null, kill: vi.fn(),
        })
        vi.mocked(spawn).mockReturnValue(child)
      }
      start('pi', mode)
      if (mode === 'scoped') manager.handleProxyUsageEvent(sessionId, { type: 'response.completed', data: { response: {
        id: `proxy-${index}`, usage: { input_tokens: 15, output_tokens: 2, input_tokens_details: { cached_tokens: 5 } },
      } } } as any)
      const message = { type: 'message_end', message: {
        id: `message-${index}`, role: 'assistant', model: 'pi-model', provider: 'test',
        content: [{ type: 'text', text: 'done' }], usage: { input: 10, output: 2, cacheRead: 5 },
      } }
      emit(message)
      emit(message)
      emit({ type: 'agent_settled' })
      close()
      const completed = emitted.mock.calls.filter(([, event]) => event === 'run.completed')
      expect(completed).toHaveLength(index)
      expect(completed.at(-1)![2]).toMatchObject({
        inputTokens: 10 * index, outputTokens: 2 * index, cacheReadTokens: 5 * index, cacheWriteTokens: 0,
      })
      expect(getRecordedUsageTotals(sessionId, 'coding_agent').apiCalls).toBe(index)
      expect(manager.hasSession(sessionId)).toBe(false)
    }
  })

  it.each(['error', 'stop', 'queue'] as const)('includes measured Pi usage when a turn ends with %s', async outcome => {
    start('pi')
    emit({ type: 'message_end', message: { role: 'assistant', model: 'pi-model',
      content: [{ type: 'text', text: 'partial' }], usage: { input: 10, output: 2, cacheRead: 5, cacheWrite: 3 },
      ...(outcome === 'error' ? { stopReason: 'error', errorMessage: 'provider failure' } : {}),
    } })
    if (outcome === 'error') { emit({ type: 'agent_settled' }); close() }
    if (outcome === 'stop') manager.stop(sessionId)
    if (outcome === 'queue') {
      const interrupted = manager.interruptForQueueInsertion(sessionId)
      close()
      await interrupted
    }
    expect(emitted.mock.calls.filter(([, event]) => event === 'run.failed')).toHaveLength(1)
    expect(emitted).toHaveBeenCalledWith(sessionId, 'run.failed', expect.objectContaining({
      inputTokens: 10, outputTokens: 2, cacheReadTokens: 5, cacheWriteTokens: 3,
    }))
  })

  it('leaves missing Pi usage unknown in the terminal event', () => {
    start('pi')
    emit({ type: 'agent_settled' })
    close()
    const completed = emitted.mock.calls.find(([, event]) => event === 'run.completed')![2]
    expect(completed).not.toHaveProperty('inputTokens')
  })

  it('still completes Pi when the terminal cumulative usage read throws', () => {
    start('pi')
    emit(fixtures.pi[0])
    vi.spyOn(usageLedger, 'getRecordedUsageTotals').mockImplementation(() => { throw new Error('ledger unavailable') })
    emit({ type: 'agent_settled' })
    close()
    const completed = emitted.mock.calls.filter(([, event]) => event === 'run.completed')
    expect(completed).toHaveLength(1)
    expect(completed[0][2]).not.toHaveProperty('inputTokens')
    expect(manager.hasSession(sessionId)).toBe(false)
  })

  it('retains all completed Grok response usage on error, without counting a final aggregate twice', () => {
    start('grok')
    emit({ type: 'usage', messageId: 'one', usage: { input_tokens: 10, output_tokens: 2 } })
    emit({ type: 'usage', messageId: 'one', usage: { input_tokens: 10, output_tokens: 2 } })
    emit({ type: 'usage', messageId: 'two', usage: { input_tokens: 20, output_tokens: 3 } })
    emit({ type: 'error', message: 'upstream failed' })
    close(1)
    expect(getRecordedUsageTotals(sessionId, 'coding_agent')).toMatchObject({ inputTokens: 30, outputTokens: 5 })
  })

  it.each(['claude-code', 'grok'])('persists measured %s calls when cancelled before a final result', agent => {
    start(agent)
    if (agent === 'claude-code') {
      emit({ type: 'stream_event', event: { type: 'message_start', message: {
        id: 'finished-call', model: 'actual', usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 20 },
      } } })
      emit({ type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 5 } } })
    } else emit({ type: 'usage', messageId: 'finished-call', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 20 } })
    manager.stop(sessionId)
    close()
    expect(getRecordedUsageTotals(sessionId, 'coding_agent')).toMatchObject({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 20, apiCalls: 1 })
  })

  it('waits for native Codex stdout to drain and retains measured usage on a failed exit', () => {
    start('codex')
    child.exitCode = 1
    child.emit('exit', 1)
    expect(getUsage(sessionId)).toBeUndefined()
    emit({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2, cached_input_tokens: 4 } })
    emit({ type: 'turn.failed', error: { message: 'native failure' } })
    expect(getUsage(sessionId)).toBeUndefined()
    child.emit('close', 1)
    expect(getRecordedUsageTotals(sessionId, 'coding_agent')).toMatchObject({ inputTokens: 6, outputTokens: 2, cacheReadTokens: 4 })
  })

  it('splits a Grok turn across models and preserves explicit model call counts', () => {
    start('grok')
    emit({ type: 'end', usage: { input_tokens: 30, output_tokens: 5 }, modelUsage: {
      first: { inputTokens: 10, outputTokens: 2, modelCalls: 1 },
      second: { inputTokens: 20, outputTokens: 3, modelCalls: 2 },
    } })
    close()
    expect(getRecordedUsageTotals(sessionId, 'coding_agent')).toMatchObject({ inputTokens: 30, outputTokens: 5, apiCalls: 3 })
    expect(getLocalUsageStats(sessionId).by_model).toEqual(expect.arrayContaining([
      expect.objectContaining({ model: 'first', input_tokens: 10 }),
      expect.objectContaining({ model: 'second', input_tokens: 20 }),
    ]))
  })

  it.each(['codex', 'pi', 'claude-code', 'grok', 'cursor', 'opencode'] as const)(
    'deducts overlapping native %s tools once, including failed tools', async agent => {
      const wallStart = Date.now()
      const clock = vi.spyOn(performance, 'now').mockReturnValue(1000)
      const wall = vi.spyOn(Date, 'now').mockReturnValue(wallStart)
      const at = (seconds: number) => { clock.mockReturnValue(1000 + seconds * 1000); wall.mockReturnValue(wallStart + seconds * 1000) }
      start(agent)
      const begin = (id: string) => {
        if (agent === 'codex') emit({ type: 'item.started', item: { id, type: 'mcp_tool_call', tool: 'read_file', arguments: {} } })
        if (agent === 'pi') emit({ type: 'tool_execution_start', toolCallId: id, toolName: 'read_file', args: {} })
        if (agent === 'claude-code') emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'read_file', input: {} }] } })
        if (agent === 'grok') emit({ type: 'tool_call', toolCallId: id, toolName: 'read_file', rawInput: {} })
        if (agent === 'cursor') emit({ type: 'tool_call', subtype: 'started', call_id: id, tool_call: { function: { name: 'read_file', arguments: '{}' } } })
      }
      const end = (id: string, from: number, to: number, failed: boolean) => {
        if (agent === 'codex') emit({ type: 'item.completed', item: { id, type: 'mcp_tool_call', tool: 'read_file', output: 'done', ...(failed ? { error: { message: 'failed' } } : {}) } })
        if (agent === 'pi') emit({ type: 'tool_execution_end', toolCallId: id, result: 'done', isError: failed })
        if (agent === 'claude-code') emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'done', is_error: failed }] } })
        if (agent === 'grok') emit({ type: 'tool_call_update', toolCallId: id, status: failed ? 'failed' : 'completed', rawOutput: 'done' })
        if (agent === 'cursor') emit({ type: 'tool_call', subtype: 'completed', call_id: id, tool_call: { function: { name: 'read_file', result: failed ? { error: 'failed' } : 'done' } } })
        if (agent === 'opencode') emit({ type: 'tool_use', part: { type: 'tool', callID: id, tool: 'read_file', state: { status: failed ? 'error' : 'completed', output: 'done', time: { start: wallStart + from * 1000, end: wallStart + to * 1000 } } } })
      }
      at(2); begin('a')
      at(3); begin('b')
      at(5); end('a', 2, 5, false)
      at(7); end('b', 3, 7, true)
      at(10)
      const usage = { input_tokens: 10, output_tokens: 20 }
      if (agent === 'codex') { emit({ type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: 'done' } }); emit({ type: 'turn.completed', usage }) }
      if (agent === 'pi') { emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], usage: { input: 10, output: 20 } } }); emit({ type: 'agent_settled' }) }
      if (agent === 'claude-code') emit({ type: 'result', result: 'done', usage })
      if (agent === 'grok') { emit({ type: 'text', data: 'done' }); emit({ type: 'end', usage }) }
      if (agent === 'cursor') { emit({ type: 'assistant', timestamp_ms: wallStart + 10000, message: { content: [{ type: 'text', text: 'done' }] } }); emit({ type: 'result', result: 'done', usage }) }
      if (agent === 'opencode') { emit({ type: 'text', part: { type: 'text', text: 'done' } }); emit({ type: 'step_finish', part: { type: 'step-finish', id: 'step', tokens: { input: 10, output: 20 } } }) }
      close()
      await vi.waitFor(() => expect(emitted).toHaveBeenCalledWith(sessionId, 'run.completed', expect.objectContaining({
        run_usage: expect.objectContaining({ outputTokens: 20, tokensPerSecond: 4, speedSource: 'estimated' }),
      })))
      const completed = emitted.mock.calls.find(([, event]) => event === 'run.completed')![2].run_usage
      expect(withRunUsage(sessionId, [{ id: completed.assistantMessageId, role: 'assistant' }])[0]).toHaveProperty('run_usage', completed)
    },
  )

  it('excludes Claude argument generation from tool time', async () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(1000)
    start('claude-code')
    const stream = (event: unknown) => emit({ type: 'stream_event', event })
    stream({ type: 'message_start', message: { id: 'model-call' } })
    clock.mockReturnValue(2000)
    stream({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'a', name: 'read_file' } })
    clock.mockReturnValue(3000)
    stream({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":"file"}' } })
    stream({ type: 'content_block_stop', index: 0 })
    clock.mockReturnValue(4000)
    stream({ type: 'message_stop' })
    clock.mockReturnValue(7000)
    emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'done' }] } })
    clock.mockReturnValue(11000)
    emit({ type: 'result', result: 'done', usage: { input_tokens: 10, output_tokens: 70 } })
    close()
    await vi.waitFor(() => expect(emitted).toHaveBeenCalledWith(sessionId, 'run.completed', expect.objectContaining({
      run_usage: expect.objectContaining({ tokensPerSecond: 10, speedSource: 'estimated' }),
    }))) // 70 / (10 - 3), keeping the 3 seconds before message_stop in the denominator
  })

  it('uses the exact OpenCode assistant message model and leaves other sessions alone', () => {
    const db = new DatabaseSync(join(workspace, 'opencode.db'))
    db.exec('CREATE TABLE message (id TEXT, session_id TEXT, data TEXT)')
    db.prepare('INSERT INTO message VALUES (?, ?, ?)').run('msg', 'native-session', JSON.stringify({ role: 'assistant', modelID: 'actual-model', providerID: 'actual-provider' }))
    db.close()
    start('opencode')
    const event = { type: 'step_finish', sessionID: 'native-session', part: { id: 'step', messageID: 'msg', type: 'step-finish', tokens: { input: 10, output: 2 } } }
    emit(event)
    emit(event)
    close()
    expect(getUsage(sessionId)?.model).toBe('actual-model')
    expect(getRecordedUsageTotals(sessionId, 'coding_agent')).toMatchObject({ inputTokens: 10, outputTokens: 2, apiCalls: 1 })
  })
})
