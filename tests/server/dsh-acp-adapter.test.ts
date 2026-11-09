import { expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { adaptDshAcpSource } from '../../packages/server/src/modules/coding-agents/services/dsh/acp-adapter'

async function fixture(version: string) { return readFile(new URL(`./fixtures/dsh/acp-${version}.txt`, import.meta.url), 'utf8') }

async function runtime(version: string) {
  const source = adaptDshAcpSource(await fixture(version), version).replace(/^import .*;\n/gm, '')
  let persisted: any
  const live = new Map()
  const header = (id: string) => ({ id, cwd: '/workspace', origin: 'root', agentPreset: persisted?.agentPreset })
  const ctx: any = { llm: {}, get: () => undefined, logger: { warn: vi.fn() },
    agentPresets: { defaultId: 'web-default', mount: vi.fn(async () => {}) },
    sessions: { get: (id: string) => live.get(id), flush: vi.fn(async () => {}) }, agents: {} }
  const agentCtx = { on: vi.fn(), effect: vi.fn() }
  async function handle(options: any, resume: boolean) {
    const h = resume ? { ...persisted } : { ...header(options.sessionId), ...options.meta }
    const session = { id: h.id, header: h, seq: 1, requestHeader: () => undefined }
    const agent = { session, status: 'idle', model: {}, whenIdle: async () => {} }
    await options.setup(agentCtx, agent)
    persisted = h
    return { agent, dispose: () => live.delete(h.id) }
  }
  ctx.agents.create = vi.fn(options => handle(options, false))
  ctx.agents.resume = vi.fn(options => handle(options, true))
  const dependencies: Record<string, any> = {
    ctx, sessions: new Map(), activating: new Set(), persistence: { stat: async () => ({ header: persisted }) },
    initialSelection: () => ({}), assertOpen: () => {}, validateWorkspaceParams: () => {}, brandString: (s: string) => s, randomUUID,
    agentOptions: (config: any) => config, config: {}, notify: () => {}, closed: false,
    sameDirectory: async (a: string, b: string) => a === b,
    invalidParams: (s: string) => new Error(s), internalError: (s: string) => new Error(s),
    internalError$1: (s: string) => new Error(s), invalidParams$1: (s: string) => new Error(s),
    errorChain: String, turnEndToStopReason: () => 'end_turn',
    mountAcpMcpServers: vi.fn(async () => {}), installModelSelection: vi.fn(),
    setSandboxMode: (session: any, value: string) => { session.sandbox = value },
    setApprovalPolicy: (session: any, value: string) => { session.approval = value },
    AcpModelControl: class { install() {} options() { return [] } },
    AcpMcpConfigError: class extends Error {}, AcpModelConfigError: class extends Error {},
  }
  const { AcpSession, implementation } = new Function(...Object.keys(dependencies), source + '\nreturn {AcpSession,implementation}')(...Object.values(dependencies))
  return { ctx, implementation, AcpSession, live, sessions: dependencies.sessions }
}

for (const version of ['0.2.1-rc.5', '0.2.2-rc.1']) {
  it(`${version}: persists explicit presets, restores saved presets after default changes, and enforces permissions`, async () => {
    const { ctx, implementation, sessions } = await runtime(version)
    const created = await implementation.newSession({ cwd: '/workspace', mcpServers: [], _meta: { agentPreset: 'chosen' } })
    expect(ctx.agentPresets.mount).toHaveBeenLastCalledWith(expect.anything(), 'chosen')
    const options = ctx.agents.create.mock.calls[0][0]
    expect(options.meta.agentPreset).toBe('chosen')
    sessions.clear() // A restarted ACP bridge has no live session records.
    ctx.agentPresets.defaultId = 'changed'
    await implementation.resumeSession({ sessionId: created.sessionId, cwd: '/workspace' })
    expect(ctx.agentPresets.mount).toHaveBeenLastCalledWith(expect.anything(), 'chosen')
  })
  it(`${version}: selects the Web default and flushes only after prompt output drains`, async () => {
    const { ctx, AcpSession } = await runtime(version)
    const record = await AcpSession.create(ctx, { sessionId: 's', cwd: '/workspace', agentOptions: {}, mcpServers: [] })
    expect(record.agent.session.header.agentPreset).toBe('web-default')
    expect(record.agent.session).toMatchObject({ sandbox: 'danger-full-access', approval: 'never' })
    let drain!: () => void
    record.outputTail = new Promise<void>(resolve => { drain = resolve })
    const finished = new Promise((resolve, reject) => {
      const inflight = { messageQueued: true, admissionDone: Promise.resolve(), admissionController: new AbortController(),
        cancellationDone: { promise: new Promise(() => {}) }, resolve, reject, endReason: { kind: 'completed' } }
      record.inflight = inflight
      record.settleAfterQuiescence(inflight)
    })
    await Promise.resolve(); await Promise.resolve()
    expect(ctx.sessions.flush).not.toHaveBeenCalled()
    drain(); await finished
    expect(ctx.sessions.flush).toHaveBeenCalledWith(record.agent.session)
  })
  it(`${version}: rejects missing or duplicated critical integration seams`, async () => {
    const source = await fixture(version)
    const point = 'meta: { cwd: options.cwd },'
    expect(() => adaptDshAcpSource(source.replace(point, 'meta: {},'), version)).toThrow(/preset persistence/)
    expect(() => adaptDshAcpSource(source + point, version)).toThrow(/preset persistence/)
  })
}
