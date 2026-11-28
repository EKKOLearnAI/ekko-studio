import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ db: null as DatabaseSync | null, json: new Map<string, object>(),
  sessions: new Map<string, Record<string, unknown>>(), inspect: vi.fn(), connected: vi.fn(), idle: vi.fn(), profiles: ['default', 'work'] }))
vi.mock('../../packages/server/src/modules/studio/infrastructure/database', () => ({
  getDb: () => fixture.db,
  jsonGet: (table: string, key: string) => fixture.json.get(`${table}/${key}`),
  jsonSet: (table: string, key: string, row: object) => fixture.json.set(`${table}/${key}`, structuredClone(row)),
}))
vi.mock('../../packages/server/src/modules/studio/public/auth', () => ({ inspectAppUserToken: fixture.inspect }))
vi.mock('../../packages/server/src/modules/studio/public/users', () => ({
  findUserById: (id: number) => ({ id, role: 'user', status: 'active' }),
  userCanAccessProfile: (_id: number, profile: string) => fixture.profiles.includes(profile),
}))
vi.mock('../../packages/server/src/modules/studio/public/global-agent', () => ({ getGlobalAgentServer: () => ({ getOwnedMcuDevice: fixture.connected }) }))
vi.mock('../../packages/server/src/modules/studio/public/chat-run', () => ({ getChatRunServer: () => ({ assertSessionMessagesEditable: fixture.idle }) }))
vi.mock('../../packages/server/src/modules/studio/repositories/session-store', () => ({ getSession: (id: string) => fixture.sessions.get(id) }))
import { syncTable, MCU_SESSION_BINDINGS_TABLE, MCU_SESSION_BINDINGS_SCHEMA, MCU_SESSION_BINDINGS_INDEXES } from '../../packages/server/src/modules/studio/infrastructure/database/schemas'
import { compareAndSetMcuSessionBinding, getMcuSessionBinding } from '../../packages/server/src/modules/studio/repositories/mcu-session-bindings'
import { readMcuBinding, writeMcuBinding, reserveMcuVoiceRoute, validateMcuVoiceRoute, releaseMcuVoiceRoute, releaseMcuVoiceForeground } from '../../packages/server/src/modules/studio/services/devices/mcu-session-bindings'

const owner = { userId: 1, profile: 'default', deviceCode: 'physical-a' }
const device = { ...owner, clientId: 'logical-a', agentRuntime: 'hermes', online: true }
const input = { userId: 1, profile: 'default', clientId: 'logical-a', userToken: 'fixture-app', interactionId: 'voice-a', agentRuntime: 'hermes' as const }
const leases: string[] = []
async function reserve(overrides = {}) { const route = await reserveMcuVoiceRoute({ ...input, ...overrides }); leases.push(route.leaseId); return route }
function session(id: string, overrides: Record<string, unknown> = {}) {
  return { id, profile: 'default', source: 'cli', agent: '', agent_mode: '', studio_user_id: '1', model: 'selected-model', provider: 'selected-provider', api_mode: 'chat_completions', workspace: '/fixture-workspace', ...overrides }
}
beforeEach(() => {
  fixture.db = new DatabaseSync(':memory:')
  syncTable(MCU_SESSION_BINDINGS_TABLE, MCU_SESSION_BINDINGS_SCHEMA, { indexes: MCU_SESSION_BINDINGS_INDEXES })
  fixture.profiles = ['default', 'work']; fixture.json.clear(); fixture.sessions.clear()
  fixture.sessions.set('chat-a', session('chat-a')); fixture.sessions.set('chat-b', session('chat-b'))
  fixture.sessions.set('person-main-a', session('person-main-a', { source: 'builtin_agent', agent: 'ekko-agent', profile: 'work' }))
  fixture.inspect.mockResolvedValue({ status: 'active', user: { id: 1 }, deviceCode: owner.deviceCode })
  fixture.idle.mockResolvedValue(undefined)
  fixture.connected.mockImplementation(async (who, clientId) => who.userId === 1 && who.profile === 'default'
    && who.deviceCode === 'physical-a' && (!clientId || clientId === 'logical-a') ? { deviceCode: owner.deviceCode,
      clientId: device.clientId, profile: 'default', agentRuntime: 'hermes', online: true } : null)
})
afterEach(() => { leases.splice(0).forEach(releaseMcuVoiceRoute); fixture.db?.close(); fixture.db = null; vi.clearAllMocks() })

