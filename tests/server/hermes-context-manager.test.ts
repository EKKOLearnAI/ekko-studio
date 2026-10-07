import { execFileSync } from 'node:child_process'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  settings: vi.fn(), ensureReady: vi.fn(), start: vi.fn(), ensureConversation: vi.fn(), snapshot: vi.fn(),
  session: vi.fn(), deleteSnapshot: vi.fn(), history: vi.fn(), compressor: vi.fn(),
}))
vi.mock('../../packages/server/src/modules/studio/services/context-manager/settings', () => ({ getContextManagerSettings: mocks.settings }))
vi.mock('../../packages/server/src/modules/studio/services/context-manager/lifecycle', () => ({ getManagedContextManagerCaBundle: vi.fn(() => undefined) }))
vi.mock('../../packages/server/src/modules/hermes/services/bridge/manager', () => ({ getAgentBridgeManager: () => ({ endpoint: 'ipc://test', start: mocks.start, ensureReady: mocks.ensureReady }) }))
vi.mock('../../packages/server/src/modules/studio/services/context-manager/runtime', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../packages/server/src/modules/studio/services/context-manager/runtime')>(),
  ensureBiliConversation: mocks.ensureConversation,
}))
vi.mock('../../packages/server/src/modules/studio/repositories/session-store', () => ({ getSession: mocks.session }))
vi.mock('../../packages/server/src/modules/studio/repositories/compression-snapshot', () => ({ getCompressionSnapshot: mocks.snapshot, deleteCompressionSnapshot: mocks.deleteSnapshot }))
vi.mock('../../packages/server/src/modules/studio/services/chat-run/context-history', () => ({ buildDbHistory: mocks.history }))
vi.mock('../../packages/server/src/modules/studio/services/context-compressor', () => ({ SUMMARY_PREFIX: '[summary]', ChatContextCompressor: mocks.compressor }))

import { assertBridgeContextCapabilities, compactBiliConversation, configureHermesContextManager, observeHermesProfileWorker, resolveSessionContextOwner, restartHermesProfileWorker, type SessionContextOwner } from '../../packages/server/src/modules/hermes/public/context-manager'
import { AgentBridgeClient } from '../../packages/server/src/modules/hermes/services/bridge/client'
import { getAgentBridgeManager } from '../../packages/server/src/modules/hermes/services/bridge/manager'
import { configureChatAgentRuntime } from '../../packages/server/src/modules/studio/public/chat-agent-runtime'
import { buildCompressedHistory, buildDbSnapshotAwareHistory, buildSnapshotAwareHistory, forceCompressBridgeHistory } from '../../packages/server/src/modules/studio/services/chat-run/compression'

const bili: SessionContextOwner = { manager: 'bili', owner: 'bili', selectedManager: 'bili', independentPlugin: false, conversationId: 's', proxyUrl: 'http://127.0.0.1:8787', allowNativeFallback: false }
const request = vi.spyOn(AgentBridgeClient.prototype, 'request')
const unused = () => { throw new Error('Unexpected unrelated runtime dependency') }

beforeEach(() => {
  vi.clearAllMocks()
  configureHermesContextManager({ loadSettings: mocks.settings })
  configureChatAgentRuntime({
    createPrimaryAgentBridge: options => new AgentBridgeClient(options),
    getPrimaryAgentBridgeManager: getAgentBridgeManager,
    redactPrimaryAgentBridgeError: unused,
    codingAgentRunManager: {}, sendCodingAgentRunInput: unused, startCodingAgentRun: unused,
    handleCodingAgentSessionCommand: unused, parseCodingAgentSessionCommand: unused,
    getEkkoAgent: unused, abortEkkoBackgroundTasks: unused, hasEkkoBackgroundTasks: unused,
    createEkkoModelClient: unused, resolveEkkoModelProviderConfigs: unused,
    ekkoModelRequestTimeoutMs: 1000, ekkoAgentReasoningText: unused,
    normalizeEkkoAgentReasoning: unused, serializeEkkoAgentReasoningDetails: unused,
    waitForEkkoToolApproval: unused, waitForEkkoClarification: unused,
    getCodingAgentMcpServers: unused, resolveEkkoMcpServers: unused,
    resolveEkkoProviderRuntimeConfig: unused, createEkkoAuthorizedProviderFetch: unused,
    respondToEkkoToolApproval: unused, respondToEkkoClarification: unused,
  })
  mocks.settings.mockResolvedValue({ hermes: { manager: 'bili' }, ekko: { manager: 'native' }, proxyUrl: bili.proxyUrl, allowNativeFallback: false })
  mocks.session.mockReturnValue({ id: 's', agent: 'hermes', profile: 'p' })
  mocks.snapshot.mockReturnValue(null)
  request.mockResolvedValue({ ok: true, context_manager: bili })
  mocks.history.mockResolvedValue([{ role: 'user', content: 'full history' }])
})

