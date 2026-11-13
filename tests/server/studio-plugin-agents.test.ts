import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PluginRuntime, type PluginPorts } from '../../packages/server/src/modules/studio/services/plugins/runtime'
import { PluginStore } from '../../packages/server/src/modules/studio/services/plugins/store'
import { PluginManager } from '../../packages/server/src/modules/studio/services/plugins/manager'
import { isPluginAgentId } from '../../packages/server/src/modules/studio/services/plugins/agent-runtime'
import type { AgentDefinition, AgentRunContext, AgentRunInput, PluginContext } from '../../packages/plugin-sdk/src'

const directories: string[] = [], runtimes: PluginRuntime[] = []
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(runtimes.splice(0).map(runtime => runtime.close())); await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))) })
function definition(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return { id: 'assistant', name: 'Assistant', vendor: 'Example', agentApiVersion: 1,
    getStatus: async () => ({ installed: true, version: '1.0.0' }),
    management: { settings: () => ({ viewId: 'settings' }) },
    modes: { global: { listModels: async () => ({ status: 'ready', source: 'sdk', scope: 'available', models: [{ id: 'native', name: 'Native' }] }) }, scoped: { protocols: ['chat_completions'] } },
    features: { surfaces: ['chat', 'group-chat', 'workflow', 'api'], streaming: true, resume: false },
    runtime: { createSession: () => ({ run: async input => ({ content: input.input, finishReason: 'stop' }), dispose() {} }) }, ...overrides }
}
async function owner(apply: (ctx: PluginContext) => void, permissions: string[] = ['agents', 'api.read']) {
  const directory = await mkdtemp(join(tmpdir(), 'studio-agent-runtime-')); directories.push(directory)
  const ports: PluginPorts = { authorize: vi.fn(), api: vi.fn(async identity => ({ userId: identity.userId })), emit() {}, log() {} }
  const runtime = new PluginRuntime({ manifest: { id: 'example', name: 'Example', version: '1.0.0', apiVersion: 1, permissions: permissions as any, server: 'server.mjs',
    views: [{ id: 'settings', title: 'Settings', slot: 'agent-settings', icon: 'settings' }] }, enabled: true, directory, installedAt: 0, source: directory, config: {} },
  { userId: 1, profile: 'installer' }, new PluginStore(directory), ports)
  runtimes.push(runtime)
  await runtime.load({ apply: ctx => { apply(ctx) } }); runtime.activate()
  return { runtime, ports, directory, agent: runtime.agents.get('assistant')! }
}
const input: AgentRunInput = { input: [{ type: 'text', text: 'Hello' }], history: [], instructions: [], options: {} }
function call(agent: Awaited<ReturnType<typeof owner>>['agent'], userId = 2, sessionId = 'session', signal = new AbortController().signal) {
  return { identity: { userId, profile: 'work', sessionId, runId: `run-${userId}` }, mode: 'global' as const,
    paths: { runtimeDir: join(agent.owner.record.directory, 'runtime', String(userId)), workspaceDir: agent.owner.record.directory },
    request: input, model: { model: 'native' }, signal, deadlineAt: Date.now() + 60_000,
    attachments: { resolve: vi.fn(async assetId => ({ assetId, name: 'file', mediaType: 'text/plain', localPath: '/file', size: 1 })), read: vi.fn(async () => new Uint8Array([7])) }, emit: vi.fn(async () => {}) }
}

it('registers namespaced agents and enforces registration permission, schema, and startup rollback', async () => {
  expect(isPluginAgentId('plugin:example/assistant')).toBe(true)
  for (const id of ['codex', 'plugin:../agent', 'plugin:example/constructor', 'plugin:example/a/b']) expect(isPluginAgentId(id)).toBe(false)
  await expect(owner(ctx => { ctx.extensions.agents.register(definition()) }, [])).rejects.toThrow('requires agents')
  await expect(owner(ctx => { ctx.extensions.agents.register(definition({ features: { ...definition().features, images: true } as any })) })).rejects.toThrow('required Agent inputs')
  let runtime: PluginContext | undefined
  await expect(owner(ctx => { runtime = ctx; ctx.extensions.agents.register(definition()); ctx.extensions.agents.register(definition()) })).rejects.toThrow('Duplicate')
  expect(() => runtime!.extensions.agents.register(definition())).toThrow('expired')
  const value = await owner(ctx => { ctx.extensions.agents.register(definition()) })
  expect(value.agent.descriptor()).toMatchObject({ id: 'plugin:example/assistant', vendor: 'Example', modes: ['global', 'scoped'], actions: { settings: true } })
  expect(() => value.runtime.context().extensions.agents.register(definition({ id: 'late' }))).toThrow('during apply')
})

