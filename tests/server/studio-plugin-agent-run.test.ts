import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PluginRuntime } from '../../packages/server/src/modules/studio/services/plugins/runtime'
import { PluginStore } from '../../packages/server/src/modules/studio/services/plugins/store'
import type { AgentSession } from '../../packages/plugin-sdk/src'

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
  createSession: (session: any) => { fixture.sessions.set(session.id, session); return session },
  updateSession: (id: string, value: any) => { Object.assign(fixture.sessions.get(id), value) },
  addMessage: (message: any) => { const id = fixture.rows.length + 1; fixture.rows.push({ ...message, id }); return id },
  addMessages: (messages: any[]) => messages.map(message => { const id = fixture.rows.length + 1; fixture.rows.push({ ...message, id }); return id }),
  updateSessionStats() {},
}))
vi.mock('../../packages/server/src/modules/studio/repositories/run-usage-store', () => ({ completeRunUsage: (_session: string, runId: string, assistantMessageId: string) => ({ runId, assistantMessageId, inputTokens: null, outputTokens: null }) }))
vi.mock('../../packages/server/src/modules/studio/services/chat-run/compression', () => ({
  getOrCreateSession: (states: Map<string, any>, id: string) => { if (!states.has(id)) states.set(id, { messages: [], queue: [], events: [], isWorking: false }); return states.get(id) },
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
async function setup(run: AgentSession['run']) {
  fixture.home = await mkdtemp(join(tmpdir(), 'studio-plugin-agent-run-')); cleanup.push(() => rm(fixture.home, { recursive: true, force: true }))
  const workspace = join(fixture.home, 'workspace'); await mkdir(workspace)
  const owner = new PluginRuntime({ directory: fixture.home, source: fixture.home, enabled: true, config: {}, installedAt: 0, manifest: { id: 'example', name: 'Example', version: '1.0.0', apiVersion: 1, server: 'server.mjs', capabilities: ['agents'] } },
    { userId: 1, profile: 'installer' }, new PluginStore(fixture.home), { authorize() {}, api: async () => null, emit() {}, log() {} })
  await owner.load({ apply(ctx) { ctx.agents.register({ id: 'assistant', name: 'Assistant', vendor: 'Example', agentApiVersion: 1,
    getStatus: async () => ({ installed: true, version: '1.0.0' }), management: {},
    modes: { global: { listModels: async () => ({ status: 'ready', source: 'sdk', scope: 'builtin', models: [{ id: 'native', name: 'Native' }] }) }, scoped: { protocols: ['chat_completions'] } },
    capabilities: { surfaces: ['chat', 'group-chat', 'workflow', 'api'], resume: false, streaming: true }, runtime: { createSession: () => ({ run, dispose() {} }) },
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
    await run.events.emit({ type: 'text.delta', text: 'Native reply' })
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

it('stops plugin workflow runs without calling Hermes and saves partial output without duplicate terminals', async () => {
  let ready!: () => void, captured: any
  const started = new Promise<void>(resolve => { ready = resolve })
  const f = await setup(async (_input, run) => { captured = run; await run.events.emit({ type: 'text.delta', text: 'Partial' }); ready(); return new Promise(() => {}) })
  const pending = f.run({ source: 'workflow' }); await started
  const bridge = { interrupt: vi.fn(), goalPause: vi.fn() }
  await handleAbort(f.nsp, f.socket, 'session', f.states, bridge, vi.fn())
  await pending
  expect(bridge.interrupt).not.toHaveBeenCalled(); expect(captured.signal.aborted).toBe(true)
  expect(fixture.rows.filter(message => message.role === 'assistant')).toMatchObject([{ content: 'Partial', finish_reason: 'interrupted' }])
  expect(f.events.filter(event => event.event === 'abort.completed')).toHaveLength(1)
  expect(f.events.filter(event => event.event === 'run.completed' || event.event === 'run.failed')).toHaveLength(0)
  await expect(captured.events.emit({ type: 'text.delta', text: 'late' })).rejects.toThrow()
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
