import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PluginRuntime } from '../../packages/server/src/modules/studio/services/plugins/runtime'
import { PluginStore } from '../../packages/server/src/modules/studio/services/plugins/store'
import type { AgentSession } from '../../packages/plugin-sdk/src'
import type { PluginPermission } from '../../packages/plugin-sdk/src'

const fixture = vi.hoisted(() => ({ home: '', sessions: new Map<string, any>(), rows: [] as any[], agents: new Map<string, any>(), lease: vi.fn(), revoked: vi.fn(), stop: vi.fn(), usage: vi.fn() }))
vi.mock('../../packages/server/src/modules/studio/public/config', () => ({ config: { get appHome() { return fixture.home } } }))
vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({ logger: { info() {}, warn() {}, debug() {} } }))
vi.mock('../../packages/server/src/modules/studio/public/runs/prompt', () => ({ getSystemPrompt: () => 'Studio instructions' }))
vi.mock('../../packages/server/src/modules/studio/public/usage', () => ({ recordSessionUsage: (...args: any[]) => fixture.usage(...args) }))
vi.mock('../../packages/server/src/modules/studio/services/agents/registry', () => ({ pluginAgent: (id: string) => fixture.agents.get(id), scopedAgentModel: (input: any) => fixture.lease(input) }))
vi.mock('../../packages/server/src/modules/studio/services/plugins/host', () => ({ authorizePluginIdentity(identity: any) { if (identity.userId !== 2 || identity.profile !== 'work') throw new Error('Profile access denied') } }))
vi.mock('../../packages/server/src/modules/studio/services/files/session-uploads', () => ({ recordSessionUploadAttachments: async () => {}, isSessionUploadAttachment: async () => false }))
vi.mock('../../packages/server/src/modules/studio/repositories/session-store', () => ({
  getSession: (id: string) => fixture.sessions.get(id),
  getSessionContextMessages: (id: string) => fixture.rows.filter(row => row.session_id === id && ['user', 'assistant', 'tool'].includes(row.role)),
  createSession: (session: any) => { fixture.sessions.set(session.id, session); return session },
  updateSession: (id: string, value: any) => { Object.assign(fixture.sessions.get(id), value) },
  addMessage: (message: any) => { const id = fixture.rows.length + 1; fixture.rows.push({ ...message, id }); return id },
  addMessages: (messages: any[]) => messages.map(message => { const id = fixture.rows.length + 1; fixture.rows.push({ ...message, id }); return id }),
  updateSessionStats() {},
}))
vi.mock('../../packages/server/src/modules/studio/repositories/run-usage-store', () => ({ completeRunUsage: (_session: string, runId: string, assistantMessageId: string) => ({ runId, assistantMessageId, inputTokens: null, outputTokens: null }) }))
vi.mock('../../packages/server/src/modules/studio/services/chat-run/compression', () => ({
  getOrCreateSession: (states: Map<string, any>, id: string) => { if (!states.has(id)) states.set(id, { messages: fixture.rows.filter(row => row.session_id === id).map(row => ({ ...row })), queue: [], events: [], isWorking: false }); return states.get(id) },
  replaceState() {},
}))
vi.mock('../../packages/server/src/modules/studio/public/chat-agent-runtime', () => ({ chatCodingAgentRunManager: { hasSession: () => false, stop: (...args: any[]) => fixture.stop(...args) }, hasChatEkkoBackgroundTasks: () => false, abortChatEkkoBackgroundTasks: async () => {} }))
vi.mock('../../packages/server/src/modules/studio/services/chat-run/usage', () => ({ calcAndUpdateUsage: async () => ({}) }))
vi.mock('../../packages/server/src/modules/studio/services/chat-run/terminal-usage', () => ({ finalizeAbortedRunUsage: () => undefined }))
vi.mock('../../packages/server/src/modules/studio/services/plugins/event-source', () => ({ publishPluginObservation() {} }))
vi.mock('../../packages/server/src/modules/studio/services/chat-run/response-stream', () => ({ flushResponseRunToDb() {} }))
vi.mock('../../packages/server/src/modules/studio/services/chat-run/bridge-message', () => ({ flushBridgePendingToDb() {} }))
vi.mock('../../packages/server/src/modules/studio/services/person/delivery', () => ({ cancelPersonDelivery() {} }))

