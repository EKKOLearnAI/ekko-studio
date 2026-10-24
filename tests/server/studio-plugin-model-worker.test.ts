import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { PluginHost } from '../../packages/server/src/modules/studio/services/plugins/host'
import { PluginStore } from '../../packages/server/src/modules/studio/repositories/plugin-store'
import { PluginModels } from '../../packages/server/src/modules/studio/services/models/plugin'
import { PluginModelCallStore } from '../../packages/server/src/modules/studio/repositories/plugin-model-call-store'
import { AgentExecutionStore } from '../../packages/server/src/modules/studio/repositories/agent-execution-store'
import { AgentCoordinator } from '../../packages/server/src/modules/studio/services/agents/coordinator'
import { AgentRegistry } from '../../packages/server/src/modules/studio/services/agents/registry'
import { PluginEventBus } from '../../packages/server/src/modules/studio/services/events/plugin-events'
import { createExecutionContext } from '../../packages/server/src/modules/studio/services/context/execution'
import type { ExecutionScope, PluginManifest } from '../../packages/studio-plugin-sdk/src'

let root: string, runner: string
const cleanups: Array<() => Promise<void>> = []
const scope: ExecutionScope = { scopeId: 'scope', principal: { kind: 'user', id: 'owner' }, profileId: 'one', surface: 'api', traceId: 'trace' }
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'studio-model-worker-')); runner = join(root, 'runner.cjs')
  await build({ entryPoints: ['packages/studio-plugin-runner/src/main.ts'], bundle: true, platform: 'node', target: 'node24.22.1', format: 'cjs', outfile: runner, logLevel: 'silent' })
})
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })
afterAll(async () => { await rm(root, { recursive: true, force: true }) })

async function setup(options: { mode?: 'abandon' | 'crash'; granted?: boolean } = {}) {
  const db = new DatabaseSync(':memory:'), store = new PluginStore(db), registry = new AgentRegistry(), events = new PluginEventBus()
  const executions = new AgentExecutionStore(db), receipts = new PluginModelCallStore(db)
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, accounted = vi.fn(), requests: string[] = []
  const models = new PluginModels({ store: receipts, state: executions.state, authorize: () => {},
    list: async () => ({ object: 'list', data: [{ id: 'p/m', object: 'model', created: 0, owned_by: 'p', api_mode: 'chat_completions', responses_supported: true }] }),
    prepare: async request => {
      requests.push(request.internal!.id)
      return { id: request.internal!.id, stream: true, create: async () => null,
        async *events() {
          try {
            yield { type: 'response.output_text.delta', delta: '你好 from host' }
            if ((request.body as { input: string }).input === 'hold') await new Promise<void>(resolve => {
              if (request.signal.aborted) resolve(); else request.signal.addEventListener('abort', () => resolve(), { once: true })
            })
            if (!request.signal.aborted) yield { type: 'response.completed', response: { output: [{ type: 'message', content: [{ type: 'output_text', text: '你好 from host' }] }] } }
          } finally {
            request.onUsage?.({ isEstimated: false, inputTokens: 7, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 })
            accounted(request.internal!.id)
          }
        },
      }
    },
  })
  const context = (current: ExecutionScope, signal: AbortSignal) => createExecutionContext(current, signal, logger, {
    authorize: async () => {}, agents: { list: async profile => registry.list(profile) }, sessions: { get: async () => null },
    models: { list: caller => models.list(caller), get: async (caller, id) => models.get(caller, id), stream: (caller, input, signal) => models.stream(caller, input, signal) },
  })
  const coordinator = new AgentCoordinator({ store: executions, registry, events, logger, authorize: () => {}, context })
  const host = new PluginHost({ store, registry, events, context, logger, runnerPath: runner, artifactsRoot: join(root, 'artifacts'),
    acceptEvents: async batch => { for (const event of batch) events.publish(event) },
  })
  cleanups.push(async () => { await coordinator.close(); await host.close(); await models.close(); events.close(); db.close() })
  const capabilities = ['agents.register', ...(options.granted === false ? [] : ['models.stream', 'models.read'])]
  const manifest: PluginManifest = { schemaVersion: 1, id: 'test.models', version: '1.0.0', engines: { studioSdk: '^0.1.0', rpc: 1 }, backend: 'index.cjs', activation: 'profile',
    contributes: { agents: ['test.models/agent'] }, requires: { capabilities } }
  const directory = await mkdtemp(join(root, 'artifact-'))
  await writeFile(join(directory, 'studio-plugin.json'), JSON.stringify(manifest))
  await writeFile(join(directory, 'index.cjs'), `module.exports = { apply(plugin) {
    plugin.agents.register({ id: 'test.models/agent', name: 'Model fixture', configSchema: {}, capabilities: { text: true, modes: ['scoped'] },
      create: async () => ({ dispose: async () => {}, run: async (input, ctx) => {
        let resolve, reject; const result = new Promise((yes, no) => { resolve = yes; reject = no });
        return { result, cancel: async () => resolve({ status: 'cancelled' }), events: (async function* () {
          try {
            const stream = await ctx.models.stream({ model: 'p/m', input: input.content[0].text, idempotencyKey: ctx.scope.runId });
            ${options.mode === 'crash' ? 'process.exit(13);' : ''}
            ${options.mode === 'abandon' ? "resolve({ status: 'completed' }); return;" : ''}
            let sequence = 0;
            for await (const event of stream.events) {
              if (event.type === 'text.delta') yield { type: 'message.delta', producerSequence: ++sequence, messageId: 'answer', text: event.text };
              if (event.type === 'call.finished') {
                const receipt = await ctx.models.get(stream.id);
                if (!receipt.usage || receipt.usage.inputTokens !== 7) throw new Error('accounting barrier failed');
                yield { type: 'usage.reported', producerSequence: ++sequence, modelCallId: stream.id, model: 'p/m', mode: 'final', revision: 999, inputTokens: 999, outputTokens: 999 };
              }
            }
            resolve({ status: 'completed' });
          } catch (error) { reject(error); throw error }
        })() };
      } }) });
  } }`)
  await host.install(directory)
  const state = { pluginId: manifest.id, profileId: 'one', ownerId: 'owner', enabled: true, config: {}, grants: capabilities }
  await host.configure(state, 0)
  const instance = coordinator.createInstance(scope, { agentTypeId: 'test.models/agent', config: {}, mode: 'scoped' })
  const start = (text = 'hello') => coordinator.start(scope, instance.id, { content: [{ type: 'text', text }] }, text)
  return { coordinator, executions, models, receipts, store, state, requests, accounted, start }
}