describe('MCU binding compare-and-set storage', () => {
  it('isolates accounts/profiles and preserves revisions when a binding is deleted', () => {
    expect(getMcuSessionBinding(owner)).toBeNull()
    expect(compareAndSetMcuSessionBinding(owner, 0, { sessionId: 'chat-a', kind: 'chat' }).revision).toBe(1)
    expect(getMcuSessionBinding({ ...owner, userId: 2 })).toBeNull()
    expect(getMcuSessionBinding({ ...owner, profile: 'work' })).toBeNull()
    expect(compareAndSetMcuSessionBinding(owner, 1, null)).toMatchObject({ revision: 2, sessionId: null })
    expect(() => compareAndSetMcuSessionBinding(owner, 0, { sessionId: 'chat-b', kind: 'chat' })).toThrow('reload')
    expect(compareAndSetMcuSessionBinding(owner, 2, { sessionId: 'chat-b', kind: 'chat' }).revision).toBe(3)
  })
  it('retains the same tombstone/CAS semantics in the single-process JSON fallback', () => {
    fixture.db?.close(); fixture.db = null
    compareAndSetMcuSessionBinding(owner, 0, { sessionId: 'chat-a', kind: 'chat' })
    compareAndSetMcuSessionBinding(owner, 1, null)
    expect(() => compareAndSetMcuSessionBinding(owner, 1, null)).toThrow('reload')
    expect(getMcuSessionBinding(owner)).toMatchObject({ revision: 2, sessionId: null })
  })
})

