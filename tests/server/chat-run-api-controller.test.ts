import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DirectChatRunOptions } from '../../packages/server/src/modules/studio/services/chat-run/direct'

const { startMock, authMock, dispose } = vi.hoisted(() => ({ startMock: vi.fn(), authMock: vi.fn(async () => ({ id: 1, role: 'super_admin' })), dispose: vi.fn() }))
vi.mock('../../packages/server/src/modules/studio/public/chat-run', () => ({ getChatRunServer: () => ({ startDirectRun: startMock }) }))
vi.mock('../../packages/server/src/modules/studio/public/auth', () => ({
  authenticateUserToken: authMock, inspectAppUserToken: vi.fn(async () => null), isAuthEnabled: vi.fn(async () => true),
}))
// A regression must fail loudly instead of silently establishing a local connection.
vi.mock('socket.io-client', () => ({ io: () => { throw new Error('HTTP must not open Socket.IO') } }))

describe('chat-run HTTP API controller', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    startMock.mockImplementation((_request: unknown, options: DirectChatRunOptions) => {
      options.onEvent('run.started', { event: 'run.started', run_id: 'run-1' })
      options.onEvent('message.delta', { event: 'message.delta', run_id: 'run-1', delta: 'hello' })
      options.onEvent('plan.updated', { event: 'plan.updated', run_id: 'turn-1', plan_id: 'mcp:context', revision: 1 })
      options.onEvent('run.completed', { event: 'run.completed', run_id: 'run-1' })
      return { dispose, dropQueued: vi.fn() }
    })
  })

  it('rejects a coding-agent run without an explicit execution identity and explains the correct request', async () => {

    const { runOnce } = await import('../../packages/server/src/modules/studio/controllers/chat-run')
    const ctx = {
      get: vi.fn(() => ''),
      state: { profile: { name: 'default' } },
      request: {
        body: {
          input: 'continue work',
          source: 'coding_agent',
          coding_agent_id: 'codex',
          mode: 'scoped',
        },
      },
      status: 200,
      body: undefined as any,
    }

    await runOnce(ctx as any)

    expect(ctx.status).toBe(400)
    expect(ctx.body).toMatchObject({
      ok: false,
      error: expect.stringContaining('provider, model, and apiMode are required'),
    })
    expect(ctx.body.error).toContain('"apiMode":"codex_responses"')
    expect(startMock).not.toHaveBeenCalled()
  })

  it.each([
    { provider: 'custom:corp-codex' },
    { model: 'gpt-5.6-terra' },
    { apiMode: 'codex_responses' },
    { provider: 'custom:corp-codex', model: 'gpt-5.6-terra' },
    { provider: 'custom:corp-codex', apiMode: 'codex_responses' },
    { model: 'gpt-5.6-terra', apiMode: 'codex_responses' },
  ])('rejects a partial execution identity before starting a run: %j', async (identity) => {

    const { runOnce } = await import('../../packages/server/src/modules/studio/controllers/chat-run')
    const ctx = {
      get: vi.fn(() => ''),
      state: { profile: { name: 'default' } },
      request: { body: { input: 'continue work', source: 'coding_agent', ...identity } },
      status: 200,
      body: undefined as any,
    }

    await runOnce(ctx as any)

    expect(ctx.status).toBe(400)
    expect(ctx.body).toMatchObject({
      ok: false,
      error: expect.stringContaining('provider, model, and apiMode are required'),
    })
    expect(ctx.body.error).toContain('"apiMode":"codex_responses"')
    expect(startMock).not.toHaveBeenCalled()
  })

  it('rejects an unsupported API mode and names the OpenAI Responses value', async () => {

    const { runOnce } = await import('../../packages/server/src/modules/studio/controllers/chat-run')
    const ctx = {
      get: vi.fn(() => ''),
      state: { profile: { name: 'default' } },
      request: { body: {
        input: 'continue work',
        source: 'coding_agent',
        provider: 'custom:explicit',
        model: 'explicit-model',
        apiMode: 'openai_responses',
      } },
      status: 200,
      body: undefined as any,
    }

    await runOnce(ctx as any)

    expect(ctx.status).toBe(400)
    expect(ctx.body).toMatchObject({
      ok: false,
      error: expect.stringContaining('For OpenAI Responses use "apiMode":"codex_responses"'),
    })
    expect(startMock).not.toHaveBeenCalled()
  })

  it('preserves a complete explicit execution identity without reading Profile defaults', async () => {

    const { runOnce } = await import('../../packages/server/src/modules/studio/controllers/chat-run')
    const ctx = {
      get: vi.fn(() => ''),
      state: { profile: { name: 'default' } },
      request: { body: {
        input: 'continue work',
        source: 'coding_agent',
        provider: 'custom:explicit',
        model: 'explicit-model',
        apiMode: 'anthropic_messages',
        apiKey: 'must-not-leave-http-boundary',
        baseUrl: 'https://must-not-leave.example/v1',
      } },
      status: 200,
      body: undefined as any,
    }

    await runOnce(ctx as any)

    expect(startMock).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'custom:explicit',
      model: 'explicit-model',
      apiMode: 'anthropic_messages',
    }), expect.anything())
    const emittedPayload = startMock.mock.calls[0]?.[0]
    expect(emittedPayload).not.toHaveProperty('apiKey')
    expect(emittedPayload).not.toHaveProperty('baseUrl')
  })

  it('runs chat-run directly without a loopback connection and returns a completed HTTP response', async () => {

    const { runOnce } = await import('../../packages/server/src/modules/studio/controllers/chat-run')
    const ctx = {
      get: vi.fn((name: string) => name.toLowerCase() === 'authorization' ? 'Bearer token-1' : ''),
      state: { profile: { name: 'default' } },
      request: {
        body: {
          session_id: 'session-1',
          input: 'hello',
          include_events: true,
        },
      },
      status: 200,
      body: undefined as any,
    }

    await runOnce(ctx as any)

    expect(authMock).toHaveBeenCalledWith('token-1')
    expect(startMock).toHaveBeenCalledWith(expect.objectContaining({
      session_id: 'session-1',
      input: 'hello',
      profile: 'default',
    }), expect.anything())
    expect(ctx.status).toBe(200)
    expect(ctx.body).toMatchObject({
      ok: true,
      status: 'completed',
      session_id: 'session-1',
      run_id: 'run-1',
      output: 'hello',
    })
    expect(dispose).toHaveBeenCalledOnce()
    expect(ctx.body.events).toHaveLength(4)
    expect(ctx.body.events).toContainEqual(expect.objectContaining({ event: 'plan.updated', plan_id: 'mcp:context', revision: 1 }))
  })

  it('generates a session id when none is provided', async () => {

    const { runOnce } = await import('../../packages/server/src/modules/studio/controllers/chat-run')
    const ctx = {
      get: vi.fn((name: string) => name.toLowerCase() === 'authorization' ? 'Bearer token-1' : ''),
      state: { profile: { name: 'default' } },
      request: {
        body: {
          source: 'cli',
          input: 'start a new chat',
        },
      },
      status: 200,
      body: undefined as any,
    }

    await runOnce(ctx as any)

    const emittedPayload = startMock.mock.calls[0]?.[0] as Record<string, unknown>
    expect(emittedPayload.session_id).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/))
    expect(emittedPayload).toMatchObject({
      source: 'cli',
      input: 'start a new chat',
      profile: 'default',
    })
    expect(ctx.status).toBe(200)
    expect(ctx.body).toMatchObject({
      ok: true,
      status: 'completed',
      session_id: emittedPayload.session_id,
    })
  })

  it('generates a session id for global-agent runs when none is provided', async () => {

    const { runOnce } = await import('../../packages/server/src/modules/studio/controllers/chat-run')
    const ctx = {
      get: vi.fn((name: string) => name.toLowerCase() === 'authorization' ? 'Bearer token-1' : ''),
      state: { profile: { name: 'default' } },
      request: {
        body: {
          source: 'global_agent',
          input: 'start a global run',
        },
      },
      status: 200,
      body: undefined as any,
    }

    await runOnce(ctx as any)

    const emittedPayload = startMock.mock.calls[0]?.[0] as Record<string, unknown>
    expect(emittedPayload.session_id).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/))
    expect(emittedPayload).toMatchObject({
      source: 'global_agent',
      input: 'start a global run',
      profile: 'default',
    })
    expect(ctx.body).toMatchObject({
      ok: true,
      status: 'completed',
      session_id: emittedPayload.session_id,
    })
  })
})
