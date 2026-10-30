import { afterEach, describe, expect, it, vi } from 'vitest'
import { initAllHermesTables } from '../../packages/server/src/modules/studio/infrastructure/database/schemas'
import { clearSessionMessages, createSession, deleteSession, getSessionGeneration } from '../../packages/server/src/modules/studio/repositories/session-store'
import { getSessionNotification } from '../../packages/server/src/modules/studio/repositories/session-notification-store'
import { handleAbort } from '../../packages/server/src/modules/studio/services/chat-run/abort'
import { handleSessionCommand, parseSessionCommand } from '../../packages/server/src/modules/studio/services/chat-run/session-command'
import { studioInstanceId } from '../../packages/server/src/modules/studio/public/session-notifications'
import * as chatRuntime from '../../packages/server/src/modules/studio/public/chat-agent-runtime'
import { ChatRunSocket } from '../../packages/server/src/modules/studio/sockets/chat-run'

// repair-release@1 R2 (owner generation/profile through claim and admission) and R3 (queued
// machine events settled on cancellation), on the production ChatRunSocket scheduling path.
function makeServer(options: { realHandleRun?: boolean } = {}) {
  const emit = vi.fn()
  const nsp: any = { use: vi.fn(), on: vi.fn(), to: vi.fn(() => ({ emit, except: vi.fn(() => ({ emit })) })),
    adapter: { rooms: new Map() }, sockets: new Map() }
  vi.spyOn(chatRuntime, 'createPrimaryAgentBridge').mockReturnValue({} as any)
  vi.spyOn(chatRuntime.chatCodingAgentRunManager, 'hasSession').mockReturnValue(false)
  vi.spyOn(chatRuntime, 'hasChatEkkoBackgroundTasks').mockReturnValue(false)
  const server: any = new ChatRunSocket({ of: () => nsp } as any)
  const bridge = { processNotification: vi.fn(async (action: string) => (action === 'admit' ? { admitted: true } : { ok: true })) }
  server.backgroundBridge = bridge
  server.bridge = bridge
  const handleRun = options.realHandleRun ? vi.spyOn(server, 'handleRun') : vi.spyOn(server, 'handleRun').mockResolvedValue(undefined)
  return { server, nsp, bridge, handleRun }
}

let counter = 0
function ownedSession() {
  initAllHermesTables()
  const sid = `machine-${Date.now()}-${counter += 1}`
  createSession({ id: sid, profile: 'default', source: 'cli', agent: 'hermes' })
  return { sid, generation: getSessionGeneration(sid)! }
}

function notification(sid: string, generation: string | null, overrides: Record<string, unknown> = {}) {
  const key = `hermes-process:default:proc_${sid}:${counter}`
  return { kind: 'process_completion', producer_key: key, claim_id: `claim-${key}`, session_id: sid, profile: 'default',
    process_id: `proc_${sid}`, owner_generation: generation, exit_code: 0, status: 'succeeded',
    message: '[IMPORTANT: Background process completed normally (exit code 0).]', ...overrides }
}

const disposition = (event: any) => getSessionNotification(studioInstanceId(), event.profile, event.producer_key)?.disposition
const settled = (bridge: any, event: any) => bridge.processNotification.mock.calls.some(([action, ref]: any[]) =>
  action === 'complete' && ref.producer_key === event.producer_key)

async function flush() {
  for (let index = 0; index < 10; index += 1) await new Promise(resolve => setImmediate(resolve))
}

afterEach(() => vi.restoreAllMocks())

describe('R2 producer owner identity at scheduling', () => {
  it('a completion produced before a reset never enters the reset conversation', async () => {
    const { server, bridge, handleRun } = makeServer()
    const { sid, generation } = ownedSession()
    clearSessionMessages(sid)
    const event = notification(sid, generation)
    await server.scheduleProcessNotification(event)
    await flush()
    expect(handleRun).not.toHaveBeenCalled()
    expect(disposition(event)).toBe('owner_reset')
    expect(settled(bridge, event)).toBe(true)
  })

  it('a completion from another profile is not adopted by a recreated session', async () => {
    const { server, handleRun } = makeServer()
    const { sid, generation } = ownedSession()
    const event = notification(sid, generation, { profile: 'other' })
    await server.scheduleProcessNotification(event)
    await flush()
    expect(handleRun).not.toHaveBeenCalled()
    expect(['owner_missing', 'owner_reset']).toContain(disposition(event))
  })

  it('a completion without a producer generation fails closed', async () => {
    const { server, handleRun } = makeServer()
    const { sid } = ownedSession()
    const event = notification(sid, null)
    await server.scheduleProcessNotification(event)
    await flush()
    expect(handleRun).not.toHaveBeenCalled()
  })
})

