import { beforeEach, describe, expect, it, vi } from 'vitest'
const scenarioMock = vi.hoisted(() => ({ emitRunEvents: vi.fn() }))
vi.mock('../../packages/server/src/modules/studio/public/chat-run', () => ({ getChatRunServer: () => ({
  startDirectRun: (payload: unknown, options: any) => {
    scenarioMock.emitRunEvents(options.onEvent, payload)
    return { dispose: vi.fn(), dropQueued: vi.fn() }
  },
}) }))
vi.mock('../../packages/server/src/modules/studio/public/auth', () => ({
  authenticateUserToken: vi.fn(), inspectAppUserToken: vi.fn(async () => null), isAuthEnabled: vi.fn(async () => false),
}))

function makeCtx(body: Record<string, unknown>) {
  return {
    get: vi.fn((name: string) => name.toLowerCase() === 'authorization' ? 'Bearer token-1' : ''),
    state: { profile: { name: 'default' } },
    request: { body },
    status: 200,
    body: undefined as any,
  }
}

describe('chat-run action/event baseline', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns requires_action when approval is requested', async () => {
    scenarioMock.emitRunEvents.mockImplementation((emitNative: Function) => {
      emitNative('run.started', { run_id: 'run-1' })
      emitNative('approval.requested', { run_id: 'run-1', approval_id: 'approval-1', command: 'touch file' })
    })

    const { runOnce } = await import('../../packages/server/src/modules/studio/controllers/chat-run')
    const ctx = makeCtx({ session_id: 'session-1', input: 'needs approval', include_events: true })
    await runOnce(ctx as any)

    expect(ctx.status).toBe(409)
    expect(ctx.body).toMatchObject({
      ok: false,
      status: 'requires_action',
      event: 'approval.requested',
      session_id: 'session-1',
      run_id: 'run-1',
      action: { event: 'approval.requested', approval_id: 'approval-1' },
    })
    expect(ctx.body.events.map((event: any) => event.event)).toEqual(['run.started', 'approval.requested'])
  })

  it('returns requires_action when clarification is requested', async () => {
    scenarioMock.emitRunEvents.mockImplementation((emitNative: Function) => {
      emitNative('run.started', { run_id: 'run-1' })
      emitNative('clarify.requested', { run_id: 'run-1', question: 'Which room?' })
    })

    const { runOnce } = await import('../../packages/server/src/modules/studio/controllers/chat-run')
    const ctx = makeCtx({ session_id: 'session-1', input: 'needs clarify', include_events: true })
    await runOnce(ctx as any)

    expect(ctx.status).toBe(409)
    expect(ctx.body).toMatchObject({
      ok: false,
      status: 'requires_action',
      event: 'clarify.requested',
      action: { event: 'clarify.requested', question: 'Which room?' },
    })
  })

  it('records bounded event history and accumulates output/reasoning when include_events is true', async () => {
    scenarioMock.emitRunEvents.mockImplementation((emitNative: Function) => {
      emitNative('run.started', { run_id: 'run-1' })
      emitNative('reasoning.delta', { run_id: 'run-1', delta: 'thought' })
      emitNative('tool.started', { run_id: 'run-1', name: 'lookup' })
      emitNative('tool.completed', { run_id: 'run-1', name: 'lookup' })
      emitNative('message.delta', { run_id: 'run-1', delta: 'hello' })
      emitNative('run.completed', { run_id: 'run-1' })
    })

    const { runOnce } = await import('../../packages/server/src/modules/studio/controllers/chat-run')
    const ctx = makeCtx({ session_id: 'session-1', input: 'hello', include_events: true })
    await runOnce(ctx as any)

    expect(ctx.status).toBe(200)
    expect(ctx.body).toMatchObject({
      ok: true,
      status: 'completed',
      output: 'hello',
      reasoning: 'thought',
      run_id: 'run-1',
    })
    expect(ctx.body.events.map((event: any) => event.event)).toEqual([
      'run.started',
      'reasoning.delta',
      'tool.started',
      'tool.completed',
      'message.delta',
      'run.completed',
    ])
  })
})