describe('owned MCU session binding and voice lease', () => {
  it('binds a real conversation with current revision and exposes only scoped device metadata', async () => {
    const snapshot = await writeMcuBinding(owner, 0, { sessionId: 'chat-a', kind: 'chat' })
    expect(snapshot).toMatchObject({ revision: 1, binding: { sessionId: 'chat-a', kind: 'chat', revision: 1 }, device: { clientId: 'logical-a', online: true } })
    const foreign = await readMcuBinding({ ...owner, userId: 2 })
    expect(foreign).toMatchObject({ revision: 0, binding: null, device: { online: false, clientId: '', agentRuntime: '' } })
  })
  it('does not write offline, foreign-owner, stale-revision, wrong-kind or cross-profile bindings', async () => {
    await expect(writeMcuBinding({ ...owner, userId: 2 }, 0, { sessionId: 'chat-a', kind: 'chat' })).rejects.toMatchObject({ status: 409 })
    await expect(writeMcuBinding(owner, 0, { sessionId: 'chat-a', kind: 'bot' })).rejects.toMatchObject({ status: 400 })
    fixture.sessions.set('other-profile', session('other-profile', { profile: 'work' }))
    await expect(writeMcuBinding(owner, 0, { sessionId: 'other-profile', kind: 'chat' })).rejects.toMatchObject({ status: 403 })
    await writeMcuBinding(owner, 0, { sessionId: 'chat-a', kind: 'chat' })
    await expect(writeMcuBinding(owner, 0, null)).rejects.toMatchObject({ status: 409 })
    expect(getMcuSessionBinding(owner)?.sessionId).toBe('chat-a')
  })
  it('uses owned BOT conversations and defers their model/agent policy to core chat-run', async () => {
    await writeMcuBinding(owner, 0, { sessionId: 'person-main-a', kind: 'bot' })
    const route = await reserve()
    expect(route).toMatchObject({ sessionId: 'person-main-a', kind: 'bot', runFields: {} })
    fixture.sessions.get('person-main-a')!.studio_user_id = '2'
    await expect(validateMcuVoiceRoute(route.leaseId, 'fixture-app')).rejects.toMatchObject({ status: 404 })
  })
  it.each([
    ['', 'cli', undefined], ['ekko-agent', 'builtin_agent', 'ekko-agent'],
    ['codex', 'coding_agent', 'codex'], ['claude', 'coding_agent', 'claude-code'],
    ['qoder', 'coding_agent', 'qoder'], ['plugin:fixture/runtime', 'coding_agent', 'plugin:fixture/runtime'],
  ])('keeps the selected %s runtime instead of hardcoding Hermes', async (agent, source, expected) => {
    fixture.sessions.set('chat-a', session('chat-a', { agent, source, agent_mode: 'scoped' }))
    await writeMcuBinding(owner, 0, { sessionId: 'chat-a', kind: 'chat' })
    const route = await reserve()
    expect(route.runFields.agent_id).toBe(expected)
    expect(route.runFields).toMatchObject({ model: 'selected-model', provider: 'selected-provider', api_mode: 'chat_completions' })
  })
  it('requires an active App identity and its matching real logical connection, including unbound legacy voice', async () => {
    await expect(reserve({ userId: 2 })).rejects.toMatchObject({ status: 403 })
    await expect(reserve({ clientId: 'victim-client' })).rejects.toMatchObject({ status: 403 })
    fixture.inspect.mockResolvedValueOnce({ status: 'revoked', user: { id: 1 }, deviceCode: owner.deviceCode })
    await expect(reserve()).rejects.toMatchObject({ status: 403 })
    const route = await reserve()
    expect(route.sessionId).toBe('mcu-logical-a-default-hermes')
  })
  it('keeps the immutable target lease while transcribing and rejects rebinding or a second voice request', async () => {
    await writeMcuBinding(owner, 0, { sessionId: 'chat-a', kind: 'chat' })
    const route = await reserve()
    await expect(writeMcuBinding(owner, 1, { sessionId: 'chat-b', kind: 'chat' })).rejects.toMatchObject({ status: 409 })
    await expect(reserve()).rejects.toMatchObject({ status: 409 })
    fixture.sessions.get('chat-a')!.model = 'new-desktop-selection'
    expect((await validateMcuVoiceRoute(route.leaseId, 'fixture-app')).runFields.model).toBe('selected-model')
    releaseMcuVoiceRoute(route.leaseId)
    expect((await writeMcuBinding(owner, 1, { sessionId: 'chat-b', kind: 'chat' })).revision).toBe(2)
  })
  it('rejects changes while the selected conversation has independent active work', async () => {
    fixture.idle.mockRejectedValue(new Error('native session is running'))
    await expect(writeMcuBinding(owner, 0, { sessionId: 'chat-a', kind: 'chat' })).rejects.toMatchObject({ status: 409 })
    expect(getMcuSessionBinding(owner)).toBeNull()
  })
  it('fails closed after target deletion, authorization revocation, profile removal or device replacement', async () => {
    await writeMcuBinding(owner, 0, { sessionId: 'chat-a', kind: 'chat' })
    const route = await reserve()
    fixture.inspect.mockResolvedValueOnce({ status: 'revoked', user: { id: 1 }, deviceCode: owner.deviceCode })
    await expect(validateMcuVoiceRoute(route.leaseId, 'fixture-app')).rejects.toMatchObject({ status: 403 })
    fixture.connected.mockResolvedValueOnce(null)
    await expect(validateMcuVoiceRoute(route.leaseId, 'fixture-app')).rejects.toMatchObject({ status: 403 })
    fixture.profiles = []
    await expect(validateMcuVoiceRoute(route.leaseId, 'fixture-app')).rejects.toMatchObject({ status: 403 })
    fixture.profiles = ['default']; fixture.sessions.delete('chat-a')
    await expect(validateMcuVoiceRoute(route.leaseId, 'fixture-app')).rejects.toMatchObject({ status: 404 })
    releaseMcuVoiceRoute(route.leaseId)
    await expect(reserve()).rejects.toMatchObject({ status: 404 })
    expect(await readMcuBinding(owner)).toMatchObject({ binding: null, revision: 1 })
  })
})

it('aborts and invalidates a released voice lease instead of leaving transcription alive', async () => {
  const route = await reserve()
  expect(route.signal.aborted).toBe(false)
  releaseMcuVoiceRoute(route.leaseId)
  expect(route.signal.aborted).toBe(true)
  await expect(validateMcuVoiceRoute(route.leaseId, 'fixture-app')).rejects.toMatchObject({ status: 409 })
})

