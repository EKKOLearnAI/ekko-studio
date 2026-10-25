import sharp from 'sharp'
import { AgentArtifacts } from '../../packages/server/src/modules/studio/services/agents/artifacts'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { buildAgentPlugins } from '../../scripts/build-agent-plugins.mjs'
import { PluginHost } from '../../packages/server/src/modules/studio/services/plugins/host'
import { PluginStore } from '../../packages/server/src/modules/studio/repositories/plugin-store'
import { AgentExecutionStore } from '../../packages/server/src/modules/studio/repositories/agent-execution-store'
import { AgentRegistry } from '../../packages/server/src/modules/studio/services/agents/registry'
import { AgentCoordinator } from '../../packages/server/src/modules/studio/services/agents/coordinator'
import { PluginEventBus } from '../../packages/server/src/modules/studio/services/events/plugin-events'
import { createExecutionContext } from '../../packages/server/src/modules/studio/services/context/execution'
import { createNativeAgentContext } from '../../packages/server/src/modules/studio/services/agents/native-context'
import { StudioError, type ExecutionScope } from '../../packages/studio-plugin-sdk/src'
import { SESSIONS_SCHEMA, MESSAGES_SCHEMA } from '../../packages/server/src/modules/studio/infrastructure/database/schemas'
import { AgentChatProjection } from '../../packages/server/src/modules/studio/repositories/agent-chat-projection'
import { AgentChatStore } from '../../packages/server/src/modules/studio/repositories/agent-chat-store'
import { OrdinaryAgentChatStore } from '../../packages/server/src/modules/studio/repositories/ordinary-agent-chat-store'
import { AgentChats } from '../../packages/server/src/modules/studio/services/agents/chats'
import { OrdinaryAgentChats } from '../../packages/server/src/modules/studio/services/agents/ordinary-chats'
import { AgentRunAdmission } from '../../packages/server/src/modules/studio/services/agents/admission'
import { PluginHookRegistry } from '../../packages/server/src/modules/studio/services/events/plugin-hooks'
import { BundledAgentPlugins } from '../../packages/server/src/modules/studio/services/plugins/bundled-agents'

let root: string, runner: string
const cleanups: Array<() => Promise<void>> = []
const scope: ExecutionScope = { scopeId: 'scope', principal: { kind: 'user', id: '7' }, profileId: 'one', surface: 'api', traceId: 'trace' }
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'qwen-plugin-中文 '))
  vi.stubEnv('HERMES_WEB_UI_HOME', join(root, 'webui'))
  runner = join(root, 'runner.cjs')
  await build({ entryPoints: ['packages/studio-plugin-runner/src/main.ts'], bundle: true, platform: 'node', target: 'node24.22.1', format: 'cjs', outfile: runner, logLevel: 'silent' })
  await buildAgentPlugins(join(root, 'plugins'))
})
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
afterAll(async () => { await rm(root, { recursive: true, force: true }); vi.unstubAllEnvs() })

const fixture = `const fs = require('node:fs');
if (process.argv.includes('--version')) { process.stdout.write('native-cli 1.2.3\\n'); process.exit(0); }
fs.writeFileSync(process.env.PID_FILE, String(process.pid));
fs.writeFileSync(process.env.PID_FILE + '.home', JSON.stringify({ home: process.env.HOME, codex: process.env.CODEX_HOME, qwen: process.env.QWEN_HOME }));
const send = data => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...data }) + '\\n');
let prompt;
const update = value => send({ method: 'session/update', params: { sessionId: 'qwen-native', update: value } });
const finish = () => {
  update({ sessionUpdate: 'tool_call_update', toolCallId: 'tool', status: 'completed', rawOutput: 'done' });
  send({ id: prompt.id, result: { stopReason: 'end_turn' } });
};
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const r = JSON.parse(line);
  fs.appendFileSync(process.env.TRACE_FILE, JSON.stringify(r) + '\\n');
  if (r.method === 'initialize') send({ id: r.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: true } },
    agentInfo: { name: 'Qwen Code', version: 'fixture', privateField: 'secret' }, authMethods: [{ id: 'qwen-oauth', name: 'Qwen OAuth', env: { KEY: 'secret' } }] } });
  else if (r.method === 'session/new' || r.method === 'session/load') {
    if (r.method === 'session/load') update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'replayed old text' } });
    update({ sessionUpdate: 'available_commands_update', availableCommands: process.env.LARGE_CATALOG === '1'
      ? Array.from({ length: 100 }, (_, index) => ({ name: 'native-' + index, description: 'Native command '.repeat(100) }))
      : [{ name: 'inspect:state', description: 'Inspect native state', input: { hint: '<raw>' } },
        { name: '技能:检查', description: 'Unicode Skill command' }, { name: 'unsupported command with spaces', description: 'Native-only form' }] });
    send({ id: r.id, result: { sessionId: 'qwen-native' } });
  } else if (r.method === 'session/set_model') send({ id: r.id, result: {} });
  else if (r.method === 'session/prompt') {
    prompt = r;
    const text = r.params.prompt[0].text;
    if (text === '/compress' && process.env.COMPRESSION_NOOP === '1') {
      send({ id: r.id, error: { code: -32603, message: 'Internal error', data: { details: 'Compression was not beneficial for this history size.' } } });
      return;
    }
    if (text === 'broken') { process.stdout.write('{bad\\n'); return; }
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
    update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } });
    update({ sessionUpdate: 'tool_call', toolCallId: 'tool', title: 'Read file', status: 'pending', rawInput: { path: 'fixture.txt' } });
    if (text === 'approval') send({ id: 'approve', method: 'session/request_permission', params: { sessionId: 'qwen-native',
      toolCall: { toolCallId: 'tool', title: 'Read fixture.txt?' }, options: [{ optionId: 'yes', name: 'Allow once', kind: 'allow_once' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }] } });
    else {
      finish();
      if (text === 'bad-exit') process.exitCode = 7;
      if (text === 'hang') setInterval(() => {}, 1000);
    }
  } else if (r.id === 'approve' && r.result?.outcome?.optionId === 'yes') finish();
  else if (r.method === 'session/cancel') process.exit(0);
});`

