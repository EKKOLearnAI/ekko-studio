import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NativeAcpTurn } from '../../packages/server/src/modules/coding-agents/protocol/acp/turn'
import { DshAcpTurn } from '../../packages/server/src/modules/coding-agents/services/dsh/acp-turn'
import { createModelDiscoveryContext } from '../../packages/server/src/modules/coding-agents/services/models/process'

const { spawn, killTree } = vi.hoisted(() => ({ spawn: vi.fn(), killTree: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn }))
vi.mock('../../packages/server/src/modules/studio/public/process-tree', () => ({ killOwnedProcessTree: killTree }))

const turns: Array<NativeAcpTurn | DshAcpTurn> = []
const invalid = [undefined, '', ' ', '0', '-1', '1.5', 'NaN', 'Infinity', '-Infinity', '240000ms', '2147483648', '1e309', 'true', 'null']
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  spawn.mockReset(); killTree.mockReset()
})
afterEach(() => {
  for (const turn of turns.splice(0)) turn.dispose()
  vi.useRealTimers(); vi.unstubAllEnvs()
})

function childProcess() {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    pid: 424242, exitCode: null, signalCode: null, kill: vi.fn(),
  })
}

function connection(dsh: boolean, hold: string[] = []) {
  const child = childProcess(), sent: any[] = [], held = new Set(hold)
  const result = (method: string) => method === 'initialize'
    ? { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: hold.includes('session/load') ? {} : { resume: {} } } }
    : method.startsWith('session/') && ['session/new', 'session/resume', 'session/load'].includes(method)
      ? { sessionId: 'native', configOptions: hold.includes('session/set_model')
        ? [{ id: 'reasoning_effort', category: 'thought_level' }]
        : [{ id: 'model', category: 'model' }, { id: 'reasoning_effort', category: 'thought_level' }] }
      : method === 'session/prompt' ? { stopReason: 'end_turn' } : {}
  const receive = (message: object) => child.stdout.write(`${JSON.stringify(message)}\n`)
  child.stdin.on('data', chunk => {
    const message = JSON.parse(chunk.toString()); sent.push(message)
    if (message.id === undefined || held.has(message.method)) return
    queueMicrotask(() => receive({ id: message.id, result: result(message.method) }))
  })
  const callbacks = { update: vi.fn(), session: vi.fn(), config: vi.fn() }
  const turn = dsh ? new DshAcpTurn(child as unknown as ChildProcess, callbacks) : new NativeAcpTurn(child as unknown as ChildProcess, callbacks)
  turns.push(turn)
  return { child, sent, turn, receive,
    prompt(nativeSessionId?: string) {
      const input = { cwd: '/workspace', text: 'go', images: [], mcpServers: [], model: 'test', modelValue: 'test', reasoningEffort: 'high', nativeSessionId }
      const promise = turn.prompt(input)
      void promise.catch(() => {})
      return promise
    },
    respond(method: string) {
      const message = sent.find(message => message.method === method)
      expect(message).toBeDefined()
      held.delete(method)
      receive({ id: message.id, result: result(method) })
    },
  }
}