it('keeps cancellation distinct from settlement until the actual ASR or native owner releases its lease', async () => {
  const { cancelMcuVoiceRoute } = await import('../../packages/server/src/modules/studio/services/devices/mcu-session-bindings')
  const route = await reserve()
  const settled = vi.fn()
  void route.settlement.then(settled)
  cancelMcuVoiceRoute(route.leaseId)
  expect(route.signal.aborted).toBe(true)
  await Promise.resolve()
  expect(settled).not.toHaveBeenCalled()
  await expect(reserve({ interactionId: 'new-turn' })).rejects.toMatchObject({ status: 409 })
  releaseMcuVoiceRoute(route.leaseId)
  await route.settlement
  expect(settled).toHaveBeenCalledOnce()
  expect((await reserve({ interactionId: 'new-turn' })).interactionId).toBe('new-turn')
})

it('serializes a binding mutation against new microphone leases while native busy checks are awaiting', async () => {
  let releaseIdle!: () => void
  fixture.idle.mockImplementationOnce(() => new Promise<void>(resolve => { releaseIdle = resolve }))
  const writing = writeMcuBinding(owner, 0, { sessionId: 'chat-a', kind: 'chat' })
  await expect(reserve()).rejects.toMatchObject({ code: 'mcu_binding_busy' })
  await expect(writeMcuBinding(owner, 0, null)).rejects.toMatchObject({ code: 'mcu_binding_busy' })
  releaseIdle()
  expect((await writing).binding?.sessionId).toBe('chat-a')
})

it('allows a new microphone turn after the foreground completes while retaining the background binding guard', async () => {
  await writeMcuBinding(owner, 0, { sessionId: 'chat-a', kind: 'chat' })
  const first = await reserve()
  releaseMcuVoiceForeground(first.leaseId)
  const second = await reserve({ interactionId: 'voice-b' })
  expect(second.sessionId).toBe(first.sessionId)
  expect((await validateMcuVoiceRoute(first.leaseId, 'fixture-app')).sessionId).toBe('chat-a')
  await expect(writeMcuBinding(owner, 1, null)).rejects.toMatchObject({ code: 'mcu_binding_busy' })
})

it('allows an owner-only cancellation terminal after lease/target removal without permitting stale content delivery', async () => {
  const { validateMcuVoiceRecipient, validateMcuVoiceDelivery } = await import('../../packages/server/src/modules/studio/services/devices/mcu-session-bindings')
  await writeMcuBinding(owner, 0, { sessionId: 'chat-a', kind: 'chat' })
  const route = await reserve()
  releaseMcuVoiceRoute(route.leaseId); fixture.sessions.delete('chat-a')
  await expect(validateMcuVoiceRecipient(route, 'fixture-app')).resolves.toBeUndefined()
  await expect(validateMcuVoiceDelivery(route, 'fixture-app')).rejects.toMatchObject({ status: 404 })
  fixture.inspect.mockResolvedValue({ status: 'revoked', user: { id: 1 }, deviceCode: owner.deviceCode })
  await expect(validateMcuVoiceRecipient(route, 'fixture-app')).rejects.toMatchObject({ status: 403 })
})

it('keeps recipient-only terminal authorization after a completed lease permits a newer binding revision', async () => {
  const { validateMcuVoiceRecipient, validateMcuVoiceDelivery } = await import('../../packages/server/src/modules/studio/services/devices/mcu-session-bindings')
  await writeMcuBinding(owner, 0, { sessionId: 'chat-a', kind: 'chat' })
  const route = await reserve()
  releaseMcuVoiceRoute(route.leaseId)
  await writeMcuBinding(owner, 1, { sessionId: 'chat-b', kind: 'chat' })
  await expect(validateMcuVoiceDelivery(route, 'fixture-app')).rejects.toMatchObject({ code: 'mcu_binding_conflict' })
  await expect(validateMcuVoiceRecipient(route, 'fixture-app')).resolves.toBeUndefined()
})
