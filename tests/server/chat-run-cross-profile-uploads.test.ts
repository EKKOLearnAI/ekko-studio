import { mkdir, writeFile, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeEach, expect, it, vi } from 'vitest'

vi.mock('../../packages/server/src/modules/studio/services/session-shares/socket-access', () => ({
  bindSessionShareSocket: vi.fn(),
}))

const saveTaskPlanMock = vi.hoisted(() => vi.fn())
vi.mock('../../packages/server/src/modules/studio/repositories/task-plan-store', () => ({
  saveTaskPlan: saveTaskPlanMock, listTaskPlansForPage: vi.fn(() => []),
}))

const handleBridgeRunMock = vi.hoisted(() => vi.fn(async () => {}))
const resumeBridgeRunMock = vi.hoisted(() => vi.fn(async () => {}))
const handleEkkoAgentRunMock = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('../../packages/server/src/modules/studio/services/chat-run/handle-ekko-agent-run', () => ({
  handleEkkoAgentRun: handleEkkoAgentRunMock,
}))
const handleEkkoCommandMock = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('../../packages/server/src/modules/studio/services/chat-run/ekko-session-command', async importOriginal => ({
  ...await importOriginal<typeof import('../../packages/server/src/modules/studio/services/chat-run/ekko-session-command')>(),
  handleEkkoSessionCommand: handleEkkoCommandMock,
}))
const handleCodingAgentRunMock = vi.hoisted(() => vi.fn(async () => {}))
const loadSessionStateFromDbMock = vi.hoisted(() => vi.fn())
const startBridgeMock = vi.hoisted(() => vi.fn())
const ensureReadyMock = vi.hoisted(() => vi.fn())
const getRuntimeStateMock = vi.hoisted(() => vi.fn())
const userCanAccessProfileMock = vi.hoisted(() => vi.fn((_user: unknown, _profile: string) => true))
const getSessionMock = vi.hoisted(() => vi.fn((sessionId?: string) => sessionId
  ? { id: sessionId, profile: 'default', source: 'cli', model: 'gpt-test', provider: 'openai' }
  : undefined))
const bridgeMock = vi.hoisted(() => ({
  status: vi.fn(),
  statusIfLoaded: vi.fn(),
  releaseBackgroundNotification: vi.fn(async () => ({ ok: true, released: true })),
  close: vi.fn(async () => {}),
  approvalRespond: vi.fn(async () => ({ resolved: true })),
  clarifyRespond: vi.fn(async () => ({ resolved: true })),
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/handle-bridge-run', () => ({
  handleBridgeRun: handleBridgeRunMock,
  resumeBridgeRun: resumeBridgeRunMock,
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/load-state', () => ({
  loadSessionStateFromDb: loadSessionStateFromDbMock,
  readSessionStateFromDb: vi.fn(() => ({ messages: [], isWorking: false, events: [], queue: [] })),
  resolveRunSource: vi.fn((source?: string) => source || 'cli'),
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/handle-coding-agent-run', () => ({
  handleCodingAgentRun: handleCodingAgentRunMock,
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/session-command', () => ({
  handleSessionCommand: vi.fn(),
  isSessionCommand: vi.fn(() => false),
  parseSessionCommand: vi.fn(() => null),
}))

vi.mock('../../packages/server/src/modules/hermes/services/bridge/index', () => ({
  AgentBridgeClient: vi.fn(() => bridgeMock),
}))

vi.mock('../../packages/server/src/modules/hermes/services/bridge/manager', () => ({
  getAgentBridgeManager: vi.fn(() => ({
    ensureReady: ensureReadyMock,
    getRuntimeState: getRuntimeStateMock,
  })),
}))

