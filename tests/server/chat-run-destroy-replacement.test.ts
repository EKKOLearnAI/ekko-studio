import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { initAllHermesTables } from '../../packages/server/src/modules/studio/infrastructure/database/schemas'
import { createSession, getSessionGeneration } from '../../packages/server/src/modules/studio/repositories/session-store'
import { getSessionNotification } from '../../packages/server/src/modules/studio/repositories/session-notification-store'
import { studioInstanceId } from '../../packages/server/src/modules/studio/public/session-notifications'
import { configureProfileConfig } from '../../packages/server/src/modules/studio/public/profile-config'
import * as chatRuntime from '../../packages/server/src/modules/studio/public/chat-agent-runtime'
import * as usage from '../../packages/server/src/modules/studio/services/chat-run/usage'
import { ChatRunSocket } from '../../packages/server/src/modules/studio/sockets/chat-run'

// repair-release@4 M2: a late /destroy must not clean up a turn that took the session while
// /destroy was awaiting the bridge or usage. Promoted from the repair-round-3 supplemental
// characterization. Real socket `run` handler (which routes /destroy), real handleSessionCommand,
// handleRun/handleBridgeRun and stores; a scripted fake Agent Bridge; synthetic profile config.

function gate() {
  let open!: () => void
  const promise = new Promise<void>(resolve => { open = resolve })
  return { promise, open }
}

function syntheticProfiles() {
  const home = mkdtempSync(join(tmpdir(), 'destroy-replacement-profiles-'))
  const model = { model: { default: 'fake-model', provider: 'custom', base_url: 'http://127.0.0.1:9/v1', api_key: 'synthetic' }, compression: { enabled: false },
    // Synthetic MoA preset so /moa is configured (no real provider is ever contacted: the bridge is fake).
    moa: { default_preset: 'synthetic', presets: { synthetic: { reference_models: [{ provider: 'custom', model: 'fake-ref' }], aggregator: { provider: 'custom', model: 'fake-agg' } } } } }
  configureProfileConfig({
    buildModelGroups: () => ({ default: 'fake-model', groups: [] } as any), getProfilesBaseDir: () => home,
    getProfileDir: (profile: string) => join(home, profile), getActiveProfileName: () => 'default', listProfileNames: () => ['default'],
    providerEnvironmentMap: {}, readConfigYaml: async () => model, readConfigYamlForProfile: async () => model, safeReadFile: async () => null,
    saveEnvValue: async () => {}, saveEnvValueForProfile: async () => {}, updateConfigYaml: async () => undefined, updateConfigYamlForProfile: async () => undefined,
  })
}

// Every chat starts a run whose stream ends only when the test releases it.
function fakeBridge() {
  const runs = new Map<string, { release: () => void; done: Promise<void> }>()
  const chats: Array<{ input: string; runId: string }> = []
  let seq = 0
  const bridge: any = {
    chats, runs,
    chat: vi.fn(async (_sessionId: string, input: any) => {
      const runId = `run-${seq += 1}`
      const g = gate()
      runs.set(runId, { release: g.open, done: g.promise })
      chats.push({ input: typeof input === 'string' ? input : JSON.stringify(input), runId })
      return { run_id: runId, status: 'started' }
    }),
    // Production signature: streamOutput(runId, options).
    streamOutput: vi.fn(async function* (runId: string) {
      await runs.get(runId)!.done
      yield { run_id: runId, done: true, status: 'completed', output: `completed ${runId}` }
    }),
    contextEstimate: vi.fn(async () => ({ token_count: 10, fixed_context_tokens: 5, message_count: 0, tool_count: 0, system_prompt_chars: 1 })),
    compressionRespond: vi.fn(async () => undefined),
    interrupt: vi.fn(async () => ({ ok: true })),
    destroy: vi.fn(async () => ({ ok: true })),
    statusIfLoaded: vi.fn(async () => ({ ok: true, exists: false, running: false, loaded: false })),
    processNotification: vi.fn(async (action: string) => (action === 'admit' ? { admitted: true } : { ok: true })),
    // /plan expands through the bridge's command endpoint.
    command: vi.fn(async (_sessionId: string, command: string) => (command.startsWith('plan')
      ? { handled: true, type: 'plan', message: `EXPANDED_PLAN_PROMPT for ${command}` }
      : { handled: false })),
    completeBackgroundNotification: vi.fn(async () => ({ ok: true })),
    releaseBackgroundNotification: vi.fn(async () => ({ ok: true })),
  }
  const release = (input: string) => bridge.runs.get(bridge.chats.find((c: any) => c.input === input)!.runId)!.release()
  return { bridge, release }
}

