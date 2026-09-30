// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, nextTick } from 'vue'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('@/components/hermes/chat/VirtualMessageList.vue', () => ({
  default: defineComponent({
    name: 'VirtualMessageList',
    props: {
      messages: { type: Array, default: () => [] },
    },
    setup(_props, { expose }) {
      expose({
        isNearBottom: () => true,
        shouldAutoFollowBottom: () => true,
        scrollToBottom: vi.fn(),
        scrollToMessage: vi.fn(),
        scrollToAnchor: vi.fn(),
        captureScrollPosition: () => null,
        restoreScrollPosition: vi.fn(),
        captureViewportPosition: () => null,
        restoreViewportPosition: vi.fn(),
      })
    },
    template: `
      <div>
        <slot name="item" v-for="message in messages" :key="message.id" :message="message" />
        <slot name="after" />
      </div>
    `,
  }),
}))

vi.mock('@/components/hermes/chat/MessageItem.vue', async () => {
  const { defineComponent } = await import('vue')
  return {
    default: defineComponent({
      name: 'MessageItem',
      props: {
        message: { type: Object, required: true },
      },
      template: '<div class="message-item-stub" :data-id="message.id">{{ message.reasoning || message.content }}</div>',
    }),
  }
})

vi.mock('@/components/hermes/chat/MarkdownRenderer.vue', async () => {
  const { defineComponent } = await import('vue')
  return {
    default: defineComponent({
      name: 'MarkdownRenderer',
      props: {
        content: { type: String, default: '' },
      },
      template: '<div class="markdown-renderer-stub">{{ content }}</div>',
    }),
  }
})

import MessageList from '@/components/hermes/chat/MessageList.vue'
import { useChatStore, type Message, type Session } from '@/stores/hermes/chat'

