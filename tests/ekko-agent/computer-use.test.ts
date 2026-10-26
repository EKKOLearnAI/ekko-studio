import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const loadSdk = vi.hoisted(() => vi.fn())
vi.mock('../../packages/ekko-agent/src/tools/computer-use/sdk', () => ({ loadComputerUseSdk: loadSdk }))

import { ComputerUseTool } from '../../packages/ekko-agent/src/tools/computer-use'
import { FakeCuaSdkDriver } from '../fixtures/fake-cua-sdk'
import { AgentRuntime, AgentToolRegistry, createDefaultToolRegistry, EkkoToolApprovalService, setupEkkoAgent, type AgentToolContext, type ModelClient } from '../../packages/ekko-agent/src'

let directory: string
const scopes: AbortController[] = []
const tools: ComputerUseTool[] = []
const drivers: FakeCuaSdkDriver[] = []
const createConfigured = vi.fn((_options: unknown) => {
  const driver = new FakeCuaSdkDriver(drivers.length + 1)
  drivers.push(driver)
  return driver
})
const sdk = { CuaDriver: { createConfigured }, SessionPermissionMode: { Standard: 0 } }
function fixture(timeoutMs = 3000) {
  const scope = new AbortController()
  scopes.push(scope)
  const context: AgentToolContext = { computerUseSessionSignal: scope.signal, workspaceRoot: directory, runId: `run-${scopes.length}`, sessionId: `session-${scopes.length}` }
  const tool = new ComputerUseTool({ timeoutMs })
  tools.push(tool)
  const describeTool = (name: string) => tool.execute({ action: 'describe', tool: name }, context)
  const call = (name: string, args = {}) => tool.execute({ action: 'call', tool: name, arguments: args }, context)
  return { tool, context, scope, describeTool, call }
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ekko-cua-test-'))
  drivers.length = 0
  createConfigured.mockClear()
  loadSdk.mockReset().mockResolvedValue(sdk)
})
afterEach(async () => {
  await Promise.all(tools.splice(0).map((tool, i) => tool.execute({ action: 'close' }, { computerUseSessionSignal: scopes[i].signal })))
  for (const scope of scopes.splice(0)) scope.abort()
  vi.unstubAllEnvs()
  await rm(directory, { recursive: true, force: true })
})

