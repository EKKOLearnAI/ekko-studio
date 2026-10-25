import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentChatProjection } from '../../packages/server/src/modules/studio/repositories/agent-chat-projection'
import { AgentChatStore } from '../../packages/server/src/modules/studio/repositories/agent-chat-store'
import { AgentExecutionStore } from '../../packages/server/src/modules/studio/repositories/agent-execution-store'
import { SESSIONS_SCHEMA, MESSAGES_SCHEMA } from '../../packages/server/src/modules/studio/infrastructure/database/schemas'
import { AgentChats, type AgentChatSessionCreation } from '../../packages/server/src/modules/studio/services/agents/chats'
import { AgentCoordinator } from '../../packages/server/src/modules/studio/services/agents/coordinator'
import { AgentRegistry } from '../../packages/server/src/modules/studio/services/agents/registry'
import { AgentRunAdmission } from '../../packages/server/src/modules/studio/services/agents/admission'
import { PluginHookRegistry } from '../../packages/server/src/modules/studio/services/events/plugin-hooks'
import { PluginEventBus } from '../../packages/server/src/modules/studio/services/events/plugin-events'
import { createExecutionContext } from '../../packages/server/src/modules/studio/services/context/execution'
import { StudioError, type ExecutionScope } from '../../packages/studio-plugin-sdk/src'
import { AgentChatDelivery } from '../../packages/server/src/modules/studio/services/chat-run/agent-delivery'
import { readAgentChatSummaries, readAgentChatRunSummaries, agentChatOwnerFilter } from '../../packages/server/src/modules/studio/repositories/agent-chat-summary'
import { PluginChatRunStore } from '../../packages/server/src/modules/studio/repositories/plugin-chat-run-store'
import { PluginChatRuns } from '../../packages/server/src/modules/studio/services/chat-run/plugin'
import type { DirectChatRunOptions } from '../../packages/server/src/modules/studio/services/chat-run/direct'
import { PluginCommandStore } from '../../packages/server/src/modules/studio/repositories/plugin-command-store'
import { CommandExecutionScopes } from '../../packages/server/src/modules/studio/services/commands/scopes'
import { AgentContextRuns } from '../../packages/server/src/modules/studio/services/agents/context-runs'
import { OrdinaryAgentChats } from '../../packages/server/src/modules/studio/services/agents/ordinary-chats'
import { OrdinaryAgentChatStore } from '../../packages/server/src/modules/studio/repositories/ordinary-agent-chat-store'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scope: ExecutionScope = { scopeId: 'app', principal: { kind: 'user', id: '7' }, profileId: 'one', surface: 'api', traceId: 'trace' }
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0)) await close() })

