import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { StudioError, type ExecutionScope } from '../../packages/studio-plugin-sdk/src'
import { PluginChatRunStore } from '../../packages/server/src/modules/studio/repositories/plugin-chat-run-store'
import { PluginChatRuns, authorizeOwnedChatSession } from '../../packages/server/src/modules/studio/services/chat-run/plugin'
import { createExecutionContext } from '../../packages/server/src/modules/studio/services/context/execution'
import type { DirectChatRunOptions } from '../../packages/server/src/modules/studio/services/chat-run/direct'

const policy = vi.hoisted(() => ({ user: vi.fn(), session: vi.fn(), profile: vi.fn() }))
vi.mock('../../packages/server/src/modules/studio/repositories/users-store', () => ({ findUserById: policy.user, userCanAccessProfile: policy.profile }))
vi.mock('../../packages/server/src/modules/studio/repositories/session-store', () => ({ getSessionMetadata: policy.session }))
const scope: ExecutionScope = { scopeId: 'scope', principal: { kind: 'user', id: '1' }, profileId: 'one', surface: 'api', traceId: 'trace' }
const request = { sessionId: 'session', input: 'hello', idempotencyKey: 'request' }
const user = { id: 1, username: 'owner', role: 'user', status: 'active' }
const session = { id: 'session', studio_user_id: '1', user_id: 'gateway-id', profile: 'one', source: 'coding_agent', agent: 'codex',
  model: 'model', provider: 'provider', api_mode: 'responses', reasoning_effort: 'high', workspace: '/workspace', agent_mode: 'scoped' }
const cleanup: Array<() => void> = []
beforeEach(() => { policy.user.mockReturnValue({ ...user }); policy.session.mockReturnValue({ ...session }); policy.profile.mockReturnValue(true) })
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close() })

function setup() {
  const db = new DatabaseSync(':memory:'), store = new PluginChatRunStore(db)
  const calls: DirectChatRunOptions[] = []
  const dispose = vi.fn(), dropQueued = vi.fn(), cancel = vi.fn(async () => {})
  const server = { startDirectRun: vi.fn((_request, options: DirectChatRunOptions) => {
    calls.push(options)
    return { dispose, dropQueued, cancel }
  }) }
  const service = new PluginChatRuns({ store, server: () => server, authorize: authorizeOwnedChatSession })
  const authorize = vi.fn(async () => {})
  const controller = new AbortController()
  const context = (current = scope, signal = controller.signal) => createExecutionContext(current, signal, { info() {}, warn() {}, error() {} }, {
    authorize, sessions: { get: async () => null }, agents: { list: async () => [] },
    chat: { start: async (s, r, signal) => service.start(s, r, signal), get: async (s, id) => service.get(s, id), cancel: (s, id) => service.cancel(s, id) },
  })
  cleanup.push(() => { service.close(); db.close() })
  return { db, store, service, context, controller, server, calls, dispose, dropQueued, cancel, authorize }
}