it('runs a real plugin through model RPC and rejects duplicate runtime usage accounting', async () => {
  const f = await setup(), run = f.start()
  await f.coordinator.wait(run.id)
  expect(f.coordinator.get(scope, run.id).status).toBe('completed')
  expect(f.coordinator.output(scope, run.id, -1)).toEqual([expect.objectContaining({ type: 'message.delta', text: '你好 from host' })])
  expect(f.executions.state.usage(run.id)).toEqual([expect.objectContaining({ modelCallId: f.requests[0], inputTokens: 7, outputTokens: 4, source: 'host', final: true })])
  expect(f.accounted).toHaveBeenCalledOnce()
})

it('cancels an abandoned call and meters it before the plugin Run completes', async () => {
  const f = await setup({ mode: 'abandon' }), run = f.start('hold')
  await f.coordinator.wait(run.id)
  expect(f.coordinator.get(scope, run.id).status).toBe('completed')
  expect(f.accounted).toHaveBeenCalledOnce()
  expect(f.receipts.get(f.requests[0])).toMatchObject({ status: 'cancelled', usage: { inputTokens: 7 } })
})

it('cancels host model work when the real worker exits', async () => {
  const f = await setup({ mode: 'crash' }), run = f.start('hold')
  await f.coordinator.wait(run.id)
  expect(f.coordinator.get(scope, run.id).status).toBe('interrupted')
  await vi.waitFor(() => expect(f.accounted).toHaveBeenCalledOnce())
  expect(f.receipts.get(f.requests[0])).toMatchObject({ status: 'cancelled' })
})

it('enforces declared capability before provider dispatch', async () => {
  const f = await setup({ granted: false }), run = f.start()
  await f.coordinator.wait(run.id)
  expect(f.coordinator.get(scope, run.id)).toMatchObject({ status: 'failed', errorCode: 'FORBIDDEN' })
  expect(f.requests).toEqual([])
})

it('revokes an existing stream without delivering further output', async () => {
  const f = await setup(), run = f.start('hold')
  await vi.waitFor(() => expect(f.requests).toHaveLength(1))
  f.store.saveProfile({ ...f.state, grants: ['agents.register'] }, 1)
  await f.coordinator.wait(run.id)
  expect(f.coordinator.get(scope, run.id)).toMatchObject({ status: 'failed', errorCode: 'FORBIDDEN' })
  expect(f.accounted).toHaveBeenCalledOnce()
  expect(f.receipts.get(f.requests[0])).toMatchObject({ status: 'cancelled' })
})
