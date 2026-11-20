import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Namespace, Socket } from 'socket.io'
import type { ModelClient, ModelResponse } from '../../packages/ekko-agent/src/model/types'
import type { PluginCompressionSummarizer, PluginPermission } from '../../packages/plugin-sdk/src'
import { PluginRuntime } from '../../packages/server/src/modules/studio/services/plugins/runtime'
import { PluginStore } from '../../packages/server/src/modules/studio/services/plugins/store'
import type { SessionState } from '../../packages/server/src/modules/studio/services/chat-run/types'

const sessionFixture = {
  id: 'session', source: 'builtin_agent', agent: 'ekko-agent',
  profile: 'work', provider: 'deepseek', model: 'family/model', history_revision: 3,
}

const fixtures = vi.hoisted(() => ({
  home: '', config: {} as any, policy: {} as Record<string, unknown>, snapshot: null as any,
  session: {} as typeof sessionFixture,
  plugin: undefined as PluginRuntime | undefined, pluginLookup: vi.fn(),
  messages: [] as any[], requests: [] as any[], upstream: [] as any[],
  fetch: undefined as any, run: vi.fn(), save: vi.fn(), bridge: vi.fn(),
}))

vi.mock('../../packages/server/src/modules/studio/public/config', () => ({ config: { port: 18648, get appHome() { return fixtures.home } } }))
vi.mock('../../packages/server/src/modules/studio/public/provider-config', () => ({ readConfigYamlForProfile: async () => fixtures.config }))
vi.mock('../../packages/server/src/modules/studio/public/profile-config', () => ({
  // Hermes' transport projection must not override Studio's compression choice.
  readConfigYamlForProfile: async () => ({
    model: { provider: 'ekkostudio', default: 'deepseek/family/model' },
    auxiliary: { compression: { provider: 'main' } }, compression: fixtures.policy,
  }),
}))
vi.mock('../../packages/server/src/modules/studio/services/providers/account-store', () => ({ providerAccountHome: () => fixtures.home }))
vi.mock('../../packages/server/src/modules/studio/public/provider-account', () => ({
  providerAccountId: () => 7, providerRequestProfile: () => 'work',
  withProviderAccount: (_id: unknown, task: () => unknown) => task(),
  withSocketProviderAccount: (task: unknown) => task,
  importAccountProviders: async () => {}, internalModelCredential: async () => ({ userId: 7, token: 'studio_model_fixture' }),
}))
vi.mock('../../packages/server/src/modules/studio/public/provider-projection', () => ({ studioModelGatewayUrl: () => 'http://localhost:18648/api/ekko-studio/models/v1' }))
vi.mock('../../packages/server/src/modules/studio/public/provider-upstream', () => ({
  resolveProviderUpstream: async ({ provider }: any) => ({ provider, baseUrl: 'https://upstream.invalid/v1', apiKey: `${provider}-secret`, apiMode: 'chat_completions' }),
}))
vi.mock('../../packages/server/src/modules/studio/public/session-agent-runtime', () => ({
  getSessionAvailableModelGroups: async () => [
    { provider: 'deepseek', models: ['family/model'], api_mode: 'chat_completions', base_url: 'https://upstream.invalid/v1' },
    { provider: 'relay', models: ['summary/family/model'], api_mode: 'chat_completions', base_url: 'https://upstream.invalid/v1' },
  ],
}))
vi.mock('../../packages/server/src/modules/studio/public/provider-runtime', () => ({ getModelContextLength: () => 32_000 }))
vi.mock('../../packages/server/src/modules/studio/services/plugins/host', () => ({
  getActiveCompressionSummarizer: fixtures.pluginLookup,
}))
vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }, bridgeLogger: { info: vi.fn(), warn: vi.fn() },
}))
vi.mock('../../packages/server/src/modules/studio/repositories/session-store', () => ({
  getSession: () => fixtures.session,
  addMessage: vi.fn(), updateSession: vi.fn(), updateSessionStats: vi.fn(),
}))
vi.mock('../../packages/server/src/modules/studio/repositories/run-usage-store', () => ({ completeRunUsage: vi.fn() }))
vi.mock('../../packages/server/src/modules/studio/public/pet-events', () => ({ observeRunChatPetEvent: vi.fn() }))
vi.mock('../../packages/server/src/modules/studio/services/chat-run/workspace-diff-tracker', () => ({
  completeWorkspaceRunCheckpoint: () => null, startWorkspaceRunCheckpoint: vi.fn(),
}))
vi.mock('../../packages/server/src/modules/studio/repositories/compression-snapshot', () => ({
  getCompressionSnapshot: () => fixtures.snapshot, saveCompressionSnapshot: (...args: any[]) => fixtures.save(...args),
  deleteCompressionSnapshot: () => { fixtures.snapshot = null },
}))
vi.mock('../../packages/server/src/modules/studio/repositories/usage-store', () => ({ getUsage: () => undefined }))
vi.mock('../../packages/server/src/modules/studio/services/chat-run/context-history', () => ({
  buildDbHistory: async () => fixtures.messages, readCursorSnapshotParts: () => ({ status: 'legacy' }),
}))
vi.mock('../../packages/server/src/modules/studio/services/chat-run/load-state', () => ({
  readSessionStateFromDb: () => ({ messages: [], events: [], queue: [], isWorking: false }),
}))
vi.mock('../../packages/server/src/modules/studio/services/chat-run/usage', async importOriginal => ({
  ...await importOriginal<typeof import('../../packages/server/src/modules/studio/services/chat-run/usage')>(),
  estimateUsageTokensFromMessages: (messages: any[]) => ({ inputTokens: messages.length * 100, outputTokens: 0 }),
  calcAndUpdateUsage: async () => ({ inputTokens: 100, outputTokens: 0 }),
}))
vi.mock('../../packages/server/src/modules/studio/public/usage', () => ({
  normalizeTokenUsage: (usage: any) => ({ inputTokens: usage.prompt_tokens || 0, outputTokens: usage.completion_tokens || 0 }),
  normalizeUsageCost: () => undefined, recordSessionUsage: vi.fn(),
}))
vi.mock('../../packages/server/src/modules/coding-agents/services/runtime/run-manager', () => ({ codingAgentRunManager: { handleProxyUsageEvent: vi.fn() } }))
vi.mock('../../packages/server/src/modules/coding-agents/services/context-policy', () => ({ codingAgentOutputLimit: () => 8192 }))
vi.mock('../../packages/server/src/modules/studio/public/chat-agent-runtime', async () => {
  const { createModelClient } = await import('../../packages/ekko-agent/src/model/registry')
  const { resolveAgentGatewayRuntime, resolveAgentGatewayModelConfigs } = await import('../../packages/server/src/bootstrap/provider-gateway-client')
  return {
    resolveChatEkkoProviderRuntimeConfig: resolveAgentGatewayRuntime,
    resolveChatEkkoModelProviderConfigs: resolveAgentGatewayModelConfigs,
    createChatEkkoModelClient: createModelClient,
    createChatEkkoAuthorizedProviderFetch: () => fixtures.fetch,
    getChatEkkoAgent: () => ({ runIsolated: fixtures.run }), createPrimaryAgentBridge: fixtures.bridge,
  }
})

