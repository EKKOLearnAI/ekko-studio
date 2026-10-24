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
  root = await mkdtemp(join(tmpdir(), 'codex-plugin-中文 '))
  runner = join(root, 'runner.cjs')
  await build({ entryPoints: ['packages/studio-plugin-runner/src/main.ts'], bundle: true, platform: 'node', target: 'node24.22.1', format: 'cjs', outfile: runner, logLevel: 'silent' })
  await buildAgentPlugins(join(root, 'plugins'))
})
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
afterAll(async () => { await rm(root, { recursive: true, force: true }) })

const fixture = `const fs = require('node:fs');
fs.writeFileSync(process.env.PID_FILE, String(process.pid));
fs.writeFileSync(process.env.PID_FILE + '.home', JSON.stringify({ home: process.env.HOME, codex: process.env.CODEX_HOME, qwen: process.env.QWEN_HOME }));
const send = data => process.stdout.write(JSON.stringify(data) + '\\n');
let turnId, index = 0;
const notify = (method, params) => send({ method, params: { threadId: 'native-thread', turnId, ...params } });
const finish = () => {
  notify('item/completed', { item: { id: 'tool', type: 'commandExecution', command: 'echo fixture', status: 'completed', aggregatedOutput: 'done' } });
  notify('item/completed', { item: { id: 'answer', type: 'agentMessage', text: 'final answer' } });
  notify('turn/completed', { turn: { id: turnId, status: 'completed' } });
};
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const r = JSON.parse(line);
  fs.appendFileSync(process.env.TRACE_FILE, JSON.stringify(r) + '\\n');
  if (r.method === 'initialize') { if (process.env.STARTUP_PHASE === 'initialize') return; send({ id: r.id, result: {} }); }
  else if (r.method === 'account/read') {
    if (process.env.INSPECT_MODE === 'hang') return;
    send({ id: r.id, result: { requiresOpenaiAuth: true, account: { type: 'chatgpt', email: 'private@example.test', planType: 'team', accessToken: 'native-secret' } } });
  } else if (r.method === 'model/list') {
    const model = id => ({ id: 'internal-' + id, model: id, displayName: 'Model ' + id, hidden: false, isDefault: id === 'first', supportedReasoningEfforts: [{ reasoningEffort: 'high', description: 'details' }], privateField: 'native-secret' });
    send({ id: r.id, result: { data: [model(r.params.cursor ? 'second' : 'first')], nextCursor: process.env.INSPECT_MODE === 'loop' || !r.params.cursor ? 'next' : null } });
  }
  else if (r.method === 'thread/start' || r.method === 'thread/resume') { if (process.env.STARTUP_PHASE === 'thread') return; send({ id: r.id, result: { thread: { id: 'native-thread' } } }); }
  else if (r.method === 'turn/start') {
    turnId = 'turn-' + (++index);
    const text = r.params.input[0].text;
    if (text === 'approval-slow') process.on('SIGTERM', () => {
      fs.appendFileSync(process.env.TRACE_FILE, JSON.stringify({ stopping: true }) + '\\n');
      setTimeout(() => process.exit(0), 300);
    });
    if (text === 'crash') { process.exit(7); return; }
    if (text === 'broken') { process.stdout.write('{bad\\n'); return; }
    // Send events before the admission response, including unrelated identities.
    notify('item/agentMessage/delta', { itemId: 'answer', delta: 'streamed' });
    notify('item/agentMessage/delta', { threadId: 'other', itemId: 'answer', delta: 'private' });
    notify('item/agentMessage/delta', { turnId: 'old-turn', itemId: 'answer', delta: 'stale' });
    notify('item/started', { item: { id: 'tool', type: 'commandExecution', command: 'echo fixture', status: 'inProgress' } });
    send({ id: r.id, result: { turn: { id: turnId, status: 'inProgress' } } });
    if (text.startsWith('approval')) send({ id: 'approval', method: 'item/commandExecution/requestApproval', params: {
      threadId: 'native-thread', turnId, itemId: 'tool', command: 'echo fixture', cwd: process.cwd(), availableDecisions: ['accept','decline','cancel'] } });
    else if (text.startsWith('question')) {
      const questions = [
        { id: 'language', header: 'Language', question: 'Which language?', isOther: false, isSecret: false, options: [
          { label: 'TypeScript', description: 'Typed implementation' }, { label: 'JavaScript', description: 'Plain implementation' }] },
        { id: 'style', header: 'Style', question: 'Which style?', isOther: true, isSecret: false, options: [{ label: 'Default', description: 'Use defaults' }] },
        { id: '__proto__', header: 'Notes', question: 'Any notes?', isOther: false, isSecret: false, options: null },
      ];
      if (text === 'question-secret') questions[2].isSecret = true;
      if (text === 'question-duplicate') questions[2].id = 'language';
      send({ id: 'questions', method: 'item/tool/requestUserInput', params: {
        threadId: 'native-thread', turnId, itemId: 'tool', questions, isBlocking: true, autoResolutionMs: null } });
      if (text === 'question-immediate') { notify('serverRequest/resolved', { requestId: 'questions' }); finish(); }
      if (text === 'question-withdraw' || text === 'question-complete') {
        const timer = setInterval(() => { if (!fs.existsSync(process.env.CONTROL_FILE)) return;
          clearInterval(timer);
          if (text === 'question-withdraw') notify('serverRequest/resolved', { requestId: 'questions' });
          finish();
        }, 10);
      }
    }
    else if (text === 'unresolved') notify('turn/completed', { turn: { id: turnId, status: 'completed' } });
    else finish();
  } else if (r.id === 'approval' && r.result?.decision === 'accept') finish();
  else if (r.id === 'questions') {
    notify('serverRequest/resolved', { requestId: 'questions' });
    finish();
  }
  else if (r.method === 'turn/interrupt') {
    send({ id: r.id, result: {} });
    notify('turn/completed', { turn: { id: turnId, status: 'interrupted' } });
  }
});`