async function setup(mode: 'global' | 'scoped' = 'global', extraEnv: Record<string, string> = {}, withChat = false) {
  const directory = await mkdtemp(join(root, 'run-')), cli = join(directory, 'qwen.cjs')
  const pidFile = join(directory, 'pid'), traceFile = join(directory, 'trace')
  await writeFile(cli, fixture)
  const db = new DatabaseSync(':memory:'), store = new PluginStore(db), registry = new AgentRegistry(), events = new PluginEventBus()
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const issued: Array<{ runId: string; model: string; protocol: string; dispose: ReturnType<typeof vi.fn> }> = []
  const gateway = vi.fn(async (scope: ExecutionScope, input: { model: string; protocol: 'responses' | 'anthropic' }, signal: AbortSignal) => {
    const dispose = vi.fn(async () => {})
    issued.push({ runId: scope.runId!, ...input, dispose })
    signal.addEventListener('abort', () => { if (!dispose.mock.calls.length) void dispose() }, { once: true })
    return { baseUrl: `http://127.0.0.1:1/${scope.runId}/v1`, token: `ephemeral-${scope.runId}`, ...input, images: true, dispose }
  })
  const readArtifact = vi.fn(async (scope: ExecutionScope, id: string, offset: number) => artifacts.read(scope, id, offset))
  const context = (scope: ExecutionScope, signal: AbortSignal) => createExecutionContext(scope, signal, logger, {
    artifacts: { read: readArtifact },
    models: { gateway, list: async () => [], get: async () => { throw new Error('unused') }, stream: async () => { throw new Error('unused') } },
    authorize: async () => {}, agents: { list: async () => [] }, sessions: { get: async () => null },
  })
  if (withChat) for (const [table, columns] of [['sessions', SESSIONS_SCHEMA], ['messages', MESSAGES_SCHEMA]] as const) db.exec(`CREATE TABLE ${table} (${Object.entries(columns).map(([name, sql]) => `${name} ${sql}`).join(', ')})`)
  const projection = withChat ? new AgentChatProjection(db) : undefined
  const executionStore = new AgentExecutionStore(db, projection)
  const artifacts = new AgentArtifacts(db, executionStore, () => {})
  const coordinator = new AgentCoordinator({ store: executionStore, registry, events, logger, authorize: () => {}, authorizeChat: () => {}, validateInput: (scope, input) => artifacts.validate(scope, input), context, stateRoot: join(directory, 'state'),
    nativeContext: (instance, current, provider, signal) => createNativeAgentContext(instance, current, signal, runId => {
      host.authorizeNativeMcp(provider, current.profileId)
      if (!['starting', 'running', 'waiting_input'].includes(executionStore.get(runId)?.status || '')) throw new StudioError('RUN_FINALIZING', 'Turn ended')
    }) })
  const host = new PluginHost({ store, registry, events, context, logger, runnerPath: runner, artifactsRoot: join(root, 'installed'),
    eventContext: async (_state, _event, signal) => context(scope, signal), acceptEvents: async batch => { for (const event of batch) events.publish(event) } })
  cleanups.push(async () => { await coordinator.close(); await host.close(); events.close(); db.close() })
  await host.registerSystemArtifact(join(root, 'plugins/qwen-code'))
  await host.configure({ pluginId: 'studio.agent-qwen', profileId: 'one', ownerId: 'installer', enabled: true, config: {}, grants: ['agents.register', 'commands.register', 'runs.start', 'processes.spawn', 'mcp.studio', 'models.gateway', 'artifacts.read'] }, 0)
  const instance = coordinator.createInstance(scope, { agentTypeId: 'qwen', mode, config: { ...(mode === 'scoped' ? { model: 'fixture/model' } : {}),
    approvalRequired: true, cwd: directory, command: process.execPath, args: [cli], env: { PID_FILE: pidFile, TRACE_FILE: traceFile, ...extraEnv },
  } })
  const start = (text: string) => coordinator.start(scope, instance.id, { content: [{ type: 'text', text }] }, text)
  const run = async (text: string) => { const r = start(text); await coordinator.wait(r.id); return coordinator.get(scope, r.id) }
  const trace = async () => (await readFile(traceFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  const pid = async () => Number(await readFile(pidFile, 'utf8'))
  return { readArtifact, artifacts, gateway, issued, directory, coordinator, host, store, executionStore, instance, start, run, trace, pid, db, registry, projection, context }
}
function alive(pid: number) { try { process.kill(pid, 0); return true } catch { return false } }

it('bounds completion metadata from large native skill catalogs without failing an ordinary chat', async () => {
  const f = await setup('global', { LARGE_CATALOG: '1' })
  const current: ExecutionScope = { ...scope, surface: 'chat', sessionId: 'large-catalog' }
  const run = f.coordinator.start(current, f.instance.id, { content: [{ type: 'text', text: 'First' }] }, 'first', undefined, { kind: 'chat', sessionId: 'large-catalog' })
  await f.coordinator.wait(run.id)
  expect(f.coordinator.get(scope, run.id).status).toBe('completed')
  const commands = f.host.commands.list('one', 'qwen', { ownerId: scope.principal.id, sessionId: 'large-catalog', instanceId: f.instance.id, instanceRevision: 1 })
  expect(commands).toHaveLength(65) // One static compression command and a bounded native completion catalog.
  expect(commands.filter(command => command.name.startsWith('native-'))).toHaveLength(64)
  expect(commands.every(command => command.description.length <= 512)).toBe(true)
})

it('reports non-beneficial native compression as a failed operation and retains the previous history checkpoint', async () => {
  const f = await setup('global', { COMPRESSION_NOOP: '1' }), first = await f.run('first')
  const checkpoint = f.executionStore.state.checkpoint(f.instance.id, first.provider, f.instance.revision)
  const result = await f.run('/compress')
  expect(result).toMatchObject({ status: 'failed', errorCode: 'CAPABILITY_UNSUPPORTED' })
  expect(f.coordinator.output(scope, result.id, -1)).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: 'message.snapshot', text: expect.stringContaining('existing history was kept') }),
  ]))
  expect(f.executionStore.state.checkpoint(f.instance.id, result.provider, f.instance.revision)).toEqual(checkpoint)
  expect((await f.run('after failure')).status).toBe('completed')
  expect((await f.trace()).filter(frame => frame.method === 'session/load').at(-1).params.sessionId).toBe('qwen-native')
})

