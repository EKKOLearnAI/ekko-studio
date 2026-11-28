import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Server } from 'socket.io'

const mocks = vi.hoisted(() => ({ connect: vi.fn() }))
vi.mock('socket.io-client', () => ({ io: (...args: unknown[]) => mocks.connect(...args) }))
vi.mock('../../packages/server/src/modules/studio/public/config', () => ({ config: { port: 18648, appHome: '/unused-mcu-test-state' } }))
vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('../../packages/server/src/modules/studio/public/auth', () => ({ authenticateUserToken: vi.fn(), inspectAppUserToken: vi.fn(async () => ({ status: 'active', user: { id: 1, role: 'super_admin' }, deviceCode: 'test-physical' })) }))
vi.mock('../../packages/server/src/modules/studio/public/users', () => ({ userCanAccessProfile: vi.fn() }))
vi.mock('../../packages/server/src/modules/studio/public/chat-run', () => ({ getChatRunServer: vi.fn() }))
vi.mock('../../packages/server/src/modules/studio/repositories/session-store', () => ({ clearSessionMessages: vi.fn() }))
vi.mock('../../packages/server/src/modules/studio/services/global-agent/mcu-webhook-events', () => ({ bindMcuWebhookEvents: vi.fn() }))
vi.mock('../../packages/server/src/modules/studio/services/voice/stt/audio-convert', () => ({ transcodeToPcmS16le: vi.fn() }))

import { GlobalAgentServer } from '../../packages/server/src/modules/studio/sockets/global-agent'
import { startOutboundRelayClient, stopOutboundRelayClient } from '../../packages/server/src/modules/studio/services/global-agent/outbound-relay-client'

type Payload = Record<string, unknown>
class Peer {
  connected = true
  autoAck = true
  readonly sent: { event: string; payload: Payload }[] = []
  private readonly handlers = new Map<string, ((payload: Payload) => void)[]>()
  constructor(readonly url: string) {}
  on(event: string, handler: (payload: Payload) => void) {
    this.handlers.set(event, [...this.handlers.get(event) || [], handler])
    return this
  }
  onAny() { return this }
  emit(event: string, payload: Payload, ack?: (value: Payload) => void) { this.sent.push({ event, payload }); if (ack && this.autoAck) ack({ ...payload, settled: true }); return this }
  receive(event: string, payload: Payload = {}) { for (const handler of [...this.handlers.get(event) || []]) handler(payload) }
  removeAllListeners() { this.handlers.clear(); return this }
  disconnect() { this.connected = false; this.receive('disconnect', {}); return this }
}

type Owner = 'local' | 'relay'
const peers: Peer[] = []
const active = new Set<Peer>()
const interactionId = 'test-voice-turn'

