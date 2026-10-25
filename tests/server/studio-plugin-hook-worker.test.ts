import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { PluginHost } from '../../packages/server/src/modules/studio/services/plugins/host'
import { PluginStore } from '../../packages/server/src/modules/studio/repositories/plugin-store'
import { PluginHookRegistry } from '../../packages/server/src/modules/studio/services/events/plugin-hooks'
import { AgentRegistry } from '../../packages/server/src/modules/studio/services/agents/registry'
import { PluginEventBus } from '../../packages/server/src/modules/studio/services/events/plugin-events'
import { createExecutionContext } from '../../packages/server/src/modules/studio/services/context/execution'
import { AgentCoordinator } from '../../packages/server/src/modules/studio/services/agents/coordinator'
import { AgentRunAdmission } from '../../packages/server/src/modules/studio/services/agents/admission'
import { AgentExecutionStore } from '../../packages/server/src/modules/studio/repositories/agent-execution-store'
import type { ExecutionScope, PluginManifest, EventEnvelope, AgentRunInput } from '../../packages/studio-plugin-sdk/src'

let root: string, runner: string
const cleanup: Array<() => Promise<void>> = []
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'studio-hooks-')); runner = join(root, 'runner.cjs')
  await build({ entryPoints: ['packages/studio-plugin-runner/src/main.ts'], bundle: true, platform: 'node', target: 'node24.22.1', format: 'cjs', outfile: runner, logLevel: 'silent' })
})
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
afterAll(async () => { await rm(root, { force: true, recursive: true }) })
const caller: ExecutionScope = { scopeId: 'caller', traceId: 'original', profileId: 'one', principal: { kind: 'user', id: '7' }, surface: 'api' }
const request = { instanceId: 'instance', idempotencyKey: 'key', input: { content: [{ type: 'text' as const, text: 'original' }] } }
const dependency = { id: 'test.provider/service@1', version: '^1.0.0', optional: true }
async function setup(source: string, capabilities = ['hooks.before:runs.start'], options: ConstructorParameters<typeof PluginHookRegistry>[0] = {}) {
  const db = new DatabaseSync(':memory:'), store = new PluginStore(db), registry = new AgentRegistry(), events = new PluginEventBus(), hooks = new PluginHookRegistry(options)
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, read = vi.fn(async () => null), remove = vi.fn(async () => ({ deleted: true, native: { attempted: false, deleted: false, profileId: 'one' } }))
  const authorize = vi.fn(async () => {}), emitted: EventEnvelope[] = []
  const context = (scope: ExecutionScope, signal: AbortSignal) => createExecutionContext(scope, signal, logger, { authorize, agents: { list: async () => [] }, sessions: { get: read, remove },
    runs: { start: (scope, input, signal) => admission.start(scope, input, signal), get: async (scope, id) => coordinator.get(scope, id), output: async (scope, id, after) => coordinator.output(scope, id, after) },
  })
  const runStore = new AgentExecutionStore(db), coordinator = new AgentCoordinator({ store: runStore, registry, events, logger, authorize: () => {}, context })
  const admission = new AgentRunAdmission(coordinator, hooks, context), inputs: AgentRunInput[] = []
  const builtin = registry.stage('*', { kind: 'builtin', module: 'ekko', implementationVersion: 'fixture' }, ['ekko'])
  builtin.register({ id: 'ekko', name: 'Fixture', configSchema: {}, capabilities: { text: true, modes: ['scoped'] }, create: async () => ({
    run: async input => { inputs.push(input); return { events: (async function* () {})(), result: Promise.resolve({ status: 'completed' as const }), cancel: async () => {} } }, dispose: async () => {},
  }) }); builtin.commit()
  const instance = coordinator.createInstance(caller, { agentTypeId: 'ekko', mode: 'scoped', config: {} })
  const host = new PluginHost({ store, registry, events, hooks, context, logger, runnerPath: runner, artifactsRoot: join(root, 'artifacts'),
    eventContext: async (state, _event, signal) => context({ ...caller, principal: { kind: 'user', id: caller.principal.id } }, signal), acceptEvents: async batch => { emitted.push(...batch); for (const event of batch) events.publish(event) },
  })
  cleanup.push(async () => { await coordinator.close(); await host.close(); events.close(); db.close() })
  const manifest: PluginManifest = { schemaVersion: 1, id: 'test.hook', version: '1.0.0', engines: { studioSdk: '^0.1.0', rpc: 1 }, backend: 'index.cjs', activation: 'profile',
    contributes: { agents: [], events: { 'test.hook:probe': {} } }, requires: { capabilities, services: [dependency] },
    configSchema: { type: 'object', properties: { instanceId: { type: 'string' } }, additionalProperties: false } }
  const directory = await mkdtemp(join(root, 'artifact-'))
  await writeFile(join(directory, 'studio-plugin.json'), JSON.stringify(manifest)); await writeFile(join(directory, 'index.cjs'), source)
  await host.install(directory)
  const state = { pluginId: manifest.id, profileId: 'one', ownerId: '1', enabled: true, config: { instanceId: instance.id }, grants: capabilities }
  const messages = () => logger.info.mock.calls.filter(call => call[0] === 'Plugin stdout').map(call => String((call[1] as { text: string }).text)).join('')
  return { host, store, state, hooks, events, coordinator, runStore, inputs, read, remove, authorize, emitted, context: () => context(caller, new AbortController().signal), messages }
}

