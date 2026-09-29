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
import { initAllHermesTables } from '../../packages/server/src/modules/studio/infrastructure/database/schemas'
import { getRecordedUsageTotals, getUsage, getLocalUsageStats, updateUsage } from '../../packages/server/src/modules/studio/repositories/usage-store'
import { createSession, getSession, getSessionDetail, getSessionDetailPaginated, listSessions, searchSessions } from '../../packages/server/src/modules/studio/repositories/session-store'
import fixtures from '../fixtures/coding-agents/global-native-usage.json'

vi.mock('child_process', async importOriginal => ({
  ...await importOriginal<typeof import('child_process')>(), spawn: vi.fn(),
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
      usage: { inputTokens: 123, outputTokens: 45, cacheReadTokens: 67, cacheWriteTokens: 8 } }
    emit(result)
    emit(result)
    close()
    await vi.waitFor(() => expect(getUsage(sessionId)?.model).toBe('Cursor native model'))
    expect(getRecordedUsageTotals(sessionId, 'coding_agent')).toMatchObject({ inputTokens: 123, outputTokens: 45, cacheReadTokens: 67, cacheWriteTokens: 8 })
    expect(getSession(sessionId)).toMatchObject({ input_tokens: 123, output_tokens: 45, cache_read_tokens: 67, cache_write_tokens: 8 })
    expect(getSessionDetail(sessionId)?.messages.filter(message => message.role === 'assistant').at(-1)?.content).toBe(text + text)
    expect(manager.getRunInfo(sessionId)?.model).toBe('Cursor native model')
    expect(emitted.mock.calls.some(([, event, payload]) => event === 'usage.updated' && payload.contextTokens != null)).toBe(false)
  })

  it('does not record made-up zero usage for older Cursor results without tokens', async () => {
    start('cursor')
    emit({ type: 'result', subtype: 'success', session_id: 'cursor-old', result: '', duration_ms: 10 })
    close()
    await new Promise(resolve => setImmediate(resolve))
    expect(getUsage(sessionId)).toBeUndefined()
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
    for (const event of fixtures[agentId]) emit(event)
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
  })

  it.each(['pi', 'claude-code', 'grok', 'codex'] as const)('%s scoped usage still comes only from the proxy', async agentId => {
    start(agentId, 'scoped')
    manager.handleProxyUsageEvent(sessionId, { type: 'response.completed', data: { response: { id: 'proxy-1', model: 'proxy-model', usage: { input_tokens: 12, output_tokens: 3, cost: 0.001 } } } })
    for (const event of fixtures[agentId]) emit(event)
    close()
    expect(getRecordedUsageTotals(sessionId, 'coding_agent')).toMatchObject({ inputTokens: 12, outputTokens: 3, apiCalls: 1 })
    expect(getUsage(sessionId)?.model).toBe('proxy-model')
    expect(getLocalUsageStats(sessionId, 1)).toMatchObject({ cost: 0.001, cost_coverage: { reported: 1, estimated: 0, unknown: 0 } })
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

  it('retains all completed Grok response usage on error, without counting a final aggregate twice', () => {
    start('grok')
    emit({ type: 'usage', messageId: 'one', usage: { input_tokens: 10, output_tokens: 2 } })
    emit({ type: 'usage', messageId: 'one', usage: { input_tokens: 10, output_tokens: 2 } })
    emit({ type: 'usage', messageId: 'two', usage: { input_tokens: 20, output_tokens: 3 } })
    emit({ type: 'error', message: 'upstream failed' })
    close(1)
    expect(getRecordedUsageTotals(sessionId, 'coding_agent')).toMatchObject({ inputTokens: 30, outputTokens: 5 })
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
