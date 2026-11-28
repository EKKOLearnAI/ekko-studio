import { EventEmitter } from 'node:events'
import { afterAll, beforeAll, afterEach, beforeEach, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import type { Server } from 'socket.io'
const fixture = vi.hoisted(() => ({ io: vi.fn(), route: null as Record<string, any> | null, validate: vi.fn(), delivery: vi.fn(), recipient: vi.fn(), cancel: vi.fn(), release: vi.fn(), clear: vi.fn(), foreground: vi.fn() }))
vi.mock('socket.io-client', () => ({ io: fixture.io }))
vi.mock('../../packages/server/src/modules/studio/public/config', () => ({ config: { port: 18648, appHome: '/unused-bound-socket' } }))
vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('../../packages/server/src/modules/studio/public/chat-run', () => ({ getChatRunServer: () => ({ clearSessionHistory: fixture.clear }) }))
vi.mock('../../packages/server/src/modules/studio/repositories/mcu-session-bindings', () => ({ getMcuSessionBinding: () => ({ sessionId: fixture.route?.sessionId }) }))
vi.mock('../../packages/server/src/modules/studio/services/devices/mcu-session-bindings', () => ({
  getMcuVoiceRoute: () => fixture.route, validateMcuVoiceRoute: fixture.validate, validateMcuVoiceDelivery: fixture.delivery, validateMcuVoiceRecipient: fixture.recipient,
  releaseMcuVoiceRoute: fixture.release, cancelMcuVoiceRoute: fixture.cancel, releaseMcuVoiceForeground: fixture.foreground, releaseMcuVoiceRoutesForClient: vi.fn(),
  activeMcuVoiceRoute: () => fixture.route, legacyMcuSessionId: () => 'legacy-session',
}))
import { GlobalAgentServer } from '../../packages/server/src/modules/studio/sockets/global-agent'
class Peer extends EventEmitter {
  connected = true
  readonly sent: Array<{ event: string; payload: Record<string, unknown> }> = []
  readonly acknowledgements: Array<{ event: string; reply: (value: Record<string, unknown>) => void }> = []
  autoAck = true
  emit(event: string, payload: Record<string, unknown>, ack?: (value: Record<string, unknown>) => void) {
    this.sent.push({ event, payload })
    if (ack) { this.acknowledgements.push({ event, reply: ack }); if (this.autoAck) ack({ ...payload, settled: true }) }
    return true
  }
  receive(event: string, payload: Record<string, unknown> = {}) { return super.emit(event, payload) }
  disconnect() { this.connected = false; return this }
}
let firmwareDirectory = '', firmwareProbe = ''
const exec = promisify(execFile)
beforeAll(async () => {
  firmwareDirectory = await mkdtemp(join(tmpdir(), 'stackchan-firmware-terminal-'))
  firmwareProbe = join(firmwareDirectory, 'fence')
  const source = resolve('tests/fixtures/stackchan-firmware')
  await exec('c++', ['-std=c++17', join(source, 'fence-main.cpp'), join(source, 'conversation_identity.cpp'), '-I', source, '-o', firmwareProbe])
})
afterAll(async () => { if (firmwareDirectory) await rm(firmwareDirectory, { recursive: true, force: true }) })
let peer: Peer, server: GlobalAgentServer
const events: Record<string, unknown>[] = []
beforeEach(() => {
  peer = new Peer(); fixture.io.mockReturnValue(peer)
  const cancellation = new AbortController()
  let resolveSettlement!: () => void
  const settlement = new Promise<void>(resolve => { resolveSettlement = resolve })
  fixture.cancel.mockImplementation(() => cancellation.abort())
  fixture.release.mockImplementation(() => { cancellation.abort(); resolveSettlement() })
  fixture.route = { settlement, resolveSettlement, signal: cancellation.signal, userId: 1, deviceCode: 'physical-a', clientId: 'own-device', profile: 'default', interactionId: 'own-turn', leaseId: 'verified-lease', sessionId: 'selected-chat', bound: true, runFields: { source: 'coding_agent', agent_id: 'codex', mode: 'scoped', model: 'chosen-model' } }
  fixture.validate.mockResolvedValue(fixture.route); fixture.delivery.mockResolvedValue(undefined); fixture.recipient.mockResolvedValue(undefined)
  server = new GlobalAgentServer({ of: () => ({}) } as unknown as Server)
  vi.spyOn(server, 'emitMcuEvent').mockImplementation(payload => { events.push(payload); return true })
})
afterEach(async () => {
  peer.receive('connect_error', new Error('fixture cleanup') as unknown as Record<string, unknown>)
  peer.connected = false; peer.receive('disconnect')
  await Promise.resolve(); events.length = 0; vi.resetAllMocks()
})
function start() {
  server.startMcuVoiceChatTurn({ clientId: 'own-device', profile: 'default', agentRuntime: 'hermes', interactionId: 'own-turn', transcript: 'hello', userToken: 'paired-token', routeLeaseId: 'verified-lease' })
  peer.receive('connect')
}
it('does not enqueue synthesized speech when cancellation arrives during its final ownership check', async () => {
  let finishValidation!: () => void
  const validation = new Promise<void>(resolve => { finishValidation = resolve })
  fixture.validate.mockImplementation(async () => { await validation; return fixture.route })
  const waitForPlayback = vi.fn(async () => undefined)
  Reflect.set(server, 'waitForMcuAudioDone', waitForPlayback)
  const cancellation = new AbortController()
  const pending = Reflect.get(server, 'enqueueMcuSpeechSegment').call(server,
    { interactionId: 'own-turn', clientId: 'own-device', userToken: 'paired-token', routeLeaseId: 'verified-lease' },
    'late-audio', 'hello', Promise.resolve({ ok: true, audio: { url: '/audio/fixture', mimeType: 'audio/x-ima-adpcm' } }), cancellation.signal)
  await vi.waitFor(() => expect(fixture.validate).toHaveBeenCalled())
  cancellation.abort()
  finishValidation()
  await (await pending).playbackDone
  expect(events.some(event => event.type === 'audio.enqueue')).toBe(false)
  expect(waitForPlayback).not.toHaveBeenCalled()
})
it('runs the verified selected session with its original runtime/mode/model on the real chat handler', async () => {
  start()
  await vi.waitFor(() => expect(peer.sent.some(item => item.event === 'run')).toBe(true))
  expect(peer.sent.find(item => item.event === 'run')!.payload).toMatchObject({ session_id: 'selected-chat', require_existing_session: true, source: 'coding_agent', agent_id: 'codex', mode: 'scoped', model: 'chosen-model', input: 'hello' })
  expect(fixture.validate).toHaveBeenCalledWith('verified-lease', 'paired-token')
})
it('uses standard chat-run BOT input without overriding the BOT-owned model or execution policy', async () => {
  fixture.route = { ...fixture.route, sessionId: 'person-main-owned', kind: 'bot', runFields: {} }
  start()
  await vi.waitFor(() => expect(peer.sent.some(item => item.event === 'run')).toBe(true))
  const input = peer.sent.find(item => item.event === 'run')!.payload
  expect(input.session_id).toBe('person-main-owned')
  expect(input).not.toHaveProperty('source'); expect(input).not.toHaveProperty('model'); expect(input).not.toHaveProperty('agent_id')
})
it('does not create or revive a deleted selected session when connection opens after authorization changed', async () => {
  fixture.validate.mockRejectedValue(new Error('target was deleted')); fixture.delivery.mockRejectedValue(new Error('target was deleted'))
  start()
  await vi.waitFor(() => expect(peer.connected).toBe(false))
  expect(peer.sent.some(item => item.event === 'run')).toBe(false)
  expect(events.filter(event => !['failed','completed'].includes(String(event.status)))).toEqual([])
  expect(events.some(event => 'text' in event)).toBe(false)
  expect(fixture.release).toHaveBeenCalledWith('verified-lease')
})
it('rejects firmware clear for a bound desktop/BOT conversation without deleting its history or cancelling its run', async () => {
  start()
  await vi.waitFor(() => expect(peer.sent.some(item => item.event === 'run')).toBe(true))
  Reflect.get(server, 'clearMcuSession').call(server, 'own-device', 'default', 'hermes', 'own-turn')
  expect(fixture.clear).not.toHaveBeenCalled()
  expect(peer.connected).toBe(true)
  expect(peer.sent.some(item => item.event === 'abort' || item.event === 'cancel_queued_run')).toBe(false)
  expect(events.at(-1)).toMatchObject({ type: 'mcu.session.cleared', ok: false, error: 'bound_session_history_preserved' })
})

it('does not send pending status events after the device cancels during an asynchronous ownership check', async () => {
  let releaseDelivery!: () => void
  fixture.delivery.mockImplementation(() => new Promise<void>(resolve => { releaseDelivery = resolve }))
  start()
  await vi.waitFor(() => expect(peer.sent.some(item => item.event === 'run')).toBe(true))
  Reflect.get(server, 'interruptMcuSession').call(server, 'own-device', 'default', 'hermes', 'own-turn')
  releaseDelivery()
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
  expect(events.filter(event => !['aborted','completed'].includes(String(event.status)))).toEqual([])
})

it('releases foreground voice admission after playback even when a native background task still needs its listener', async () => {
  start()
  await vi.waitFor(() => expect(peer.sent.some(item => item.event === 'run')).toBe(true))
  const run = peer.sent.find(item => item.event === 'run')!.payload
  peer.receive('run.started', { session_id: run.session_id, run_id: 'own-native-run', queue_id: run.queue_id })
  peer.receive('run.completed', { session_id: run.session_id, run_id: 'own-native-run', queue_id: run.queue_id, background_pending: 1, output: '' })
  await vi.waitFor(() => expect(fixture.foreground).toHaveBeenCalledWith('verified-lease'))
  expect(peer.connected).toBe(true)
  expect(fixture.release).not.toHaveBeenCalled()
})

it('still delivers a normal completed status after asynchronous authorization even when foreground cleanup has finished', async () => {
  let releaseDelivery!: () => void
  fixture.delivery.mockImplementationOnce(() => new Promise<void>(resolve => { releaseDelivery = resolve }))
  start()
  await vi.waitFor(() => expect(peer.sent.some(item => item.event === 'run')).toBe(true))
  const run = peer.sent.find(item => item.event === 'run')!.payload
  peer.receive('run.started', { session_id: run.session_id, run_id: 'own-native-run', queue_id: run.queue_id })
  peer.receive('run.completed', { session_id: run.session_id, run_id: 'own-native-run', queue_id: run.queue_id, background_pending: 0, output: '' })
  await vi.waitFor(() => expect(peer.connected).toBe(false))
  releaseDelivery()
  await vi.waitFor(() => expect(events.at(-1)).toMatchObject({ type: 'interaction.status', status: 'completed' }))
})


it('acknowledges cancellation of an ASR lease only for its matching turn ID and deduplicates repeated stops', async () => {
  Reflect.get(server, 'clients').set('own-device', { data: { userToken: 'paired-token' } })
  Reflect.get(server, 'interruptMcuSession').call(server, 'own-device', 'default', 'hermes', 'own-turn')
  Reflect.get(server, 'interruptMcuSession').call(server, 'own-device', 'default', 'hermes', 'own-turn')
  expect(events).toEqual([])
  fixture.release('verified-lease') // actual ASR finally, after its abort has settled
  await vi.waitFor(() => expect(events.filter(event => event.status === 'completed' && event.outcome === 'cancelled')).toHaveLength(1))
  expect(events.filter(event => event.status === 'completed')).toEqual([{ type: 'interaction.status', interactionId: 'own-turn', status: 'completed', outcome: 'cancelled', stop_reason: 'cancelled' }])
  expect(fixture.release).toHaveBeenCalledWith('verified-lease')
  expect(peer.sent).toEqual([])
})

it('never cancels or acknowledges another device or Profile lease even when its interaction ID is known', async () => {
  Reflect.get(server, 'interruptMcuSession').call(server, 'other-device', 'default', 'hermes', 'own-turn')
  Reflect.get(server, 'interruptMcuSession').call(server, 'own-device', 'other-profile', 'hermes', 'own-turn')
  await Promise.resolve(); await Promise.resolve()
  expect(fixture.release).not.toHaveBeenCalled()
  expect(events).toEqual([])
})

it('does not invent a cancelled terminal for an unknown turn when no owned lease or run exists', async () => {
  fixture.route = null
  Reflect.get(server, 'interruptMcuSession').call(server, 'own-device', 'default', 'hermes', 'unknown-turn')
  await Promise.resolve(); await Promise.resolve()
  expect(fixture.release).not.toHaveBeenCalled()
  expect(events).toEqual([])
})

it('settles the authenticated turn once when its lease is cancelled before the chat socket connects', async () => {
  const cancellation = new AbortController()
  fixture.route!.signal = cancellation.signal
  server.startMcuVoiceChatTurn({ clientId: 'own-device', profile: 'default', agentRuntime: 'hermes', interactionId: 'own-turn', transcript: 'hello', userToken: 'paired-token', routeLeaseId: 'verified-lease' })
  cancellation.abort()
  peer.receive('connect')
  await vi.waitFor(() => expect(events.filter(event => event.status === 'completed' && event.outcome === 'cancelled')).toHaveLength(1))
  expect(peer.sent.some(item => item.event === 'run')).toBe(false)
  expect(events.filter(event => !['aborted','completed'].includes(String(event.status)))).toEqual([])
})

it('stops its own work but does not send a cancellation terminal to a revoked or replaced recipient', async () => {
  fixture.recipient.mockRejectedValue(new Error('device authorization revoked'))
  start()
  await vi.waitFor(() => expect(peer.sent.some(item => item.event === 'run')).toBe(true))
  Reflect.get(server, 'interruptMcuSession').call(server, 'own-device', 'default', 'hermes', 'own-turn')
  await Promise.resolve(); await Promise.resolve()
  expect(peer.connected).toBe(false)
  expect(events.some(event => event.status === 'completed' && event.outcome === 'cancelled')).toBe(false)
})

it('does not send another terminal for an already completed foreground when Stop only releases its background listener', async () => {
  start()
  await vi.waitFor(() => expect(peer.sent.some(item => item.event === 'run')).toBe(true))
  const run = peer.sent.find(item => item.event === 'run')!.payload
  peer.receive('run.started', { session_id: run.session_id, run_id: 'own-native-run', queue_id: run.queue_id })
  peer.receive('run.completed', { session_id: run.session_id, run_id: 'own-native-run', queue_id: run.queue_id, background_pending: 1, output: '' })
  await vi.waitFor(() => expect(events.some(event => event.status === 'completed')).toBe(true))
  Reflect.get(server, 'interruptMcuSession').call(server, 'own-device', 'default', 'hermes', 'own-turn')
  await Promise.resolve(); await Promise.resolve()
  expect(events.some(event => event.status === 'completed' && event.outcome === 'cancelled')).toBe(false)
})

it('sends one cancelled terminal when Stop beats an authorized completed status still pending after background cleanup', async () => {
  let releaseDelivery!: () => void
  fixture.delivery.mockImplementationOnce(() => new Promise<void>(resolve => { releaseDelivery = resolve }))
  start()
  await vi.waitFor(() => expect(peer.sent.some(item => item.event === 'run')).toBe(true))
  const run = peer.sent.find(item => item.event === 'run')!.payload
  peer.receive('run.started', { session_id: run.session_id, run_id: 'own-native-run', queue_id: run.queue_id })
  peer.receive('run.completed', { session_id: run.session_id, run_id: 'own-native-run', queue_id: run.queue_id, background_pending: 1, output: '' })
  await vi.waitFor(() => expect(fixture.foreground).toHaveBeenCalled())
  Reflect.get(server, 'interruptMcuSession').call(server, 'own-device', 'default', 'hermes', 'own-turn')
  releaseDelivery()
  await vi.waitFor(() => expect(events.some(event => event.status === 'completed')).toBe(true))
  expect(events.filter(event => event.status === 'completed')).toEqual([{ type: 'interaction.status', interactionId: 'own-turn', status: 'completed', outcome: 'cancelled', stop_reason: 'cancelled' }])
})

it('settles a pending terminal with a content-free owner-verified cancellation when its binding changes after foreground cleanup', async () => {
  let invalidateDelivery!: () => void
  fixture.delivery.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { invalidateDelivery = () => reject(new Error('binding revision changed')) }))
  start()
  await vi.waitFor(() => expect(peer.sent.some(item => item.event === 'run')).toBe(true))
  const run = peer.sent.find(item => item.event === 'run')!.payload
  peer.receive('run.started', { session_id: run.session_id, run_id: 'own-native-run', queue_id: run.queue_id })
  peer.receive('run.completed', { session_id: run.session_id, run_id: 'own-native-run', queue_id: run.queue_id, background_pending: 0, output: '' })
  await vi.waitFor(() => expect(peer.connected).toBe(false))
  fixture.delivery.mockRejectedValue(new Error('binding revision changed'))
  invalidateDelivery()
  await vi.waitFor(() => expect(events.some(event => event.status === 'completed')).toBe(true))
  expect(events.filter(event => event.status === 'completed')).toEqual([{ type: 'interaction.status', interactionId: 'own-turn', status: 'completed', outcome: 'cancelled', stop_reason: 'cancelled' }])
  expect(fixture.recipient).toHaveBeenCalled()
})


