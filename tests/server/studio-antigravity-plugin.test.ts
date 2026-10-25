import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { cp, mkdir, lstat, stat } from 'node:fs/promises'
import { convertRequest, geminiBridge } from '../../plugins/antigravity/src/gemini'
import { assertScopedRouting, prepareNative } from '../../plugins/antigravity/src/configuration'
import { nonOwnerImageReaders, windowsImageAcl } from '../fixtures/studio-antigravity-privacy'
import { nativeParser } from '../../plugins/antigravity/src/protocol'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { AgentExecutionStore } from '../../packages/server/src/modules/studio/repositories/agent-execution-store'
import { PluginStore } from '../../packages/server/src/modules/studio/repositories/plugin-store'
import { AgentCoordinator } from '../../packages/server/src/modules/studio/services/agents/coordinator'
import { AgentRegistry } from '../../packages/server/src/modules/studio/services/agents/registry'
import { PluginHost } from '../../packages/server/src/modules/studio/services/plugins/host'
import { PluginEventBus } from '../../packages/server/src/modules/studio/services/events/plugin-events'
import { createExecutionContext } from '../../packages/server/src/modules/studio/services/context/execution'
import { StudioError, type AgentRuntimeContext, type ExecutionScope, type ModelGatewayHandle } from '../../packages/studio-plugin-sdk/src'

const caller: ExecutionScope = {
  scopeId: 'scope',
  principal: { kind: 'user', id: 'owner' },
  profileId: 'one',
  surface: 'api',
  traceId: 'trace',
}
let root: string, runner: string
const cleanups: Array<() => Promise<void>> = []
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'studio-antigravity-'))
  runner = join(root, 'runner.cjs')
  await build({
    entryPoints: ['packages/studio-plugin-runner/src/main.ts'],
    bundle: true,
    platform: 'node',
    target: 'node24.22.1',
    format: 'cjs',
    outfile: runner,
    logLevel: 'silent',
  })
  await build({
    entryPoints: ['plugins/antigravity/src/index.ts'],
    bundle: true,
    platform: 'node',
    target: 'node24.22.1',
    format: 'cjs',
    outfile: join(root, 'plugin/dist/index.cjs'),
    logLevel: 'silent',
    alias: {
      '@ekko-studio/plugin-sdk': join(process.cwd(), 'packages/studio-plugin-sdk/src/index.ts'),
      '@ekko-studio/agent-drivers': join(process.cwd(), 'packages/studio-agent-drivers/src/index.ts'),
    },
  })
  await cp('plugins/antigravity/studio-plugin.json', join(root, 'plugin/studio-plugin.json'))
})
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