it('publishes the native ACP catalog before session creation completes and preserves raw command arguments across retained turns', async () => {
  const f = await setup()
  const updated = await f.coordinator.updateInstance(scope, f.instance.id, { revision: 1, mode: 'global', config: { ...f.instance.config, systemPrompt: 'Do not add to command arguments' } })
  const chatScope: ExecutionScope = { ...scope, surface: 'chat', sessionId: 'native-chat' }
  const target = { ownerId: scope.principal.id, sessionId: 'native-chat', instanceId: f.instance.id, instanceRevision: updated.revision }
  const run = async (text: string) => {
    const accepted = f.coordinator.start(chatScope, f.instance.id, { content: [{ type: 'text', text }] }, text, undefined, { kind: 'chat', sessionId: 'native-chat' })
    await f.coordinator.wait(accepted.id)
    expect(f.coordinator.get(scope, accepted.id).status).toBe('completed')
  }
  expect(f.host.commands.list('one', 'qwen', target).map(command => command.name)).toEqual(['compress'])
  await run('first')
  const commands = f.host.commands.list('one', 'qwen', target)
  expect(commands).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'inspect:state', argsHint: '<raw>' })]))
  const inspect = commands.find(command => command.name === 'inspect:state')!
  await run('/inspect:state  "quoted"\n tail ')
  expect((await f.trace()).filter(frame => frame.method === 'session/prompt').at(-1).params.prompt[0].text).toBe('/inspect:state  "quoted"\n tail ')
  expect(f.host.commands.list('one', 'qwen', target).find(command => command.name === 'inspect:state')?.revision).toBe(inspect.revision)
  expect(commands.some(command => command.name === '技能:检查')).toBe(true)
  expect(commands.some(command => command.name.includes(' '))).toBe(false)
  await run('/技能:检查  中文参数')
  expect((await f.trace()).filter(frame => frame.method === 'session/prompt').at(-1).params.prompt[0].text).toBe('/技能:检查  中文参数')
  expect(f.host.commands.list('one', 'qwen', { ...target, sessionId: 'other' }).map(command => command.name)).toEqual(['compress'])
})

it('inspects ACP metadata without creating history or claiming an unknown account state', async () => {
  const f = await setup(), result = await f.coordinator.inspectInstance(scope, f.instance.id)
  expect(result).toMatchObject({ native: { name: 'Qwen Code', version: 'fixture' },
    authentication: { state: 'unknown', methods: [{ id: 'qwen-oauth', name: 'Qwen OAuth' }] }, models: { status: 'unsupported', items: [] } })
  expect(JSON.stringify(result)).not.toMatch(/privateField|secret|KEY/)
  expect((await f.trace()).map(r => r.method)).toEqual(['initialize'])
  expect(alive(await f.pid())).toBe(false)
  expect(await f.run('after-inspect')).toMatchObject({ status: 'completed' })
})

it('applies a compatible instance configuration while restoring the previous native session', async () => {
  const f = await setup(), before = await f.run('before')
  await f.coordinator.updateInstance(scope, f.instance.id, { revision: 1, config: { ...f.instance.config, model: 'configured-model' }, mode: 'global' })
  expect(await f.run('after')).toMatchObject({ status: 'completed', configRevision: 2 })
  const requests = await f.trace()
  expect(requests.filter(frame => frame.method === 'session/new')).toHaveLength(1)
  expect(requests.filter(frame => frame.method === 'session/load')).toHaveLength(1)
  expect(requests.filter(frame => frame.method === 'session/set_model').at(-1).params.modelId).toBe('configured-model')
  expect(f.coordinator.get(scope, before.id).status).toBe('completed')
})

