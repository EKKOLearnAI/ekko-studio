import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { expect, it, vi } from 'vitest'
import { SESSIONS_SCHEMA, MESSAGES_SCHEMA } from '../../packages/server/src/modules/studio/infrastructure/database/schemas'
import { AgentChatProjection } from '../../packages/server/src/modules/studio/repositories/agent-chat-projection'
import { AgentChatStore } from '../../packages/server/src/modules/studio/repositories/agent-chat-store'
import { AgentExecutionStore } from '../../packages/server/src/modules/studio/repositories/agent-execution-store'
import { PluginStore } from '../../packages/server/src/modules/studio/repositories/plugin-store'
import { PluginCommandStore } from '../../packages/server/src/modules/studio/repositories/plugin-command-store'
import { AgentChats } from '../../packages/server/src/modules/studio/services/agents/chats'
import { AgentCoordinator } from '../../packages/server/src/modules/studio/services/agents/coordinator'
import { AgentRegistry } from '../../packages/server/src/modules/studio/services/agents/registry'
import { AgentRunAdmission } from '../../packages/server/src/modules/studio/services/agents/admission'
import { AgentContextRuns } from '../../packages/server/src/modules/studio/services/agents/context-runs'
import { PluginHookRegistry } from '../../packages/server/src/modules/studio/services/events/plugin-hooks'
import { PluginEventBus } from '../../packages/server/src/modules/studio/services/events/plugin-events'
import { createExecutionContext } from '../../packages/server/src/modules/studio/services/context/execution'
import { CommandExecutionScopes } from '../../packages/server/src/modules/studio/services/commands/scopes'
import { PluginCommands } from '../../packages/server/src/modules/studio/services/commands/plugin'
import { PluginHost } from '../../packages/server/src/modules/studio/services/plugins/host'
import type { ExecutionScope } from '../../packages/studio-plugin-sdk/src'