describe('R2 owner rechecked after awaited admission', () => {
  for (const [label, change, expected] of [
    ['Stop', (server: any, sid: string) => { server.sessionMap.get(sid).backgroundWakeStopped = true }, 'owner_stopped'],
    ['history reset', (_server: any, sid: string) => { clearSessionMessages(sid) }, 'owner_reset'],
    ['delete', (_server: any, sid: string) => { deleteSession(sid) }, 'owner_missing'],
  ] as const) {
    it(`${label} while the admission RPC is pending fails closed`, async () => {
      const { server, bridge, handleRun } = makeServer()
      const { sid, generation } = ownedSession()
      let release!: () => void
      bridge.processNotification.mockImplementation(async (action: string) => {
        if (action === 'admit') {
          await new Promise<void>(resolve => { release = resolve })
          return { admitted: true }
        }
        return { ok: true }
      })
      const event = notification(sid, generation)
      await server.scheduleProcessNotification(event)
      await flush()
      change(server, sid)
      release()
      await flush()
      expect(handleRun).not.toHaveBeenCalled()
      expect(disposition(event)).toBe(expected)
    })
  }

  it('positive control: the current owner runs once with a final dispatch fence', async () => {
    const { server, handleRun } = makeServer()
    const { sid, generation } = ownedSession()
    const event = notification(sid, generation)
    await server.scheduleProcessNotification(event)
    await flush()
    expect(handleRun).toHaveBeenCalledTimes(1)
    const data = handleRun.mock.calls[0][1] as any
    expect(typeof data.machine_fence).toBe('function')
    expect(data.machine_fence()).toBeNull()
    // Admission alone is not execution: only the final seam marks the event dispatched.
    expect(disposition(event)).toBe('admitted')
    data.on_machine_dispatch()
    expect(disposition(event)).toBe('dispatched')
    clearSessionMessages(sid)
    expect(data.machine_fence()).toBe('owner_reset')
  })
})

describe('S4 run ownership captured at admission', () => {
  function gatedAdmission(bridge: any) {
    let release!: () => void
    bridge.processNotification.mockImplementation(async (action: string) => {
      if (action === 'admit') {
        await new Promise<void>(resolve => { release = resolve })
        return { admitted: true }
      }
      return { ok: true }
    })
    return () => release()
  }

  it('/destroy while the admission RPC is pending: no dispatch and the destroyed state is left alone', async () => {
    const { server, nsp, bridge, handleRun } = makeServer()
    const { sid, generation } = ownedSession()
    const release = gatedAdmission(bridge)
    const event = notification(sid, generation)
    await server.scheduleProcessNotification(event)
    await flush()
    const state = server.sessionMap.get(sid)
    expect(state.isWorking).toBe(true)
    const socket: any = { id: 'destroyer', connected: true, data: {}, emit: vi.fn(), join: vi.fn(), to: vi.fn(() => ({ emit: vi.fn() })) }
    await handleSessionCommand(sid, parseSessionCommand('/destroy')!, { nsp, socket, sessionMap: server.sessionMap,
      bridge: { ...bridge, interrupt: vi.fn(async () => ({ ok: true })), destroy: vi.fn(async () => ({ ok: true })) } as any,
      profile: 'default', runQueuedItem: vi.fn() })
    expect(getSessionGeneration(sid)).toBe(generation)
    release()
    await flush()
    expect(handleRun).not.toHaveBeenCalled()
    expect(disposition(event)).toBe('owner_stopped')
    expect(state.isWorking).toBe(false)
    expect(state.activeRunMarker).toBeUndefined()
  })

  it('Stop then a new intentional turn while admission is pending: the old event never runs or touches the new turn', async () => {
    const { server, bridge, handleRun } = makeServer()
    const { sid, generation } = ownedSession()
    const release = gatedAdmission(bridge)
    const event = notification(sid, generation)
    await server.scheduleProcessNotification(event)
    await flush()
    const state = server.sessionMap.get(sid)
    // Stop released the session; the user's next turn has claimed it with its own run marker.
    state.isWorking = true
    state.activeRunMarker = 'cli_run_replacement'
    release()
    await flush()
    expect(handleRun).not.toHaveBeenCalled()
    expect(disposition(event)).toBe('owner_stopped')
    expect(state.isWorking).toBe(true)
    expect(state.activeRunMarker).toBe('cli_run_replacement')
  })

  it('positive control: the admitted run carries the marker it owns into the run', async () => {
    const { server, handleRun } = makeServer()
    const { sid, generation } = ownedSession()
    await server.scheduleProcessNotification(notification(sid, generation))
    await flush()
    expect(handleRun).toHaveBeenCalledTimes(1)
    const data = handleRun.mock.calls[0][1] as any
    const state = server.sessionMap.get(sid)
    expect(typeof data.run_marker).toBe('string')
    expect(state.activeRunMarker).toBe(data.run_marker)
    expect(data.machine_fence()).toBeNull()
    state.activeRunMarker = 'cli_run_replacement'
    expect(data.machine_fence()).toBe('owner_stopped')
  })
})

