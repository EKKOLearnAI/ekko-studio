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
function makeServer() {
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
  const handleRun = vi.spyOn(server, 'handleRun').mockResolvedValue(undefined)
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