function setup(interactions?: ConstructorParameters<typeof AgentChats>[0]['interactions'], prepareRuntime?: ConstructorParameters<typeof AgentChats>[0]['prepareRuntime']) {
  const db = new DatabaseSync(':memory:')
  for (const [table, columns] of [['sessions', SESSIONS_SCHEMA], ['messages', MESSAGES_SCHEMA]] as const) db.exec(`CREATE TABLE ${table} (${Object.entries(columns).map(([name, sql]) => `${name} ${sql}`).join(', ')})`)
  const projection = new AgentChatProjection(db), executions = new AgentExecutionStore(db, projection), store = new AgentChatStore(db)
  const registry = new AgentRegistry(), events = new PluginEventBus(), hooks = new PluginHookRegistry(), logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  let allowed = true, failCreation = false, failDisposal = false
  let held: ReturnType<typeof Promise.withResolvers<void>> | undefined
  const authorize = () => { if (!allowed) throw new StudioError('FORBIDDEN', 'Access revoked') }
  const factory = vi.fn(async () => ({ run: async () => {
    const result = (held?.promise ?? Promise.resolve()).then(() => ({ status: 'completed' as const }))
    return { events: (async function* () {
      yield { type: 'message.delta' as const, producerSequence: 0, messageId: 'm', text: 'Native answer' }
      await result
    })(), result, cancel: async () => { held?.resolve() } }
  }, dispose: async () => { if (failDisposal) throw new Error('Fixture disposal unconfirmed') } }))
  const registration = registry.stage('one', { kind: 'plugin', pluginId: 'test.chats', version: '1.0.0', generation: 'first' }, ['test.chats/agent'])
  registration.register({ id: 'test.chats/agent', name: 'Owned Agent fixture', configSchema: { type: 'object', properties: { cwd: { type: 'string' }, model: { type: 'string' } } },
    capabilities: { text: true, modes: ['global'] }, create: factory })
  registration.commit()
  const context = (current: ExecutionScope, signal: AbortSignal) => createExecutionContext(current, signal, logger, {
    authorize: async () => authorize(), sessions: { get: async () => null }, agents: { list: async profile => registry.list(profile) },
  })
  const coordinator = new AgentCoordinator({ store: executions, registry, events, logger, context, authorize,
    authorizeChat: (scope, instance, sessionId) => chats.authorizeRunTarget(scope, instance, sessionId) })
  const instance = coordinator.createInstance(scope, { agentTypeId: 'test.chats/agent', config: { cwd: '/owned-workspace', model: 'native-model' }, mode: 'global' })
  const createSession = vi.fn((input: AgentChatSessionCreation) => {
    db.prepare(`INSERT INTO sessions (id, profile, source, agent, agent_mode, user_id, studio_user_id, workspace, model, started_at, last_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(input.id, input.profile, input.source, input.agent, input.agent_mode,
      input.user_id, input.studio_user_id, input.workspace ?? null, input.model ?? '', 1, 1)
    if (failCreation) throw new Error('fixture session failure')
  })
  const admission = new AgentRunAdmission(coordinator, hooks, context)
  const chats = new AgentChats({ store, projection, executions, coordinator, admission, registry, authorize, createSession, interactions, prepareRuntime })
  cleanup.push(async () => { await coordinator.close(); chats.close(); events.close(); db.close() })
  const create = (key = 'create') => chats.create(scope, instance.id, { revision: 1, idempotencyKey: key })
  return { db, chats, store, projection, executions, coordinator, admission, instance, registration, factory, createSession, create, registry, authorize,
    revoke() { allowed = false }, fail() { failCreation = true }, recover() { failCreation = false },
    failDisposal() { failDisposal = true },
    hold() { held = Promise.withResolvers<void>() }, release() { held?.resolve(); held = undefined } }
}

it('creates one owned chat and binding without starting the native Agent, including an identical retry', () => {
  const f = setup(), receipt = f.create()
  expect(f.create()).toEqual(receipt)
  expect(f.createSession).toHaveBeenCalledOnce()
  expect(f.factory).not.toHaveBeenCalled()
  expect(f.db.prepare('SELECT * FROM sessions').all()).toMatchObject([{ id: receipt.sessionId, profile: 'one', source: 'coding_agent',
    agent: f.instance.agentTypeId, agent_mode: 'global', studio_user_id: '7', user_id: '7', workspace: '/owned-workspace', model: 'native-model' }])
  expect(f.chats.isBound(receipt.sessionId)).toBe(true)
  expect(f.chats.ownedBinding(scope, receipt.sessionId).instance.id).toBe(f.instance.id)
})

it('adopts the authenticated command input in the canonical transaction and rejects a second Run or forged input row', async () => {
  const f = setup(), chat = f.create(), commands = new PluginCommandStore(f.db), scopes = new CommandExecutionScopes(), controller = new AbortController()
  const input = { sessionId: chat.sessionId, commandId: 'test.chats/native', text: '/native "original"', revision: 'registered', idempotencyKey: 'command' }
  const call = commands.accept(scope, input, () => Number(f.db.prepare("INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, 'command', ?, 1)").run(chat.sessionId, input.text).lastInsertRowid))
  const current = { ...scope, scopeId: call.id, sessionId: chat.sessionId, surface: 'chat' as const }
  scopes.bind(current, call, controller.signal, { instanceId: f.instance.id, instanceRevision: 1 })
  const origin = scopes.origin(current, { instanceId: f.instance.id, instanceRevision: 1 })!
  const follow = vi.fn(), contexts = new AgentContextRuns({ admission: f.admission, chats: f.chats, commands: scopes, executions: f.executions, coordinator: f.coordinator, follow })
  const request = { instanceId: f.instance.id, input: { content: [{ type: 'text' as const, text: 'Plugin parsed native arguments' }] }, idempotencyKey: 'command-run' }
  f.hold()
  const run = await contexts.start(current, request, controller.signal)
  await vi.waitFor(() => expect(f.projection.message(run.id, 'input', 'input')?.id).toBe(call.inputMessageId))
  expect(f.db.prepare("SELECT id, role, content, run_marker FROM messages WHERE session_id=? AND role IN ('user','command')").all(chat.sessionId)).toEqual([
    { id: call.inputMessageId, role: 'command', content: input.text, run_marker: run.id },
  ])
  expect((await contexts.start(current, request, controller.signal)).id).toBe(run.id)
  expect(follow).toHaveBeenCalledWith(expect.objectContaining({ scopeId: call.id, sessionId: chat.sessionId }), chat.sessionId, expect.objectContaining({ id: run.id }), 'command-run')
  await expect(contexts.start(current, { ...request, instanceId: 'other-instance' }, controller.signal)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  await expect(contexts.start({ ...current, runId: run.id }, request, controller.signal)).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' })
  await expect(contexts.start(current, { ...request, commandOrigin: origin } as any, controller.signal)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  const count = f.db.prepare('SELECT count(*) AS n FROM studio_agent_runs').get()!.n
  await expect(f.chats.start(current, chat.sessionId, { content: [{ type: 'text', text: 'Second' }] }, 'second-key', controller.signal, origin)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
  await expect(f.chats.start(current, chat.sessionId, { content: [{ type: 'text', text: 'Forged' }] }, 'forged', controller.signal, { ...origin, messageId: call.inputMessageId! + 999 })).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(f.db.prepare('SELECT count(*) AS n FROM studio_agent_runs').get()!.n).toBe(count)
  expect(f.executions.commands.runs(call.id)).toEqual([run.id])
  f.release(); await f.chats.wait(run.id); controller.abort()
  expect(f.factory).toHaveBeenCalledOnce()
})

it.each([false, true])('cancels only the command-associated queued Run and preserves another active invocation (separate chat: %s)', async separate => {
  const f = setup(), chat = f.create(), calls = new PluginCommandStore(f.db), scopes = new CommandExecutionScopes()
  const contexts = new AgentContextRuns({ admission: f.admission, chats: f.chats, commands: scopes, executions: f.executions, coordinator: f.coordinator })
  const begin = async (key: string, sessionId = chat.sessionId) => {
    const call = calls.accept(scope, { sessionId, commandId: 'test.chats/native', revision: '1', text: '/' + key, idempotencyKey: key },
      () => Number(f.db.prepare("INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, 'command', ?, 1)").run(sessionId, '/' + key).lastInsertRowid))
    const current = { ...scope, scopeId: call.id, sessionId, surface: 'chat' as const }, controller = new AbortController()
    scopes.bind(current, call, controller.signal, { instanceId: f.instance.id, instanceRevision: 1 })
    const run = await contexts.start(current, { instanceId: f.instance.id, input: { content: [{ type: 'text', text: '/' + key }] }, idempotencyKey: key }, controller.signal)
    return { call, scope: current, run, controller }
  }
  f.hold()
  const first = await begin('first')
  await vi.waitFor(() => expect(f.coordinator.get(first.scope, first.run.id).status).toBe('running'))
  calls.finish(first.call.id, 'completed'); first.controller.abort()
  const second = await begin('second', separate ? f.create('other-chat').sessionId : chat.sessionId)
  expect(f.coordinator.get(second.scope, second.run.id).status).toBe('queued')
  await contexts.cancelCommand(second.scope, second.call.id)
  expect(f.coordinator.get(second.scope, second.run.id).status).toBe('cancelled')
  expect(f.coordinator.get(first.scope, first.run.id).status).toBe('running')
  expect(f.db.prepare('SELECT ended_at FROM sessions WHERE id=?').get(chat.sessionId)?.ended_at).toBeNull()
  expect(f.factory).toHaveBeenCalledOnce()
  f.release(); await f.chats.wait(first.run.id)
  first.controller.abort(); second.controller.abort()
})

it('does not report command cleanup as confirmed while its own native lease remains quarantined', async () => {
  const f = setup(), chat = f.create(), calls = new PluginCommandStore(f.db), scopes = new CommandExecutionScopes(), controller = new AbortController()
  const call = calls.accept(scope, { sessionId: chat.sessionId, commandId: 'test.chats/native', revision: '1', text: '/native', idempotencyKey: 'native' },
    () => Number(f.db.prepare("INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, 'command', '/native', 1)").run(chat.sessionId).lastInsertRowid))
  const current = { ...scope, scopeId: call.id, sessionId: chat.sessionId, surface: 'chat' as const }
  scopes.bind(current, call, controller.signal, { instanceId: f.instance.id, instanceRevision: 1 })
  const contexts = new AgentContextRuns({ admission: f.admission, chats: f.chats, commands: scopes, executions: f.executions, coordinator: f.coordinator })
  f.hold()
  const run = await contexts.start(current, { instanceId: f.instance.id, input: { content: [{ type: 'text', text: '/native' }] }, idempotencyKey: 'native' }, controller.signal)
  await vi.waitFor(() => expect(f.coordinator.get(current, run.id).status).toBe('running'))
  f.failDisposal()
  await expect(contexts.cancelCommand(current, call.id)).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
  expect(f.executions.state.leaseForRun(run.id)).toEqual(expect.any(String))
  const next = await f.chats.start(scope, chat.sessionId, { content: [{ type: 'text', text: 'Next' }] }, 'next', new AbortController().signal)
  await f.chats.wait(next.id)
  expect(f.chats.get(scope, chat.sessionId, next.id)).toMatchObject({ status: 'failed', errorCode: 'RUNTIME_UNAVAILABLE' })
  expect(f.factory).toHaveBeenCalledOnce()
  f.release(); controller.abort()
})

it('reads SDK chat receipts from canonical snapshots across retries and reconstruction without another text writer', async () => {
  const f = setup(), chat = f.create(), receipts = new PluginChatRunStore(f.db)
  let observer: DirectChatRunOptions | undefined
  const authorize = (current: ExecutionScope, id: string) => {
    f.chats.ownedBinding(current, id)
    return { user: { id: 7, username: 'owner', role: 'super_admin' }, session: { id, profile: 'one', source: 'coding_agent', agent: f.instance.agentTypeId } } as any
  }
  const deps = { store: receipts, authorize, canonical: (current: ExecutionScope, id: string, runId: string) => f.chats.text(current, id, runId) }
  const service = new PluginChatRuns({ ...deps, server: () => ({ startDirectRun: (_request, options) => {
    observer = options; return { dispose: vi.fn(), dropQueued: vi.fn(), cancel: vi.fn(async () => {}) }
  } }) })
  f.hold()
  const input = { sessionId: chat.sessionId, input: 'Question', idempotencyKey: 'sdk-chat' }
  const receipt = service.start(scope, input, new AbortController().signal)
  const run = await f.chats.start(scope, chat.sessionId, { content: [{ type: 'text', text: 'Question' }] }, 'sdk-canonical', new AbortController().signal)
  observer!.onEvent('run.accepted', { agent_run_id: run.id })
  await vi.waitFor(() => expect(service.get(scope, receipt.id).output).toBe('Native answer'))
  const first = service.get(scope, receipt.id)
  f.executions.appendOutput(run.id, { type: 'message.snapshot', messageId: 'm', producerSequence: 1, text: 'Corrected answer' })
  f.executions.appendOutput(run.id, { type: 'reasoning.delta', messageId: 'm', producerSequence: 2, text: 'Native reasoning' })
  const corrected = service.get(scope, receipt.id)
  expect(corrected).toMatchObject({ output: 'Corrected answer', reasoning: 'Native reasoning', truncated: false })
  expect(corrected.revision).toBeGreaterThan(first.revision)
  observer!.onEvent('message.persisted', { messages: [{ id: 1, role: 'assistant', content: 'Corrected answer' }] })
  observer!.onEvent('message.delta', { delta: 'A transport packet must not create another text writer' })
  expect(service.get(scope, receipt.id).output).toBe('Corrected answer')
  expect(receipts.get(receipt.id)).toMatchObject({ output: '', reasoning: '' })
  f.release(); await f.chats.wait(run.id)
  expect(service.start(scope, input, new AbortController().signal)).toMatchObject({ id: receipt.id, status: 'completed' })
  const rebuilt = new PluginChatRuns({ ...deps, store: new PluginChatRunStore(f.db), server: () => null })
  expect(rebuilt.get(scope, receipt.id)).toMatchObject({ status: 'completed', output: 'Corrected answer', reasoning: 'Native reasoning' })
  expect(() => rebuilt.get({ ...scope, principal: { kind: 'user', id: '8' } }, receipt.id)).toThrow(/execution scope/)
  f.db.prepare('UPDATE sessions SET studio_user_id=? WHERE id=?').run('8', chat.sessionId)
  expect(() => rebuilt.get(scope, receipt.id)).toThrow(/binding/)
  service.close(); rebuilt.close()
})

it('reads managed instance metadata and reports unmeasured usage as unknown without adding a legacy ledger', async () => {
  const f = setup(), chat = f.create()
  expect(readAgentChatSummaries(f.db, [chat.sessionId])[chat.sessionId]).toMatchObject({ agent_instance_id: f.instance.id, agent_instance_revision: 1,
    model: 'native-model', workspace: '/owned-workspace', agent_mode: 'global', agent_usage: { modelCalls: 0, unknownModelCalls: 0, inputTokens: null, outputTokens: null, costUsd: null } })
  const run = await f.chats.start(scope, chat.sessionId, { content: [{ type: 'text', text: 'Question' }] }, 'run', new AbortController().signal)
  await f.chats.wait(run.id)
  const message = f.projection.message(run.id, 'message', 'm')!
  expect(readAgentChatRunSummaries(f.db, chat.sessionId, [String(message.id)])).toMatchObject([{ runId: run.id, assistantMessageId: String(message.id), inputTokens: null, outputTokens: null, costUsd: null }])
  expect(f.db.prepare("SELECT 1 FROM sqlite_master WHERE name='usage'").get()).toBeUndefined()
})

it('reads corrected per-call usage once and preserves partial unknowns across model calls and independent runs', async () => {
  const f = setup(), chat = f.create()
  f.hold()
  const run = await f.chats.start(scope, chat.sessionId, { content: [{ type: 'text', text: 'Question' }] }, 'run', new AbortController().signal)
  await vi.waitFor(() => expect(f.executions.output(run.id).length).toBe(1))
  f.executions.appendOutput(run.id, { type: 'usage.reported', producerSequence: 1, modelCallId: 'native-call', model: 'native-model', mode: 'cumulative', revision: 1, inputTokens: 12, outputTokens: 3 })
  f.executions.appendOutput(run.id, { type: 'usage.reported', producerSequence: 2, modelCallId: 'native-call', model: 'native-model', mode: 'final', revision: 2, inputTokens: 18, outputTokens: 4 })
  expect(readAgentChatSummaries(f.db, [chat.sessionId])[chat.sessionId].agent_usage).toMatchObject({ modelCalls: 1, inputTokens: 18, outputTokens: 4, unknownModelCalls: 0, cacheReadTokens: null })
  const host = { id: 'host-call', runId: run.id, model: 'native-model', revision: 1, status: 'running', usage: null } as any
  f.executions.state.claimHostModelCall(host)
  expect(readAgentChatSummaries(f.db, [chat.sessionId])[chat.sessionId].agent_usage).toMatchObject({ modelCalls: 2, unknownModelCalls: 1, inputTokens: null, outputTokens: null })
  f.executions.state.recordHostModelUsage({ ...host, revision: 2, status: 'completed', usage: { inputTokens: 7, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } })
  const message = f.projection.message(run.id, 'message', 'm')!
  expect(readAgentChatRunSummaries(f.db, chat.sessionId, [String(message.id)])).toEqual([])
  expect(readAgentChatSummaries(f.db, [chat.sessionId])[chat.sessionId].agent_usage).toMatchObject({ inputTokens: 25, outputTokens: 6, cacheReadTokens: null, costUsd: null })
  f.executions.appendOutput(run.id, { type: 'usage.reported', producerSequence: 3, modelCallId: 'native-call', model: 'native-model', mode: 'final',
    revision: 3, inputTokens: 18, outputTokens: 4, cacheReadTokens: 4, cacheWriteTokens: 2, reasoningTokens: 1 })
  expect(readAgentChatRunSummaries(f.db, chat.sessionId, [String(message.id)])).toEqual([])
  expect(readAgentChatSummaries(f.db, [chat.sessionId])[chat.sessionId].agent_usage).toMatchObject({
    inputTokens: 25, outputTokens: 6, cacheReadTokens: 4, cacheWriteTokens: 2, reasoningTokens: 1,
  })
  expect(readAgentChatRunSummaries(f.db, 'other-chat', [String(message.id)])).toEqual([])
  f.release(); await f.chats.wait(run.id)
  expect(readAgentChatRunSummaries(f.db, chat.sessionId, [String(message.id)])[0]).toMatchObject({
    inputTokens: 25, outputTokens: 6, cacheReadTokens: 4, cacheHitRate: 4 / 25, costUsd: null, tokensPerSecond: null,
  })
})

it('includes host cache buckets once in total input and retains reported versus estimated cost corrections', async () => {
  const f = setup(), chat = f.create()
  const run = await f.chats.start(scope, chat.sessionId, { content: [{ type: 'text', text: 'Question' }] }, 'run', new AbortController().signal)
  await f.chats.wait(run.id)
  const host = { id: 'host-call', runId: run.id, model: 'native-model', revision: 1, status: 'completed',
    usage: { inputTokens: 3, outputTokens: 4, cacheReadTokens: 10, cacheWriteTokens: 2, reasoningTokens: 1, costUsd: 0.03, costSource: 'estimated' } } as any
  f.executions.state.claimHostModelCall(host)
  const message = f.projection.message(run.id, 'message', 'm')!
  expect(readAgentChatSummaries(f.db, [chat.sessionId])[chat.sessionId].agent_usage).toMatchObject({ inputTokens: 15, outputTokens: 4, cacheReadTokens: 10, cacheWriteTokens: 2, costUsd: 0.03, estimatedCost: true })
  expect(readAgentChatRunSummaries(f.db, chat.sessionId, [String(message.id)])[0]).toMatchObject({ inputTokens: 15, cacheHitRate: 10 / 15, isEstimated: true })
  f.executions.state.recordHostModelUsage({ ...host, revision: 2, usage: { ...host.usage, inputTokens: 4, cacheReadTokens: 7, cacheWriteTokens: 1, costUsd: 0.02, costSource: 'reported' } })
  expect(readAgentChatRunSummaries(f.db, chat.sessionId, [String(message.id)])[0]).toMatchObject({ inputTokens: 12, cacheHitRate: 7 / 12, costUsd: 0.02, isEstimated: false })
})

it('filters managed ownership before pagination and counting while preserving ordinary profile history', () => {
  const f = setup(), chat = f.create()
  f.db.prepare("INSERT INTO sessions (id, profile, source, agent, started_at, last_active) VALUES ('legacy', 'one', 'cli', 'hermes', 1, 1)").run()
  const visible = (owner: string) => {
    const filter = agentChatOwnerFilter(f.db, owner)!
    return f.db.prepare(`SELECT s.id FROM sessions s WHERE ${filter.sql} ORDER BY s.id`).all(...filter.params).map(row => row.id)
  }
  expect(visible('7')).toEqual([chat.sessionId, 'legacy'].sort())
  expect(visible('8')).toEqual(['legacy'])
  expect(visible('')).toEqual(['legacy'])
  f.db.prepare("UPDATE sessions SET studio_user_id='8' WHERE id=?").run(chat.sessionId)
  expect(visible('7')).toEqual(['legacy'])
  expect(visible('8')).toEqual(['legacy'])
})

it('drains only the changed chat, blocks new admission until release and resets only its conversation checkpoint', async () => {
  const f = setup(), chat = f.create(), other = f.create('other-chat')
  const initial = await f.chats.start(scope, chat.sessionId, { content: [{ type: 'text', text: 'First' }] }, 'initial', new AbortController().signal)
  await f.chats.wait(initial.id)
  f.executions.state.saveCheckpoint(initial.conversationId!, initial.provider, initial.configRevision, initial.id, { nativeId: 'first-chat' })
  const sibling = await f.chats.start(scope, other.sessionId, { content: [{ type: 'text', text: 'Other chat' }] }, 'sibling', new AbortController().signal)
  await f.chats.wait(sibling.id)
  f.executions.state.saveCheckpoint(sibling.conversationId!, sibling.provider, sibling.configRevision, sibling.id, { nativeId: 'sibling-chat' })
  f.hold()
  const active = await f.chats.start(scope, chat.sessionId, { content: [{ type: 'text', text: 'Running' }] }, 'active', new AbortController().signal)
  await vi.waitFor(() => expect(f.executions.get(active.id)?.status).toBe('running'))
  const queued = await f.chats.start(scope, chat.sessionId, { content: [{ type: 'text', text: 'Queued' }] }, 'queued', new AbortController().signal)
  const lease = await f.chats.prepareHistoryChange(scope, chat.sessionId)
  expect(f.executions.get(active.id)?.status).toBe('cancelled')
  expect(f.executions.get(queued.id)?.status).toBe('cancelled')
  expect(f.projection.message(queued.id, 'input', 'input')).toBeUndefined()
  await expect(f.chats.start(scope, chat.sessionId, { content: [{ type: 'text', text: 'Race' }] }, 'race', new AbortController().signal)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
  const unaffected = await f.chats.start(scope, other.sessionId, { content: [{ type: 'text', text: 'Continues' }] }, 'continues', new AbortController().signal)
  await f.chats.wait(unaffected.id)
  lease.reset()
  expect(f.executions.state.checkpoint(initial.conversationId!, initial.provider, initial.configRevision)).toBeUndefined()
  expect(f.executions.state.checkpoint(sibling.conversationId!, sibling.provider, sibling.configRevision)).toEqual({ nativeId: 'sibling-chat' })
  lease.release()
  const next = await f.chats.start(scope, chat.sessionId, { content: [{ type: 'text', text: 'Fresh conversation' }] }, 'fresh', new AbortController().signal)
  await f.chats.wait(next.id)
  expect(next.conversationId).toBe(initial.conversationId)
})

it('retains ownership on a removed chat tombstone without reopening its legacy runtime or exposing old Run output', async () => {
  const f = setup(), chat = f.create()
  const run = await f.chats.start(scope, chat.sessionId, { content: [{ type: 'text', text: 'Question' }] }, 'run', new AbortController().signal)
  await f.chats.wait(run.id)
  f.db.prepare('DELETE FROM sessions WHERE id=?').run(chat.sessionId)
  expect(f.chats.isBound(chat.sessionId)).toBe(true)
  expect(() => f.chats.authorizeRemoval(scope, chat.sessionId)).not.toThrow()
  await expect(f.chats.prepareRemoval({ ...scope, principal: { kind: 'user', id: '8' } }, chat.sessionId)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  expect(() => f.chats.output(scope, chat.sessionId, run.id, -1)).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
  const lease = await f.chats.prepareRemoval(scope, chat.sessionId)
  lease.release()
  expect(f.factory).toHaveBeenCalledOnce()
})

it('rejects self-removal from an executing Run before cancellation or waiting on its own cleanup', async () => {
  const f = setup(), chat = f.create()
  f.hold()
  const run = await f.chats.start(scope, chat.sessionId, { content: [{ type: 'text', text: 'Running' }] }, 'run', new AbortController().signal)
  await vi.waitFor(() => expect(f.executions.get(run.id)?.status).toBe('running'))
  await expect(f.chats.prepareRemoval({ ...scope, runId: run.id }, chat.sessionId)).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' })
  await expect(f.chats.prepareHistoryChange({ ...scope, runId: run.id }, chat.sessionId)).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' })
  expect(f.executions.get(run.id)?.status).toBe('running')
  const userMutation = await f.chats.prepareRemoval(scope, chat.sessionId)
  expect(f.executions.get(run.id)?.status).toBe('cancelled')
  userMutation.release()
})

it('returns an existing receipt after provider removal but rejects a new chat with an unavailable provider', async () => {
  const f = setup(), receipt = f.create()
  await f.registration.dispose()
  expect(f.create()).toEqual(receipt)
  expect(() => f.create('new-key')).toThrow(expect.objectContaining({ code: 'RUNTIME_UNAVAILABLE' }))
  expect(f.createSession).toHaveBeenCalledOnce()
})

it('rolls back the receipt, session and binding if session creation fails, allowing the original key to retry', () => {
  const f = setup()
  f.fail()
  expect(f.create).toThrow('fixture session failure')
  for (const table of ['sessions', 'studio_agent_chat_creations', 'studio_agent_chat_bindings']) expect(f.db.prepare(`SELECT count(*) AS count FROM ${table}`).get()?.count).toBe(0)
  f.recover()
  expect(f.create().sessionId).toEqual(expect.any(String))
  expect(f.db.prepare('SELECT count(*) AS count FROM sessions').get()?.count).toBe(1)
})

it('never accepts owner, target, configuration or scope overrides in chat creation', () => {
  const f = setup()
  for (const value of [{ revision: 0, idempotencyKey: 'key' }, { revision: 1, idempotencyKey: '' }, { revision: 1, idempotencyKey: 'key', ownerId: '8' }]) {
    expect(() => f.chats.create(scope, f.instance.id, value as never)).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }))
  }
  for (const extra of [{ sessionId: 'other' }, { runId: 'other' }, { workspaceId: 'other' }]) {
    expect(() => f.chats.create({ ...scope, ...extra }, f.instance.id, { revision: 1, idempotencyKey: 'key' })).toThrow(expect.objectContaining({ code: 'CAPABILITY_UNSUPPORTED' }))
  }
  expect(() => f.chats.create({ ...scope, principal: { kind: 'service', id: '7' } }, f.instance.id, { revision: 1, idempotencyKey: 'key' })).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
  expect(f.createSession).not.toHaveBeenCalled()
})

it('keeps creation keys and owned bindings within owner/profile and checks the current instance revision', () => {
  const f = setup(), receipt = f.create()
  expect(() => f.chats.create(scope, f.instance.id, { revision: 2, idempotencyKey: 'create' })).toThrow(expect.objectContaining({ code: 'REVISION_CONFLICT' }))
  expect(() => f.chats.create(scope, f.instance.id, { revision: 2, idempotencyKey: 'new-key' })).toThrow(expect.objectContaining({ code: 'REVISION_CONFLICT' }))
  for (const current of [{ ...scope, profileId: 'two' }, { ...scope, principal: { kind: 'user' as const, id: '8' } }]) {
    expect(() => f.chats.ownedBinding(current, receipt.sessionId)).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }))
    expect(() => f.chats.create(current, f.instance.id, { revision: 1, idempotencyKey: 'create' })).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }))
  }
  expect(() => f.chats.ownedBinding({ ...scope, sessionId: 'other' }, receipt.sessionId)).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
  f.revoke()
  expect(f.create).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
  expect(() => f.chats.ownedBinding(scope, receipt.sessionId)).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
})

it('executes through canonical admission and commits exactly one input and answer per Run', async () => {
  const f = setup(), chat = f.create(), input = { content: [{ type: 'text' as const, text: 'User text' }] }, signal = new AbortController().signal
  const first = await f.chats.start(scope, chat.sessionId, input, 'run-key', signal)
  await f.coordinator.wait(first.id)
  expect((await f.chats.start(scope, chat.sessionId, input, 'run-key', signal)).id).toBe(first.id)
  expect(f.factory).toHaveBeenCalledOnce()
  expect(f.db.prepare('SELECT role, content, run_marker FROM messages ORDER BY id').all()).toEqual([
    { role: 'user', content: 'User text', run_marker: first.id }, { role: 'assistant', content: 'Native answer', run_marker: first.id },
  ])
  const other = f.create('other-chat')
  await expect(f.chats.cancel(scope, other.sessionId, first.id)).rejects.toMatchObject({ code: 'FORBIDDEN' })
})

it('keeps queued input durable and materializes it after the previous Run transcript', async () => {
  const f = setup(), chat = f.create(), signal = new AbortController().signal
  f.hold()
  const first = await f.chats.start(scope, chat.sessionId, { content: [{ type: 'text', text: 'First input' }] }, 'first', signal)
  await vi.waitFor(() => expect(f.executions.output(first.id)).toHaveLength(1))
  const second = await f.chats.start(scope, chat.sessionId, { content: [{ type: 'text', text: 'Queued input' }] }, 'second', signal)
  expect(second.status).toBe('queued')
  expect(f.executions.originalInput(second.id)?.content).toEqual([{ type: 'text', text: 'Queued input' }])
  expect(f.db.prepare('SELECT role, content FROM messages ORDER BY id').all()).toEqual([
    { role: 'user', content: 'First input' }, { role: 'assistant', content: 'Native answer' },
  ])
  f.release()
  await f.coordinator.wait(second.id)
  expect(f.db.prepare('SELECT role, content FROM messages ORDER BY id').all()).toEqual([
    { role: 'user', content: 'First input' }, { role: 'assistant', content: 'Native answer' },
    { role: 'user', content: 'Queued input' }, { role: 'assistant', content: 'Native answer' },
  ])
})

it('binds one interactive context to the exact canonical Run and settles it after completion', async () => {
  const finish = vi.fn(), active: Array<() => boolean> = []
  const begin = vi.fn((_session: string, _profile: string, _run: string, isActive: () => boolean) => {
    active.push(isActive)
    return { contextId: 'context-for-run', instructions: 'Current turn instructions', finish }
  })
  const f = setup({ begin }), chat = f.create(), signal = new AbortController()
  f.hold()
  const run = await f.chats.start(scope, chat.sessionId, { content: [{ type: 'text', text: 'Work' }] }, 'run', new AbortController().signal)
  const current = { ...scope, sessionId: chat.sessionId }
  const binding = f.chats.beginNativeTurn(current, f.instance, run.id, signal.signal)
  expect(binding).toMatchObject({ contextId: 'context-for-run', sessionId: chat.sessionId, interactive: true })
  expect(f.chats.beginNativeTurn(current, f.instance, run.id, signal.signal)).toBe(binding)
  expect(begin).toHaveBeenCalledOnce()
  expect(begin.mock.calls[0].slice(0, 3)).toEqual([chat.sessionId, 'one', run.id])
  expect(active[0]()).toBe(true)
  f.release()
  await f.coordinator.wait(run.id)
  expect(active[0]()).toBe(false)
  signal.abort()
  await vi.waitFor(() => expect(finish).toHaveBeenCalledWith('ended'))
})

it('waits for native cancellation before settling a task card and never enables interactive goals for an event origin', async () => {
  const finish = vi.fn(), begin = vi.fn(() => ({ contextId: 'background-context', instructions: 'Plan only', finish }))
  const f = setup({ begin }), chat = f.create(), signal = new AbortController()
  f.hold()
  const run = await f.chats.start({ ...scope, surface: 'event' }, chat.sessionId, { content: [{ type: 'text', text: 'Background work' }] }, 'run', new AbortController().signal)
  expect(f.chats.beginNativeTurn({ ...scope, sessionId: chat.sessionId, surface: 'event' }, f.instance, run.id, signal.signal).interactive).toBe(false)
  expect(begin.mock.calls[0][4]).toBe(false)
  signal.abort()
  await Promise.resolve()
  expect(finish).not.toHaveBeenCalled()
  await f.chats.cancel(scope, chat.sessionId, run.id)
  await vi.waitFor(() => expect(finish).toHaveBeenCalledWith('interrupted'))
})

it('delivers committed rows in Run order with stable ids and queue identity, including cancellation before dispatch', async () => {
  const f = setup(), chat = f.create(), emitted: Array<{ event: string; data: Record<string, any> }> = []
  const delivery = new AgentChatDelivery({ chats: f.chats, emit: (_session, event, data) => emitted.push({ event, data }), activity: vi.fn(), onError: vi.fn() })
  f.hold()
  const first = await f.chats.start(scope, chat.sessionId, { content: [{ type: 'text', text: 'First' }] }, 'first', new AbortController().signal)
  delivery.follow(scope, chat.sessionId, first.id, 'first')
  const second = await f.chats.start(scope, chat.sessionId, { content: [{ type: 'text', text: 'Second' }] }, 'second', new AbortController().signal)
  delivery.follow(scope, chat.sessionId, second.id, 'second')
  await f.chats.cancel(scope, chat.sessionId, second.id)
  delivery.publishQueue(scope, chat.sessionId)
  expect(emitted.filter(item => item.event === 'run.queued').at(-1)?.data.queue_length).toBe(0)
  await vi.waitFor(() => expect(emitted.some(item => item.event === 'message.persisted')).toBe(true))
  f.release()
  await delivery.idle(chat.sessionId)
  expect(emitted.filter(item => ['run.started', 'run.completed', 'abort.completed'].includes(item.event)).map(item => [item.event, item.data.queue_id]))
    .toEqual([['run.started', 'first'], ['run.completed', 'first'], ['abort.completed', 'second']])
  const rows = emitted.filter(item => item.event === 'message.persisted').flatMap(item => item.data.messages)
  expect([...new Map(rows.map(row => [row.id, row])).values()]).toMatchObject([{ role: 'user', content: 'First', run_marker: first.id }, { role: 'assistant', content: 'Native answer', run_marker: first.id }])
  expect(new Set(rows.map(row => row.id)).size).toBe(2)
  expect(rows.at(-1).id).toBe(rows.find(row => row.role === 'assistant').id)
  const delivered = emitted.length
  expect(delivery.follow(scope, chat.sessionId, first.id, 'first')).toBe(false)
  expect(emitted).toHaveLength(delivered)
  delivery.close()
})

it('drains the output cursor after terminal status before emitting completion and rechecks ownership before delivery', async () => {
  const f = setup(), chat = f.create(), emitted = vi.fn(), onError = vi.fn()
  const delivery = new AgentChatDelivery({ chats: f.chats, emit: emitted, activity: vi.fn(), onError })
  f.hold()
  const run = await f.chats.start(scope, chat.sessionId, { content: [{ type: 'text', text: 'One' }] }, 'one', new AbortController().signal)
  await vi.waitFor(() => expect(f.executions.output(run.id).length).toBe(1))
  for (let i = 1; i <= 210; i++) f.executions.appendOutput(run.id, { type: 'message.delta', producerSequence: i, messageId: 'm', text: '.' })
  f.release(); await f.chats.wait(run.id)
  delivery.follow(scope, chat.sessionId, run.id, 'one')
  await delivery.idle(chat.sessionId)
  expect(emitted.mock.calls.filter(call => call[1] === 'message.persisted').at(-1)?.[2]).toMatchObject({ producer_sequence: 210, messages: [{ content: 'Native answer' + '.'.repeat(210) }] })
  expect(emitted.mock.calls.at(-1)?.[1]).toBe('run.completed')
  f.revoke()
  expect(() => delivery.follow(scope, chat.sessionId, run.id, 'one')).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
  expect(onError).not.toHaveBeenCalled()
  delivery.close()
})

it('replays completed retries only to their observer without changing a later Run or rebroadcasting a start', async () => {
  const f = setup(), chat = f.create()
  const first = await f.chats.start(scope, chat.sessionId, { content: [{ type: 'text', text: 'First' }] }, 'first', new AbortController().signal)
  await f.chats.wait(first.id)
  f.hold()
  const second = await f.chats.start(scope, chat.sessionId, { content: [{ type: 'text', text: 'Second' }] }, 'second', new AbortController().signal)
  const broadcast = vi.fn(), activity = vi.fn(), replayed = vi.fn()
  const delivery = new AgentChatDelivery({ chats: f.chats, emit: broadcast, activity, onError: vi.fn() })
  delivery.follow(scope, chat.sessionId, second.id, 'second')
  await vi.waitFor(() => expect(broadcast.mock.calls.some(([, event]) => event === 'run.started')).toBe(true))
  const emitted = broadcast.mock.calls.length, activities = activity.mock.calls.length
  await delivery.replay(scope, chat.sessionId, first.id, 'first', replayed)
  expect(broadcast).toHaveBeenCalledTimes(emitted)
  expect(activity).toHaveBeenCalledTimes(activities)
  expect(replayed.mock.calls.some(([event]) => event === 'run.started')).toBe(false)
  expect(replayed.mock.calls.at(-1)).toMatchObject(['run.completed', { agent_run_id: first.id, replayed: true, terminal: true, queue_remaining: 1 }])
  expect(replayed.mock.calls.filter(([event]) => event === 'message.persisted').every(([, data]) => data.terminal === true)).toBe(true)
  await expect(delivery.replay(scope, chat.sessionId, second.id, 'second', replayed)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
  expect(f.chats.get(scope, chat.sessionId, second.id).status).toBe('running')
  f.release(); await delivery.idle(chat.sessionId); delivery.close()
})

function ordinarySetup() {
  const f = setup(), root = mkdtempSync(join(tmpdir(), 'studio-ordinary-chat-'))
  cleanup.push(async () => { rmSync(root, { recursive: true, force: true }) })
  const store = new OrdinaryAgentChatStore(f.db), ensure = vi.fn(async () => {}), prepare = vi.fn(async (_scope, selection) => ({ model: selection.model }))
  const updateSession = (id: string, settings: any) => {
    f.db.prepare('UPDATE sessions SET model=?, provider=?, workspace=?, reasoning_effort=? WHERE id=?').run(settings.model, settings.provider, settings.workspace, settings.reasoning_effort, id)
  }
  const ordinary = new OrdinaryAgentChats({ store, registry: f.registry, coordinator: f.coordinator, chats: f.chats, authorize: f.authorize,
    ensure, prepare, defaultWorkspace: () => root, updateSession })
  const selection = { sessionId: 'draft-one', agentTypeId: f.instance.agentTypeId, mode: 'global', model: 'native-model' }
  return { ...f, ordinary, ordinaryStore: store, selection, ensure, prepare }
}

it('internally binds concurrent ordinary-chat retries to one isolated instance and canonical transcript', async () => {
  const f = ordinarySetup()
  const [one, retry] = await Promise.all([f.ordinary.create(scope, f.selection), f.ordinary.create(scope, f.selection)])
  expect(one).toEqual(retry)
  expect(one.sessionId).toBe('draft-one')
  expect(f.executions.instances('7', 'one')).toHaveLength(2) // fixture instance plus one chat instance
  const two = await f.ordinary.create(scope, { ...f.selection, sessionId: 'draft-two' })
  expect(two.instanceId).not.toBe(one.instanceId)
  expect(f.factory).not.toHaveBeenCalled()
  const run = await f.chats.start(scope, one.sessionId, { content: [{ type: 'text', text: 'Ordinary input' }] }, 'ordinary-run', new AbortController().signal)
  await f.coordinator.wait(run.id)
  expect(f.factory).toHaveBeenCalledOnce()
  expect(f.db.prepare('SELECT role,content FROM messages WHERE session_id=? ORDER BY id').all(one.sessionId)).toEqual([
    { role: 'user', content: 'Ordinary input' }, { role: 'assistant', content: 'Native answer' },
  ])
  expect(f.chats.summary(scope, one.sessionId)).toMatchObject({ agent_instance_id: one.instanceId, agent_chat_settings: true, model: 'native-model' })
  expect((await f.ordinary.create(scope, f.selection)).sessionId).toBe(one.sessionId)
})

it('rejects ordinary chat identity overrides, reused drafts, history adoption and deleted-chat retries', async () => {
  const f = ordinarySetup(), chat = await f.ordinary.create(scope, f.selection)
  await expect(f.ordinary.create(scope, { ...f.selection, model: 'different' })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
  for (const current of [{ ...scope, profileId: 'two' }, { ...scope, principal: { kind: 'user' as const, id: '8' } }]) {
    await expect(f.ordinary.create(current, f.selection)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  }
  for (const extra of [{ sessionId: 'bound' }, { runId: 'bound' }, { workspaceId: 'bound' }]) {
    await expect(f.ordinary.create({ ...scope, ...extra }, f.selection)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  }
  for (const patch of [{ config: {} }, { ownerId: '8' }, { command: '/untrusted' }, { env: { AUTH_TOKEN: 'secret' } }, { workspace: '../relative' }]) {
    await expect(f.ordinary.create(scope, { ...f.selection, ...patch })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  }
  f.db.prepare("INSERT INTO sessions(id,profile,source,studio_user_id,started_at,last_active) VALUES ('legacy','one','coding_agent','7',1,1)").run()
  await expect(f.ordinary.create(scope, { ...f.selection, sessionId: 'legacy' })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
  f.db.prepare('DELETE FROM sessions WHERE id=?').run(chat.sessionId)
  await expect(f.ordinary.create(scope, f.selection)).rejects.toBeInstanceOf(StudioError)
  expect(f.db.prepare('SELECT count(*) AS n FROM sessions WHERE id=?').get(chat.sessionId)?.n).toBe(0)
})

it('rolls back an ordinary chat instance and receipt with failed session creation and respects late revocation', async () => {
  const f = ordinarySetup()
  f.fail()
  await expect(f.ordinary.create(scope, f.selection)).rejects.toThrow('fixture session failure')
  expect(f.executions.instances('7', 'one')).toHaveLength(1)
  expect(f.ordinaryStore.selection('draft-one')).toBeUndefined()
  f.recover()
  f.ensure.mockImplementationOnce(async () => { f.revoke() })
  await expect(f.ordinary.create(scope, f.selection)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(f.prepare).toHaveBeenCalledOnce()
  expect(f.executions.instances('7', 'one')).toHaveLength(1)
})

it('updates ordinary chat settings through the same instance and refuses to change an active Run', async () => {
  const f = ordinarySetup(), chat = await f.ordinary.create(scope, f.selection)
  await f.ordinary.update(scope, chat.sessionId, { model: 'native-next' })
  expect(f.chats.summary(scope, chat.sessionId)).toMatchObject({ agent_instance_id: chat.instanceId, agent_instance_revision: 2, agent_chat_settings: true, model: 'native-next' })
  expect(f.db.prepare('SELECT model FROM sessions WHERE id=?').get(chat.sessionId)?.model).toBe('native-next')
  expect((await f.ordinary.create(scope, f.selection)).instanceId).toBe(chat.instanceId)
  f.hold()
  const run = await f.chats.start(scope, chat.sessionId, { content: [{ type: 'text', text: 'Active' }] }, 'active', new AbortController().signal)
  await vi.waitFor(() => expect(f.executions.get(run.id)?.status).toBe('running'))
  await expect(f.ordinary.update(scope, chat.sessionId, { model: 'racing' })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
  expect(f.ordinaryStore.selection(chat.sessionId)?.model).toBe('native-next')
  expect(f.executions.instance(chat.instanceId)?.config.model).toBe('native-next')
  f.release(); await f.coordinator.wait(run.id)
})

it('restores the bound profile provider before a continuation and rechecks ownership after activation', async () => {
  let restore: (() => void) | undefined
  const prepare = vi.fn(async () => { restore?.() })
  const f = setup(undefined, prepare), chat = f.create()
  const first = await f.chats.start(scope, chat.sessionId, { content: [{ type: 'text', text: 'First' }] }, 'first', new AbortController().signal)
  await f.chats.wait(first.id)
  f.registration.dispose()
  restore = () => {
    const registration = f.registry.stage('one', first.provider, [f.instance.agentTypeId])
    registration.register({ id: f.instance.agentTypeId, name: 'Restored Agent', configSchema: { type: 'object' }, capabilities: { text: true, modes: ['global'] }, create: f.factory })
    registration.commit()
  }
  const second = await f.chats.start(scope, chat.sessionId, { content: [{ type: 'text', text: 'Continue' }] }, 'second', new AbortController().signal)
  await f.chats.wait(second.id)
  expect(second).toMatchObject({ sessionId: chat.sessionId, instanceId: chat.instanceId, profileId: 'one' })
  expect(f.chats.get(scope, chat.sessionId, second.id).status).toBe('completed')
  const calls = prepare.mock.calls.length
  await expect(f.chats.start({ ...scope, profileId: 'other' }, chat.sessionId, { content: [{ type: 'text', text: 'Wrong profile' }] }, 'wrong', new AbortController().signal)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  expect(prepare).toHaveBeenCalledTimes(calls)
  restore = () => { f.revoke() }
  await expect(f.chats.start(scope, chat.sessionId, { content: [{ type: 'text', text: 'Revoked' }] }, 'revoked', new AbortController().signal)).rejects.toMatchObject({ code: 'FORBIDDEN' })
})