describe('R3 queued machine events are settled when the queue is cleared', () => {
  it('Stop while the owner is busy settles the claim and records cancellation, with no later wake', async () => {
    const { server, nsp, bridge, handleRun } = makeServer()
    const { sid, generation } = ownedSession()
    await server.sessionStateForBackground(sid)
    server.sessionMap.get(sid).isWorking = true
    const event = notification(sid, generation)
    await server.scheduleProcessNotification(event)
    expect(server.sessionMap.get(sid).queue).toHaveLength(1)
    const socket: any = { id: 'stopper', connected: true, emit: vi.fn(), to: vi.fn(() => ({ emit: vi.fn() })), data: {} }
    await handleAbort(nsp, socket, sid, server.sessionMap, bridge, server.runQueuedItem.bind(server))
    await flush()
    expect(server.sessionMap.get(sid).queue).toHaveLength(0)
    expect(disposition(event)).toBe('cancelled')
    expect(settled(bridge, event)).toBe(true)
    expect(handleRun).not.toHaveBeenCalled()
  })

  it('explicit cancel of the queued machine run settles it; other queued items are untouched', async () => {
    const { server, bridge, handleRun } = makeServer()
    const { sid, generation } = ownedSession()
    await server.sessionStateForBackground(sid)
    const state = server.sessionMap.get(sid)
    state.isWorking = true
    const event = notification(sid, generation)
    await server.scheduleProcessNotification(event)
    state.queue.push({ queue_id: 'user-q', input: 'later question', profile: 'default', source: 'cli' })
    const handlers = new Map<string, Function>()
    const socket: any = { id: 'canceller', connected: true, handshake: { auth: {}, query: { profile: 'default' } }, data: {},
      emit: vi.fn(), join: vi.fn(), to: vi.fn(() => ({ emit: vi.fn() })), on: vi.fn((name: string, fn: Function) => handlers.set(name, fn)) }
    server.onConnection(socket)
    const machineQueueId = state.queue.find((item: any) => item.machineEvent).queue_id
    handlers.get('cancel_queued_run')!({ session_id: sid, queue_id: machineQueueId })
    await flush()
    expect(state.queue.map((item: any) => item.queue_id)).toEqual(['user-q'])
    expect(disposition(event)).toBe('cancelled')
    expect(settled(bridge, event)).toBe(true)
    expect(handleRun).not.toHaveBeenCalled()
  })

  it('/destroy settles a queued machine event', async () => {
    const { server, nsp, bridge, handleRun } = makeServer()
    const { sid, generation } = ownedSession()
    await server.sessionStateForBackground(sid)
    const state = server.sessionMap.get(sid)
    state.isWorking = true
    const event = notification(sid, generation)
    await server.scheduleProcessNotification(event)
    expect(state.queue).toHaveLength(1)
    const socket: any = { id: 'destroyer', connected: true, data: {}, emit: vi.fn(), join: vi.fn(), to: vi.fn(() => ({ emit: vi.fn() })) }
    const commandBridge = { ...bridge, interrupt: vi.fn(async () => ({ ok: true })), destroy: vi.fn(async () => ({ ok: true })) }
    await handleSessionCommand(sid, parseSessionCommand('/destroy')!, { nsp, socket, sessionMap: server.sessionMap,
      bridge: commandBridge as any, profile: 'default', runQueuedItem: vi.fn() })
    await flush()
    expect(state.queue).toHaveLength(0)
    expect(disposition(event)).toBe('cancelled')
    expect(settled(bridge, event)).toBe(true)
    expect(handleRun).not.toHaveBeenCalled()
  })

  it('clearing session history settles a queued machine event', async () => {
    const { server, bridge, handleRun } = makeServer()
    const { sid, generation } = ownedSession()
    await server.sessionStateForBackground(sid)
    server.sessionMap.get(sid).isWorking = true
    const event = notification(sid, generation)
    await server.scheduleProcessNotification(event)
    server.sessionMap.get(sid).isWorking = false
    server.clearSessionHistory(sid)
    await flush()
    expect(disposition(event)).toBe('cancelled')
    expect(settled(bridge, event)).toBe(true)
    expect(handleRun).not.toHaveBeenCalled()
  })
})

