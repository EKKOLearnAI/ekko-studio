import Koa from 'koa'
import { bodyParser } from '@koa/bodyparser'
import { once } from 'node:events'
import { DatabaseSync } from 'node:sqlite'
import type { Server } from 'node:http'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentCoordinator } from '../../packages/server/src/modules/studio/services/agents/coordinator'
import { AgentRunAdmission } from '../../packages/server/src/modules/studio/services/agents/admission'
import { PluginHookRegistry } from '../../packages/server/src/modules/studio/services/events/plugin-hooks'
import { AgentRegistry } from '../../packages/server/src/modules/studio/services/agents/registry'
import { AgentExecutionStore } from '../../packages/server/src/modules/studio/repositories/agent-execution-store'
import { PluginEventStore } from '../../packages/server/src/modules/studio/repositories/plugin-event-store'
import { PluginEventBus } from '../../packages/server/src/modules/studio/services/events/plugin-events'
import { createExecutionContext } from '../../packages/server/src/modules/studio/services/context/execution'
import { StudioError, type AgentRunStartInput, type ExecutionContext, type ExecutionScope } from '../../packages/studio-plugin-sdk/src'

const http = vi.hoisted(() => ({ runtime: undefined as unknown }))
vi.mock('../../packages/server/src/modules/studio/services/plugins/runtime', () => ({
  authorizePluginScope: vi.fn(), getStudioPluginRuntime: () => http.runtime,
}))
import { studioPluginRoutes } from '../../packages/server/src/modules/studio/routes/studio-plugins'

const scope: ExecutionScope = { scopeId: 'scope', principal: { kind: 'user', id: '1' }, profileId: 'one', surface: 'api', traceId: 'trace' }
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

function setup() {
  const db = new DatabaseSync(':memory:'), store = new AgentExecutionStore(db), registry = new AgentRegistry(), events = new PluginEventBus()
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  let allowed = true
  const authorize = vi.fn(() => { if (!allowed) throw new StudioError('FORBIDDEN', 'Access revoked') })
  const beforeAuthorize = vi.fn(async () => {})
  const factory = vi.fn(async () => ({
    run: async () => ({
      events: (async function* () { yield { type: 'message.delta' as const, producerSequence: 1, messageId: 'answer', text: 'done' } })(),
      result: Promise.resolve({ status: 'completed' as const }), cancel: async () => {},
    }), dispose: async () => {},
  }))
  const registration = registry.stage('*', { kind: 'builtin', module: 'ekko', implementationVersion: 'fixture' }, ['ekko'])
  registration.register({ id: 'ekko', name: 'Fixture', configSchema: {}, capabilities: { text: true, modes: ['scoped'] }, create: factory })
  registration.commit()
  const context = (current = scope, signal = new AbortController().signal): ExecutionContext => createExecutionContext(current, signal, logger, {
    authorize: async () => { await beforeAuthorize(); authorize() }, sessions: { get: async () => null }, agents: { list: async () => [] },
    runs: {
      start: (current, input, signal) => admission.start(current, input, signal),
      get: async (current, id) => coordinator.get(current, id), output: async (current, id, after) => coordinator.output(current, id, after),
    },
  })
  const coordinator: AgentCoordinator = new AgentCoordinator({ store, registry, events, logger, authorize, context })
  const hooks = new PluginHookRegistry(), admission = new AgentRunAdmission(coordinator, hooks, context)
  const instance = coordinator.createInstance(scope, { agentTypeId: 'ekko', config: {}, mode: 'scoped' })
  const request = (): AgentRunStartInput => ({ instanceId: instance.id, input: { content: [{ type: 'text', text: 'hello' }] }, idempotencyKey: 'request' })
  cleanup.push(async () => { await coordinator.close(); events.close(); db.close() })
  http.runtime = { context, coordinator }
  return { db, store, context, coordinator, hooks, factory, request, beforeAuthorize, registration, revoke: () => { allowed = false } }
}

