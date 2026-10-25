import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthenticatedUser } from '../../packages/server/src/modules/studio/public/auth'
import type { SessionState } from '../../packages/server/src/modules/studio/services/chat-run/types'

const mocks = vi.hoisted(() => ({
  rows: new Map<string, { profile: string; source?: string; agent?: string }>(),
  access: vi.fn(() => true),
  uploads: vi.fn(async () => {}),
  bindPush: vi.fn(() => ({ id: 'push-target', run_id: 'push-run' })),
  snapshot: vi.fn(() => 'encrypted'),
  webhook: vi.fn(),
}))
vi.mock('../../packages/server/src/modules/studio/repositories/session-store', () => ({
  getSession: (id: string) => mocks.rows.get(id),
}))
vi.mock('../../packages/server/src/modules/studio/repositories/session-category-store', () => ({
  getSessionCategory: (id: number) => id === 7 ? { id } : undefined,
}))
vi.mock('../../packages/server/src/modules/studio/public/profile-config', () => ({
  listProfileNamesFromDisk: () => ['default', 'research', 'private'],
}))
vi.mock('../../packages/server/src/modules/studio/repositories/users-store', () => ({ userCanAccessProfile: mocks.access }))
vi.mock('../../packages/server/src/modules/studio/services/files/session-uploads', () => ({ recordSessionUploadAttachments: mocks.uploads }))
vi.mock('../../packages/server/src/modules/studio/repositories/run-push-store', () => ({ bindRunPushTarget: mocks.bindPush }))
vi.mock('../../packages/server/src/modules/studio/services/notifications/push-registration', () => ({ prepareRunPushSnapshot: mocks.snapshot }))
vi.mock('../../packages/server/src/modules/studio/services/webhooks', () => ({ observeChatRunWebhookEvent: mocks.webhook }))
vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({ logger: { info: vi.fn(), warn: vi.fn() } }))
vi.mock('../../packages/server/src/modules/studio/public/chat-agent-runtime', () => ({
  parseChatCodingAgentSessionCommand: (input: string) => input === '/status' ? { name: 'status' } : null,
}))
// The store hydration port is separate from admission. Keep real getOrCreateSession and source selection.
vi.mock('../../packages/server/src/modules/studio/services/chat-run/load-state', async importOriginal => ({
  ...await importOriginal<typeof import('../../packages/server/src/modules/studio/services/chat-run/load-state')>(),
  readSessionStateFromDb: () => ({ messages: [], events: [], queue: [], isWorking: false }),
}))

import { startChatRun, resolveChatRunProfile, requireChatRunSessionAccess, type ChatRunStartPorts, type ChatRunStartRequest, type ChatRunStartScope } from '../../packages/server/src/modules/studio/services/chat-run/start'

function harness(scopeOverrides: Partial<ChatRunStartScope> = {}) {
  const state: SessionState = { messages: [], events: [], queue: [], isWorking: false }
  const scope: ChatRunStartScope = { profile: 'default', user: { id: 3, role: 'user' } as AuthenticatedUser, ...scopeOverrides }
  const ports = {
    sessions: new Map([['session', state]]),
    emit: vi.fn(), emitSession: vi.fn(), publish: vi.fn(), pushActor: vi.fn<ChatRunStartPorts['pushActor']>(async () => null),
    commands: { ekko: vi.fn(async () => {}), session: vi.fn(async () => {}), codingAgent: vi.fn(async () => {}) },
    execute: vi.fn(async () => {}),
  } satisfies ChatRunStartPorts
  const run = (data: Partial<ChatRunStartRequest> = {}) => startChatRun({ session_id: 'session', input: 'Hello', source: 'cli', ...data }, scope, ports)
  return { state, scope, ports, run }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.rows.clear()
  mocks.access.mockReturnValue(true)
  mocks.uploads.mockResolvedValue(undefined)
  mocks.bindPush.mockReturnValue({ id: 'push-target', run_id: 'push-run' })
})