it('loads the independent Qwen artifact in a worker, streams approvals and restores the native session without replay', async () => {
  const f = await setup(), first = f.start('approval')
  await vi.waitFor(() => expect(f.coordinator.get(scope, first.id).status).toBe('waiting_input'))
  expect(f.coordinator.output(scope, first.id, -1)).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: 'message.delta', text: 'approval' }),
    expect.objectContaining({ type: 'reasoning.delta', text: 'thinking' }),
    expect.objectContaining({ type: 'tool.started', name: 'Read file' }),
  ]))
  const interaction = f.coordinator.interactions(scope, first.id)[0]
  await f.coordinator.respond(scope, first.id, { interactionId: interaction.id, idempotencyKey: 'approve-once', choiceId: 'yes' })
  await f.coordinator.wait(first.id)
  expect(f.coordinator.get(scope, first.id).status).toBe('completed')
  expect(alive(await f.pid())).toBe(false)
  expect(f.coordinator.usage(scope, first.id)).toEqual([])
  const second = await f.run('继续 😀')
  expect(second.status).toBe('completed')
  const text = f.coordinator.output(scope, second.id, -1).filter(event => event.type === 'message.delta')
  expect(text).toHaveLength(1)
  expect(text[0]).toMatchObject({ text: '继续 😀' })
  expect(await f.trace()).toEqual(expect.arrayContaining([expect.objectContaining({ method: 'session/load', params: expect.objectContaining({ sessionId: 'qwen-native' }) })]))
  expect(() => f.host.uninstall('studio.agent-qwen')).toThrow('System plugins cannot be uninstalled')
})

it('cancels a pending native approval and confirms the subprocess exit', async () => {
  const f = await setup(), run = f.start('approval')
  await vi.waitFor(() => expect(f.coordinator.get(scope, run.id).status).toBe('waiting_input'))
  const pid = await f.pid()
  expect(alive(pid)).toBe(true)
  await f.coordinator.cancel(scope, run.id)
  await f.coordinator.wait(run.id)
  expect(f.coordinator.get(scope, run.id).status).toBe('cancelled')
  expect(f.coordinator.interactions(scope, run.id)[0].status).toBe('interrupted')
  expect(alive(pid)).toBe(false)
})

it.each(['broken', 'bad-exit', 'hang'])('does not commit a successful checkpoint for native failure: %s', async text => {
  const f = await setup(), run = await f.run(text)
  expect(run.status).toBe('failed')
  expect(alive(await f.pid())).toBe(false)
  expect(await f.run('fresh')).toMatchObject({ status: 'completed' })
  expect((await f.trace()).filter(r => r.method === 'session/new')).toHaveLength(2)
})

it('rejects a relative working directory before launching a CLI', async () => {
  const f = await setup()
  const instance = f.coordinator.createInstance(scope, { agentTypeId: 'qwen', mode: 'global', config: { cwd: 'relative' } })
  const run = f.coordinator.start(scope, instance.id, { content: [{ type: 'text', text: 'hello' }] }, 'invalid')
  await f.coordinator.wait(run.id)
  expect(f.coordinator.get(scope, run.id)).toMatchObject({ status: 'failed', errorCode: 'INVALID_ARGUMENT' })
})


it('runs scoped Qwen through a worker with isolated persistent history and per-turn gateway credentials', async () => {
  const f = await setup('scoped')
  expect(await f.run('first')).toMatchObject({ status: 'completed' })
  const firstPid = await f.pid(), firstHome = JSON.parse(await readFile(join(f.directory, 'pid.home'), 'utf8'))
  expect(firstHome.qwen).toContain(join(f.directory, 'state'))
  expect(alive(firstPid)).toBe(false)
  expect(await f.run('second')).toMatchObject({ status: 'completed' })
  expect(await f.pid()).not.toBe(firstPid)
  expect(JSON.parse(await readFile(join(f.directory, 'pid.home'), 'utf8'))).toEqual(firstHome)
  const trace = await f.trace()
  expect(trace.filter(frame => frame.method === 'session/new')).toHaveLength(1)
  expect(trace.filter(frame => frame.method === 'session/load')).toHaveLength(1)
  expect(f.issued).toHaveLength(2)
  expect(f.issued[0].runId).not.toBe(f.issued[1].runId)
  for (const gateway of f.issued) { expect(gateway).toMatchObject({ model: 'fixture/model', protocol: 'anthropic' }); expect(gateway.dispose).toHaveBeenCalled() }
  expect(await readFile(join(firstHome.qwen, 'settings.json'), 'utf8')).not.toContain('ephemeral-')
})

it('cancels scoped Qwen approvals and releases its model gateway', async () => {
  const f = await setup('scoped'), run = f.start('approval')
  await vi.waitFor(() => expect(f.coordinator.get(scope, run.id).status).toBe('waiting_input'))
  const pid = await f.pid()
  f.coordinator.cancel(scope, run.id)
  await f.coordinator.wait(run.id)
  expect(alive(pid)).toBe(false)
  expect(f.issued[0].dispose).toHaveBeenCalled()
  expect(f.coordinator.get(scope, run.id).status).toBe('cancelled')
})