import { buildCompressedHistory, compressHistory, forceCompressBridgeHistory } from '../../packages/server/src/modules/studio/services/chat-run/compression'
import { handleSessionCommand, parseSessionCommand } from '../../packages/server/src/modules/studio/services/chat-run/session-command'
import { handleEkkoSessionCommand, parseEkkoRunCommand } from '../../packages/server/src/modules/studio/services/chat-run/ekko-session-command'
import { resumeBridgeRun } from '../../packages/server/src/modules/studio/services/chat-run/handle-bridge-run'
import { callSummarizer, SUMMARY_PREFIX } from '../../packages/server/src/modules/studio/services/context-compressor'
import { configureProviderHttp } from '../../packages/server/src/modules/studio/public/provider-http'
import { configureModelGatewayAdapters } from '../../packages/server/src/modules/studio/public/model-gateway-adapters'
import { codingModelGatewayAdapters } from '../../packages/server/src/modules/coding-agents/public/model-gateway'
import { serveModelGateway } from '../../packages/server/src/modules/studio/services/model-api/gateway'

const summary = 'Decisions: preserve logical provider and model; continue the task.'

beforeEach(async () => {
  vi.clearAllMocks()
  fixtures.home = await mkdtemp(join(tmpdir(), 'compression-routing-'))
  fixtures.config = { model: { provider: 'relay', default: 'summary/family/model' } }
  fixtures.policy = { enabled: true, threshold: 0.5, target_ratio: 0.1, protect_first_n: 0, protect_last_n: 1 }
  fixtures.snapshot = null
  fixtures.session = { ...sessionFixture }
  fixtures.pluginLookup.mockReset().mockImplementation(() => fixtures.plugin)
  fixtures.messages = [
    { role: 'user', content: 'Keep the existing session history.' },
    { role: 'assistant', content: 'I will check the model migration.' },
    { role: 'user', content: 'Also preserve the previous decisions.' },
    { role: 'assistant', content: 'This recent reply must remain verbatim.' },
  ]
  fixtures.requests = []
  fixtures.upstream = []
  fixtures.save.mockReturnValue(true)
  await Promise.all([
    writeFile(join(fixtures.home, 'config.yaml'), 'providers:\n  deepseek: {}\n  relay: {}\n'),
    writeFile(join(fixtures.home, 'pool.json'), JSON.stringify({ aliases: { 'custom:legacy': 'relay' }, imports: {} })),
    writeFile(join(fixtures.home, 'routes.json'), JSON.stringify({ deepseek: { provider: 'deepseek' }, relay: { provider: 'relay' }, 'old/route': { provider: 'custom:legacy' } })),
  ])
  configureModelGatewayAdapters(codingModelGatewayAdapters)
  configureProviderHttp(async input => {
    fixtures.upstream.push(input)
    const chunks = [
      { id: 'summary', choices: [{ index: 0, delta: { role: 'assistant', content: summary }, finish_reason: null }] },
      { id: 'summary', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 500, completion_tokens: 20 } },
    ]
    return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  })
  // Exercise the actual Ekko client, gateway routing and Responses -> Chat
  // adapter in process; only the network and persistent session stores are fake.
  fixtures.fetch = async (url: string, init: RequestInit) => {
    const headers = new Headers(init.headers)
    const body = JSON.parse(String(init.body))
    fixtures.requests.push({ provider: headers.get('x-studio-provider'), body })
    const ctx: any = {
      path: new URL(url).pathname, method: 'POST', query: {}, params: {}, request: { body },
      res: Object.assign(new EventEmitter(), { writableEnded: false }),
      state: { user: { id: 7 }, modelGateway: { userId: 7, profile: 'work' }, modelGatewaySignal: init.signal },
      get: (name: string) => headers.get(name) || '', set: () => {}, status: 200,
    }
    await serveModelGateway(ctx, 'codex_responses', ['work'])
    if (ctx.body instanceof Readable) {
      const stream = ctx.body
      const bytes = Readable.from((async function* () {
        for await (const chunk of stream) yield Buffer.from(chunk)
      })())
      return new Response(Readable.toWeb(bytes) as ReadableStream, { status: ctx.status, headers: { 'content-type': 'text/event-stream' } })
    }
    return Response.json(ctx.body, { status: ctx.status })
  }
  fixtures.run.mockImplementation(async (options: { modelClient: ModelClient; modelDefaults: { model: string } }, input: any) => {
    let output: Partial<ModelResponse> = {}
    let content = ''
    for await (const event of options.modelClient.stream({ model: options.modelDefaults.model, messages: input.messages })) {
      if (event.type === 'error') throw new Error(event.error)
      if (event.type === 'text-delta') content += event.text
      if (event.type === 'done') output = event.response || {}
    }
    return { output: { ...output, content: output.content || content } }
  })
})

