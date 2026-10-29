import { afterEach, describe, expect, it, vi } from 'vitest'
import { initAllHermesTables } from '../../packages/server/src/modules/studio/infrastructure/database/schemas'
import { clearSessionMessages, createSession, deleteSession, getSessionGeneration } from '../../packages/server/src/modules/studio/repositories/session-store'
import { getSessionNotification } from '../../packages/server/src/modules/studio/repositories/session-notification-store'
import { handleAbort } from '../../packages/server/src/modules/studio/services/chat-run/abort'
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
