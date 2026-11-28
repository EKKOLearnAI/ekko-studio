import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'

const fixture = vi.hoisted(() => ({ io: vi.fn(), inspect: vi.fn(), authenticate: vi.fn(), allowed: vi.fn(), fetch: vi.fn() }))
vi.mock('socket.io-client', () => ({ io: fixture.io }))
vi.mock('../../packages/server/src/modules/studio/public/auth', () => ({ inspectAppUserToken: fixture.inspect, authenticateUserToken: fixture.authenticate }))
vi.mock('../../packages/server/src/modules/studio/public/users', () => ({ userCanAccessProfile: fixture.allowed }))
vi.mock('../../packages/server/src/modules/studio/public/config', () => ({ config: { port: 18648, appHome: '/unused-relay-test' } }))
vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
import { startOutboundRelayClient, stopOutboundRelayClient } from '../../packages/server/src/modules/studio/services/global-agent/outbound-relay-client'

class Peer extends EventEmitter {
  connected = true
  readonly sent: Array<{ event: string; payload: unknown }> = []
  readonly io = { opts: {} }
  onAny() { return this }
  emit(event: string, payload?: unknown) { this.sent.push({ event, payload }); return true }
  receive(event: string, payload?: unknown) { return super.emit(event, payload) }
  disconnect() { this.connected = false; this.receive('disconnect', 'test close'); return this }
}
const peers: Array<{ url: string; options: Record<string, any>; peer: Peer }> = []
beforeEach(() => {
  fixture.io.mockImplementation((url, options) => {
    const peer = new Peer(); peers.push({ url, options, peer })
    if (url.endsWith('/global-agent')) queueMicrotask(() => peer.receive('connect'))
    return peer
  })
  fixture.inspect.mockResolvedValue({ status: 'active', deviceCode: 'physical-a', user: { id: 1, role: 'user' } })
  fixture.authenticate.mockResolvedValue({ id: 1, role: 'user' }); fixture.allowed.mockReturnValue(true)
  fixture.fetch.mockResolvedValue({ ok: true, text: async () => JSON.stringify({ accepted: true }), headers: new Headers() })
})
afterEach(() => { stopOutboundRelayClient(); peers.length = 0; vi.clearAllMocks() })

function setup() {
  const client = startOutboundRelayClient({ connectionId: 'relay-owner-test', relayProtocol: 'mcu-socket.io',
    relayUrl: 'http://relay.invalid', localBaseUrl: 'http://studio.invalid', instanceId: 'relay-instance', deviceCode: 'physical-a',
    userToken: 'manager-token', fetchImpl: fixture.fetch })!
  peers[0].peer.receive('connect')
  return client
}
const voice = { interactionId: 'voice-a', mimeType: 'audio/wav', bytes: 4, profile: 'default', agentRuntime: 'hermes' }
async function upload(client: object) {
  await Reflect.get(client, 'handleVoiceAudio').call(client, Buffer.from('WAVE'), voice)
}

it('does not create an administrator-backed device bridge before a paired MCU logs in', async () => {
  setup(); await Promise.resolve()
  expect(peers.filter(peer => peer.url === 'http://studio.invalid/global-agent')).toHaveLength(0)
})

it('uses the same verified App owner, physical device and profile for local socket and voice upload', async () => {
  const client = setup()
  Reflect.get(client, 'rememberRemoteMcuLoginToken').call(client, JSON.stringify({ token: 'device-token' }))
  await upload(client)
  expect(peers[0].peer.sent.filter(item => (item.payload as {status?: string})?.status === 'failed')).toEqual([])
  const local = peers.find(peer => peer.url === 'http://studio.invalid/global-agent')!
  expect(local.options.auth).toMatchObject({ token: 'device-token', deviceCode: 'physical-a', profile: 'default', instanceId: 'relay-instance' })
  expect(fixture.fetch).toHaveBeenCalledWith('http://studio.invalid/api/studio/mcu/voice-turn', expect.objectContaining({
    headers: expect.objectContaining({ Authorization: 'Bearer device-token', 'X-Hermes-Mcu-Device-Id': 'relay-instance', 'X-Hermes-Profile': 'default' }),
  }))
})