describe.each([
  [false, 'EKKO_STUDIO_ACP_TIMEOUT_MS', 'EKKO_STUDIO_DSH_ACP_TIMEOUT_MS'],
  [true, 'EKKO_STUDIO_DSH_ACP_TIMEOUT_MS', 'EKKO_STUDIO_ACP_TIMEOUT_MS'],
  [false, 'HERMES_ACP_TIMEOUT_MS', 'HERMES_DSH_ACP_TIMEOUT_MS'],
  [true, 'HERMES_DSH_ACP_TIMEOUT_MS', 'HERMES_ACP_TIMEOUT_MS'],
] as const)('ACP request budgets (DSH: %s, variable: %s)', (dsh, variable, other) => {
  const prefix = dsh ? 'DSH ACP' : 'ACP'

  it.each(invalid)('uses the 60-second default for %s, independently of the other ACP budget', async value => {
    vi.stubEnv(variable, value); vi.stubEnv(other, '240000')
    const rpc = connection(dsh, ['initialize']), pending = rpc.prompt()
    const rejected = expect(pending).rejects.toThrow(`${prefix} initialize timed out`)
    await vi.advanceTimersByTimeAsync(59_999)
    expect(rpc.sent).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    await rejected
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([1, 2_147_483_647])('accepts the Node timer boundary %s', async budget => {
    vi.stubEnv(variable, String(budget))
    const rpc = connection(dsh, ['initialize']), pending = rpc.prompt()
    const rejected = expect(pending).rejects.toThrow(`${prefix} initialize timed out`)
    await vi.advanceTimersByTimeAsync(budget - 1)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    await rejected
  })

  it.each(['initialize', 'session/new', 'session/resume', 'session/set_config_option', ...(dsh ? [] : ['session/load', 'session/set_model'])])('allows a healthy %s reply after the old deadline', async method => {
    vi.stubEnv(variable, '240000')
    const rpc = connection(dsh, [method])
    const pending = rpc.prompt(['session/resume', 'session/load'].includes(method) ? 'native' : undefined)
    await vi.advanceTimersByTimeAsync(90_000)
    expect(rpc.sent.at(-1).method).toBe(method)
    expect(vi.getTimerCount()).toBe(1)
    rpc.respond(method)
    await expect(pending).resolves.toBe('end_turn')
    expect(vi.getTimerCount()).toBe(0)
    expect(rpc.child.stdin.writableEnded).toBe(true)
  })

  it('starts a fresh budget for each control request', async () => {
    vi.stubEnv(variable, '240000')
    const rpc = connection(dsh, ['initialize', 'session/new']), pending = rpc.prompt()
    await vi.advanceTimersByTimeAsync(150_000)
    rpc.respond('initialize')
    await vi.advanceTimersByTimeAsync(150_000)
    expect(rpc.sent.at(-1).method).toBe('session/new')
    rpc.respond('session/new')
    await expect(pending).resolves.toBe('end_turn')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('enforces a shorter configured cutoff and ignores a late reply', async () => {
    vi.stubEnv(variable, '1250')
    const rpc = connection(dsh, ['initialize']), pending = rpc.prompt()
    const rejected = expect(pending).rejects.toThrow(`${prefix} initialize timed out`)
    await vi.advanceTimersByTimeAsync(1250)
    await rejected
    rpc.respond('initialize')
    await vi.advanceTimersByTimeAsync(0)
    expect(rpc.sent.map(message => message.method)).toEqual(['initialize'])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('leaves prompt generation unbounded and still allows cancellation', async () => {
    vi.stubEnv(variable, '1')
    const rpc = connection(dsh, ['session/prompt']), pending = rpc.prompt()
    await vi.advanceTimersByTimeAsync(300_000)
    expect(rpc.sent.at(-1).method).toBe('session/prompt')
    expect(vi.getTimerCount()).toBe(0)
    rpc.turn.cancel()
    expect(rpc.sent.at(-1)).toMatchObject({ method: 'session/cancel', params: { sessionId: 'native' } })
    rpc.respond('session/prompt')
    await expect(pending).resolves.toBe('end_turn')
  })

  it.each(['dispose', 'close', 'error', 'write-error'])('clears the configured timer on %s', async event => {
    vi.stubEnv(variable, '240000')
    const rpc = connection(dsh, ['initialize'])
    if (event === 'write-error') vi.spyOn(rpc.child.stdin, 'write').mockImplementation(() => { throw new Error('write failed') })
    const pending = rpc.prompt(), rejected = expect(pending).rejects.toThrow()
    if (event === 'dispose') rpc.turn.dispose()
    else if (event === 'close') rpc.child.emit('close', 1)
    else if (event === 'error') rpc.child.emit('error', new Error('process failed'))
    await rejected
    expect(vi.getTimerCount()).toBe(0)
  })
})

it.each(['EKKO_STUDIO_DSH_ACP_TIMEOUT_MS', 'HERMES_DSH_ACP_TIMEOUT_MS'])('preserves the separate 10-second DSH close deadline with %s', async variable => {
  vi.stubEnv(variable, '240000')
  const rpc = connection(true, ['session/close']), pending = rpc.prompt()
  const rejected = expect(pending).rejects.toThrow('DSH ACP session/close timed out')
  await vi.advanceTimersByTimeAsync(9999)
  expect(rpc.sent.at(-1).method).toBe('session/close')
  expect(vi.getTimerCount()).toBe(1)
  await vi.advanceTimersByTimeAsync(1)
  await rejected
})

function discovery(timeoutMs?: number, env: NodeJS.ProcessEnv = {}) {
  const child = childProcess()
  spawn.mockReturnValue(child)
  const context = createModelDiscoveryContext({ command: { command: 'fixture' }, cwd: '/workspace', home: '/workspace', env,
    host: { commandExecution: (command, args) => ({ command, args }), timeoutMs } })
  return { child, context }
}

describe.each(['EKKO_STUDIO_AGENT_MODEL_DISCOVERY_TIMEOUT_MS', 'HERMES_AGENT_MODEL_DISCOVERY_TIMEOUT_MS'])('model discovery total deadline: %s', variable => {
  it.each(invalid)('uses the 20-second default for %s', async value => {
    vi.stubEnv(variable, value)
    const { child, context } = discovery(), pending = context.run([])
    const rejected = expect(pending).rejects.toMatchObject({ status: 'timeout' })
    await vi.advanceTimersByTimeAsync(19_999)
    expect(killTree).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await rejected
    expect(killTree).toHaveBeenCalledExactlyOnceWith(child.pid, expect.any(Function))
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([1, 2_147_483_647])('accepts the Node timer boundary %s', async budget => {
    vi.stubEnv(variable, String(budget))
    const { context } = discovery(), pending = context.run([])
    const rejected = expect(pending).rejects.toMatchObject({ status: 'timeout' })
    await vi.advanceTimersByTimeAsync(budget - 1)
    expect(killTree).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await rejected
  })

  it('allows a healthy process to finish after 20 seconds and clears its timer', async () => {
    vi.stubEnv(variable, '240000')
    const { child, context } = discovery(), pending = context.run([])
    void pending.catch(() => {})
    await vi.advanceTimersByTimeAsync(30_000)
    expect(killTree).not.toHaveBeenCalled()
    child.stdout.write('models'); child.emit('close', 0)
    await expect(pending).resolves.toEqual({ stdout: 'models', stderr: '' })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps one total deadline across multiple RPC requests', async () => {
    vi.stubEnv(variable, '240000')
    const { child, context } = discovery(), sent: any[] = []
    child.stdin.on('data', chunk => sent.push(JSON.parse(chunk.toString())))
    const pending = context.rpc([], async rpc => { await rpc.request('initialize'); return rpc.request('session/new') })
    const rejected = expect(pending).rejects.toMatchObject({ status: 'timeout' })
    await vi.advanceTimersByTimeAsync(230_000)
    child.stdout.write(`${JSON.stringify({ id: sent[0].id, result: {} })}\n`)
    await vi.advanceTimersByTimeAsync(9999)
    expect(sent.map(message => message.method)).toEqual(['initialize', 'session/new'])
    expect(killTree).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await rejected
    expect(killTree).toHaveBeenCalledOnce()
  })

  it('lets the explicit host deadline take precedence over the environment', async () => {
    vi.stubEnv(variable, '240000')
    vi.stubEnv(variable.startsWith('HERMES_') ? 'EKKO_STUDIO_AGENT_MODEL_DISCOVERY_TIMEOUT_MS' : 'HERMES_AGENT_MODEL_DISCOVERY_TIMEOUT_MS', '360000')
    const { context } = discovery(1250), pending = context.run([])
    const rejected = expect(pending).rejects.toMatchObject({ status: 'timeout' })
    await vi.advanceTimersByTimeAsync(1250)
    await rejected
    expect(killTree).toHaveBeenCalledOnce()
  })
})

const settings = [
  { kind: 'native', variable: 'EKKO_STUDIO_ACP_TIMEOUT_MS', legacy: 'HERMES_ACP_TIMEOUT_MS', fallback: 60_000 },
  { kind: 'dsh', variable: 'EKKO_STUDIO_DSH_ACP_TIMEOUT_MS', legacy: 'HERMES_DSH_ACP_TIMEOUT_MS', fallback: 60_000 },
  { kind: 'models', variable: 'EKKO_STUDIO_AGENT_MODEL_DISCOVERY_TIMEOUT_MS', legacy: 'HERMES_AGENT_MODEL_DISCOVERY_TIMEOUT_MS', fallback: 20_000 },
] as const

describe.each(settings)('$kind naming compatibility', ({ kind, variable, legacy, fallback }) => {
  const cases = [
    { name: 'valid Studio value wins', preferred: '1250', old: '240000', budget: 1250 },
    { name: 'valid Studio value survives invalid legacy', preferred: '1250', old: 'invalid', budget: 1250 },
    ...[' 1250 ', '1.25e3', '0x4e2'].map(value => ({ name: `preserves Number parsing for ${value}`, preferred: value, old: '240000', budget: 1250 })),
    ...invalid.flatMap(value => [
      { name: `invalid Studio ${String(value)} uses valid legacy`, preferred: value, old: '240000', budget: 240000 },
      { name: `invalid Studio and legacy ${String(value)} use default`, preferred: 'invalid', old: value, budget: fallback },
    ]),
  ]

  it.each(cases)('$name', async ({ preferred, old, budget }) => {
    // Unrelated request, discovery and readiness settings cannot supply this budget.
    for (const setting of settings) {
      vi.stubEnv(setting.variable, '1'); vi.stubEnv(setting.legacy, '1')
    }
    vi.stubEnv('HERMES_DSH_READY_TIMEOUT_MS', '1')
    vi.stubEnv(variable, preferred); vi.stubEnv(legacy, old)
    const pending = kind === 'models' ? discovery().context.run([]) : connection(kind === 'dsh', ['initialize']).prompt()
    const rejected = kind === 'models'
      ? expect(pending).rejects.toMatchObject({ status: 'timeout' })
      : expect(pending).rejects.toThrow(`${kind === 'dsh' ? 'DSH ACP' : 'ACP'} initialize timed out`)
    await vi.advanceTimersByTimeAsync(budget - 1)
    expect(vi.getTimerCount()).toBe(1)
    expect(killTree).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await rejected
    expect(vi.getTimerCount()).toBe(0)
    if (kind === 'models') expect(killTree).toHaveBeenCalledOnce()
  })
})

it('reads discovery timers from Studio rather than the agent subprocess environment', async () => {
  vi.stubEnv('EKKO_STUDIO_AGENT_MODEL_DISCOVERY_TIMEOUT_MS', '1250')
  const { context } = discovery(undefined, { EKKO_STUDIO_AGENT_MODEL_DISCOVERY_TIMEOUT_MS: '1', HERMES_AGENT_MODEL_DISCOVERY_TIMEOUT_MS: '1' })
  const pending = context.run([]), rejected = expect(pending).rejects.toMatchObject({ status: 'timeout' })
  await vi.advanceTimersByTimeAsync(1249)
  expect(killTree).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  await rejected
})