it.each(['previous-turn', '', undefined])('does not release the new ASR lease for stale or absent turn ID %s', async previousId => {
  Reflect.get(server, 'clients').set('own-device', { data: { userToken: 'paired-token' } })
  Reflect.get(server, 'interruptMcuSession').call(server, 'own-device', 'default', 'hermes', previousId)
  await Promise.resolve(); await Promise.resolve()
  expect(fixture.release).not.toHaveBeenCalled()
  expect(events).toEqual([])
})

it.each(['ASR', 'native'])('does not let a delayed previous-turn interrupt cancel the next %s turn', async phase => {
  vi.useFakeTimers()
  try {
    const nextRoute = fixture.route!
    fixture.route = { ...nextRoute, leaseId: 'previous-lease', interactionId: 'previous-turn' }
    Reflect.get(server, 'scheduleMcuInterrupt').call(server, 'own-device', 'default', 'hermes', 'previous-turn')
    fixture.route = nextRoute
    if (phase === 'native') {
      start(); await vi.advanceTimersByTimeAsync(0)
      const run = peer.sent.find(item => item.event === 'run')!.payload
      peer.receive('run.started', { session_id: run.session_id, run_id: 'new-native-run', queue_id: run.queue_id })
    }
    await vi.advanceTimersByTimeAsync(1000)
    expect(fixture.release).not.toHaveBeenCalled()
    expect(peer.sent.some(item => item.event === 'abort' || item.event === 'cancel_queued_run')).toBe(false)
    expect(events.some(event => event.status === 'completed' && event.outcome === 'cancelled')).toBe(false)
  } finally {
    peer.receive('connect_error', new Error('fixture cleanup') as unknown as Record<string, unknown>)
    await vi.advanceTimersByTimeAsync(0)
    vi.clearAllTimers(); vi.useRealTimers()
  }
})


