import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest'

let db: DatabaseSync
const mocks = vi.hoisted(() => ({ config: { appHome: '' }, create: vi.fn(), stream: vi.fn(), pricing: vi.fn() }))
vi.mock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({ getDb: () => db, isSqliteAvailable: () => true, getStoragePath: () => ':memory:' }))
vi.mock('../../packages/server/src/modules/studio/public/config', () => ({ config: mocks.config }))
vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({ logger: { warn: vi.fn() } }))
vi.mock('../../packages/server/src/modules/studio/public/session-agent-runtime', () => ({ getSessionAvailableModelGroups: async () => [{ provider: 'p', models: ['model'], api_mode: 'chat_completions' }] }))
vi.mock('../../packages/server/src/modules/studio/public/chat-agent-runtime', () => ({
  resolveChatEkkoProviderRuntimeConfig: async () => ({ apiKey: 'private', baseUrl: 'https://provider.test' }),
  resolveChatEkkoModelProviderConfigs: () => ({ providerConfig: { requestStyle: 'openai-chat' } }),
  createChatEkkoAuthorizedProviderFetch: vi.fn(),
  createChatEkkoModelClient: () => ({ capabilities: { vision: false }, create: mocks.create, stream: mocks.stream }),
}))
vi.mock('../../packages/server/src/modules/studio/repositories/usage-pricing-store', () => ({ getUsagePricing: mocks.pricing }))
vi.mock('../../packages/server/src/modules/studio/public/model-catalog', () => ({ getModelCatalogSnapshot: () => undefined, refreshModelCatalog: async () => undefined }))

import { initAllHermesTables } from '../../packages/server/src/modules/studio/infrastructure/database/schemas'
import { createModelApiKey } from '../../packages/server/src/modules/studio/services/model-api/keys'
import { getModelApiKey, updateModelApiKey } from '../../packages/server/src/modules/studio/repositories/model-api-keys-store'
import { fillMissingUsageCost, updateUsage } from '../../packages/server/src/modules/studio/repositories/usage-store'
import { prepareModelResponse } from '../../packages/server/src/modules/studio/services/model-api/service'
import { checkModelApiBudget, startModelApiKeyRequest } from '../../packages/server/src/modules/studio/services/model-api/budget'
import { modelApiErrorBody } from '../../packages/server/src/modules/studio/services/model-api/errors'

const dir = mkdtempSync(join(tmpdir(), 'model-key-budget-'))
mocks.config.appHome = dir
afterAll(() => rmSync(dir, { recursive: true, force: true }))
beforeEach(() => {
  vi.clearAllMocks()
  db = new DatabaseSync(':memory:')
  initAllHermesTables()
  mocks.pricing.mockReturnValue([{ provider: 'p', model: 'model', input: 10, output: 20 }])
  mocks.create.mockResolvedValue({ content: 'Hello', usage: { inputTokens: 100, outputTokens: 50 } })
  mocks.stream.mockImplementation(async function* () {
    yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 50 } }
    yield { type: 'done', response: { content: 'Hello', usage: { inputTokens: 100, outputTokens: 50 } } }
  })
})
afterEach(() => db.close())
const key = (budget: number | null = 0.003) => createModelApiKey(7, 'client', ['p/model'], budget).key
const prepare = (id: string, stream = false) => prepareModelResponse({ profiles: ['default'], accountId: '7', apiKeyId: id, allowedModels: ['p/model'], body: { model: 'p/model', input: 'hi', stream }, signal: new AbortController().signal })
async function call(id: string, stream = false) {
  const request = await prepare(id, stream)
  if (stream) { for await (const _event of request.events()) {} }
  else await request.create()
}

it.each([false, true])('settles JSON/SSE costs once, and rejects new requests after the USD budget is exhausted (stream=%s)', async stream => {
  const k = key()
  await call(k.id, stream)
  expect(getModelApiKey(7, k.id)).toMatchObject({ spentUsd: 0.002, budgetUsd: 0.003, unpricedRequests: 0 })
  await call(k.id, stream)
  expect(getModelApiKey(7, k.id)?.spentUsd).toBe(0.004)
  await expect(prepare(k.id, stream)).rejects.toMatchObject({ status: 429, code: 'insufficient_quota' })
  expect(mocks.create.mock.calls.length + mocks.stream.mock.calls.length).toBe(2)
  expect(db.prepare('SELECT COUNT(*) AS n FROM session_usage').get()).toMatchObject({ n: 2 })
})

it('zero blocks immediately, while raising or removing the budget preserves lifetime spending', async () => {
  const k = key(0)
  await expect(prepare(k.id)).rejects.toMatchObject({ status: 429 })
  updateModelApiKey(7, k.id, k.name, k.models, 0.002)
  await call(k.id)
  expect(() => checkModelApiBudget(7, k.id)).toThrow('exhausted')
  updateModelApiKey(7, k.id, 'renamed', k.models, 0.001)
  expect(() => checkModelApiBudget(7, k.id)).toThrow('exhausted')
  updateModelApiKey(7, k.id, 'renamed', k.models, 1)
  await call(k.id)
  updateModelApiKey(7, k.id, 'renamed', k.models, null)
  expect(getModelApiKey(7, k.id)).toMatchObject({ spentUsd: 0.004, budgetUsd: null })
  expect(() => checkModelApiBudget(7, k.id)).not.toThrow()
})

it('counts concurrent completions without lost updates and then blocks admission', async () => {
  const k = key()
  let finish!: () => void
  const held = new Promise<void>(resolve => { finish = resolve })
  mocks.create.mockImplementation(async () => { await held; return { content: 'ok', usage: { inputTokens: 100, outputTokens: 50 } } })
  const a = await prepare(k.id), b = await prepare(k.id)
  const pending = [a.create(), b.create()]
  finish()
  await Promise.all(pending)
  expect(getModelApiKey(7, k.id)?.spentUsd).toBe(0.004)
  await expect(prepare(k.id)).rejects.toMatchObject({ status: 429 })
})