it('does not inspect the global account for a scoped Qwen instance', async () => {
  const f = await setup('scoped')
  await expect(f.coordinator.inspectInstance(scope, f.instance.id)).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' })
  await expect(f.pid()).rejects.toMatchObject({ code: 'ENOENT' })
})

for (const mode of ['global', 'scoped'] as const) it(`passes owned image bytes through the real worker in ${mode} mode`, async () => {
  const f = await setup(mode)
  const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } }).png().toBuffer()
  const image = await f.artifacts.create(scope, bytes, new AbortController().signal)
  const input = { content: [{ type: 'text' as const, text: 'describe image' }, { type: 'image' as const, artifactId: image.id, mediaType: image.mediaType }] }
  const run = f.coordinator.start(scope, f.instance.id, input, 'image')
  await f.coordinator.wait(run.id)
  expect(f.coordinator.get(scope, run.id)).toMatchObject({ status: 'completed' })
  const requests = await f.trace()
  expect(requests.find(r => r.method === 'session/prompt').params.prompt).toContainEqual({ type: 'image', mimeType: 'image/png', data: bytes.toString('base64') })
  expect(JSON.stringify(f.coordinator.output(scope, run.id, -1))).not.toContain(bytes.toString('base64'))
  expect(await f.run('continue after image')).toMatchObject({ status: 'completed' })
  expect(() => f.artifacts.read({ ...scope, runId: run.id }, image.id)).toThrow(/live Run/)
})

it('rejects scoped image input on a model without vision before native admission', async () => {
  const f = await setup('scoped')
  const open = f.gateway.getMockImplementation()!
  f.gateway.mockImplementation(async (...args) => ({ ...await open(...args), images: false }))
  const bytes = await sharp({ create: { width: 1, height: 1, channels: 3, background: 'red' } }).png().toBuffer()
  const image = await f.artifacts.create(scope, bytes, new AbortController().signal)
  const run = f.coordinator.start(scope, f.instance.id, { content: [{ type: 'image', artifactId: image.id, mediaType: image.mediaType }] }, 'no-vision')
  await f.coordinator.wait(run.id)
  expect(f.coordinator.get(scope, run.id)).toMatchObject({ status: 'failed', errorCode: 'CAPABILITY_UNSUPPORTED' })
  expect(f.issued[0].dispose).toHaveBeenCalledOnce()
  await expect(f.trace()).rejects.toMatchObject({ code: 'ENOENT' })
})

it('rechecks the image grant after a delayed worker read and never sends revoked bytes to the CLI', async () => {
  const f = await setup()
  const bytes = await sharp({ create: { width: 1, height: 1, channels: 3, background: 'red' } }).png().toBuffer()
  const image = await f.artifacts.create(scope, bytes, new AbortController().signal)
  let release!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  f.readArtifact.mockImplementationOnce(async (scope, id, offset) => {
    const chunk = f.artifacts.read(scope, id, offset)
    await barrier
    return chunk
  })
  const run = f.coordinator.start(scope, f.instance.id, { content: [{ type: 'image', artifactId: image.id, mediaType: image.mediaType }] }, 'revoked-image')
  try {
    await vi.waitFor(() => expect(f.readArtifact).toHaveBeenCalledOnce())
    const profile = f.store.profile('studio.agent-qwen', 'one')!
    f.store.saveProfile({ ...profile, grants: profile.grants.filter(value => value !== 'artifacts.read') }, profile.revision)
  } finally { release() }
  await f.coordinator.wait(run.id)
  expect(f.coordinator.get(scope, run.id)).toMatchObject({ status: 'failed', errorCode: 'FORBIDDEN' })
  await expect(f.trace()).rejects.toMatchObject({ code: 'ENOENT' })
})