describe('Ekko Computer Use', () => {
  it('discovers native SDK operations lazily and keeps one embedded runtime per run', async () => {
    const { tool, context, describeTool, call } = fixture()
    expect(drivers).toHaveLength(0)
    const list = await tool.execute({ action: 'list' }, context)
    expect(list.ok).toBe(true)
    expect(list.content).toContain('type_text')
    expect(list.content).not.toContain('set_config')
    expect(list.content).not.toContain('kill_app')
    await describeTool('list_apps')
    const first = await call('list_apps')
    const second = await call('list_apps')
    expect((first.data as any).result.driverId).toBe((second.data as any).result.driverId)
    expect(drivers).toHaveLength(1)
    expect(loadSdk).toHaveBeenCalledTimes(1)
  })

  it('keeps snapshot ownership stable without a run ID and renews it after explicit close', async () => {
    const { tool, context, describeTool, call } = fixture()
    delete context.runId
    await describeTool('get_window_state')
    const first = (await call('get_window_state', { pid: 1, window_id: 2 })).data as any
    await describeTool('click')
    const click = await call('click', { pid: 1, window_id: 2, element_token: first.result.elements[0].element_token })
    expect(click.ok).toBe(true)
    expect((click.data as any).result.args.session).toBe(first.result.args.session)
    await tool.execute({ action: 'close' }, context)
    await describeTool('get_window_state')
    const next = (await call('get_window_state', { pid: 1, window_id: 2 })).data as any
    expect(next.result.args.session).not.toBe(first.result.args.session)
    expect(drivers).toHaveLength(2)
    expect(drivers[0].destroyed).toBe(true)
  })

  it('returns a real image part, a shareable local file and snapshot-bound handles without logging image data', async () => {
    const { describeTool, call } = fixture()
    await describeTool('get_window_state')
    const capture = await call('get_window_state', { pid: 1, window_id: 2 })
    expect(capture.ok).toBe(true)
    expect(capture.contentParts?.some(part => part.type === 'image')).toBe(true)
    const { screenshots, result } = capture.data as any
    expect(await readFile(screenshots[0])).toEqual(Buffer.from((capture.contentParts!.find(part => part.type === 'image') as any).data, 'base64'))
    expect(result.args).toMatchObject({ max_elements: 300, session: expect.stringMatching(/^ekko-/) })
    expect(JSON.stringify(capture.data)).not.toContain('iVBOR')
    await describeTool('click')
    expect((await call('click', { pid: 1, window_id: 2, element_token: result.elements[0].element_token })).ok).toBe(true)
    await call('get_window_state', { pid: 1, window_id: 2 })
    expect(await call('click', { pid: 1, window_id: 2, element_token: result.elements[0].element_token })).toMatchObject({ ok: false, error: expect.stringContaining('stale') })
  })

  it('requires discovery, denies session takeover and keeps permission checks read-only', async () => {
    const { describeTool, call } = fixture()
    expect((await call('click')).error).toContain('Describe click')
    expect((await describeTool('set_config')).error).toContain('Unsupported')
    await describeTool('get_window_state')
    expect((await call('get_window_state', { session: 'another-user' })).ok).toBe(false)
    expect((await call('get_window_state', { screenshot_out_file: '/arbitrary/file' })).ok).toBe(false)
    await describeTool('check_permissions')
    const check = await call('check_permissions', { prompt: true, probe_direct_capture: true })
    expect((check.data as any).result.args).toMatchObject({ prompt: false, probe_direct_capture: false })
  })

  it('describes only caller-owned arguments while retaining native session injection', async () => {
    const { describeTool, call } = fixture()
    const described = JSON.parse((await describeTool('get_window_state')).content)
    expect(described.inputSchema.required).toEqual(['pid', 'window_id'])
    expect(described.inputSchema.properties).toMatchObject({ pid: { type: 'integer' }, window_id: { type: 'integer' } })
    for (const field of ['session', 'screenshot_out_file', 'debug_image_out', '_internal']) {
      expect(described.inputSchema.properties).not.toHaveProperty(field)
      expect((await call('get_window_state', { pid: 123, window_id: 456, [field]: 'caller-owned' })).ok).toBe(false)
    }
    expect(drivers[0].calls).toHaveLength(0)
    expect((await call('get_window_state', { pid: 123, window_id: 456 })).ok).toBe(true)
    expect(drivers[0].calls[0].args.session).toMatch(/^ekko-/)
    const permissions = JSON.parse((await describeTool('check_permissions')).content)
    expect(permissions.inputSchema.properties).not.toHaveProperty('prompt')
    expect(permissions.inputSchema.properties).not.toHaveProperty('probe_direct_capture')
  })

  it('delivers window identities, capture geometry and input verification to the next model request', async () => {
    const tool = new ComputerUseTool()
    const registry = new AgentToolRegistry()
    registry.register(tool)
    let turn = 0
    let target: { pid: number; window_id: number }
    const client: ModelClient = {
      provider: 'test', requestStyle: 'custom-runtime',
      capabilities: { streaming: false, tools: true, vision: true, jsonMode: false, systemPrompt: true },
      stream: vi.fn(),
      create: async request => {
        turn++
        const call = (args: Record<string, unknown>) => ({ content: '', toolCalls: [{ id: `step-${turn}`, name: 'computer_use', arguments: args }] })
        if (turn === 1) return call({ action: 'describe', tool: 'list_windows' })
        if (turn === 2) return call({ action: 'call', tool: 'list_windows', arguments: {} })
        if (turn === 3) {
          const message = request.messages.find(message => message.toolCallId === 'step-2')!
          expect(message.content).toContain('Found 1 window(s).')
          const window = JSON.parse(message.content.split('\n')[0]).windows[0]
          expect(window).toMatchObject({ pid: 123, window_id: 456, title: 'Fixture window' })
          target = { pid: window.pid, window_id: window.window_id }
          return call({ action: 'describe', tool: 'get_window_state' })
        }
        if (turn === 4) return call({ action: 'call', tool: 'get_window_state', arguments: target })
        if (turn === 5) {
          const message = request.messages.find(message => message.toolCallId === 'step-4')!
          const payload = JSON.parse(message.content.split('\n')[0])
          expect(payload).toMatchObject({ snapshot_id: 's1', screenshot_scale: 0.5, window_bounds: { width: 1600 } })
          expect(message.contentParts).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: 'text', text: expect.stringContaining('"screenshot_scale":0.5') }),
            expect.objectContaining({ type: 'image', mimeType: 'image/png' }),
          ]))
          return call({ action: 'describe', tool: 'type_text' })
        }
        if (turn === 6) return call({ action: 'call', tool: 'type_text', arguments: { ...target, text: 'Draft only' } })
        const message = request.messages.find(message => message.toolCallId === 'step-6')!
        expect(JSON.parse(message.content.split('\n')[0])).toMatchObject({
          effect: 'unverifiable', route: 'synthetic_events', delivery: { mode: 'background' },
          escalation: { target: 'foreground', reason: 'effect_unconfirmed' },
        })
        return { content: 'Input still needs verification.' }
      },
    }
    const result = await new AgentRuntime({ modelClient: client, tools: registry }).run({
      messages: ['Enter a draft in the fixture window.'], toolContext: { workspaceRoot: directory }, skillReviewEnabled: false,
    })
    expect(result.output.content).toBe('Input still needs verification.')
    expect(turn).toBe(7)
    expect(drivers[0].calls.map(call => call.name)).toEqual(['list_windows', 'get_window_state', 'type_text'])
    expect(drivers[0].closed).toBe(true)
  })

  it('uses the accessibility tree for text-only models', async () => {
    const { context, describeTool, call } = fixture()
    context.modelCapabilities = { vision: false } as any
    await describeTool('get_window_state')
    const capture = await call('get_window_state', { pid: 1, window_id: 2 })
    expect((capture.data as any).result.args.include_screenshot).toBe(false)
    expect(capture.contentParts).toBeUndefined()
    await describeTool('get_desktop_state')
    expect((await call('get_desktop_state')).error).toContain('VISION_UNSUPPORTED')
  })

  it('prevents competing desktop controllers and frees the lease when a run closes', async () => {
    const first = fixture(), second = fixture()
    await first.describeTool('list_windows')
    await second.describeTool('list_windows')
    expect((await first.call('list_windows')).ok).toBe(true)
    expect((await second.call('list_windows')).error).toContain('COMPUTER_USE_BUSY')
    await first.tool.execute({ action: 'close' }, first.context)
    expect((await second.call('list_windows')).ok).toBe(true)
  })

  it('cancels native work, releases its handle and refuses reusing the scope', async () => {
    const { describeTool, call, scope } = fixture()
    await describeTool('type_text')
    const pending = call('type_text', { text: '__hang__', pid: 1, window_id: 2 })
    await vi.waitFor(() => expect(drivers[0].calls).toHaveLength(1))
    scope.abort()
    expect((await pending).ok).toBe(false)
    expect(drivers[0].calls[0].signal.aborted).toBe(true)
    expect(drivers[0]).toMatchObject({ closed: true, destroyed: true })
    expect((await call('type_text')).ok).toBe(false)
  })

  it('never retries an input that times out', async () => {
    const { tool, context } = fixture(20)
    expect((await tool.execute({ action: 'describe', tool: 'type_text' }, context)).ok).toBe(true)
    const failed = await tool.execute({ action: 'call', tool: 'type_text', arguments: { text: '__hang__', pid: 1, window_id: 2 } }, context)
    expect(failed.error).toContain('outcome is unknown')
    const repeat = await tool.execute({ action: 'call', tool: 'type_text', arguments: { text: '__hang__', pid: 1, window_id: 2 } }, context)
    expect(repeat.error).toContain('connection has ended')
    expect(drivers).toHaveLength(1)
    expect(drivers[0].calls).toHaveLength(1)
    expect(drivers[0].calls[0].signal.aborted).toBe(true)
    expect(drivers[0]).toMatchObject({ closed: true, destroyed: true })
  })

  it('requires a run scope and blocks delegated control without loading native code', async () => {
    const { tool, context } = fixture()
    expect((await tool.execute({ action: 'list' })).error).toContain('run-scoped')
    expect((await tool.execute({ action: 'list' }, { ...context, delegationDepth: 1 })).error).toContain('main agent')
    expect(loadSdk).not.toHaveBeenCalled()
  })

  it('sets a standard authorization ceiling without inheriting daemon or bypass settings', async () => {
    vi.stubEnv('CUA_DRIVER_PERMISSION_MODE', 'unrestricted')
    vi.stubEnv('CUA_DRIVER_RS_SOCKET', '/other/daemon')
    const { tool } = fixture()
    const status = await tool.execute({ action: 'status' })
    expect(status).toMatchObject({ ok: true, data: { mode: 'embedded', backend: '@trycua/cua-driver' } })
    expect(createConfigured).toHaveBeenCalledWith({
      claudeCodeCompatibility: false,
      authorization: { allowedModes: [0], compatibilityMode: 0, unrestrictedAcknowledged: false, maxSessionTtlSeconds: 86_400n, maxIdleTtlSeconds: 300n },
    })
    expect(drivers[0]).toMatchObject({ closed: true, destroyed: true })
  })

  it('reports unavailable SDK libraries without falling back to a system executable', async () => {
    loadSdk.mockRejectedValue(new Error('CUA_SDK_UNAVAILABLE: missing native library'))
    const { tool } = fixture()
    expect((await tool.execute({ action: 'status' })).error).toContain('CUA_SDK_UNAVAILABLE')
    expect(createConfigured).not.toHaveBeenCalled()
  })

  it('does not create a native runtime if the scope closes during SDK loading', async () => {
    let finish!: (value: typeof sdk) => void
    loadSdk.mockReturnValue(new Promise(resolve => { finish = resolve }))
    const { tool, context, scope } = fixture()
    const pending = tool.execute({ action: 'list' }, context)
    scope.abort()
    finish(sdk)
    expect((await pending).ok).toBe(false)
    expect(createConfigured).not.toHaveBeenCalled()
  })

  it('serializes native calls and cancels queued input before it is dispatched', async () => {
    const { call, describeTool, scope } = fixture()
    await describeTool('type_text')
    const first = call('type_text', { text: '__hang__', pid: 1, window_id: 2 })
    const second = call('type_text', { text: 'must not execute', pid: 1, window_id: 2 })
    await vi.waitFor(() => expect(drivers[0].calls).toHaveLength(1))
    scope.abort()
    expect((await Promise.all([first, second])).every(result => !result.ok)).toBe(true)
    expect(drivers[0].calls).toHaveLength(1)
  })

  it('uses existing approvals and keeps foreground grants separate', async () => {
    const service = new EkkoToolApprovalService({ configPath: join(directory, 'config.json') })
    const registry = createDefaultToolRegistry({ authorizer: service.authorize })
    const call = { action: 'call', tool: 'click', arguments: { pid: 1, window_id: 2, element_token: 's00000001:1' } }
    expect(await registry.execute('computer_use', call, { sessionId: 'test' })).toMatchObject({ ok: false, error: expect.stringContaining('requires approval') })
    expect(drivers).toHaveLength(0)
    const requestToolApproval = vi.fn(async (_request: unknown) => 'session' as const)
    const context = { sessionId: 'test', requestToolApproval }
    await service.authorize('computer_use', call, context)
    await service.authorize('computer_use', call, context)
    await service.authorize('computer_use', { ...call, arguments: { ...call.arguments, delivery_mode: 'foreground' } }, context)
    expect(requestToolApproval).toHaveBeenCalledTimes(2)
    expect(requestToolApproval.mock.calls[0][0].key).toBe('computer_use:click:background')
    expect(requestToolApproval.mock.calls[1][0].key).toBe('computer_use:click:foreground')
  })

  it('persists config, merges partial updates, and removes the tool when disabled', () => {
    const setup = setupEkkoAgent({ baseDirectory: directory })
    try {
      expect(setup.config.read().tools.computerUse).toEqual({ enabled: true, timeoutMs: 30_000 })
      setup.config.update({ tools: { computerUse: { timeoutMs: 20_000 } } })
      setup.config.update({ tools: { computerUse: { enabled: false } } })
      expect(setup.config.read().tools.computerUse).toEqual({ enabled: false, timeoutMs: 20_000 })
      expect(createDefaultToolRegistry({ computerUse: { enabled: false } }).get('computer_use')).toBeUndefined()
      expect(loadSdk).not.toHaveBeenCalled()
    } finally { setup.close() }
  })
})