function setup(owner: Owner, started = true, agentRuntime: 'ekko' | 'hermes' = 'hermes') {
  const deviceEvents: Payload[] = []
  let instance: object
  if (owner === 'local') {
    const server = new GlobalAgentServer({ of: () => ({}) } as unknown as Server)
    vi.spyOn(server, 'emitMcuEvent').mockImplementation(event => { deviceEvents.push(event); return true })
    instance = server
    Reflect.get(server, 'clients').set('test-device', { connected: true, data: { profile: 'default', user: { id: 1 }, userToken: 'test-token' }, handshake: { auth: { agentRuntime: 'hermes' } } })
    server.startMcuVoiceChatTurn({ clientId: 'test-device', profile: 'default', agentRuntime, interactionId, transcript: '测试', userToken: 'test-token' })
  } else {
    instance = startOutboundRelayClient({
      connectionId: 'mcu-test', relayProtocol: 'mcu-socket.io', relayUrl: 'http://relay.invalid',
      localBaseUrl: 'http://studio.invalid', instanceId: 'test-device', userToken: 'test-token',
    })!
    Reflect.set(instance, 'remoteMcuUserToken', 'test-device-token')
    Reflect.set(instance, 'connectLocalAgentSocket', vi.fn(async () => true))
    Reflect.set(instance, 'sendJson', (event: Payload) => { deviceEvents.push(event) })
    void Reflect.get(instance, 'runChatFromTranscript').call(instance, { interactionId, profile: 'default', agentRuntime }, '测试')
  }
  // Cloud synthesis and the device player are outside this transport regression.
  Reflect.set(instance, 'synthesizeMcuSpeech', vi.fn(async () => ({ url: 'http://audio.invalid', mimeType: 'audio/x-pcm', sampleRate: 24000, channels: 1 })))
  Reflect.set(instance, 'enqueueMcuSpeechSegment', vi.fn(async () => ({ playbackDone: Promise.resolve() })))
  const socket = peers.at(-1)!
  active.add(socket)
  socket.receive('connect')
  const run = socket.sent.find(item => item.event === 'run')!.payload
  let runId = 'test-native-run'
  // The server tags chat events with session_id and native events with run_id.
  // RPC ACKs below explicitly omit run_id, matching the real response handlers.
  const receive = (event: string, payload: Payload = {}) => {
    if (event === 'run.started' && typeof payload.run_id === 'string') runId = payload.run_id
    socket.receive(event, { session_id: run.session_id, run_id: runId, ...payload })
  }
  if (started) receive('run.started', { queue_id: run.queue_id })
  const interrupt = () => owner === 'local'
    ? Reflect.get(instance, 'interruptMcuSession').call(instance, 'test-device', 'default', agentRuntime, interactionId)
    : Reflect.get(instance, 'interruptMcuSession').call(instance, 'default', interactionId)
  return { socket, run, deviceEvents, interrupt, receive, instance }
}