it('deduplicates concurrent starts and uses only the host identity and stored configuration', async () => {
  const { context, calls, server, controller } = setup()
  const [a, b] = await Promise.all([context().chat.start(request), context().chat.start({ ...request })])
  expect(a.id).toBe(b.id)
  expect(server.startDirectRun).toHaveBeenCalledOnce()
  expect(server.startDirectRun.mock.calls[0][0]).toMatchObject({ session_id: 'session', input: 'hello', coding_agent_id: 'codex', workspace: '/workspace', model: 'model', provider: 'provider' })
  expect(calls[0].user).toMatchObject({ id: 1 })
  controller.abort()
  expect(calls[0].context!.signal.aborted).toBe(false)
  calls[0].onEvent('message.delta', { delta: 'answer' })
  calls[0].onEvent('run.completed', {})
  const fresh = context(scope, new AbortController().signal)
  expect(await fresh.chat.get(a.id)).toMatchObject({ status: 'completed', output: 'answer' })
  expect(await fresh.chat.start(request)).toMatchObject({ id: a.id, status: 'completed' })
  await expect(fresh.chat.start({ ...request, input: 'different' })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
})

it.each(['principal', 'ownerId', 'profile', 'provider', 'workspace', 'scope', 'mcpServers', 'apiKey'])('rejects injected %s before any side effect', async field => {
  const { context, server } = setup()
  await expect(context().chat.start({ ...request, [field]: 'forged' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  expect(server.startDirectRun).not.toHaveBeenCalled()
})

it.each(['', '/clear', ' /branch', 42, [{ type: 'text', text: 'hello' }]])('rejects unsupported or invalid text %j', async input => {
  const { context, server } = setup()
  await expect(context().chat.start({ ...request, input } as any)).rejects.toMatchObject({ code: typeof input === 'string' && input.trim().startsWith('/') ? 'CAPABILITY_UNSUPPORTED' : 'INVALID_ARGUMENT' })
  expect(server.startDirectRun).not.toHaveBeenCalled()
})

it.each(['principal', 'inactive', 'profile', 'owner', 'unowned', 'gateway', 'other-session', 'service'])('rejects %s access including admin ownership bypass', async variant => {
  const { context, server } = setup()
  let current = scope
  if (variant === 'principal') policy.user.mockReturnValue(null)
  if (variant === 'inactive') policy.user.mockReturnValue({ ...user, status: 'disabled' })
  if (variant === 'profile') policy.profile.mockReturnValue(false)
  if (variant === 'owner') { policy.user.mockReturnValue({ ...user, role: 'super_admin' }); policy.session.mockReturnValue({ ...session, studio_user_id: '2' }) }
  if (variant === 'unowned') policy.session.mockReturnValue({ ...session, studio_user_id: null })
  if (variant === 'gateway') policy.session.mockReturnValue({ ...session, studio_user_id: null, user_id: '1', source: 'cli' })
  if (variant === 'other-session') current = { ...scope, sessionId: 'other' }
  if (variant === 'service') current = { ...scope, principal: { kind: 'service', id: '1' } }
  await expect(context(current).chat.start(request)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(server.startDirectRun).not.toHaveBeenCalled()
})

it.each(['runId', 'workspaceId'])('preserves unsupported %s constraints', async field => {
  const { context, server } = setup()
  await expect(context({ ...scope, [field]: 'bound' }).chat.start(request)).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' })
  expect(server.startDirectRun).not.toHaveBeenCalled()
})

it.each(['workflow', 'group_chat', 'global_agent'])('does not invoke %s through direct chat', async source => {
  const { context } = setup()
  policy.session.mockReturnValue({ ...session, source })
  await expect(context().chat.start(request)).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' })
})

it('snapshots input before authorization and rejects cancellation during that wait', async () => {
  const { context, authorize, controller, server } = setup()
  let release!: () => void
  authorize.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve }))
  const input = { ...request }
  const pending = context().chat.start(input)
  input.input = 'changed'
  release()
  await pending
  expect(server.startDirectRun.mock.calls[0][0].input).toBe('hello')
  authorize.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve }))
  const cancelled = context().chat.start({ ...request, idempotencyKey: 'cancelled' })
  controller.abort(); release()
  await expect(cancelled).rejects.toMatchObject({ code: 'CANCELLED' })
  expect(server.startDirectRun).toHaveBeenCalledOnce()
})