function makeServer(bridge: any, readiness: () => Promise<boolean> = async () => true) {
  const emit = vi.fn()
  const nsp: any = { use: vi.fn(), on: vi.fn(), to: vi.fn(() => ({ emit, except: vi.fn(() => ({ emit })) })),
    in: vi.fn(() => ({ socketsLeave: vi.fn() })), adapter: { rooms: new Map() }, sockets: new Map() }
  vi.spyOn(chatRuntime, 'createPrimaryAgentBridge').mockReturnValue(bridge)
  vi.spyOn(chatRuntime.chatCodingAgentRunManager, 'hasSession').mockReturnValue(false)
  vi.spyOn(chatRuntime, 'hasChatEkkoBackgroundTasks').mockReturnValue(false)
  vi.spyOn(chatRuntime, 'redactPrimaryAgentBridgeError').mockImplementation((message: string) => message)
  const ensureReady = vi.fn(async () => (await readiness())
    ? { reachable: true, status: 'ready' }
    : { reachable: false, status: 'stopped', error: 'synthetic bridge down' })
  vi.spyOn(chatRuntime, 'getPrimaryAgentBridgeManager').mockReturnValue({ start: vi.fn(async () => {}), ensureReady, getRuntimeState: () => ({}) } as any)
  const server: any = new ChatRunSocket({ of: () => nsp } as any)
  clearInterval(server.backgroundPollTimer)
  clearInterval(server.cronObserveTimer)
  server.bridge = bridge
  server.backgroundBridge = bridge
  // Room events of one name.
  const roomEvents = (name: string) => emit.mock.calls.filter(([event]: any[]) => event === name).map(([, payload]: any[]) => payload)
  return { server, ensureReady, roomEvents }
}

function userSocket(server: any) {
  const handlers = new Map<string, Function>()
  const socket: any = { id: `user-${Math.random()}`, connected: true, handshake: { auth: {}, query: { profile: 'default' } }, data: {},
    rooms: new Set(), emit: vi.fn(), join: vi.fn(), to: vi.fn(() => ({ emit: vi.fn() })), use: vi.fn(),
    on: vi.fn((name: string, fn: Function) => handlers.set(name, fn)) }
  server.onConnection(socket)
  const run = (sid: string, input: string) => handlers.get('run')!({ session_id: sid, input, profile: 'default' })
  // The real Stop handler of the same connection.
  run.stop = (sid: string) => handlers.get('abort')!({ session_id: sid })
  return run as typeof run & { stop: (sid: string) => unknown }
}

async function flush(times = 20) { for (let index = 0; index < times; index += 1) await new Promise(resolve => setImmediate(resolve)) }
let counter = 0
function session() {
  initAllHermesTables()
  const sid = `destroy-replacement-${Date.now()}-${counter += 1}`
  createSession({ id: sid, profile: 'default', source: 'cli', agent: 'hermes' })
  return { sid, generation: getSessionGeneration(sid)! }
}
const destroyResults = (roomEvents: (name: string) => any[]) =>
  roomEvents('session.command').filter((payload: any) => payload.action === 'destroy' && typeof payload.message === 'string')
const chatInputs = (bridge: any) => bridge.chats.map((c: any) => c.input)