it('clears only the actually cancelled turn in the unchanged real StackChan firmware OutstandingTurns implementation', async () => {
  start()
  await vi.waitFor(() => expect(peer.sent.some(item => item.event === 'run')).toBe(true))
  const run = peer.sent.find(item => item.event === 'run')!.payload
  peer.receive('run.started', { session_id: run.session_id, run_id: 'own-native-run', queue_id: run.queue_id })
  Reflect.get(server, 'interruptMcuSession').call(server, 'own-device', 'default', 'hermes', 'own-turn')
  await vi.waitFor(() => expect(events.some(event => ['cancelled','aborted','completed'].includes(String(event.status)))).toBe(true))
  const statuses = events.filter(event => event.type === 'interaction.status')
  const { stdout } = await exec(firmwareProbe, statuses.flatMap(event => [String(event.interactionId), String(event.status)]))
  expect(JSON.parse(stdout)).toEqual({ own: false, new: true, count: 1 })
})

it('does not settle a stopped turn when its old playback finishes before native cancellation is confirmed', async () => {
  let finishPlayback!: () => void
  const playbackDone = new Promise<void>(resolve => { finishPlayback = resolve })
  Reflect.set(server, 'synthesizeMcuSpeech', vi.fn(async () => ({ url: 'http://audio.invalid', mimeType: 'audio/x-pcm', sampleRate: 24000, channels: 1 })))
  const enqueue = vi.fn(async () => ({ playbackDone }))
  Reflect.set(server, 'enqueueMcuSpeechSegment', enqueue)
  peer.autoAck = false
  start()
  await vi.waitFor(() => expect(peer.sent.some(item => item.event === 'run')).toBe(true))
  const run = peer.sent.find(item => item.event === 'run')!.payload
  peer.receive('run.started', { session_id: run.session_id, run_id: 'own-native-run', queue_id: run.queue_id })
  peer.receive('run.completed', { session_id: run.session_id, run_id: 'own-native-run', queue_id: run.queue_id, output: 'hello' })
  await vi.waitFor(() => expect(enqueue).toHaveBeenCalled())
  Reflect.get(server, 'interruptMcuSession').call(server, 'own-device', 'default', 'hermes', 'own-turn')
  finishPlayback()
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(fixture.release).not.toHaveBeenCalled()
  expect(events.some(event => event.status === 'completed')).toBe(false)
  peer.acknowledgements.at(-1)!.reply({ session_id: run.session_id, run_id: 'own-native-run', settled: true })
  await vi.waitFor(() => expect(events.some(event => event.status === 'completed' && event.outcome === 'cancelled')).toBe(true))
})

