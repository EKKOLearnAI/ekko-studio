import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { createServer, request as httpRequest, type Server as HttpServer } from 'http'
import Koa from 'koa'

const dbMock = vi.hoisted(() => ({
  current: null as DatabaseSync | null,
}))

const { mockIo, mockSocket } = vi.hoisted(() => {
  const mockSocket: any = {
    id: 'agent-socket-1',
    connected: true,
    io: { on: vi.fn() },
    on: vi.fn((event: string, handler: (...args: any[]) => void) => {
      if (event === 'connect') queueMicrotask(() => handler())
      return mockSocket
    }),
    emit: vi.fn(),
    disconnect: vi.fn(),
  }
  return {
    mockSocket,
    mockIo: vi.fn(() => mockSocket),
  }
})

vi.mock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({
  getDb: () => dbMock.current,
}))

vi.mock('socket.io-client', () => ({
  io: mockIo,
}))

vi.mock('../../packages/server/src/modules/studio/services/auth/token-auth', () => ({
  getToken: vi.fn(async () => 'test-token'),
}))

import { countTokens } from '../../packages/server/src/modules/studio/services/context-compressor'
import { initAllHermesTables } from '../../packages/server/src/modules/studio/infrastructure/database/schemas'
import { healthRoutes } from '../../packages/server/src/bootstrap/health'
import { GroupChatServer } from '../../packages/server/src/modules/studio/sockets/group-chat'
import { AgentClients, mentionMessageToStoredContextMessage } from '../../packages/server/src/modules/studio/services/group-chat/agent-clients'
import { sortGroupMessagesCanonical } from '../../packages/server/src/modules/studio/services/group-chat/group-message-ordering'
import { groupRunUsageMessage } from '../../packages/server/src/modules/studio/services/group-chat/run-usage'
import { GroupRoomSummaryService, type GroupSummaryRunner } from '../../packages/server/src/modules/studio/services/group-chat/room-summary'

function makeDb(): DatabaseSync {
  return new DatabaseSync(':memory:')
}

function makeMessage(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'msg-1',
    roomId: 'room-1',
    senderId: 'user-1',
    senderName: 'Alice',
    content: 'hello',
    timestamp: 1,
    role: 'user',
    ...overrides,
  }
}