describe('Hermes context ownership', () => {
  it('rejects legacy attach capabilities and accepts the explicit single-owner protocol', () => {
    expect(() => assertBridgeContextCapabilities({ ok: true, pong: true })).toThrow(/context manager/)
    expect(() => assertBridgeContextCapabilities({ context_manager_capabilities: { version: 1, workerIsolation: true, stableConversationId: true, singleCompressionOwner: true, contextOwnerStatus: true } })).not.toThrow()
  })
  it('discovers independently enabled bili even when Studio selects native', async () => {
    mocks.settings.mockResolvedValue({ hermes: { manager: 'native' }, ekko: { manager: 'native' }, proxyUrl: bili.proxyUrl, allowNativeFallback: false })
    request.mockResolvedValue({ ok: true, context_manager: { ...bili, selectedManager: 'native', independentPlugin: true } })
    expect(await resolveSessionContextOwner('s', 'p', 'hermes')).toMatchObject({ manager: 'bili', independentPlugin: true })
  })
  it('rejects a worker returning a foreign identity', async () => {
    request.mockResolvedValue({ ok: true, context_manager: { ...bili, conversationId: 'wrong' } })
    await expect(resolveSessionContextOwner('s', 'p', 'hermes')).rejects.toThrow(/identity/)
  })
  it('manual compact uses the public session-scoped bridge action and verifies identity', async () => {
    request.mockResolvedValue({ ok: true, manager: 'bili', conversationId: 's', status: { conversationId: 's' } })
    await compactBiliConversation('s', 'p', bili)
    expect(request).toHaveBeenCalledWith({ action: 'context_compact', session_id: 's', profile: 'p' })
  })
})

describe('Hermes profile worker facade', () => {
  const capabilities = {
    version: 1, workerIsolation: true, stableConversationId: true,
    singleCompressionOwner: true, contextOwnerStatus: true,
  }

  it('observes only the requested profile without creating a worker', async () => {
    request.mockResolvedValue({ ok: true, context_manager_capabilities: capabilities,
      worker_details: {
        'p:context:a': { profile: 'p', running: true, pid: 41, endpoint: 'ipc://p', last_used_at: 12 },
        'q:context:b': { profile: 'q', running: true, pid: 42, endpoint: 'ipc://q', last_used_at: 13 },
      }, sessions_by_profile: { p: 2 }, running_sessions_by_profile: { p: 1 } })
    await expect(observeHermesProfileWorker('p')).resolves.toEqual({
      profile: 'p', reachable: true, running: true,
      workers: [{ key: 'p:context:a', profile: 'p', running: true, pid: 41, endpoint: 'ipc://p', lastUsedAt: 12 }],
      activeSessions: 2, runningSessions: 1,
    })
    expect(request).toHaveBeenCalledWith({ action: 'ping' })
  })

  it('restarts one profile worker through the scoped broker actions', async () => {
    request.mockImplementation(async payload => {
      if (payload.action === 'ping') {
        return { ok: true, context_manager_capabilities: capabilities,
          worker_details: { 'p:context:a': { profile: 'p', running: true, pid: 41, endpoint: 'ipc://p' } },
          sessions_by_profile: { p: 0 }, running_sessions_by_profile: { p: 0 } }
      }
      if (payload.action === 'destroy_profile') return { ok: true, profile: 'p', destroyed: 1 }
      if (payload.action === 'worker_ping') return { ok: true, context_manager_capabilities: capabilities, pong: true }
      throw new Error(`unexpected action ${String(payload.action)}`)
    })
    const result = await restartHermesProfileWorker('p')
    expect(result.destroyed).toBe(1)
    expect(request.mock.calls.map(([payload]) => payload.action)).toEqual(['ping', 'destroy_profile', 'worker_ping', 'ping'])
    expect(request.mock.calls[1]?.[0]).toEqual({ action: 'destroy_profile', profile: 'p' })
    expect(request.mock.calls[2]?.[0]).toEqual({ action: 'worker_ping', profile: 'p' })
  })

  it('interprets missing profile keys in provided count maps as idle', async () => {
    request.mockResolvedValue({ ok: true, context_manager_capabilities: capabilities,
      worker_details: { p: { profile: 'p', running: true } },
      sessions_by_profile: { q: 2 }, running_sessions_by_profile: { q: 1 } })
    await expect(observeHermesProfileWorker('p')).resolves.toMatchObject({ activeSessions: 0, runningSessions: 0 })
  })

  it.each([undefined, null, [], 'invalid'])('keeps absent or malformed count observations unknown: %s', async counts => {
    request.mockResolvedValue({ ok: true, context_manager_capabilities: capabilities,
      sessions_by_profile: counts, running_sessions_by_profile: counts })
    await expect(observeHermesProfileWorker('p')).resolves.toMatchObject({ activeSessions: null, runningSessions: null })
  })

  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, '0', null])('rejects malformed explicit profile counts: %s', async count => {
    request.mockResolvedValue({ ok: true, context_manager_capabilities: capabilities,
      sessions_by_profile: { p: count }, running_sessions_by_profile: { p: count } })
    await expect(observeHermesProfileWorker('p')).resolves.toMatchObject({ activeSessions: null, runningSessions: null })
  })

  it.each([1, undefined, null])('fails closed before restart with busy or unknown counts: %s', async count => {
    request.mockImplementation(async payload => {
      if (payload.action === 'ping') return { ok: true, context_manager_capabilities: capabilities,
        worker_details: { p: { profile: 'p', running: true } }, sessions_by_profile: { p: 0 },
        ...(count !== undefined ? { running_sessions_by_profile: { p: count } } : {}) }
      return { ok: true, profile: 'p', destroyed: 1, context_manager_capabilities: capabilities }
    })
    await expect(restartHermesProfileWorker('p')).rejects.toThrow(/running|verify/)
    expect(request.mock.calls.map(([payload]) => payload.action)).toEqual(['ping'])
  })

  it('does not ping a replacement when atomic broker destruction rejects a raced chat', async () => {
    request.mockImplementation(async payload => {
      if (payload.action === 'ping') return { ok: true, context_manager_capabilities: capabilities,
        sessions_by_profile: {}, running_sessions_by_profile: {} }
      throw new Error('cannot destroy worker profile while sessions are running or starting')
    })
    await expect(restartHermesProfileWorker('p')).rejects.toThrow(/running or starting/)
    expect(request.mock.calls.map(([payload]) => payload.action)).toEqual(['ping', 'destroy_profile'])
  })

  it('rejects profile traversal before touching the bridge', async () => {
    await expect(observeHermesProfileWorker('../default')).rejects.toThrow('invalid worker profile')
    await expect(restartHermesProfileWorker('p/../q')).rejects.toThrow('invalid worker profile')
    expect(request).not.toHaveBeenCalled()
  })
})