it('narrows a real hook context and denies RPC mutations, service calls and deferred global emission', async () => {
  const f = await setup(`let scopeHandle; process.prependListener('message', frame => { if (frame.method === 'hook.invoke') scopeHandle = frame.params.scopeHandle; });
    module.exports = { async apply(plugin) {
      const service = plugin.services.use(${JSON.stringify(dependency)});
      await plugin.emit('test.hook:probe', { phase: 'activation' });
      plugin.hooks.before('runs.start', async (input, ctx) => {
        await ctx.sessions.get('session');
        const results = [typeof ctx.sessions.remove, typeof ctx.runs.start, ctx.scope.principal.id, Object.isFrozen(input.input.content[0])];
        const denied = await new Promise(resolve => {
          const listener = frame => { if (frame.id === 900000 && frame.kind === 'error') { process.removeListener('message', listener); resolve(frame.error.code); } };
          process.on('message', listener);
          process.send({ kind: 'request', id: 900000, method: 'context.call', params: { scopeHandle, method: 'sessions.remove', args: { id: 'session' } } });
        }); results.push(denied);
        for (const invoke of [() => service.call(ctx, 'write', null), () => plugin.emit('test.hook:probe', {})]) {
          try { await invoke(); results.push('unexpected') } catch (error) { results.push(error.code) }
        }
        setTimeout(async () => { try { await plugin.emit('test.hook:probe', {}) } catch (error) { plugin.logger.info('deferred', { code: error.code }) } }, 30);
        plugin.logger.info('checks', { results });
        return { action: 'patch', patch: { content: [{ type: 'text', text: 'approved' }], timeoutMs: 500 } };
      }, { key: 'policy', priority: 10 });
    } }`, ['hooks.before:runs.start', 'sessions.read', 'sessions.remove', 'services.use:test.provider/service@1', 'events.emit:test.hook:probe'])
  await f.host.configure(f.state, 0)
  const result = await f.hooks.run('runs.start', request, f.context())
  expect(result.input.input).toEqual({ content: [{ type: 'text', text: 'approved' }], timeoutMs: 500 })
  expect(result.snapshot).toEqual([{ point: 'runs.start', pluginId: 'test.hook', generation: expect.any(String), key: 'policy', priority: 10 }])
  await vi.waitFor(() => expect(f.messages()).toContain('deferred'))
  expect(f.messages()).toContain('"results":["undefined","undefined","7",true,"FORBIDDEN","FORBIDDEN","FORBIDDEN"]')
  expect(f.messages()).toContain('"code":"FORBIDDEN"')
  expect(f.authorize).toHaveBeenCalledWith(expect.objectContaining({ principal: { kind: 'user', id: '7' } }), 'sessions.read', 'session')
  expect(f.read).toHaveBeenCalledTimes(1); expect(f.remove).not.toHaveBeenCalled()
  expect(f.emitted.map(event => event.type)).toEqual(['test.hook:probe', 'plugin.ready'])
  await f.host.configure({ ...f.state, enabled: false }, 1)
  expect(f.hooks.has('one', 'runs.start')).toBe(false)
})

it.each(['crash', 'deadline'])('fails a real %s hook and withdraws its contribution', async failure => {
  const f = await setup(`module.exports = { apply(plugin) { plugin.hooks.before('runs.start', async () => {
    ${failure === 'crash' ? 'process.exit(9)' : 'await new Promise(() => {})'}
    return { action: 'continue' };
  }, { key: 'failure' }); } }`, ['hooks.before:runs.start'], { timeoutMs: 50 })
  await f.host.configure(f.state, 0)
  await expect(f.hooks.run('runs.start', request, f.context())).rejects.toMatchObject({ code: failure === 'crash' ? 'PLUGIN_UNAVAILABLE' : 'DEADLINE_EXCEEDED' })
  await vi.waitFor(() => expect(f.hooks.has('one', 'runs.start')).toBe(false))
  expect(f.host.diagnostic('test.hook', 'one').state).toBe('failed')
})

it('checks hook grants again after a delayed real callback returns', async () => {
  const gate = join(root, `gate-${Date.now()}`)
  const f = await setup(`const fs = require('node:fs'); module.exports = { apply(plugin) { plugin.hooks.before('runs.start', async () => {
    plugin.logger.info('entered'); while (!fs.existsSync(${JSON.stringify(gate)})) await new Promise(resolve => setTimeout(resolve, 5));
    return { action: 'continue' };
  }, { key: 'gate' }); } }`)
  await f.host.configure(f.state, 0)
  const pending = f.hooks.run('runs.start', request, f.context())
  const rejected = expect(pending).rejects.toMatchObject({ code: 'FORBIDDEN' })
  await vi.waitFor(() => expect(f.messages()).toContain('entered'))
  f.store.saveProfile({ ...f.state, grants: [] }, 1); await writeFile(gate, 'release')
  await rejected
})