import { handlePluginAgentRun } from '../../packages/server/src/modules/studio/services/chat-run/handle-plugin-agent-run'
import { handleAbort } from '../../packages/server/src/modules/studio/services/chat-run/abort'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); fixture.sessions.clear(); fixture.rows = []; fixture.agents.clear(); vi.clearAllMocks() })
async function setup(run: AgentSession['run'], permissions: PluginPermission[] = ['agents']) {
  fixture.home = await mkdtemp(join(tmpdir(), 'studio-plugin-agent-run-')); cleanup.push(() => rm(fixture.home, { recursive: true, force: true }))
  const workspace = join(fixture.home, 'workspace'); await mkdir(workspace)
  const owner = new PluginRuntime({ directory: fixture.home, source: fixture.home, enabled: true, config: {}, installedAt: 0, manifest: { id: 'example', name: 'Example', version: '1.0.0', apiVersion: 1, server: 'server.mjs', permissions } },
    { userId: 1, profile: 'installer' }, new PluginStore(fixture.home), { authorize() {}, api: async () => null, emit() {}, log() {} })
  await owner.load({ apply(ctx) { ctx.extensions.agents.register({ id: 'assistant', name: 'Assistant', vendor: 'Example', agentApiVersion: 1,
    getStatus: async () => ({ installed: true, version: '1.0.0' }), management: {},
    modes: { global: { listModels: async () => ({ status: 'ready', source: 'sdk', scope: 'builtin', models: [{ id: 'native', name: 'Native' }] }) }, scoped: { protocols: ['chat_completions'] } },
    features: { surfaces: ['chat', 'group-chat', 'workflow', 'api'], resume: false, streaming: true }, runtime: { createSession: () => ({ run, dispose() {} }) },
  }) } }); owner.activate(); cleanup.push(() => owner.close())
  fixture.agents.set('plugin:example/assistant', owner.agents.get('assistant'))
  fixture.lease.mockImplementation(async () => ({ model: { provider: 'custom:test', model: 'selected', apiMode: 'chat_completions', baseUrl: 'http://studio-proxy/v1', token: 'run-proxy-token', contextWindow: 128000, outputLimit: 8192 }, dispose: fixture.revoked }))
  const events: any[] = [], states = new Map<string, any>(), dequeue = vi.fn(), socket = { data: { user: { id: 2 } }, connected: true, join() {}, emit: (event: string, payload: any) => events.push({ event, ...payload }) } as any
  const nsp = { to: () => ({ emit: (event: string, payload: any) => events.push({ event, ...payload }) }), adapter: { rooms: new Map([['session:session', new Set(['socket'])]]) } } as any
  return { workspace, owner, events, states, socket, nsp, dequeue,
    run: (data: any = {}) => handlePluginAgentRun(nsp, socket, { input: 'hello', session_id: 'session', agent_id: 'plugin:example/assistant', mode: 'global', model: 'native', workspace, ...data }, 'work', states, dequeue) }
}