it('routes a real runtime handler through SDK admission and one canonical chat input, including durable retries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-command-chat-')), db = new DatabaseSync(':memory:')
  const registry = new AgentRegistry(), events = new PluginEventBus(), logger = { info() {}, warn() {}, error() {} }
  for (const [table, columns] of [['sessions', SESSIONS_SCHEMA], ['messages', MESSAGES_SCHEMA]] as const) db.exec(`CREATE TABLE ${table} (${Object.entries(columns).map(([name, sql]) => `${name} ${sql}`).join(', ')})`)
  const projection = new AgentChatProjection(db), executions = new AgentExecutionStore(db, projection), store = new AgentChatStore(db)
  const calls = new PluginCommandStore(db), scopes = new CommandExecutionScopes()
  const scope: ExecutionScope = { scopeId: 'owner', principal: { kind: 'user', id: '7' }, profileId: 'one', surface: 'api', traceId: 'test' }
  let contextRuns: AgentContextRuns
  const context = (current: ExecutionScope, signal: AbortSignal) => createExecutionContext(current, signal, logger, {
    authorize: async () => {}, agents: { list: async profile => registry.list(profile) }, sessions: { get: async () => null },
    runs: { start: (current, input, signal) => contextRuns.start(current, input, signal),
      get: async (current, id) => coordinator.get(current, id), output: async (current, id, after) => coordinator.output(current, id, after) },
  })
  const coordinator = new AgentCoordinator({ store: executions, registry, events, logger, context, authorize: () => {},
    authorizeChat: (current, instance, id) => chats.authorizeRunTarget(current, instance, id) })
  const admission = new AgentRunAdmission(coordinator, new PluginHookRegistry(), context)
  const chats = new AgentChats({ store, projection, executions, coordinator, admission, registry, authorize: () => {}, createSession: input => {
    db.prepare('INSERT INTO sessions (id, profile, source, agent, agent_mode, user_id, studio_user_id, started_at, last_active) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1)')
      .run(input.id, input.profile, input.source, input.agent, input.agent_mode, input.user_id, input.studio_user_id)
  } })
  contextRuns = new AgentContextRuns({ admission, chats, commands: scopes, executions, coordinator })
  const host = new PluginHost({ store: new PluginStore(db), registry, events, logger, context, eventContext: async () => context(scope, new AbortController().signal),
    acceptEvents: async () => {}, artifactsRoot: join(root, 'artifacts'), runnerPath: join(root, 'runner.cjs') })
  const commands = new PluginCommands({ registry: host.commands, store: calls,
    context: (current, signal, call, target) => { if (call) scopes.bind(current, call, signal, { instanceId: target!.instanceId!, instanceRevision: target!.instanceRevision! }); return context(current, signal) },
    cancelRuns: (current, id) => contextRuns.cancelCommand(current, id),
    authorize: (current, id) => {
      const { instance } = chats.ownedBinding(current, id)
      return { agentTypeId: instance.agentTypeId, fingerprint: `${instance.id}:${instance.revision}`, instanceId: instance.id, instanceRevision: instance.revision, isWorking: chats.activity(current, id).length > 0 }
    },
    persist: (id, text) => Number(db.prepare("INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, 'command', ?, 1)").run(id, text).lastInsertRowid), publish: () => {},
  })
  try {
    await build({ entryPoints: ['packages/studio-plugin-runner/src/main.ts'], bundle: true, platform: 'node', target: 'node24.22.1', format: 'cjs', outfile: join(root, 'runner.cjs'), logLevel: 'silent' })
    const manifest = { schemaVersion: 1, id: 'test.native-chat', version: '1.0.0', engines: { studioSdk: '^0.1.0', rpc: 1 }, backend: 'index.cjs', activation: 'profile',
      contributes: { agents: ['test.native-chat/agent'], runtimeCommands: ['test.native-chat/agent'] }, requires: { capabilities: ['agents.register', 'commands.register', 'runs.start'] } }
    const pluginDirectory = join(root, 'plugin')
    await mkdir(pluginDirectory)
    await writeFile(join(pluginDirectory, 'studio-plugin.json'), JSON.stringify(manifest))
    await writeFile(join(pluginDirectory, 'index.cjs'), `module.exports = { apply(plugin) { plugin.agents.register({
      id: 'test.native-chat/agent', name: 'Native fixture', configSchema: {}, capabilities: { text: true, persistentSession: true, modes: ['global'] },
      create: async (input, runtime) => {
        await runtime.commands.replace([{ definition: { id: 'test.native-chat/inspect', name: 'inspect', description: 'Native inspect' }, handler: async (input, ctx) => {
          await ctx.runs.start({ instanceId: ctx.session.instanceId, input: { content: [{ type: 'text', text: '/inspect' + input.rawArguments }] }, idempotencyKey: ctx.scope.scopeId });
          return { command: input.command, action: 'submitted', ok: true, message: '', terminal: false };
        } }]);
        return { run: async input => ({ events: (async function*() { yield { type: 'message.snapshot', producerSequence: 1, messageId: 'answer', text: 'Native: ' + input.content[0].text }; })(),
          result: Promise.resolve({ status: 'completed' }), cancel: async () => {} }), dispose: async () => {} };
      }
    }); } };`)
    await host.install(pluginDirectory)
    await host.configure({ pluginId: manifest.id, profileId: 'one', ownerId: '7', enabled: true, config: {}, grants: manifest.requires.capabilities }, 0)
    const instance = coordinator.createInstance(scope, { agentTypeId: 'test.native-chat/agent', config: {}, mode: 'global' })
    const chat = chats.create(scope, instance.id, { revision: 1, idempotencyKey: 'create' })
    expect(commands.list(scope, chat.sessionId)).toEqual([])
    const first = await chats.start(scope, chat.sessionId, { content: [{ type: 'text', text: 'First' }] }, 'first', new AbortController().signal)
    await chats.wait(first.id)
    const command = commands.list(scope, chat.sessionId)[0]
    expect(command.name).toBe('inspect')
    const request = { sessionId: chat.sessionId, commandId: command.id, revision: command.revision, text: '/test.native-chat:inspect  "raw"', idempotencyKey: 'command' }
    const call = commands.start(scope, request)
    await vi.waitFor(() => expect(calls.get(call.id)?.status).not.toBe('running'))
    expect(commands.get(scope, call.id).status).toBe('completed')
    const [runId] = executions.commands.runs(call.id)
    await chats.wait(runId)
    expect(chats.get(scope, chat.sessionId, runId).status).toBe('completed')
    expect(commands.start(scope, request).id).toBe(call.id)
    expect(db.prepare('SELECT role, content, run_marker FROM messages WHERE run_marker=? ORDER BY id').all(runId)).toEqual([
      { role: 'command', content: request.text, run_marker: runId }, { role: 'assistant', content: 'Native: /inspect  "raw"', run_marker: runId },
    ])
    expect(executions.commands.runs(call.id)).toEqual([runId])
  } finally {
    await commands.close(); await coordinator.close(); await host.close(); chats.close(); events.close(); db.close(); await rm(root, { recursive: true, force: true })
  }
})
