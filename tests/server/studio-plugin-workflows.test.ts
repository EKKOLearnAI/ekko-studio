import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ExecutionScope, WorkflowRunStartInput } from '../../packages/studio-plugin-sdk/src'
import type { WorkflowRunRecord } from '../../packages/server/src/modules/studio/repositories/workflow-run-store'

const state = vi.hoisted(() => ({ db: null as DatabaseSync | null, workflow: {} as any, runs: new Map<string, WorkflowRunRecord>(),
  start: vi.fn(), stop: vi.fn(), preflight: vi.fn(), models: vi.fn(), user: { id: 1, username: 'owner', role: 'super_admin', status: 'active' } as any }))
vi.mock('../../packages/server/src/modules/studio/infrastructure/database', () => ({ getDb: () => state.db }))
vi.mock('../../packages/server/src/modules/studio/repositories/users-store', () => ({ findUserById: () => state.user }))
vi.mock('../../packages/server/src/modules/studio/repositories/workflow-run-store', () => ({ getWorkflowRun: (id: string) => state.runs.get(id) || null }))
vi.mock('../../packages/server/src/modules/studio/services/workflow/manager', () => ({ getWorkflowManager: () => ({ get: () => state.workflow, runNow: state.start, stopRun: state.stop, setRuntimeStatus: vi.fn() }), preflightWorkflowExecutionDefinition: state.preflight }))
vi.mock('../../packages/server/src/modules/studio/public/workflow-runtime', () => ({ getWorkflowAvailableModelGroups: state.models }))
vi.mock('../../packages/server/src/modules/studio/services/workflow/import-capabilities', () => ({ assertWorkflowImportCapabilities: vi.fn() }))
vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({ logger: { error: vi.fn() } }))
import { StudioError } from '../../packages/studio-plugin-sdk/src'
import { PluginWorkflows } from '../../packages/server/src/modules/studio/services/workflow/plugin'
import { WorkflowRequestStore } from '../../packages/server/src/modules/studio/repositories/workflow-request-store'
import { workflowRequestIdentity } from '../../packages/server/src/modules/studio/services/workflow/input'
import { createExecutionContext } from '../../packages/server/src/modules/studio/services/context/execution'

const scope: ExecutionScope = { scopeId: 'scope', principal: { id: '1', kind: 'user' }, profileId: 'one', surface: 'event', traceId: 'trace' }
const request: WorkflowRunStartInput = { workflowId: 'workflow', input: 'original', startNodeIds: ['node'], idempotencyKey: 'key' }
const signal = () => new AbortController().signal
const authorize = vi.fn()
let workflows: PluginWorkflows
const fixture = (): WorkflowRunRecord => ({ id: 'run', workflow_id: 'workflow', user_id: 1, profile: 'one', status: 'running',
  workspace: '/private', snapshot_nodes: [{ private: true }], snapshot_edges: [], compiled_loops: [], start_node_ids: [],
  requested_timeout_ms: null, deadline_at: null, started_at: 1, finished_at: null, created_at: 1, error: 'private native detail', trigger_source: 'manual', scheduled_at: null })
beforeEach(() => {
  state.db = new DatabaseSync(':memory:'); state.runs.clear()
  state.workflow = { id: 'workflow', profile: 'one', nodes: [], edges: [], updated_at: 1 }
  state.user = { id: 1, username: 'owner', role: 'super_admin', status: 'active' }
  authorize.mockReset(); workflows = new PluginWorkflows(authorize)
  state.preflight.mockReset().mockResolvedValue({ activeNodes: [] })
  state.models.mockReset().mockResolvedValue([])
  state.start.mockReset().mockImplementation(async (_id, input) => {
    await input.assertCanStart()
    const run = fixture()
    new WorkflowRequestStore(state.db!).bind(input.requestIdentity, run.id)
    state.runs.set(run.id, run); input.onAccepted(run)
    return { run, nodeSessions: [] }
  })
  state.stop.mockReset().mockImplementation(async (_workflowId, id) => { state.runs.get(id)!.status = 'canceled' })
})
afterEach(() => { state.db!.close(); state.db = null })

it('accepts, reads and cancels its own run using the same workflow domain service', async () => {
  const accepted = await workflows.run(scope, request, signal())
  expect(accepted).toEqual({ id: 'run', workflowId: 'workflow', profileId: 'one', ownerId: '1', status: 'running', createdAt: 1, startedAt: 1, finishedAt: null })
  expect(state.start).toHaveBeenCalledWith('workflow', expect.objectContaining({ profile: 'one', input: 'original', startNodeIds: ['node'], user: { id: 1, username: 'owner', role: 'super_admin' } }))
  expect(workflows.get(scope, 'run')).toEqual(accepted)
  expect(await workflows.cancel(scope, 'run')).toMatchObject({ status: 'canceled' })
  expect(state.stop).toHaveBeenCalledWith('workflow', 'run', 'Workflow run canceled by owner')
  expect(JSON.stringify(accepted)).not.toContain('private')
})