afterEach(async () => {
  await fixtures.plugin?.close()
  fixtures.plugin = undefined
  await rm(fixtures.home, { recursive: true, force: true })
})

async function compress(kind: 'automatic' | 'manual') {
  if (kind === 'manual') {
    const result = await forceCompressBridgeHistory('session', 'work', [], undefined, { force: true, excludeLastUser: false, allowHermesFallback: false })
    expect(result.llmCompressed).toBe(true)
    return result.messages
  }
  const state: any = { messages: [], events: [], queue: [], isWorking: false }
  const emit = vi.fn()
  const result = await compressHistory(fixtures.messages, null, 'session', '', undefined, state, 20_000, emit,
    new Map([['session', state]]), { allowHermesFallback: false }, { triggerTokens: 16_000, tailMessageCount: 1 })
  expect(emit).toHaveBeenCalledWith('compression.completed', expect.objectContaining({ llmCompressed: true }))
  return result
}

it.each(['automatic', 'manual'] as const)('%s compression follows Studio main model instead of Hermes projection', async kind => {
  fixtures.config.auxiliary = { compression: { provider: 'main' } }
  const historyBefore = structuredClone(fixtures.messages)
  const result = await compress(kind)
  expect(fixtures.requests[0]).toMatchObject({ provider: 'relay', body: { model: 'summary/family/model', stream: true } })
  expect(fixtures.upstream[0]).toMatchObject({ profile: 'work', apiKey: 'relay-secret', body: { model: 'summary/family/model', stream: true } })
  expect(result).toEqual([{ role: 'user', content: `${SUMMARY_PREFIX}\n\n${summary}` }, historyBefore.at(-1)])
  expect(fixtures.messages).toEqual(historyBefore)
  expect(fixtures.save).toHaveBeenCalledWith('session', summary, 2, 4, undefined, 3)
  expect(fixtures.bridge).not.toHaveBeenCalled()
  expect(fixtures.run.mock.calls[0][0]).toMatchObject({ toolsEnabled: false, skillsEnabled: false, runtimeInstructions: [], maxSteps: 1 })
})

