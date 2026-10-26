import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionState } from '../../packages/server/src/modules/studio/services/chat-run/types'

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(), createSession: vi.fn(), updateSession: vi.fn(), addMessage: vi.fn(() => 9), updateSessionStats: vi.fn(),
  totals: vi.fn(), latest: vi.fn(), history: vi.fn(), compact: vi.fn(), runtime: vi.fn(),
}))
vi.mock('../../packages/server/src/modules/studio/repositories/session-store', () => ({
  getSession: mocks.getSession, createSession: mocks.createSession, updateSession: mocks.updateSession, addMessage: mocks.addMessage, updateSessionStats: mocks.updateSessionStats,
}))
vi.mock('../../packages/server/src/modules/studio/repositories/usage-store', () => ({ getRecordedUsageTotals: mocks.totals, getUsage: mocks.latest }))
vi.mock('../../packages/server/src/modules/studio/public/chat-agent-runtime', () => ({ resolveChatEkkoProviderRuntimeConfig: mocks.runtime }))
vi.mock('../../packages/server/src/modules/studio/public/provider-runtime', () => ({ getModelContextLength: vi.fn(() => 1000) }))
vi.mock('../../packages/server/src/modules/studio/services/chat-run/compression', async importOriginal => ({
  ...await importOriginal<typeof import('../../packages/server/src/modules/studio/services/chat-run/compression')>(),
  buildDbSnapshotAwareHistory: mocks.history, forceCompressBridgeHistory: mocks.compact,
}))
import { handleEkkoSessionCommand, parseEkkoRunCommand, parseEkkoSessionCommand } from '../../packages/server/src/modules/studio/services/chat-run/ekko-session-command'

function fixture(working = false) {
  const emit = vi.fn()
  const nsp = { to: vi.fn(() => ({ emit })), adapter: { rooms: new Map([['session:ekko-1', new Set(['socket-1'])]]) } }
  const socket = { connected: true, data: {}, join: vi.fn(), emit: vi.fn() }
  const state: SessionState = { messages: [], isWorking: working, events: [], queue: [], inputTokens: 10000, outputTokens: 2000, ekkoContext: { fixedContextTokens: 100 } }
  const sessionMap = new Map([['ekko-1', state]])
  const dequeue = vi.fn(() => false)
  const run = (input: string) => handleEkkoSessionCommand(nsp as any, socket as any, {
    session_id: 'ekko-1', coding_agent_id: 'ekko-agent', input, model: 'requested-model', provider: 'requested-provider',
  }, parseEkkoSessionCommand(input)!, 'default', sessionMap, dequeue)
  const response = () => emit.mock.calls.filter(([event]) => event === 'session.command').at(-1)?.[1]
  return { run, state, emit, response, dequeue }
}