describe('Hermes Python worker lifecycle wrapper', () => {
  it('runs the deterministic broker lifecycle regressions', () => {
    expect(() => execFileSync('python3', ['tests/server/hermes-worker-lifecycle-python.test.py', '-v'],
      { cwd: process.cwd(), encoding: 'utf-8', timeout: 30_000, stdio: 'pipe' })).not.toThrow()
  })
})

describe('Studio single compression owner', () => {
  it('automatic history passes raw messages to bili without a native compressor', async () => {
    expect(await buildCompressedHistory('s', 'p', '', undefined, vi.fn(), new Map())).toEqual([{ role: 'user', content: 'full history' }])
    expect(request).toHaveBeenCalledWith({ action: 'context_manager_status', session_id: 's', profile: 'p',
      context_manager: { manager: 'bili', proxyUrl: bili.proxyUrl, conversationId: 's', allowNativeFallback: false } })
    expect(mocks.ensureConversation).toHaveBeenCalledWith('p', 'hermes', 's', expect.objectContaining(bili))
    expect(mocks.compressor).not.toHaveBeenCalled()
  })
  it('blocks native snapshots before cursor repair or deletion', async () => {
    mocks.snapshot.mockReturnValue({ summary: 'irreversible native summary', lastMessageIndex: 100 })
    await expect(buildSnapshotAwareHistory('s', 'p', [])).rejects.toThrow(/migration/)
    await expect(buildDbSnapshotAwareHistory('s', 'p')).rejects.toThrow(/migration/)
    await expect(buildCompressedHistory('s', 'p', '', undefined, vi.fn(), new Map())).rejects.toThrow(/migration/)
    expect(mocks.deleteSnapshot).not.toHaveBeenCalled()
  })
  it('rejects native overflow compression rather than fabricating a result', async () => {
    await expect(forceCompressBridgeHistory('s', 'p', [])).rejects.toThrow(/bili/)
    expect(mocks.compressor).not.toHaveBeenCalled()
  })
  it('propagates explicit bili failures without native fallback', async () => {
    request.mockRejectedValue(new Error('plugin inactive'))
    await expect(buildCompressedHistory('s', 'p', '', undefined, vi.fn(), new Map())).rejects.toThrow('plugin inactive')
    expect(mocks.compressor).not.toHaveBeenCalled()
  })
})