async function serve(): Promise<string> {
  const app = new Koa()
  app.use(bodyParser())
  app.use(async (ctx, next) => {
    ctx.state.user = { id: 1, username: 'fixture', role: 'super_admin' }
    ctx.state.profile = { name: 'one' }
    await next()
  })
  app.use(studioPluginRoutes.routes())
  const server: Server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  cleanup.push(async () => { server.close(); await once(server, 'close') })
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`
}

it('deduplicates concurrent SDK and HTTP starts and commits one result and completion event', async () => {
  const { db, context, coordinator, hooks, factory, request } = setup()
  const hook = vi.fn(async () => ({ action: 'patch', patch: { content: [{ type: 'text', text: 'hook approved' }] } }))
  hooks.register('one', 'test.policy', 'generation', { point: 'runs.start', options: { key: 'policy', priority: 0 } }, hook)
  const base = await serve(), input = request()
  const response = fetch(`${base}/api/studio/agent-instances/${input.instanceId}/runs`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input: input.input, idempotencyKey: input.idempotencyKey }),
  })
  const [a, b, res] = await Promise.all([context().runs.start(input), context().runs.start(input), response])
  expect(res.status).toBe(200)
  expect(await res.json()).toMatchObject({ ok: true, data: { id: a.id, ownerId: '1', profileId: 'one' } })
  expect(b.id).toBe(a.id)
  await coordinator.wait(a.id)
  expect(factory).toHaveBeenCalledOnce()
  expect(hook).toHaveBeenCalledOnce()
  expect(coordinator.get(scope, a.id).hooks).toEqual([{ point: 'runs.start', pluginId: 'test.policy', generation: 'generation', key: 'policy', priority: 0 }])
  expect((db.prepare('SELECT effective_input_json FROM studio_agent_run_admissions WHERE run_id=?').get(a.id) as { effective_input_json: string }).effective_input_json).toContain('hook approved')
  expect(await context().runs.get(a.id)).toMatchObject({ status: 'completed' })
  expect(await context().runs.output(a.id)).toMatchObject([{ text: 'done' }])
  expect(new PluginEventStore(db).read('one').map(row => row.event.type)).toEqual(['run.completed'])
})

it('rejects changed retries but returns a committed receipt after provider removal and recovery', async () => {
  const { db, context, coordinator, registration, factory, request } = setup()
  const first = await context().runs.start(request())
  await coordinator.wait(first.id)
  await registration.dispose()
  const persisted = new AgentExecutionStore(db)
  expect(persisted.recover()).toBe(0)
  expect(await context().runs.start(request())).toMatchObject({ id: first.id, status: 'completed' })
  await expect(context().runs.start({ ...request(), input: { content: [{ type: 'text', text: 'changed' }] } })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
  expect(factory).toHaveBeenCalledOnce()
})

it.each([
  { ...scope, profileId: 'two' },
  { ...scope, principal: { kind: 'user' as const, id: '2' } },
])('does not start instances owned by another user/profile', async current => {
  const { context, factory, request } = setup()
  await expect(context(current).runs.start(request())).rejects.toMatchObject({ code: 'NOT_FOUND' })
  expect(factory).not.toHaveBeenCalled()
})

it.each(['sessionId', 'workspaceId', 'runId'] as const)('does not drop a %s constraint to launch an unrelated run', async key => {
  const { context, factory, request } = setup()
  await expect(context({ ...scope, [key]: 'bound' }).runs.start(request())).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' })
  expect(factory).not.toHaveBeenCalled()
})

it.each(['ownerId', 'principal', 'profileId', 'sessionId', 'runId', 'provider', 'scope'])('rejects caller-supplied %s', async key => {
  const { context, factory, request } = setup()
  await expect(context().runs.start({ ...request(), [key]: 'forged' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  expect(factory).not.toHaveBeenCalled()
})

it.each([
  { instanceId: '' }, { instanceId: 42 }, { instanceId: 'x'.repeat(257) }, { idempotencyKey: '' }, { idempotencyKey: 42 },
  { input: null }, { input: [] }, { input: { content: [] } }, { input: { content: [{ type: 'text', text: 42 }] } },
  { input: { content: [{ type: 'text', text: 'ok' }], principal: 'forged' } },
])('rejects malformed start requests before accepting a run: %j', async invalid => {
  const { db, context, factory, request } = setup()
  await expect(context().runs.start({ ...request(), ...invalid } as AgentRunStartInput)).rejects.toBeInstanceOf(StudioError)
  expect(db.prepare('SELECT count(*) AS count FROM studio_agent_runs').get()).toMatchObject({ count: 0 })
  expect(factory).not.toHaveBeenCalled()
})

it('uses the same validation and error codes for HTTP and SDK', async () => {
  const { context, request } = setup(), input = request(), base = await serve()
  const invalid = { ...input, input: { ...input.input, ownerId: 'forged' } }
  await expect(context().runs.start(invalid)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  const res = await fetch(`${base}/api/studio/agent-instances/${input.instanceId}/runs`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input: invalid.input, idempotencyKey: input.idempotencyKey }),
  })
  expect(res.status).toBe(400)
  expect(await res.json()).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } })
})

it('checks cancellation before and after authorization without accepting a run', async () => {
  const { db, context, request, beforeAuthorize, factory } = setup()
  const controller = new AbortController()
  beforeAuthorize.mockImplementationOnce(async () => { controller.abort() })
  await expect(context(scope, controller.signal).runs.start(request())).rejects.toMatchObject({ code: 'CANCELLED' })
  await expect(context(scope, controller.signal).runs.start(request())).rejects.toMatchObject({ code: 'CANCELLED' })
  expect(beforeAuthorize).toHaveBeenCalledOnce()
  expect(factory).not.toHaveBeenCalled()
  expect(db.prepare('SELECT count(*) AS count FROM studio_agent_runs').get()).toMatchObject({ count: 0 })
})

it('rechecks revoked access, including previously accepted idempotency keys', async () => {
  const { context, coordinator, request, revoke, factory } = setup()
  const run = await context().runs.start(request())
  await coordinator.wait(run.id)
  revoke()
  await expect(context().runs.start(request())).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(factory).toHaveBeenCalledOnce()
})

it('snapshots the request before asynchronous authorization', async () => {
  const { context, coordinator, request, beforeAuthorize, factory } = setup()
  let release!: () => void
  beforeAuthorize.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  const input = request(), original = request()
  const pending = context().runs.start(input)
  input.instanceId = 'forged'
  input.input.content = [{ type: 'text', text: 'changed' }]
  release()
  const accepted = await pending
  await coordinator.wait(accepted.id)
  expect(await context().runs.start(original)).toMatchObject({ id: accepted.id })
  expect(factory).toHaveBeenCalledOnce()
})

it('returns the accepted receipt if the caller scope ends after commit', async () => {
  const { context, coordinator, request } = setup()
  const controller = new AbortController(), accept = coordinator.start.bind(coordinator)
  vi.spyOn(coordinator, 'start').mockImplementation((...args) => { const run = accept(...args); controller.abort(); return run })
  const receipt = await context(scope, controller.signal).runs.start(request())
  await coordinator.wait(receipt.id)
  expect(coordinator.get(scope, receipt.id).status).toBe('completed')
})

it('rejects a missing host start port explicitly', async () => {
  const ctx = createExecutionContext(scope, new AbortController().signal, { info() {}, warn() {}, error() {} }, {
    authorize: async () => {}, sessions: { get: async () => null }, agents: { list: async () => [] },
  })
  await expect(ctx.runs.start({ instanceId: 'instance', input: { content: [{ type: 'text', text: 'go' }] }, idempotencyKey: 'request' })).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' })
})