it.each(['missing', 'revoked', 'device', 'owner', 'profile'])('rejects a %s relay identity before posting microphone audio', async reason => {
  const client = setup()
  if (reason !== 'missing') Reflect.get(client, 'rememberRemoteMcuLoginToken').call(client, JSON.stringify({ token: 'device-token' }))
  if (reason === 'revoked') fixture.inspect.mockResolvedValue({ status: 'revoked', deviceCode: 'physical-a', user: { id: 1 } })
  if (reason === 'device') fixture.inspect.mockResolvedValue({ status: 'active', deviceCode: 'someone-else', user: { id: 1 } })
  if (reason === 'owner') fixture.authenticate.mockResolvedValue({ id: 2 })
  if (reason === 'profile') fixture.allowed.mockReturnValue(false)
  await upload(client)
  expect(fixture.fetch).not.toHaveBeenCalled()
})

it('retires the previous local recipient when the paired App credential rotates', async () => {
  const client = setup()
  const remember = Reflect.get(client, 'rememberRemoteMcuLoginToken').bind(client)
  remember(JSON.stringify({ token: 'device-token' })); await upload(client)
  const old = peers.find(peer => peer.url === 'http://studio.invalid/global-agent')!
  remember(JSON.stringify({ token: 'new-device-token' }))
  expect(old.peer.connected).toBe(false)
  fixture.fetch.mockClear(); await upload(client)
  const next = peers.filter(peer => peer.url === 'http://studio.invalid/global-agent').at(-1)!
  expect(next.options.auth.token).toBe('new-device-token')
  expect(fixture.fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer new-device-token')
})

it('does not post audio after the authorized relay connection disconnects', async () => {
  const client = setup()
  Reflect.get(client, 'rememberRemoteMcuLoginToken').call(client, JSON.stringify({ token: 'device-token' }))
  peers[0].peer.disconnect()
  await upload(client)
  expect(fixture.fetch).not.toHaveBeenCalled()
})

it.each(['rotated', 'revoked'])('discards a delayed voice failure prompt when its original App credential is %s', async change => {
  const client = setup()
  Reflect.get(client, 'rememberRemoteMcuLoginToken').call(client, JSON.stringify({ token: 'device-token' }))
  let finishBody!: (body: string) => void
  const body = new Promise<string>(resolve => { finishBody = resolve })
  fixture.fetch.mockResolvedValue({ ok: false, status: 503, text: () => body })
  const prompt = vi.fn(async () => true)
  Reflect.set(client, 'enqueuePromptAudioFromVoiceTurn', prompt)
  const pending = upload(client)
  await vi.waitFor(() => expect(fixture.fetch).toHaveBeenCalled())
  if (change === 'rotated') Reflect.get(client, 'rememberRemoteMcuLoginToken').call(client, JSON.stringify({ token: 'new-device-token' }))
  else fixture.inspect.mockResolvedValue({ status: 'revoked', deviceCode: 'physical-a', user: { id: 1 } })
  const before = peers[0].peer.sent.length
  finishBody(JSON.stringify({ ok: false, audio: { url: '/api/studio/mcu/audio/old-prompt' }, error: 'old request failure' }))
  await pending
  expect(prompt).not.toHaveBeenCalled()
  expect(peers[0].peer.sent.slice(before)).toEqual([])
})

it('never sends the paired credential to a non-Studio audio URL', async () => {
  const client = setup()
  Reflect.set(client, 'audioUploadToken', 'fixture-upload')
  Reflect.get(client, 'rememberRemoteMcuLoginToken').call(client, JSON.stringify({ token: 'device-token' }))
  await expect(Reflect.get(client, 'uploadMcuAudioUrlToRelay').call(client, 'https://other.invalid/audio')).rejects.toThrow('local Studio origin')
  expect(fixture.fetch).not.toHaveBeenCalled()
})

it.each([true, false])('cancellation terminal requires the same active relay App owner (revoked=%s)', async revoked => {
  const client = setup()
  Reflect.get(client, 'rememberRemoteMcuLoginToken').call(client, JSON.stringify({ token: 'device-token' }))
  if (revoked) fixture.inspect.mockResolvedValue({ status: 'revoked', deviceCode: 'physical-a', user: { id: 1 } })
  await Reflect.get(client, 'notifyMcuCancellation').call(client, 'known-owned-turn', 'default', 'device-token')
  expect(peers[0].peer.sent.filter(item => (item.payload as {status?: string})?.status === 'completed')).toHaveLength(revoked ? 0 : 1)
})

it('does not manufacture a terminal for an unknown relay interaction after its own active run is gone', async () => {
  const client = setup()
  Reflect.get(client, 'rememberRemoteMcuLoginToken').call(client, JSON.stringify({ token: 'device-token' }))
  Reflect.get(client, 'interruptMcuSession').call(client, 'default', 'unknown-turn')
  await Promise.resolve(); await Promise.resolve()
  expect(peers[0].peer.sent.filter(item => (item.payload as {status?: string})?.status === 'completed')).toEqual([])
})
