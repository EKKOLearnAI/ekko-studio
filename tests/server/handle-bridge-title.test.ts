import { beforeEach, describe, expect, it, vi } from 'vitest'
import { extractTextForPreview } from '../../packages/server/src/modules/studio/services/chat-run/content-blocks'

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  getFirstSessionMessageByRole: vi.fn(),
  getSessionMessageCountByRole: vi.fn(),
  updateSession: vi.fn(),
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  bridgeLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../../packages/server/src/modules/studio/repositories/session-store', () => ({
  getSession: mocks.getSession,
  getFirstSessionMessageByRole: mocks.getFirstSessionMessageByRole,
  getSessionMessageCountByRole: mocks.getSessionMessageCountByRole,
  updateSession: mocks.updateSession,
}))

vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({
  logger: mocks.logger,
  bridgeLogger: mocks.bridgeLogger,
}))

describe('syncBridgeGeneratedTitle', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.getSessionMessageCountByRole.mockReturnValue(1)
    mocks.getSession.mockReturnValue({
      id: 'session-1',
      source: 'cli',
      title: '帮忙检查并扩充该笔记。',
      preview: '检查完成。',
    })
    mocks.getFirstSessionMessageByRole.mockReturnValue({
      content: JSON.stringify([
        { type: 'text', text: '帮忙检查并扩充该笔记。' },
        { type: 'image', source: { type: 'base64', data: 'image-data' } },
      ]),
    })
  })

  it('replaces the extracted content-block title with the generated title', async () => {
    const { syncBridgeGeneratedTitle } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-bridge-run')
    const emit = vi.fn()

    expect(syncBridgeGeneratedTitle('session-1', '检查并扩充 SRAM 笔记。', emit)).toBe(true)
    expect(mocks.updateSession).toHaveBeenCalledWith('session-1', expect.objectContaining({ title: '检查并扩充 SRAM 笔记。' }))
    expect(emit).toHaveBeenCalledWith('session.title.updated', expect.objectContaining({ title: '检查并扩充 SRAM 笔记。' }))
  })

  it('does not replace a manually chosen title', async () => {
    mocks.getSession.mockReturnValue({
      id: 'session-1',
      source: 'cli',
      title: 'Pinned research notes',
      preview: '帮忙检查并扩充该笔记。',
    })
    const { syncBridgeGeneratedTitle } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-bridge-run')

    expect(syncBridgeGeneratedTitle('session-1', 'Generated title', vi.fn())).toBe(false)
    expect(mocks.updateSession).not.toHaveBeenCalled()
  })

  it.each([
    'Explain this JSON content block',
    'Explain this JSON content block. '.repeat(8),
  ])('preserves generated titles for a plain-text JSON prompt: %s', async (text) => {
    const input = JSON.stringify([{ type: 'text', text }])
    const title = extractTextForPreview(input).replace(/[\r\n]/g, ' ').substring(0, 100)
    mocks.getSession.mockReturnValue({ id: 'session-1', source: 'cli', title, preview: '' })
    mocks.getFirstSessionMessageByRole.mockReturnValue({ content: input })
    const { syncBridgeGeneratedTitle } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-bridge-run')
    const emit = vi.fn()

    expect(syncBridgeGeneratedTitle('session-1', 'JSON content block explained', emit)).toBe(true)
    expect(mocks.updateSession).toHaveBeenCalledWith('session-1', expect.objectContaining({ title: 'JSON content block explained' }))
    expect(emit).toHaveBeenCalledWith('session.title.updated', expect.objectContaining({ title: 'JSON content block explained' }))
  })

  it.each(['\n\n', '\r\n', '   ', '\t\t'])('replaces a truncated attachment title containing %j', async (separator) => {
    const input = [{ type: 'text' as const, text: 'A'.repeat(50) + separator + 'B'.repeat(80) }]
    const title = extractTextForPreview(input).replace(/[\r\n]/g, ' ').substring(0, 100)
    const blocks = [...input, { type: 'file', name: 'notes.md', path: '/tmp/notes.md', media_type: 'text/markdown' }]
    mocks.getSession.mockReturnValue({ id: 'session-1', source: 'cli', title, preview: '' })
    mocks.getFirstSessionMessageByRole.mockReturnValue({ content: JSON.stringify(blocks) })
    const { syncBridgeGeneratedTitle } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-bridge-run')

    expect(syncBridgeGeneratedTitle('session-1', 'Notes summary', vi.fn())).toBe(true)
    expect(mocks.updateSession).toHaveBeenCalledWith('session-1', expect.objectContaining({ title: 'Notes summary' }))
  })
  it.each(['manual', 'ai'])('protects explicit %s provenance even when the text equals the first input', async title_origin => {
    mocks.getSession.mockReturnValue({ id: 'session-1', source: 'cli', title: '帮忙检查并扩充该笔记。', title_origin })
    const { syncBridgeGeneratedTitle } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-bridge-run')
    expect(syncBridgeGeneratedTitle('session-1', 'Replacement', vi.fn(), 'llm')).toBe(false)
    expect(mocks.updateSession).not.toHaveBeenCalled()
  })

  it('upgrades a derived title to LLM provenance instead of treating it as a manual name', async () => {
    mocks.getSession.mockReturnValue({ id: 'session-1', source: 'cli', title: 'A derived topic', title_origin: 'fallback' })
    const { syncBridgeGeneratedTitle } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-bridge-run')
    expect(syncBridgeGeneratedTitle('session-1', 'A derived topic', vi.fn(), 'llm')).toBe(true)
    expect(mocks.updateSession).toHaveBeenCalledWith('session-1', expect.objectContaining({ title_origin: 'ai' }))
  })

  it('keeps polling past an instant derived title to receive the delayed LLM upgrade on turn three', async () => {
    mocks.getSessionMessageCountByRole.mockReturnValue(3)
    const session = { id: 'session-1', source: 'cli', profile: 'p', agent: '', history_revision: 0, title: '', title_origin: 'fallback' }
    mocks.getSession.mockImplementation(() => ({ ...session }))
    mocks.getFirstSessionMessageByRole.mockReturnValue({ id: 10, content: 'Explain async titles' })
    mocks.updateSession.mockImplementation((_id, patch) => Object.assign(session, patch))
    const bridge = { getSessionTitle: vi.fn().mockResolvedValueOnce({ title: 'Stale summary', source: 'llm', run_id: 'old-run' }).mockResolvedValueOnce({ title: 'Instant slice', source: 'derived', run_id: 'current-run' }).mockResolvedValueOnce({ title: 'LLM summary', source: 'llm', run_id: 'current-run' }) }
    const { pollBridgeGeneratedTitleAfterRun } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-bridge-run')
    await pollBridgeGeneratedTitleAfterRun(bridge as any, 'session-1', 'p', vi.fn(), 'current-run')
    expect(bridge.getSessionTitle).toHaveBeenCalledTimes(3)
    expect(mocks.updateSession).not.toHaveBeenCalledWith('session-1', expect.objectContaining({ title: 'Stale summary' }))
    expect(session.title).toBe('LLM summary')
    expect(session.title_origin).toBe('ai')
  })

  it('discards a poll result when history was cleared while the request was pending', async () => {
    const session = { id: 'session-1', source: 'cli', profile: 'p', agent: '', history_revision: 0, title: '', title_origin: 'fallback' }
    mocks.getSession.mockImplementation(() => ({ ...session }))
    mocks.getFirstSessionMessageByRole.mockReturnValue({ id: 10, content: 'First input' })
    const bridge = { getSessionTitle: vi.fn(async () => { session.history_revision++; return { title: 'Old history title', source: 'llm' } }) }
    const { pollBridgeGeneratedTitleAfterRun } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-bridge-run')
    await pollBridgeGeneratedTitleAfterRun(bridge as any, 'session-1', 'p', vi.fn())
    expect(mocks.updateSession).not.toHaveBeenCalled()
  })

})
