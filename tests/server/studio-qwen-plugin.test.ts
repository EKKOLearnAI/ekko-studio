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
import type { ExecutionScope } from '../../packages/studio-plugin-sdk/src'

let root: string, runner: string
const cleanups: Array<() => Promise<void>> = []
const scope: ExecutionScope = { scopeId: 'scope', principal: { kind: 'user', id: 'caller' }, profileId: 'one', surface: 'api', traceId: 'trace' }
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'qwen-plugin-中文 '))
  runner = join(root, 'runner.cjs')
  await build({ entryPoints: ['packages/studio-plugin-runner/src/main.ts'], bundle: true, platform: 'node', target: 'node24.22.1', format: 'cjs', outfile: runner, logLevel: 'silent' })
  await buildAgentPlugins(join(root, 'plugins'))
})
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
afterAll(async () => { await rm(root, { recursive: true, force: true }) })

const fixture = `const fs = require('node:fs');
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
    send({ id: r.id, result: { sessionId: 'qwen-native' } });
  } else if (r.method === 'session/set_model') send({ id: r.id, result: {} });
  else if (r.method === 'session/prompt') {
    prompt = r;
    const text = r.params.prompt[0].text;
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

async function setup(mode: 'global' | 'scoped' = 'global') {
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
  const executionStore = new AgentExecutionStore(db)
  const artifacts = new AgentArtifacts(db, executionStore, () => {})
  const coordinator = new AgentCoordinator({ store: executionStore, registry, events, logger, authorize: () => {}, validateInput: (scope, input) => artifacts.validate(scope, input), context, stateRoot: join(directory, 'state') })
  const host = new PluginHost({ store, registry, events, context, logger, runnerPath: runner, artifactsRoot: join(root, 'installed'),
    eventContext: async (_state, _event, signal) => context(scope, signal), acceptEvents: async batch => { for (const event of batch) events.publish(event) } })
  cleanups.push(async () => { await coordinator.close(); await host.close(); events.close(); db.close() })
  await host.registerSystemArtifact(join(root, 'plugins/qwen-code'))
  await host.configure({ pluginId: 'studio.agent-qwen', profileId: 'one', ownerId: 'installer', enabled: true, config: {}, grants: ['agents.register', 'processes.spawn', 'models.gateway', 'artifacts.read'] }, 0)
  const instance = coordinator.createInstance(scope, { agentTypeId: 'qwen', mode, config: { ...(mode === 'scoped' ? { model: 'fixture/model' } : {}),
    cwd: directory, command: process.execPath, args: [cli], env: { PID_FILE: pidFile, TRACE_FILE: traceFile },
  } })
  const start = (text: string) => coordinator.start(scope, instance.id, { content: [{ type: 'text', text }] }, text)
  const run = async (text: string) => { const r = start(text); await coordinator.wait(r.id); return coordinator.get(scope, r.id) }
  const trace = async () => (await readFile(traceFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  const pid = async () => Number(await readFile(pidFile, 'utf8'))
  return { readArtifact, artifacts, gateway, issued, directory, coordinator, host, store, executionStore, instance, start, run, trace, pid }
}
function alive(pid: number) { try { process.kill(pid, 0); return true } catch { return false } }

it('inspects ACP metadata without creating history or claiming an unknown account state', async () => {
  const f = await setup(), result = await f.coordinator.inspectInstance(scope, f.instance.id)
  expect(result).toMatchObject({ native: { name: 'Qwen Code', version: 'fixture' },
    authentication: { state: 'unknown', methods: [{ id: 'qwen-oauth', name: 'Qwen OAuth' }] }, models: { status: 'unsupported', items: [] } })
  expect(JSON.stringify(result)).not.toMatch(/privateField|secret|KEY/)
  expect((await f.trace()).map(r => r.method)).toEqual(['initialize'])
  expect(alive(await f.pid())).toBe(false)
  expect(await f.run('after-inspect')).toMatchObject({ status: 'completed' })
})

it('applies a new instance configuration without restoring the previous native session', async () => {
  const f = await setup(), before = await f.run('before')
  await f.coordinator.updateInstance(scope, f.instance.id, { revision: 1, config: { ...f.instance.config, model: 'configured-model' }, mode: 'global' })
  expect(await f.run('after')).toMatchObject({ status: 'completed', configRevision: 2 })
  const requests = await f.trace()
  expect(requests.filter(frame => frame.method === 'session/new')).toHaveLength(2)
  expect(requests.filter(frame => frame.method === 'session/load')).toHaveLength(0)
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