// After the paused /destroy resumes: the replacement keeps its state and queue, then it and the
// queued turn both complete exactly once, and /destroy reports its result exactly once.
async function expectReplacementSurvives(ctx: {
  server: any; bridge: any; release: (input: string) => void; roomEvents: (name: string) => any[]; sid: string
  destroying: Promise<unknown>; reopen: () => void; earlierChats: string[]
}) {
  const state = ctx.server.sessionMap.get(ctx.sid)
  const replacement = ctx.bridge.chats.find((c: any) => c.input === 'replacement question')!
  const before = { isWorking: state.isWorking, activeRunMarker: state.activeRunMarker, runId: state.runId, queue: state.queue.length }
  expect(before.isWorking).toBe(true)
  expect(typeof before.activeRunMarker).toBe('string')
  expect(before.runId).toBe(replacement.runId)
  expect(before.queue).toBe(1)

  ctx.reopen()
  await ctx.destroying
  await flush()
  expect({ isWorking: state.isWorking, activeRunMarker: state.activeRunMarker, runId: state.runId, queue: state.queue.length }).toEqual(before)
  expect(destroyResults(ctx.roomEvents)).toHaveLength(1)

  ctx.release('replacement question')
  await vi.waitFor(() => expect(chatInputs(ctx.bridge)).toContain('third question'))
  ctx.release('third question')
  await vi.waitFor(() => expect(state.isWorking).toBe(false))
  await flush()
  // No dropped work and no stale model dispatch: exactly these chats, each once.
  expect(chatInputs(ctx.bridge)).toEqual([...ctx.earlierChats, 'replacement question', 'third question'])
  expect(ctx.roomEvents('run.completed').map((payload: any) => payload.run_id).filter((id: string) =>
    [replacement.runId, ctx.bridge.chats.find((c: any) => c.input === 'third question').runId].includes(id))).toHaveLength(2)
  expect(state.queue).toHaveLength(0)
  expect(destroyResults(ctx.roomEvents)).toHaveLength(1)
}

afterEach(() => vi.restoreAllMocks())