async function setup(env: Record<string, string> = {}, mode: 'global' | 'scoped' = 'global') {
  const directory = await mkdtemp(join(root, 'run-')), cli = join(directory, 'codex.cjs')
  const pidFile = join(directory, 'pid'), traceFile = join(directory, 'trace'), controlFile = join(directory, 'control')
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
  await host.registerSystemArtifact(join(root, 'plugins/codex'))
  await host.configure({ pluginId: 'studio.agent-codex', profileId: 'one', ownerId: 'installer', enabled: true, config: {}, grants: ['agents.register', 'processes.spawn', 'models.gateway', 'artifacts.read'] }, 0)
  const instance = coordinator.createInstance(scope, { agentTypeId: 'codex', mode, config: { ...(mode === 'scoped' ? { model: 'fixture/model' } : {}),
    cwd: directory, command: process.execPath, args: [cli], env: { PID_FILE: pidFile, TRACE_FILE: traceFile, CONTROL_FILE: controlFile, ...env },
  } })
  const start = (text: string) => coordinator.start(scope, instance.id, { content: [{ type: 'text', text }] }, text)
  const run = async (text: string) => { const r = start(text); await coordinator.wait(r.id); return coordinator.get(scope, r.id) }
  const trace = async () => (await readFile(traceFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  const pid = async () => Number(await readFile(pidFile, 'utf8'))
  const reopen = async () => {
    await coordinator.close()
    const next = new AgentCoordinator({ store: executionStore, registry, events, logger, authorize: () => {}, context, stateRoot: join(directory, 'state') })
    cleanups.push(() => next.close())
    return next
  }
  return { readArtifact, artifacts, gateway, issued, directory, coordinator, host, store, registry, executionStore, instance, start, run, trace, pid, reopen, controlFile }
}
function alive(pid: number) { try { process.kill(pid, 0); return true } catch { return false } }

it('inspects account state and paginated native models through a worker without exposing private fields', async () => {
  const f = await setup()
  expect(f.registry.list('one')[0].management).toEqual({ inspect: true })
  const result = await f.coordinator.inspectInstance(scope, f.instance.id)
  expect(result).toMatchObject({ native: { name: 'Codex' }, authentication: { state: 'authenticated', methods: [] }, models: { status: 'available', items: [
    { id: 'first', name: 'Model first', isDefault: true, reasoningEfforts: ['high'] },
    { id: 'second', name: 'Model second', isDefault: false, reasoningEfforts: ['high'] },
  ] } })
  expect(JSON.stringify(result)).not.toMatch(/private|native-secret|email|accessToken/)
  const trace = await f.trace()
  expect(trace.filter(r => r.method === 'account/read')[0].params).toEqual({ refreshToken: false })
  expect(trace.some(r => r.method?.startsWith('thread/') || r.method?.startsWith('turn/'))).toBe(false)
  expect(alive(await f.pid())).toBe(false)
  expect(await f.run('after-inspect')).toMatchObject({ status: 'completed' })
})

it('rejects a cycling native model cursor and disposes the inspection process', async () => {
  const f = await setup({ INSPECT_MODE: 'loop' })
  await expect(f.coordinator.inspectInstance(scope, f.instance.id)).rejects.toMatchObject({ code: 'INTERNAL' })
  expect(alive(await f.pid())).toBe(false)
  expect((await f.trace()).filter(r => r.method === 'model/list')).toHaveLength(2)
})

it('cancels a hung native inspection and keeps the plugin available', async () => {
  const f = await setup({ INSPECT_MODE: 'hang' }), controller = new AbortController()
  const pending = f.coordinator.inspectInstance(scope, f.instance.id, controller.signal)
  await vi.waitFor(async () => expect((await f.trace()).some(r => r.method === 'account/read')).toBe(true))
  expect(f.host.diagnostic('studio.agent-codex', 'one').hasActiveLeases).toBe(true)
  await expect(f.host.configure({ pluginId: 'studio.agent-codex', profileId: 'one', ownerId: 'installer', enabled: false, config: {}, grants: [] }, 1)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
  controller.abort()
  await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' })
  expect(alive(await f.pid())).toBe(false)
  await vi.waitFor(() => expect(f.host.diagnostic('studio.agent-codex', 'one').hasActiveLeases).toBe(false))
  expect(await f.run('after-cancelled-inspection')).toMatchObject({ status: 'completed' })
})

it('revokes managed process access during native inspection', async () => {
  const f = await setup({ INSPECT_MODE: 'hang' })
  const pending = f.coordinator.inspectInstance(scope, f.instance.id).catch(error => error)
  await vi.waitFor(async () => expect((await f.trace()).some(r => r.method === 'account/read')).toBe(true))
  const profile = f.store.profile('studio.agent-codex', 'one')!
  f.store.saveProfile({ ...profile, grants: ['agents.register'] }, profile.revision)
  expect(await pending).toMatchObject({ code: 'FORBIDDEN' })
  expect(alive(await f.pid())).toBe(false)
})

it('loads the Codex bundle in a worker, routes approvals and reuses a native process across turns', async () => {
  const f = await setup(), first = f.start('approval')
  await vi.waitFor(() => expect(f.coordinator.get(scope, first.id).status).toBe('waiting_input'))
  const pid = await f.pid()
  const interaction = f.coordinator.interactions(scope, first.id)[0]
  await f.coordinator.respond(scope, first.id, { interactionId: interaction.id, idempotencyKey: 'yes', choiceId: 'accept' })
  await f.coordinator.wait(first.id)
  expect(f.coordinator.get(scope, first.id).status).toBe('completed')
  const output = f.coordinator.output(scope, first.id, -1)
  expect(output.filter(e => e.type === 'message.delta')).toEqual([expect.objectContaining({ text: 'streamed' })])
  expect(output).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'message.snapshot', text: 'final answer' })]))
  expect(f.coordinator.usage(scope, first.id)).toEqual([])
  expect(alive(pid)).toBe(true)
  const second = await f.run('next')
  expect(second.status).toBe('completed')
  expect(await f.pid()).toBe(pid)
  expect((await f.trace()).filter(r => r.method === 'initialize')).toHaveLength(1)
  expect((await f.trace()).filter(r => r.method === 'thread/start')).toHaveLength(1)
  await f.coordinator.close()
  expect(alive(pid)).toBe(false)
})