it.each(['global', 'scoped'] as const)('declares multiple qwen skill roots and configuration files without starting a Run (%s)', async mode => {
  const f = await setup(mode)
  const first = await f.coordinator.resourceLocations(scope, f.instance.id, 1)
  expect(first.skills).toHaveLength(4)
  expect(first.configs).toHaveLength(3)
  expect(new Set(first.skills!.map(item => item.id)).size).toBe(4)
  expect(first.configs!.filter(item => item.name === 'QWEN.md')).toHaveLength(2)
  expect(first.skills!.find(item => item.id === 'shared-skills')).toMatchObject({ readOnly: true, scope: 'shared' })
  expect(first.configs!.find(item => item.id === 'workspace-instructions')!.path).toBe(join(f.directory, 'QWEN.md'))
  await expect(readFile(join(f.directory, 'pid'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await f.coordinator.resourceLocations(scope, f.instance.id, 1)).toEqual(first)
  const cwd = join(f.directory, 'another-workspace')
  await f.coordinator.updateInstance(scope, f.instance.id, { revision: 1, mode, config: { ...f.instance.config, cwd } })
  await expect(f.coordinator.resourceLocations(scope, f.instance.id, 1)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
  const next = await f.coordinator.resourceLocations(scope, f.instance.id, 2)
  expect(next.configs!.find(item => item.id === 'workspace-instructions')!.path).toBe(join(cwd, 'QWEN.md'))
  await expect(f.coordinator.resourceLocations({ ...scope, principal: { kind: 'user', id: 'other' } }, f.instance.id, 2)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  await expect(f.coordinator.resourceLocations({ ...scope, profileId: 'other' }, f.instance.id, 2)).rejects.toMatchObject({ code: 'NOT_FOUND' })
})

it('loads Studio-edited scoped configuration and skills from the declared native locations', async () => {
  const f = await setup('scoped')
  const catalog = await f.coordinator.resourceFiles(scope, f.instance.id, 1, { action: 'list' })
  const configRef = { kind: 'configs' as const, locationId: 'native-config', path: '' }
  const skillRef = { kind: 'skills' as const, locationId: 'native-skills', path: 'studio-test/SKILL.md' }
  await f.coordinator.resourceFiles(scope, f.instance.id, 1, { action: 'write', ...configRef, content: '{"ui":{"theme":"studio-resource-test"}}', etag: 'missing' }, catalog.snapshot)
  await f.coordinator.resourceFiles(scope, f.instance.id, 1, { action: 'write', ...skillRef, content: '# Studio edited skill', etag: 'missing' }, catalog.snapshot)
  const probe = `
fs.writeFileSync(process.env.PID_FILE + '.resources', JSON.stringify({ config: fs.readFileSync(require('node:path').join(process.env.QWEN_HOME, 'settings.json'), 'utf8'), skill: fs.readFileSync(require('node:path').join(process.env.QWEN_HOME, 'skills/studio-test/SKILL.md'), 'utf8') }));`
  await writeFile(join(f.directory, 'qwen.cjs'), (await readFile(join(f.directory, 'qwen.cjs'), 'utf8')) + probe)
  expect((await f.run('resource-first')).status).toBe('completed')
  let loaded = JSON.parse(await readFile(join(f.directory, 'pid.resources'), 'utf8'))
  expect(loaded.config).toContain('studio-resource-test')
  expect(loaded.skill).toBe('# Studio edited skill')
  const read = await f.coordinator.resourceFiles(scope, f.instance.id, 1, { action: 'read', ...skillRef }, catalog.snapshot)
  await f.coordinator.resourceFiles(scope, f.instance.id, 1, { action: 'write', ...skillRef, content: '# Updated for next run', etag: read.file!.etag }, catalog.snapshot)
  expect((await f.run('resource-next')).status).toBe('completed')
  loaded = JSON.parse(await readFile(join(f.directory, 'pid.resources'), 'utf8'))
  expect(loaded.skill).toBe('# Updated for next run')
})


it('keeps scoped resources and native history across compatible configuration revisions', async () => {
  const f = await setup('scoped')
  const catalog = await f.coordinator.resourceFiles(scope, f.instance.id, 1, { action: 'list' }) as any
  await f.coordinator.resourceFiles(scope, f.instance.id, 1, { action: 'write', kind: 'configs', locationId: 'native-instructions', path: '', content: 'Keep this instruction', etag: 'missing' }, catalog.snapshot)
  expect(await f.run('before-config')).toMatchObject({ status: 'completed' })
  const beforeHome = await readFile(join(f.directory, 'pid.home'), 'utf8')
  const updated = await f.coordinator.updateInstance(scope, f.instance.id, { revision: 1, config: { ...f.instance.config, model: 'fixture/next', systemPrompt: 'New instruction' }, mode: 'scoped' })
  const { revision, ...profile } = f.store.profile('studio.agent-qwen', 'one')!
  const disabled = await f.host.configure({ ...profile, enabled: false }, revision)
  await f.host.configure({ ...profile, enabled: true }, disabled.revision)
  const next = await f.coordinator.resourceFiles(scope, f.instance.id, 2, { action: 'list' }) as any
  expect(next.configs).toEqual(catalog.configs)
  expect(next.snapshot).not.toBe(catalog.snapshot)
  await expect(f.coordinator.resourceFiles(scope, f.instance.id, 2, { action: 'read', kind: 'configs', locationId: 'native-instructions', path: '' }, catalog.snapshot)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
  expect(await f.coordinator.resourceFiles(scope, f.instance.id, 2, { action: 'read', kind: 'configs', locationId: 'native-instructions', path: '' }, next.snapshot)).toMatchObject({ file: { content: 'Keep this instruction' } })
  expect(await f.run('after-config')).toMatchObject({ status: 'completed', configRevision: 2 })
  expect(await readFile(join(f.directory, 'pid.home'), 'utf8')).toBe(beforeHome)
  expect((await f.trace()).filter(frame => frame.method === 'session/load')).toHaveLength(1)
  expect(f.issued.at(-1)!.model).toBe('fixture/next')
  // Environment can select a different account/home; it must not reuse the old state.
  await f.coordinator.updateInstance(scope, f.instance.id, { revision: 2, config: { ...updated.config, env: { ...updated.config.env as any, NEW_HOME_SELECTOR: 'different' } }, mode: 'scoped' })
  const changed = await f.coordinator.resourceLocations(scope, f.instance.id, 3)
  expect(changed.configs!.find(file => file.id === 'native-instructions')!.path).not.toBe(next.configs.find((file: any) => file.id === 'native-instructions').path)
  expect(await f.run('after-environment')).toMatchObject({ status: 'completed', configRevision: 3 })
  expect((await f.trace()).filter(frame => frame.method === 'session/load')).toHaveLength(1)
})


it.each(['global', 'scoped'] as const)('returns qwen setup instructions through a real worker in %s mode', async mode => {
  const f = await setup(mode)
  const result = await f.coordinator.setupInstance(scope, f.instance.id, 1)
  expect(result.cli).toEqual({ state: 'available', version: '1.2.3' })
  expect(result.authentication.kind).toBe(mode === 'scoped' ? 'studio' : 'native')
  if (mode === 'global') expect(result.authentication).toMatchObject({ command: process.execPath, input: '/auth' })
  expect(f.gateway).not.toHaveBeenCalled()
  await expect(f.trace()).rejects.toMatchObject({ code: 'ENOENT' })
})

it('injects only selected Studio MCP servers into ACP and keeps the private path stable across native session restoration', async () => {
  const f = await setup()
  await f.coordinator.updateInstance(scope, f.instance.id, { revision: 1, mode: 'global', config: { ...f.instance.config,
    studioMcp: { enabled: true, browser: false, devices: false, use: false },
  } })
  expect(await f.run('first native MCP turn')).toMatchObject({ status: 'completed' })
  const first = (await f.trace()).find(frame => frame.method === 'session/new').params.mcpServers
  expect(first.map((server: any) => server.name)).toEqual(['ekko-studio-api'])
  const env = Object.fromEntries(first[0].env.map((item: any) => [item.name, item.value]))
  expect(env).toMatchObject({ ELECTRON_RUN_AS_NODE: '1', HERMES_WEB_UI_PROFILE: 'one', HERMES_WEB_UI_TOKEN: '', AUTH_TOKEN: '' })
  expect(env.HERMES_WEB_UI_RUN_TOKEN_FILE).toEqual(expect.any(String))
  await expect(readFile(String(env.HERMES_WEB_UI_RUN_TOKEN_FILE), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await f.run('second native MCP turn')).toMatchObject({ status: 'completed' })
  const next = (await f.trace()).find(frame => frame.method === 'session/load').params.mcpServers
  expect(next).toEqual(first)
  expect(JSON.stringify(await f.trace())).not.toContain('studio_run_')
  const completed = (await f.trace()).filter(frame => frame.method === 'session/prompt')
  expect(completed[0].params.prompt[0].text).toContain('ekko_studio_api_openapi_get')
  expect(completed[1].params.prompt[0].text).toContain('second native MCP turn')
})

for (const mode of ['global', 'scoped'] as const) it(`runs an ordinary ${mode} chat through the real plugin worker, resumes it and writes one transcript`, async () => {
  const f = await setup(mode, {}, true)
  const chats = new AgentChats({ store: new AgentChatStore(f.db), projection: f.projection!, executions: f.executionStore, registry: f.registry, coordinator: f.coordinator,
    admission: new AgentRunAdmission(f.coordinator, new PluginHookRegistry(), f.context), authorize: () => {},
    createSession: input => { f.db.prepare(`INSERT INTO sessions(id,profile,source,agent,agent_mode,studio_user_id,started_at,last_active) VALUES(?,?,?,?,?,?,1,1)`)
      .run(input.id, input.profile, input.source, input.agent, input.agent_mode, input.studio_user_id) } })
  const ordinary = new OrdinaryAgentChats({ store: new OrdinaryAgentChatStore(f.db), registry: f.registry, coordinator: f.coordinator, chats,
    authorize: () => {}, ensure: async () => { expect(f.host.diagnostic('studio.agent-qwen', 'one').state).toBe('ready') },
    prepare: async () => { const { approvalRequired: _manual, ...config } = f.instance.config; return config }, defaultWorkspace: () => f.directory, updateSession: () => {} })
  const selection = { sessionId: `ordinary-${mode}`, agentTypeId: 'qwen', mode, ...(mode === 'scoped' ? { model: 'fixture/model', provider: 'fixture' } : {}) }
  const chat = await ordinary.create(scope, selection)
  const first = await chats.start(scope, chat.sessionId, { content: [{ type: 'text', text: 'approval' }] }, 'ordinary-first', new AbortController().signal)
  await f.coordinator.wait(first.id)
  expect(chats.get(scope, chat.sessionId, first.id).status).toBe('completed')
  expect(chats.interactions(scope, chat.sessionId, first.id)).toEqual([])
  const image = await f.artifacts.create(scope, await sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } }).png().toBuffer(), new AbortController().signal)
  const second = await chats.start(scope, chat.sessionId, { content: [{ type: 'text', text: 'Resumed ordinary turn' }, { type: 'image', artifactId: image.id, mediaType: image.mediaType }] }, 'ordinary-second', new AbortController().signal)
  await f.coordinator.wait(second.id)
  expect(chats.get(scope, chat.sessionId, second.id).status).toBe('completed')
  expect(f.db.prepare("SELECT role,content FROM messages WHERE session_id=? AND (role='user' OR role='assistant' AND content!='') ORDER BY id").all(chat.sessionId)).toMatchObject([
    { role: 'user', content: 'approval' }, { role: 'assistant', content: 'approval' },
    { role: 'user' }, { role: 'assistant', content: 'Resumed ordinary turn' },
  ])
  expect((await f.trace()).filter(item => item.method === 'session/load')).toHaveLength(1)
  expect((await f.trace()).filter(item => item.method === 'session/prompt').at(-1).params.prompt).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'image', mimeType: image.mediaType })]))
  expect((await ordinary.create(scope, selection)).instanceId).toBe(chat.instanceId)
  if (mode === 'scoped') expect(f.gateway).toHaveBeenCalledWith(expect.objectContaining({ sessionId: chat.sessionId, runId: second.id }), expect.objectContaining({ model: 'fixture/model' }), expect.any(AbortSignal))
  chats.close()
})