describe('M2 late /destroy cleanup keeps a replacement turn and its queued turn', () => {
  for (const phase of ['bridge.destroy', 'usage'] as const) {
    it(`idle session, /destroy paused in ${phase}: the replacement and the queued turn both complete once`, async () => {
      syntheticProfiles()
      const { bridge, release } = fakeBridge()
      const paused = gate()
      let reached = false
      if (phase === 'bridge.destroy') bridge.destroy.mockImplementation(async () => { reached = true; await paused.promise; return { ok: true } })
      const realUsage = usage.calcAndUpdateUsage
      let usageCalls = 0
      if (phase === 'usage') {
        vi.spyOn(usage, 'calcAndUpdateUsage').mockImplementation(async (...args: any[]) => {
          if ((usageCalls += 1) === 1) { reached = true; await paused.promise }
          return (realUsage as any)(...args)
        })
      }
      const { server, roomEvents } = makeServer(bridge)
      const { sid } = session()
      const run = userSocket(server)

      const destroying = run(sid, '/destroy')
      await vi.waitFor(() => expect(reached).toBe(true))
      expect(server.sessionMap.get(sid).isWorking).toBe(false)
      void run(sid, 'replacement question')
      await vi.waitFor(() => expect(chatInputs(bridge)).toContain('replacement question'))
      void run(sid, 'third question')
      await vi.waitFor(() => expect(server.sessionMap.get(sid).queue.length).toBe(1))

      await expectReplacementSurvives({ server, bridge, release, roomEvents, sid, destroying, reopen: paused.open, earlierChats: [] })
    })
  }

  it('working session, /destroy paused in bridge.interrupt; the old run ends and a replacement starts: both later turns complete once', async () => {
    syntheticProfiles()
    const { bridge, release } = fakeBridge()
    const paused = gate()
    let reached = false
    bridge.interrupt.mockImplementation(async () => { reached = true; await paused.promise; return { ok: true } })
    const { server, roomEvents } = makeServer(bridge)
    const { sid } = session()
    const run = userSocket(server)
    const state = () => server.sessionMap.get(sid)

    void run(sid, 'original question')
    await vi.waitFor(() => expect(chatInputs(bridge)).toContain('original question'))
    const destroying = run(sid, '/destroy')
    await vi.waitFor(() => expect(reached).toBe(true))
    // The original run ends on its own while the interrupt RPC is still pending.
    release('original question')
    await vi.waitFor(() => expect(state().isWorking).toBe(false))
    void run(sid, 'replacement question')
    await vi.waitFor(() => expect(chatInputs(bridge)).toContain('replacement question'))
    void run(sid, 'third question')
    await vi.waitFor(() => expect(state().queue.length).toBe(1))

    await expectReplacementSurvives({ server, bridge, release, roomEvents, sid, destroying, reopen: paused.open, earlierChats: ['original question'] })
  })

  it('idle session, /destroy paused while a replacement is still preparing before its marker: no cleanup of the replacement', async () => {
    syntheticProfiles()
    const { bridge, release } = fakeBridge()
    const paused = gate()
    let reached = false
    bridge.destroy.mockImplementation(async () => { reached = true; await paused.promise; return { ok: true } })
    const readinessGate = gate()
    let readinessCalls = 0
    const { server, roomEvents } = makeServer(bridge, async () => {
      if ((readinessCalls += 1) === 1) await readinessGate.promise
      return true
    })
    const { sid } = session()
    const run = userSocket(server)
    const state = () => server.sessionMap.get(sid)

    const destroying = run(sid, '/destroy')
    await vi.waitFor(() => expect(reached).toBe(true))
    void run(sid, 'replacement question')
    // The replacement has claimed the session and waits at readiness: no marker yet.
    await vi.waitFor(() => expect(readinessCalls).toBe(1))
    expect(state().isWorking).toBe(true)
    expect(state().activeRunMarker).toBeUndefined()

    paused.open()
    await destroying
    await flush()
    expect(state().isWorking).toBe(true)
    expect(destroyResults(roomEvents)).toHaveLength(1)

    readinessGate.open()
    await vi.waitFor(() => expect(chatInputs(bridge)).toContain('replacement question'))
    void run(sid, 'third question')
    await vi.waitFor(() => expect(state().queue.length).toBe(1))
    release('replacement question')
    await vi.waitFor(() => expect(chatInputs(bridge)).toContain('third question'))
    release('third question')
    await vi.waitFor(() => expect(state().isWorking).toBe(false))
    await flush()
    expect(chatInputs(bridge)).toEqual(['replacement question', 'third question'])
    expect(state().queue).toHaveLength(0)
    expect(destroyResults(roomEvents)).toHaveLength(1)
  })
})

describe('controls: /destroy without a replacement keeps its full cleanup', () => {
  it('idle session: destroys the bridge agent, reports once, session idle', async () => {
    syntheticProfiles()
    const { bridge } = fakeBridge()
    const { server, roomEvents } = makeServer(bridge)
    const { sid } = session()
    const run = userSocket(server)
    await run(sid, '/destroy')
    await flush()
    const state = server.sessionMap.get(sid)
    expect(bridge.destroy).toHaveBeenCalledTimes(1)
    expect(state.isWorking).toBe(false)
    expect(destroyResults(roomEvents)).toHaveLength(1)
    expect(roomEvents('run.queued').some((payload: any) => payload.queue_length === 0)).toBe(true)
  })

  it('working session: interrupts the run, clears its state and queue, reports once; the stopped run is not revived', async () => {
    syntheticProfiles()
    const { bridge, release } = fakeBridge()
    const { server, roomEvents } = makeServer(bridge)
    const { sid } = session()
    const run = userSocket(server)
    void run(sid, 'original question')
    await vi.waitFor(() => expect(chatInputs(bridge)).toContain('original question'))
    void run(sid, 'queued question')
    const state = server.sessionMap.get(sid)
    await vi.waitFor(() => expect(state.queue.length).toBe(1))
    await run(sid, '/destroy')
    await flush()
    expect(bridge.interrupt).toHaveBeenCalledTimes(1)
    expect(bridge.destroy).toHaveBeenCalledTimes(1)
    expect({ isWorking: state.isWorking, activeRunMarker: state.activeRunMarker, runId: state.runId, queue: state.queue.length })
      .toEqual({ isWorking: false, activeRunMarker: undefined, runId: undefined, queue: 0 })
    expect(destroyResults(roomEvents)).toHaveLength(1)
    release('original question')
    await flush()
    expect(chatInputs(bridge)).toEqual(['original question'])
    expect(state.isWorking).toBe(false)
  })
})

