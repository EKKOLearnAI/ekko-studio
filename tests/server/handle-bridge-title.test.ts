import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  getFirstSessionMessageByRole: vi.fn(),
  updateSession: vi.fn(),
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  bridgeLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../../packages/server/src/modules/studio/repositories/session-store', () => ({
  getSession: mocks.getSession,
  getFirstSessionMessageByRole: mocks.getFirstSessionMessageByRole,
  updateSession: mocks.updateSession,
}))

vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({
  logger: mocks.logger,
  bridgeLogger: mocks.bridgeLogger,
}))

describe('syncBridgeGeneratedTitle', () => {
  beforeEach(() => {
    vi.resetAllMocks()
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
})