it.each([
  ['unset', undefined], ['auto', { provider: 'auto' }],
  ['explicit', { provider: 'deepseek', model: 'family/model' }],
] as const)('keeps the existing %s compression selection', async (_label, selection) => {
  fixtures.config.auxiliary = { compression: selection }
  await compress('automatic')
  expect(fixtures.requests[0]).toMatchObject({ provider: 'deepseek', body: { model: 'family/model' } })
  expect(fixtures.upstream).toHaveLength(1)
})

it('uses an explicit auxiliary model instead of the session or global model', async () => {
  fixtures.config.model = { provider: 'deepseek', default: 'family/model' }
  fixtures.config.auxiliary = { compression: { provider: 'relay', model: 'summary/family/model' } }
  await compress('manual')
  expect(fixtures.upstream[0]).toMatchObject({ apiKey: 'relay-secret', body: { model: 'summary/family/model' } })
})

it('preserves cursor snapshot writes and the session history revision', async () => {
  fixtures.messages = fixtures.messages.map((message, index) => ({ ...message, cursorId: index + 10 }))
  await compress('manual')
  expect(fixtures.save).toHaveBeenCalledWith('session', summary, 2, 4, {
    compressedThroughMessageId: 12, protectedHeadThroughMessageId: null, expectedHistoryRevision: 3,
  })
})

it.each(['ekkostudio', 'custom:ekkostudio'])('normalizes an old %s auxiliary route and merges the previous snapshot', async provider => {
  fixtures.config.auxiliary = { compression: { provider, model: 'old%2Froute/summary/family/model' } }
  fixtures.snapshot = { summary: 'Earlier decision: retain legacy sessions.', lastMessageIndex: 0 }
  const previous = structuredClone(fixtures.snapshot)
  await compress('manual')
  expect(fixtures.requests[0]).toMatchObject({ provider: 'relay', body: { model: 'summary/family/model' } })
  expect(fixtures.upstream).toHaveLength(1)
  expect(JSON.stringify(fixtures.upstream[0].body)).toContain(previous.summary)
  expect(fixtures.snapshot).toEqual(previous)
  expect(fixtures.save).toHaveBeenCalled()
})

it('normalizes projected session fallback models for automatic compression', async () => {
  fixtures.session.provider = 'ekkostudio'
  fixtures.session.model = 'deepseek/family/model'
  await compress('automatic')
  expect(fixtures.requests[0]).toMatchObject({ provider: 'deepseek', body: { model: 'family/model' } })
})

it('normalizes direct summarizer requests without changing slash-containing model names', async () => {
  const result = await callSummarizer('', undefined, 'Summarize the task.', [], 10_000, undefined,
    { profile: 'work', provider: 'ekkostudio', model: 'deepseek/family/model', allowHermesFallback: false })
  expect(result).toBe(summary)
  expect(fixtures.requests[0]).toMatchObject({ provider: 'deepseek', body: { model: 'family/model' } })
})