vi.mock('../../packages/server/src/modules/studio/public/chat-agent-runtime', () => ({
  getChatCodingAgentMcpServers: vi.fn(() => ({ 'ekko-studio-interaction': { command: 'studio' }, 'ekko-studio-use': { command: 'studio' } })),
  resolveChatEkkoMcpServers: vi.fn(() => ({ 'ekko-studio-use': { command: 'studio' } })),
  createPrimaryAgentBridge: vi.fn(() => bridgeMock),
  getPrimaryAgentBridgeManager: vi.fn(() => ({
    start: startBridgeMock,
    ensureReady: ensureReadyMock,
    getRuntimeState: getRuntimeStateMock,
  })),
  redactPrimaryAgentBridgeError: (error?: string, endpoint?: string, replacement = '[redacted endpoint]') => {
    if (!error) return error
    const values = [endpoint, endpoint?.replace(/^(?:ipc|tcp):\/\//, '')].filter(Boolean) as string[]
    return values.reduce((value, candidate) => value.split(candidate).join(replacement), error)
  },
  chatCodingAgentRunManager: {
    resolveApproval: vi.fn(() => ({ handled: false, resolved: false })),
    resolveClarification: vi.fn(() => ({ handled: false, resolved: false })),
    stop: vi.fn(),
  },
  handleChatCodingAgentSessionCommand: vi.fn(),
  parseChatCodingAgentSessionCommand: vi.fn(() => null),
  getChatEkkoAgent: vi.fn(() => ({ requestBoundaryInterrupt: vi.fn() })),
  respondToChatEkkoToolApproval: vi.fn(() => ({ handled: false, resolved: false })),
  respondToChatEkkoClarification: vi.fn(() => ({ handled: false, resolved: false })),
}))

vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('../../packages/server/src/modules/studio/public/runs/prompt', () => ({
  getSystemPrompt: vi.fn(() => 'system prompt'),
}))

vi.mock('../../packages/server/src/modules/studio/repositories/session-store', () => ({
  getSessionNotificationPreview: vi.fn(() => null),
  getSession: getSessionMock,
  getSessionMetadata: getSessionMock,
  getSessionDetail: vi.fn(() => null),
}))

vi.mock('../../packages/server/src/modules/studio/public/profile-config', () => ({
  readConfigYamlForProfile: vi.fn(async () => ({ mcp_servers: { 'ekko-studio-interaction': { command: 'studio' }, 'ekko-studio-use': { command: 'studio' } } })),
  getActiveProfileName: vi.fn(() => 'default'),
  getProfileDir: vi.fn(() => '/tmp/hermes-default'),
  listProfileNamesFromDisk: vi.fn(() => ['default', 'research', 'private']),
}))

vi.mock('../../packages/server/src/modules/studio/public/auth', () => ({
  authenticateUserToken: vi.fn(),
  isAuthEnabled: vi.fn(async () => false),
}))

vi.mock('../../packages/server/src/modules/studio/repositories/users-store', () => ({
  userCanAccessProfile: userCanAccessProfileMock,
}))

function makeServerHarness() {
  const handlers = new Map<string, Function>()
  const emitted: Array<{ room: string; event: string; payload: any }> = []
  const namespace = {
    adapter: { rooms: new Map() },
    to: vi.fn((room: string) => ({
      emit: vi.fn((event: string, payload: any) => emitted.push({ room, event, payload })),
    })),
    use: vi.fn(),
    on: vi.fn(),
  }
  const io = { of: vi.fn(() => namespace) }
  const socket = {
    id: 'socket-1',
    connected: true,
    handshake: { auth: {}, query: { profile: 'default' } },
    data: {},
    emit: vi.fn(),
    join: vi.fn(),
    to: vi.fn(() => ({ emit: vi.fn() })),
    on: vi.fn((event: string, handler: Function) => {
      handlers.set(event, handler)
    }),
  }
  return { emitted, handlers, io, namespace, socket }
}


const uploads = vi.hoisted(() => new Map<string, string>())
vi.mock('../../packages/server/src/modules/studio/repositories/session-uploads-store', () => ({
  sessionUploadsStore: {
    record: vi.fn((sessionId: string, profile: string, path: string, actual: string) => uploads.set(`${sessionId}:${profile}:${path}`, actual)),
    find: vi.fn((sessionId: string, profile: string, path: string) => uploads.get(`${sessionId}:${profile}:${path}`)),
    legacyContents: vi.fn(() => []),
  },
}))

import { getProfileUploadDir } from '../../packages/server/src/modules/studio/services/files/upload-paths'
import { isSessionUploadAttachment } from '../../packages/server/src/modules/studio/services/files/session-uploads'
import { ChatRunSocket } from '../../packages/server/src/modules/studio/sockets/chat-run'

async function harness(profile = 'research', shared = false) {
  const { handlers, io, socket } = makeServerHarness()
  socket.handshake.query.profile = profile
  Object.assign(socket.data, { user: { id: 42, role: 'user' }, ...(shared ? { sessionShare: { share: { session_id: 'session-1' } } } : {}) })
  const server = new ChatRunSocket(io as any)
  const agent = vi.spyOn(server as any, 'handleRun').mockResolvedValue(undefined)
  ;(server as any).onConnection(socket)
  return { socket, agent, run: handlers.get('run')!, server }
}

beforeEach(() => {
  vi.clearAllMocks()
  uploads.clear()
  getSessionMock.mockImplementation((id?: string) => id && id !== 'pending'
    ? { id, profile: id === 'other-session' ? 'private' : 'default', source: 'cli', model: 'gpt-test', provider: 'openai' }
    : undefined)
  userCanAccessProfileMock.mockImplementation((_user, profile) => profile !== 'private')
})

async function upload(profile = 'default', name = '0123456789abcdef.txt') {
  const root = getProfileUploadDir(profile)
  await mkdir(root, { recursive: true })
  const path = join(root, name)
  await writeFile(path, 'synthetic public fixture')
  return path
}

it.each([{ input: 'hello' }, { input: [{ type: 'text', text: 'hello' }] }])('runs cross-profile text input $input', async ({ input }) => {
  const { run, agent, socket, server } = await harness()
  await run({ session_id: 'session-1', source: 'cli', input })
  expect(socket.emit).not.toHaveBeenCalledWith('run.failed', expect.anything())
  expect(agent).toHaveBeenCalledWith(socket, expect.objectContaining({ input }), 'default', false, undefined, undefined)
  await server.close()
})

it('records a valid cross-profile attachment before dispatching the run', async () => {
  const path = await upload()
  const { run, agent, socket, server } = await harness()
  await run({ session_id: 'session-1', input: [{ type: 'file', path }], source: 'cli' })
  expect(socket.emit).not.toHaveBeenCalledWith('run.failed', expect.anything())
  expect(agent).toHaveBeenCalledOnce()
  expect(await isSessionUploadAttachment('session-1', 'default', path)).toBe(true)
  expect(await isSessionUploadAttachment('other-session', 'default', path)).toBe(false)
  await server.close()
})

it.each([
  { session_id: 'other-session' },
  { session_id: 'session-1', profile: 'private' },
  { session_id: 'other-session', profile: 'research' },
  { session_id: 'session-1', profile: 'research' },
])('rejects inaccessible profile or session %j before recording attachments', async target => {
  const path = await upload()
  const { run, agent, socket, server } = await harness()
  await run({ ...target, input: [{ type: 'file', path }], source: 'cli' })
  expect(socket.emit).toHaveBeenCalledWith('run.failed', expect.objectContaining({ error: expect.any(String) }))
  expect(agent).not.toHaveBeenCalled()
  expect(uploads.size).toBe(0)
  await server.close()
})

it('does not grant provenance to another profile, arbitrary names, or symlinks', async () => {
  const foreign = await upload('research')
  const arbitrary = await upload('default', 'private.txt')
  const alias = join(getProfileUploadDir('default'), 'fedcba9876543210.txt')
  await symlink(foreign, alias).catch(() => {})
  const { run, agent, server } = await harness('default')
  await run({ session_id: 'session-1', input: [foreign, arbitrary, alias].map(path => ({ type: 'file', path })), source: 'cli' })
  expect(agent).toHaveBeenCalledOnce()
  expect(uploads.size).toBe(0)
  for (const path of [foreign, arbitrary, alias]) expect(await isSessionUploadAttachment('session-1', 'default', path)).toBe(false)
  await server.close()
})

it('preserves provenance for a pending first-run session', async () => {
  const path = await upload('research')
  const { run, agent, server } = await harness()
  await run({ session_id: 'pending', input: [{ type: 'file', path }], source: 'cli' })
  expect(agent).toHaveBeenCalledOnce()
  expect(await isSessionUploadAttachment('pending', 'research', path)).toBe(true)
  await server.close()
})

it('does not record share-recipient uploads', async () => {
  const path = await upload()
  const { run, agent, server } = await harness('default', true)
  await run({ session_id: 'session-1', input: [{ type: 'file', path }], source: 'cli' })
  expect(agent).toHaveBeenCalledOnce()
  expect(uploads.size).toBe(0)
  await server.close()
})