it('runs a global native model with text, image and file inputs and persists each message once', async () => {
  let received: any
  const f = await setup(async (input, run) => {
    received = { input, mode: run.mode, model: run.model, identity: run.identity }
    for (const part of input.input) if (part.type !== 'text') expect((await run.attachments.read(part.assetId)).byteLength).toBeGreaterThan(0)
    await run.output.emit({ type: 'text.delta', text: 'Native reply' })
    return { content: [{ type: 'text', text: 'Native reply' }], finishReason: 'stop', usage: { inputTokens: 20, outputTokens: 8, isEstimated: false } }
  })
  const image = join(f.workspace, 'image.png'), file = join(f.workspace, 'file.txt')
  await writeFile(image, new Uint8Array([1, 2, 3])); await writeFile(file, 'file text')
  await f.run({ input: [{ type: 'text', text: 'hello' }, { type: 'image', path: image, name: 'image.png', media_type: 'image/png' }, { type: 'file', path: file, name: 'file.txt', media_type: 'text/plain' }] })
  expect(received.input.history).toEqual([]); expect(received.input.input.map((part: any) => part.type)).toEqual(['text', 'image', 'file'])
  expect(received.model).toEqual({ model: 'native', reasoningEffort: undefined }); expect(received.identity.userId).toBe(2)
  expect(fixture.lease).not.toHaveBeenCalled(); expect(fixture.rows.map(message => message.role)).toEqual(['user', 'assistant'])
  expect(f.events.filter(event => event.event === 'run.completed')).toHaveLength(1)
  expect(f.events.find(event => event.event === 'run.completed').output).toBe('Native reply'); expect(f.states.get('session').isWorking).toBe(false)
  expect(fixture.usage).toHaveBeenCalledWith(expect.objectContaining({ agent: 'plugin:example/assistant', usageScope: 'run', usage: { inputTokens: 20, outputTokens: 8, isEstimated: false } }))
})

it('injects only the Studio scoped proxy binding and revokes it after a workflow turn', async () => {
  let binding: any
  const f = await setup(async (_input, run) => { binding = run.model; return { content: [{ type: 'text', text: 'Scoped reply' }], finishReason: 'stop' } })
  await f.run({ mode: 'scoped', model: 'selected', provider: 'custom:test', apiMode: 'chat_completions', source: 'workflow' })
  expect(fixture.lease).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'plugin:example/assistant', provider: 'custom:test', model: 'selected', identity: expect.objectContaining({ userId: 2, surface: 'workflow' }) }))
  expect(binding).toMatchObject({ baseUrl: 'http://studio-proxy/v1', token: 'run-proxy-token' }); expect(binding).not.toHaveProperty('apiKey')
  expect(fixture.revoked).toHaveBeenCalledTimes(1); expect(fixture.sessions.get('session')).toMatchObject({ source: 'workflow', agent_mode: 'scoped', provider: 'custom:test' })
  expect(fixture.usage).not.toHaveBeenCalled()
})

it('binds SDK workspace reads and writes to the current persisted workspace on new and resumed runs', async () => {
  const workspaces: string[] = []
  const f = await setup(async (_input, run) => {
    workspaces.push(run.identity.workspace!)
    expect(run.identity.workspace).toBe(run.paths.workspaceDir)
    await run.workspace.read('proof.txt')
    await run.workspace.write('result.txt', 'done')
    return { content: [{ type: 'text', text: 'Done' }], finishReason: 'stop' }
  }, ['agents', 'api.read', 'api.write'])
  const api = vi.spyOn(f.owner.ports, 'api')
  await f.run()
  const nextWorkspace = join(fixture.home, 'next-workspace')
  await f.run({ workspace: nextWorkspace, input: 'Continue' })
  expect(workspaces).toEqual([f.workspace, nextWorkspace])
  expect(fixture.sessions.get('session').workspace).toBe(nextWorkspace)
  expect(api.mock.calls.map(([identity, path, options]) => ({ workspace: identity.workspace, path, method: options.method || 'GET' }))).toEqual([
    { workspace: f.workspace, path: '/api/studio/sessions/session/workspace-file/read', method: 'GET' },
    { workspace: f.workspace, path: '/api/studio/sessions/session/workspace-file/write', method: 'PUT' },
    { workspace: nextWorkspace, path: '/api/studio/sessions/session/workspace-file/read', method: 'GET' },
    { workspace: nextWorkspace, path: '/api/studio/sessions/session/workspace-file/write', method: 'PUT' },
  ])
  expect(f.events.filter(event => event.event === 'run.failed')).toEqual([])
})