// repair-release@3 M2/M3: real Stop and real socket-run preparation, gated at the production
// readiness await (before the replacement run assigns its marker); real handleRun, no mocked run seam.
// Synthetic profile configuration in a disposable directory: the real run path reads profile config,
// and the live user profile must never be read by tests.
async function syntheticProfileConfig() {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { configureProfileConfig } = await import('../../packages/server/src/modules/studio/public/profile-config')
  const home = mkdtempSync(join(tmpdir(), 'machine-lifecycle-profiles-'))
  configureProfileConfig({
    buildModelGroups: () => ({ default: '', groups: [] } as any), getProfilesBaseDir: () => home,
    getProfileDir: (profile: string) => join(home, profile), getActiveProfileName: () => 'default', listProfileNames: () => ['default'],
    providerEnvironmentMap: {}, readConfigYaml: async () => ({}), readConfigYamlForProfile: async () => ({}), safeReadFile: async () => null,
    saveEnvValue: async () => {}, saveEnvValueForProfile: async () => {}, updateConfigYaml: async () => undefined, updateConfigYamlForProfile: async () => undefined,
  })
}
function gatedReadiness() {
  const calls: Array<(value: any) => void> = []
  const ensureReady = vi.fn(() => new Promise(resolve => { calls.push(resolve) }))
  vi.spyOn(chatRuntime, 'getPrimaryAgentBridgeManager').mockReturnValue({ start: vi.fn(async () => {}), ensureReady } as any)
  vi.spyOn(chatRuntime, 'redactPrimaryAgentBridgeError').mockImplementation((message: string) => message)
  return { ensureReady, resolve: (index: number, value: any) => calls[index](value), pending: () => calls.length }
}
function userSocket(server: any) {
  const handlers = new Map<string, Function>()
  const emitted: any[] = []
  const socket: any = { id: `user-${counter += 1}`, connected: true, handshake: { auth: {}, query: { profile: 'default' } }, data: {},
    rooms: new Set(), emit: vi.fn((event: string, payload: any) => { emitted.push({ event, payload }) }), join: vi.fn(),
    to: vi.fn(() => ({ emit: vi.fn() })), use: vi.fn(), on: vi.fn((name: string, fn: Function) => handlers.set(name, fn)) }
  server.onConnection(socket)
  return { socket, handlers, emitted }
}
const machineRuns = (handleRun: any) => handleRun.mock.calls.filter(([, data]: any[]) => typeof data?.machine_fence === 'function')