it('opens Agent-only settings pages without registering either global navigation entry', async () => {
  const value = await owner(ctx => { ctx.extensions.agents.register(definition({ management: { settings: () => ({ viewId: 'skills' }) } })) })
  value.runtime.record.manifest.views = [{ id: 'skills', title: 'Skills', slot: 'agent-settings', icon: 'skills' }]
  expect(value.runtime.record.manifest.navigation).toBeUndefined()
  expect(await value.agent.settings({ userId: 2, profile: 'work' })).toEqual({ name: 'studio.pluginAgentSettings', params: { pluginId: 'example', viewId: 'skills' }, query: {} })
})

it('binds concurrent runs and root SDK calls to actual users, isolates state, and expires run services', async () => {
  let root!: PluginContext
  const contexts: AgentRunContext[] = [], factory = vi.fn()
  const value = await owner(ctx => {
    root = ctx
    ctx.extensions.agents.register(definition({ runtime: { createSession: session => {
      factory(session.identity.userId)
      return { async run(_input, run) {
        contexts.push(run)
        await run.state.agentSession!.set('owner', run.identity.userId)
        await new Promise(resolve => setTimeout(resolve, run.identity.userId === 2 ? 15 : 1))
        const api = await root.host.request<{ userId: number }>('/api/studio/sessions')
        return { content: [{ type: 'text', text: `${root.identity.userId}/${api.userId}/${await run.state.agentSession!.get('owner')}` }], finishReason: 'stop' }
      }, dispose() {} }
    } } }))
  })
  const [first, second] = await Promise.all([value.agent.execute(call(value.agent, 2)), value.agent.execute(call(value.agent, 3))])
  expect(first.content).toEqual([{ type: 'text', text: '2/2/2' }]); expect(second.content).toEqual([{ type: 'text', text: '3/3/3' }])
  await expect(contexts[0].output.emit({ type: 'text.delta', text: 'late' })).rejects.toThrow()
  await expect(contexts[0].attachments.read('late')).rejects.toThrow()
  await expect(contexts[0].state.agentSession.get('owner')).rejects.toThrow()
  await value.agent.execute(call(value.agent, 2))
  expect(factory).toHaveBeenCalledTimes(2)
})

it('passes text, images and files without capability flags and cleans per-run resources', async () => {
  const cleanup = vi.fn(), dispose = vi.fn()
  const value = await owner(ctx => ctx.extensions.agents.register(definition({ runtime: { createSession: () => ({ async run(request, run) {
    run.lifecycle.add(cleanup)
    for (const part of request.input) if (part.type !== 'text') { await run.attachments.resolve(part.assetId); await run.attachments.read(part.assetId) }
    await run.output.emit({ type: 'text.delta', text: 'processed' })
    return { content: [{ type: 'text', text: 'processed' }], finishReason: 'stop' }
  }, dispose }) } })))
  const args = call(value.agent)
  args.request = { ...input, input: [...input.input, { type: 'image', assetId: 'image', name: 'image.png', mediaType: 'image/png' }, { type: 'file', assetId: 'file', name: 'file.pdf', mediaType: 'application/pdf' }] }
  await value.agent.execute(args)
  expect(args.attachments.read).toHaveBeenCalledTimes(2); expect(args.emit).toHaveBeenCalledWith({ type: 'text.delta', text: 'processed' })
  expect(cleanup).toHaveBeenCalledTimes(1); expect(dispose).not.toHaveBeenCalled()
  await value.runtime.close(); expect(dispose).toHaveBeenCalledTimes(1)
})

it('serializes a session, cancels hung runs, disposes engines, and rejects calls after disable', async () => {
  let started!: () => void
  const ready = new Promise<void>(resolve => { started = resolve }), dispose = vi.fn()
  const value = await owner(ctx => ctx.extensions.agents.register(definition({ runtime: { createSession: () => ({ run: async () => { started(); return new Promise(() => {}) }, dispose }) } })))
  const controller = new AbortController(), pending = value.agent.execute(call(value.agent, 2, 'one', controller.signal))
  const caught = expect(pending).rejects.toThrow()
  await ready
  await expect(value.agent.execute(call(value.agent, 2, 'one'))).rejects.toMatchObject({ code: 'AGENT_BUSY' })
  controller.abort(new Error('Stopped')); await caught
  expect(dispose).toHaveBeenCalledTimes(1)
  await value.runtime.close()
  await expect(value.agent.execute(call(value.agent))).rejects.toThrow('expired')
})