it('keeps tool execution automatic when no manual approval policy is configured', async () => {
  const f = await setup()
  const { approvalRequired: _manual, ...config } = f.instance.config
  await f.coordinator.updateInstance(scope, f.instance.id, { revision: f.instance.revision, mode: f.instance.mode, config })
  const run = f.start('approval')
  await f.coordinator.wait(run.id)
  expect(f.coordinator.get(scope, run.id).status).toBe('completed')
  expect(f.coordinator.interactions(scope, run.id)).toEqual([])
  expect((await f.trace()).find((frame: any) => frame.id === 'approve')?.result).toMatchObject({ outcome: { outcome: 'selected', optionId: 'yes' } })
})

it('continues an existing chat after host reconstruction by restoring the global plugin before admission', async () => {
  const f = await setup('global', {}, true)
  const createSession = (input: any) => { f.db.prepare('INSERT INTO sessions(id,profile,source,agent,agent_mode,studio_user_id,started_at,last_active) VALUES(?,?,?,?,?,?,1,1)')
    .run(input.id, input.profile, input.source, input.agent, input.agent_mode, input.studio_user_id) }
  const chats = new AgentChats({ store: new AgentChatStore(f.db), projection: f.projection!, executions: f.executionStore, registry: f.registry, coordinator: f.coordinator,
    admission: new AgentRunAdmission(f.coordinator, new PluginHookRegistry(), f.context), authorize: () => {}, createSession })
  const chat = chats.create(scope, f.instance.id, { revision: 1, idempotencyKey: 'restart-chat' })
  const before = await chats.start(scope, chat.sessionId, { content: [{ type: 'text', text: 'Before restart' }] }, 'before', new AbortController().signal)
  await chats.wait(before.id)
  await f.coordinator.close(); chats.close(); await f.host.close()

  const registry = new AgentRegistry(), events = new PluginEventBus(), logger = { info() {}, warn() {}, error() {} }
  const host = new PluginHost({ store: f.store, registry, events, context: f.context, logger, runnerPath: runner, artifactsRoot: join(root, 'installed'),
    eventContext: async (_state, _event, signal) => f.context(scope, signal), acceptEvents: async batch => { for (const event of batch) events.publish(event) } })
  const bundles = new BundledAgentPlugins(host, f.store, runner, () => {})
  const coordinator = new AgentCoordinator({ store: f.executionStore, registry, events, logger, authorize: () => {}, context: f.context, stateRoot: join(f.directory, 'state'),
    authorizeChat: (current, instance, id) => restored.authorizeRunTarget(current, instance, id) })
  const restored = new AgentChats({ store: new AgentChatStore(f.db), projection: f.projection!, executions: f.executionStore, registry, coordinator,
    admission: new AgentRunAdmission(coordinator, new PluginHookRegistry(), f.context), authorize: () => {}, createSession,
    prepareRuntime: (current, instance) => bundles.ensure(instance.agentTypeId, () => {}) })
  cleanups.push(async () => { await coordinator.close(); restored.close(); await bundles.close(); await host.close(); events.close() })
  expect(registry.list('one')).toEqual([])
  const after = await restored.start(scope, chat.sessionId, { content: [{ type: 'text', text: 'After restart' }] }, 'after', new AbortController().signal)
  await restored.wait(after.id)
  expect(restored.get(scope, chat.sessionId, after.id)).toMatchObject({ status: 'completed', instanceId: f.instance.id, sessionId: chat.sessionId, profileId: 'one' })
  const frames = await f.trace()
  expect(frames.filter(frame => frame.method === 'session/load')).toHaveLength(1)
  expect(frames.filter(frame => frame.method === 'session/prompt').map(frame => frame.params.prompt[0].text)).toEqual(['Before restart', 'After restart'])
  expect(f.db.prepare('SELECT count(*) AS n FROM studio_agent_chat_bindings').get()?.n).toBe(1)
})