beforeEach(() => {
  vi.useFakeTimers()
  mocks.connect.mockImplementation((url: string) => { const peer = new Peer(url); peers.push(peer); return peer })
})
afterEach(async () => {
  for (const peer of active) {
    const run = peer.sent.find(item => item.event === 'run')?.payload
    peer.receive('run.failed', { session_id: run?.session_id, queue_id: run?.queue_id, error: 'test cleanup' })
  }
  await vi.advanceTimersByTimeAsync(0)
  active.clear()
  stopOutboundRelayClient()
  peers.length = 0
  mocks.connect.mockClear()
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe.each<Owner>(['local', 'relay'])('%s MCU human interactions', owner => {
  it('reports a missing native cancellation ACK without a completed fence or late content', async () => {
    const { socket, deviceEvents, interrupt, receive } = setup(owner)
    socket.autoAck = false
    interrupt()
    const before = deviceEvents.length
    receive('tool.started', { tool: 'old-tool' })
    receive('tool.completed', { tool: 'old-tool' })
    receive('message.delta', { delta: 'old content must not return' })
    await vi.advanceTimersByTimeAsync(0)
    expect(deviceEvents).toHaveLength(before)
    await vi.advanceTimersByTimeAsync(30_001)
    expect(deviceEvents.at(-1)).toMatchObject({ status: 'failed', reason: 'cancel_unconfirmed' })
    expect(deviceEvents.some(event => event.status === 'completed')).toBe(false)
    socket.disconnect()
    const stopped = deviceEvents.length
    receive('run.completed', { output: 'late response' })
    await vi.advanceTimersByTimeAsync(0)
    expect(deviceEvents.slice(stopped).every(event => event.reason === 'cancel_unconfirmed')).toBe(true)
  })

  it('waits for the desktop approval instead of granting any offered choice', async () => {
    const { socket, run, deviceEvents, receive } = setup(owner)
    receive('approval.requested', { approval_id: 'approval-1', choices: ['once', 'session', 'always', 'deny'] })
    expect(socket.sent.filter(item => item.event === 'approval.respond')).toEqual([])
    expect(socket.connected).toBe(true)
    expect(deviceEvents.some(event => event.status === 'failed')).toBe(false)
    await vi.advanceTimersByTimeAsync(30_001)
    expect(deviceEvents.filter(event => event.status === 'working').length).toBeGreaterThan(1)
    receive('approval.resolved', { approval_id: 'approval-1', choice: 'once', resolved: true })
    receive('run.completed', { queue_id: run.queue_id, output: '已完成。' })
    await vi.advanceTimersByTimeAsync(0)
    expect(deviceEvents.at(-1)).toMatchObject({ status: 'completed' })
    expect(socket.connected).toBe(false)
    const count = deviceEvents.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(deviceEvents).toHaveLength(count)
    expect(socket.sent.some(item => item.event === 'abort')).toBe(false)
  })

  it('keeps clarification pending beyond the device idle deadline until the desktop responds', async () => {
    const { socket, run, deviceEvents, receive } = setup(owner)
    receive('clarify.requested', { clarify_id: 'clarify-1', question: '选择哪台设备？', timeout_ms: 600_000 })
    await vi.advanceTimersByTimeAsync(181_000)
    expect(socket.connected).toBe(true)
    expect(deviceEvents.some(event => event.status === 'failed')).toBe(false)
    expect(deviceEvents.filter(event => event.status === 'working').length).toBeGreaterThanOrEqual(7)
    expect(socket.sent.some(item => item.event === 'clarify.respond')).toBe(false)
    receive('clarify.resolved', { clarify_id: 'unrelated', resolved: true })
    const before = deviceEvents.length
    await vi.advanceTimersByTimeAsync(30_000)
    expect(deviceEvents.length).toBeGreaterThan(before)
    receive('clarify.resolved', { clarify_id: 'clarify-1', resolved: true })
    receive('run.completed', { queue_id: run.queue_id, output: '已收到你的选择。' })
    await vi.advanceTimersByTimeAsync(0)
    expect(deviceEvents.at(-1)).toMatchObject({ status: 'completed' })
  })

  it('does not retry or grant a denied approval', async () => {
    const { socket, run, deviceEvents, receive } = setup(owner)
    receive('approval.requested', { approval_id: 'approval-1' })
    receive('approval.resolved', { approval_id: 'approval-1', choice: 'deny', resolved: true })
    receive('run.completed', { queue_id: run.queue_id, output: '已取消，没有执行。' })
    await vi.advanceTimersByTimeAsync(0)
    expect(socket.sent.filter(item => item.event === 'run')).toHaveLength(1)
    expect(socket.sent.some(item => item.event === 'approval.respond')).toBe(false)
    expect(deviceEvents.find(event => event.type === 'tool.completed' && event.tool === 'approval')).toMatchObject({ error: 'approval failed' })
  })

  it('aborts the upstream run at the existing total deadline and stops waiting heartbeats', async () => {
    const { socket, deviceEvents, receive } = setup(owner)
    receive('clarify.requested', { clarify_id: 'clarify-1', timeout_ms: 600_000 })
    await vi.advanceTimersByTimeAsync(300_000)
    expect(socket.sent.filter(item => item.event === 'abort')).toHaveLength(1)
    expect(socket.connected).toBe(false)
    expect(deviceEvents.at(-1)).toMatchObject({ status: 'completed', outcome: 'failed' })
    const count = deviceEvents.length
    receive('clarify.resolved', { clarify_id: 'clarify-1' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(deviceEvents).toHaveLength(count)
  })

  it('stops the waiting heartbeat and ignores late requests after a device interrupt', async () => {
    const { socket, deviceEvents, interrupt, run, receive } = setup(owner)
    receive('approval.requested', { approval_id: 'approval-1' })
    interrupt()
    await vi.advanceTimersByTimeAsync(0)
    expect(deviceEvents.at(-1)).toMatchObject({ status: 'completed', outcome: 'cancelled', stop_reason: 'cancelled', interactionId })
    const count = deviceEvents.length
    receive('approval.requested', { approval_id: 'late-approval' })
    await vi.advanceTimersByTimeAsync(30_001)
    expect(deviceEvents).toHaveLength(count)
    expect(socket.sent.some(item => item.event === 'approval.respond')).toBe(false)
    expect(socket.sent.filter(item => item.event === 'abort')).toHaveLength(1)
    receive('run.completed', { queue_id: run.queue_id, output: '', stop_reason: 'cancelled' })
    await vi.advanceTimersByTimeAsync(0)
    expect(socket.connected).toBe(false)
  })

  it('also waits for desktop approval in a delegated background run', async () => {
    const { socket, run, deviceEvents, receive } = setup(owner)
    receive('run.completed', { queue_id: run.queue_id, output: '', background_pending: 1 })
    await vi.advanceTimersByTimeAsync(0)
    expect(socket.connected).toBe(true)
    receive('run.started', { autonomous: true, delegation_id: 'background-1', run_id: 'background-run' })
    receive('approval.requested', { approval_id: 'background-approval', choices: ['session', 'once', 'deny'] })
    await vi.advanceTimersByTimeAsync(181_000)
    expect(socket.sent.some(item => item.event === 'approval.respond')).toBe(false)
    expect(deviceEvents.filter(event => event.status === 'working').length).toBeGreaterThanOrEqual(7)
    receive('approval.resolved', { approval_id: 'background-approval', choice: 'once', resolved: true })
    receive('run.completed', { autonomous: true, output: '', background_pending: 0 })
    await vi.advanceTimersByTimeAsync(0)
    expect(socket.connected).toBe(false)
  })

  it('bounds a background human wait even after the primary run timer was released', async () => {
    const { socket, run, deviceEvents, receive } = setup(owner)
    receive('run.completed', { queue_id: run.queue_id, output: '', background_pending: 1 })
    await vi.advanceTimersByTimeAsync(0)
    receive('run.started', { autonomous: true, delegation_id: 'background-1', run_id: 'background-run' })
    receive('clarify.requested', { clarify_id: 'background-clarify', timeout_ms: 600_000 })
    receive('clarify.resolved', { clarify_id: 'background-clarify', run_id: undefined, resolved: false, error: 'RPC failed; still pending' })
    await vi.advanceTimersByTimeAsync(300_000)
    expect(socket.sent.filter(item => item.event === 'abort')).toHaveLength(1)
    expect(socket.connected).toBe(false)
    expect(deviceEvents.at(-1)).toMatchObject({ status: 'completed', outcome: 'failed' })
    const count = deviceEvents.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(deviceEvents).toHaveLength(count)
  })

  it('keeps both human waits after failed desktop RPC ACKs until the native requests resolve', async () => {
    const { socket, run, deviceEvents, receive } = setup(owner)
    receive('approval.requested', { approval_id: 'approval-1' })
    receive('clarify.requested', { clarify_id: 'clarify-1' })
    receive('approval.resolved', { approval_id: 'approval-1', run_id: undefined, resolved: false, error: 'RPC failed' })
    receive('clarify.resolved', { clarify_id: 'clarify-1', run_id: undefined, resolved: false, error: 'RPC failed' })
    await vi.advanceTimersByTimeAsync(181_000)
    expect(socket.connected).toBe(true)
    expect(deviceEvents.filter(event => event.status === 'working').length).toBeGreaterThanOrEqual(8)
    expect(deviceEvents.some(event => event.type === 'tool.completed' && event.tool === 'approval')).toBe(false)
    receive('approval.resolved', { approval_id: 'approval-1', choice: 'once' })
    const partial = deviceEvents.length
    await vi.advanceTimersByTimeAsync(30_000)
    expect(deviceEvents.length).toBeGreaterThan(partial)
    receive('clarify.resolved', { clarify_id: 'clarify-1' })
    const resolved = deviceEvents.length
    await vi.advanceTimersByTimeAsync(30_000)
    expect(deviceEvents).toHaveLength(resolved)
    receive('run.completed', { queue_id: run.queue_id, output: '' })
    await vi.advanceTimersByTimeAsync(0)
  })

  it('only cancels its own queued request at timeout while another run is active', async () => {
    const { socket, run, deviceEvents, receive } = setup(owner, false)
    receive('run.started', { queue_id: 'someone-else', run_id: 'other-active-run' })
    receive('run.queued', { queue_id: run.queue_id, queue_length: 1, queued_messages: [{ id: run.queue_id }] })
    await vi.advanceTimersByTimeAsync(300_000)
    expect(socket.sent.filter(item => item.event === 'cancel_queued_run')).toEqual([
      { event: 'cancel_queued_run', payload: { session_id: run.session_id, queue_id: run.queue_id } },
    ])
    expect(socket.sent.some(item => item.event === 'abort')).toBe(false)
    expect(socket.connected).toBe(false)
    expect(deviceEvents.at(-1)).toMatchObject({ status: 'completed', outcome: 'failed' })
  })

  it('only cancels its own queue item when interrupted before another active run finishes', async () => {
    const { socket, run, interrupt, receive } = setup(owner, false)
    receive('run.started', { queue_id: 'someone-else', run_id: 'other-active-run' })
    receive('run.queued', { queued_messages: [{ id: run.queue_id }] })
    interrupt()
    expect(socket.sent.filter(item => item.event === 'cancel_queued_run')).toEqual([
      { event: 'cancel_queued_run', payload: { session_id: run.session_id, queue_id: run.queue_id } },
    ])
    expect(socket.sent.some(item => item.event === 'abort')).toBe(false)
    expect(socket.connected).toBe(false)
  })

  it('sends exactly one cancelled terminal for its own interrupted active turn', async () => {
    const { socket, deviceEvents, interrupt } = setup(owner)
    interrupt(); interrupt()
    await vi.advanceTimersByTimeAsync(0)
    expect(deviceEvents.filter(event => event.status === 'completed' && event.outcome === 'cancelled')).toEqual([
      { type: 'interaction.status', interactionId, status: 'completed', outcome: 'cancelled', stop_reason: 'cancelled' },
    ])
    expect(socket.sent.filter(item => item.event === 'abort')).toHaveLength(1)
  })

  it('sends a cancelled terminal for its queued turn without aborting the other desktop run', async () => {
    const { socket, deviceEvents, interrupt, receive, run } = setup(owner, false)
    receive('run.started', { queue_id: 'desktop-queue', run_id: 'desktop-run' })
    receive('run.queued', { queued_messages: [{ id: run.queue_id }] })
    interrupt()
    await vi.advanceTimersByTimeAsync(0)
    expect(deviceEvents.filter(event => event.status === 'completed' && event.outcome === 'cancelled')).toEqual([
      { type: 'interaction.status', interactionId, status: 'completed', outcome: 'cancelled', stop_reason: 'cancelled' },
    ])
    expect(socket.sent.some(item => item.event === 'abort')).toBe(false)
  })

  it('publishes only the cancelled outcome when cancellation races with final playback cleanup', async () => {
    const { deviceEvents, receive, interrupt, run } = setup(owner)
    receive('run.completed', { queue_id: run.queue_id, output: '' })
    interrupt()
    await vi.advanceTimersByTimeAsync(0)
    expect(deviceEvents.filter(event => ['completed', 'cancelled'].includes(String(event.status)))).toEqual([
      { type: 'interaction.status', interactionId, status: 'completed', outcome: 'cancelled', stop_reason: 'cancelled' },
    ])
  })

  it.each(['previous-turn', '', undefined])('ignores a stale or absent interrupt ID %s while the next turn is running', async previousId => {
    const { socket, instance, deviceEvents } = setup(owner, true, 'ekko')
    if (owner === 'local') Reflect.get(instance, 'interruptMcuSession').call(instance, 'test-device', 'default', 'ekko', previousId)
    else Reflect.get(instance, 'interruptMcuSession').call(instance, 'default', previousId)
    await vi.advanceTimersByTimeAsync(0)
    expect(socket.connected).toBe(true)
    expect(socket.sent.some(item => item.event === 'abort' || item.event === 'cancel_queued_run')).toBe(false)
    expect(deviceEvents.some(event => event.status === 'completed' && event.outcome === 'cancelled')).toBe(false)
  })

  it('ignores other-session, missing-session and old-run human events on the same profile', async () => {
    const { socket, run, deviceEvents, receive } = setup(owner)
    const before = deviceEvents.length
    for (const scope of [{ session_id: 'different-session' }, { session_id: undefined }, { run_id: 'old-native-run' }]) {
      receive('approval.requested', { approval_id: 'foreign-approval', ...scope })
      receive('clarify.requested', { clarify_id: 'foreign-clarify', ...scope })
    }
    expect(deviceEvents).toHaveLength(before)
    receive('approval.requested', { approval_id: 'own-approval' })
    receive('clarify.requested', { clarify_id: 'own-clarify' })
    for (const scope of [{ session_id: 'different-session' }, { session_id: undefined }, { run_id: 'old-native-run' }]) {
      receive('approval.resolved', { approval_id: 'own-approval', resolved: true, ...scope })
      receive('clarify.resolved', { clarify_id: 'own-clarify', resolved: true, ...scope })
    }
    const waiting = deviceEvents.length
    await vi.advanceTimersByTimeAsync(30_000)
    expect(deviceEvents.length).toBeGreaterThan(waiting)
    expect(deviceEvents.some(event => event.type === 'tool.completed' && event.tool === 'approval')).toBe(false)
    receive('approval.resolved', { approval_id: 'own-approval', run_id: undefined, resolved: true, choice: 'once' })
    receive('clarify.resolved', { clarify_id: 'own-clarify', run_id: undefined, resolved: true })
    receive('run.completed', { queue_id: run.queue_id, output: '' })
    await vi.advanceTimersByTimeAsync(0)
    expect(socket.connected).toBe(false)
  })

  it('ignores stale native-run text, tools and terminal events while waiting for desktop input', async () => {
    const { socket, run, deviceEvents, receive } = setup(owner)
    receive('approval.requested', { approval_id: 'own-approval' })
    const before = deviceEvents.length
    const stale = { run_id: 'old-native-run', queue_id: 'old-queue' }
    receive('tool.started', { ...stale, tool: 'foreign-tool' })
    receive('tool.completed', { ...stale, tool: 'foreign-tool' })
    receive('message.delta', { ...stale, delta: 'old response must not be spoken' })
    receive('run.completed', { ...stale, output: 'old response must not be spoken' })
    receive('run.failed', { ...stale, error: 'old failure must not cancel this run' })
    await vi.advanceTimersByTimeAsync(0)
    expect(socket.connected).toBe(true)
    expect(deviceEvents).toHaveLength(before)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(deviceEvents.length).toBeGreaterThan(before)
    receive('approval.resolved', { approval_id: 'own-approval', choice: 'once' })
    receive('run.completed', { queue_id: run.queue_id, output: '' })
    await vi.advanceTimersByTimeAsync(0)
    expect(socket.connected).toBe(false)
  })

  it('keeps a pending human request when the same native run starts again', async () => {
    const { socket, run, deviceEvents, receive } = setup(owner)
    receive('clarify.requested', { clarify_id: 'own-clarify' })
    receive('run.started', { queue_id: run.queue_id })
    const before = deviceEvents.length
    await vi.advanceTimersByTimeAsync(30_000)
    expect(deviceEvents.length).toBeGreaterThan(before)
    receive('clarify.resolved', { clarify_id: 'own-clarify' })
    receive('run.completed', { queue_id: run.queue_id, output: '' })
    await vi.advanceTimersByTimeAsync(0)
    expect(socket.connected).toBe(false)
  })

  it('ignores another queue rejection that has no native run ID', async () => {
    const { socket, run, deviceEvents, receive } = setup(owner)
    receive('clarify.requested', { clarify_id: 'own-clarify' })
    const before = deviceEvents.length
    receive('run.failed', { queue_id: 'other-queue', run_id: undefined, error: 'another request was rejected' })
    expect(socket.connected).toBe(true)
    expect(deviceEvents).toHaveLength(before)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(deviceEvents.length).toBeGreaterThan(before)
    receive('clarify.resolved', { clarify_id: 'own-clarify' })
    receive('run.completed', { queue_id: run.queue_id, output: '' })
    await vi.advanceTimersByTimeAsync(0)
    expect(socket.connected).toBe(false)
  })

  it('does not downgrade active ownership when an old queued snapshot arrives late', async () => {
    const { socket, run, deviceEvents, receive } = setup(owner)
    receive('approval.requested', { approval_id: 'own-approval' })
    receive('run.queued', { queued_messages: [{ id: run.queue_id }] })
    const before = deviceEvents.length
    await vi.advanceTimersByTimeAsync(30_000)
    expect(deviceEvents.length).toBeGreaterThan(before)
    receive('approval.resolved', { approval_id: 'own-approval', choice: 'once' })
    receive('run.completed', { queue_id: run.queue_id, output: '' })
    await vi.advanceTimersByTimeAsync(0)
    expect(socket.connected).toBe(false)
  })
})