it('stops plugin workflow runs without calling Hermes and saves partial output without duplicate terminals', async () => {
  let ready!: () => void, captured: any
  const started = new Promise<void>(resolve => { ready = resolve })
  const f = await setup(async (_input, run) => {
    captured = run
    await run.output.emit({ type: 'text.delta', text: 'Partial' })
    await run.output.emit({ type: 'tool.started', callId: 'pending', name: 'read', input: { path: 'proof.txt' } })
    ready(); return new Promise(() => {})
  })
  const pending = f.run({ source: 'workflow' }); await started
  const bridge = { interrupt: vi.fn(), goalPause: vi.fn() }
  await handleAbort(f.nsp, f.socket, 'session', f.states, bridge, vi.fn())
  await pending
  expect(bridge.interrupt).not.toHaveBeenCalled(); expect(captured.signal.aborted).toBe(true)
  expect(fixture.rows.filter(message => message.role === 'assistant' && !message.tool_calls)).toMatchObject([{ content: 'Partial', finish_reason: 'interrupted' }])
  expect(fixture.rows.filter(message => message.role === 'tool')).toMatchObject([{ tool_call_id: 'pending', tool_name: 'read', finish_reason: 'error', content: 'Tool execution interrupted' }])
  expect(f.events.filter(event => event.event === 'abort.completed')).toHaveLength(1)
  expect(f.events.filter(event => event.event === 'run.completed' || event.event === 'run.failed')).toHaveLength(0)
  await expect(captured.output.emit({ type: 'text.delta', text: 'late' })).rejects.toThrow()
})

it('rejects attachments outside the workspace and restores the session to idle', async () => {
  const engine = vi.fn(async () => ({ content: [], finishReason: 'stop' as const })), f = await setup(engine)
  const outside = join(fixture.home, 'outside.txt'); await writeFile(outside, 'private')
  await f.run({ input: [{ type: 'file', path: outside, name: 'outside.txt' }] })
  expect(engine).not.toHaveBeenCalled(); expect(f.events.find(event => event.event === 'run.failed').error).toContain('outside')
  expect(f.states.get('session').isWorking).toBe(false)
})

it('rejects a file replaced with a symlink after the run input was authorized', async () => {
  let path = ''
  const f = await setup(async (input, run) => {
    await rm(path)
    await symlink(join(fixture.home, 'private.txt'), path)
    await expect(run.attachments.read((input.input[0] as any).assetId)).rejects.toThrow('changed')
    return { content: [{ type: 'text', text: 'blocked' }], finishReason: 'stop' }
  })
  path = join(f.workspace, 'file.txt')
  await writeFile(path, 'allowed'); await writeFile(join(fixture.home, 'private.txt'), 'private')
  await f.run({ input: [{ type: 'file', path, name: 'file.txt' }] })
  expect(f.events.find(event => event.event === 'run.completed').output).toBe('blocked')
})

it('persists successful and failed tools and restores their results after the session cache is cleared', async () => {
  const engine = vi.fn<AgentSession['run']>().mockImplementationOnce(async (_input, run) => {
    await run.output.emit({ type: 'tool.started', callId: 'read-1', name: 'read', input: { path: 'proof.txt' } })
    await run.output.emit({ type: 'tool.completed', callId: 'read-1', result: { text: 'saved evidence' } })
    await run.output.emit({ type: 'tool.started', callId: 'write-1', name: 'write', input: { path: 'missing/result.txt' } })
    await run.output.emit({ type: 'tool.failed', callId: 'write-1', error: 'Directory missing' })
    return { content: [{ type: 'text', text: 'Read succeeded; write failed' }], finishReason: 'stop' }
  }).mockResolvedValue({ content: [{ type: 'text', text: 'Resumed' }], finishReason: 'stop' })
  const f = await setup(engine)
  await f.run()
  expect(fixture.rows.map(row => row.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'tool', 'assistant'])
  expect(fixture.rows[1].tool_calls).toEqual([{ id: 'read-1', type: 'function', function: { name: 'read', arguments: '{"path":"proof.txt"}' } }])
  expect(fixture.rows[2]).toMatchObject({ tool_call_id: 'read-1', tool_name: 'read', content: '{"text":"saved evidence"}', finish_reason: null })
  expect(fixture.rows[4]).toMatchObject({ tool_call_id: 'write-1', tool_name: 'write', content: 'Directory missing', finish_reason: 'error' })
  expect(new Set(fixture.rows.map(row => row.run_marker)).size).toBe(1)
  expect(f.states.get('session').events).toEqual([])
  f.states.clear()
  await f.run({ input: 'Continue' })
  expect(engine.mock.calls[1][0].history.filter(message => message.role === 'tool')).toEqual([
    { role: 'tool', toolCallId: 'read-1', content: [{ type: 'text', text: '{"text":"saved evidence"}' }] },
    { role: 'tool', toolCallId: 'write-1', content: [{ type: 'text', text: 'Directory missing' }] },
  ])
})