it('reports an unconfirmed cancellation after a bounded missing ACK without retiring its actual fence', async () => {
  vi.useFakeTimers()
  try {
    peer.autoAck = false; start()
    await vi.advanceTimersByTimeAsync(0)
    const run = peer.sent.find(item => item.event === 'run')!.payload
    peer.receive('run.started', { session_id: run.session_id, run_id: 'own-native-run', queue_id: run.queue_id })
    Reflect.get(server, 'interruptMcuSession').call(server, 'own-device', 'default', 'hermes', 'own-turn')
    await vi.advanceTimersByTimeAsync(30_001)
    expect(events.at(-1)).toMatchObject({ status: 'failed', reason: 'cancel_unconfirmed' })
    expect(events.some(event => event.status === 'completed')).toBe(false)
    expect(fixture.release).not.toHaveBeenCalled()
    expect(peer.sent.filter(item => item.event === 'abort')).toHaveLength(1)
    const { stdout } = await exec(firmwareProbe, events.filter(event => event.type === 'interaction.status').flatMap(event => [String(event.interactionId), String(event.status)]))
    expect(JSON.parse(stdout)).toEqual({ own: true, new: true, count: 2 })
  } finally { vi.clearAllTimers(); vi.useRealTimers() }
})

it.each(['session_id', 'run_id'])('rejects a cancellation ACK with the wrong %s without pretending it settled', async field => {
  peer.autoAck = false; start()
  await vi.waitFor(() => expect(peer.sent.some(item => item.event === 'run')).toBe(true))
  const run = peer.sent.find(item => item.event === 'run')!.payload
  peer.receive('run.started', { session_id: run.session_id, run_id: 'own-native-run', queue_id: run.queue_id })
  Reflect.get(server, 'interruptMcuSession').call(server, 'own-device', 'default', 'hermes', 'own-turn')
  peer.acknowledgements.at(-1)!.reply({ session_id: run.session_id, run_id: 'own-native-run', settled: true, [field]: 'someone-else' })
  await vi.waitFor(() => expect(events.at(-1)).toMatchObject({ status: 'failed', reason: 'cancel_unconfirmed' }))
  expect(fixture.release).not.toHaveBeenCalled()
  expect(events.some(event => event.status === 'completed')).toBe(false)
})