it('rechecks owner/profile/config before deferred dispatch and on every read, cancel and retry', async () => {
  const { context, calls, cancel } = setup()
  const ctx = context({ ...scope, sessionId: 'session' })
  const receipt = await ctx.chat.start(request)
  policy.session.mockReturnValue({ ...session, model: 'changed' })
  await expect(calls[0].reauthorize!()).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
  policy.session.mockReturnValue({ ...session, studio_user_id: '2' })
  await expect(calls[0].reauthorize!()).rejects.toMatchObject({ code: 'FORBIDDEN' })
  await expect(ctx.chat.get(receipt.id)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  await expect(ctx.chat.cancel(receipt.id)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  await expect(ctx.chat.start(request)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(cancel).not.toHaveBeenCalled()
})

it('isolates result and cancellation by owner, profile and session binding', async () => {
  const { context, cancel } = setup()
  const receipt = await context().chat.start(request)
  for (const current of [{ ...scope, principal: { kind: 'user' as const, id: '2' } }, { ...scope, profileId: 'two' }, { ...scope, sessionId: 'other' }]) {
    await expect(context(current).chat.get(receipt.id)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(context(current).chat.cancel(receipt.id)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  }
  expect(cancel).not.toHaveBeenCalled()
})

it('retains waiting input and bounded output, and finalizes exactly once on confirmed cancellation', async () => {
  const { context, calls, dispose } = setup()
  const ctx = context(), receipt = await ctx.chat.start(request)
  calls[0].onEvent('run.started', {})
  calls[0].onEvent('reasoning.delta', { delta: 'thought' })
  calls[0].onEvent('message.delta', { delta: 'x'.repeat(70_000) })
  calls[0].onEvent('approval.requested', { secret: 'not public' })
  expect(await ctx.chat.get(receipt.id)).toMatchObject({ status: 'waiting_input', reasoning: 'thought', truncated: true })
  expect((await ctx.chat.cancel(receipt.id)).status).toBe('cancelling')
  calls[0].onEvent('abort.completed', { synced: true })
  const terminal = await ctx.chat.get(receipt.id)
  calls[0].onEvent('run.completed', { output: 'late' })
  expect(await ctx.chat.get(receipt.id)).toEqual(terminal)
  expect(terminal.output).toHaveLength(65_536)
  expect(terminal.status).toBe('cancelled')
  expect(dispose).toHaveBeenCalledOnce()
})

it('lets actual completion win cancellation and does not report native timeout as cancelled', async () => {
  const { context, calls, cancel } = setup()
  const ctx = context(), receipt = await ctx.chat.start(request)
  cancel.mockImplementationOnce(async () => calls[0].onEvent('run.completed', { output: 'done' }))
  expect(await ctx.chat.cancel(receipt.id)).toMatchObject({ status: 'completed' })
  expect(await ctx.chat.get(receipt.id)).toMatchObject({ output: 'done' })
  await ctx.chat.cancel(receipt.id)
  expect(cancel).toHaveBeenCalledOnce()
  const other = await ctx.chat.start({ ...request, idempotencyKey: 'other' })
  calls[1].onEvent('abort.completed', { synced: false })
  expect(await ctx.chat.get(other.id)).toMatchObject({ status: 'interrupted', errorCode: 'RUNTIME_UNAVAILABLE' })
})

it('does not return collected content if ownership is revoked during cancellation', async () => {
  const { context, calls, cancel } = setup()
  const ctx = context(), receipt = await ctx.chat.start(request)
  calls[0].onEvent('message.delta', { delta: 'private' })
  cancel.mockImplementationOnce(async () => { policy.user.mockReturnValue(null) })
  await expect(ctx.chat.cancel(receipt.id)).rejects.toMatchObject({ code: 'FORBIDDEN' })
})

it('keeps output behind chat.read even on idempotent starts and terminal cancellation', async () => {
  const { context, calls, authorize } = setup()
  const ctx = context(), started = await ctx.chat.start(request)
  calls[0].onEvent('run.completed', { output: 'private answer', reasoning: 'private reasoning' })
  authorize.mockImplementation(async (_scope, operation) => {
    if (operation === 'chat.read') throw new StudioError('FORBIDDEN', 'Read capability revoked')
  })
  await expect(ctx.chat.get(started.id)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  for (const result of [await ctx.chat.start(request), await ctx.chat.cancel(started.id)]) {
    expect(result).toMatchObject({ id: started.id, status: 'completed' })
    expect(result).not.toHaveProperty('output')
    expect(result).not.toHaveProperty('reasoning')
  }
})

it('recovers unfinished persisted receipts as interrupted without replaying or overwriting terminal results', async () => {
  const { context, calls, store, db, server } = setup()
  const done = await context().chat.start(request)
  calls[0].onEvent('run.completed', { output: 'done' })
  const pending = await context().chat.start({ ...request, idempotencyKey: 'pending' })
  const restored = new PluginChatRunStore(db)
  restored.recover()
  expect(restored.get(done.id)).toMatchObject({ status: 'completed', output: 'done' })
  expect(store.get(pending.id)).toMatchObject({ status: 'interrupted' })
  expect(await context().chat.start({ ...request, idempotencyKey: 'pending' })).toMatchObject({ id: pending.id, status: 'interrupted' })
  expect(server.startDirectRun).toHaveBeenCalledTimes(2)
})

it('persists synchronous startup failure and closes pending receipts and observers', async () => {
  const { context, server, service, store, dispose, dropQueued } = setup()
  server.startDirectRun.mockImplementationOnce(() => { throw new Error('private transport details') })
  expect(await context().chat.start(request)).toMatchObject({ status: 'failed', errorCode: 'RUNTIME_UNAVAILABLE' })
  const pending = await context().chat.start({ ...request, idempotencyKey: 'pending' })
  service.close()
  expect(store.get(pending.id)).toMatchObject({ status: 'interrupted' })
  expect(dispose).toHaveBeenCalledOnce()
  expect(dropQueued).toHaveBeenCalledOnce()
})