describe('M3 positive: after a readiness refusal settles the machine run, restored readiness runs turns normally', () => {
  it('the next intentional turn reaches bridge.chat and completes, and a queued turn then runs', async () => {
    syntheticProfiles()
    const { bridge, release } = fakeBridge()
    let checks = 0
    const { server, roomEvents } = makeServer(bridge, async () => (checks += 1) > 1)
    const { sid, generation } = session()
    const key = `hermes-process:default:proc_${sid}:1`
    await server.scheduleProcessNotification({ kind: 'process_completion', producer_key: key, claim_id: `claim-${key}`, session_id: sid,
      profile: 'default', process_id: `proc_${sid}`, owner_generation: generation, exit_code: 0, status: 'succeeded',
      message: '[IMPORTANT: Background process completed normally (exit code 0).]' })
    const record = () => getSessionNotification(studioInstanceId(), 'default', key)?.disposition
    await vi.waitFor(() => expect(record()).toBe('bridge_unavailable'))
    const state = server.sessionMap.get(sid)
    expect(state.isWorking).toBe(false)

    const run = userSocket(server)
    void run(sid, 'first after recovery')
    await vi.waitFor(() => expect(chatInputs(bridge)).toContain('first after recovery'))
    void run(sid, 'second after recovery')
    await vi.waitFor(() => expect(state.queue.length).toBe(1))
    expect(roomEvents('run.queued').length).toBeGreaterThan(0)
    release('first after recovery')
    await vi.waitFor(() => expect(chatInputs(bridge)).toContain('second after recovery'))
    release('second after recovery')
    await vi.waitFor(() => expect(state.isWorking).toBe(false))
    await flush()
    expect(chatInputs(bridge)).toEqual(['first after recovery', 'second after recovery'])
    expect(roomEvents('run.completed')).toHaveLength(2)
    expect(state.queue).toHaveLength(0)
    expect(record()).toBe('bridge_unavailable')
  })
})

// repair-release@5 P2: Stop before any native run, then a replacement that is still preparing (no
// marker yet) must not look like the owner an outstanding /destroy captured.
function gatedReadiness() {
  const gates: Array<{ promise: Promise<boolean>; resolve: (ok: boolean) => void }> = []
  // Gates the first two readiness checks (the stopped first owner and the replacement); later turns are ready.
  const readiness = () => {
    if (gates.length >= 2) return Promise.resolve(true)
    let resolve!: (ok: boolean) => void
    const promise = new Promise<boolean>(r => { resolve = r })
    gates.push({ promise, resolve })
    return promise
  }
  return { readiness, gates }
}