function makeSession(messages: Message[]): Session {
  return {
    id: 'session-1',
    title: 'Live reasoning',
    messages,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

function mountMessageList(messages: Message[], runActive = true) {
  const chatStore = useChatStore()
  chatStore.activeSessionId = 'session-1'
  chatStore.activeSession = makeSession(messages)
  chatStore.abortState = runActive ? { aborting: true, synced: false } : null

  return mount(MessageList)
}

describe('MessageList live reasoning', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('updates the thinking logo with the active agent and preserves the Ekko animation', async () => {
    const wrapper = mountMessageList([])
    const chatStore = useChatStore()
    for (const [agent, src] of [
      ['hermes', '/coding-agents/hermes.png'],
      ['codex', '/coding-agents/codex-openai.png'],
      ['claude-code', '/coding-agents/claude-code.svg'],
      ['ekko-agent', 'thinking.gif'],
      ['pi', '/coding-agents/pi.svg'],
    ]) {
      chatStore.activeSession = { ...makeSession([]), agent }
      await nextTick()
      expect(wrapper.get('.thinking-avatar').attributes('src')).toContain(src)
      expect(wrapper.get('.thinking-avatar').classes()).toContain(
        agent === 'ekko-agent' ? 'thinking-avatar--animated' : 'thinking-avatar--logo',
      )
    }
    wrapper.unmount()
  })

  it('renders live reasoning between the thinking animation and tool area instead of flashing a message bubble', async () => {
    const wrapper = mountMessageList([
      { id: 'user-1', role: 'user', content: 'Think about this', timestamp: 1 },
      {
        id: 'assistant-1',
        role: 'assistant',
        content: '',
        reasoning: 'Working through the answer',
        timestamp: 2,
        isStreaming: true,
      },
    ])
    await flushPromises()

    expect(wrapper.find('[data-id="assistant-1"].message-item-stub').exists()).toBe(false)
    expect(wrapper.get('.thinking-status').text()).toContain('chat.thinkingInProgress')
    expect(wrapper.get('.live-reasoning-detail').text()).toContain('Working through the answer')

    const status = wrapper.get('.thinking-status').element
    const reasoning = wrapper.get('.live-reasoning-detail').element
    expect(status.compareDocumentPosition(reasoning) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('keeps the complete reasoning ticker text without inserting an ellipsis', async () => {
    const longReasoning = Array.from({ length: 80 }, (_, index) => `step-${index}`).join(' ')
    const wrapper = mountMessageList([
      { id: 'user-1', role: 'user', content: 'Think about this', timestamp: 1 },
      {
        id: 'assistant-long-reasoning',
        role: 'assistant',
        content: '',
        reasoning: longReasoning,
        timestamp: 2,
        isStreaming: true,
      },
    ])
    await flushPromises()

    expect(wrapper.get('.live-reasoning-body').text()).toBe(longReasoning)
    expect(wrapper.get('.live-reasoning-body').text().startsWith('…')).toBe(false)
  })

  it('shows the insert arrow for Hermes and one-shot coding agents', async () => {
    const chatStore = useChatStore()
    const session = makeSession([])
    session.source = 'cli'
    session.agent = 'hermes'
    chatStore.activeSessionId = 'session-1'
    chatStore.activeSession = session
    chatStore.queuedUserMessages = new Map([['session-1', [{
      id: 'queue-1', role: 'user', content: 'Follow up', timestamp: 1, queued: true,
    }]]])
    const insertSpy = vi.spyOn(chatStore, 'insertQueuedMessage')
    const wrapper = mount(MessageList)

    expect(wrapper.get('.queue-insert').attributes('title')).toBe('chat.insertQueuedMessage')
    await wrapper.get('.queue-insert').trigger('click')
    expect(insertSpy).toHaveBeenCalledWith('session-1', 'queue-1')

    chatStore.activeSession = {
      ...session,
      source: 'coding_agent',
      agent: 'codex',
      codingAgentId: 'codex',
    }
    await nextTick()
    expect(wrapper.get('.queue-insert').attributes('title')).toBe('chat.insertQueuedMessage')
    await wrapper.get('.queue-insert').trigger('click')
    expect(insertSpy).toHaveBeenLastCalledWith('session-1', 'queue-1')

    chatStore.activeSession = {
      ...session,
      source: 'coding_agent',
      agent: 'cursor',
      codingAgentId: 'cursor',
    }
    await nextTick()
    expect(wrapper.get('.queue-insert').attributes('title')).toBe('chat.insertQueuedMessage')
    await wrapper.get('.queue-insert').trigger('click')
    expect(insertSpy).toHaveBeenLastCalledWith('session-1', 'queue-1')
  })

  it('keeps the standalone thinking status before assistant output starts', () => {
    const wrapper = mountMessageList([
      { id: 'user-1', role: 'user', content: 'Think about this', timestamp: 1 },
    ])

    expect(wrapper.get('.thinking-status').text()).toContain('chat.thinkingInProgress')
  })

  it('moves a finalized tool and its reasoning into the transcript, then reuses the fixed live line', async () => {
    const chatStore = useChatStore()
    const wrapper = mountMessageList([
      { id: 'user-1', role: 'user', content: 'Use a tool', timestamp: 1 },
      {
        id: 'assistant-1',
        role: 'assistant',
        content: '',
        reasoning: 'Need inspect the file.',
        timestamp: 2,
        isStreaming: false,
      },
      {
        id: 'tool-1',
        role: 'tool',
        content: '',
        toolName: 'read_file',
        reasoning: 'Need inspect the file.',
        toolStatus: 'running',
        timestamp: 3,
      },
    ])
    await flushPromises()

    expect(wrapper.find('[data-id="assistant-1"]').exists()).toBe(false)
    expect(wrapper.get('.live-reasoning-detail').text()).toContain('Need inspect the file.')
    const liveReasoningRow = wrapper.get('.live-reasoning-detail').element
    const tool = wrapper.get('.tool-calls-panel .tool-call-item:not(.compression-item)').element
    expect(liveReasoningRow.compareDocumentPosition(tool) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(chatStore.messages.find(message => message.id === 'assistant-1')).toEqual(
      expect.objectContaining({ reasoning: 'Need inspect the file.' }),
    )

    const runningTool = chatStore.messages.find(message => message.id === 'tool-1')
    if (!runningTool) throw new Error('expected running tool')
    runningTool.toolStatus = 'done'
    await nextTick()

    expect(wrapper.get('[data-id="tool-1"]').text()).toContain('Need inspect the file.')
    expect(wrapper.findAll('.tool-calls-panel .tool-call-item:not(.compression-item)')).toHaveLength(0)
    expect(wrapper.get('.live-reasoning-detail').classes()).toContain('is-empty')
    expect(wrapper.get('.live-reasoning-body').text()).toBe('')

    chatStore.messages.push({
      id: 'assistant-2',
      role: 'assistant',
      content: '',
      reasoning: 'Now summarize\n  the tool result.',
      timestamp: 4,
      isStreaming: true,
    })
    await nextTick()

    expect(wrapper.get('.live-reasoning-body').text()).toBe('Now summarize the tool result.')
    expect(wrapper.get('.live-reasoning-detail').text()).not.toContain('Need inspect the file.')
    expect(wrapper.get('.live-reasoning-detail').element).toBe(liveReasoningRow)
    expect(chatStore.messages.find(message => message.id === 'tool-1')).toEqual(
      expect.objectContaining({ reasoning: 'Need inspect the file.' }),
    )
  })

  it('does not materialize a completed reasoning-only response as an empty-body bubble', () => {
    const wrapper = mountMessageList([
      { id: 'user-1', role: 'user', content: 'Think about this', timestamp: 1 },
      {
        id: 'assistant-1',
        role: 'assistant',
        content: '',
        reasoning: 'The model returned reasoning without a final body.',
        timestamp: 2,
        isStreaming: false,
      },
    ], false)

    expect(wrapper.find('[data-id="assistant-1"]').exists()).toBe(false)
  })

  it('does not materialize think-tag-only streaming content as a bubble', () => {
    const wrapper = mountMessageList([
      { id: 'user-1', role: 'user', content: 'Think about this', timestamp: 1 },
      {
        id: 'assistant-1',
        role: 'assistant',
        content: '<think>Working through the answer</think>',
        timestamp: 2,
        isStreaming: true,
      },
    ])

    expect(wrapper.find('[data-id="assistant-1"]').exists()).toBe(false)
    expect(wrapper.get('.thinking-status').text()).toContain('chat.thinkingInProgress')
  })

  it('keeps body content that follows a thinking segment', () => {
    const wrapper = mountMessageList([
      { id: 'user-1', role: 'user', content: 'Think about this', timestamp: 1 },
      {
        id: 'assistant-1',
        role: 'assistant',
        content: '<reasoning>Working through the answer</reasoning>Final answer',
        timestamp: 2,
        isStreaming: true,
      },
    ])

    expect(wrapper.get('[data-id="assistant-1"]').exists()).toBe(true)
  })

  it('keeps an assistant bubble when a reasoning-only message has an attachment', () => {
    const wrapper = mountMessageList([
      { id: 'user-1', role: 'user', content: 'Create a file', timestamp: 1 },
      {
        id: 'assistant-1',
        role: 'assistant',
        content: '<think>Preparing the file</think>',
        attachments: [{
          id: 'attachment-1',
          name: 'result.txt',
          type: 'text/plain',
          size: 6,
          url: '/result.txt',
        }],
        timestamp: 2,
        isStreaming: false,
      },
    ], false)

    expect(wrapper.get('[data-id="assistant-1"]').exists()).toBe(true)
  })

  it('keeps the thinking animation through tool execution and removes the run panel when the lifecycle finishes', async () => {
    vi.useFakeTimers()
    const chatStore = useChatStore()
    const wrapper = mountMessageList([
      { id: 'user-1', role: 'user', content: 'Use a tool', timestamp: 1 },
      {
        id: 'tool-1',
        role: 'tool',
        content: '',
        toolName: 'read_file',
        toolStatus: 'done',
        timestamp: 2,
      },
    ])

    expect(wrapper.find('.tool-calls-panel').exists()).toBe(true)
    expect(wrapper.find('.thinking-status').exists()).toBe(true)

    chatStore.abortState = null
    expect(chatStore.abortState).toBeNull()
    expect(chatStore.isRunActive).toBe(false)
    await nextTick()
    await vi.advanceTimersByTimeAsync(500)
    await flushPromises()

    expect(wrapper.find('.streaming-indicator').exists()).toBe(false)
    expect(wrapper.find('.thinking-status').exists()).toBe(false)
  })

  it('keeps completed tools in the transcript for every session while only running tools stay live', async () => {
    const wrapper = mountMessageList([
      { id: 'user-1', role: 'user', content: 'Inspect the repository', timestamp: 1 },
      {
        id: 'tool-done',
        role: 'tool',
        content: '',
        toolName: 'Command',
        toolStatus: 'done',
        reasoning: 'Read the files first.',
        timestamp: 2,
      },
      {
        id: 'tool-running',
        role: 'tool',
        content: '',
        toolName: 'Command',
        toolStatus: 'running',
        reasoning: 'Run the focused tests.',
        timestamp: 3,
      },
    ])
    await flushPromises()

    expect(wrapper.find('[data-id="tool-done"]').exists()).toBe(true)
    expect(wrapper.find('[data-id="tool-running"]').exists()).toBe(false)
    expect(wrapper.findAll('.tool-calls-panel .tool-call-item:not(.compression-item)')).toHaveLength(1)
    expect(wrapper.get('.tool-calls-panel').text()).toContain('Command')
    expect(wrapper.get('.live-reasoning-body').text()).toBe('Run the focused tests.')
  })

  it('groups completed tools with a run id and leaves tools without one as individual rows', async () => {
    const wrapper = mountMessageList([
      { id: 'user-1', role: 'user', content: 'Use several tools', timestamp: 1 },
      {
        id: 'tool-1',
        role: 'tool',
        content: '',
        toolName: 'read_file',
        toolStatus: 'done',
        runMarker: 'run-1',
        timestamp: 2,
      },
      {
        id: 'tool-2',
        role: 'tool',
        content: '',
        toolName: 'search',
        toolStatus: 'error',
        runMarker: 'run-1',
        timestamp: 3,
      },
      {
        id: 'tool-without-run',
        role: 'tool',
        content: '',
        toolName: 'legacy_tool',
        toolStatus: 'done',
        timestamp: 4,
      },
    ], false)
    await flushPromises()

    expect(wrapper.findAll('.tool-run-card')).toHaveLength(1)
    expect(wrapper.get('.tool-run-card').attributes('data-run-id')).toBe('run-1')
    expect(wrapper.find('[data-id="tool-1"]').exists()).toBe(false)
    expect(wrapper.find('[data-id="tool-2"]').exists()).toBe(false)
    expect(wrapper.find('[data-id="tool-without-run"]').exists()).toBe(true)

    await wrapper.get('.tool-run-header').trigger('click')

    expect(wrapper.find('[data-id="tool-1"]').exists()).toBe(true)
    expect(wrapper.find('[data-id="tool-2"]').exists()).toBe(true)
  })
})