describe('M2 Stop revokes machine ownership permanently', () => {
  it('Stop with no active native run, then a real intentional turn preparing before its marker: the old machine run never runs', async () => {
    await syntheticProfileConfig()
    const { server, nsp, bridge, handleRun } = makeServer({ realHandleRun: true })
    const readiness = gatedReadiness()
    const { sid, generation } = ownedSession()
    let releaseAdmit!: () => void
    bridge.processNotification.mockImplementation(async (action: string) => {
      if (action === 'admit') { await new Promise<void>(resolve => { releaseAdmit = resolve }); return { admitted: true } }
      return { ok: true }
    })
    const event = notification(sid, generation)
    await server.scheduleProcessNotification(event)
    await flush()
    const state = server.sessionMap.get(sid)
    const machineMarker = state.activeRunMarker
    expect(typeof machineMarker).toBe('string')

    // Real Stop: no native run exists yet (no runId/abortController), so the no-active-run branch runs.
    const stopper: any = { id: 'stopper', connected: true, emit: vi.fn(), to: vi.fn(() => ({ emit: vi.fn() })), data: {} }
    await handleAbort(nsp, stopper, sid, server.sessionMap, bridge, server.runQueuedItem.bind(server))
    expect(state.isWorking).toBe(false)

    // Real intentional turn through the production socket handler: it claims isWorking, clears the
    // stop flag and waits at the readiness await, before any new marker exists.
    const user = userSocket(server)
    void user.handlers.get('run')!({ session_id: sid, input: 'my next question', profile: 'default' })
    await vi.waitFor(() => expect(readiness.pending()).toBe(1))
    expect(state.isWorking).toBe(true)
    expect(state.backgroundWakeStopped).toBe(false)

    releaseAdmit()
    await flush()
    expect(machineRuns(handleRun)).toHaveLength(0)
    expect(disposition(event)).toBe('owner_stopped')
    // The replacement's preparation is untouched by the cancelled machine run.
    expect(state.isWorking).toBe(true)
    expect(state.backgroundWakeStopped).toBe(false)
    readiness.resolve(0, { reachable: false, status: 'stopped', error: 'synthetic stop of the test turn' })
    await flush()
  })

  it('positive control: without Stop the admitted machine run reaches its run preparation once', async () => {
    await syntheticProfileConfig()
    const { server, handleRun } = makeServer({ realHandleRun: true })
    const readiness = gatedReadiness()
    const { sid, generation } = ownedSession()
    await server.scheduleProcessNotification(notification(sid, generation))
    await vi.waitFor(() => expect(machineRuns(handleRun)).toHaveLength(1))
    expect(readiness.pending()).toBe(1)
    readiness.resolve(0, { reachable: false, status: 'stopped', error: 'synthetic' })
    await flush()
  })
})

describe('M3 a known readiness refusal settles the admitted machine run', () => {
  it('releases only the state it still owns, settles the record, and the next real turn runs', async () => {
    await syntheticProfileConfig()
    const { server, bridge, handleRun } = makeServer({ realHandleRun: true })
    const readiness = gatedReadiness()
    const { sid, generation } = ownedSession()
    const event = notification(sid, generation)
    await server.scheduleProcessNotification(event)
    await vi.waitFor(() => expect(readiness.pending()).toBe(1))
    const state = server.sessionMap.get(sid)
    readiness.resolve(0, { reachable: false, status: 'stopped', error: 'synthetic bridge down' })
    await flush()
    expect(state.isWorking).toBe(false)
    expect(state.activeRunMarker).toBeUndefined()
    expect(['admitting', 'admitted']).not.toContain(disposition(event))
    expect(disposition(event)).toBe('bridge_unavailable')
    expect(bridge.processNotification.mock.calls.some(([action, ref]: any[]) => action === 'complete' && ref.producer_key === event.producer_key)).toBe(true)
    expect(machineRuns(handleRun)).toHaveLength(1)

    // Readiness restored: the user's next turn is dispatched, not queued behind a stranded run.
    const user = userSocket(server)
    void user.handlers.get('run')!({ session_id: sid, input: 'after the bridge recovered', profile: 'default' })
    await vi.waitFor(() => expect(readiness.pending()).toBe(2))
    expect(state.queue).toHaveLength(0)
    expect(user.emitted.some(entry => entry.event === 'run.queued')).toBe(false)
    readiness.resolve(1, { reachable: false, status: 'stopped', error: 'synthetic end of test turn' })
    await flush()
  })

  it('negative control: a replacement that claimed the session while readiness was pending is left intact', async () => {
    await syntheticProfileConfig()
    const { server, handleRun } = makeServer({ realHandleRun: true })
    const readiness = gatedReadiness()
    const { sid, generation } = ownedSession()
    const event = notification(sid, generation)
    await server.scheduleProcessNotification(event)
    await vi.waitFor(() => expect(readiness.pending()).toBe(1))
    const state = server.sessionMap.get(sid)
    state.activeRunMarker = 'cli_run_replacement'
    state.isWorking = true
    readiness.resolve(0, { reachable: false, status: 'stopped', error: 'synthetic bridge down' })
    await flush()
    expect(state.isWorking).toBe(true)
    expect(state.activeRunMarker).toBe('cli_run_replacement')
    expect(['admitting', 'admitted']).not.toContain(disposition(event))
    expect(machineRuns(handleRun)).toHaveLength(1)
  })
})
