import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  settings: vi.fn(), session: vi.fn(), detail: vi.fn(), summarize: vi.fn(),
  config: { appHome: '' },
}))
vi.mock('../../packages/server/src/modules/studio/public/config', () => ({ config: mocks.config }))
vi.mock('../../packages/server/src/modules/studio/services/context-manager/settings', () => ({ getContextManagerSettings: mocks.settings }))
vi.mock('../../packages/server/src/modules/studio/services/context-manager/lifecycle', () => ({ getManagedContextManagerCaBundle: vi.fn() }))
vi.mock('../../packages/server/src/modules/studio/repositories/session-store', () => ({ getSession: mocks.session, getSessionDetail: mocks.detail }))
vi.mock('../../packages/server/src/modules/studio/services/context-compressor', () => ({
  callSummarizer: mocks.summarize, buildFullPrompt: (s: string) => s,
}))

const nativeSettings = { hermes: { manager: 'native' }, ekko: { manager: 'native' }, proxyUrl: 'http://127.0.0.1:8787', allowNativeFallback: false }
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex')
const identities = [1, 2].map(n => ({ rawId: `raw-${n}`, ref: `m0000${n}`, identityHash: 'a'.repeat(64) }))
const snapshot = {
  ok: true, protocolVersion: 1, parentRevision: 'b'.repeat(64), orderedMessages: identities,
  messages: identities.map((i, n) => ({ ...i, role: n ? 'assistant' : 'user', text: n ? 'answer' : 'question', contentType: 'text' })),
}

