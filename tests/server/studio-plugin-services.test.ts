import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { PluginHost } from '../../packages/server/src/modules/studio/services/plugins/host'
import { PluginStore } from '../../packages/server/src/modules/studio/repositories/plugin-store'
import { PluginEventStore } from '../../packages/server/src/modules/studio/repositories/plugin-event-store'
import { AgentRegistry } from '../../packages/server/src/modules/studio/services/agents/registry'
import { PluginEventBus } from '../../packages/server/src/modules/studio/services/events/plugin-events'
import { createExecutionContext } from '../../packages/server/src/modules/studio/services/context/execution'
import { parseManifest } from '../../packages/server/src/modules/studio/services/plugins/validation'
import { pluginActivationOrder } from '../../packages/server/src/modules/studio/services/plugins/dependencies'
import { PluginServiceRegistry } from '../../packages/server/src/modules/studio/services/plugins/services'
import type { AgentRunContext, ExecutionScope, PluginManifest, ServiceToken } from '../../packages/studio-plugin-sdk/src'

let root: string, runner: string
const cleanup: Array<() => Promise<void>> = []
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'studio-services-'))
  runner = join(root, 'runner.cjs')
  await build({ entryPoints: ['packages/studio-plugin-runner/src/main.ts'], bundle: true, platform: 'node', target: 'node24.22.1', format: 'cjs', outfile: runner, logLevel: 'silent' })
})
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
afterAll(async () => { await rm(root, { force: true, recursive: true }) })

const token: ServiceToken = { id: 'test.provider/echo@1', version: '1.2.0', methods: {
  echo: { input: { type: 'string' }, output: { type: 'object' } },
  read: { input: {}, output: {} },
  invalid: { input: {}, output: { type: 'string' } },
} }
const dependency = { id: token.id, version: '^1.0.0' }
const scope: ExecutionScope = { scopeId: 'original', traceId: 'trace', profileId: 'one', principal: { kind: 'user', id: 'caller' }, surface: 'event' }
function manifest(id: string, provides: ServiceToken[] = [], required: PluginManifest['requires']['services'] = [], capabilities: string[] = []): PluginManifest {
  return { schemaVersion: 1, id, version: '1.0.0', engines: { studioSdk: '^0.1.0', rpc: 1 }, backend: 'index.cjs', activation: 'profile', configSchema: {},
    contributes: { agents: [], services: provides }, requires: { services: required, capabilities: [
      ...provides.map(value => `services.provide:${value.id}`), ...required.map(value => `services.use:${value.id}`), ...capabilities,
    ] } }
}
function setup() {
  const db = new DatabaseSync(':memory:'), store = new PluginStore(db), registry = new AgentRegistry(), events = new PluginEventBus()
  const eventStore = new PluginEventStore(db)
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, read = vi.fn(async () => ({ id: 'session', profileId: 'one', title: 'read', agentTypeId: 'fixture', archived: false }))
  const context = (scope: ExecutionScope, signal: AbortSignal) => createExecutionContext(scope, signal, logger, {
    authorize: async () => {}, sessions: { get: read }, agents: { list: async profile => registry.list(profile) },
  })
  const host = new PluginHost({ store, registry, events, context, logger, runnerPath: runner, artifactsRoot: join(root, 'artifacts'),
    eventContext: async (state, event, signal) => context({ ...scope, profileId: event.subject.profileId || scope.profileId, principal: { kind: 'user', id: scope.principal.id }, traceId: event.correlationId }, signal),
    acceptEvents: async batch => { for (const event of eventStore.append(batch)) events.publish(event) },
  })
  cleanup.push(async () => { await host.close(); events.close(); db.close() })
  const install = async (value: PluginManifest, source: string) => {
    const directory = await mkdtemp(join(root, 'artifact-'))
    await writeFile(join(directory, 'studio-plugin.json'), JSON.stringify(value))
    await writeFile(join(directory, 'index.cjs'), source)
    return host.install(directory)
  }
  const state = (value: PluginManifest, profileId = 'one') => ({ pluginId: value.id, profileId, ownerId: value.id === 'test.provider' ? 'provider-owner' : 'caller', enabled: true, config: {}, grants: value.requires.capabilities })
  const output = (name: string) => logger.info.mock.calls.filter(call => call[0] === 'Plugin stdout')
    .flatMap(call => String((call[1] as { text: string }).text).trim().split('\n')).map(line => JSON.parse(line)).filter(value => value.message === name)
  return { host, store, registry, events, eventStore, context, logger, read, install, state, output }
}
const providerSource = `module.exports = { apply(plugin) { plugin.services.provide(${JSON.stringify(token)}, {
  echo: async (input, ctx) => ({ input, principal: ctx.scope.principal.id, profile: ctx.scope.profileId, trace: ctx.scope.traceId }),
  read: async (_, ctx) => ctx.sessions.get('session'), invalid: async () => 42,
}) } }`
function consumerSource(required = dependency) {
  return `module.exports = { apply(plugin) {
    const service = plugin.services.use(${JSON.stringify(required)});
    plugin.on('plugin.ready', async (event, ctx) => {
      if (event.subject.pluginId !== plugin.plugin.id) return;
      const results = [await service.status()];
      for (const [method, input, context] of [['echo', 'hello', ctx], ['echo', 42, ctx], ['invalid', null, ctx], ['read', null, ctx], ['echo', 'forged', {...ctx}]]) {
        try { results.push(await service.call(context, method, input)) } catch (error) { results.push(error.code) }
      }
      plugin.logger.info('service-results', { results });
    });
  } }`
}