it('keeps unknown costs distinct from free calls, and delayed pricing automatically restores a limited key', async () => {
  const k = key(1)
  mocks.pricing.mockReturnValue([])
  await call(k.id)
  expect(getModelApiKey(7, k.id)).toMatchObject({ spentUsd: 0, unpricedRequests: 1 })
  await expect(prepare(k.id)).rejects.toMatchObject({ code: 'quota_cost_unknown' })
  const row = db.prepare('SELECT id FROM session_usage').get() as { id: number }
  fillMissingUsageCost(row, { costUsd: 0.05, costSource: 'estimated' })
  expect(getModelApiKey(7, k.id)).toMatchObject({ spentUsd: 0.05, unpricedRequests: 0 })
  expect(() => checkModelApiBudget(7, k.id)).not.toThrow()
})

it('preserves reported cost and usage on a failed stream, including missing-usage failures', async () => {
  const k = key(1)
  mocks.pricing.mockReturnValue([])
  mocks.stream.mockImplementation(async function* () {
    yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.2 } }
    throw new Error('disconnected')
  })
  await call(k.id, true)
  expect(getModelApiKey(7, k.id)).toMatchObject({ spentUsd: 0.2, unpricedRequests: 0 })
  mocks.create.mockRejectedValue(new Error('provider failed without usage'))
  await expect(call(k.id)).rejects.toThrow('provider failed')
  expect(getModelApiKey(7, k.id)).toMatchObject({ spentUsd: 0.2, unpricedRequests: 1 })
  await expect(prepare(k.id)).rejects.toMatchObject({ code: 'quota_cost_unknown' })
})

it('isolates keys/accounts, deduplicates request records and rechecks edits before a prepared request starts', async () => {
  const a = key(1), b = key(1)
  const data = { modelApiKeyId: a.id, runId: 'same', origin: 'external' as const, accountId: '7', source: 'model_api', inputTokens: 1, outputTokens: 1, costUsd: 0.25 }
  updateUsage('', data)
  updateUsage('', data)
  updateUsage('', { ...data, runId: 'other-user', accountId: '8', costUsd: 100 })
  expect(getModelApiKey(7, a.id)?.spentUsd).toBe(0.25)
  expect(getModelApiKey(7, b.id)?.spentUsd).toBe(0)
  const prepared = await prepare(a.id)
  const preparedStream = await prepare(a.id, true)
  updateModelApiKey(7, a.id, a.name, a.models, 0)
  await expect(prepared.create()).rejects.toMatchObject({ status: 429 })
  const events = []
  for await (const event of preparedStream.events()) events.push(event)
  expect(events.at(-1)).toMatchObject({ type: 'response.failed', response: { error: { code: 'insufficient_quota' } } })
  expect(getModelApiKey(7, a.id)?.unpricedRequests).toBe(0)
  expect(mocks.create).not.toHaveBeenCalled()
  try { checkModelApiBudget(7, a.id) } catch (error) {
    expect(modelApiErrorBody(error)).toMatchObject({ status: 429, body: { error: { type: 'insufficient_quota', code: 'insufficient_quota' } } })
  }
})

it('keeps a durable unknown entry after interrupted accounting and refuses to start when ledger writes fail', async () => {
  const k = key(1)
  const release = startModelApiKeyRequest(7, k.id, 'interrupted')
  expect(() => checkModelApiBudget(7, k.id)).not.toThrow() // Known in-flight work may continue concurrently.
  release() // Simulate a process losing the request without settlement.
  expect(() => checkModelApiBudget(7, k.id)).toThrow('unknown cost')
  const another = key(1)
  db.exec("CREATE TRIGGER reject_key_usage BEFORE INSERT ON session_usage BEGIN SELECT RAISE(ABORT, 'ledger unavailable'); END")
  await expect(call(another.id)).rejects.toThrow('ledger unavailable')
  expect(mocks.create).not.toHaveBeenCalled()
})

it('distinguishes known zero-priced requests from unknown cost', async () => {
  const k = key(1)
  mocks.pricing.mockReturnValue([{ provider: 'p', model: 'model', input: 0, output: 0 }])
  await call(k.id)
  await call(k.id)
  expect(getModelApiKey(7, k.id)).toMatchObject({ spentUsd: 0, unpricedRequests: 0 })
})

it('does not admit an extra request at an exact decimal budget boundary', () => {
  const k = key(1)
  for (const [index, costUsd] of [0.1, 0.7, 0.2].entries()) {
    updateUsage('', { modelApiKeyId: k.id, accountId: '7', origin: 'external', runId: `decimal-${index}`, source: 'model_api', inputTokens: 1, outputTokens: 1, costUsd })
  }
  expect(() => checkModelApiBudget(7, k.id)).toThrow('exhausted')
})

it('failed settlement stays unknown and blocks subsequent limited calls instead of silently losing spend', async () => {
  const k = key(1)
  db.exec("CREATE TRIGGER reject_settlement BEFORE UPDATE ON session_usage BEGIN SELECT RAISE(ABORT, 'settlement unavailable'); END")
  await expect(call(k.id)).rejects.toThrow('settlement unavailable')
  expect(mocks.create).toHaveBeenCalledTimes(1)
  expect(getModelApiKey(7, k.id)?.unpricedRequests).toBe(1)
  await expect(prepare(k.id)).rejects.toMatchObject({ code: 'quota_cost_unknown' })
})