it('rejects unknown projected routes without overwriting the previous summary or history', async () => {
  fixtures.config.auxiliary = { compression: { provider: 'ekkostudio', model: 'missing/family/model' } }
  fixtures.snapshot = { summary: 'Keep this snapshot.', lastMessageIndex: 0 }
  const previous = structuredClone({ snapshot: fixtures.snapshot, history: fixtures.messages })
  await expect(forceCompressBridgeHistory('session', 'work', [], undefined,
    { force: true, allowHermesFallback: false })).rejects.toThrow('Studio model route is not available')
  expect(fixtures.upstream).toHaveLength(0)
  expect(fixtures.save).not.toHaveBeenCalled()
  expect({ snapshot: fixtures.snapshot, history: fixtures.messages }).toEqual(previous)
})

async function registerSummarizer(
  handler: PluginCompressionSummarizer, permissions: PluginPermission[] = ['compression'],
) {
  const runtime = new PluginRuntime({
    directory: fixtures.home, source: fixtures.home, installedAt: 0, config: {}, enabled: true,
    manifest: { id: 'summary-plugin', name: 'Summary', version: '1.0.0', apiVersion: 1, server: 'server.mjs', permissions },
  }, { userId: 1, profile: 'admin' }, new PluginStore(fixtures.home), {
    authorize(identity) {
      if (identity.userId !== 7 || identity.profile !== 'work' || identity.sessionId !== 'session') throw new Error('Wrong session scope')
    },
    api: async () => null, emit() {}, log() {},
  })
  fixtures.plugin = runtime
  await runtime.load({ apply(ctx) { return ctx.extensions.compression.register(handler) } })
  runtime.activate()
}

function sessionTransport(runtime: 'hermes' | 'ekko-agent') {
  if (runtime === 'hermes') fixtures.session = { ...fixtures.session, source: 'cli', agent: '' }
  const { id: sessionId, profile } = fixtures.session
  const emit = vi.fn()
  const state: SessionState = { messages: [], events: [], queue: [], isWorking: false }
  const sessionMap = new Map([[sessionId, state]])
  const nsp = { to: () => ({ emit }), adapter: { rooms: new Map() } } as unknown as Namespace
  const socket = { join: vi.fn(), data: { user: { id: 7 } } } as unknown as Socket
  const dequeue = vi.fn(() => false)
  async function command(input: string) {
    if (runtime === 'hermes') {
      const parsed = parseSessionCommand(input)
      if (!parsed) throw new Error(`Hermes did not parse ${input}`)
      await handleSessionCommand(sessionId, parsed, { nsp, socket, sessionMap, profile, bridge: {}, runQueuedItem: dequeue })
    } else {
      const data = { input, session_id: sessionId }
      const parsed = parseEkkoRunCommand(data, fixtures.session.source)
      if (!parsed) throw new Error(`Ekko did not parse ${input}`)
      await handleEkkoSessionCommand(nsp, socket, data, parsed, profile, sessionMap, dequeue)
    }
  }
  return { nsp, socket, state, sessionMap, sessionId, profile, emit, dequeue, command }
}

it.each([
  ['hermes', '/compress', 'compress'],
  ['hermes', '/compact', 'compress'],
  ['ekko-agent', '/compact', 'compact'],
  ['ekko-agent', '/compress', 'compact'],
] as const)('runs %s %s through the real manual compression command handler', async (runtime, input, action) => {
  const session = sessionTransport(runtime)
  const handler = vi.fn<PluginCompressionSummarizer>(() => {
    expect(runtime === 'hermes' ? session.state.isCompressing : session.state.isWorking).toBe(true)
    return 'Summary from the command handler.'
  })
  await registerSummarizer(handler)

  await session.command(input)

  expect(handler).toHaveBeenCalledOnce()
  expect(session.emit).toHaveBeenCalledWith('compression.started', expect.objectContaining({ source: 'command' }))
  expect(session.emit).toHaveBeenCalledWith('compression.completed', expect.objectContaining({ source: 'command', compressed: true }))
  expect(session.emit).toHaveBeenCalledWith('session.command', expect.objectContaining({ command: input.slice(1), action, ok: true }))
  expect(fixtures.save).toHaveBeenCalledExactlyOnceWith('session', 'Summary from the command handler.', 2, 4, undefined, 3)
  expect(session.state.isWorking || session.state.isCompressing).toBeFalsy()
  expect(fixtures.run).not.toHaveBeenCalled()
})