it('interrupts an approval turn and confirms native process shutdown', async () => {
  const f = await setup(), run = f.start('approval')
  await vi.waitFor(() => expect(f.coordinator.get(scope, run.id).status).toBe('waiting_input'))
  const pid = await f.pid()
  await f.coordinator.cancel(scope, run.id)
  await f.coordinator.wait(run.id)
  expect(f.coordinator.get(scope, run.id).status).toBe('cancelled')
  expect(alive(pid)).toBe(false)
  expect(await f.trace()).toEqual(expect.arrayContaining([expect.objectContaining({ method: 'turn/interrupt', params: { threadId: 'native-thread', turnId: 'turn-1' } })]))
})

it('restores the committed native thread after releasing its runtime lease', async () => {
  const f = await setup()
  expect(await f.run('first')).toMatchObject({ status: 'completed' })
  const firstPid = await f.pid(), coordinator = await f.reopen()
  expect(alive(firstPid)).toBe(false)
  const run = coordinator.start(scope, f.instance.id, { content: [{ type: 'text', text: 'restored' }] }, 'restored')
  await coordinator.wait(run.id)
  expect(coordinator.get(scope, run.id).status).toBe('completed')
  expect(await f.pid()).not.toBe(firstPid)
  expect((await f.trace()).filter(r => r.method === 'thread/resume')).toEqual([
    expect.objectContaining({ params: expect.objectContaining({ threadId: 'native-thread' }) }),
  ])
})