it.each([false, true])('uses real worker services with caller identity and permission intersection: %s', async readGranted => {
  const { host, install, state, events, output, read } = setup()
  const provider = manifest('test.provider', [token], [], ['sessions.read'])
  const consumer = manifest('test.consumer', [], [dependency], ['events.subscribe:plugin.ready', ...(readGranted ? ['sessions.read'] : [])])
  await install(provider, providerSource); await install(consumer, consumerSource())
  await host.configure(state(provider), 0)
  await host.configure(state(consumer), 0)
  await events.idle()
  await vi.waitFor(() => expect(output('service-results')).toHaveLength(1))
  const results = output('service-results')[0].data.results
  expect(results.slice(0, 4)).toEqual([{ available: true, version: '1.2.0' }, { input: 'hello', principal: 'caller', profile: 'one', trace: expect.any(String) }, 'INVALID_ARGUMENT', 'INVALID_ARGUMENT'])
  expect(results[4]).toEqual(readGranted ? expect.objectContaining({ id: 'session' }) : 'FORBIDDEN')
  expect(results[5]).toBe('FORBIDDEN')
  expect(read).toHaveBeenCalledTimes(readGranted ? 1 : 0)
  await expect(host.configure({ ...state(provider), enabled: false }, 1)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
  await expect(host.uninstall(provider.id)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
  await host.configure({ ...state(consumer), enabled: false }, 1)
  await host.configure({ ...state(provider), enabled: false }, 1)
})

it('restores global providers before consumers and preserves each service caller context', async () => {
  const { host, store, install, state, events, output } = setup()
  const provider = manifest('test.provider', [token], [], ['sessions.read'])
  const consumer = manifest('test.consumer', [], [dependency], ['events.subscribe:plugin.ready'])
  await install(consumer, consumerSource()); await install(provider, providerSource)
  store.saveProfile(state(consumer), 0); store.saveProfile(state(provider), 0)
  await host.restore(); await events.idle()
  await vi.waitFor(() => expect(output('service-results')).toHaveLength(1))
  expect(output('service-results')[0].data.results[0].available).toBe(true)
  const optional = manifest('test.optional', [], [{ ...dependency, optional: true }], ['events.subscribe:plugin.ready'])
  await install(optional, consumerSource({ ...dependency, optional: true } as any))
  await host.configure(state(optional, 'two'), 0); await events.idle()
  await vi.waitFor(() => expect(output('service-results')).toHaveLength(2))
  expect(output('service-results')[1].data.results).toEqual([{ available: true, version: '1.2.0' }, { input: 'hello', principal: 'caller', profile: 'one', trace: expect.any(String) }, 'INVALID_ARGUMENT', 'INVALID_ARGUMENT', 'FORBIDDEN', 'FORBIDDEN'])
  const refresh = () => events.publish({ schemaVersion: 1, id: String(Math.random()), type: 'plugin.ready', occurredAt: Date.now(), partitionKey: 'optional', sequence: 1,
    subject: { profileId: 'two', pluginId: optional.id }, data: { pluginId: optional.id }, correlationId: 'optional-trace' })
  await host.activate(provider.id, 'two')
  refresh(); await events.idle()
  await vi.waitFor(() => expect(output('service-results')).toHaveLength(3))
  expect(output('service-results')[2].data.results[0]).toEqual({ available: true, version: '1.2.0' })
  expect(output('service-results')[2].data.results[1]).toMatchObject({ principal: 'caller', profile: 'two', trace: 'optional-trace' })
  await expect(host.configure({ ...state(provider), enabled: false }, 1)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
  await host.configure({ ...state(consumer), enabled: false }, 1)
  await host.configure({ ...state(provider), enabled: false }, 1)
  refresh(); await events.idle()
  await vi.waitFor(() => expect(output('service-results')).toHaveLength(4))
  expect(output('service-results')[3].data.results[0]).toEqual({ available: false })
})

it('rejects missing dependencies, incompatible versions and cycles before applying plugin code', async () => {
  const { store, host, install, state, output, eventStore } = setup()
  const missing = manifest('test.missing', [], [dependency])
  await install(missing, `module.exports = { apply(ctx) { ctx.logger.info('must-not-apply') } }`)
  await expect(host.configure(state(missing), 0)).rejects.toMatchObject({ code: 'PLUGIN_UNAVAILABLE' })
  expect(host.diagnostic(missing.id, 'one')).toMatchObject({ state: 'blocked', errorCode: 'PLUGIN_UNAVAILABLE', configurationRevision: 1 })
  expect(store.diagnostic(missing.id)).toMatchObject({ state: 'blocked', errorCode: 'PLUGIN_UNAVAILABLE' })
  expect(output('must-not-apply')).toHaveLength(0)
  expect(eventStore.read(undefined).map(row => row.event)).toEqual([expect.objectContaining({ type: 'plugin.failed', subject: { pluginId: missing.id } })])
  await host.configure({ ...state(missing), enabled: false }, 1)
  expect(eventStore.read(undefined).map(row => row.event.type)).toEqual(['plugin.failed', 'plugin.disabled'])
  const provider = manifest('test.provider', [token])
  await install(provider, providerSource); store.saveProfile(state(provider), 0)
  const incompatible = manifest('test.incompatible', [], [{ ...dependency, version: '^2.0.0' }])
  await install(incompatible, 'module.exports = { apply() {} }'); store.saveProfile(state(incompatible), 0)
  expect(() => pluginActivationOrder(store, incompatible.id, 'one')).toThrow('incompatible')
  const cycleToken = { ...token, id: 'test.cycle/echo@1' }
  const cycle = manifest('test.cycle', [cycleToken], [{ id: cycleToken.id, version: '^1' }])
  await install(cycle, 'module.exports = { apply() {} }'); store.saveProfile(state(cycle), 0)
  expect(() => pluginActivationOrder(store, cycle.id, 'one')).toThrow('cycle')
  const leftToken = { ...token, id: 'test.left/echo@1' }, rightToken = { ...token, id: 'test.right/echo@1' }
  const left = manifest('test.left', [leftToken], [{ id: rightToken.id, version: '^1' }])
  const right = manifest('test.right', [rightToken], [{ id: leftToken.id, version: '^1' }])
  await install(left, 'module.exports = { apply() {} }'); await install(right, 'module.exports = { apply() {} }')
  store.saveProfile(state(left), 0); store.saveProfile(state(right), 0)
  expect(() => pluginActivationOrder(store, left.id, 'one')).toThrow('cycle')
})

it('notifies global consumers once after directory changes and publishes one withdrawal per contribution', async () => {
  const { host, install, state, events, eventStore, output, registry } = setup()
  const provider = manifest('test.provider', [token], [], ['agents.register'])
  provider.contributes.agents = ['test.provider/agent']
  const optional = manifest('test.optional', [], [{ ...dependency, optional: true }], [
    'agents.read', 'events.subscribe:service.available', 'events.subscribe:service.unavailable',
  ])
  await install(provider, `module.exports = { apply(plugin) {
    plugin.services.provide(${JSON.stringify(token)}, { echo: async () => ({}), read: async () => null, invalid: async () => '' });
    plugin.agents.register({ id: 'test.provider/agent', name: 'Lifecycle', configSchema: {}, capabilities: { text: true, modes: ['scoped'] }, create: async () => ({}) });
  } }`)
  await install(optional, `module.exports = { apply(plugin) {
    const service = plugin.services.use(${JSON.stringify({ ...dependency, optional: true })});
    for (const type of ['service.available', 'service.unavailable']) plugin.on(type, async (event, ctx) => {
      plugin.logger.info('service-change', { type, profile: ctx.scope.profileId, data: event.data,
        status: await service.status(), agents: (await ctx.agents.list()).map(agent => agent.id) });
    });
  } }`)
  await host.configure(state(optional), 0); await host.activate(optional.id, 'two')
  await host.configure(state(provider), 0); await events.idle()
  await vi.waitFor(() => expect(output('service-change')).toHaveLength(1))
  expect(output('service-change')[0].data).toEqual({ type: 'service.available', profile: 'one',
    data: { serviceId: token.id, version: token.version }, status: { available: true, version: token.version }, agents: ['test.provider/agent'] })
  await host.configure({ ...state(provider), enabled: false }, 1); await events.idle()
  await vi.waitFor(() => expect(output('service-change')).toHaveLength(2))
  expect(output('service-change')[1].data).toMatchObject({ type: 'service.unavailable', profile: 'one', status: { available: false }, agents: [] })
  expect(registry.list('one')).toEqual([])
  await host.configure({ ...state(provider), enabled: false }, 2)
  const lifecycle = () => eventStore.read(undefined).filter(row => row.event.subject.pluginId === provider.id).map(row => row.event.type)
  expect(lifecycle()).toEqual(['plugin.ready', 'agent.available', 'service.available', 'agent.unavailable', 'service.unavailable', 'plugin.disabled'])
  await host.configure(state(provider), 3); await events.idle()
  await host.configure(state(provider), 4); await events.idle()
  expect(lifecycle().filter(type => type === 'plugin.disabled')).toHaveLength(1)
  await host.uninstall(provider.id); await events.idle()
  expect(lifecycle().slice(-3)).toEqual(['agent.unavailable', 'service.unavailable', 'plugin.disabled'])
  expect(lifecycle().filter(type => type === 'service.available')).toHaveLength(3)
  expect(lifecycle().filter(type => type === 'service.unavailable')).toHaveLength(3)
  expect(host.diagnostic(optional.id, 'one').state).toBe('ready')
})

it('withdraws only consumers of a disposed service and publishes a single Agent/service removal', async () => {
  const { host, install, state, events, eventStore, registry } = setup()
  const second = { ...token, id: 'test.provider/second@1' }
  const provider = manifest('test.provider', [token, second], [], ['agents.register', 'events.subscribe:plugin.ready'])
  provider.contributes.agents = ['test.provider/agent']
  const firstConsumer = manifest('test.first', [], [dependency])
  const secondConsumer = manifest('test.second', [], [{ id: second.id, version: '^1' }])
  await install(provider, `module.exports = { apply(plugin) {
    const methods = { echo: async () => ({}), read: async () => null, invalid: async () => '' };
    const removeService = plugin.services.provide(${JSON.stringify(token)}, methods);
    plugin.services.provide(${JSON.stringify(second)}, methods);
    const removeAgent = plugin.agents.register({ id: 'test.provider/agent', name: 'Removal', configSchema: {}, capabilities: { text: true, modes: ['scoped'] }, create: async () => ({}) });
    plugin.on('plugin.ready', async event => { if (event.data.generation !== 'withdraw') return;
      await removeService(); await removeService(); await removeAgent(); await removeAgent();
    });
  } }`)
  await install(firstConsumer, 'module.exports = { apply() {} }'); await install(secondConsumer, 'module.exports = { apply() {} }')
  await host.configure(state(provider), 0); await host.configure(state(firstConsumer), 0); await host.configure(state(secondConsumer), 0)
  await events.idle()
  events.publish({ schemaVersion: 1, id: 'withdraw', type: 'plugin.ready', occurredAt: Date.now(), partitionKey: 'fixture', sequence: 1,
    subject: { profileId: 'one', pluginId: provider.id }, data: { pluginId: provider.id, generation: 'withdraw' }, correlationId: 'withdraw' })
  await events.idle()
  await vi.waitFor(() => expect(host.diagnostic(firstConsumer.id, 'one').state).toBe('blocked'))
  expect(host.diagnostic(secondConsumer.id, 'one').state).toBe('ready')
  expect(host.diagnostic(provider.id, 'one').state).toBe('ready')
  expect(registry.list('one')).toEqual([])
  expect(eventStore.read(undefined).filter(row => row.event.type === 'service.unavailable').map(row => row.event.data)).toEqual([{ serviceId: token.id, version: token.version }])
  expect(eventStore.read(undefined).filter(row => row.event.type === 'agent.unavailable')).toHaveLength(1)
  await host.configure({ ...state(secondConsumer), enabled: false }, 1)
  await host.configure({ ...state(firstConsumer), enabled: false }, 1)
  await host.configure({ ...state(provider), enabled: false }, 1)
  expect(eventStore.read(undefined).filter(row => row.event.type === 'service.unavailable').map(row => row.event.data)).toEqual([
    { serviceId: token.id, version: token.version }, { serviceId: second.id, version: second.version },
  ])
  expect(eventStore.read(undefined).filter(row => row.event.type === 'agent.unavailable')).toHaveLength(1)
})

it('reaps an activation even if its profile was disabled outside the host, and does not announce shutdown as a disable', async () => {
  const { host, store, install, state, eventStore } = setup()
  const provider = manifest('test.provider', [token])
  await install(provider, providerSource)
  await host.configure(state(provider), 0)
  store.saveProfile({ ...state(provider), enabled: false }, 1)
  await host.uninstall(provider.id)
  expect(eventStore.read(undefined).map(row => row.event.type)).toEqual(['plugin.ready', 'service.available', 'service.unavailable', 'plugin.disabled'])
  await install(provider, providerSource)
  await host.configure(state(provider), 2)
  const before = eventStore.read(undefined)
  await host.close()
  expect(eventStore.read(undefined)).toEqual(before)
  expect(host.diagnostic(provider.id, 'one').state).toBe('inactive')
})

it('rolls back a malformed service contribution without publishing its Agent', async () => {
  const { host, install, state, registry } = setup()
  const provider = manifest('test.provider', [token], [], ['agents.register'])
  provider.contributes.agents = ['test.provider/agent']
  await install(provider, `module.exports = { apply(ctx) {
    ctx.agents.register({ id: 'test.provider/agent', name: 'bad service', configSchema: {}, capabilities: { text: true, modes: ['scoped'] }, create: async () => ({}) });
    ctx.services.provide(${JSON.stringify({ ...token, version: '1.3.0' })}, { echo() {}, read() {}, invalid() {} });
  } }`)
  await expect(host.configure(state(provider), 0)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  expect(registry.list('one')).toEqual([])
  expect(host.diagnostic(provider.id, 'one')).toMatchObject({ state: 'failed', errorCode: 'INVALID_ARGUMENT' })
})

it('propagates cancellation through real service RPC without sending a second execution', async () => {
  const { host, install, state, context, registry, output, logger } = setup()
  const slow: ServiceToken = { id: 'test.provider/slow@1', version: '1.0.0', methods: { wait: { input: {}, output: {} } } }
  const required = { id: slow.id, version: '^1' }
  const provider = manifest('test.provider', [slow]), consumer = manifest('test.consumer', [], [required], ['agents.register'])
  consumer.contributes.agents = ['test.consumer/agent']
  await install(provider, `module.exports = { apply(plugin) { plugin.services.provide(${JSON.stringify(slow)}, {
    wait: async (_, ctx) => { plugin.logger.info('service-waiting'); await new Promise(resolve => {
      if (ctx.signal.aborted) resolve(); else ctx.signal.addEventListener('abort', resolve, { once: true });
    }); plugin.logger.info('service-aborted'); return null; }
  }) } }`)
  await install(consumer, `module.exports = { apply(plugin) {
    const service = plugin.services.use(${JSON.stringify(required)});
    plugin.agents.register({ id: 'test.consumer/agent', name: 'Service caller', configSchema: {}, capabilities: { text: true, modes: ['scoped'] }, create: async () => ({
      run: async (_, ctx) => { const result = service.call(ctx, 'wait', null).then(() => ({ status: 'completed' }), () => ({ status: 'cancelled' }));
        return { result, events: (async function* () { await result })(), cancel: async () => {} }; }, dispose: async () => {}
    }) });
  } }`)
  await host.configure(state(provider), 0); await host.configure(state(consumer), 0)
  const { definition, provider: ref } = registry.resolve('one', 'test.consumer/agent'), runtimeController = new AbortController()
  const runtime = await definition.create({ instanceId: 'instance', config: {}, configRevision: 1, mode: 'scoped' }, {
    provider: ref, runtimeSessionId: 'lease', profileId: 'one', ownerId: 'caller', signal: runtimeController.signal, logger,
    processes: { spawn: async () => { throw new Error('Processes are not used by this fixture') } },
    mcp: { connect: async () => { throw new Error('MCP is not used by this fixture') } },
  })
  const controller = new AbortController(), ctx = context({ ...scope, runId: 'run' }, controller.signal)
  const handle = await runtime.run({ content: [{ type: 'text', text: 'wait' }] }, { ...ctx, scope: { ...ctx.scope, runId: 'run', runtimeSessionId: 'lease' } } as AgentRunContext)
  await vi.waitFor(() => expect(output('service-waiting')).toHaveLength(1))
  controller.abort()
  expect(await handle.result).toMatchObject({ status: 'cancelled' })
  await vi.waitFor(() => expect(output('service-aborted')).toHaveLength(1))
  expect(output('service-waiting')).toHaveLength(1)
  await runtime.dispose('test done')
  expect(host.diagnostic(consumer.id, 'one').hasActiveLeases).toBe(false)
})

it('rechecks the original caller grants when a provider performs a later domain call', async () => {
  const { host, store, install, state, events, output, read } = setup()
  const gate = join(root, 'read-gate'), token: ServiceToken = { id: 'test.provider/read@1', version: '1.0.0', methods: { read: { input: {}, output: {} } } }
  const required = { id: token.id, version: '^1' }
  const provider = manifest('test.provider', [token], [], ['sessions.read'])
  const consumer = manifest('test.consumer', [], [required], ['sessions.read', 'events.subscribe:plugin.ready'])
  await install(provider, `module.exports = { apply(plugin) { plugin.services.provide(${JSON.stringify(token)}, { read: async (_, ctx) => {
    plugin.logger.info('read-waiting');
    while (true) { try { await require('node:fs/promises').readFile(${JSON.stringify(gate)}); break } catch { await new Promise(resolve => setTimeout(resolve, 10)) } }
    return ctx.sessions.get('session');
  } }) } }`)
  await install(consumer, `module.exports = { apply(plugin) {
    const service = plugin.services.use(${JSON.stringify(required)});
    plugin.on('plugin.ready', async (event, ctx) => { if (event.subject.pluginId !== plugin.plugin.id) return;
      try { await service.call(ctx, 'read', null) } catch (error) { plugin.logger.info('read-result', { code: error.code }); }
    });
  } }`)
  await host.configure(state(provider), 0); await host.configure(state(consumer), 0)
  await vi.waitFor(() => expect(output('read-waiting')).toHaveLength(1))
  store.saveProfile({ ...state(consumer), grants: state(consumer).grants.filter(value => value !== 'sessions.read') }, 1)
  await writeFile(gate, 'release')
  await events.idle()
  await vi.waitFor(() => expect(output('read-result')[0]?.data.code).toBe('FORBIDDEN'))
  expect(read).not.toHaveBeenCalled()
})

it('marks a crashed provider failed and withdraws required consumers while leaving unrelated plugins ready', async () => {
  const { host, install, state, eventStore } = setup()
  const crash: ServiceToken = { id: 'test.provider/crash@1', version: '1.0.0', methods: { crash: { input: {}, output: {} } } }
  const required = { id: crash.id, version: '^1' }
  const provider = manifest('test.provider', [crash]), consumer = manifest('test.consumer', [], [required], ['events.subscribe:plugin.ready'])
  const unrelated = manifest('test.unrelated')
  await install(provider, `module.exports = { apply(ctx) { ctx.services.provide(${JSON.stringify(crash)}, { crash: async () => { process.exit(7) } }) } }`)
  await install(consumer, `module.exports = { apply(plugin) { const service = plugin.services.use(${JSON.stringify(required)});
    plugin.on('plugin.ready', async (event, ctx) => { if (event.subject.pluginId === plugin.plugin.id) await service.call(ctx, 'crash', null); });
  } }`)
  await install(unrelated, 'module.exports = { apply() {} }')
  await host.configure(state(provider), 0); await host.configure(state(unrelated), 0); await host.configure(state(consumer), 0)
  await vi.waitFor(() => expect(host.diagnostic(consumer.id, 'one').state).toBe('blocked'))
  expect(host.diagnostic(provider.id, 'one')).toMatchObject({ state: 'failed', errorCode: 'PLUGIN_UNAVAILABLE' })
  expect(host.diagnostic(unrelated.id, 'one').state).toBe('ready')
  await vi.waitFor(() => expect(eventStore.read(undefined).filter(row => row.event.type === 'plugin.failed')).toHaveLength(2))
  const failures = eventStore.read(undefined).filter(row => row.event.type === 'plugin.failed').map(row => row.event.subject.pluginId)
  expect(failures.sort()).toEqual([consumer.id, provider.id])
  expect(eventStore.read(undefined).filter(row => row.event.type === 'service.unavailable').map(row => row.event.data)).toEqual([{ serviceId: crash.id, version: crash.version }])
})

it.each([
  { ...token, id: 'core/models@1' },
  { ...token, version: '2.0.0' },
  { ...token, methods: { constructor: { input: {}, output: {} } } },
])('rejects invalid service namespaces or schemas: $id/$version', value => {
  expect(() => parseManifest(manifest('test.provider', [value]))).toThrow()
})

it('keeps staged services private and rejects duplicate registrations and schema-invalid results', async () => {
  const { context } = setup(), registry = new PluginServiceRegistry(), invoke = vi.fn(async () => ({ input: 'ok' }))
  const staged = registry.stage('one', [token], invoke, () => true)
  expect(registry.status('one', dependency)).toEqual({ available: false })
  expect(() => staged.commit()).toThrow('validated')
  staged.validate([token]); staged.commit()
  expect(registry.status('two', dependency)).toEqual({ available: false })
  const duplicate = registry.stage('one', [token], invoke, () => true)
  expect(() => duplicate.validate([token])).toThrow('already')
  const ctx = context(scope, new AbortController().signal)
  expect(await registry.call(ctx, dependency, 'echo', 'ok', () => {})).toEqual({ input: 'ok' })
  await expect(registry.call(ctx, dependency, 'echo', 42, () => {})).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  await expect(registry.call(ctx, dependency, 'invalid', null, () => {})).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  staged.dispose()
  expect(registry.status('one', dependency)).toEqual({ available: false })
})