describe('group chat history windows', () => {
  it('maps routed mention ids into context-engine current message cursors', () => {
    const current = mentionMessageToStoredContextMessage('room-1', {
      messageId: 'trigger-msg',
      content: '@Worker use the context through this message only',
      senderName: 'Alice',
      senderId: 'user-1',
      timestamp: 123,
      senderKind: 'user',
    })

    expect(current.id).toBe('trigger-msg')
    expect(current.roomId).toBe('room-1')
    expect(current.role).toBe('user')
  })

  let httpServer: HttpServer
  let groupServer: GroupChatServer

  beforeEach(() => {
    vi.clearAllMocks()
    dbMock.current = makeDb()
    initAllHermesTables()
    httpServer = createServer()
    groupServer = new GroupChatServer(httpServer)
  })

  afterEach(() => {
    groupServer?.getIO().close()
    httpServer?.close()
    dbMock.current?.close()
    dbMock.current = null
  })

  it('returns bounded UI and context windows in canonical order', () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Room 1')

    const seeded = Array.from({ length: 160 }, (_value, index) => makeMessage({
      id: `msg-${index + 1}`,
      content: `message ${index + 1}`,
      timestamp: index + 1,
    }))

    for (const message of seeded) storage.saveMessageAndRefreshRoom(message as any)

    const recentMessages = storage.getRecentMessagesForUI('room-1')
    const contextMessages = storage.getMessagesForContext('room-1')

    expect(recentMessages).toHaveLength(150)
    expect(recentMessages[0]?.id).toBe('msg-11')
    expect(recentMessages.at(-1)?.id).toBe('msg-160')
    expect(contextMessages).toHaveLength(160)
    expect(contextMessages.map(message => message.id)).toEqual(
      sortGroupMessagesCanonical(seeded as Array<{ id: string; timestamp: number }>).map(message => message.id),
    )
  })

  it('persists and updates one usage card without consuming room tokens or model context', () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Room 1')
    storage.saveMessageAndRefreshRoom(makeMessage({ id: 'reply', role: 'assistant', content: 'Done', run_id: 'group-run' }) as any)
    const originalTokens = storage.getRoom('room-1')!.totalTokens
    const usage = { runId: 'runtime-run', assistantMessageId: 'reply', inputTokens: 1200, outputTokens: 200,
      cacheReadTokens: 300, cacheHitRate: 0.25, costUsd: 0.0123, tokensPerSecond: 50, speedSource: 'model', isEstimated: false }
    for (const outputTokens of [200, 250]) {
      const card = groupRunUsageMessage('room-1', 'session', 'group-run', 'reply', { ...usage, outputTokens })!
      storage.saveMessageAndRefreshRoom(makeMessage({ ...card, ...card.extra, senderId: 'agent', senderType: 'agent', timestamp: 2 }) as any)
    }
    const cards = storage.getRecentMessagesForUI('room-1').filter(message => message.tool_name === 'run_usage')
    expect(cards).toHaveLength(1)
    expect(JSON.parse(cards[0].content)).toMatchObject({ outputTokens: 250 })
    expect(storage.getRoom('room-1')!.totalTokens).toBe(originalTokens)
    expect(storage.getMessagesForContext('room-1').map(message => message.id)).toEqual(['reply'])
    expect(() => storage.saveMessageAndRefreshRoom({ ...cards[0], run_id: 'other-run' })).toThrow('Invalid group run usage')
  })

  it('bounds tool results only in the outbound UI page and retains full group history', () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Room 1')
    const completeResult = 'tool-result-'.repeat(400)
    storage.saveMessageAndRefreshRoom(makeMessage({
      id: 'tool-result-1',
      role: 'tool',
      tool_name: 'read_file',
      tool_call_id: 'call-1',
      content: completeResult,
    }) as any)

    const [outbound] = storage.getRecentMessagesForUI('room-1') as Array<Record<string, any>>

    expect(outbound.content).toHaveLength(1_000)
    expect(outbound.content_truncated).toBe(true)
    expect(outbound.content_original_length).toBe(completeResult.length)
    expect(storage.getMessage('tool-result-1')?.content).toBe(completeResult)
    expect(storage.getMessagesForContext('room-1')[0]?.content).toBe(completeResult)
  })

  it('keeps workspace diff payloads complete in the outbound UI page', () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Room 1')
    const completeDiff = JSON.stringify({
      kind: 'workspace_diff',
      files: [{ path: 'large.ts', patch: '+'.repeat(4_000) }],
    })
    storage.saveMessageAndRefreshRoom(makeMessage({
      id: 'workspace-diff-1',
      role: 'tool',
      tool_name: 'workspace_diff',
      tool_call_id: 'workspace_diff:run-1',
      content: completeDiff,
    }) as any)

    const [outbound] = storage.getRecentMessagesForUI('room-1') as Array<Record<string, any>>

    expect(outbound.content).toBe(completeDiff)
    expect(outbound.content_truncated).toBeUndefined()
  })

  it('does not split same-timestamp multipart assistant/tool runs across UI page boundaries', () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Room 1')

    const seeded = [
      makeMessage({ id: 'run-1_part_0', role: 'assistant', senderId: 'agent-1', senderName: 'Agent', content: 'assistant', timestamp: 100 }),
      makeMessage({ id: 'run-1_part_0_toolcall_t', role: 'assistant', senderId: 'agent-1', senderName: 'Agent', content: '', timestamp: 100 }),
      makeMessage({ id: 'run-1_part_0_toolresult_t', role: 'tool', senderId: 'agent-1', senderName: 'Agent', content: 'tool result', timestamp: 100 }),
      makeMessage({ id: 'run-2', role: 'user', senderId: 'user-1', senderName: 'Human', content: 'next', timestamp: 100 }),
    ]

    for (const message of seeded) storage.saveMessageAndRefreshRoom(message as any)

    expect(storage.getRecentMessagesForUI('room-1', 2, 0).map(message => message.id)).toEqual([
      'run-1_part_0',
      'run-1_part_0_toolcall_t',
      'run-1_part_0_toolresult_t',
      'run-2',
    ])
    expect(storage.getRecentMessagesForUI('room-1', 2, 2).map(message => message.id)).toEqual([
      'run-1_part_0',
      'run-1_part_0_toolcall_t',
      'run-1_part_0_toolresult_t',
    ])
  })

  it('expands complete-history pages instead of splitting an Agent run at the nominal boundary', () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Room 1')

    const runMessages = [
      makeMessage({
        id: 'boundary-run_part_0',
        role: 'assistant',
        senderId: 'agent-1',
        senderName: 'Agent',
        content: 'starting',
        timestamp: 100,
      }),
      makeMessage({
        id: 'boundary-run_part_0_toolcall_t',
        role: 'assistant',
        senderId: 'agent-1',
        senderName: 'Agent',
        content: '',
        timestamp: 101,
      }),
      makeMessage({
        id: 'boundary-run_part_0_toolresult_t',
        role: 'tool',
        senderId: 'agent-1',
        senderName: 'Agent',
        content: 'tool result',
        timestamp: 102,
      }),
    ]
    const newerMessages = Array.from({ length: 149 }, (_value, index) => makeMessage({
      id: `newer-${String(index + 1).padStart(3, '0')}`,
      content: `newer ${index + 1}`,
      timestamp: 1_000 + index,
    }))
    for (const message of [...runMessages, ...newerMessages]) {
      storage.saveMessageAndRefreshRoom(message as any)
    }

    const page = storage.getHistoryPageForUI('room-1', 150)

    expect(page.messages).toHaveLength(152)
    expect(page.messages.slice(0, 3).map(message => message.id)).toEqual(
      runMessages.map(message => message.id),
    )
    expect(page.hasMore).toBe(false)
  })

  it('bounds same-timestamp overflow while retaining the newest context messages', () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Room 1')
    for (let index = 0; index < 2_000; index += 1) {
      storage.addMessage(makeMessage({
        id: `same-time-${String(index).padStart(4, '0')}`,
        content: `same timestamp ${index}`,
        timestamp: 100,
      }) as any)
    }

    const context = storage.getMessagesForContext('room-1')

    expect(context.length).toBeLessThanOrEqual(600)
    expect(context.at(-1)?.id).toBe('same-time-1999')
  })

  it('honors throughMessageId inside a 2,000-message equal-timestamp group', () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Room 1')
    for (let index = 0; index < 2_000; index += 1) {
      storage.addMessage(makeMessage({
        id: `same-time-${String(index).padStart(4, '0')}`,
        content: `same timestamp ${index}`,
        timestamp: 100,
      }) as any)
    }

    const context = storage.getMessagesForContext('room-1', {
      throughMessageId: 'same-time-0500',
    })

    expect(context).toHaveLength(501)
    expect(context[0]?.id).toBe('same-time-0000')
    expect(context.at(-1)?.id).toBe('same-time-0500')
    expect(context.some(message => message.id > 'same-time-0500')).toBe(false)
  })

  it('uses the same binary id order as SQLite for equal-timestamp cursors', () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Room 1')
    for (const id of ['A', 'a', '1', '_', '中']) {
      storage.addMessage(makeMessage({ id, content: id, timestamp: 100 }) as any)
    }

    const ordered = sortGroupMessagesCanonical(
      ['A', 'a', '1', '_', '中'].map(id => ({ id, timestamp: 100 })),
    ).map(message => message.id)
    const through = 'A'
    const expected = ordered.slice(0, ordered.indexOf(through) + 1)

    expect(storage.getMessagesForContext('room-1', { throughMessageId: through }).map(message => message.id))
      .toEqual(expected)
  })

  it('uses SQLite UTF-8 binary order for supplementary-plane cursor ids', () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Room 1')
    const ids = ['中', '\uE000', '😀']
    for (const id of ids) {
      storage.addMessage(makeMessage({ id, content: id, timestamp: 100 }) as any)
    }

    const ordered = sortGroupMessagesCanonical(ids.map(id => ({ id, timestamp: 100 })))
      .map(message => message.id)
    const through = '😀'

    expect(ordered).toEqual(['中', '\uE000', '😀'])
    expect(storage.getMessagesForContext('room-1', { throughMessageId: through }).map(message => message.id))
      .toEqual(ordered)
  })

  it('computes room total tokens from the context window, not the UI page window', () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Room 1')

    const seeded = Array.from({ length: 160 }, (_value, index) => makeMessage({
      id: `msg-${index + 1}`,
      content: `message-${index + 1}`,
      timestamp: index + 1,
    }))

    let latest: { totalTokens: number } | null = null
    for (const message of seeded) latest = storage.saveMessageAndRefreshRoom(message as any)

    const expectedTotalTokens = seeded.reduce((sum, message) => sum + countTokens(String(message.content)), 0)

    expect(storage.getRecentMessagesForUI('room-1')).toHaveLength(150)
    expect(storage.getMessagesForContext('room-1')).toHaveLength(160)
    expect(latest?.totalTokens).toBe(expectedTotalTokens)
    expect(storage.getRoom('room-1')?.totalTokens).toBe(expectedTotalTokens)
  })

  it('accounts from the normalized content that was actually persisted', () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Room 1')
    const dataImage = `data:image/png;base64,${'A'.repeat(300_000)}`

    const inserted = storage.saveMessageAndRefreshRoom(makeMessage({
      id: 'normalized-tool',
      role: 'tool',
      senderId: 'agent-1',
      senderName: 'Agent',
      content: JSON.stringify({
        _multimodal: true,
        content: [{ type: 'image_url', image_url: { url: dataImage } }],
      }),
      timestamp: 1,
    }) as any)

    expect(inserted.message.content).toBe('[screenshot]')
    expect(inserted.totalTokens).toBe(countTokens('[screenshot]'))
    expect(storage.getRoom('room-1')?.totalTokens).toBe(countTokens('[screenshot]'))

    const updated = storage.saveMessageAndRefreshRoom(makeMessage({
      id: 'normalized-tool',
      role: 'tool',
      senderId: 'agent-1',
      senderName: 'Agent',
      content: 'small canonical update',
      timestamp: 1,
    }) as any)
    expect(updated.totalTokens).toBe(countTokens('small canonical update'))

    for (let index = 0; index < 500; index += 1) {
      storage.saveMessageAndRefreshRoom(makeMessage({
        id: `evict-${String(index).padStart(3, '0')}`,
        content: `replacement ${index}`,
        timestamp: index + 2,
      }) as any)
    }
    const expectedAfterEviction = Array.from(
      { length: 500 },
      (_value, index) => countTokens(`replacement ${index}`),
    ).reduce((sum, tokens) => sum + tokens, 0)
    expect(storage.getRoom('room-1')?.totalTokens).toBe(expectedAfterEviction)
  })

  it('migrates the context-window index onto an existing messages table', () => {
    dbMock.current!.exec('DROP INDEX idx_gc_messages_context_window')

    initAllHermesTables()

    const migrated = dbMock.current!.prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?`,
    ).get('idx_gc_messages_context_window') as { sql: string } | undefined
    expect(migrated?.sql).toContain("WHERE COALESCE(tool_name, '') <> 'workspace_diff'")
  })

  it('uses the context-window index without a table scan or temporary sort', () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Room 1')
    for (let index = 0; index < 600; index += 1) {
      storage.addMessage(makeMessage({
        id: `indexed-${index}`,
        content: `indexed message ${index}`,
        timestamp: index + 1,
      }) as any)
    }

    const boundaryPlan = dbMock.current!.prepare(
      `EXPLAIN QUERY PLAN
       SELECT timestamp FROM gc_messages
       WHERE roomId = ? AND COALESCE(tool_name, '') <> 'workspace_diff'
       ORDER BY timestamp DESC, id DESC
       LIMIT 1 OFFSET ?`,
    ).all('room-1', 499) as Array<{ detail: string }>
    const idPlan = dbMock.current!.prepare(
      `EXPLAIN QUERY PLAN
       SELECT id FROM gc_messages
       WHERE roomId = ? AND COALESCE(tool_name, '') <> 'workspace_diff' AND timestamp >= ?
       ORDER BY timestamp DESC, id DESC
       LIMIT ?`,
    ).all('room-1', 100, 600) as Array<{ detail: string }>
    const details = [...boundaryPlan, ...idPlan].map(row => row.detail).join('\n')

    expect(details).toContain('idx_gc_messages_context_window')
    expect(details).not.toContain('SCAN gc_messages')
    expect(details).not.toContain('USE TEMP B-TREE')
  })

  it('rebuilds a legacy cached total before applying an incremental message update', () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Room 1')
    const oversized = makeMessage({
      id: 'legacy-large',
      content: 'a '.repeat(131_073),
      timestamp: 1,
    })
    storage.addMessage(oversized as any)
    // Simulate a pre-upgrade cache populated by the old exact-tokenizer path.
    storage.updateRoomTotalTokens('room-1', 131_074)
    dbMock.current!.prepare(
      'UPDATE gc_rooms SET tokenAccountingVersion = 0 WHERE id = ?',
    ).run('room-1')

    const replacement = makeMessage({ id: 'legacy-large', content: 'a', timestamp: 2 })
    const saved = storage.saveMessageAndRefreshRoom(replacement as any)

    expect(saved.totalTokens).toBe(countTokens('a'))
    expect(storage.getRoom('room-1')?.totalTokens).toBe(countTokens('a'))
  })

  it('marks new rooms with the current token-accounting version', () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Room 1')

    const row = dbMock.current!.prepare(
      'SELECT tokenAccountingVersion FROM gc_rooms WHERE id = ?',
    ).get('room-1') as { tokenAccountingVersion: number }

    expect(row.tokenAccountingVersion).toBe(1)
  })

  it('marks rooms from the legacy schema for bounded token-accounting rebuild', () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('legacy-room', 'Legacy Room')
    dbMock.current!.exec('ALTER TABLE gc_rooms DROP COLUMN tokenAccountingVersion')

    initAllHermesTables()

    const row = dbMock.current!.prepare(
      'SELECT tokenAccountingVersion FROM gc_rooms WHERE id = ?',
    ).get('legacy-room') as { tokenAccountingVersion: number }
    expect(row.tokenAccountingVersion).toBe(0)
  })

  it('rebuilds legacy totals in both rooms before moving a message', () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Room 1')
    storage.saveRoom('room-2', 'Room 2')
    const source = makeMessage({ id: 'moving', roomId: 'room-1', content: 'source', timestamp: 1 })
    const target = makeMessage({ id: 'target', roomId: 'room-2', content: 'target', timestamp: 1 })
    storage.addMessage(source as any)
    storage.addMessage(target as any)
    dbMock.current!.prepare(
      'UPDATE gc_rooms SET totalTokens = 999999, tokenAccountingVersion = 0 WHERE id IN (?, ?)',
    ).run('room-1', 'room-2')

    const moved = makeMessage({ id: 'moving', roomId: 'room-2', content: 'moved', timestamp: 2 })
    const saved = storage.saveMessageAndRefreshRoom(moved as any)

    expect(storage.getRoom('room-1')?.totalTokens).toBe(0)
    expect(saved.totalTokens).toBe(countTokens('target') + countTokens('moved'))
  })

  it('updates room token totals without retokenizing the complete context window', () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Room 1')

    const seeded = Array.from({ length: 500 }, (_value, index) => makeMessage({
      id: `msg-${index + 1}`,
      content: `history-${index + 1}`,
      timestamp: index + 1,
    }))
    for (const message of seeded) storage.addMessage(message as any)

    const initialTotal = seeded.reduce((sum, message) => sum + countTokens(String(message.content)), 0)
    storage.updateRoomTotalTokens('room-1', initialTotal)
    const fullWindowRead = vi.spyOn(storage, 'getMessagesForContext')

    const incoming = makeMessage({ id: 'msg-501', content: 'newest-message', timestamp: 501 })
    const saved = storage.saveMessageAndRefreshRoom(incoming as any)

    expect(fullWindowRead).not.toHaveBeenCalled()
    expect(saved.totalTokens).toBe(
      initialTotal
      - countTokens(String(seeded[0].content))
      + countTokens(String(incoming.content)),
    )
    expect(storage.getRoom('room-1')?.totalTokens).toBe(saved.totalTokens)
  })

  it('adjusts the cached room total when an existing message is updated', () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Room 1')
    const first = makeMessage({ id: 'msg-1', content: 'short', timestamp: 1 })
    const initial = storage.saveMessageAndRefreshRoom(first as any).totalTokens
    const updated = makeMessage({ id: 'msg-1', content: 'a substantially longer updated message', timestamp: 2 })

    const saved = storage.saveMessageAndRefreshRoom(updated as any)

    expect(saved.totalTokens).toBe(
      initial - countTokens(String(first.content)) + countTokens(String(updated.content)),
    )
    expect(storage.getRoom('room-1')?.totalTokens).toBe(saved.totalTokens)
  })

  it('updates both cached room totals when an existing message moves between rooms', () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Room 1')
    storage.saveRoom('room-2', 'Room 2')
    const original = makeMessage({ id: 'shared-id', roomId: 'room-1', content: 'source room content', timestamp: 1 })
    const originalTokens = storage.saveMessageAndRefreshRoom(original as any).totalTokens
    const moved = makeMessage({ id: 'shared-id', roomId: 'room-2', content: 'target room content', timestamp: 2 })

    const result = storage.saveMessageAndRefreshRoom(moved as any)

    expect(originalTokens).toBe(countTokens(String(original.content)))
    expect(storage.getRoom('room-1')?.totalTokens).toBe(0)
    expect(result.totalTokens).toBe(countTokens(String(moved.content)))
    expect(storage.getRoom('room-2')?.totalTokens).toBe(result.totalTokens)
  })

  it('includes every same-timestamp boundary message in the incremental token total', () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Room 1')
    const seeded = Array.from({ length: 501 }, (_value, index) => makeMessage({
      id: `boundary-${index}`,
      content: `boundary message ${index}`,
      timestamp: index < 3 ? 1 : index - 1,
    }))
    for (const message of seeded.slice(0, 500)) storage.addMessage(message as any)
    const initialWindow = storage.getMessagesForContext('room-1')
    const initialTotal = initialWindow.reduce((sum, message) => sum + countTokens(String(message.content)), 0)
    storage.updateRoomTotalTokens('room-1', initialTotal)

    const saved = storage.saveMessageAndRefreshRoom(seeded[500] as any)
    const expected = storage.getMessagesForContext('room-1')
      .reduce((sum, message) => sum + countTokens(String(message.content)), 0)

    expect(saved.totalTokens).toBe(expected)
  })

  it('persists a production-sized tool result without multi-second tokenization stalls', () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Room 1')
    const unit = 'abcdefghijklmnopqrstuvwxyz0123456789 '
    const content = unit.repeat(Math.ceil(6_204_367 / unit.length)).slice(0, 6_204_367)
    const start = performance.now()

    const saved = storage.saveMessageAndRefreshRoom(makeMessage({
      id: 'large-tool-result',
      senderId: 'agent-1',
      senderName: 'Agent',
      role: 'tool',
      tool_name: 'api_request',
      tool_call_id: 'call-large',
      content,
      timestamp: 1,
    }) as any)
    const elapsedMs = performance.now() - start

    expect(saved.totalTokens).toBeGreaterThan(0)
    expect(elapsedMs).toBeLessThan(1_000)
  })

  it('does not reread a production-sized tool result for each later message', () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Room 1')
    const unit = 'abcdefghijklmnopqrstuvwxyz0123456789 '
    const content = unit.repeat(Math.ceil(6_204_367 / unit.length)).slice(0, 6_204_367)
    storage.saveMessageAndRefreshRoom(makeMessage({
      id: 'large-tool-result',
      senderId: 'agent-1',
      senderName: 'Agent',
      role: 'tool',
      tool_name: 'api_request',
      tool_call_id: 'call-large',
      content,
      timestamp: 1,
    }) as any)

    const start = performance.now()
    for (let index = 0; index < 50; index += 1) {
      storage.saveMessageAndRefreshRoom(makeMessage({
        id: `small-${index}`,
        content: `small message ${index}`,
        timestamp: index + 2,
      }) as any)
    }
    const elapsedMs = performance.now() - start

    expect(elapsedMs).toBeLessThan(500)
  })

  it('keeps a livez response within budget under production-sized group chat load', async () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Room 1')
    for (let index = 0; index < 500; index += 1) {
      storage.addMessage(makeMessage({
        id: `history-${index}`,
        content: `history message ${index}`,
        timestamp: index + 1,
      }) as any)
    }
    storage.updateRoomTotalTokens(
      'room-1',
      Array.from({ length: 500 }, (_value, index) => countTokens(`history message ${index}`))
        .reduce((sum, tokens) => sum + tokens, 0),
    )

    const healthApp = new Koa()
    healthApp.use(healthRoutes.routes())
    const healthServer = createServer(healthApp.callback())
    await new Promise<void>(resolve => healthServer.listen(0, '127.0.0.1', resolve))
    const address = healthServer.address()
    if (!address || typeof address === 'string') throw new Error('missing health port')
    const startedAt = performance.now()
    const response = new Promise<{ body: string; elapsedMs: number }>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port: address.port, path: '/livez' }, res => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', chunk => { body += chunk })
        res.on('end', () => resolve({ body, elapsedMs: performance.now() - startedAt }))
      })
      req.on('error', reject)
      req.end()
    })

    await new Promise(resolve => setImmediate(resolve))
    const unit = 'abcdefghijklmnopqrstuvwxyz0123456789 '
    const content = unit.repeat(Math.ceil(6_204_367 / unit.length)).slice(0, 6_204_367)
    storage.saveMessageAndRefreshRoom(makeMessage({
      id: 'large-tool-result',
      senderId: 'agent-1',
      senderName: 'Agent',
      role: 'tool',
      tool_name: 'api_request',
      tool_call_id: 'call-large',
      content,
      timestamp: 501,
    }) as any)
    for (let index = 0; index < 50; index += 1) {
      storage.saveMessageAndRefreshRoom(makeMessage({
        id: `follow-up-${index}`,
        content: `follow up ${index}`,
        timestamp: index + 502,
      }) as any)
    }

    const health = await response.finally(() => healthServer.close())
    expect(health.body).toBe('{"status":"ok"}')
    expect(health.elapsedMs).toBeLessThan(1_000)
  })

  it('keeps room token totals unchanged when saving an excluded workspace diff', () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Room 1')
    const initial = storage.saveMessageAndRefreshRoom(makeMessage({
      id: 'msg-1',
      content: 'context message',
      timestamp: 1,
    }) as any).totalTokens
    const fullWindowRead = vi.spyOn(storage, 'getMessagesForContext')

    const result = storage.saveWorkspaceDiffMessageForRun({
      roomId: 'room-1',
      senderId: 'agent-1',
      senderName: 'Agent',
      sessionId: 'session-1',
      runId: 'run-1',
      status: 'completed',
      workspace: '/tmp/workspace',
      draft: {
        change_id: 'change-1',
        run_id: 'run-1',
        session_id: 'session-1',
        room_id: 'room-1',
        message_id: 'pending',
        assistant_message_id: '',
        workspace: 'workspace',
        workspace_kind: 'git',
        started_at: 1,
        finished_at: 2,
        files_changed: 0,
        additions: 0,
        deletions: 0,
        truncated: false,
        total_patch_bytes: 0,
        status: 'completed',
        files: [],
      },
    } as any)

    expect(result?.totalTokens).toBe(initial)
    expect(fullWindowRead).not.toHaveBeenCalled()
    expect(storage.getRoom('room-1')?.totalTokens).toBe(initial)
  })

  it('rebuilds a legacy cached total before saving an excluded workspace diff', () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Room 1')
    storage.addMessage(makeMessage({
      id: 'legacy-context',
      content: 'authoritative context',
      timestamp: 1,
    }) as any)
    dbMock.current!.prepare(
      'UPDATE gc_rooms SET totalTokens = ?, tokenAccountingVersion = 0 WHERE id = ?',
    ).run(999_999, 'room-1')

    const result = storage.saveWorkspaceDiffMessageForRun({
      roomId: 'room-1',
      senderId: 'agent-1',
      senderName: 'Agent',
      sessionId: 'session-1',
      runId: 'legacy-run',
      status: 'completed',
      workspace: '/tmp/workspace',
      draft: {
        change_id: 'legacy-change',
        run_id: 'legacy-run',
        session_id: 'session-1',
        room_id: 'room-1',
        message_id: 'pending',
        assistant_message_id: '',
        workspace: 'workspace',
        workspace_kind: 'git',
        started_at: 1,
        finished_at: 2,
        files_changed: 0,
        additions: 0,
        deletions: 0,
        truncated: false,
        total_patch_bytes: 0,
        status: 'completed',
        files: [],
      },
    } as any)

    const expected = countTokens('authoritative context')
    expect(result?.totalTokens).toBe(expected)
    expect(storage.getRoom('room-1')?.totalTokens).toBe(expected)
  })

  it('rebuilds a legacy cached total before replaying an existing workspace diff', () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Room 1')
    storage.addMessage(makeMessage({
      id: 'legacy-context',
      content: 'authoritative context',
      timestamp: 1,
    }) as any)
    storage.addMessage(makeMessage({
      id: 'existing-workspace-diff',
      senderId: 'agent-1',
      senderName: 'Agent',
      role: 'tool',
      tool_name: 'workspace_diff',
      tool_call_id: 'workspace_diff:run-1',
      content: '{"kind":"workspace_diff"}',
      timestamp: 2,
    }) as any)
    dbMock.current!.prepare(
      'UPDATE gc_rooms SET totalTokens = ?, tokenAccountingVersion = 0 WHERE id = ?',
    ).run(999_999, 'room-1')

    const replayed = storage.saveMessageAndRefreshRoom(makeMessage({
      id: 'existing-workspace-diff',
      senderId: 'agent-1',
      senderName: 'Agent',
      role: 'tool',
      tool_name: 'workspace_diff',
      tool_call_id: 'workspace_diff:run-1',
      content: '{"kind":"workspace_diff"}',
      timestamp: 2,
    }) as any)

    const expected = countTokens('authoritative context')
    expect(replayed.totalTokens).toBe(expected)
    expect(storage.getRoom('room-1')?.totalTokens).toBe(expected)
  })

  it('summarizes the oldest pending public utterances despite a tool-heavy tail', async () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Room 1', 'INVITE1', {
      summaryProfile: 'default',
      summaryProvider: 'openai',
      summaryModel: 'test',
      summaryApiMode: 'chat_completions',
      summaryEveryTurns: 4,
    })
    storage.addMessage(makeMessage({ id: 'anchor', content: 'already summarized', timestamp: 1 }) as any)
    storage.saveRoomSummary({
      roomId: 'room-1',
      summary: 'earlier summary',
      summaryThroughMessageId: 'anchor',
      summaryThroughMessageTimestamp: 1,
      summarizedTurnCount: 1,
      status: 'success',
      version: 1,
      updatedAt: 1,
      lastError: null,
    })
    storage.addMessage(makeMessage({ id: 'user-1', content: 'first pending', timestamp: 2 }) as any)
    storage.addMessage(makeMessage({ id: 'agent-1', role: 'assistant', senderId: 'agent', senderName: 'Agent', content: 'public reply', timestamp: 3 }) as any)
    storage.addMessage(makeMessage({ id: 'user-2', content: 'second pending', timestamp: 4 }) as any)
    storage.addMessage(makeMessage({ id: 'agent-2', role: 'assistant', senderId: 'agent', senderName: 'Agent', content: 'public handoff', timestamp: 5 }) as any)
    for (let index = 0; index < 600; index += 1) {
      storage.addMessage(makeMessage({
        id: `tool-${String(index).padStart(3, '0')}`,
        role: 'tool',
        senderId: 'agent',
        senderName: 'Agent',
        tool_call_id: `call-${index}`,
        tool_name: 'terminal',
        content: `tool output ${index}`,
        timestamp: 100 + index,
      }) as any)
    }

    const runner = vi.fn<GroupSummaryRunner>(async () => 'updated summary')
    const service = new GroupRoomSummaryService(storage, undefined, runner)
    await service.checkAfterMessage('room-1', 'agent-2')

    expect(runner).toHaveBeenCalledTimes(1)
    expect(runner.mock.calls[0][0].messages.map(item => item.id)).toEqual([
      'user-1', 'agent-1', 'user-2', 'agent-2',
    ])
    expect(storage.getRoomSummary('room-1')).toMatchObject({
      summary: 'updated summary',
      summaryThroughMessageId: 'agent-2',
      summarizedTurnCount: 5,
      status: 'success',
    })
  })

  it('continues oldest-first across multiple bounded summary batches', async () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Room 1', 'INVITE1', {
      summaryProfile: 'default',
      summaryProvider: 'openai',
      summaryModel: 'test',
      summaryApiMode: 'chat_completions',
      summaryEveryTurns: 20,
    })
    for (let index = 0; index < 520; index += 1) {
      storage.addMessage(makeMessage({
        id: `public-${String(index).padStart(3, '0')}`,
        role: index % 2 === 0 ? 'user' : 'assistant',
        senderId: index % 2 === 0 ? 'human' : 'agent',
        senderName: index % 2 === 0 ? 'Human' : 'Agent',
        content: `public utterance ${index}`,
        timestamp: index + 1,
      }) as any)
    }

    const runner = vi.fn<GroupSummaryRunner>(async input => `summary-${input.messages.at(-1)?.id}`)
    const service = new GroupRoomSummaryService(storage, undefined, runner)
    await service.checkAfterMessage('room-1', 'public-519')

    expect(runner).toHaveBeenCalledTimes(2)
    expect(runner.mock.calls[0][0].messages[0]?.id).toBe('public-000')
    expect(runner.mock.calls[0][0].messages.at(-1)?.id).toBe('public-499')
    expect(runner.mock.calls[1][0].messages[0]?.id).toBe('public-500')
    expect(runner.mock.calls[1][0].messages.at(-1)?.id).toBe('public-519')
    expect(storage.getRoomSummary('room-1')).toMatchObject({
      summaryThroughMessageId: 'public-519',
      summarizedTurnCount: 520,
      version: 2,
      status: 'success',
    })
  })

  it('continues an eligible backlog beyond three batches without a later message', async () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Room 1', 'INVITE1', {
      summaryProfile: 'default',
      summaryProvider: 'openai',
      summaryModel: 'test',
      summaryApiMode: 'chat_completions',
      summaryEveryTurns: 20,
    })
    for (let index = 0; index < 1_600; index += 1) {
      storage.addMessage(makeMessage({
        id: `backlog-${String(index).padStart(4, '0')}`,
        role: index % 2 === 0 ? 'user' : 'assistant',
        senderId: index % 2 === 0 ? 'human' : 'agent',
        senderName: index % 2 === 0 ? 'Human' : 'Agent',
        content: `backlog utterance ${index}`,
        timestamp: index + 1,
      }) as any)
    }

    const runner = vi.fn<GroupSummaryRunner>(async input => `summary-${input.messages.at(-1)?.id}`)
    const service = new GroupRoomSummaryService(storage, undefined, runner)
    await service.checkAfterMessage('room-1', 'backlog-1599')

    expect(runner).toHaveBeenCalledTimes(4)
    expect(runner.mock.calls.flatMap(call => call[0].messages.map(message => message.id))).toEqual(
      Array.from({ length: 1_600 }, (_value, index) => `backlog-${String(index).padStart(4, '0')}`),
    )
    expect(storage.getRoomSummary('room-1')).toMatchObject({
      summaryThroughMessageId: 'backlog-1599',
      summarizedTurnCount: 1_600,
      version: 4,
      status: 'success',
    })
  })

  it('retains frozen-cutoff drain authority after a later batch fails', async () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Room 1', 'INVITE1', {
      summaryProfile: 'default', summaryProvider: 'openai', summaryModel: 'test',
      summaryApiMode: 'chat_completions', summaryEveryTurns: 2,
    })
    const onePerBatch = 'bounded token '.repeat(10_000)
    storage.addMessage(makeMessage({ id: 'u1', content: `${onePerBatch} one`, timestamp: 1 }) as any)
    storage.addMessage(makeMessage({
      id: 'a1', role: 'assistant', senderId: 'agent', senderName: 'Agent',
      content: `${onePerBatch} two`, timestamp: 2,
    }) as any)

    let attempt = 0
    const runner = vi.fn<GroupSummaryRunner>(async (input: Parameters<GroupSummaryRunner>[0]) => {
      attempt += 1
      if (attempt === 2) throw new Error('second batch failed')
      return `summary-${input.messages.at(-1)?.id}`
    })
    const service = new GroupRoomSummaryService(storage, undefined, runner)

    await service.checkAfterMessage('room-1', 'a1')
    expect(runner).toHaveBeenCalledTimes(2)
    expect(storage.getRoomSummary('room-1')).toMatchObject({
      summaryThroughMessageId: 'u1', summarizedTurnCount: 1, version: 1,
      status: 'failed', lastError: 'second batch failed',
    })
    expect(storage.getRoomSummaryDrainThroughMessageId('room-1')).toBe('a1')

    await service.checkAfterMessage('room-1', 'a1')

    expect(runner).toHaveBeenCalledTimes(3)
    expect(runner.mock.calls[2][0].messages.map(message => message.id)).toEqual(['a1'])
    expect(storage.getRoomSummary('room-1')).toMatchObject({
      summaryThroughMessageId: 'a1', summarizedTurnCount: 2, version: 2,
      status: 'success', lastError: null,
    })
    expect(storage.getRoomSummaryDrainThroughMessageId('room-1')).toBe('')
  })

  it('persists frozen-cutoff drain authority across an owner handoff after a partial commit', async () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Room 1', 'INVITE1', {
      summaryProfile: 'default', summaryProvider: 'openai', summaryModel: 'test',
      summaryApiMode: 'chat_completions', summaryEveryTurns: 2,
    })
    const onePerBatch = 'bounded token '.repeat(10_000)
    storage.addMessage(makeMessage({ id: 'u1', content: `${onePerBatch} one`, timestamp: 1 }) as any)
    storage.addMessage(makeMessage({
      id: 'a1', role: 'assistant', senderId: 'agent', senderName: 'Agent',
      content: `${onePerBatch} two`, timestamp: 2,
    }) as any)

    const originalCommit = storage.commitRoomSummaryRun.bind(storage)
    let simulateOwnerLoss = true
    vi.spyOn(storage, 'commitRoomSummaryRun').mockImplementation((...args) => {
      const committed = originalCommit(...args)
      if (committed && simulateOwnerLoss) {
        simulateOwnerLoss = false
        return false
      }
      return committed
    })
    const runner = vi.fn<GroupSummaryRunner>(async input => `summary-${input.messages.at(-1)?.id}`)
    const firstService = new GroupRoomSummaryService(storage, undefined, runner)
    const secondService = new GroupRoomSummaryService(storage, undefined, runner)

    await firstService.checkAfterMessage('room-1', 'a1')
    expect(runner).toHaveBeenCalledTimes(1)
    expect(storage.getRoomSummary('room-1')).toMatchObject({
      summaryThroughMessageId: 'u1', summarizedTurnCount: 1, version: 1,
    })

    storage.addMessage(makeMessage({ id: 'u2', content: 'newer below-threshold message', timestamp: 3 }) as any)
    await secondService.checkAfterMessage('room-1', 'u2')

    expect(runner).toHaveBeenCalledTimes(2)
    expect(runner.mock.calls[1][0].messages.map(message => message.id)).toEqual(['a1'])
    expect(storage.getRoomSummary('room-1')).toMatchObject({
      summaryThroughMessageId: 'a1', summarizedTurnCount: 2, version: 2,
    })
  })

  it('does not inherit draining for a later cutoff below the threshold', async () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Room 1', 'INVITE1', {
      summaryProfile: 'default', summaryProvider: 'openai', summaryModel: 'test',
      summaryApiMode: 'chat_completions', summaryEveryTurns: 2,
    })
    storage.addMessage(makeMessage({ id: 'u1', content: 'one', timestamp: 1 }) as any)
    storage.addMessage(makeMessage({
      id: 'a1', role: 'assistant', senderId: 'agent', senderName: 'Agent', content: 'two', timestamp: 2,
    }) as any)

    let release!: () => void
    const waiting = new Promise<void>(resolve => { release = resolve })
    const runner = vi.fn<GroupSummaryRunner>(async input => {
      if (input.messages.some(message => message.id === 'a1')) await waiting
      return `summary-${input.messages.at(-1)?.id}`
    })
    const firstService = new GroupRoomSummaryService(storage, undefined, runner)
    const secondService = new GroupRoomSummaryService(storage, undefined, runner)
    const first = firstService.checkAfterMessage('room-1', 'a1')
    await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(1))

    storage.addMessage(makeMessage({ id: 'u2', content: 'three', timestamp: 3 }) as any)
    const second = secondService.checkAfterMessage('room-1', 'u2')
    await new Promise<void>(resolve => setTimeout(resolve, 150))
    expect(runner).toHaveBeenCalledTimes(1)

    release()
    await Promise.all([first, second])

    expect(runner).toHaveBeenCalledTimes(1)
    expect(storage.getRoomSummary('room-1')).toMatchObject({
      summaryThroughMessageId: 'a1', summarizedTurnCount: 2, version: 1,
    })
  })

  it('rechecks a later cutoff from another service after the active claim commits', async () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Room 1', 'INVITE1', {
      summaryProfile: 'default', summaryProvider: 'openai', summaryModel: 'test',
      summaryApiMode: 'chat_completions', summaryEveryTurns: 2,
    })
    storage.addMessage(makeMessage({ id: 'u1', content: 'one', timestamp: 1 }) as any)
    storage.addMessage(makeMessage({
      id: 'a1', role: 'assistant', senderId: 'agent', senderName: 'Agent', content: 'two', timestamp: 2,
    }) as any)

    let release!: () => void
    const waiting = new Promise<void>(resolve => { release = resolve })
    const runner = vi.fn<GroupSummaryRunner>(async input => {
      if (input.messages.some(message => message.id === 'a1')) await waiting
      return `summary-${input.messages.at(-1)?.id}`
    })
    const firstService = new GroupRoomSummaryService(storage, undefined, runner)
    const secondService = new GroupRoomSummaryService(storage, undefined, runner)
    const first = firstService.checkAfterMessage('room-1', 'a1')
    await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(1))

    storage.addMessage(makeMessage({ id: 'u2', content: 'three', timestamp: 3 }) as any)
    storage.addMessage(makeMessage({
      id: 'a2', role: 'assistant', senderId: 'agent', senderName: 'Agent', content: 'four', timestamp: 4,
    }) as any)
    const second = secondService.checkAfterMessage('room-1', 'a2')
    await new Promise<void>(resolve => setTimeout(resolve, 150))
    expect(runner).toHaveBeenCalledTimes(1)

    release()
    await Promise.all([first, second])

    expect(runner).toHaveBeenCalledTimes(2)
    expect(runner.mock.calls[1][0].messages.map(message => message.id)).toEqual(['u2', 'a2'])
    expect(storage.getRoomSummary('room-1')).toMatchObject({
      summaryThroughMessageId: 'a2', summarizedTurnCount: 4, version: 2,
    })
  })

  it('continues across a same-timestamp batch boundary without replay or loss', async () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Room 1', 'INVITE1', {
      summaryProfile: 'default', summaryProvider: 'openai', summaryModel: 'test',
      summaryApiMode: 'chat_completions', summaryEveryTurns: 20,
    })
    for (let index = 0; index < 700; index += 1) {
      storage.addMessage(makeMessage({
        id: `same-${String(index).padStart(3, '0')}`,
        role: index % 2 === 0 ? 'user' : 'assistant',
        senderId: index % 2 === 0 ? 'human' : 'agent',
        senderName: index % 2 === 0 ? 'Human' : 'Agent',
        content: `same timestamp ${index}`,
        timestamp: 42,
      }) as any)
    }
    const runner = vi.fn<GroupSummaryRunner>(async input => `summary-${input.messages.at(-1)?.id}`)
    const service = new GroupRoomSummaryService(storage, undefined, runner)
    await service.checkAfterMessage('room-1', 'same-699')

    expect(runner).toHaveBeenCalledTimes(2)
    expect(runner.mock.calls.flatMap(call => call[0].messages.map(message => message.id))).toEqual(
      Array.from({ length: 700 }, (_value, index) => `same-${String(index).padStart(3, '0')}`),
    )
    expect(storage.getRoomSummary('room-1')).toMatchObject({
      summaryThroughMessageId: 'same-699', summarizedTurnCount: 700, version: 2,
    })
  })

  it('continues across a real multipart same-timestamp batch boundary', async () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Room 1', 'INVITE1', {
      summaryProfile: 'default', summaryProvider: 'openai', summaryModel: 'test',
      summaryApiMode: 'chat_completions', summaryEveryTurns: 20,
    })
    for (let index = 1; index <= 1_200; index += 1) {
      storage.addMessage(makeMessage({
        id: `run_part_${index}`,
        role: index % 2 === 0 ? 'user' : 'assistant',
        senderId: index % 2 === 0 ? 'human' : 'agent',
        senderName: index % 2 === 0 ? 'Human' : 'Agent',
        content: `multipart ${index}`,
        timestamp: 42,
      }) as any)
    }
    const runner = vi.fn<GroupSummaryRunner>(async input => `summary-${input.messages.at(-1)?.id}`)
    const service = new GroupRoomSummaryService(storage, undefined, runner)
    await service.checkAfterMessage('room-1', 'run_part_1200')

    expect(runner).toHaveBeenCalledTimes(3)
    expect(runner.mock.calls.flatMap(call => call[0].messages.map(message => message.id))).toEqual(
      Array.from({ length: 1_200 }, (_value, index) => `run_part_${index + 1}`),
    )
    expect(storage.getRoomSummary('room-1')).toMatchObject({
      summaryThroughMessageId: 'run_part_1200', summarizedTurnCount: 1_200, version: 3,
    })
  })

  it('supports the configured maximum effective-utterance threshold', async () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Room 1', 'INVITE1', {
      summaryProfile: 'default',
      summaryProvider: 'openai',
      summaryModel: 'test',
      summaryApiMode: 'chat_completions',
      summaryEveryTurns: 1_000,
    })
    for (let index = 0; index < 1_000; index += 1) {
      storage.addMessage(makeMessage({
        id: `max-${String(index).padStart(4, '0')}`,
        role: index % 2 === 0 ? 'user' : 'assistant',
        senderId: index % 2 === 0 ? 'human' : 'agent',
        senderName: index % 2 === 0 ? 'Human' : 'Agent',
        content: `utterance ${index}`,
        timestamp: index + 1,
      }) as any)
    }

    const runner = vi.fn<GroupSummaryRunner>(async () => 'summary')
    const service = new GroupRoomSummaryService(storage, undefined, runner)
    await service.checkAfterMessage('room-1', 'max-0999')

    expect(runner).toHaveBeenCalledTimes(1)
    expect(runner.mock.calls[0][0].messages).toHaveLength(1_000)
    expect(storage.getRoomSummary('room-1')).toMatchObject({
      summaryThroughMessageId: 'max-0999',
      summarizedTurnCount: 1_000,
    })
  })

  it('does not let serialized Tool traces consume the eligible summary scan limit', async () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Room 1', undefined, {
      summaryProfile: 'default', summaryProvider: 'openai', summaryModel: 'test',
      summaryApiMode: 'chat_completions', summaryEveryTurns: 2,
    })
    for (let index = 0; index < 10_001; index += 1) {
      storage.addMessage(makeMessage({
        id: `trace-${String(index).padStart(5, '0')}`,
        role: 'assistant', senderId: 'agent', senderName: 'Worker',
        content: '\u00a0[Worker]:\t[Calling tool: terminal with arguments: {}]',
        timestamp: index + 1,
      }) as any)
    }
    storage.addMessage(makeMessage({
      id: 'valid-user', role: 'user', content: 'public request', timestamp: 20_000,
    }) as any)
    storage.addMessage(makeMessage({
      id: 'valid-agent', role: 'assistant', senderId: 'agent', senderName: 'Worker',
      content: 'public final answer', timestamp: 20_001,
    }) as any)

    const runner = vi.fn<GroupSummaryRunner>(async () => 'summary')
    await new GroupRoomSummaryService(storage, undefined, runner)
      .checkAfterMessage('room-1', 'valid-agent')

    expect(runner).toHaveBeenCalledTimes(1)
    expect(runner.mock.calls[0][0].messages.map(message => message.id)).toEqual([
      'valid-user', 'valid-agent',
    ])
    expect(storage.getRoomSummary('room-1')).toMatchObject({
      summaryThroughMessageId: 'valid-agent', summarizedTurnCount: 2,
    })
  })

  it('keeps trace-like public words eligible when the marker has no word boundary', async () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Room 1', undefined, {
      summaryProfile: 'default', summaryProvider: 'openai', summaryModel: 'test',
      summaryApiMode: 'chat_completions', summaryEveryTurns: 2,
    })
    storage.addMessage(makeMessage({
      id: 'toolbar-user', role: 'user', content: '[Calling toolbar is useful]', timestamp: 1,
    }) as any)
    storage.addMessage(makeMessage({
      id: 'resultant-agent', role: 'assistant', senderId: 'agent', senderName: 'Worker',
      content: '[Tool resultant behavior is documented]', timestamp: 2,
    }) as any)

    const runner = vi.fn<GroupSummaryRunner>(async () => 'summary')
    await new GroupRoomSummaryService(storage, undefined, runner)
      .checkAfterMessage('room-1', 'resultant-agent')

    expect(runner).toHaveBeenCalledTimes(1)
    expect(runner.mock.calls[0][0].messages.map(message => message.id)).toEqual([
      'toolbar-user', 'resultant-agent',
    ])
  })

  it('does not let Unicode-whitespace-only rows consume the eligible summary scan limit', async () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Room 1', undefined, {
      summaryProfile: 'default', summaryProvider: 'openai', summaryModel: 'test',
      summaryApiMode: 'chat_completions', summaryEveryTurns: 2,
    })
    for (let index = 0; index < 10_001; index += 1) {
      storage.addMessage(makeMessage({
        id: `blank-${String(index).padStart(5, '0')}`,
        role: index % 2 === 0 ? 'user' : 'assistant',
        senderId: index % 2 === 0 ? 'human' : 'agent',
        senderName: index % 2 === 0 ? 'Human' : 'Worker',
        content: '\u00a0',
        timestamp: index + 1,
      }) as any)
    }
    storage.addMessage(makeMessage({
      id: 'valid-user-after-blanks', role: 'user', content: 'public request', timestamp: 20_000,
    }) as any)
    storage.addMessage(makeMessage({
      id: 'valid-agent-after-blanks', role: 'assistant', senderId: 'agent', senderName: 'Worker',
      content: 'public final answer', timestamp: 20_001,
    }) as any)

    const runner = vi.fn<GroupSummaryRunner>(async () => 'summary')
    await new GroupRoomSummaryService(storage, undefined, runner)
      .checkAfterMessage('room-1', 'valid-agent-after-blanks')

    expect(runner).toHaveBeenCalledTimes(1)
    expect(runner.mock.calls[0][0].messages.map(message => message.id)).toEqual([
      'valid-user-after-blanks', 'valid-agent-after-blanks',
    ])
  })

  it('enforces persisted summary claims and rejects stale run tokens', () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Room 1')
    const initial = {
      roomId: 'room-1', summary: '', summaryThroughMessageId: '', summaryThroughMessageTimestamp: 0,
      summarizedTurnCount: 0, status: 'idle' as const, version: 0, updatedAt: 0, lastError: null,
    }
    storage.saveRoomSummary(initial)
    expect(storage.claimRoomSummaryRun('room-1', initial, 'run-a', Date.now() + 60_000)).toBe(true)
    expect(storage.claimRoomSummaryRun('room-1', initial, 'run-b', Date.now() + 60_000)).toBe(false)

    storage.saveRoomSummary({ ...initial, summary: 'manual', status: 'success', version: 1 })
    expect(storage.commitRoomSummaryRun('room-1', 'run-a', {
      ...initial, summary: 'stale', status: 'success', version: 1,
    })).toBe(false)
    expect(storage.getRoomSummary('room-1')).toMatchObject({ summary: 'manual', version: 1 })
  })

  it('rejects a persisted summary result after another instance changes summary config', () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Room 1', undefined, {
      summaryProfile: 'default', summaryProvider: 'openai', summaryModel: 'old-model',
      summaryApiMode: 'chat_completions', summaryEveryTurns: 20,
    })
    const initial = {
      roomId: 'room-1', summary: '', summaryThroughMessageId: '', summaryThroughMessageTimestamp: 0,
      summarizedTurnCount: 0, status: 'idle' as const, version: 0, updatedAt: 0, lastError: null,
    }
    storage.saveRoomSummary(initial)
    const generation = storage.getRoom('room-1')!.summaryGeneration
    expect(storage.claimRoomSummaryRun('room-1', initial, 'run-old-config', Date.now() + 60_000, generation)).toBe(true)

    storage.updateRoomConfig('room-1', { summaryModel: 'new-model' })
    expect(storage.commitRoomSummaryRun('room-1', 'run-old-config', {
      ...initial, summary: 'stale model result', status: 'success', version: 1,
    })).toBe(false)
    expect(storage.getRoomSummary('room-1')).toMatchObject({
      summary: '', status: 'summarizing', version: 0,
    })
  })

  it('cannot recreate a deleted Room summary from a stale claim or result', () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Room 1')
    const initial = {
      roomId: 'room-1', summary: '', summaryThroughMessageId: '', summaryThroughMessageTimestamp: 0,
      summarizedTurnCount: 0, status: 'idle' as const, version: 0, updatedAt: 0, lastError: null,
    }
    storage.saveRoomSummary(initial)
    expect(storage.claimRoomSummaryRun('room-1', initial, 'run-before-delete', Date.now() + 60_000)).toBe(true)
    storage.deleteRoom('room-1')

    expect(storage.claimRoomSummaryRun('room-1', initial, 'run-after-delete', Date.now() + 60_000)).toBe(false)
    expect(storage.commitRoomSummaryRun('room-1', 'run-before-delete', {
      ...initial, summary: 'must not return', status: 'success', version: 1,
    })).toBe(false)
    expect(storage.getRoomSummary('room-1')).toBeNull()
  })

  it('rejects a stale manual summary write after Room clear or deletion', () => {
    const storage = groupServer.getStorage()
    const initial = {
      roomId: 'room-1', summary: 'before', summaryThroughMessageId: 'anchor',
      summaryThroughMessageTimestamp: 1, summarizedTurnCount: 1,
      status: 'success' as const, version: 1, updatedAt: 1, lastError: null,
    }

    storage.saveRoom('room-1', 'Room 1')
    storage.saveRoomSummary(initial)
    const clearGeneration = storage.getRoom('room-1')!.summaryGeneration
    storage.clearRoomContext('room-1')
    expect(storage.saveRoomSummaryIfCurrent(
      { ...initial, summary: 'stale after clear', version: 2 },
      clearGeneration,
      initial.version,
      initial.summaryThroughMessageId,
    )).toBe(false)
    expect(storage.getRoomSummary('room-1')).toBeNull()

    storage.saveRoomSummary({ ...initial, summary: 'after clear' })
    const deleteGeneration = storage.getRoom('room-1')!.summaryGeneration
    storage.deleteRoom('room-1')
    expect(storage.saveRoomSummaryIfCurrent(
      { ...initial, summary: 'stale after delete', version: 2 },
      deleteGeneration,
      initial.version,
      initial.summaryThroughMessageId,
    )).toBe(false)
    expect(storage.getRoomSummary('room-1')).toBeNull()
  })

  it('recovers only expired persisted summary leases', () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Room 1')
    const initial = {
      roomId: 'room-1', summary: '', summaryThroughMessageId: '', summaryThroughMessageTimestamp: 0,
      summarizedTurnCount: 0, status: 'idle' as const, version: 0, updatedAt: 0, lastError: null,
    }
    storage.saveRoomSummary(initial)
    expect(storage.claimRoomSummaryRun('room-1', initial, 'run-a', 10_000)).toBe(true)
    expect(storage.recoverExpiredRoomSummaryRun('room-1', 9_999)).toBe(false)
    expect(storage.getRoomSummary('room-1')).toMatchObject({ status: 'summarizing' })
    expect(storage.recoverExpiredRoomSummaryRun('room-1', 10_000)).toBe(true)
    expect(storage.getRoomSummary('room-1')).toMatchObject({
      status: 'failed', lastError: 'Summary run was interrupted', version: 0,
    })
  })

  it('retains older messages while limiting shared context to the latest 500', () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Room 1')

    const seeded = Array.from({ length: 501 }, (_value, index) => makeMessage({
      id: `msg-${index + 1}`,
      content: `message-${index + 1}`,
      timestamp: index + 1,
    }))

    storage.saveMessageAndRefreshRoom(seeded[0] as any)
    storage.saveRoomSummary({
      roomId: 'room-1',
      summary: 'Earlier summary',
      summaryThroughMessageId: 'msg-1',
      summaryThroughMessageTimestamp: 1,
      summarizedTurnCount: 1,
      status: 'success',
      version: 1,
      updatedAt: 1,
      lastError: null,
    })

    let latest: { totalTokens: number } | null = null
    for (const message of seeded.slice(1)) latest = storage.saveMessageAndRefreshRoom(message as any)

    const contextMessages = storage.getMessagesForContext('room-1')
    const context = groupServer.getRoomSummaryService().buildRuntimeContext('room-1')

    expect(storage.getMessageCount('room-1')).toBe(501)
    expect(storage.getMessage('msg-1')).not.toBeNull()
    expect(storage.getRecentMessagesForUI('room-1', 500).map(message => message.id)).toEqual(
      seeded.slice(1).map(message => message.id),
    )
    expect(storage.getRecentMessagesForUI('room-1', 150, 450).map(message => message.id)).toEqual(
      seeded.slice(0, 51).map(message => message.id),
    )
    expect(storage.getRecentMessagesForUI('room-1', 150, 500).map(message => message.id)).toEqual([
      'msg-1',
    ])
    expect(contextMessages).toHaveLength(500)
    expect(contextMessages.some(message => message.id === 'msg-1')).toBe(false)
    expect(context.summary).toBe('Earlier summary')
    expect(context.history).toHaveLength(500)
    expect(context.history[0]?.id).toBe('msg-2')
    expect(context.history.at(-1)?.id).toBe('msg-501')
    expect(latest?.totalTokens).toBe(
      seeded.slice(1).reduce((sum, message) => sum + countTokens(String(message.content)), 0),
    )

    storage.clearRoomContext('room-1')

    expect(storage.getMessageCount('room-1')).toBe(0)
    expect(storage.getMessage('msg-1')).toBeNull()
    expect(storage.getMessagesForContext('room-1')).toEqual([])
  })

  it('paginates the complete UI history beyond the 500-message Agent context window', () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Room 1')
    const seeded = Array.from({ length: 725 }, (_value, index) => makeMessage({
      id: `history-${String(index + 1).padStart(4, '0')}`,
      content: `history ${index + 1}`,
      timestamp: index + 1,
    }))
    for (const message of seeded) storage.saveMessageAndRefreshRoom(message as any)

    const pages: string[][] = []
    let offset = 0
    while (offset < seeded.length) {
      const page = storage.getRecentMessagesForUI('room-1', 150, offset)
      pages.unshift(page.map(message => message.id))
      offset += page.length
      if (page.length === 0) break
    }

    expect(pages.flat()).toEqual(seeded.map(message => message.id))
    expect(new Set(pages.flat())).toHaveLength(seeded.length)
    expect(storage.getRecentMessagesForUI('room-1', 150, 600)).toHaveLength(125)
    expect(storage.getRecentMessagesForUI('room-1', 150, 725)).toEqual([])
    expect(storage.getMessagesForContext('room-1')).toHaveLength(500)
    expect(storage.getMessagesForContext('room-1')[0]?.id).toBe('history-0226')
  })

  it('keyset-paginates 13,000+ archived messages with stable ids and equal timestamps', () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Room 1')
    const boundaryRunIndexes = new Set([12_923, 12_924, 12_925])
    const seeded = Array.from({ length: 13_075 }, (_value, index) => makeMessage({
      id: `archive-${String(index + 1).padStart(5, '0')}`,
      content: `archive ${index + 1}`,
      timestamp: 1_900_000_000 + Math.floor(index / 225),
      ...(boundaryRunIndexes.has(index)
        ? {
            role: index === 12_924 ? 'tool' : 'assistant',
            run_id: 'archive-boundary-run',
            senderId: 'agent-1',
            senderName: 'Agent',
          }
        : {}),
    }))
    const insert = dbMock.current!.prepare(
      `INSERT INTO gc_messages (id, roomId, senderId, senderName, content, timestamp, role, run_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    dbMock.current!.exec('BEGIN')
    try {
      for (const message of seeded) {
        insert.run(
          message.id,
          message.roomId,
          message.senderId,
          message.senderName,
          message.content,
          message.timestamp,
          message.role,
          message.run_id || null,
        )
      }
      dbMock.current!.exec('COMMIT')
    } catch (error) {
      dbMock.current!.exec('ROLLBACK')
      throw error
    }

    const pages: string[][] = []
    let beforeMessageId: string | undefined
    do {
      const page = storage.getHistoryPageForUI('room-1', 150, beforeMessageId)
      pages.unshift(page.messages.map(message => message.id))
      beforeMessageId = page.hasMore ? page.messages[0]?.id : undefined
      if (!page.hasMore) break
    } while (beforeMessageId)

    const loaded = pages.flat()
    expect(loaded).toEqual(seeded.map(message => message.id))
    expect(new Set(loaded)).toHaveLength(seeded.length)
    expect(pages).toHaveLength(Math.ceil(seeded.length / 150))
    const boundaryRunIds = [...boundaryRunIndexes].map(index => seeded[index].id)
    expect(pages.filter(page => boundaryRunIds.some(id => page.includes(id)))).toEqual([
      expect.arrayContaining(boundaryRunIds),
    ])
  })

  it('builds Agent context from the full retained transcript rather than the UI page', () => {
    const messages = Array.from({ length: 160 }, (_value, index) => ({
      id: `message-${index + 1}`,
      senderId: 'user-1',
      senderName: 'Alice',
      content: `message ${index + 1}`,
      role: 'user',
      timestamp: index + 1,
    }))
    const storage = {
      getMessagesForContext: vi.fn(() => messages),
      getRecentMessagesForUI: vi.fn(() => messages.slice(-150)),
      getRoom: vi.fn(() => ({
        id: 'room-1',
        summaryProfile: 'default',
        summaryProvider: 'openai',
        summaryModel: 'test',
        summaryApiMode: '',
        summaryEveryTurns: 200,
      })),
      getRoomSummary: vi.fn(() => null),
      saveRoomSummary: vi.fn(),
    }

    const context = new GroupRoomSummaryService(storage as any).buildRuntimeContext('room-1')

    expect(storage.getMessagesForContext).toHaveBeenCalledWith('room-1')
    expect(storage.getRecentMessagesForUI).not.toHaveBeenCalled()
    expect(context.summary).toBe('')
    expect(context.history).toHaveLength(160)
    expect(context.history[0]?.id).toBe('message-1')
    expect(context.history.at(-1)?.id).toBe('message-160')
  })

  it('keeps a completed tool result recoverable until Room persistence succeeds', async () => {
    let resultAttempts = 0
    mockSocket.emit.mockImplementation((event: string, payload?: any, ack?: Function) => {
      if (event === 'message' && payload?.role === 'tool') {
        resultAttempts += 1
        if (typeof ack === 'function') {
          ack(resultAttempts === 1
            ? { error: 'temporary Room persistence failure' }
            : { id: payload.id })
        }
      } else if (typeof ack === 'function') {
        ack({ id: payload?.id })
      }
      return mockSocket
    })
    const clients = new AgentClients()
    const client = await clients.createAgent({
      agentId: 'agent-1',
      profile: 'default',
      name: 'Worker',
      description: '',
      invited: 0,
    } as any)

    await (client as any).recordToolStarted(
      'room-1',
      'session-1',
      { tool_name: 'lookup', tool_call_id: 'call-retry', args: {} },
      'run-retry_part_0',
      'run-retry',
    )
    await (client as any).recordToolCompleted('room-1', 'session-1', {
      event: 'tool.completed',
      tool_name: 'lookup',
      tool_call_id: 'call-retry',
      output: 'literal @all result must survive retry',
    })

    expect(resultAttempts).toBe(1)
    expect(Array.from((client as any).pendingToolRunIds.values())).toContain('run-retry')

    await (client as any).completePendingToolsForRun('room-1', 'session-1', 'run-retry')

    expect(resultAttempts).toBe(2)
    expect(mockSocket.emit).toHaveBeenLastCalledWith(
      'message',
      expect.objectContaining({
        id: 'run-retry_part_0_toolresult_call-retry',
        role: 'tool',
        tool_call_id: 'call-retry',
        content: 'literal @all result must survive retry',
      }),
      expect.any(Function),
    )
    expect((client as any).pendingToolRunIds.size).toBe(0)
    expect((client as any).pendingToolBaseIds.size).toBe(0)
    expect((client as any).pendingToolNames.size).toBe(0)

    const resultPayloads = mockSocket.emit.mock.calls
      .filter((call: any[]) => call[0] === 'message' && call[1]?.role === 'tool')
      .map((call: any[]) => call[1])
    expect(resultPayloads.map((payload: any) => payload.id)).toEqual([
      'run-retry_part_0_toolresult_call-retry',
      'run-retry_part_0_toolresult_call-retry',
    ])

    client.disconnect()
  })

  it('keeps parallel anonymous tool completions correlated when the first persistence attempt fails', async () => {
    const attempts = new Map<string, number>()
    mockSocket.emit.mockImplementation((event: string, payload?: any, ack?: Function) => {
      if (event === 'message' && payload?.role === 'tool') {
        const callId = String(payload.tool_call_id)
        const attempt = (attempts.get(callId) || 0) + 1
        attempts.set(callId, attempt)
        if (typeof ack === 'function') ack(attempt === 1 && callId.endsWith('_1')
          ? { error: 'temporary Room persistence failure' }
          : { id: payload.id })
      } else if (typeof ack === 'function') {
        ack({ id: payload?.id })
      }
      return mockSocket
    })
    const clients = new AgentClients()
    const client = await clients.createAgent({
      agentId: 'agent-1', profile: 'default', name: 'Worker', description: '', invited: 0,
    } as any)

    await (client as any).recordToolStarted(
      'room-1', 'session-1', { tool_name: 'lookup', args: { index: 1 } }, 'run-parallel_part_0', 'run-parallel',
    )
    await (client as any).recordToolStarted(
      'room-1', 'session-1', { tool_name: 'lookup', args: { index: 2 } }, 'run-parallel_part_0', 'run-parallel',
    )
    await (client as any).recordToolCompleted('room-1', 'session-1', {
      event: 'tool.completed', tool_name: 'lookup', output: 'first result',
    })
    await (client as any).recordToolCompleted('room-1', 'session-1', {
      event: 'tool.completed', tool_name: 'lookup', output: 'second result',
    })
    await (client as any).completePendingToolsForRun('room-1', 'session-1', 'run-parallel')

    const resultPayloads = mockSocket.emit.mock.calls
      .filter((call: any[]) => call[0] === 'message' && call[1]?.role === 'tool')
      .map((call: any[]) => call[1])
    const toolCallIds = mockSocket.emit.mock.calls
      .filter((call: any[]) => call[0] === 'message' && call[1]?.role === 'assistant' && call[1]?.tool_calls)
      .map((call: any[]) => call[1].tool_calls[0].id)
    expect(toolCallIds).toHaveLength(2)
    expect(resultPayloads.map((payload: any) => [payload.tool_call_id, payload.content])).toEqual([
      [toolCallIds[0], 'first result'],
      [toolCallIds[1], 'second result'],
      [toolCallIds[0], 'first result'],
    ])
    expect((client as any).pendingToolRunIds.size).toBe(0)
    client.disconnect()
  })

  it('keeps sequential acknowledged anonymous tool ids distinct when wall time does not advance', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1775860000000)
    mockSocket.emit.mockImplementation((event: string, payload?: any, ack?: Function) => {
      if (typeof ack === 'function') ack({ id: payload?.id })
      return mockSocket
    })
    const clients = new AgentClients()
    const client = await clients.createAgent({
      agentId: 'agent-1', profile: 'default', name: 'Worker', description: '', invited: 0,
    } as any)

    for (const output of ['first', 'second']) {
      await (client as any).recordToolStarted(
        'room-1', 'session-1', { tool_name: 'lookup', args: {} },
        'run-sequential_part_0', 'run-sequential',
      )
      await (client as any).recordToolCompleted('room-1', 'session-1', {
        event: 'tool.completed', tool_name: 'lookup', output,
      })
    }

    const toolCallIds = mockSocket.emit.mock.calls
      .filter((call: any[]) => call[0] === 'message' && call[1]?.role === 'assistant' && call[1]?.tool_calls)
      .map((call: any[]) => call[1].tool_calls[0].id)
    const resultPayloads = mockSocket.emit.mock.calls
      .filter((call: any[]) => call[0] === 'message' && call[1]?.role === 'tool')
      .map((call: any[]) => call[1])
    expect(toolCallIds).toHaveLength(2)
    expect(new Set(toolCallIds).size).toBe(2)
    expect(new Set(resultPayloads.map((payload: any) => payload.id)).size).toBe(2)
    expect(resultPayloads.map((payload: any) => payload.tool_call_id)).toEqual(toolCallIds)
    client.disconnect()
  })

  it('keeps colliding sanitized tool call ids distinct in persisted message ids', async () => {
    mockSocket.emit.mockImplementation((event: string, payload?: any, ack?: Function) => {
      if (typeof ack === 'function') ack({ id: payload?.id })
      return mockSocket
    })
    const clients = new AgentClients()
    const client = await clients.createAgent({
      agentId: 'agent-1', profile: 'default', name: 'Worker', description: '', invited: 0,
    } as any)

    for (const toolCallId of ['call/a', 'call?a']) {
      await (client as any).recordToolStarted(
        'room-1', 'session-1', { tool_name: 'lookup', tool_call_id: toolCallId, args: {} },
        'run-collision_part_0', 'run-collision',
      )
      await (client as any).recordToolCompleted('room-1', 'session-1', {
        event: 'tool.completed', tool_name: 'lookup', tool_call_id: toolCallId, output: toolCallId,
      })
    }

    const resultPayloads = mockSocket.emit.mock.calls
      .filter((call: any[]) => call[0] === 'message' && call[1]?.role === 'tool')
      .map((call: any[]) => call[1])
    expect(resultPayloads).toHaveLength(2)
    expect(new Set(resultPayloads.map((payload: any) => payload.id)).size).toBe(2)
    expect(resultPayloads.map((payload: any) => payload.tool_call_id)).toEqual(['call/a', 'call?a'])
    client.disconnect()
  })

  it('bounds long persisted tool message ids without changing external tool call ids', async () => {
    const resultAttempts = new Map<string, number>()
    mockSocket.emit.mockImplementation((event: string, payload?: any, ack?: Function) => {
      if (event === 'message' && payload?.role === 'tool') {
        const toolCallId = String(payload.tool_call_id)
        const attempt = (resultAttempts.get(toolCallId) || 0) + 1
        resultAttempts.set(toolCallId, attempt)
        if (typeof ack === 'function') ack(attempt === 1
          ? { error: 'temporary Room persistence failure' }
          : { id: payload.id })
      } else if (typeof ack === 'function') {
        ack({ id: payload?.id })
      }
      return mockSocket
    })
    const clients = new AgentClients()
    const client = await clients.createAgent({
      agentId: 'agent-1', profile: 'default', name: 'Worker', description: '', invited: 0,
    } as any)
    const runMessageId = `${'r'.repeat(153)}_part_0`
    const toolCallIds = [`call_${'x'.repeat(74)}a`, `call_${'x'.repeat(74)}b`]

    for (const toolCallId of toolCallIds) {
      await (client as any).recordToolStarted(
        'room-1', 'session-1', { tool_name: 'lookup', tool_call_id: toolCallId, args: {} },
        runMessageId, 'run-long',
      )
      await (client as any).recordToolCompleted('room-1', 'session-1', {
        event: 'tool.completed', tool_name: 'lookup', tool_call_id: toolCallId, output: toolCallId,
      })
    }
    await (client as any).completePendingToolsForRun('room-1', 'session-1', 'run-long')

    const messagePayloads = mockSocket.emit.mock.calls
      .filter((call: any[]) => call[0] === 'message')
      .map((call: any[]) => call[1])
    expect(messagePayloads.every((payload: any) => payload.id.length <= 160)).toBe(true)

    const toolCallPayloads = messagePayloads.filter((payload: any) => payload.role === 'assistant')
    expect(toolCallPayloads.map((payload: any) => payload.tool_calls[0].id)).toEqual(toolCallIds)
    expect(toolCallPayloads.every((payload: any) => payload.id.includes('_toolcall_'))).toBe(true)

    const resultPayloads = messagePayloads.filter((payload: any) => payload.role === 'tool')
    expect(resultPayloads.map((payload: any) => payload.tool_call_id)).toEqual([
      toolCallIds[0], toolCallIds[1], toolCallIds[0], toolCallIds[1],
    ])
    expect(resultPayloads.every((payload: any) => payload.id.includes('_toolresult_'))).toBe(true)
    for (const toolCallId of toolCallIds) {
      const ids = resultPayloads
        .filter((payload: any) => payload.tool_call_id === toolCallId)
        .map((payload: any) => payload.id)
      expect(new Set(ids).size).toBe(1)
    }
    expect(new Set(resultPayloads.map((payload: any) => payload.id)).size).toBe(2)
    client.disconnect()
  })

  it('retries terminal tool persistence with stable ids until bounded success', async () => {
    let resultAttempts = 0
    mockSocket.emit.mockImplementation((event: string, payload?: any, ack?: Function) => {
      if (event === 'message' && payload?.role === 'tool') {
        resultAttempts += 1
        if (typeof ack === 'function') ack(resultAttempts < 3
          ? { error: 'temporary Room persistence failure' }
          : { id: payload.id })
      } else if (typeof ack === 'function') {
        ack({ id: payload?.id })
      }
      return mockSocket
    })
    const clients = new AgentClients()
    const client = await clients.createAgent({
      agentId: 'agent-1', profile: 'default', name: 'Worker', description: '', invited: 0,
    } as any)

    await (client as any).recordToolStarted(
      'room-1', 'session-1', { tool_name: 'lookup', tool_call_id: 'call-bounded-retry', args: {} },
      'run-bounded-retry_part_0', 'run-bounded-retry',
    )
    await (client as any).recordToolCompleted('room-1', 'session-1', {
      event: 'tool.completed', tool_name: 'lookup', tool_call_id: 'call-bounded-retry', output: 'preserved',
    })
    await (client as any).completePendingToolsForRun('room-1', 'session-1', 'run-bounded-retry')

    expect(resultAttempts).toBe(3)
    const ids = mockSocket.emit.mock.calls
      .filter((call: any[]) => call[0] === 'message' && call[1]?.role === 'tool')
      .map((call: any[]) => call[1].id)
    expect(new Set(ids)).toEqual(new Set(['run-bounded-retry_part_0_toolresult_call-bounded-retry']))
    expect((client as any).pendingToolRunIds.size).toBe(0)
    client.disconnect()
  })

  it('clears retained tool recovery state on explicit disconnect', async () => {
    mockSocket.emit.mockImplementation((event: string, payload?: any, ack?: Function) => {
      if (event === 'message' && payload?.role === 'tool') {
        if (typeof ack === 'function') ack({ error: 'persistent Room failure' })
      } else if (typeof ack === 'function') {
        ack({ id: payload?.id })
      }
      return mockSocket
    })
    const clients = new AgentClients()
    const client = await clients.createAgent({
      agentId: 'agent-1', profile: 'default', name: 'Worker', description: '', invited: 0,
    } as any)
    await (client as any).recordToolStarted(
      'room-1', 'session-1', { tool_name: 'lookup', tool_call_id: 'call-disconnect', args: {} },
      'run-disconnect_part_0', 'run-disconnect',
    )
    await (client as any).recordToolCompleted('room-1', 'session-1', {
      event: 'tool.completed', tool_name: 'lookup', tool_call_id: 'call-disconnect', output: 'retained',
    })
    expect((client as any).pendingToolCompletionEvents.size).toBe(1)

    client.disconnect()

    expect((client as any).pendingToolCallIds.size).toBe(0)
    expect((client as any).pendingToolBaseIds.size).toBe(0)
    expect((client as any).pendingToolRunIds.size).toBe(0)
    expect((client as any).pendingToolNames.size).toBe(0)
    expect((client as any).pendingToolExternalIds.size).toBe(0)
    expect((client as any).pendingToolCompletionEvents.size).toBe(0)
  })

  it('discards only the stale run tool recovery state after bounded reconciliation', async () => {
    mockSocket.emit.mockImplementation((event: string, payload?: any, ack?: Function) => {
      if (event === 'message' && payload?.role === 'tool') {
        if (typeof ack === 'function') ack({ error: 'stale session' })
      } else if (typeof ack === 'function') {
        ack({ id: payload?.id })
      }
      return mockSocket
    })
    const clients = new AgentClients()
    const client = await clients.createAgent({
      agentId: 'agent-1', profile: 'default', name: 'Worker', description: '', invited: 0,
    } as any)

    for (const [toolCallId, runId] of [['call-stale', 'run-stale'], ['call-current', 'run-current']]) {
      await (client as any).recordToolStarted(
        'room-1', 'session-1', { tool_name: 'lookup', tool_call_id: toolCallId, args: {} },
        `${runId}_part_0`, runId,
      )
      await (client as any).recordToolCompleted('room-1', 'session-1', {
        event: 'tool.completed', tool_name: 'lookup', tool_call_id: toolCallId, output: toolCallId,
      })
    }

    ;(client as any).discardPendingToolsForRun('run-stale')

    expect(Array.from((client as any).pendingToolRunIds.values())).toEqual(['run-current'])
    expect((client as any).pendingToolBaseIds.size).toBe(1)
    expect((client as any).pendingToolNames.size).toBe(1)
    expect((client as any).pendingToolExternalIds.size).toBe(1)
    expect((client as any).pendingToolCompletionEvents.size).toBe(1)
    client.disconnect()
  })

  it('ignores a replayed acknowledged tool completion', async () => {
    mockSocket.emit.mockImplementation((event: string, payload?: any, ack?: Function) => {
      if (typeof ack === 'function') ack({ id: payload?.id })
      return mockSocket
    })
    const clients = new AgentClients()
    const client = await clients.createAgent({
      agentId: 'agent-1', profile: 'default', name: 'Worker', description: '', invited: 0,
    } as any)
    await (client as any).recordToolStarted(
      'room-1', 'session-1', { tool_name: 'lookup', tool_call_id: 'call-replay', args: {} },
      'run-replay_part_0', 'run-replay',
    )
    const completion = {
      event: 'tool.completed', tool_name: 'lookup', tool_call_id: 'call-replay', output: 'one result',
    }
    await (client as any).recordToolCompleted('room-1', 'session-1', completion)
    await (client as any).recordToolCompleted('room-1', 'session-1', completion)

    const resultPayloads = mockSocket.emit.mock.calls
      .filter((call: any[]) => call[0] === 'message' && call[1]?.role === 'tool')
    expect(resultPayloads).toHaveLength(1)
    client.disconnect()
  })

  it('keeps reused native tool call ids isolated across rooms and runs', async () => {
    const attempts = new Map<string, number>()
    mockSocket.emit.mockImplementation((event: string, payload?: any, ack?: Function) => {
      if (event === 'message' && payload?.role === 'tool') {
        const key = `${payload.roomId}:${payload.run_id}`
        const attempt = (attempts.get(key) || 0) + 1
        attempts.set(key, attempt)
        if (typeof ack === 'function') ack(attempt === 1
          ? { error: 'temporary Room persistence failure' }
          : { id: payload.id })
      } else if (typeof ack === 'function') {
        ack({ id: payload?.id })
      }
      return mockSocket
    })
    const clients = new AgentClients()
    const client = await clients.createAgent({
      agentId: 'agent-1', profile: 'default', name: 'Worker', description: '', invited: 0,
    } as any)

    for (const [roomId, runId] of [['room-1', 'run-1'], ['room-2', 'run-2']]) {
      await (client as any).recordToolStarted(
        roomId, `session-${roomId}`, { tool_name: 'lookup', tool_call_id: 'call-shared', args: { roomId } },
        `${runId}_part_0`, runId,
      )
    }
    for (const [roomId, runId] of [['room-1', 'run-1'], ['room-2', 'run-2']]) {
      await (client as any).recordToolCompleted(roomId, `session-${roomId}`, {
        event: 'tool.completed', tool_name: 'lookup', tool_call_id: 'call-shared', output: `${roomId} result`,
      })
      await (client as any).completePendingToolsForRun(roomId, `session-${roomId}`, runId)
    }

    const resultPayloads = mockSocket.emit.mock.calls
      .filter((call: any[]) => call[0] === 'message' && call[1]?.role === 'tool')
      .map((call: any[]) => call[1])
    expect(resultPayloads.map((payload: any) => [payload.roomId, payload.run_id, payload.content])).toEqual([
      ['room-1', 'run-1', 'room-1 result'],
      ['room-1', 'run-1', 'room-1 result'],
      ['room-2', 'run-2', 'room-2 result'],
      ['room-2', 'run-2', 'room-2 result'],
    ])
    expect((client as any).pendingToolRunIds.size).toBe(0)
    client.disconnect()
  })

  it('includes the active reasoning segment in persisted group tool-call messages', async () => {
    mockSocket.emit.mockImplementation((event: string, payload?: any, ack?: Function) => {
      if (typeof ack === 'function') ack({ id: payload?.id })
      return mockSocket
    })
    const clients = new AgentClients()
    const client = await clients.createAgent({
      agentId: 'agent-1',
      profile: 'default',
      name: 'Worker',
      description: '',
      invited: 0,
    } as any)

    ;(client as any).recordToolStarted(
      'room-1',
      'session-1',
      {
        tool_name: 'lookup',
        tool_call_id: 'call-1',
        args: { room: 'room-1' },
      },
      'run-1_part_0',
      'run-1',
      'Inspect the room before calling lookup.',
    )

    expect(mockSocket.emit).toHaveBeenCalledWith(
      'message',
      expect.objectContaining({
        roomId: 'room-1',
        id: 'run-1_part_0_toolcall_call-1',
        run_id: 'run-1',
        role: 'assistant',
        reasoning: 'Inspect the room before calling lookup.',
        reasoning_content: 'Inspect the room before calling lookup.',
        tool_calls: [expect.objectContaining({ id: 'call-1' })],
      }),
      expect.any(Function),
    )

    client.disconnect()
  })
})