it.each([['hermes', '/compress'], ['ekko-agent', '/compact']] as const)('rejects a busy %s manual command and releases its reservation on compression failure', async (runtime, input) => {
  const session = sessionTransport(runtime)
  const handler = vi.fn<PluginCompressionSummarizer>().mockReturnValue('Summary discarded by the snapshot revision check.')
  await registerSummarizer(handler)
  session.state.isWorking = true
  await session.command(input)
  expect(handler).not.toHaveBeenCalled()
  expect(session.emit).toHaveBeenCalledWith('session.command', expect.objectContaining({ ok: false, terminal: false }))
  expect(session.state.isWorking).toBe(true)

  session.state.isWorking = false
  fixtures.save.mockReturnValue(false)
  await session.command(input)
  expect(handler).toHaveBeenCalledOnce()
  expect(session.emit).toHaveBeenLastCalledWith('session.command', expect.objectContaining({ ok: false, message: expect.stringContaining('Compression snapshot changed') }))
  expect(session.state.isWorking || session.state.isCompressing).toBeFalsy()
})

it.each(['plugin summary', 'built-in fallback'] as const)('returns the %s to a running Hermes bridge and lets the run complete', async outcome => {
  const session = sessionTransport('hermes')
  const newSummary = outcome === 'plugin summary' ? 'Summary for the bridge.' : summary
  const handler = vi.fn<PluginCompressionSummarizer>(() => {
    if (outcome === 'built-in fallback') throw new Error('Plugin failed')
    return newSummary
  })
  await registerSummarizer(handler)

  const run = { ok: true, run_id: 'run', session_id: session.sessionId, delta: '', cursor: 0, error: null }
  const compressionRespond = vi.fn(async () => ({ ok: true }))
  const bridge = {
    getResult: vi.fn(async () => ({ ok: true, deltas: [], events: [], output: '' })),
    getOutput: vi.fn().mockResolvedValueOnce({
      ...run, status: 'running', done: false, event_cursor: 1,
      events: [{ event: 'bridge.compression.requested', request_id: 'compaction', messages: fixtures.messages }],
    }).mockImplementationOnce(async () => {
      expect(compressionRespond).toHaveBeenCalledExactlyOnceWith('compaction', {
        messages: [{ role: 'user', content: `${SUMMARY_PREFIX}\n\n${newSummary}` }, fixtures.messages.at(-1)],
      })
      return {
        ...run, status: 'completed', done: true, event_cursor: 2, output: 'The run continued.',
        events: [{ event: 'bridge.compression.completed', request_id: 'compaction', compressed: true }],
      }
    }),
    compressionRespond,
    contextEstimate: vi.fn(async () => ({ fixed_context_tokens: 100 })),
    goalEvaluate: vi.fn(async () => ({ should_continue: false })),
  }
  await resumeBridgeRun(session.nsp, session.socket, {
    sessionId: session.sessionId, profile: session.profile, runId: 'run', instructions: '',
  }, session.sessionMap, bridge, session.dequeue)

  expect(handler).toHaveBeenCalledOnce()
  expect(fixtures.run).toHaveBeenCalledTimes(outcome === 'built-in fallback' ? 1 : 0)
  expect(fixtures.save).toHaveBeenCalledExactlyOnceWith('session', newSummary, 2, 4, undefined, 3)
  expect(session.emit).toHaveBeenCalledWith('compression.started', expect.objectContaining({ request_id: 'compaction', source: 'bridge' }))
  expect(session.emit).toHaveBeenCalledWith('compression.completed', expect.objectContaining({ request_id: 'compaction', source: 'bridge', compressed: true }))
  expect(session.emit).toHaveBeenCalledWith('run.completed', expect.objectContaining({ run_id: 'run' }))
  expect(session.state.bridgeCompressionResults).toEqual({})
  expect(session.state.isWorking).toBe(false)
})