describe('P2 /destroy after a pre-native Stop does not clobber a replacement preparing before its marker', () => {
  async function stopThenReplace(kind: 'machine' | 'ordinary') {
    syntheticProfiles()
    const { bridge, release } = fakeBridge()
    const interruptGate = gate()
    let interruptReached = false
    bridge.interrupt.mockImplementation(async () => { interruptReached = true; await interruptGate.promise; return { ok: true } })
    const { readiness, gates } = gatedReadiness()
    const { server, roomEvents } = makeServer(bridge, readiness)
    const { sid, generation } = session()
    const run = userSocket(server)
    const state = () => server.sessionMap.get(sid)

    // 1. The first owner is preparing before native dispatch (waiting at readiness).
    if (kind === 'machine') {
      const key = `hermes-process:default:proc_${sid}:p2`
      await server.scheduleProcessNotification({ kind: 'process_completion', producer_key: key, claim_id: `claim-${key}`, session_id: sid,
        profile: 'default', process_id: `proc_${sid}`, owner_generation: generation, exit_code: 0, status: 'succeeded',
        message: '[IMPORTANT: Background process completed normally (exit code 0).]' })
    } else {
      void run(sid, 'first question')
    }
    await vi.waitFor(() => expect(gates.length).toBe(1))
    expect(state().isWorking).toBe(true)
    if (kind === 'machine') expect(typeof state().activeRunMarker).toBe('string')
    else expect(state().activeRunMarker).toBeUndefined()

    // 2. /destroy captures that owner and waits in the interrupt.
    const destroying = run(sid, '/destroy')
    await vi.waitFor(() => expect(interruptReached).toBe(true))
    // 3. Real Stop: no native run yet, so the no-active-run branch releases the session.
    run.stop(sid)
    await flush()
    expect(state().isWorking).toBe(false)
    // 4. A replacement claims the session and waits at readiness before its own marker; a third turn queues.
    void run(sid, 'replacement question')
    await vi.waitFor(() => expect(gates.length).toBe(2))
    void run(sid, 'third question')
    await vi.waitFor(() => expect(state().queue.length).toBe(1))
    const before = { isWorking: state().isWorking, activeRunMarker: state().activeRunMarker, queue: state().queue.length }
    expect(before.isWorking).toBe(true)

    // 5. /destroy resumes: it lost its owner, so no destructive bridge call and no cleanup.
    interruptGate.open()
    await destroying
    await flush()
    expect(bridge.destroy).not.toHaveBeenCalled()
    expect({ isWorking: state().isWorking, activeRunMarker: state().activeRunMarker, queue: state().queue.length }).toEqual(before)
    expect(destroyResults(roomEvents)).toHaveLength(1)

    // 6. The replacement and the queued turn each run once and complete.
    gates[1].resolve(true)
    await vi.waitFor(() => expect(chatInputs(bridge)).toContain('replacement question'))
    release('replacement question')
    await vi.waitFor(() => expect(chatInputs(bridge)).toContain('third question'))
    release('third question')
    await vi.waitFor(() => expect(state().isWorking).toBe(false))
    // The stopped first owner's preparation finally ends with a refusal and dispatches nothing.
    gates[0].resolve(false)
    await flush()
    expect(chatInputs(bridge)).toEqual(['replacement question', 'third question'])
    expect(state().queue).toHaveLength(0)
    expect(destroyResults(roomEvents)).toHaveLength(1)
  }

  it('machine run preparing (marker assigned) -> /destroy -> Stop -> replacement before marker + queued turn', async () => {
    await stopThenReplace('machine')
  })

  it('ordinary turn preparing (no marker) -> /destroy -> Stop -> replacement before marker + queued turn', async () => {
    await stopThenReplace('ordinary')
  })

  it('control: native run working -> /destroy -> Stop completes the run -> replacement before marker + queued turn', async () => {
    syntheticProfiles()
    const { bridge, release } = fakeBridge()
    const interruptGate = gate()
    let interrupts = 0
    bridge.interrupt.mockImplementation(async () => { if ((interrupts += 1) === 1) await interruptGate.promise; return { ok: true } })
    let checks = 0
    const replacementReady = gate()
    const { server, roomEvents } = makeServer(bridge, async () => { if ((checks += 1) === 2) await replacementReady.promise; return true })
    const { sid } = session()
    const run = userSocket(server)
    const state = () => server.sessionMap.get(sid)
    void run(sid, 'original question')
    await vi.waitFor(() => expect(chatInputs(bridge)).toContain('original question'))
    const destroying = run(sid, '/destroy')
    await vi.waitFor(() => expect(interrupts).toBe(1))
    void run.stop(sid)
    await flush()
    release('original question')
    await vi.waitFor(() => expect(state().isWorking).toBe(false))
    void run(sid, 'replacement question')
    await vi.waitFor(() => expect(checks).toBe(2))
    void run(sid, 'third question')
    await vi.waitFor(() => expect(state().queue.length).toBe(1))
    interruptGate.open()
    await destroying
    await flush()
    expect(bridge.destroy).not.toHaveBeenCalled()
    expect(state().isWorking).toBe(true)
    expect(state().queue.length).toBe(1)
    expect(destroyResults(roomEvents)).toHaveLength(1)
    replacementReady.open()
    await vi.waitFor(() => expect(chatInputs(bridge)).toContain('replacement question'))
    release('replacement question')
    await vi.waitFor(() => expect(chatInputs(bridge)).toContain('third question'))
    release('third question')
    await vi.waitFor(() => expect(state().isWorking).toBe(false))
    await flush()
    expect(chatInputs(bridge)).toEqual(['original question', 'replacement question', 'third question'])
    expect(state().queue).toHaveLength(0)
  })
})

