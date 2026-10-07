import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  binding: vi.fn(), ensure: vi.fn(), status: vi.fn(), manager: vi.fn(), create: vi.fn(),
  session: vi.fn(), snapshot: vi.fn(), deleteSnapshot: vi.fn(), history: vi.fn(), compressor: vi.fn(),
}))
vi.mock('../../packages/server/src/modules/studio/services/context-manager/runtime', () => ({
  resolveStudioContextManager: mocks.binding, ensureBiliConversation: mocks.ensure,
}))
vi.mock('../../packages/server/src/modules/studio/public/chat-agent-runtime', () => ({
  createPrimaryAgentBridge: mocks.create, getPrimaryAgentBridgeManager: mocks.manager,
}))
vi.mock('../../packages/server/src/modules/studio/repositories/session-store', () => ({ getSession: mocks.session }))
vi.mock('../../packages/server/src/modules/studio/repositories/compression-snapshot', () => ({ getCompressionSnapshot: mocks.snapshot, deleteCompressionSnapshot: mocks.deleteSnapshot }))
vi.mock('../../packages/server/src/modules/studio/services/chat-run/context-history', () => ({ buildDbHistory: mocks.history }))
vi.mock('../../packages/server/src/modules/studio/services/context-compressor', () => ({ SUMMARY_PREFIX: '[summary]', ChatContextCompressor: mocks.compressor }))

import { buildCompressedHistory, buildDbSnapshotAwareHistory, buildSnapshotAwareHistory, forceCompressBridgeHistory, getSessionCompressionOwner } from '../../packages/server/src/modules/studio/services/chat-run/compression'

const binding = { manager: 'bili', conversationId: 's', proxyUrl: 'http://127.0.0.1:8787', allowNativeFallback: false }
beforeEach(() => {
  vi.clearAllMocks()
  mocks.binding.mockResolvedValue(binding)
  mocks.session.mockReturnValue({ id: 's', agent: 'hermes', profile: 'p' })
  mocks.snapshot.mockReturnValue(null)
  mocks.manager.mockReturnValue({ endpoint: 'ipc://test', start: vi.fn(), ensureReady: vi.fn() })
  mocks.create.mockReturnValue({ contextManagerStatus: mocks.status })
  mocks.status.mockResolvedValue({ ok: true, context_manager: binding })
  mocks.history.mockResolvedValue([{ role: 'user', content: 'raw' }])
})