describe('Studio public context manager runtime', () => {
  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    mocks.config.appHome = await mkdtemp(join(tmpdir(), 'studio-context-runtime-'))
    mocks.settings.mockResolvedValue(nativeSettings)
    mocks.session.mockReturnValue({ id: 'child', profile: 'p', agent: 'hermes', model: 'm' })
    mocks.detail.mockReturnValue({ messages: [] })
  })
  afterEach(async () => {
    vi.unstubAllGlobals()
    await rm(mocks.config.appHome, { recursive: true, force: true })
  })

  it('keeps native defaults without requesting a proxy', async () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    const { resolveStudioContextManager } = await import('../../packages/server/src/modules/studio/services/context-manager/runtime')
    expect(await resolveStudioContextManager('p', 'hermes', 'child')).toMatchObject({ manager: 'native', conversationId: 'child' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('rejects another profile before accessing its proxy state', async () => {
    const { resolveStudioContextManager } = await import('../../packages/server/src/modules/studio/services/context-manager/runtime')
    await expect(resolveStudioContextManager('other', 'hermes', 'child')).rejects.toThrow(/profile/i)
  })

  it('matches a strict ordered text prefix and refuses changed or ambiguous raw content', async () => {
    const { matchBiliBranchPrefix } = await import('../../packages/server/src/modules/studio/services/context-manager/runtime')
    expect(matchBiliBranchPrefix(snapshot, [{ role: 'user', content: 'question' }])).toEqual(identities.slice(0, 1))
    expect(() => matchBiliBranchPrefix(snapshot, [{ role: 'user', content: 'question' }, { role: 'assistant', content: 'answer' }, { role: 'user', content: 'unsent tail' }])).toThrow(/match|unavailable/i)
    expect(() => matchBiliBranchPrefix(snapshot, [{ role: 'user', content: 'edited' }])).toThrow(/match/i)
    expect(() => matchBiliBranchPrefix({ ...snapshot, messages: snapshot.messages.map(m => ({ ...m, contentType: 'image' })) }, [{ role: 'user', content: 'question' }])).toThrow(/unavailable/i)
  })

  it('maps provider-split assistant text and tool calls to ordered raw messages', async () => {
    const { matchBiliBranchPrefix } = await import('../../packages/server/src/modules/studio/services/context-manager/runtime')
    const descriptors = [
      { role: 'user', text: 'question', contentType: 'text' },
      { role: 'assistant', text: 'checking', contentType: 'text' },
      { role: 'assistant', text: '{"city":"Paris"}', contentType: 'tool-call', toolName: 'weather', toolCallId: 'call-1' },
      { role: 'assistant', text: '{"zone":"UTC"}', contentType: 'tool-call', toolName: 'clock', toolCallId: 'call-2' },
      { role: 'tool', text: 'sunny', contentType: 'tool-result', toolName: 'weather', toolCallId: 'call-1' },
      { role: 'tool', text: '12:00', contentType: 'tool-result', toolName: 'clock', toolCallId: 'call-2' },
    ]
    const orderedMessages = descriptors.map((_, i) => ({ rawId: `raw-${i}`, ref: `m${String(i + 1).padStart(5, '0')}`, identityHash: 'a'.repeat(64) }))
    const toolSnapshot = { ...snapshot, orderedMessages, messages: descriptors.map((m, i) => ({ ...orderedMessages[i], ...m })) }
    const history = [
      { role: 'user', content: 'question' },
      { role: 'assistant', content: 'checking', tool_calls: [
        { id: 'call-1', type: 'function', function: { name: 'weather', arguments: '{ "city": "Paris" }' } },
        { id: 'call-2', type: 'function', function: { name: 'clock', arguments: '{"zone":"UTC"}' } },
      ] },
      { role: 'tool', content: 'sunny', tool_call_id: 'call-1' },
      { role: 'tool', content: '12:00', tool_call_id: 'call-2' },
    ]
    for (let i = 1; i <= history.length; i++) {
      expect(matchBiliBranchPrefix(toolSnapshot, history.slice(0, i))).toEqual(orderedMessages.slice(0, [1, 4, 5, 6][i - 1]))
    }
    expect(matchBiliBranchPrefix(toolSnapshot, [...history, { role: 'assistant', content: 'final unsent reply' }])).toEqual(orderedMessages)
    expect(() => matchBiliBranchPrefix(toolSnapshot, [...history, { role: 'user', content: 'missing history' }])).toThrow(/match|unavailable/i)
    expect(() => matchBiliBranchPrefix(toolSnapshot, [history[0], { ...history[1], tool_calls: [...history[1].tool_calls!].reverse() }])).toThrow(/match/i)
  })

  it('rejects a tool-result success/error mismatch in the public snapshot', async () => {
    const { matchBiliBranchPrefix } = await import('../../packages/server/src/modules/studio/services/context-manager/runtime')
    const descriptors = [
      { role: 'assistant', text: '{}', contentType: 'tool-call', toolName: 'lookup', toolCallId: 'call-1' },
      { role: 'tool', text: 'result', contentType: 'tool-result', toolName: 'lookup', toolCallId: 'call-1', toolIsError: false },
    ]
    const toolSnapshot = { ...snapshot, messages: descriptors.map((m, i) => ({ ...identities[i], ...m })) }
    const history = [
      { role: 'assistant', content: JSON.stringify([{ type: 'tool_use', id: 'call-1', name: 'lookup', input: {} }]) },
      { role: 'user', content: JSON.stringify([{ type: 'tool_result', tool_use_id: 'call-1', content: 'result', is_error: true }]) },
    ]
    expect(() => matchBiliBranchPrefix(toolSnapshot, history)).toThrow(/match/i)
    expect(matchBiliBranchPrefix({ ...toolSnapshot, messages: toolSnapshot.messages.map(m => ({ ...m, toolIsError: true })) }, history)).toEqual(identities)
  })

  it('journals the exact fork request and retries it before the first model request', async () => {
    mocks.settings.mockResolvedValue({ ...nativeSettings, hermes: { manager: 'bili' } })
    const calls: Array<{ path: string; body?: Record<string, unknown> }> = []
    let fail = true
    vi.stubGlobal('fetch', vi.fn(async (url: URL, options: RequestInit) => {
      const body = options.body ? JSON.parse(String(options.body)) : undefined
      calls.push({ path: url.pathname, body })
      if (url.pathname.endsWith('/manifest')) return Response.json({ ok: true, protocolVersion: 1, toolNames: ['compress', 'decompress', 'search_context', 'acp_status', 'acp_cache'], capabilities: { fork: { protocolVersion: 1 } } })
      if (url.pathname.endsWith('/snapshot')) {
        const conversationId = url.searchParams.get('conversationId')!
        return Response.json({ ...snapshot, conversationId, sessionId: conversationId,
          parentRevision: conversationId === 'child' ? 'c'.repeat(64) : snapshot.parentRevision,
          orderedMessages: conversationId === 'child' ? identities.slice(0, 1) : identities,
          messages: conversationId === 'child' ? snapshot.messages.slice(0, 1) : snapshot.messages })
      }
      if (fail) { fail = false; throw new Error('connection lost') }
      return Response.json({ ok: true, protocolVersion: 1, parentConversationId: 'parent', childConversationId: 'child', sessionId: 'child',
        parentRevision: body!.parentRevision, branchPoint: body!.branchPoint, childRevision: 'c'.repeat(64), status: 'exact' })
    }))
    const { forkBiliConversation, ensureBiliConversation } = await import('../../packages/server/src/modules/studio/services/context-manager/runtime')
    await expect(forkBiliConversation({ profile: 'p', agent: 'hermes', parentSessionId: 'parent', childSessionId: 'child', messages: [{ role: 'user', content: 'question' }] })).rejects.toThrow('connection lost')
    await Promise.all(Array.from({ length: 8 }, () => ensureBiliConversation('p', 'hermes', 'child')))
    const forks = calls.filter(c => c.path.endsWith('/fork'))
    expect(forks).toHaveLength(2)
    expect(forks[1].body).toEqual(forks[0].body)
    expect(forks[1].body).toMatchObject({ parentConversationId: 'parent', childConversationId: 'child', branchPoint: { messageCount: 1, orderHash: hash(identities.slice(0, 1)) } })
  })

  it('rejects a foreign manual compression snapshot before invoking the summarizer', async () => {
    mocks.settings.mockResolvedValue({ ...nativeSettings, hermes: { manager: 'bili' } })
    const messages = Array.from({ length: 8 }, (_, i) => ({
      rawId: `raw-${i}`, ref: `m${String(i + 1).padStart(5, '0')}`, identityHash: 'a'.repeat(64),
      role: i % 2 ? 'assistant' : 'user', text: `original-${i}`, contentType: 'text',
    }))
    mocks.session.mockReturnValue({ id: 'child', profile: 'p', model: 'm', provider: 'provider' })
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...snapshot, conversationId: 'foreign', sessionId: 'foreign',
      messages, orderedMessages: messages.map(({ rawId, ref, identityHash }) => ({ rawId, ref, identityHash })) })))
    const { compactBiliConversation } = await import('../../packages/server/src/modules/studio/services/context-manager/runtime')
    await expect(compactBiliConversation({ profile: 'p', agent: 'hermes', sessionId: 'child', model: 'm',
      state: { contextOwner: { manager: 'bili', conversationId: 'child' } } as any, emit: vi.fn() })).rejects.toThrow(/identity mismatch/i)
    expect(mocks.summarize).not.toHaveBeenCalled()
  })

  it('commits manual compression through the public tool with an isolated summarizer and revision guard', async () => {
    mocks.settings.mockResolvedValue({ ...nativeSettings, hermes: { manager: 'bili' } })
    mocks.session.mockReturnValue({ id: 'child', profile: 'p', model: 'm', provider: 'provider' })
    const messages = Array.from({ length: 8 }, (_, i) => ({
      rawId: `raw-${i}`, ref: `m${String(i + 1).padStart(5, '0')}`, identityHash: 'a'.repeat(64),
      role: i % 2 ? 'assistant' : 'user', text: `original-${i}`, contentType: 'text',
    }))
    const orderedMessages = messages.map(({ rawId, ref, identityHash }) => ({ rawId, ref, identityHash }))
    const toolBodies: unknown[] = []
    let compressed = false
    mocks.summarize.mockResolvedValue('Recovered conversation summary.')
    vi.stubGlobal('fetch', vi.fn(async (url: URL, options: RequestInit) => {
      if (url.pathname.endsWith('/snapshot')) return Response.json({ ...snapshot, conversationId: 'child', sessionId: 'child',
        parentRevision: (compressed ? 'c' : 'b').repeat(64), messages, orderedMessages })
      if (url.pathname.endsWith('/tool')) {
        toolBodies.push(JSON.parse(String(options.body)))
        compressed = true
        return Response.json({ ok: true, result: 'Compressed messages into b1.' })
      }
      return Response.json({ ok: true, conversationId: 'child', model: 'm', requests: 1, contextLimit: 100000,
        sessionId: 'child', sessionRevision: 'b'.repeat(64), compressibleRanges: [{ startRef: 'm00002', endRef: 'm00004', count: 3 }],
        contextTokens: compressed ? 125 : 1200, contextTokensSource: compressed ? 'estimate' : 'usage',
        contextTokensAt: Date.now(), contextGeneration: compressed ? 'after' : 'before' })
    }))
    const { compactBiliConversation } = await import('../../packages/server/src/modules/studio/services/context-manager/runtime')
    const state: any = { contextOwner: { manager: 'bili', conversationId: 'child' } }
    expect(await compactBiliConversation({ profile: 'p', agent: 'hermes', sessionId: 'child', model: 'm', state, emit: vi.fn() }))
      .toEqual({ beforeTokens: 1200, afterTokens: 125 })
    expect(toolBodies).toEqual([{ conversationId: 'child', tool: 'compress', expectedRevision: 'b'.repeat(64),
      args: { content: [{ startId: 'm00002', endId: 'm00004', summary: 'Recovered conversation summary.' }] } }])
    expect(mocks.summarize.mock.calls[0][2]).not.toContain('original-0')
    expect(mocks.summarize).toHaveBeenCalledWith('', undefined, expect.stringContaining('original-3'), [], 120000, undefined,
      expect.objectContaining({ profile: 'p', sessionId: expect.stringMatching(/^bili-summary-/), model: 'm', provider: 'provider', allowHermesFallback: false }))
    expect(mocks.summarize.mock.calls[0][2]).not.toContain('original-4')
    expect(state.externalContext).toMatchObject({ source: 'estimate', generation: 'after', tokens: 125 })
  })

  it.each(['missing ranges', 'empty ranges', 'stale revision', 'foreign status', 'unknown ref', 'reversed range', 'wrong count', 'single message'])
    ('rejects %s before the summarizer or compression tool runs', async variant => {
      mocks.settings.mockResolvedValue({ ...nativeSettings, hermes: { manager: 'bili' } })
      mocks.session.mockReturnValue({ id: 'child', profile: 'p', model: 'm', provider: 'provider' })
      const messages = Array.from({ length: 8 }, (_, i) => ({
        rawId: `raw-${i}`, ref: `m${String(i + 1).padStart(5, '0')}`, identityHash: 'a'.repeat(64),
        role: i % 2 ? 'assistant' : 'user', text: `original-${i}`, contentType: 'text',
      }))
      const status: any = { ok: true, conversationId: 'child', sessionId: 'child', sessionRevision: 'b'.repeat(64),
        compressibleRanges: [{ startRef: 'm00001', endRef: 'm00004', count: 4 }] }
      if (variant === 'missing ranges') delete status.compressibleRanges
      if (variant === 'empty ranges') status.compressibleRanges = []
      if (variant === 'stale revision') status.sessionRevision = 'c'.repeat(64)
      if (variant === 'foreign status') status.conversationId = 'foreign'
      if (variant === 'unknown ref') status.compressibleRanges[0].startRef = 'm99999'
      if (variant === 'reversed range') status.compressibleRanges[0].startRef = 'm00005'
      if (variant === 'wrong count') status.compressibleRanges[0].count = 3
      if (variant === 'single message') status.compressibleRanges = [{ startRef: 'm00002', endRef: 'm00002', count: 1 }]
      const paths: string[] = []
      vi.stubGlobal('fetch', vi.fn(async (url: URL) => {
        paths.push(url.pathname)
        if (url.pathname.endsWith('/snapshot')) return Response.json({ ...snapshot, conversationId: 'child', sessionId: 'child',
          messages, orderedMessages: messages.map(({ rawId, ref, identityHash }) => ({ rawId, ref, identityHash })) })
        return Response.json(status)
      }))
      const { compactBiliConversation } = await import('../../packages/server/src/modules/studio/services/context-manager/runtime')
      await expect(compactBiliConversation({ profile: 'p', agent: 'hermes', sessionId: 'child', model: 'm',
        state: { contextOwner: { manager: 'bili', conversationId: 'child' } } as any, emit: vi.fn() })).rejects.toThrow(/range|history/i)
      expect(mocks.summarize).not.toHaveBeenCalled()
      expect(paths.some(path => path.endsWith('/tool'))).toBe(false)
    })

  it.each(['foreign identity', 'unsupported protocol', 'invalid order', 'missing revision', 'empty revision', 'unchanged revision'])
    ('rejects a %s post-compression snapshot without retrying or changing owner', async variant => {
      mocks.settings.mockResolvedValue({ ...nativeSettings, hermes: { manager: 'bili' }, allowNativeFallback: true })
      mocks.session.mockReturnValue({ id: 'child', profile: 'p', model: 'm', provider: 'provider' })
      const messages = Array.from({ length: 8 }, (_, i) => ({
        rawId: `raw-${i}`, ref: `m${String(i + 1).padStart(5, '0')}`, identityHash: 'a'.repeat(64),
        role: i % 2 ? 'assistant' : 'user', text: `original-${i}`, contentType: 'text',
      }))
      const original = { ...snapshot, conversationId: 'child', sessionId: 'child', messages,
        orderedMessages: messages.map(({ rawId, ref, identityHash }) => ({ rawId, ref, identityHash })) }
      const after: Record<string, unknown> = { ...original, parentRevision: 'c'.repeat(64) }
      if (variant === 'foreign identity') after.conversationId = 'foreign'
      if (variant === 'unsupported protocol') after.protocolVersion = 2
      if (variant === 'invalid order') after.orderedMessages = [...original.orderedMessages].reverse()
      if (variant === 'missing revision') delete after.parentRevision
      if (variant === 'empty revision') after.parentRevision = ''
      if (variant === 'unchanged revision') after.parentRevision = original.parentRevision
      const paths: string[] = []
      let compressed = false
      mocks.summarize.mockResolvedValue('Recovered conversation summary.')
      vi.stubGlobal('fetch', vi.fn(async (url: URL) => {
        paths.push(url.pathname)
        if (url.pathname.endsWith('/snapshot')) return Response.json(compressed ? after : original)
        if (url.pathname.endsWith('/tool')) {
          compressed = true
          return Response.json({ ok: true, result: 'Compressed messages into b1.' })
        }
        return Response.json({ ok: true, conversationId: 'child', model: 'm', requests: 1, contextLimit: 100000,
        sessionId: 'child', sessionRevision: 'b'.repeat(64), compressibleRanges: [{ startRef: 'm00002', endRef: 'm00004', count: 3 }],
          contextTokens: compressed ? 125 : 1200, contextTokensSource: 'usage',
          contextTokensAt: Date.now(), contextGeneration: compressed ? 'after' : 'before' })
      }))
      const { compactBiliConversation } = await import('../../packages/server/src/modules/studio/services/context-manager/runtime')
      const state: any = { contextOwner: { manager: 'bili', conversationId: 'child' } }
      const emit = vi.fn()
      await expect(compactBiliConversation({ profile: 'p', agent: 'hermes', sessionId: 'child', model: 'm', state, emit }))
        .rejects.toThrow(/identity|mapping|compression block/i)
      expect(paths.filter(path => path.endsWith('/tool'))).toHaveLength(1)
      expect(paths.filter(path => path.endsWith('/status'))).toHaveLength(1)
      expect(mocks.summarize).toHaveBeenCalledOnce()
      expect(state.contextOwner).toEqual({ manager: 'bili', conversationId: 'child' })
      expect(state.externalContext).toBeUndefined()
      expect(emit).not.toHaveBeenCalled()
    })

  it.each(['summarizer unavailable', 'FAILED revision conflict', 'tool offline', 'snapshot offline', 'usage offline'])
    ('keeps a single bili owner and never retries compression after %s', async failure => {
      mocks.settings.mockResolvedValue({ ...nativeSettings, hermes: { manager: 'bili' }, allowNativeFallback: true })
      mocks.session.mockReturnValue({ id: 'child', profile: 'p', model: 'm', provider: 'provider' })
      const messages = Array.from({ length: 8 }, (_, i) => ({
        rawId: `raw-${i}`, ref: `m${String(i + 1).padStart(5, '0')}`, identityHash: 'a'.repeat(64),
        role: i % 2 ? 'assistant' : 'user', text: `original-${i}`, contentType: 'text',
      }))
      const paths: string[] = []
      let compressed = false
      mocks.summarize.mockResolvedValue('Recovered conversation summary.')
      if (failure === 'summarizer unavailable') mocks.summarize.mockRejectedValueOnce(new Error(failure))
      vi.stubGlobal('fetch', vi.fn(async (url: URL) => {
        paths.push(url.pathname)
        if (url.pathname.endsWith('/snapshot')) {
          if (compressed && failure === 'snapshot offline') throw new Error(failure)
          return Response.json({ ...snapshot, conversationId: 'child', sessionId: 'child', messages,
            orderedMessages: messages.map(({ rawId, ref, identityHash }) => ({ rawId, ref, identityHash })),
            parentRevision: (compressed ? 'c' : 'b').repeat(64) })
        }
        if (url.pathname.endsWith('/tool')) {
          if (failure === 'tool offline') throw new Error(failure)
          compressed = true
          return Response.json({ ok: true, result: failure === 'FAILED revision conflict' ? failure : 'Compressed messages into b1.' })
        }
        if (compressed && failure === 'usage offline') throw new Error(failure)
        return Response.json({ ok: true, conversationId: 'child', model: 'm', requests: 1, contextLimit: 100000,
        sessionId: 'child', sessionRevision: 'b'.repeat(64), compressibleRanges: [{ startRef: 'm00002', endRef: 'm00004', count: 3 }],
          contextTokens: 1200, contextTokensSource: 'usage', contextTokensAt: Date.now(), contextGeneration: 'before' })
      }))
      const { compactBiliConversation } = await import('../../packages/server/src/modules/studio/services/context-manager/runtime')
      const state: any = { contextOwner: { manager: 'bili', conversationId: 'child' } }
      await expect(compactBiliConversation({ profile: 'p', agent: 'hermes', sessionId: 'child', model: 'm', state, emit: vi.fn() }))
        .rejects.toThrow(/summarizer unavailable|FAILED|tool offline|snapshot offline|effective usage/)
      expect(paths.filter(path => path.endsWith('/tool'))).toHaveLength(failure === 'summarizer unavailable' ? 0 : 1)
      expect(mocks.summarize).toHaveBeenCalledOnce()
      expect(state.contextOwner).toMatchObject({ manager: 'bili', conversationId: 'child' })
      expect(state.externalContext).toBeUndefined()
    })

  it('honors an observed native owner without calling configured bili', async () => {
    mocks.settings.mockResolvedValue({ ...nativeSettings, hermes: { manager: 'bili' } })
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    const { ensureBiliConversation, compactBiliConversation, forkBiliConversation } = await import('../../packages/server/src/modules/studio/services/context-manager/runtime')
    await ensureBiliConversation('p', 'hermes', 'child', { manager: 'native', conversationId: 'child' })
    expect(await forkBiliConversation({ profile: 'p', agent: 'hermes', parentSessionId: 'parent', childSessionId: 'child', messages: [], owner: { manager: 'native', conversationId: 'parent' } })).toBeUndefined()
    await expect(compactBiliConversation({ profile: 'p', agent: 'hermes', sessionId: 'child', state: { contextOwner: { manager: 'native', conversationId: 'child' } } as any, emit: vi.fn() })).rejects.toThrow(/does not own/i)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('invalidates the bili snapshot when the effective owner changes to native', async () => {
    const { refreshExternalContextUsage } = await import('../../packages/server/src/modules/studio/services/context-manager/runtime')
    const state: any = { contextTokens: 1200, externalContext: { tokens: 1200 }, contextManagerStatus: 'active' }
    expect(await refreshExternalContextUsage({ sessionId: 'child', profile: 'p', agent: 'hermes', state, emit: vi.fn(), owner: { manager: 'native' } })).toBe(false)
    expect(state.externalContext).toBeUndefined()
    expect(state.contextTokens).toBeUndefined()
    expect(state.contextManagerStatus).toBe('unavailable')
  })

  it('does not label an unknown native context as active after resume', async () => {
    const { refreshExternalContextUsage } = await import('../../packages/server/src/modules/studio/services/context-manager/runtime')
    const state: any = { contextTokens: undefined, contextManagerStatus: 'unavailable' }
    expect(await refreshExternalContextUsage({ sessionId: 'child', profile: 'p', agent: 'hermes', state, emit: vi.fn() })).toBe(false)
    expect(state.contextManagerStatus).toBe('unavailable')
  })

  it('clears stale context and publishes unavailability when bili status fails', async () => {
    mocks.settings.mockResolvedValue({ ...nativeSettings, hermes: { manager: 'bili' } })
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    const { refreshExternalContextUsage } = await import('../../packages/server/src/modules/studio/services/context-manager/runtime')
    const state: any = { contextTokens: 1_200, externalContext: { tokens: 1_200 }, contextManagerStatus: 'active', inputTokens: 999999 }
    const emit = vi.fn()
    expect(await refreshExternalContextUsage({ sessionId: 'child', profile: 'p', agent: 'hermes', model: 'm', state, emit })).toBe(false)
    expect(state.contextTokens).toBeUndefined()
    expect(state.externalContext).toBeUndefined()
    expect(emit).toHaveBeenCalledWith('usage.updated', expect.objectContaining({
      contextTokens: null, contextManager: 'bili', contextSource: 'unavailable', contextManagerStatus: 'unavailable', inputTokens: 999999,
    }))
  })

  it('refreshes effective context without adding cumulative billing or cache tokens', async () => {
    mocks.settings.mockResolvedValue({ ...nativeSettings, hermes: { manager: 'bili' } })
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: true, conversationId: 'child', model: 'm', contextTokens: 125, contextTokensSource: 'usage', contextTokensAt: Date.now(), contextGeneration: 'g', contextLimit: 100000, requests: 2, inputTokens: 999999, cachedTokens: 888888 })))
    const { refreshExternalContextUsage } = await import('../../packages/server/src/modules/studio/services/context-manager/runtime')
    const state: any = { messages: [], isWorking: false, events: [], queue: [], inputTokens: 999999 }
    const emit = vi.fn()
    expect(await refreshExternalContextUsage({ sessionId: 'child', profile: 'p', agent: 'hermes', model: 'm', state, emit })).toBe(true)
    expect(state.contextTokens).toBe(125)
    expect(state.externalContext).toMatchObject({ source: 'usage', generation: 'g' })
    expect(emit).toHaveBeenCalledWith('usage.updated', expect.objectContaining({ contextTokens: 125, inputTokens: 999999 }))
  })

  it('invalidates verified bili usage when profile configuration cannot be read', async () => {
    mocks.settings.mockRejectedValue(new Error('invalid settings'))
    const { refreshExternalContextUsage } = await import('../../packages/server/src/modules/studio/services/context-manager/runtime')
    const state: any = { contextOwner: { manager: 'bili', conversationId: 'child' },
      contextTokens: 1200, externalContext: { tokens: 1200 }, contextManagerStatus: 'active' }
    const emit = vi.fn()
    expect(await refreshExternalContextUsage({ sessionId: 'child', profile: 'p', agent: 'hermes', state, emit })).toBe(false)
    expect(state.contextTokens).toBeUndefined()
    expect(emit).toHaveBeenCalledWith('usage.updated', expect.objectContaining({ contextTokens: null, contextManagerStatus: 'unavailable' }))
  })
})