// repair-release@6: expanded commands (/plan, configured /moa) start their turn through a direct
// runQueuedItem hand-off; that acceptance must take ownership like every other accepted run.
describe('repair@6 direct command turns are owners an outstanding /destroy must not clean up', () => {
  const commands = {
    plan: { input: '/plan draft the release', chat: 'EXPANDED_PLAN_PROMPT for plan draft the release' },
    moa: { input: '/moa compare the options', chat: 'compare the options' },
  } as const
  for (const name of ['plan', 'moa'] as const) {
    for (const phase of ['preparing before its marker', 'running with its marker'] as const) {
      it(`/${name} accepted while an idle /destroy waits in bridge.destroy (${phase}): the command turn and a queued turn both complete once`, async () => {
        syntheticProfiles()
        const { bridge, release } = fakeBridge()
        const destroyGate = gate()
        let destroyReached = false
        bridge.destroy.mockImplementation(async () => { destroyReached = true; await destroyGate.promise; return { ok: true } })
        const readinessGate = gate()
        let checks = 0
        const { server, roomEvents } = makeServer(bridge, async () => {
          if ((checks += 1) === 1 && phase === 'preparing before its marker') await readinessGate.promise
          return true
        })
        const { sid } = session()
        const run = userSocket(server)
        const state = () => server.sessionMap.get(sid)
        const command = commands[name]

        const destroying = run(sid, '/destroy')
        await vi.waitFor(() => expect(destroyReached).toBe(true))
        const revisionAtDestroy = state().ownerRevision ?? 0
        void run(sid, command.input)
        if (phase === 'preparing before its marker') {
          await vi.waitFor(() => expect(checks).toBe(1))
          expect(state().activeRunMarker).toBeUndefined()
        } else {
          await vi.waitFor(() => expect(chatInputs(bridge)).toContain(command.chat))
          expect(typeof state().activeRunMarker).toBe('string')
        }
        // The third message: queued behind the accepted command turn (or, if the command turn has not
        // taken the session, started on its own; the final assertions then fail).
        void run(sid, 'third question')
        await vi.waitFor(() => expect(state().queue.length === 1 || chatInputs(bridge).includes('third question')).toBe(true))
        const before = { isWorking: true, activeRunMarker: state().activeRunMarker, runId: state().runId, queue: 1 }
        console.log('REPAIR6_SNAPSHOT', name, phase, JSON.stringify({ isWorking: state().isWorking, revisionAtDestroy, revision: state().ownerRevision, queue: state().queue.length }))

        destroyGate.open()
        await destroying
        await flush()
        // Only the destroy RPC already in flight before the command started; no second destructive call, no cleanup.
        expect(bridge.destroy).toHaveBeenCalledTimes(1)
        expect({ isWorking: state().isWorking, activeRunMarker: state().activeRunMarker, runId: state().runId, queue: state().queue.length }).toEqual(before)
        expect(destroyResults(roomEvents)).toHaveLength(1)

        readinessGate.open()
        await vi.waitFor(() => expect(chatInputs(bridge)).toContain(command.chat))
        release(command.chat)
        await vi.waitFor(() => expect(chatInputs(bridge)).toContain('third question'))
        release('third question')
        await vi.waitFor(() => expect(state().isWorking).toBe(false))
        await flush()
        expect(chatInputs(bridge)).toEqual([command.chat, 'third question'])
        expect(state().queue).toHaveLength(0)
        expect(destroyResults(roomEvents)).toHaveLength(1)
      })
    }
  }

  it('control: a command sent while busy only queues; it neither advances the owner revision nor takes over', async () => {
    syntheticProfiles()
    const { bridge, release } = fakeBridge()
    const { server } = makeServer(bridge)
    const { sid } = session()
    const run = userSocket(server)
    const state = () => server.sessionMap.get(sid)
    void run(sid, 'current question')
    await vi.waitFor(() => expect(chatInputs(bridge)).toContain('current question'))
    const owner = { revision: state().ownerRevision, marker: state().activeRunMarker, runId: state().runId }
    await run(sid, commands.plan.input)
    await flush()
    expect(state().queue).toHaveLength(1)
    expect({ revision: state().ownerRevision, marker: state().activeRunMarker, runId: state().runId }).toEqual(owner)
    release('current question')
    await vi.waitFor(() => expect(chatInputs(bridge)).toContain(commands.plan.chat))
    release(commands.plan.chat)
    await vi.waitFor(() => expect(state().isWorking).toBe(false))
    expect(chatInputs(bridge)).toEqual(['current question', commands.plan.chat])
  })

  it('positives: a normal turn, a machine completion and a background delegation each advance ownership exactly once and run once', async () => {
    syntheticProfiles()
    const { bridge, release } = fakeBridge()
    const { server } = makeServer(bridge)
    const { sid, generation } = session()
    const run = userSocket(server)
    const state = () => server.sessionMap.get(sid)
    const step = async (start: () => unknown, chat: string) => {
      const before = state()?.ownerRevision ?? 0
      void start()
      await vi.waitFor(() => expect(chatInputs(bridge)).toContain(chat))
      // Accepted once; the admission/authorize recursion inside the run does not advance it again.
      expect(state().ownerRevision).toBe(before + 1)
      release(chat)
      await vi.waitFor(() => expect(state().isWorking).toBe(false))
      await flush()
    }
    await step(() => run(sid, 'normal question'), 'normal question')
    const key = `hermes-process:default:proc_${sid}:pos`
    const machineMessage = '[IMPORTANT: Background process completed normally (exit code 0).]'
    await step(() => server.scheduleProcessNotification({ kind: 'process_completion', producer_key: key, claim_id: `claim-${key}`, session_id: sid,
      profile: 'default', process_id: `proc_${sid}`, owner_generation: generation, exit_code: 0, status: 'succeeded', message: machineMessage }), machineMessage)
    // The origin context a delegating turn registers when it hands work to the background.
    state().backgroundContinuationContexts = { 'deleg-1': { runtime: 'hermes', version: 1, delegationId: 'deleg-1', sessionId: sid,
      originRunId: 'origin-run', messages: [], profile: 'default' } }
    await step(() => server.scheduleBackgroundNotification({ session_id: sid, profile: 'default', delegation_id: 'deleg-1', claim_id: 'claim-deleg-1',
      message: '[ASYNC DELEGATION COMPLETE synthetic]', status: 'completed', event: {} }), '[ASYNC DELEGATION COMPLETE synthetic]')
    expect(chatInputs(bridge)).toEqual(['normal question', machineMessage, '[ASYNC DELEGATION COMPLETE synthetic]'])
  })
})
