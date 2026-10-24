import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { PluginHost } from '../../packages/server/src/modules/studio/services/plugins/host'
import { PluginStore } from '../../packages/server/src/modules/studio/repositories/plugin-store'
import { PluginConsumerStore } from '../../packages/server/src/modules/studio/repositories/plugin-consumer-store'
import { ReliablePluginConsumers } from '../../packages/server/src/modules/studio/services/events/reliable-consumers'
import { AgentRegistry } from '../../packages/server/src/modules/studio/services/agents/registry'
import { PluginEventBus } from '../../packages/server/src/modules/studio/services/events/plugin-events'
import { createExecutionContext } from '../../packages/server/src/modules/studio/services/context/execution'
import type { ExecutionScope, PluginManifest } from '../../packages/studio-plugin-sdk/src'

let root: string, runner: string
const cleanup: Array<() => Promise<void>> = []
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'studio-consumers-')); runner = join(root, 'runner.cjs')
  await build({ entryPoints: ['packages/studio-plugin-runner/src/main.ts'], bundle: true, platform: 'node', target: 'node24.22.1', format: 'cjs', outfile: runner, logLevel: 'silent' })
})
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
afterAll(async () => { await rm(root, { force: true, recursive: true }) })

async function setup(source: string, capabilities = ['events.consume:run.completed', 'sessions.read'], agents: string[] = []) {
  const db = new DatabaseSync(':memory:'), store = new PluginStore(db), registry = new AgentRegistry(), events = new PluginEventBus()
  let now = Date.now()
  const consumerStore = new PluginConsumerStore(db), consumers = new ReliablePluginConsumers(consumerStore, { intervalMs: 1_000_000, now: () => now })
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, read = vi.fn(async () => null)
  const context = (scope: ExecutionScope, signal: AbortSignal) => createExecutionContext(scope, signal, logger, { authorize: async () => {}, sessions: { get: read } })
  const host = new PluginHost({ store, registry, events, consumers, context, logger, runnerPath: runner, artifactsRoot: join(root, 'artifacts'),
    eventContext: async (state, event, signal) => context({ scopeId: event.id, principal: { kind: 'user', id: state.ownerId }, profileId: state.profileId,
      surface: 'event', traceId: event.correlationId }, signal),
    acceptEvents: async batch => { for (const event of consumerStore.events.append(batch)) events.publish(event) },
  })
  cleanup.push(async () => { await host.close(); await consumers.close(); events.close(); db.close() })
  const manifest: PluginManifest = { schemaVersion: 1, id: 'test.consumer', version: '1.0.0', engines: { studioSdk: '^0.1.0', rpc: 1 }, backend: 'index.cjs', activation: 'profile',
    contributes: { agents }, requires: { capabilities } }
  const directory = await mkdtemp(join(root, 'artifact-'))
  await writeFile(join(directory, 'studio-plugin.json'), JSON.stringify(manifest)); await writeFile(join(directory, 'index.cjs'), source)
  await host.install(directory)
  const state = { pluginId: manifest.id, profileId: 'one', ownerId: 'owner', enabled: true, config: {}, grants: capabilities }
  const append = (id: string, profileId = 'one') => consumerStore.events.append([{ schemaVersion: 1, id, type: 'run.completed', occurredAt: now,
    subject: { profileId }, partitionKey: `${profileId}:run`, sequence: 0, data: { runId: 'run' }, correlationId: 'original-trace' }])
  const messages = () => logger.info.mock.calls.filter(call => call[0] === 'Plugin stdout').map(call => String((call[1] as { text: string }).text)).join('')
  return { host, store, state, consumers, consumerStore, read, append, messages, advance: (ms: number) => { now += ms } }
}
const source = `module.exports = { apply(plugin) {
  plugin.events.consume('history', { types: ['run.completed'], start: 'earliest', resume: 'continue' }, async (event, ctx) => {
    await ctx.sessions.get('session');
    plugin.logger.info('delivered', { id: event.id, owner: ctx.scope.principal.id, profile: ctx.scope.profileId, trace: ctx.scope.traceId });
  });
} }`