it('releases a real worker runtime before changing config and starts a fresh native thread', async () => {
  const f = await setup(), before = await f.run('before'), pid = await f.pid()
  await expect(f.coordinator.updateInstance(scope, f.instance.id, { revision: 1, config: f.instance.config, mode: 'unsupported' as any })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  expect(alive(pid)).toBe(true)
  await f.coordinator.updateInstance(scope, f.instance.id, { revision: 1, config: { ...f.instance.config, model: 'configured-model' }, mode: 'global' })
  expect(alive(pid)).toBe(false)
  expect(await f.run('after')).toMatchObject({ status: 'completed', configRevision: 2 })
  expect(await f.pid()).not.toBe(pid)
  const requests = await f.trace()
  expect(requests.filter(frame => frame.method === 'thread/start')).toHaveLength(2)
  expect(requests.filter(frame => frame.method === 'thread/resume')).toHaveLength(0)
  expect(requests.filter(frame => frame.method === 'turn/start').at(-1).params.model).toBe('configured-model')
  expect(f.coordinator.get(scope, before.id)).toMatchObject({ status: 'completed', configRevision: 1 })
})

it('routes multi-question native input with exact choice labels and free text', async () => {
  const f = await setup(), run = f.start('question')
  await vi.waitFor(() => expect(f.coordinator.interactions(scope, run.id)).toHaveLength(3))
  const interactions = f.coordinator.interactions(scope, run.id)
  expect(interactions[0]).toMatchObject({ allowText: false, choices: [{ id: 'option-0', label: 'TypeScript', description: 'Typed implementation' }, { id: 'option-1' }] })
  const answer = { interactionId: interactions[0].id, idempotencyKey: 'language' }
  await expect(f.coordinator.respond(scope, run.id, { ...answer, text: 'Other' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  await f.coordinator.respond(scope, run.id, { ...answer, choiceId: 'option-1' })
  expect(f.coordinator.get(scope, run.id).status).toBe('waiting_input')
  await f.coordinator.respond(scope, run.id, { interactionId: interactions[2].id, idempotencyKey: 'notes', text: 'Keep history' })
  await f.coordinator.respond(scope, run.id, { interactionId: interactions[1].id, idempotencyKey: 'style', text: 'Custom style' })
  await f.coordinator.wait(run.id)
  expect(f.coordinator.get(scope, run.id).status).toBe('completed')
  expect(f.coordinator.interactions(scope, run.id).map(item => item.status)).toEqual(['resolved', 'resolved', 'resolved'])
  const reply = (await f.trace()).find(frame => frame.id === 'questions')
  expect(reply.result.answers).toEqual(JSON.parse('{"language":{"answers":["JavaScript"]},"style":{"answers":["Custom style"]},"__proto__":{"answers":["Keep history"]}}'))
  expect(await f.run('next')).toMatchObject({ status: 'completed' })
})

it.each(['question-withdraw', 'question-complete'])('withdraws unanswered native questions without sending invented answers: %s', async text => {
  const f = await setup(), run = f.start(text)
  await vi.waitFor(() => expect(f.coordinator.interactions(scope, run.id)).toHaveLength(3))
  const first = f.coordinator.interactions(scope, run.id)[0]
  await writeFile(f.controlFile, 'continue')
  await f.coordinator.wait(run.id)
  expect(f.coordinator.get(scope, run.id).status).toBe('completed')
  expect(f.coordinator.interactions(scope, run.id).map(item => item.status)).toEqual(['withdrawn', 'withdrawn', 'withdrawn'])
  expect((await f.trace()).some(frame => frame.id === 'questions')).toBe(false)
  await expect(f.coordinator.respond(scope, run.id, { interactionId: first.id, idempotencyKey: 'late', choiceId: 'option-0' })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
  expect(await f.run('next')).toMatchObject({ status: 'completed' })
})

it.each(['question-secret', 'question-duplicate'])('rejects an unrepresentable native question set before persisting any prompt: %s', async text => {
  const f = await setup(), run = await f.run(text)
  expect(run.status).toBe('completed') // The native fixture handles the explicit RPC failure.
  expect(f.coordinator.interactions(scope, run.id)).toEqual([])
  expect((await f.trace()).find(frame => frame.id === 'questions')).toEqual({ id: 'questions', error: { code: -32000, message: 'Client request failed' } })
})

it('suppresses a request withdrawn before its asynchronous callback begins', async () => {
  const f = await setup(), run = await f.run('question-immediate')
  expect(run.status).toBe('completed')
  expect(f.coordinator.interactions(scope, run.id).every(item => item.status === 'withdrawn')).toBe(true)
  expect((await f.trace()).some(frame => frame.id === 'questions')).toBe(false)
})

it('cancels all questions and closes the owned native process', async () => {
  const f = await setup(), run = f.start('question')
  await vi.waitFor(() => expect(f.coordinator.interactions(scope, run.id)).toHaveLength(3))
  const pid = await f.pid()
  await f.coordinator.cancel(scope, run.id)
  await f.coordinator.wait(run.id)
  expect(f.coordinator.get(scope, run.id).status).toBe('cancelled')
  expect(alive(pid)).toBe(false)
  expect((await f.trace()).some(frame => frame.id === 'questions')).toBe(false)
  expect(f.coordinator.interactions(scope, run.id).every(item => !['pending', 'responding'].includes(item.status))).toBe(true)
})

it.skipIf(process.platform === 'win32')('keeps cancellation pending until the native process actually exits', async () => {
  const f = await setup(), run = f.start('approval-slow')
  await vi.waitFor(() => expect(f.coordinator.get(scope, run.id).status).toBe('waiting_input'))
  const pid = await f.pid()
  await f.coordinator.cancel(scope, run.id)
  await vi.waitFor(async () => expect((await f.trace()).some(frame => frame.stopping)).toBe(true))
  expect(alive(pid)).toBe(true)
  expect(f.coordinator.get(scope, run.id).status).toBe('cancelling')
  await f.coordinator.wait(run.id)
  expect(f.coordinator.get(scope, run.id).status).toBe('cancelled')
  expect(alive(pid)).toBe(false)
})

it.each(['crash', 'broken', 'unresolved'])('fails an incomplete native run and leaves the plugin usable: %s', async text => {
  const f = await setup(), run = await f.run(text)
  expect(run.status).toBe('failed')
  expect(alive(await f.pid())).toBe(false)
  expect(await f.run('fresh')).toMatchObject({ status: 'completed' })
  expect((await f.trace()).filter(r => r.method === 'thread/start')).toHaveLength(2)
})


it('runs scoped Codex with fresh per-turn credentials and a stable isolated native home through worker RPC', async () => {
  const f = await setup({}, 'scoped')
  expect(await f.run('first')).toMatchObject({ status: 'completed' })
  const firstPid = await f.pid(), firstHome = JSON.parse(await readFile(join(f.directory, 'pid.home'), 'utf8'))
  expect(alive(firstPid)).toBe(false)
  expect(firstHome.codex).toContain(join(f.directory, 'state'))
  expect(await f.run('second')).toMatchObject({ status: 'completed' })
  expect(await f.pid()).not.toBe(firstPid)
  expect(JSON.parse(await readFile(join(f.directory, 'pid.home'), 'utf8'))).toEqual(firstHome)
  const trace = await f.trace()
  expect(trace.filter(frame => frame.method === 'thread/start')).toHaveLength(1)
  expect(trace.filter(frame => frame.method === 'thread/resume')).toHaveLength(1)
  expect(f.issued).toHaveLength(2)
  expect(f.issued[0].runId).not.toBe(f.issued[1].runId)
  for (const gateway of f.issued) { expect(gateway).toMatchObject({ model: 'fixture/model', protocol: 'responses' }); expect(gateway.dispose).toHaveBeenCalled() }
  expect(await readFile(join(firstHome.codex, 'config.toml'), 'utf8')).not.toContain('ephemeral-')
})

it('cancels scoped Codex approvals, revokes the model lease and confirms native exit', async () => {
  const f = await setup({}, 'scoped'), run = f.start('approval')
  await vi.waitFor(() => expect(f.coordinator.get(scope, run.id).status).toBe('waiting_input'))
  const pid = await f.pid()
  f.coordinator.cancel(scope, run.id)
  await f.coordinator.wait(run.id)
  expect(alive(pid)).toBe(false)
  expect(f.issued[0].dispose).toHaveBeenCalled()
  expect(f.coordinator.get(scope, run.id).status).toBe('cancelled')
})

it('does not inspect the global account for a scoped Codex instance', async () => {
  const f = await setup({}, 'scoped')
  await expect(f.coordinator.inspectInstance(scope, f.instance.id)).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' })
  await expect(f.pid()).rejects.toMatchObject({ code: 'ENOENT' })
})


it.each(['initialize', 'thread'])('cancels scoped Codex during native %s admission without retaining a subprocess', async phase => {
  const f = await setup({ STARTUP_PHASE: phase }, 'scoped'), run = f.start('pending-start')
  await vi.waitFor(async () => expect((await f.trace()).some(frame => frame.method === (phase === 'thread' ? 'thread/start' : 'initialize'))).toBe(true))
  const pid = await f.pid()
  f.coordinator.cancel(scope, run.id)
  await f.coordinator.wait(run.id)
  expect(alive(pid)).toBe(false)
  expect(f.issued[0].dispose).toHaveBeenCalled()
  expect(f.coordinator.get(scope, run.id).status).toBe('cancelled')
})

for (const mode of ['global', 'scoped'] as const) it(`passes owned image bytes through the real worker in ${mode} mode`, async () => {
  const f = await setup({}, mode)
  const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } }).png().toBuffer()
  const image = await f.artifacts.create(scope, bytes, new AbortController().signal)
  const input = { content: [{ type: 'text' as const, text: 'describe image' }, { type: 'image' as const, artifactId: image.id, mediaType: image.mediaType }] }
  const run = f.coordinator.start(scope, f.instance.id, input, 'image')
  await f.coordinator.wait(run.id)
  expect(f.coordinator.get(scope, run.id)).toMatchObject({ status: 'completed' })
  const requests = await f.trace()
  expect(requests.find(r => r.method === 'turn/start').params.input).toContainEqual({ type: 'image', url: `data:image/png;base64,${bytes.toString('base64')}` })
  expect(JSON.stringify(f.coordinator.output(scope, run.id, -1))).not.toContain(bytes.toString('base64'))
  expect(await f.run('continue after image')).toMatchObject({ status: 'completed' })
  expect(() => f.artifacts.read({ ...scope, runId: run.id }, image.id)).toThrow(/live Run/)
})

it('rejects scoped image input on a model without vision before native admission', async () => {
  const f = await setup({}, 'scoped')
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
    const profile = f.store.profile('studio.agent-codex', 'one')!
    f.store.saveProfile({ ...profile, grants: profile.grants.filter(value => value !== 'artifacts.read') }, profile.revision)
  } finally { release() }
  await f.coordinator.wait(run.id)
  expect(f.coordinator.get(scope, run.id)).toMatchObject({ status: 'failed', errorCode: 'FORBIDDEN' })
  expect((await f.trace()).some(request => request.method === 'turn/start')).toBe(false)
})