describe('Studio context compression ownership', () => {
  it('uses the public facade with explicit configuration and stable session identity', async () => {
    expect(await getSessionCompressionOwner('s', 'p')).toMatchObject(binding)
    expect(mocks.status).toHaveBeenCalledWith('s', 'p', { context_manager: binding })
    expect(mocks.ensure).toHaveBeenCalledWith('p', 'hermes', 's', expect.objectContaining(binding))
  })
  it('does not discover a Hermes worker for Ekko', async () => {
    mocks.session.mockReturnValue({ id: 's', agent: 'ekko-agent', profile: 'p' })
    await getSessionCompressionOwner('s', 'p')
    expect(mocks.binding).toHaveBeenCalledWith('p', 'ekko', 's')
    expect(mocks.create).not.toHaveBeenCalled()
  })
  it.each(['native', 'bili'] as const)('does not reject a healthy %s owner when fallback permission is enabled', async manager => {
    const permitted = { ...binding, manager, allowNativeFallback: true }
    mocks.binding.mockResolvedValue(permitted)
    mocks.status.mockResolvedValue({ context_manager: { ...permitted, selectedManager: manager } })
    expect(await getSessionCompressionOwner('s', 'p')).toMatchObject(permitted)
    expect(mocks.status).toHaveBeenCalledWith('s', 'p', { context_manager: permitted })
  })
  it('rejects an unverified fallback policy returned by the worker', async () => {
    mocks.binding.mockResolvedValue({ ...binding, allowNativeFallback: true })
    await expect(getSessionCompressionOwner('s', 'p')).rejects.toThrow(/ownership/)
  })
  it('passes raw automatic history without native compression', async () => {
    expect(await buildCompressedHistory('s', 'p', '', undefined, vi.fn(), new Map())).toEqual([{ role: 'user', content: 'raw' }])
    expect(mocks.status).toHaveBeenCalledTimes(1)
    expect(mocks.compressor).not.toHaveBeenCalled()
  })
  it.each([false, true])('blocks native snapshot repair and deletion during migration with fallback permission %s', async allowNativeFallback => {
    mocks.binding.mockResolvedValue({ ...binding, allowNativeFallback })
    mocks.status.mockResolvedValue({ context_manager: { ...binding, allowNativeFallback } })
    mocks.snapshot.mockReturnValue({ summary: 'irreversible', lastMessageIndex: 100 })
    await expect(buildSnapshotAwareHistory('s', 'p', [])).rejects.toThrow(/migration/)
    await expect(buildDbSnapshotAwareHistory('s', 'p')).rejects.toThrow(/migration/)
    await expect(buildCompressedHistory('s', 'p', '', undefined, vi.fn(), new Map())).rejects.toThrow(/migration/)
    expect(mocks.deleteSnapshot).not.toHaveBeenCalled()
  })
  it('rejects a different worker conversation identity', async () => {
    mocks.status.mockResolvedValue({ context_manager: { ...binding, conversationId: 'other' } })
    await expect(getSessionCompressionOwner('s', 'p')).rejects.toThrow(/identity/)
  })
  it.each([false, true])('propagates bili discovery failure without a native fallback when permission is %s', async allowNativeFallback => {
    mocks.binding.mockResolvedValue({ ...binding, allowNativeFallback })
    mocks.status.mockRejectedValue(new Error('plugin inactive'))
    await expect(buildCompressedHistory('s', 'p', '', undefined, vi.fn(), new Map())).rejects.toThrow('plugin inactive')
    expect(mocks.compressor).not.toHaveBeenCalled()
  })
  it('rejects a worker-owned native downgrade even when fallback permission is enabled', async () => {
    mocks.binding.mockResolvedValue({ ...binding, allowNativeFallback: true })
    mocks.status.mockResolvedValue({ context_manager: { ...binding, manager: 'native', selectedManager: 'bili', allowNativeFallback: true, fallbackReason: 'unavailable' } })
    await expect(getSessionCompressionOwner('s', 'p')).rejects.toThrow(/ownership/)
    expect(mocks.compressor).not.toHaveBeenCalled()
    expect(mocks.ensure).not.toHaveBeenCalled()
  })

  it('supports unconfigured native unit callers but does not swallow configured runtime failures', async () => {
    mocks.binding.mockResolvedValue({ ...binding, manager: 'native' })
    mocks.manager.mockImplementation(() => { throw new Error('Studio chat Agent runtime has not been configured') })
    expect(await getSessionCompressionOwner('s', 'p')).toMatchObject({ manager: 'native' })
    mocks.manager.mockImplementation(() => { throw new Error('bridge connection failed') })
    await expect(getSessionCompressionOwner('s', 'p')).rejects.toThrow('bridge connection failed')
  })
  it.each([false, true])('keeps an independently enabled bili plugin as the sole owner with fallback permission %s', async allowNativeFallback => {
    mocks.binding.mockResolvedValue({ ...binding, manager: 'native', allowNativeFallback })
    const observed = { ...binding, selectedManager: 'native', independentPlugin: true, allowNativeFallback }
    mocks.status.mockResolvedValue({ context_manager: observed })
    expect(await getSessionCompressionOwner('s', 'p')).toMatchObject(observed)
    expect(await buildCompressedHistory('s', 'p', '', undefined, vi.fn(), new Map())).toEqual([{ role: 'user', content: 'raw' }])
    expect(mocks.history).toHaveBeenCalledWith('s', { excludeLastUser: true, truncateToolResults: false })
    await expect(forceCompressBridgeHistory('s', 'p', [])).rejects.toThrow(/bili/)
    expect(mocks.compressor).not.toHaveBeenCalled()
  })
  it.each([false, true])('requires snapshot migration for an independent bili owner with fallback permission %s', async allowNativeFallback => {
    mocks.binding.mockResolvedValue({ ...binding, manager: 'native', allowNativeFallback })
    mocks.status.mockResolvedValue({ context_manager: { ...binding, selectedManager: 'native', independentPlugin: true, allowNativeFallback } })
    mocks.snapshot.mockReturnValue({ summary: 'irreversible', lastMessageIndex: 100 })
    await expect(buildCompressedHistory('s', 'p', '', undefined, vi.fn(), new Map())).rejects.toThrow(/migration/)
    expect(mocks.history).not.toHaveBeenCalled()
    expect(mocks.deleteSnapshot).not.toHaveBeenCalled()
    expect(mocks.compressor).not.toHaveBeenCalled()
  })
})