it('replaces a retained runtime after its global worker reloads at the same artifact generation', async () => {
  const f = await setup()
  expect((await f.run('Before worker reload')).status).toBe('completed')
  const previous = f.registry.resolve(scope.profileId, 'qwen')
  await f.host.close()
  const events = new PluginEventBus(), logger = { info() {}, warn() {}, error() {} }
  const host = new PluginHost({ store: f.store, registry: f.registry, events, context: f.context, logger, runnerPath: runner,
    artifactsRoot: join(root, 'installed'), eventContext: async (_state, _event, signal) => f.context(scope, signal),
    acceptEvents: async batch => { for (const event of batch) events.publish(event) } })
  cleanups.push(async () => { await f.coordinator.close(); await host.close(); events.close() })
  await host.activate('studio.agent-qwen')
  const current = f.registry.resolve('another-profile', 'qwen')
  expect(current.provider).toEqual(previous.provider)
  expect(current.definition).not.toBe(previous.definition)
  expect((await f.run('After worker reload')).status).toBe('completed')
  const frames = await f.trace()
  expect(frames.filter(frame => frame.method === 'session/load')).toHaveLength(1)
  expect(frames.filter(frame => frame.method === 'session/prompt').map(frame => frame.params.prompt[0].text)).toEqual(['Before worker reload', 'After worker reload'])
})