it('rejects undeclared hooks before publishing the plugin', async () => {
  const f = await setup(`module.exports = { apply(plugin) { plugin.hooks.before('sessions.remove', () => ({ action: 'continue' }), { key: 'remove' }); } }`)
  await expect(f.host.configure(f.state, 0)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(f.hooks.has('one', 'sessions.remove')).toBe(false)
  expect(f.emitted).toEqual([expect.objectContaining({ type: 'plugin.failed',
    data: { pluginId: f.state.pluginId, generation: expect.any(String) },
  })])
})

it('preserves an authorized ordinary event callback while a hook executes in the same worker', async () => {
  const entered = join(root, `entered-${Date.now()}`), release = join(root, `release-${Date.now()}`)
  const f = await setup(`const fs = require('node:fs'); module.exports = { apply(plugin) {
    plugin.on('plugin.ready', async () => {
      while (!fs.existsSync(${JSON.stringify(entered)})) await new Promise(resolve => setTimeout(resolve, 5));
      await plugin.emit('test.hook:probe', { phase: 'ordinary' }); fs.writeFileSync(${JSON.stringify(release)}, 'ok');
    });
    plugin.hooks.before('runs.start', async () => {
      fs.writeFileSync(${JSON.stringify(entered)}, 'ok');
      while (!fs.existsSync(${JSON.stringify(release)})) await new Promise(resolve => setTimeout(resolve, 5));
      return { action: 'continue' };
    }, { key: 'parallel' });
  } }`, ['hooks.before:runs.start', 'events.subscribe:plugin.ready', 'events.emit:test.hook:probe'])
  await f.host.configure(f.state, 0)
  await expect(f.hooks.run('runs.start', request, f.context())).resolves.toMatchObject({ input: request })
  await f.events.idle()
  expect(f.emitted.find(event => event.type === 'test.hook:probe')?.data).toEqual({ phase: 'ordinary' })
})

it('routes a real SDK start through a hook in the same worker without deadlock or duplicate execution', async () => {
  const f = await setup(`module.exports = { apply(plugin) {
    plugin.hooks.before('runs.start', () => ({ action: 'patch', patch: { content: [{ type: 'text', text: 'hook input' }] } }), { key: 'rewrite' });
    plugin.on('plugin.ready', async (_event, ctx) => {
      const request = { instanceId: plugin.config.instanceId, input: { content: [{ type: 'text', text: 'original' }] }, idempotencyKey: 'from-worker' };
      const [one, two] = await Promise.all([ctx.runs.start(request), ctx.runs.start(request)]);
      plugin.logger.info('accepted', { id: one.id, same: one.id === two.id, owner: one.ownerId, hooks: one.hooks });
    });
  } }`, ['hooks.before:runs.start', 'runs.start', 'events.subscribe:plugin.ready'])
  await f.host.configure(f.state, 0); await f.events.idle()
  await vi.waitFor(() => expect(f.messages()).toContain('accepted'))
  const result = f.messages().trim().split('\n').map(line => JSON.parse(line)).find(value => value.message === 'accepted').data
  expect(result).toMatchObject({ same: true, owner: '7', hooks: [{ pluginId: 'test.hook', key: 'rewrite' }] })
  await f.coordinator.wait(result.id)
  expect(f.inputs).toEqual([{ content: [{ type: 'text', text: 'hook input' }] }])
  expect(f.runStore.get(result.id)?.status).toBe('completed')
})

it('cannot borrow a live event context to start model work from a read-only hook', async () => {
  const f = await setup(`module.exports = { apply(plugin) {
    let captured, release;
    plugin.on('plugin.ready', async (_event, ctx) => { captured = ctx; plugin.logger.info('captured'); await new Promise(resolve => release = resolve); });
    plugin.hooks.before('runs.start', async () => {
      try { await captured.models.stream({ model: 'p/m', input: 'forbidden', idempotencyKey: 'borrowed' }); }
      catch (error) { plugin.logger.info('borrowed-denied', { code: error.code }); }
      finally { release(); }
      return { action: 'continue' };
    }, { key: 'borrow' });
  } }`, ['hooks.before:runs.start', 'events.subscribe:plugin.ready', 'models.stream'])
  await f.host.configure(f.state, 0)
  await vi.waitFor(() => expect(f.messages()).toContain('captured'))
  await f.hooks.run('runs.start', request, f.context())
  await f.events.idle()
  await vi.waitFor(() => expect(f.messages()).toContain('borrowed-denied'))
  expect(f.messages()).toContain('FORBIDDEN')
  expect(f.messages()).not.toContain('CAPABILITY_UNSUPPORTED')
})