it('cleans up disconnected cancellation observers without inventing a successful native termination', async () => {
  peer.autoAck = false; start()
  await vi.waitFor(() => expect(peer.sent.some(item => item.event === 'run')).toBe(true))
  const run = peer.sent.find(item => item.event === 'run')!.payload
  peer.receive('run.started', { session_id: run.session_id, run_id: 'own-native-run', queue_id: run.queue_id })
  Reflect.get(server, 'interruptMcuSession').call(server, 'own-device', 'default', 'hermes', 'own-turn')
  peer.connected = false; peer.receive('disconnect')
  await vi.waitFor(() => expect(events.at(-1)).toMatchObject({ status: 'failed', reason: 'cancel_unconfirmed' }))
  expect(peer.eventNames()).toEqual([])
  expect(fixture.release).not.toHaveBeenCalled()
  expect(events.some(event => event.status === 'completed')).toBe(false)
  peer.acknowledgements.at(-1)!.reply({ session_id: run.session_id, run_id: 'own-native-run', settled: true })
  await Promise.resolve()
  expect(fixture.release).not.toHaveBeenCalled()
})

it('follows only its own queue-to-run cancellation race and waits for that exact native ACK', async () => {
  peer.autoAck = false; start()
  await vi.waitFor(() => expect(peer.sent.some(item => item.event === 'run')).toBe(true))
  const run = peer.sent.find(item => item.event === 'run')!.payload
  Reflect.get(server, 'interruptMcuSession').call(server, 'own-device', 'default', 'hermes', 'own-turn')
  peer.acknowledgements.at(-1)!.reply({ session_id: run.session_id, queue_id: run.queue_id, settled: false, reason: 'not_found' })
  peer.receive('run.started', { session_id: run.session_id, run_id: 'desktop-run', queue_id: 'desktop-queue' })
  expect(peer.sent.some(item => item.event === 'abort')).toBe(false)
  peer.receive('run.started', { session_id: run.session_id, run_id: 'own-native-run', queue_id: run.queue_id })
  expect(peer.sent.filter(item => item.event === 'abort')).toEqual([{ event: 'abort', payload: { session_id: run.session_id, run_id: 'own-native-run' } }])
  expect(events.some(event => event.status === 'completed')).toBe(false)
  peer.acknowledgements.at(-1)!.reply({ session_id: run.session_id, run_id: 'own-native-run', settled: true })
  await vi.waitFor(() => expect(events.some(event => event.status === 'completed' && event.outcome === 'cancelled')).toBe(true))
})