it.each(['throw', 'unfinished'] as const)('retains an interrupted tool when the runtime ends with %s', async ending => {
  const f = await setup(async (_input, run) => {
    await run.output.emit({ type: 'tool.started', callId: 'call-1', name: 'read', input: {} })
    if (ending === 'throw') throw new Error('Engine failed')
    return { content: [], finishReason: 'stop' }
  })
  await f.run()
  expect(f.events.filter(event => event.event === 'run.failed')).toHaveLength(1)
  expect(fixture.rows.filter(row => row.role === 'tool')).toMatchObject([{ tool_call_id: 'call-1', finish_reason: 'error' }])
})

it('restores JSON tool output without interpreting engine image data as a Studio upload', async () => {
  const output = [{ type: 'image', data: 'AQID', mimeType: 'image/png' }]
  const engine = vi.fn<AgentSession['run']>().mockImplementationOnce(async (_input, run) => {
    await run.output.emit({ type: 'tool.started', callId: 'image', name: 'screenshot', input: {} })
    await run.output.emit({ type: 'tool.completed', callId: 'image', result: output })
    return { content: [{ type: 'text', text: 'Done' }], finishReason: 'stop' }
  }).mockResolvedValue({ content: [{ type: 'text', text: 'Resumed' }], finishReason: 'stop' })
  const f = await setup(engine)
  await f.run()
  f.states.clear()
  await f.run({ input: 'Continue' })
  expect(engine).toHaveBeenCalledTimes(2)
  expect(engine.mock.calls[1][0].history.find(message => message.role === 'tool')?.content).toEqual([{ type: 'text', text: JSON.stringify(output) }])
})

it.each([
  { data: {}, expected: 'Internal execution prompt', role: 'user' },
  { data: { display_input: 'User task summary' }, expected: 'User task summary', role: 'user' },
  { data: { display_input: [{ type: 'text', text: 'Corrected task' }] }, expected: '[{"type":"text","text":"Corrected task"}]', role: 'user' },
  { data: { display_input: 'Command', display_role: 'command', storage_message: 'Stored command' }, expected: 'Stored command', role: 'command' },
  { data: { display_input: null, storage_message: 'Hidden continuation' }, expected: null, role: 'user' },
])('honors display and storage overrides: $data', async ({ data, expected, role }) => {
  const engine = vi.fn<AgentSession['run']>().mockResolvedValue({ content: [{ type: 'text', text: 'Done' }], finishReason: 'stop' })
  const f = await setup(engine)
  await f.run({ input: 'Internal execution prompt', ...data })
  expect(engine.mock.calls[0][0].input).toEqual([{ type: 'text', text: 'Internal execution prompt' }])
  const rows = fixture.rows.filter(row => row.role === role)
  expect(rows.map(row => row.content)).toEqual(expected === null ? [] : [expected])
  const created = f.events.filter(event => event.event === 'message.created')
  expect(created.map(event => event.content)).toEqual(expected === null ? [] : [expected])
})