it('delivers a missed notification through real SDK RPC and resumes its durable cursor on reactivation', async () => {
  const f = await setup(source); f.append('before-enable'); f.append('foreign', 'two')
  await f.host.configure(f.state, 0); f.consumers.poll(); await f.consumers.idle()
  await vi.waitFor(() => expect(f.messages()).toContain('before-enable'))
  expect(f.messages()).toContain('original-trace'); expect(f.messages()).toContain('owner'); expect(f.messages()).not.toContain('foreign')
  expect(f.read).toHaveBeenCalledTimes(1)
  await f.host.configure({ ...f.state, enabled: false }, 1)
  const record = f.consumerStore.list('test.consumer', 'one')[0]
  f.append('while-disabled')
  await f.host.configure(f.state, 2); f.consumers.poll(); await f.consumers.idle()
  await vi.waitFor(() => expect(f.messages()).toContain('while-disabled'))
  expect(f.read).toHaveBeenCalledTimes(2)
  expect(f.consumerStore.list('test.consumer', 'one')[0].id).toBe(record.id)
  await f.host.configure({ ...f.state, enabled: false }, 3); await f.host.uninstall('test.consumer')
  expect(f.consumerStore.get(record.id)).not.toBeNull()
})

it('redelivers the same event after a real worker dies after its side effect but before acknowledgement', async () => {
  const sideEffect = join(root, `side-effect-${Date.now()}.json`)
  const f = await setup(`const fs = require('node:fs'); module.exports = { apply(plugin) {
    plugin.events.consume('history', { types: ['run.completed'], start: 'earliest', resume: 'continue' }, async event => {
      const file = ${JSON.stringify(sideEffect)};
      if (!fs.existsSync(file)) { fs.writeFileSync(file, event.id); process.exit(7); }
      plugin.logger.info('replayed', { id: event.id, previous: fs.readFileSync(file, 'utf8') });
    });
  } }`)
  f.append('stable-event-id'); await f.host.configure(f.state, 0); f.consumers.poll(); await f.consumers.idle()
  await vi.waitFor(() => expect(f.host.diagnostic('test.consumer', 'one').state).toBe('failed'))
  expect(await readFile(sideEffect, 'utf8')).toBe('stable-event-id')
  expect(f.consumerStore.deliveries(f.consumerStore.list('test.consumer', 'one')[0].id)[0]).toMatchObject({ attempts: 1, status: 'pending', error_code: 'PLUGIN_UNAVAILABLE' })
  f.advance(1000); await f.host.activate('test.consumer', 'one'); f.consumers.poll(); await f.consumers.idle()
  await vi.waitFor(() => expect(f.messages()).toContain('replayed'))
  expect(f.messages()).toContain('"previous":"stable-event-id"')
  expect(f.consumerStore.deliveries(f.consumerStore.list('test.consumer', 'one')[0].id)).toEqual([])
})

it('rechecks grants before replay and does not expose filtered events to the worker', async () => {
  const f = await setup(source); await f.host.configure(f.state, 0)
  f.store.saveProfile({ ...f.state, grants: ['sessions.read'] }, 1)
  f.append('revoked'); f.consumers.poll(); await f.consumers.idle()
  expect(f.read).not.toHaveBeenCalled(); expect(f.messages()).not.toContain('revoked')
  f.store.saveProfile(f.state, 2); f.append('allowed'); f.consumers.poll(); await f.consumers.idle()
  await vi.waitFor(() => expect(f.messages()).toContain('allowed'))
  expect(f.read).toHaveBeenCalledTimes(1)
})

it('rejects undeclared reliable consumers before publishing a ready plugin or cursor', async () => {
  const f = await setup(source, ['sessions.read'])
  await expect(f.host.configure(f.state, 0)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(f.host.diagnostic('test.consumer', 'one').state).toBe('blocked')
  expect(f.consumerStore.list('test.consumer', 'one')).toEqual([])
})

it('does not reset retained delivery state when another activation contribution is invalid', async () => {
  const f = await setup(source.replace("resume: 'continue'", "resume: 'from-now'"), ['events.consume:run.completed', 'sessions.read', 'agents.register'], ['test.consumer/missing'])
  const record = f.consumerStore.register({ pluginId: 'test.consumer', profileId: 'one', ownerId: 'owner', name: 'history' }, { types: ['run.completed'], start: 'earliest', resume: 'continue' })
  f.append('must-retain'); f.consumerStore.fill(record.id)
  await expect(f.host.configure(f.state, 0)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  expect(f.consumerStore.deliveries(record.id)).toHaveLength(1)
  expect(f.consumerStore.get(record.id)?.revision).toBe(1)
})