it('upgrades a pending queue cancellation to its own newly admitted run without trusting the older queue ACK', async () => {
  peer.autoAck = false; start()
  await vi.waitFor(() => expect(peer.sent.some(item => item.event === 'run')).toBe(true))
  const run = peer.sent.find(item => item.event === 'run')!.payload
  Reflect.get(server, 'interruptMcuSession').call(server, 'own-device', 'default', 'hermes', 'own-turn')
  const queuedReply = peer.acknowledgements.at(-1)!.reply
  peer.receive('run.started', { session_id: run.session_id, run_id: 'own-native-run', queue_id: run.queue_id })
  expect(peer.sent.filter(item => item.event === 'abort')).toEqual([{ event: 'abort', payload: { session_id: run.session_id, run_id: 'own-native-run' } }])
  queuedReply({ session_id: run.session_id, queue_id: run.queue_id, settled: true })
  await Promise.resolve()
  expect(events.some(event => event.status === 'completed')).toBe(false)
  expect(fixture.release).not.toHaveBeenCalled()
  peer.acknowledgements.at(-1)!.reply({ session_id: run.session_id, run_id: 'own-native-run', settled: true })
  await vi.waitFor(() => expect(events.some(event => event.status === 'completed' && event.outcome === 'cancelled')).toBe(true))
})