it.each([
  ['cli', '', 'hermes', 'automatic'],
  ['cli', '', 'hermes', 'manual'],
  ['builtin_agent', 'ekko-agent', 'ekko-agent', 'automatic'],
  ['builtin_agent', 'ekko-agent', 'ekko-agent', 'manual'],
] as const)('uses the selected plugin for %s %s %s %s compression', async (source, agent, runtime, kind) => {
  fixtures.session = { ...fixtures.session, source, agent }
  fixtures.messages = [
    { role: 'user', content: 'Keep this older decision.' },
    { role: 'assistant', content: 'Older response.' },
    ...fixtures.messages,
  ].map((message, index) => ({ ...message, cursorId: index + 10 }))
  const before = structuredClone(fixtures.messages)
  const pluginSummary = 'A custom checkpoint summary.'
  const handler = vi.fn<PluginCompressionSummarizer>().mockReturnValue(pluginSummary)
  await registerSummarizer(handler)

  const messages = kind === 'automatic'
    ? await buildCompressedHistory('session', 'work', '', undefined, vi.fn(), new Map(), { allowHermesFallback: false }, async () => 20_000, 0, false)
    : await compress('manual')

  expect(handler).toHaveBeenCalledOnce()
  const [input, ctx] = handler.mock.calls[0]
  expect(input).toEqual({
    transcript: expect.stringContaining('Keep this older decision.'),
    history: before.slice(0, -1).map(({ role, content }) => ({ role, content })),
    summaryBudget: 3200,
  })
  expect(input.transcript).not.toContain(before.at(-1)!.content)
  expect(ctx.identity).toMatchObject({ userId: 7, profile: 'work', sessionId: 'session', runtime })
  expect(messages).toMatchObject([{ role: 'user', content: `${SUMMARY_PREFIX}\n\n${pluginSummary}` }, { content: before.at(-1)!.content }])
  expect(fixtures.messages).toEqual(before)
  expect(fixtures.save).toHaveBeenCalledExactlyOnceWith('session', pluginSummary, 4, 6, {
    compressedThroughMessageId: 14, protectedHeadThroughMessageId: null, expectedHistoryRevision: 3,
  })
  expect(fixtures.run).not.toHaveBeenCalled()
})

it('passes an existing summary to the plugin on incremental compression', async () => {
  fixtures.snapshot = { summary: 'Previous checkpoint.', lastMessageIndex: 0 }
  const handler = vi.fn<PluginCompressionSummarizer>().mockReturnValue('Updated checkpoint.')
  await registerSummarizer(handler)
  await compress('manual')
  expect(handler.mock.calls[0][0]).toMatchObject({
    previousSummary: 'Previous checkpoint.',
    history: fixtures.messages.slice(1, -1),
  })
  expect(handler.mock.calls[0][0].transcript).not.toContain(fixtures.messages[0].content)
  expect(fixtures.save).toHaveBeenCalledExactlyOnceWith('session', 'Updated checkpoint.', 2, 4, undefined, 3)
})

it('gives the plugin detached content blocks and paired tool calls for only the selected segment', async () => {
  fixtures.policy.protect_first_n = 1
  const image = { type: 'image', path: 'diagram.png', source: { type: 'base64', data: 'sample-bytes' } }
  const toolCall = { id: 'lookup-1', type: 'function', function: { name: 'lookup', arguments: JSON.stringify({ input: 'a'.repeat(1800) }) } }
  fixtures.messages = [
    { role: 'user', content: 'Protected head.' },
    { role: 'user', content: [{ type: 'text', text: 'Check the diagram.' }, image], cursorId: 11 },
    { role: 'assistant', content: '', tool_calls: [toolCall], reasoning_content: 'Internal reasoning.' },
    { role: 'tool', content: 'start ' + 'a'.repeat(6000) + ' end', name: 'lookup', tool_call_id: 'lookup-1' },
    { role: 'assistant', content: 'Protected tail.' },
  ]
  const handler = vi.fn<PluginCompressionSummarizer>().mockReturnValue('Summary of the lookup.')
  await registerSummarizer(handler)
  await compress('manual')

  const { history } = handler.mock.calls[0][0]
  expect(history).toEqual([
    { role: 'user', content: [{ type: 'text', text: 'Check the diagram.' }, { type: 'image', path: 'diagram.png' }] },
    { role: 'assistant', content: '', tool_calls: [toolCall] },
    { role: 'tool', content: expect.stringMatching(/^start .*\[truncated\].* end$/s), name: 'lookup', tool_call_id: 'lookup-1' },
  ])
  expect(history[0].content[1]).not.toBe(image)
  expect(history[1].tool_calls?.[0].function).not.toBe(toolCall.function)
})

it('keeps history verbatim below the automatic compression threshold', async () => {
  const handler = vi.fn<PluginCompressionSummarizer>().mockReturnValue('Unexpected summary.')
  await registerSummarizer(handler)
  const history = await buildCompressedHistory('session', 'work', '', undefined, vi.fn(), new Map(), {}, async () => 1000)
  expect(history).toEqual(fixtures.messages)
  expect(fixtures.pluginLookup).not.toHaveBeenCalled()
  expect(fixtures.save).not.toHaveBeenCalled()
})