describe('chat start admission without a transport', () => {
  it('sends bound chats to canonical admission without parsing legacy commands or entering the legacy queue', async () => {
    const { state, scope, ports } = harness()
    state.isWorking = true
    const managed = { ...ports, isManagedChat: () => true }
    for (const input of ['/status', '/branch', 'Next turn']) await startChatRun({ session_id: 'session', source: 'coding_agent', input, queue_id: input }, scope, managed)
    expect(ports.execute).toHaveBeenCalledTimes(3)
    expect(ports.commands.session).not.toHaveBeenCalled()
    expect(ports.commands.codingAgent).not.toHaveBeenCalled()
    expect(state.queue).toEqual([])
    expect(state.isWorking).toBe(true)
  })

  it('rejects shared managed chat writes before device binding or canonical admission', async () => {
    const { scope, ports } = harness({ shared: true })
    await startChatRun({ session_id: 'session', input: 'Hello' }, scope, { ...ports, isManagedChat: () => true })
    expect(ports.emit).toHaveBeenCalledWith('run.failed', expect.objectContaining({ error_code: 'FORBIDDEN' }))
    expect(ports.pushActor).not.toHaveBeenCalled()
    expect(ports.execute).not.toHaveBeenCalled()
  })
  it('resolves an existing session profile, explicit profile, and removed-profile fallback', () => {
    const { scope } = harness({ profile: 'research' })
    mocks.rows.set('session', { profile: 'private' })
    expect(resolveChatRunProfile(scope, 'session')).toBe('private')
    expect(resolveChatRunProfile(scope, 'session', ' default ')).toBe('default')
    mocks.rows.set('session', { profile: 'deleted' })
    expect(resolveChatRunProfile(scope, 'session')).toBe('research')
    expect(resolveChatRunProfile(scope)).toBe('research')
  })

  it.each(['missing', 'private'])('rejects unavailable profile %s before all admission side effects', async profile => {
    mocks.access.mockReturnValue(false)
    const { ports, state, run } = harness()
    await run({ profile, input: [{ type: 'file', name: 'file', path: '/tmp/file' }] })
    expect(ports.emit).toHaveBeenCalledWith('run.failed', expect.objectContaining({ session_id: 'session', error: expect.stringContaining('Profile') }))
    expect(mocks.uploads).not.toHaveBeenCalled()
    expect(ports.pushActor).not.toHaveBeenCalled()
    expect(ports.execute).not.toHaveBeenCalled()
    expect(state.isWorking).toBe(false)
  })

  it('checks the stored profile before granting upload provenance', async () => {
    mocks.rows.set('session', { profile: 'private' })
    const { ports, run } = harness()
    await run({ profile: 'research', input: [{ type: 'file', name: 'file', path: '/tmp/file' }] })
    expect(ports.emit).toHaveBeenCalledWith('run.failed', expect.objectContaining({ error: 'Profile "private" is not available on this connection' }))
    expect(mocks.uploads).not.toHaveBeenCalled()
    expect(ports.execute).not.toHaveBeenCalled()
  })

  it('registers pending-session attachments before execution', async () => {
    const { ports, run } = harness({ profile: 'research' })
    await run({ input: [{ type: 'file', name: 'file', path: '/tmp/file' }] })
    expect(mocks.uploads).toHaveBeenCalledWith('session', 'research', expect.any(Array), { allowPendingSession: true })
    expect(mocks.uploads.mock.invocationCallOrder[0]).toBeLessThan(ports.execute.mock.invocationCallOrder[0])
  })

  it('fails closed on attachment registration failure', async () => {
    mocks.uploads.mockRejectedValueOnce(new Error('upload unavailable'))
    const { ports, run } = harness()
    await run({ input: [{ type: 'file', name: 'file', path: '/tmp/file' }] })
    expect(ports.execute).not.toHaveBeenCalled()
    expect(ports.pushActor).not.toHaveBeenCalled()
    expect(ports.emit).toHaveBeenCalledWith('run.failed', expect.objectContaining({ error: 'upload unavailable' }))
  })

  it('preserves strict mutation access and the super-admin exception', () => {
    const { scope } = harness()
    expect(() => requireChatRunSessionAccess(scope, 'missing')).toThrow('Session not found')
    mocks.rows.set('session', { profile: 'research' })
    expect(() => requireChatRunSessionAccess(scope, 'session')).toThrow('not available on this connection')
    mocks.access.mockReturnValue(false)
    expect(() => requireChatRunSessionAccess(scope, 'session', 'research')).toThrow('not available for this user')
    scope.user!.role = 'super_admin'
    expect(requireChatRunSessionAccess(scope, 'session', 'research')).toBe('research')
    mocks.rows.set('session', { profile: 'deleted' })
    expect(() => requireChatRunSessionAccess(scope, 'session', 'deleted')).toThrow('does not exist')
  })

  it.each([
    { source: 'cli', agent_id: undefined, command: 'session' },
    { source: 'builtin_agent', agent_id: 'ekko-agent', command: 'ekko' },
    { source: 'coding_agent', agent_id: 'codex', command: 'codingAgent' },
  ] as const)('dispatches $command commands before device binding and queueing', async ({ source, agent_id, command }) => {
    const { state, ports, run } = harness()
    state.isWorking = true
    await run({ input: '/status', source, agent_id })
    expect(ports.commands[command]).toHaveBeenCalledOnce()
    expect(ports.pushActor).not.toHaveBeenCalled()
    expect(state.queue).toEqual([])
    expect(ports.execute).not.toHaveBeenCalled()
  })

  it('allows the shared branch command for a native runtime', async () => {
    const { ports, run } = harness()
    await run({ input: '/fork', source: 'coding_agent', agent_id: 'codex' })
    expect(ports.commands.session).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ name: 'branch' }), 'default')
    expect(ports.commands.codingAgent).not.toHaveBeenCalled()
  })

  it('reports session command errors through the session event port', async () => {
    const { ports, run } = harness()
    ports.commands.session.mockRejectedValueOnce(new Error('command failed'))
    await run({ input: '/status' })
    expect(ports.emitSession).toHaveBeenCalledWith('session', 'session.command', expect.objectContaining({ ok: false, action: 'error', message: 'command failed' }))
    expect(ports.execute).not.toHaveBeenCalled()
  })

  it.each(['workflow', 'group_chat'] as const)('leaves slash-prefixed %s Ekko tasks to the runtime', async source => {
    const { ports, run } = harness()
    await run({ input: '/status', source, agent_id: 'ekko-agent' })
    expect(ports.commands.ekko).not.toHaveBeenCalled()
    expect(ports.execute).toHaveBeenCalledWith(expect.objectContaining({ input: '/status', source }), 'default', undefined)
  })

  it('retains the queue owner, reauthorization and hidden-message projection for shared input', async () => {
    const reauthorize = vi.fn(async () => { throw new Error('share revoked') })
    const { ports, state, run } = harness({ shared: true, originId: 'owner', reauthorize })
    state.isWorking = true
    await run({ queue_id: 'q', display_input: null, input: [{ type: 'file', name: 'file', path: '/tmp/file' }], group_room_id: 'room' })
    expect(mocks.uploads).not.toHaveBeenCalled()
    expect(ports.pushActor).not.toHaveBeenCalled()
    expect(state.queue[0]).toMatchObject({ queue_id: 'q', originSocketId: 'owner', profile: 'default', groupRoomId: 'room', authorize: reauthorize })
    await expect(state.queue[0].authorize!()).rejects.toThrow('share revoked')
    expect(ports.publish).toHaveBeenCalledWith('session', 'run.queued', expect.objectContaining({ queue_length: 1, queued_messages: [] }))
    expect(ports.execute).not.toHaveBeenCalled()
  })

  it.each([false, true])('captures the initiating push device when queued=%s', async queued => {
    const { state, ports, run } = harness()
    state.isWorking = queued
    ports.pushActor.mockResolvedValueOnce({ userId: 3, deviceId: 'phone', studioDeviceId: 'studio' })
    await run({ push_snapshot: { platform: 'ios' }, queue_id: 'q', reasoning_effort: 'high', apiMode: 'codex_responses', api_mode: 'openai_completions' })
    expect(mocks.bindPush).toHaveBeenCalledWith(expect.objectContaining({ kind: 'chat', profile: 'default' }), 'session', expect.objectContaining({ deviceId: 'phone' }), { ciphertext: 'encrypted', platform: 'ios' })
    expect(ports.emit).toHaveBeenCalledWith('run.push.bound', { session_id: 'session', queue_id: 'q', run_id: 'push-run' })
    if (queued) expect(state.queue[0]).toMatchObject({ pushTargetId: 'push-target', reasoningEffort: 'high', apiMode: 'codex_responses', api_mode: 'openai_completions' })
    else {
      expect(ports.execute).toHaveBeenCalledWith(expect.not.objectContaining({ push_snapshot: expect.anything() }), 'default', 'push-target')
      expect(state.isWorking).toBe(true)
      expect(state.runStartedAt).toBeGreaterThan(0)
    }
  })

  it('does not queue or start when push authentication fails', async () => {
    const { ports, state, run } = harness()
    state.isWorking = true
    ports.pushActor.mockRejectedValueOnce(new Error('revoked device'))
    await run()
    expect(ports.emit).toHaveBeenCalledWith('run.failed', expect.objectContaining({ error: 'Run device binding failed' }))
    expect(state.queue).toEqual([])
    expect(ports.execute).not.toHaveBeenCalled()
  })

  it.each([undefined, 'runId', 'abortController', 'activeRunMarker'] as const)('only releases an unowned reservation after launch failure (%s)', async owner => {
    const { state, ports, run } = harness()
    ports.execute.mockImplementationOnce(async () => {
      if (owner === 'abortController') state.abortController = new AbortController()
      else if (owner) state[owner] = 'live'
      throw new Error('launch failed')
    })
    await run({ queue_id: 'q', workflow_id: 'workflow', workflow_node_id: 'node' })
    expect(state.isWorking).toBe(Boolean(owner))
    expect(ports.emit).toHaveBeenCalledWith('run.failed', expect.objectContaining({ error: 'launch failed', queue_id: 'q' }))
    expect(mocks.webhook).toHaveBeenCalledWith(expect.objectContaining({ event: 'run.failed', workflowId: 'workflow', workflowNodeId: 'node' }))
  })

  it('normalizes Ekko/category fields without changing the caller request', async () => {
    const { scope, ports, state } = harness()
    const request = Object.freeze({ session_id: 'session', input: 'Hello', source: 'coding_agent', agent_id: 'ekko-agent' as const, category_id: 999, push_snapshot: { platform: 'ios' } })
    await startChatRun(request, scope, ports)
    expect(ports.execute).toHaveBeenCalledWith(expect.objectContaining({ agent_id: 'ekko-agent', source: 'builtin_agent', category_id: null }), 'default', undefined)
    expect(request).toMatchObject({ agent_id: 'ekko-agent', source: 'coding_agent', category_id: 999, push_snapshot: { platform: 'ios' } })
    expect(state.isWorking).toBe(false) // The provider runtime owns the actual running reservation.
  })
})
