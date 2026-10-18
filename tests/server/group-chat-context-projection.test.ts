import { describe, expect, it } from 'vitest'
import type { StoredMessage } from '../../packages/server/src/modules/studio/services/group-chat/types'
import {
  buildProjectedGroupChatHistory,
  projectGroupChatMessage,
} from '../../packages/server/src/modules/studio/services/group-chat/context-projection'
import {
  cleanGroupMessages,
  GroupRoomSummaryService,
} from '../../packages/server/src/modules/studio/services/group-chat/room-summary'

function makeMessage(overrides: Partial<StoredMessage>): StoredMessage {
  return {
    id: 'm1',
    roomId: 'room-1',
    senderId: 'user-1',
    senderName: 'Alice',
    content: 'hello',
    timestamp: 1,
    role: 'user',
    ...overrides,
  }
}

describe('group chat context projection', () => {
  it('projects own agent messages as assistant and other participants with attribution as user', () => {
    expect(projectGroupChatMessage(makeMessage({ senderId: 'agent-1', senderName: 'Worker', role: 'assistant', content: '@Bob I handled it' }), {
      agentId: 'agent-1',
      socketId: 'agent-socket-1',
      name: 'Worker',
    })).toEqual({ role: 'assistant', content: '[Worker]: I handled it' })

    expect(projectGroupChatMessage(makeMessage({ senderId: 'user-2', senderName: 'Alice', role: 'user', content: '@Worker please help' }), {
      socketId: 'agent-socket-1',
      name: 'Worker',
    })).toEqual({ role: 'user', content: '[Alice]: please help' })
  })

  it('does not project same-name humans as the own agent when sender ids differ', () => {
    expect(projectGroupChatMessage(makeMessage({
      senderId: 'user-2',
      senderName: 'Worker',
      role: 'user',
      content: '@Worker I am a different participant',
    }), {
      socketId: 'agent-socket-1',
      name: 'Worker',
    })).toEqual({ role: 'user', content: '[Worker]: I am a different participant' })
  })

  it('formats tool results and assistant tool calls consistently', () => {
    expect(projectGroupChatMessage(makeMessage({
      senderName: 'Worker',
      senderId: 'agent-socket-1',
      role: 'tool',
      tool_name: 'search',
      content: 'found docs',
    }), {
      socketId: 'agent-socket-1',
      name: 'Worker',
    })).toEqual({ role: 'user', content: '[Worker] [Tool result: search]\nfound docs' })

    expect(projectGroupChatMessage(makeMessage({
      senderName: 'Reviewer',
      senderId: 'agent-reviewer',
      role: 'assistant',
      content: '@Worker let me check',
      tool_calls: [{ function: { name: 'search', arguments: '{"q":"docs"}' } }],
    }), {
      socketId: 'agent-socket-1',
      name: 'Worker',
    })).toEqual({
      role: 'user',
      content: '[Reviewer]: let me check\n[Reviewer]: [Calling tool: search with arguments: {"q":"docs"}]',
    })
  })

  it('preserves summary prefix while stripping mentions from projected content', () => {
    const history = buildProjectedGroupChatHistory('Earlier summary', [
      makeMessage({ senderName: 'Alice', content: '@Worker compare this with @Bob' }),
    ], {
      socketId: 'agent-socket-1',
      name: 'Worker',
    })

    expect(history).toEqual([
      { role: 'user', content: '[Previous conversation summary]\nEarlier summary' },
      { role: 'assistant', content: 'I have reviewed the conversation history and understand the context.' },
      { role: 'user', content: '[Alice]: compare this with ' },
    ])
  })

  it('keeps only member messages and final assistant text in the shared room context', () => {
    const messages = [
      makeMessage({ id: 'm1', senderName: 'Alice', senderId: 'user-1', role: 'user', content: '@Worker please compare options' }),
      makeMessage({ id: 'm2', senderName: 'Worker', senderId: 'agent-1', role: 'assistant', content: '@Bob I will take this' }),
      makeMessage({ id: 'm3', senderName: 'Reviewer', senderId: 'agent-reviewer', role: 'assistant', content: '@Worker checking', tool_calls: [{ function: { name: 'search', arguments: '{"q":"options"}' } }], timestamp: 3 }),
      makeMessage({ id: 'm4', senderName: 'Worker', senderId: 'agent-1', role: 'tool', tool_name: 'search', content: 'docs found', timestamp: 4 }),
    ]

    expect(cleanGroupMessages(messages as any).map(message => ({
      id: message.id,
      role: message.role,
      senderName: message.senderName,
      content: message.content,
    }))).toEqual([
      { id: 'm1', role: 'user', senderName: 'Alice', content: '@Worker please compare options' },
      { id: 'm2', role: 'assistant', senderName: 'Worker', content: '@Bob I will take this' },
    ])
  })

  it('excludes usage metadata from projected history and room summaries', () => {
    const messages = [
      makeMessage({ id: 'reply', senderId: 'agent-1', senderName: 'Worker', role: 'assistant', content: 'Answer' }),
      makeMessage({ id: 'usage', senderId: 'agent-1', senderName: 'Worker', role: 'tool', tool_name: 'run_usage',
        content: JSON.stringify({ runId: 'run-1', inputTokens: 1000, outputTokens: 200 }), timestamp: 2 }),
    ]

    expect(buildProjectedGroupChatHistory('', messages, { agentId: 'agent-1', name: 'Worker' })).toEqual([
      { role: 'assistant', content: '[Worker]: Answer' },
    ])
    expect(cleanGroupMessages(messages as any).map(message => message.id)).toEqual(['reply'])
  })

  it('combines the persisted room summary with clean messages after its anchor', () => {
    const messages = [
      makeMessage({ id: 'm1', senderName: 'Alice', senderId: 'user-1', role: 'user', content: 'older request', timestamp: 1 }),
      makeMessage({ id: 'm2', senderName: 'Worker', senderId: 'agent-1', role: 'assistant', content: 'old answer', timestamp: 2 }),
      makeMessage({ id: 'm3', senderName: 'Alice', senderId: 'user-1', role: 'user', content: '@Worker latest request', timestamp: 3 }),
    ]
    const service = new GroupRoomSummaryService({
      getRoom: () => ({
        id: 'room-1',
        summaryProfile: 'default',
        summaryProvider: 'openai',
        summaryModel: 'test',
        summaryApiMode: '',
        summaryEveryTurns: 20,
      }),
      getMessagesForContext: () => messages,
      getRoomSummary: () => ({
        roomId: 'room-1',
        summary: 'Earlier room summary',
        summaryThroughMessageId: 'm1',
        summaryThroughMessageTimestamp: 1,
        summarizedTurnCount: 1,
        status: 'success',
        version: 1,
        updatedAt: 1,
        lastError: null,
      }),
      saveRoomSummary: () => {},
    })

    expect(service.buildRuntimeContext('room-1', 'm3')).toEqual({
      summary: 'Earlier room summary',
      history: [expect.objectContaining({
        id: 'm2',
        role: 'assistant',
        senderName: 'Worker',
        content: 'old answer',
      })],
    })
  })
})
