import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ModelClient, ModelResponse } from '../../packages/ekko-agent/src/model/types'

const fixtures = vi.hoisted(() => ({
  home: '', config: {} as any, snapshot: null as any,
  session: { profile: 'work', provider: 'deepseek', model: 'family/model', history_revision: 3 },
  messages: [] as any[], requests: [] as any[], upstream: [] as any[],
  fetch: undefined as any, run: vi.fn(), save: vi.fn(), bridge: vi.fn(),
}))

vi.mock('../../packages/server/src/modules/studio/public/config', () => ({ config: { port: 18648, get appHome() { return fixtures.home } } }))
vi.mock('../../packages/server/src/modules/studio/public/provider-config', () => ({ readConfigYamlForProfile: async () => fixtures.config }))
vi.mock('../../packages/server/src/modules/studio/public/profile-config', () => ({
  // Hermes' transport projection must not override Studio's compression choice.
  readConfigYamlForProfile: async () => ({ model: { provider: 'ekkostudio', default: 'deepseek/family/model' }, auxiliary: { compression: { provider: 'main' } } }),
}))
vi.mock('../../packages/server/src/modules/studio/services/providers/account-store', () => ({ providerAccountHome: () => fixtures.home }))
vi.mock('../../packages/server/src/modules/studio/public/provider-account', () => ({
  providerAccountId: () => 7, providerRequestProfile: () => 'work',
  withProviderAccount: (_id: unknown, task: () => unknown) => task(),
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
vi.mock('../../packages/server/src/modules/studio/public/compression-policy', () => ({
  readCompressionPolicy: async () => ({ enabled: true, threshold: 0.5, targetRatio: 0.1, protectFirstN: 0, protectLastN: 1 }),
}))
vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, bridgeLogger: { info: vi.fn(), warn: vi.fn() },
}))
vi.mock('../../packages/server/src/modules/studio/repositories/session-store', () => ({ getSession: () => fixtures.session }))
vi.mock('../../packages/server/src/modules/studio/repositories/compression-snapshot', () => ({
  getCompressionSnapshot: () => fixtures.snapshot, saveCompressionSnapshot: (...args: any[]) => fixtures.save(...args),
  deleteCompressionSnapshot: () => { fixtures.snapshot = null },
}))
vi.mock('../../packages/server/src/modules/studio/repositories/usage-store', () => ({ getUsage: () => undefined }))
vi.mock('../../packages/server/src/modules/studio/services/chat-run/context-history', () => ({
  buildDbHistory: async () => fixtures.messages, readCursorSnapshotParts: () => ({ status: 'legacy' }),
}))
vi.mock('../../packages/server/src/modules/studio/services/chat-run/load-state', () => ({ readSessionStateFromDb: vi.fn() }))
vi.mock('../../packages/server/src/modules/studio/services/chat-run/usage', () => ({
  estimateUsageTokensFromMessages: (messages: any[]) => ({ inputTokens: messages.length * 100, outputTokens: 0 }),
  calcAndUpdateUsage: async () => ({ inputTokens: 100, outputTokens: 0 }), updateMessageContextTokenUsage: vi.fn(),
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

import { compressHistory, forceCompressBridgeHistory } from '../../packages/server/src/modules/studio/services/chat-run/compression'
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
  fixtures.snapshot = null
  fixtures.session = { profile: 'work', provider: 'deepseek', model: 'family/model', history_revision: 3 }
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

afterEach(async () => { await rm(fixtures.home, { recursive: true, force: true }) })

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