it('settles a whole native failure only after its exact run exits and keeps the firmware failure phase', async () => {
  peer.autoAck = false; start()
  await vi.waitFor(() => expect(peer.sent.some(item => item.event === 'run')).toBe(true))
  const run = peer.sent.find(item => item.event === 'run')!.payload
  peer.receive('run.started', { session_id: run.session_id, run_id: 'own-native-run', queue_id: run.queue_id })
  peer.receive('run.failed', { session_id: run.session_id, run_id: 'own-native-run', queue_id: run.queue_id, error: 'fixture failure' })
  expect(events.some(event => event.status === 'completed')).toBe(false)
  peer.acknowledgements.at(-1)!.reply({ session_id: run.session_id, run_id: 'own-native-run', settled: true })
  await vi.waitFor(() => expect(events.some(event => event.status === 'completed' && event.outcome === 'failed')).toBe(true))
  const statuses = events.filter(event => event.type === 'interaction.status')
  expect(statuses.slice(-2).map(event => event.status)).toEqual(['failed', 'completed'])
  const { stdout } = await exec(firmwareProbe, statuses.flatMap(event => [String(event.interactionId), String(event.status)]))
  expect(JSON.parse(stdout)).toEqual({ own: false, new: true, count: 1 })
})

it('does not retire the firmware fence or release the turn for a failed TTS segment', async () => {
  Reflect.set(server, 'synthesizeMcuSpeech', vi.fn(async () => ({ url: 'http://audio.invalid', mimeType: 'audio/x-pcm', sampleRate: 24000, channels: 1 })))
  Reflect.set(server, 'enqueueMcuSpeechSegment', vi.fn(async () => { throw new Error('fixture segment unavailable') }))
  start()
  await vi.waitFor(() => expect(peer.sent.some(item => item.event === 'run')).toBe(true))
  const run = peer.sent.find(item => item.event === 'run')!.payload
  const scope = { session_id: run.session_id, run_id: 'own-native-run', queue_id: run.queue_id }
  peer.receive('run.started', scope)
  peer.receive('message.delta', { ...scope, delta: '这是仍然运行中的一段测试回复。' })
  peer.receive('tool.started', { ...scope, tool: 'fixture-tool' })
  await vi.waitFor(() => expect(events.some(event => event.status === 'failed')).toBe(true))
  expect(events.some(event => event.status === 'completed')).toBe(false)
  expect(fixture.release).not.toHaveBeenCalled()
  const { stdout } = await exec(firmwareProbe, events.filter(event => event.type === 'interaction.status').flatMap(event => [String(event.interactionId), String(event.status)]))
  expect(JSON.parse(stdout)).toEqual({ own: true, new: true, count: 2 })
})
