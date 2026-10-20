import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as DatabaseSync | null }))
const readConfig = vi.hoisted(() => vi.fn())
const resolveRuntime = vi.hoisted(() => vi.fn())
const createClient = vi.hoisted(() => vi.fn())
const resolveConfigs = vi.hoisted(() => vi.fn())
const authorizedFetch = vi.hoisted(() => vi.fn())
const warn = vi.hoisted(() => vi.fn())
vi.mock('../../packages/server/src/modules/studio/infrastructure/database', () => ({ getDb: () => state.db, isSqliteAvailable: () => true }))
vi.mock('../../packages/server/src/modules/studio/public/profile-config', () => ({ readConfigYamlForProfile: readConfig }))
vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({ logger: { warn, info: vi.fn() } }))
vi.mock('../../packages/server/src/modules/studio/public/chat-agent-runtime', () => ({
  resolveChatEkkoProviderRuntimeConfig: resolveRuntime,
  resolveChatEkkoModelProviderConfigs: resolveConfigs,
  createChatEkkoModelClient: createClient,
  createChatEkkoAuthorizedProviderFetch: authorizedFetch,
}))
vi.mock('../../packages/server/src/modules/studio/repositories/compression-snapshot', () => ({ copyCompressionSnapshot: vi.fn() }))
vi.mock('../../packages/server/src/modules/studio/repositories/skill-usage-store', () => ({ recordSkillUsageMessage: vi.fn() }))
vi.mock('../../packages/server/src/modules/studio/repositories/usage-store', () => ({ getRecordedSessionTokensBatch: () => ({}) }))
import { SESSIONS_SCHEMA, MESSAGES_SCHEMA, TASK_PLANS_SCHEMA, COMPRESSION_SNAPSHOT_SCHEMA } from '../../packages/server/src/modules/studio/infrastructure/database/schemas'
import { clearSessionMessages, createSession, deleteSession, renameSession, updateSession } from '../../packages/server/src/modules/studio/repositories/session-store'
import { generateEkkoAutoTitle, prepareEkkoAutoTitle } from '../../packages/server/src/modules/studio/services/chat-run/ekko-auto-title'