async function setup(mode: 'global' | 'scoped' = 'global') {
  const directory = await mkdtemp(join(root, 'fixture-')),
    trace = join(directory, 'trace'),
    cli = join(directory, 'cli.cjs')
  await cp('tests/fixtures/studio-antigravity-cli.cjs', cli)
  const db = new DatabaseSync(':memory:'),
    executions = new AgentExecutionStore(db),
    store = new PluginStore(db),
    registry = new AgentRegistry(),
    events = new PluginEventBus()
  const logger = { info() {}, warn() {}, error() {} },
    authorize = vi.fn()
  const gateway = vi.fn(async () => ({
    baseUrl: 'http://127.0.0.1:1/v1',
    token: 'temporary-only',
    model: 'fixture/model',
    protocol: 'responses',
    images: true,
    dispose: async () => {},
  }))
  const context = (scope: ExecutionScope, signal: AbortSignal) =>
    createExecutionContext(scope, signal, logger, {
      authorize: async () => {},
      agents: { list: async () => [] },
      sessions: { get: async () => null },
      models: { gateway },
      artifacts: {
        read: async (_scope, id, offset) => ({
          id,
          offset,
          mediaType: 'image/png',
          byteLength: 3,
          data: 'YWJj',
          nextOffset: 3,
          done: true,
        }),
      },
    })
  const coordinator = new AgentCoordinator({
    store: executions,
    registry,
    events,
    logger,
    authorize,
    validateInput() {},
    context,
    stateRoot: join(directory, 'state'),
  })
  const host = new PluginHost({
    store,
    registry,
    events,
    context,
    logger,
    runnerPath: runner,
    artifactsRoot: join(directory, 'installed'),
    eventContext: async (_state, _event, signal) => context(caller, signal),
    acceptEvents: async (batch) => {
      for (const event of batch) events.publish(event)
    },
  })
  cleanups.push(async () => {
    await coordinator.close()
    await host.close()
    events.close()
    db.close()
  })
  const manifest = JSON.parse(await readFile(join(root, 'plugin/studio-plugin.json'), 'utf8'))
  await host.registerSystemArtifact(join(root, 'plugin'), manifest.id)
  await host.configure(
    {
      pluginId: manifest.id,
      profileId: caller.profileId,
      ownerId: caller.principal.id,
      enabled: true,
      config: {},
      grants: manifest.requires.capabilities,
    },
    0,
  )
  const config = {
    cwd: directory,
    command: process.execPath,
    args: [cli],
    model: 'native-model',
    env: { TRACE: trace, HOME: directory, USERPROFILE: directory },
  }
  const instance = coordinator.createInstance(caller, { agentTypeId: 'antigravity', mode, config })
  let sequence = 0
  const start = (text: string) => coordinator.start(caller, instance.id, { content: [{ type: 'text', text }] }, `run-${++sequence}`)
  const frames = async () =>
    (await readFile(trace, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
  return { db, coordinator, registry, host, executions, instance, config, directory, trace, gateway, authorize, start, frames }
}

it.each(['global', 'scoped'] as const)('executes and resumes Antigravity with native IDs through its own worker (%s)', async (mode) => {
  const f = await setup(mode)
  for (const text of ['hello', 'again']) {
    const run = f.start(text)
    await f.coordinator.wait(run.id)
    expect(f.coordinator.get(caller, run.id).status).toBe('completed')
    const output = f.coordinator.output(caller, run.id, -1)
    expect(output.filter((x) => x.type === 'message.delta')).toHaveLength(1)
    expect(output.filter((x) => x.type === 'tool.failed')).toHaveLength(1)
    const usage = f.coordinator.usage(caller, run.id)
    if (mode === 'global')
      expect(usage).toEqual([expect.objectContaining({ inputTokens: 10, outputTokens: 3, cacheReadTokens: 2, reasoningTokens: 1 })])
    else expect(usage).toEqual([])
  }
  const frames = await f.frames()
  expect(frames[0].args).not.toContain('--conversation')
  expect(frames[1].args).toEqual(expect.arrayContaining(['--conversation', 'native-session', '--dangerously-skip-permissions']))
  expect(frames[1].args).not.toContain('--continue')
  if (mode === 'scoped') {
    expect(frames[0].token).toHaveLength(64)
    expect(f.gateway).toHaveBeenCalledTimes(2)
  } else {
    expect(frames[0].token).toBeUndefined()
    expect(f.gateway).not.toHaveBeenCalled()
  }
  expect(() => f.host.uninstall('studio.agent-antigravity')).toThrow('System plugins cannot be uninstalled')
})
it('waits for terminal result after model DONE and tool failure', async () => {
  const f = await setup(),
    run = f.start('barrier')
  await vi.waitFor(async () => expect(await readFile(f.trace + '.step', 'utf8')).toBe('ready'))
  expect(f.coordinator.get(caller, run.id).status).toBe('running')
  await writeFile(f.trace + '.release', 'go')
  await f.coordinator.wait(run.id)
  expect(f.coordinator.get(caller, run.id).status).toBe('completed')
})
it.each(['step-only', 'error', 'crash', 'malformed', 'bad-exit', 'late-exit'])(
  'fails closed on %s and permits a later turn',
  async (text) => {
    const f = await setup(),
      run = f.start(text)
    await f.coordinator.wait(run.id)
    expect(f.coordinator.get(caller, run.id).status).toBe(text === 'late-exit' ? 'interrupted' : 'failed')
    const next = f.start('hello')
    await f.coordinator.wait(next.id)
    expect(f.coordinator.get(caller, next.id).status).toBe('completed')
  },
)
it.each(['global', 'scoped'] as const)('cancels the owned process and preserves another turn (%s)', async (mode) => {
  const f = await setup(mode),
    run = f.start('wait')
  await vi.waitFor(async () => expect(await f.frames()).toHaveLength(1))
  await f.coordinator.cancel(caller, run.id)
  await f.coordinator.wait(run.id)
  expect(f.coordinator.get(caller, run.id).status).toBe('cancelled')
  const next = f.start('hello')
  await f.coordinator.wait(next.id)
  expect(f.coordinator.get(caller, next.id).status).toBe('completed')
})
it('rejects another native conversation after checkpoint', async () => {
  const f = await setup()
  const first = f.start('hello')
  await f.coordinator.wait(first.id)
  const run = f.start('wrong-identity')
  await f.coordinator.wait(run.id)
  expect(f.coordinator.get(caller, run.id).status).toBe('failed')
})
it('inspects version and manual setup without a native conversation or account claims', async () => {
  const f = await setup()
  const inspected = await f.coordinator.inspectInstance(caller, f.instance.id)
  expect(inspected).toMatchObject({
    native: { name: 'Antigravity', version: '1.4.7' },
    authentication: { state: 'unknown' },
    models: { status: 'unsupported', items: [] },
  })
  await expect(readFile(f.trace)).rejects.toMatchObject({ code: 'ENOENT' })
  const prepared = await f.coordinator.setupInstance(caller, f.instance.id, 1)
  expect(prepared).toMatchObject({ installation: { kind: 'manual', url: 'https://antigravity.google/docs/cli/install' } })
  expect(f.db.prepare('SELECT count(*) AS count FROM studio_agent_runs').get()?.count).toBe(0)
})
it('keeps native config and keychain ownership global, while scoped never links native account paths', async () => {
  const directory = await mkdtemp(join(root, 'config-')),
    home = join(directory, 'native'),
    state = join(directory, 'state')
  await mkdir(join(home, '.gemini/config/skills/local'), { recursive: true })
  await mkdir(join(home, '.gemini/antigravity-cli'), { recursive: true })
  await mkdir(join(home, 'Library/Keychains'), { recursive: true })
  const settings = '{"permissions":{"deny":["shell(*)"]},"nativePreference":true}',
    mcp = '{"mcpServers":{"user":{"command":"custom"}}}'
  await writeFile(join(home, '.gemini/antigravity-cli/settings.json'), settings)
  await writeFile(join(home, '.gemini/config/mcp_config.json'), mcp)
  await writeFile(join(home, '.gemini/config/AGENTS.md'), 'Native rules')
  const config = { env: { HOME: home } },
    runtime = { stateDirectory: state, runtimeSessionId: 'session' } as AgentRuntimeContext,
    context = { systemPrompt: 'Studio rules', mcpServers: { studio: { command: 'node', env: { ELECTRON_RUN_AS_NODE: '1' } } } }
  const global = await prepareNative(config, 'global', runtime, context)
  expect(await readFile(join(home, '.gemini/antigravity-cli/settings.json'), 'utf8')).toBe(settings)
  expect(await readFile(join(home, '.gemini/config/mcp_config.json'), 'utf8')).toBe(mcp)
  expect(
    JSON.parse(await readFile(join(global.home, '.gemini/config/mcp_config.json'), 'utf8')).mcpServers.studio.env.ELECTRON_RUN_AS_NODE,
  ).toBe('1')
  expect(await readFile(join(global.home, '.gemini/config/AGENTS.md'), 'utf8')).toContain('Native rules')
  expect((await lstat(join(global.home, '.gemini/antigravity'))).isSymbolicLink()).toBe(true)
  const scoped = await prepareNative(config, 'scoped', { ...runtime, runtimeSessionId: 'scoped' }, context, {
    token: 'ephemeral',
    baseUrl: 'http://127.0.0.1:1',
  })
  await expect(lstat(join(scoped.home, 'Library/Keychains'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(join(scoped.home, '.gemini/antigravity-cli/settings.json'), 'utf8')).not.toContain('nativePreference')
  expect(scoped.env.GEMINI_API_KEY).toBe('ephemeral')
})
it('never repeats cumulative result usage across resumed or multi-turn history', () => {
  for (const resumed of [false, true]) {
    const parse = nativeParser(resumed)
    const events = parse(
      JSON.stringify({ event: 'result', result: { status: 'SUCCESS', num_turns: 2, usage: { input_tokens: 999, output_tokens: 99 } } }),
    )
    expect(events.at(-1)).toEqual({ type: 'terminal', success: true })
  }
})
it('rejects unsupported Gemini semantics instead of losing them', () => {
  for (const extra of [
    { cachedContent: 'old' },
    { generationConfig: { topP: 0.5 } },
    { tools: [{ googleSearch: {} }] },
    { contents: [{ role: 'model', parts: [{ text: 'test', thoughtSignature: 'encrypted' }] }] },
  ])
    expect(() => convertRequest({ contents: [], ...extra })).toThrow()
})
it('serves only authenticated native Gemini calls and retains the selected host model and call IDs', async () => {
  const { createServer } = await import('node:http'),
    requests: unknown[] = []
  const upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    requests.push(JSON.parse(Buffer.concat(chunks).toString()))
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        id: 'response',
        status: 'completed',
        output: [{ type: 'function_call', call_id: 'native-call', name: 'read_file', arguments: '{"Path":"/file"}' }],
      }),
    )
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const address = upstream.address()
  if (!address || typeof address === 'string') throw new Error('No local port')
  const controller = new AbortController(),
    bridge = await geminiBridge(
      {
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        token: 'host-only',
        model: 'provider/selected',
        protocol: 'responses',
        dispose: async () => {},
      } as ModelGatewayHandle,
      controller.signal,
    )
  try {
    const path = `${bridge.baseUrl}/v1beta/models/ignored-native-model:streamGenerateContent`,
      body = {
        contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
        generationConfig: { maxOutputTokens: 128, thinkingConfig: { includeThoughts: true, thinkingBudget: 1024 } },
      }
    expect((await fetch(path, { method: 'POST', body: JSON.stringify(body) })).status).toBe(401)
    expect(
      (await fetch(bridge.baseUrl + '/other', { method: 'POST', headers: { 'x-goog-api-key': bridge.token }, body: '{}' })).status,
    ).toBe(404)
    const response = await fetch(path, { method: 'POST', headers: { 'x-goog-api-key': bridge.token }, body: JSON.stringify(body) })
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('"id":"native-call"')
    expect(requests).toEqual([
      expect.objectContaining({
        model: 'provider/selected',
        stream: false,
        max_output_tokens: 128,
        reasoning: { effort: 'low', summary: 'auto' },
      }),
    ])
    const bad = await fetch(path, {
      method: 'POST',
      headers: { 'x-goog-api-key': bridge.token },
      body: JSON.stringify({ ...body, cachedContent: 'cannot-represent' }),
    })
    expect(bad.status).toBe(400)
    expect(requests).toHaveLength(1)
  } finally {
    await bridge.dispose()
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
  }
})
it('aborts active native requests on Run cancellation and closes the loopback server', async () => {
  const { createServer } = await import('node:http')
  let started!: () => void
  const admitted = new Promise<void>((resolve) => {
    started = resolve
  })
  const upstream = createServer((_req, _res) => started())
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const address = upstream.address()
  if (!address || typeof address === 'string') throw new Error('No local port')
  const controller = new AbortController(),
    bridge = await geminiBridge(
      {
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        token: 'host-only',
        model: 'p/m',
        protocol: 'responses',
        dispose: async () => {},
      } as ModelGatewayHandle,
      controller.signal,
    )
  try {
    const request = fetch(`${bridge.baseUrl}/v1beta/models/native:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': bridge.token },
      body: '{"contents":[]}',
    })
    void request.catch(() => {})
    await admitted
    controller.abort()
    await bridge.dispose()
    await expect(request).rejects.toThrow()
    await expect(fetch(bridge.baseUrl)).rejects.toThrow()
  } finally {
    upstream.closeAllConnections()
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
  }
})

it('rejects scoped native/project routing overrides without editing them or opening a gateway', async () => {
  const f = await setup('scoped'),
    directory = join(f.directory, '.agents')
  await mkdir(directory, { recursive: true })
  const path = join(directory, 'settings.local.json'),
    content = JSON.stringify({ env: { GOOGLE_GEMINI_BASE_URL: 'http://127.0.0.1:9', GEMINI_API_KEY: 'foreign' } })
  await writeFile(path, content)
  const run = f.start('hello')
  await f.coordinator.wait(run.id)
  expect(f.coordinator.get(caller, run.id)).toMatchObject({ status: 'failed', errorCode: 'CAPABILITY_UNSUPPORTED' })
  expect(f.gateway).not.toHaveBeenCalled()
  expect(await readFile(path, 'utf8')).toBe(content)
  await expect(readFile(f.trace)).rejects.toMatchObject({ code: 'ENOENT' })
})
it('rejects scoped custom provider settings while retaining benign settings', async () => {
  const directory = await mkdtemp(join(root, 'routing-')),
    runtime = { stateDirectory: directory }
  const home = join(directory, 'native-home/.gemini/antigravity-cli')
  await mkdir(home, { recursive: true })
  const path = join(home, 'settings.json')
  await writeFile(path, '{"colorScheme":"light","modelProvider":"gemini"}')
  await expect(assertScopedRouting({ cwd: directory }, runtime)).resolves.toBeUndefined()
  await writeFile(path, '{"customModelsConfig":{"baseUrl":"https://foreign.example"}}')
  await expect(assertScopedRouting({ cwd: directory }, runtime)).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' })
  expect(await readFile(path, 'utf8')).toContain('foreign.example')
})

it('stores image attachments privately and removes them after cancellation', async () => {
  const f = await setup()
  const run = f.coordinator.start(
    caller,
    f.instance.id,
    {
      content: [
        { type: 'text', text: 'wait' },
        { type: 'image', artifactId: '00000000-0000-0000-0000-000000000001', mediaType: 'image/png' },
      ],
    },
    'image-cancel',
  )
  await vi.waitFor(async () => expect(await f.frames()).toHaveLength(1))
  const prompt = (await f.frames())[0].body.message.content
  const path = JSON.parse(prompt.trim().split('\n').at(-1))
  const metadata = await stat(path)
  expect(metadata.isFile()).toBe(true)
  if (process.platform === 'win32') {
    const acl = await windowsImageAcl(path)
    expect(acl.allowReadSids.length).toBeGreaterThan(0)
    expect(nonOwnerImageReaders(acl)).toEqual([])
  } else expect(metadata.mode & 0o777).toBe(0o600)
  expect(await readFile(path, 'utf8')).toBe('abc')
  await f.coordinator.cancel(caller, run.id)
  await f.coordinator.wait(run.id)
  expect(f.coordinator.get(caller, run.id).status).toBe('cancelled')
  await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('meters checkpoint model work once alongside resumed agent steps', () => {
  const parse = nativeParser(true)
  for (const step_type of ['agent_response', 'checkpoint', 'checkpoint'])
    parse(
      JSON.stringify({
        event: 'step_update',
        step_update: {
          step_type,
          state: 'DONE',
          step_index: step_type === 'checkpoint' ? 4 : 3,
          usage: { input_tokens: 10, output_tokens: 2 },
        },
      }),
    )
  expect(
    parse(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', num_turns: 9, usage: { input_tokens: 999 } } })).at(-1),
  ).toEqual({
    type: 'terminal',
    success: true,
    usage: { inputTokens: 20, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
  })
})

it('rejects legacy SSE MCP instead of reinterpreting it as Streamable HTTP', async () => {
  const directory = await mkdtemp(join(root, 'sse-'))
  await expect(
    prepareNative(
      { env: { HOME: directory } },
      'global',
      { stateDirectory: join(directory, 'state'), runtimeSessionId: 'test' } as AgentRuntimeContext,
      { mcpServers: { legacy: { type: 'sse', url: 'http://127.0.0.1:1/sse' } } },
    ),
  ).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' })
})

it('rejects Windows image ACLs that grant other users content access or omit a DACL', () => {
  const currentSid = 'S-1-5-21-100-200-300-1001'
  const acl = { currentSid, ownerSid: currentSid, hasDacl: true, allowReadSids: [currentSid, 'S-1-5-18', 'S-1-5-32-544'] }
  expect(nonOwnerImageReaders(acl)).toEqual([])
  for (const other of ['S-1-1-0', 'S-1-5-11', 'S-1-5-32-545', 'S-1-5-21-100-200-300-1002'])
    expect(nonOwnerImageReaders({ ...acl, allowReadSids: [...acl.allowReadSids, other] })).toEqual([other])
  expect(nonOwnerImageReaders({ ...acl, ownerSid: 'S-1-5-21-100-200-300-1002' })).toEqual(['S-1-5-21-100-200-300-1002'])
  expect(() => nonOwnerImageReaders({ ...acl, hasDacl: false })).toThrow('valid discretionary ACL')
})