it.each(['hermes', 'ekko-agent'] as const)('automatically falls back to built-in summarization for %s', async runtime => {
  const session = sessionTransport(runtime)
  fixtures.messages = [
    { role: 'user', content: 'Earlier question.' },
    { role: 'assistant', content: 'Earlier answer.' },
    ...fixtures.messages,
  ]
  const handler = vi.fn<PluginCompressionSummarizer>(() => { throw new Error('Plugin failed') })
  await registerSummarizer(handler)

  const history = await buildCompressedHistory(
    session.sessionId, session.profile, '', undefined, session.emit, session.sessionMap,
    { allowHermesFallback: runtime === 'hermes' }, async () => 20_000, 0, false,
  )

  expect(handler).toHaveBeenCalledOnce()
  expect(fixtures.run).toHaveBeenCalledOnce()
  expect(history).toEqual([{ role: 'user', content: `${SUMMARY_PREFIX}\n\n${summary}` }, fixtures.messages.at(-1)])
  expect(session.emit).toHaveBeenCalledWith('compression.completed', expect.objectContaining({ compressed: true, llmCompressed: true }))
  expect(fixtures.save).toHaveBeenCalledExactlyOnceWith('session', summary, 4, 6, undefined, 3)
})

it('retains the existing history revision check for plugin summaries', async () => {
  fixtures.save.mockReturnValue(false)
  await registerSummarizer(() => 'A summary generated before a concurrent history change.')
  await expect(forceCompressBridgeHistory('session', 'work', [], undefined, { force: true, excludeLastUser: false }))
    .rejects.toThrow('Compression snapshot changed while summarizing')
  expect(fixtures.save).toHaveBeenCalledOnce()
  expect(fixtures.run).not.toHaveBeenCalled()
})

it.each(['no active plugin', 'group_chat', 'workflow', 'global_agent'] as const)('uses Studio summarization for %s', async scope => {
  const handler = vi.fn<PluginCompressionSummarizer>().mockReturnValue('Unexpected summary.')
  if (scope !== 'no active plugin') {
    fixtures.session.source = scope
    await registerSummarizer(handler)
  }
  await compress('manual')
  expect(fixtures.pluginLookup).toHaveBeenCalledTimes(scope === 'no active plugin' ? 1 : 0)
  expect(handler).not.toHaveBeenCalled()
  expect(fixtures.save).toHaveBeenCalledExactlyOnceWith('session', summary, 2, 4, undefined, 3)
})

it.each([
  ['declined', () => null],
  ['invalid', () => '  '],
  ['over budget', () => ' word'.repeat(3500)],
  ['thrown error', () => { throw new Error('Plugin error') }],
] as const)('falls back to the built-in summarizer when the plugin is %s', async (_case, handler) => {
  await registerSummarizer(handler)
  await compress('manual')
  expect(fixtures.run).toHaveBeenCalledOnce()
  expect(fixtures.save).toHaveBeenCalledExactlyOnceWith('session', summary, 2, 4, undefined, 3)
})

it('falls back on timeout even while plugin cleanup is pending', async () => {
  let started!: () => void
  let finishCleanup!: () => void
  const cleanupStarted = new Promise<void>(resolve => { started = resolve })
  const cleanup = new Promise<void>(resolve => { finishCleanup = resolve })
  const deadline = new AbortController()
  const originalTimeout = AbortSignal.timeout.bind(AbortSignal)
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => ms === 10_000 ? deadline.signal : originalTimeout(ms))
  await registerSummarizer((_input, ctx) => {
    ctx.lifecycle.add(() => { started(); return cleanup })
    return 'A summary with blocked cleanup.'
  })
  try {
    const result = compress('manual')
    await cleanupStarted
    deadline.abort(new DOMException('Deadline exceeded', 'TimeoutError'))
    await result
    expect(fixtures.run).toHaveBeenCalledOnce()
    expect(fixtures.save).toHaveBeenCalledExactlyOnceWith('session', summary, 2, 4, undefined, 3)
  } finally {
    finishCleanup()
    timeout.mockRestore()
  }
})

it('requires the compression permission to register a summarizer', async () => {
  await expect(registerSummarizer(() => null, [])).rejects.toThrow('Plugin requires compression')
})