describe('Ekko built-in session commands', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getSession.mockReturnValue({ id: 'ekko-1', agent: 'ekko-agent', source: 'coding_agent', model: 'stored-model', provider: 'openai' })
    mocks.history.mockResolvedValue([{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'world' }])
    mocks.totals.mockReturnValue({ inputTokens: 12000, outputTokens: 3000, cacheReadTokens: 4000, cacheWriteTokens: 0 })
    mocks.latest.mockReturnValue({ model: 'stored-model' })
    mocks.runtime.mockResolvedValue({ baseUrl: 'http://model', apiKey: 'test', apiMode: 'openai' })
    mocks.compact.mockResolvedValue({ beforeMessages: 2, resultMessages: 1, beforeTokens: 4, afterTokens: 2, compressed: true, llmCompressed: true })
  })
  it.each(['context', 'usage', 'status', 'compact'])('parses /%s without borrowing external CLI commands', name => {
    expect(parseEkkoSessionCommand(` /${name.toUpperCase()} `)?.name).toBe(name)
    expect(parseEkkoSessionCommand('/plan')).toBeNull()
    expect(parseEkkoSessionCommand([{ type: 'text', text: `/${name}` }])).toBeNull()
  })
  it('keeps /compress as a compact alias', () => expect(parseEkkoSessionCommand('/compress')?.name).toBe('compact'))
  it.each(['group_chat', 'workflow'])('leaves slash-prefixed task inputs untouched on %s', source => {
    for (const input of ['/context', '/usage', '/status', '/compact', '/compress']) {
      expect(parseEkkoRunCommand({ input, source })).toBeNull()
      expect(parseEkkoRunCommand({ input, source: 'coding_agent', session_source: source })).toBeNull()
      expect(parseEkkoRunCommand({ input, source: 'coding_agent' }, source)).toBeNull()
      expect(parseEkkoRunCommand({ input, source: 'coding_agent' }, 'coding_agent')).not.toBeNull()
    }
  })
  it('uses the Ekko ledger for a legacy coding_agent session', async () => {
    const f = fixture(true)
    await f.run('/usage')
    expect(mocks.updateSession).toHaveBeenCalledWith('ekko-1', { source: 'builtin_agent', agent: 'ekko-agent' })
    expect(f.state.source).toBe('builtin_agent')
    expect(mocks.totals).toHaveBeenCalledWith('ekko-1', 'ekko_agent')
    expect(f.response()).toMatchObject({ source: 'ekko', terminal: false, inputTokens: 12000, outputTokens: 3000, totalTokens: 19000 })
    expect(f.state.isWorking).toBe(true)
    expect(mocks.compact).not.toHaveBeenCalled()
  })
  it('reports missing recorded usage as unknown', async () => {
    mocks.latest.mockReturnValue(null)
    const f = fixture()
    await f.run('/usage')
    expect(f.response()).toMatchObject({ available: false, inputTokens: null, outputTokens: null, terminal: true })
  })
  it('reads the complete snapshot-aware history and keeps usage totals separate', async () => {
    const f = fixture()
    await f.run('/context')
    expect(mocks.history).toHaveBeenCalledWith('ekko-1', 'default', { excludeLastUser: false }, { model: 'stored-model', provider: 'openai' })
    expect(f.response()).toMatchObject({ source: 'ekko', estimated: true, contextWindow: 1000 })
    expect(f.response().contextTokens).toBeGreaterThan(100)
    expect(f.state.inputTokens).toBe(10000)
  })
  it('reports built-in runtime status while working', async () => {
    const f = fixture(true)
    await f.run('/status')
    expect(f.response()).toMatchObject({ agent: 'ekko-agent', mode: 'scoped', isWorking: true, queueLength: 0, terminal: false })
  })
  it('rejects compact while running without disturbing the active run', async () => {
    const f = fixture(true)
    await f.run('/compact')
    expect(f.response()).toMatchObject({ ok: false, terminal: false })
    expect(f.state.isWorking).toBe(true)
    expect(mocks.compact).not.toHaveBeenCalled()
    expect(f.dequeue).not.toHaveBeenCalled()
  })
  it('locks manual compression, preserves provider settings and resumes queued messages', async () => {
    const f = fixture()
    let resolve!: (value: any) => void
    mocks.runtime.mockImplementationOnce(() => new Promise(r => { resolve = r }))
    const pending = f.run('/compact')
    await vi.waitFor(() => expect(mocks.runtime).toHaveBeenCalled())
    expect(f.state.isWorking).toBe(true)
    await f.run('/compact')
    expect(f.response()).toMatchObject({ ok: false, terminal: false })
    resolve({ baseUrl: 'http://model', apiKey: 'test', apiMode: 'openai' })
    await pending
    expect(mocks.compact).toHaveBeenCalledWith('ekko-1', 'default', [], undefined, expect.objectContaining({
      model: 'stored-model', provider: 'openai', allowHermesFallback: false, excludeLastUser: false, force: true, apiMode: 'openai',
    }))
    expect(f.response()).toMatchObject({ action: 'compact', ok: true, terminal: true, contextTokens: 102 })
    expect(f.state.isWorking).toBe(false)
    expect(f.state.inputTokens).toBe(10000)
    expect(f.dequeue).toHaveBeenCalledOnce()
    expect(mocks.addMessage).toHaveBeenCalledWith(expect.objectContaining({ role: 'command', content: '/compact' }))
  })
  it('reports compression failure and releases the session', async () => {
    mocks.compact.mockRejectedValueOnce(new Error('Summarizer unavailable'))
    const f = fixture()
    await f.run('/compact')
    expect(f.response()).toMatchObject({ ok: false, terminal: true, message: 'Summarizer unavailable' })
    expect(f.state.isWorking).toBe(false)
    expect(f.emit).toHaveBeenCalledWith('compression.completed', expect.objectContaining({ failed: true }))
    expect(f.dequeue).toHaveBeenCalledOnce()
  })
})