it('validates management results, owns settings views, and checks exact versions before upgrading', async () => {
  let version = '1.0.0'
  const upgrade = vi.fn(async request => { version = request.version; return { installedVersion: version } })
  const value = await owner(ctx => ctx.extensions.agents.register(definition({ getStatus: async () => ({ installed: true, version }), management: {
    settings: () => ({ viewId: 'other-plugin-settings' }),
    checkUpdate: async () => ({ currentVersion: version, latestVersion: '2.0.0', updateAvailable: true }), upgrade,
  } })))
  await expect(value.agent.settings({ userId: 2, profile: 'work' })).rejects.toThrow('own declared')
  await expect(value.agent.upgrade({ userId: 1, profile: 'installer' }, { version: '2.0.0', expectedVersion: 'old' })).rejects.toMatchObject({ code: 'AGENT_VERSION' })
  expect(upgrade).not.toHaveBeenCalled()
  expect(await value.agent.upgrade({ userId: 1, profile: 'installer' }, { version: '2.0.0', expectedVersion: '1.0.0' })).toEqual({ installedVersion: '2.0.0' })
  expect(await value.agent.status({ userId: 2, profile: 'work' })).toMatchObject({ version: '2.0.0' })
})

it('restores versioned native checkpoints only when resume is declared', async () => {
  const resumes: unknown[] = []
  const value = await owner(ctx => ctx.extensions.agents.register(definition({ features: { ...definition().features, resume: true }, runtime: { createSession: context => {
    resumes.push(context.resumeState)
    return { run: async () => ({ content: [], finishReason: 'stop' }), checkpoint: async () => ({ schemaVersion: 1, data: { nativeSession: 'native-1' } }), dispose() {} }
  } } })))
  await value.agent.execute(call(value.agent)); await value.agent.closeSessions(); await value.agent.execute(call(value.agent))
  expect(resumes).toEqual([undefined, { schemaVersion: 1, data: { nativeSession: 'native-1' } }])
})

it('installs the shipped Agent example and sends scoped multimodal requests to the injected Studio proxy', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'studio-agent-example-')); directories.push(directory)
  const manager = new PluginManager(directory, { authorize() {}, api: async () => null, emit() {}, log() {} })
  try {
    await manager.install({ userId: 1, profile: 'installer' }, resolve('tests/fixtures/plugins/custom-agent'), 0)
    await manager.update({ userId: 1, profile: 'installer' }, 'custom-agent', 1, { enabled: true })
    const agent = manager.registeredAgents()[0]
    expect(await agent.settings({ userId: 2, profile: 'work' })).toMatchObject({ params: { pluginId: 'custom-agent', viewId: 'settings' } })
    expect(await agent.models({ userId: 2, profile: 'work' })).toMatchObject({ models: [{ id: 'local-echo' }] })
    const args = call(agent)
    expect(await agent.execute(args)).toMatchObject({ content: [{ text: 'Echo: Hello' }] })
    const fetch = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'Proxy reply' } }] }), { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    await agent.execute({ ...args, mode: 'scoped', model: { provider: 'custom:test', model: 'selected', apiMode: 'chat_completions', baseUrl: 'http://studio-proxy/v1', token: 'proxy-token', contextWindow: 128000, outputLimit: 8192 },
      request: { ...input, input: [...input.input, { type: 'image', assetId: 'image', name: 'image.png', mediaType: 'image/png' }, { type: 'file', assetId: 'file', name: 'file.pdf', mediaType: 'application/pdf' }] } })
    expect(fetch).toHaveBeenCalledWith('http://studio-proxy/v1/chat/completions', expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer proxy-token' }) }))
    const body = JSON.parse((fetch.mock.calls[0][1] as any).body)
    expect(body.messages.at(-1).content.map((part: any) => part.type)).toEqual(['text', 'image_url', 'file'])
    expect(args.attachments.read).toHaveBeenCalledTimes(2)
  } finally { await manager.close() }
})