it('reuses an accepted receipt without requiring its native provider to remain ready', async () => {
  await workflows.run(scope, request, signal())
  state.preflight.mockRejectedValue(new Error('provider unavailable'))
  expect((await workflows.run(scope, request, signal())).id).toBe('run')
  expect(state.start).toHaveBeenCalledOnce()
  await expect(workflows.run(scope, { ...request, input: 'changed' }, signal())).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
  state.runs.clear()
  await expect(workflows.run(scope, request, signal())).rejects.toMatchObject({ code: 'NOT_FOUND' })
  expect(state.start).toHaveBeenCalledOnce()
})

it.each(['sessionId', 'workspaceId', 'runId'] as const)('does not discard a %s binding to execute an independent workflow', async field => {
  await expect(workflows.run({ ...scope, [field]: 'bound' }, request, signal())).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' })
  expect(state.start).not.toHaveBeenCalled()
})

it.each([{ principal: { id: '2', kind: 'user' as const } }, { profileId: 'other' }])('does not let an administrator access another owner/profile run (%j)', async overrides => {
  state.runs.set('run', fixture())
  expect(() => workflows.get({ ...scope, ...overrides }, 'run')).toThrow('unavailable')
  await expect(workflows.cancel({ ...scope, ...overrides }, 'run')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  expect(state.stop).not.toHaveBeenCalled()
})

it('rejects workflows outside the current profile and imported runs without an owner', async () => {
  state.workflow.profile = 'other'
  await expect(workflows.run(scope, request, signal())).rejects.toMatchObject({ code: 'FORBIDDEN' })
  state.runs.set('run', { ...fixture(), user_id: null })
  expect(() => workflows.get(scope, 'run')).toThrow('unavailable')
  expect(state.start).not.toHaveBeenCalled()
})

it.each([{ ...request, principal: { id: '2' } }, { ...request, timeoutMs: 10 }, { ...request, startNodeIds: [42] }, { ...request, input: [] }])('rejects invalid public workflow input before dispatch', async input => {
  await expect(workflows.run(scope, input as never, signal())).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  expect(state.start).not.toHaveBeenCalled()
})

it('rechecks revocation, definition mutation and cancellation after preflight', async () => {
  state.preflight.mockImplementationOnce(async () => { authorize.mockImplementation(() => { throw new StudioError('FORBIDDEN', 'revoked') }); return { activeNodes: [] } })
  await expect(workflows.run(scope, request, signal())).rejects.toMatchObject({ code: 'FORBIDDEN' })
  authorize.mockReset()
  state.preflight.mockImplementationOnce(async () => { state.workflow.updated_at++; return { activeNodes: [] } })
  await expect(workflows.run(scope, request, signal())).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
  const controller = new AbortController()
  state.preflight.mockImplementationOnce(async () => { controller.abort(); return { activeNodes: [] } })
  await expect(workflows.run(scope, request, controller.signal)).rejects.toMatchObject({ code: 'CANCELLED' })
  expect(state.start).not.toHaveBeenCalled()
})

it('snapshots SDK input before asynchronous context authorization and keeps accepted work independent', async () => {
  const controller = new AbortController(), mutable = structuredClone(request)
  const services = { authorize: async () => { mutable.input = 'mutated'; mutable.startNodeIds![0] = 'other' },
    sessions: { get: async () => null }, agents: { list: async () => [] }, workflows: {
      run: (scope: ExecutionScope, input: WorkflowRunStartInput, signal: AbortSignal) => workflows.run(scope, input, signal),
      get: async (scope: ExecutionScope, id: string) => workflows.get(scope, id), cancel: (scope: ExecutionScope, id: string) => workflows.cancel(scope, id),
    } }
  const start = state.start.getMockImplementation()!
  state.start.mockImplementation(async (...args) => { const result = await start(...args); controller.abort(); return result })
  const context = createExecutionContext(scope, controller.signal, { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, services)
  expect(await context.workflows.run(mutable)).toMatchObject({ id: 'run' })
  expect(state.start).toHaveBeenCalledWith('workflow', expect.objectContaining({ input: 'original', startNodeIds: ['node'] }))
  expect(state.stop).not.toHaveBeenCalled()
})

it('rolls back a request binding together with a failed acceptance transaction', () => {
  const store = new WorkflowRequestStore(state.db!)
  const identity = workflowRequestIdentity('1', 'one', request)
  expect(() => store.transaction(() => { store.bind(identity, 'run'); throw new Error('commit failed') })).toThrow('commit failed')
  expect(store.find(identity)).toBeNull()
  store.transaction(() => store.bind(identity, 'run'))
  expect(store.find(identity)).toBe('run')
  expect(store.find({ ...identity, ownerId: '2' })).toBeNull()
})

it('does not leak native preflight error text into plugin RPC', async () => {
  state.preflight.mockRejectedValue(new Error('secret endpoint credential'))
  await expect(workflows.run(scope, request, signal())).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', message: 'Workflow could not be started' })
})
