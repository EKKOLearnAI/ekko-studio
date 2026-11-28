import { beforeEach, expect, it, vi } from 'vitest'
import type { Server } from 'socket.io'
const fixture = vi.hoisted(() => ({ inspect: vi.fn(), allowed: vi.fn() }))
vi.mock('../../packages/server/src/modules/studio/public/auth', () => ({ authenticateUserToken: vi.fn(), inspectAppUserToken: fixture.inspect }))
vi.mock('../../packages/server/src/modules/studio/public/users', () => ({ userCanAccessProfile: fixture.allowed }))
vi.mock('../../packages/server/src/modules/studio/public/config', () => ({ config: { port: 18648, appHome: '/unused-owner-test' } }))
vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
import { GlobalAgentServer } from '../../packages/server/src/modules/studio/sockets/global-agent'

const owner = { userId: 1, profile: 'default', deviceCode: 'physical-a' }
const app = { status: 'active', deviceCode: 'physical-a', user: { id: 1, role: 'user' } }
beforeEach(() => { fixture.inspect.mockReset().mockResolvedValue(app); fixture.allowed.mockReset().mockReturnValue(true) })
function setup() {
  const server = new GlobalAgentServer({ of: () => ({}) } as unknown as Server)
  const peer = { connected: true, handshake: { auth: { deviceCode: 'forged-code', agentRuntime: 'hermes' } },
    data: { profile: 'default', userToken: 'paired-app-token', user: { id: 1 } } }
  const clients: Map<string, typeof peer> = Reflect.get(server, 'clients')
  clients.set('logical-a', peer)
  return { server, peer, clients }
}

it('resolves physical identity from the active App token instead of claimed handshake deviceCode', async () => {
  const { server } = setup()
  expect(await server.getOwnedMcuDevice(owner, 'logical-a')).toMatchObject({ deviceCode: 'physical-a', clientId: 'logical-a', profile: 'default', agentRuntime: 'hermes' })
  expect(await server.getOwnedMcuDevice({ ...owner, deviceCode: 'forged-code' })).toBeNull()
})
it.each(['account', 'profile', 'token', 'permission', 'logical-client'])('does not expose a %s-mismatched socket as an owned device', async reason => {
  const { server, peer } = setup()
  if (reason === 'account') peer.data.user.id = 2
  if (reason === 'profile') peer.data.profile = 'work'
  if (reason === 'token') fixture.inspect.mockResolvedValue({ ...app, status: 'revoked' })
  if (reason === 'permission') fixture.allowed.mockReturnValue(false)
  expect(await server.getOwnedMcuDevice(owner, reason === 'logical-client' ? 'victim-client' : 'logical-a')).toBeNull()
})
it('does not return a connection that was replaced while its token was being verified', async () => {
  const { server, peer, clients } = setup()
  fixture.inspect.mockImplementation(async () => { clients.set('logical-a', { ...peer, data: { ...peer.data, user: { id: 2 } } }); return app })
  expect(await server.getOwnedMcuDevice(owner, 'logical-a')).toBeNull()
})

it('does not let another device interrupt a run or acknowledge its audio by guessing public IDs', () => {
  const { server } = setup()
  const emit = vi.fn(), resolve = vi.fn(), reject = vi.fn(), cancel = vi.fn()
  Reflect.get(server, 'activeMcuRuns').set('victim-turn', { socket: { emit }, sessionId: 'victim-chat', clientId: 'victim-client', profile: 'default', cancel })
  Reflect.get(server, 'mcuAudioWaiters').set('victim-audio', { clientId: 'victim-client', resolve, reject, timer: undefined })
  const receive = Reflect.get(server, 'handleMcuClientEvent').bind(server)
  receive('logical-a', 'audio.interrupted', { interactionId: 'victim-turn', segmentId: 'victim-audio' })
  receive('logical-a', 'audio.done', { interactionId: 'victim-turn', segmentId: 'victim-audio' })
  expect(emit).not.toHaveBeenCalled(); expect(cancel).not.toHaveBeenCalled()
  expect(resolve).not.toHaveBeenCalled(); expect(reject).not.toHaveBeenCalled()
  expect(Reflect.get(server, 'mcuAudioWaiters').has('victim-audio')).toBe(true)
})

it.each(['account', 'physical-device'])('does not let a different %s evict the owner by claiming its logical client ID', reason => {
  const { server, peer, clients } = setup()
  Object.assign(peer, { id: 'socket-original', disconnect: vi.fn() })
  Object.assign(peer.data, { mcuDeviceCode: 'physical-a' })
  const replacement = { id: 'socket-replacement', handshake: { auth: { instanceId: 'logical-a' } },
    data: { user: { id: reason === 'account' ? 2 : 1 }, mcuDeviceCode: reason === 'physical-device' ? 'physical-b' : 'physical-a' },
    emit: vi.fn(), disconnect: vi.fn() }
  Reflect.get(server, 'onAgentConnection').call(server, replacement)
  expect(clients.get('logical-a')).toBe(peer)
  expect(Reflect.get(peer, 'disconnect')).not.toHaveBeenCalled()
  expect(replacement.disconnect).toHaveBeenCalledWith(true)
})