function row() { return state.db!.prepare('SELECT * FROM sessions WHERE id = ?').get('s') as Record<string, any> | undefined }
function seed(origin: 'fallback' | 'manual' = 'fallback') {
  createSession({ id: 's', profile: 'p', source: 'builtin_agent', agent: 'ekko-agent', title: 'Explain async titles', title_origin: origin })
  const insert = state.db!.prepare('INSERT INTO messages(session_id, role, content, timestamp) VALUES (?, ?, ?, ?)')
  insert.run('s', 'user', 'Explain async titles', 1)
  return String(insert.run('s', 'assistant', 'Here is an explanation', 2).lastInsertRowid)
}
function harness() {
  const replyId = seed()
  const client = { capabilities: { streaming: false }, create: vi.fn(async (_request: any) => ({ content: 'Async conversation titles' })) }
  const emit = vi.fn()
  const options = { snapshot: prepareEkkoAutoTitle('s'), replyId, reply: 'Here is an explanation', provider: 'openai-codex', model: 'test-model', modelClient: client, emit }
  return { client, emit, options }
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
beforeEach(() => {
  vi.clearAllMocks()
  readConfig.mockResolvedValue({})
  resolveRuntime.mockResolvedValue({ provider: 'custom:title', baseUrl: 'https://safe.test', apiKey: 'resolved-key', apiMode: 'chat_completions' })
  resolveConfigs.mockReturnValue({ providerConfig: { defaultModel: 'title-model' } })
  state.db = new DatabaseSync(':memory:')
  for (const [name, schema] of Object.entries({ sessions: SESSIONS_SCHEMA, messages: MESSAGES_SCHEMA, task_plans: TASK_PLANS_SCHEMA, chat_compression_snapshots: COMPRESSION_SNAPSHOT_SCHEMA })) {
    state.db.exec(`CREATE TABLE ${name} (${Object.entries(schema).map(([key, type]) => `"${key}" ${type}`).join(', ')})`)
  }
})
afterEach(() => { vi.useRealTimers(); state.db?.close(); state.db = null })

describe('Native Ekko asynchronous AI conversation titles', () => {
  it('uses the session model without tools and persists AI provenance before notifying clients', async () => {
    const { client, emit, options } = harness()
    emit.mockImplementation(() => expect(row()?.title_origin).toBe('ai'))
    await generateEkkoAutoTitle(options)
    expect(client.create).toHaveBeenCalledWith(expect.objectContaining({ model: 'test-model', tools: [], toolChoice: 'none' }))
    expect(row()?.title).toBe('Async conversation titles')
    expect(row()?.title_generation_attempts).toBe(1)
    expect(emit).toHaveBeenCalledWith('session.title.updated', expect.objectContaining({ session_id: 's', title: 'Async conversation titles' }))
  })
  it('does not regenerate an AI title', async () => {
    const { client, options } = harness()
    await generateEkkoAutoTitle(options)
    await generateEkkoAutoTitle({ ...options, snapshot: prepareEkkoAutoTitle('s') })
    expect(client.create).toHaveBeenCalledTimes(1)
  })
  it('protects explicit manual names even when identical to the fallback', () => {
    seed('manual')
    expect(prepareEkkoAutoTitle('s')).toBeNull()
  })
  it('recognizes a legacy first-input fallback', () => {
    seed()
    state.db!.prepare("UPDATE sessions SET title_origin = ''").run()
    expect(prepareEkkoAutoTitle('s')).not.toBeNull()
    state.db!.prepare("UPDATE sessions SET title = 'Human topic'").run()
    expect(prepareEkkoAutoTitle('s')).toBeNull()
  })
  it('does not trigger for group-chat sessions', () => {
    seed()
    state.db!.prepare("UPDATE sessions SET source = 'group_chat'").run()
    expect(prepareEkkoAutoTitle('s')).toBeNull()
  })
  it.each(['renamed', 'cleared', 'deleted', 'recreated', 'updated'])('discards pending results after the session is %s', async action => {
    const { client, emit, options } = harness()
    const pending = deferred<{ content: string }>()
    client.create.mockReturnValueOnce(pending.promise)
    const task = generateEkkoAutoTitle(options)
    await vi.waitFor(() => expect(client.create).toHaveBeenCalledOnce())
    if (action === 'renamed') renameSession('s', 'Human title')
    if (action === 'cleared') clearSessionMessages('s')
    if (action === 'deleted') deleteSession('s')
    if (action === 'recreated') { deleteSession('s'); seed() }
    if (action === 'updated') updateSession('s', { title: 'Human title' })
    pending.resolve({ content: 'Stale AI title' })
    await task
    expect(row()?.title).not.toBe('Stale AI title')
    expect(emit).not.toHaveBeenCalled()
  })
  it('deduplicates concurrent title requests', async () => {
    const { client, options } = harness()
    const pending = deferred<{ content: string }>()
    client.create.mockReturnValueOnce(pending.promise)
    const task = generateEkkoAutoTitle(options)
    await vi.waitFor(() => expect(client.create).toHaveBeenCalledOnce())
    await generateEkkoAutoTitle(options)
    pending.resolve({ content: 'One title' })
    await task
    expect(client.create).toHaveBeenCalledOnce()
  })
  it('bounds failures across subsequent turns and sanitizes provider exceptions', async () => {
    const { client, emit, options } = harness()
    client.create.mockRejectedValue(new Error('secret-key echoed-provider-content'))
    await generateEkkoAutoTitle(options)
    await generateEkkoAutoTitle(options)
    expect(client.create).toHaveBeenCalledTimes(2)
    expect(row()?.title_generation_attempts).toBe(2)
    expect(emit).not.toHaveBeenCalled()
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret-key')
  })
  it.each(['', 'line one\nline two', 'x'.repeat(101)])('rejects malformed title output %j', async content => {
    const { client, emit, options } = harness()
    client.create.mockResolvedValue({ content })
    await generateEkkoAutoTitle(options)
    expect(row()?.title_origin).toBe('fallback')
    expect(emit).not.toHaveBeenCalled()
  })
  it('accepts a streamed response and strips wrapping quotes', async () => {
    const { emit, options } = harness()
    const client = { capabilities: { streaming: true }, async *stream() { yield { type: 'text-delta', text: '“Streaming title”' }; yield { type: 'done' } } }
    await generateEkkoAutoTitle({ ...options, modelClient: client })
    expect(row()?.title).toBe('Streaming title')
    expect(emit).toHaveBeenCalledOnce()
  })
  it('does not write a tool-call response as a title', async () => {
    const { emit, options } = harness()
    const client = { capabilities: { streaming: true }, async *stream() { yield { type: 'tool-call', toolCall: { name: 'bad' } } } }
    await generateEkkoAutoTitle({ ...options, modelClient: client })
    expect(emit).not.toHaveBeenCalled()
  })
  it('resolves explicit auxiliary providers through authorized runtime configuration', async () => {
    readConfig.mockResolvedValue({ auxiliary: { title_generation: { provider: 'custom:title', model: 'title-model', timeout: 8 } } })
    const { client, options } = harness()
    const auxiliary = { create: vi.fn(async () => ({ content: 'Auxiliary title' })) }
    createClient.mockReturnValue(auxiliary)
    await generateEkkoAutoTitle(options)
    expect(client.create).not.toHaveBeenCalled()
    expect(resolveRuntime).toHaveBeenCalledWith(expect.objectContaining({ profile: 'p', provider: 'custom:title', model: 'title-model' }))
    expect(resolveRuntime.mock.calls[0][0].apiKey).toBeUndefined()
    expect(authorizedFetch).toHaveBeenCalledWith(expect.objectContaining({ provider: 'custom:title', model: 'title-model' }))
    expect(row()?.title).toBe('Auxiliary title')
  })
  it('does not silently fall back after an auxiliary provider authorization denial', async () => {
    readConfig.mockResolvedValue({ auxiliary: { title_generation: { provider: 'disabled', model: 'title-model' } } })
    resolveRuntime.mockRejectedValue(new Error('disabled secret-key'))
    const { client, options } = harness()
    await generateEkkoAutoTitle(options)
    expect(client.create).not.toHaveBeenCalled()
    expect(createClient).not.toHaveBeenCalled()
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret-key')
  })
  it('aborts timed-out requests and ignores a late result', async () => {
    vi.useFakeTimers()
    readConfig.mockResolvedValue({ auxiliary: { title_generation: { provider: 'auto', timeout: 1 } } })
    const { client, emit, options } = harness()
    const pending = deferred<{ content: string }>()
    client.create.mockReturnValue(pending.promise)
    const task = generateEkkoAutoTitle(options)
    await vi.advanceTimersByTimeAsync(2100)
    await task
    expect(client.create).toHaveBeenCalledTimes(2)
    expect(client.create.mock.calls[0][0].signal.aborted).toBe(true)
    pending.resolve({ content: 'Late result' })
    await vi.advanceTimersByTimeAsync(0)
    expect(emit).not.toHaveBeenCalled()
  })
  it('does not consume attempts for empty replies or missing assistant anchors', async () => {
    const { client, options } = harness()
    await generateEkkoAutoTitle({ ...options, reply: ' ' })
    await generateEkkoAutoTitle({ ...options, replyId: null })
    await generateEkkoAutoTitle({ ...options, replyId: '99999' })
    expect(client.create).not.toHaveBeenCalled()
    expect(row()?.title_generation_attempts).toBe(0)
  })
})
