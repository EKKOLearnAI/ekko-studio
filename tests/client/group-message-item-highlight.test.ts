// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('naive-ui', () => ({
  useMessage: () => ({
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  }),
  NPopover: { template: '<div><slot name="trigger" /><slot /></div>' },
}))

vi.mock('@/api/studio/download', () => ({
  getDownloadUrl: (_path: string, name: string) => `/download/${name}`,
}))

vi.mock('@/components/hermes/chat/MarkdownRenderer.vue', () => ({
  default: {
    name: 'MarkdownRenderer',
    props: ['content'],
    template: '<markdown-renderer-stub :content="content" />',
  },
}))

import GroupMessageItem from '@/components/hermes/group-chat/GroupMessageItem.vue'
import type { ChatMessage } from '@/api/studio/group-chat'
import { useGroupChatStore } from '@/stores/hermes/group-chat'

function mountToolMessage(message: Partial<ChatMessage>) {
  return mount(GroupMessageItem, {
    props: {
      message: {
        id: 'group-tool',
        roomId: 'room-1',
        senderId: 'agent-1',
        senderName: 'UAT Agent',
        role: 'tool',
        content: '',
        timestamp: new Date().toISOString(),
        toolName: 'runtime_payload',
        toolStatus: 'done',
        ...message,
      } as ChatMessage,
      agents: [],
      members: [],
      currentUserId: 'user-1',
    },
    global: { stubs: { MarkdownRenderer: true, ProfileAvatar: true } },
  })
}

describe('GroupMessageItem tool details', () => {
  beforeEach(() => {
    vi.useRealTimers()
    setActivePinia(createPinia())
    Object.defineProperty(window, 'isSecureContext', {
      configurable: true,
      value: true,
    })
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    })
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      value: {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        getVoices: vi.fn(() => []),
        speak: vi.fn(),
        cancel: vi.fn(),
        pause: vi.fn(),
        resume: vi.fn(),
      },
    })
  })

  it('shows an explicit unavailable-result label for interrupted historical tools', () => {
    const wrapper = mountToolMessage({ toolStatus: 'interrupted' })

    expect(wrapper.find('.tool-spinner').exists()).toBe(false)
    expect(wrapper.get('.tool-interrupted-badge').text()).toBe('chat.toolResultUnavailable')
  })

  it('selects a group message as the active room reference', async () => {
    const store = useGroupChatStore()
    store.currentRoomId = 'room-1'
    const wrapper = mount(GroupMessageItem, {
      props: {
        message: {
          id: 'group-assistant',
          roomId: 'room-1',
          senderId: 'agent-1',
          senderName: 'Worker',
          role: 'assistant',
          content: 'Use this group answer',
          timestamp: Date.now(),
        },
        agents: [{ id: 'agent-row', roomId: 'room-1', agentId: 'agent-1', profile: 'worker', name: 'Worker', description: '', invited: 1 }],
        members: [],
        currentUserId: 'user-1',
      },
      global: { stubs: { MarkdownRenderer: true, ProfileAvatar: true } },
    })

    expect(wrapper.get('.reference-bubble-btn svg').findAll('path').map(path => path.attributes('d'))).toEqual([
      'M9 17l-5-5 5-5',
      'M20 18v-2a4 4 0 0 0-4-4H4',
    ])
    await wrapper.get('.reference-bubble-btn').trigger('click')

    expect(store.activeMessageReference).toMatchObject({
      id: 'group-assistant',
      content: 'Use this group answer',
      sender: 'Worker',
    })
  })

  it('keeps streaming Agent reasoning collapsed until the user expands it', async () => {
    const wrapper = mount(GroupMessageItem, {
      props: {
        message: {
          id: 'group-thinking',
          roomId: 'room-1',
          senderId: 'agent-1',
          senderName: 'Worker',
          role: 'assistant',
          content: '',
          reasoning: 'Inspecting several possible approaches.',
          isStreaming: true,
          timestamp: Date.now(),
        },
        agents: [{ id: 'agent-row', roomId: 'room-1', agentId: 'agent-1', profile: 'worker', name: 'Worker', description: '', invited: 1 }],
        members: [],
        currentUserId: 'user-1',
      },
      global: { stubs: { MarkdownRenderer: true, ProfileAvatar: true } },
    })

    expect(wrapper.find('.thinking-body').exists()).toBe(false)
    expect(wrapper.get('.thinking-label').text()).toBe('chat.thinkingInProgress')
    await wrapper.get('.thinking-header').trigger('click')
    expect(wrapper.get('.thinking-body markdown-renderer-stub').attributes('content'))
      .toBe('Inspecting several possible approaches.')
  })

  it('throttles streaming body Markdown and commits the final body immediately', async () => {
    vi.useFakeTimers()
    const baseMessage: ChatMessage = {
      id: 'group-streaming-body',
      roomId: 'room-1',
      senderId: 'agent-1',
      senderName: 'Worker',
      role: 'assistant',
      content: 'A',
      isStreaming: true,
      timestamp: Date.now(),
    }
    const wrapper = mount(GroupMessageItem, {
      props: {
        message: baseMessage,
        agents: [],
        members: [],
        currentUserId: 'user-1',
      },
      global: { stubs: { MarkdownRenderer: true, ProfileAvatar: true } },
    })

    expect(wrapper.get('.msg-content markdown-renderer-stub').attributes('content')).toBe('A')
    await wrapper.setProps({ message: { ...baseMessage, content: 'AB' } })
    expect(wrapper.get('.msg-content markdown-renderer-stub').attributes('content')).toBe('A')

    await vi.advanceTimersByTimeAsync(100)
    expect(wrapper.get('.msg-content markdown-renderer-stub').attributes('content')).toBe('AB')

    await wrapper.setProps({ message: { ...baseMessage, content: 'ABC', isStreaming: false } })
    expect(wrapper.get('.msg-content markdown-renderer-stub').attributes('content')).toBe('ABC')
    wrapper.unmount()
  })

  it('normalizes non-string runtime tool payloads before rendering', async () => {
    const wrapper = mountToolMessage({
      toolArgs: { group: true, values: [1, 2, 3] },
      toolResult: false,
    } as unknown as Partial<ChatMessage>)

    await wrapper.find('.tool-line').trigger('click')

    const blocks = wrapper.findAll('.tool-details .hljs-code-block')
    expect(blocks).toHaveLength(2)
    expect(blocks[0].find('.code-lang').text()).toBe('json')
    expect(blocks[0].find('code').text()).toContain('values')
    expect(blocks[1].find('.code-lang').text()).toBe('json')
    expect(blocks[1].find('code').text()).toBe('false')
  })

  it('adds the tool-call reasoning as the first expanded detail section', async () => {
    const wrapper = mountToolMessage({
      reasoning: 'I should inspect the group context first.',
      toolArgs: { room: 'room-1' },
      toolResult: 'done',
    })

    await wrapper.find('.tool-line').trigger('click')

    const sections = wrapper.findAll('.tool-details .tool-detail-section')
    expect(sections).toHaveLength(3)
    expect(sections.map(section => section.find('.tool-detail-label').text())).toEqual([
      'chat.thinkingLabel',
      'chat.arguments',
      'chat.result',
    ])
    expect(wrapper.get('.tool-detail-reasoning markdown-renderer-stub').attributes('content'))
      .toBe('I should inspect the group context first.')
  })

  it('keeps plain string false payloads as text', async () => {
    const wrapper = mountToolMessage({
      toolResult: 'false',
    })

    await wrapper.find('.tool-line').trigger('click')

    const block = wrapper.find('.tool-details .hljs-code-block')
    expect(block.exists()).toBe(true)
    expect(block.find('.code-lang').text()).toBe('text')
    expect(block.find('code').text()).toBe('false')
  })

  it('uses the compact single-chat identity layout for an Agent message', () => {
    const wrapper = mount(GroupMessageItem, {
      props: {
        message: {
          id: 'group-agent-identity',
          roomId: 'room-1',
          senderId: 'agent-1',
          senderName: 'Worker',
          role: 'assistant',
          content: 'Hello',
          timestamp: Date.now(),
        },
        agents: [{ id: 'agent-row', roomId: 'room-1', agentId: 'agent-1', profile: 'worker', name: 'Worker', description: '', invited: 1 }],
        members: [],
        currentUserId: 'user-1',
      },
      global: { stubs: { MarkdownRenderer: true, ProfileAvatar: true } },
    })

    const header = wrapper.get('.msg-header')
    expect(header.get('.sender-name').text()).toBe('Worker')
    expect(header.get('.message-agent-avatar').attributes('style')).toContain('width: 22px')
    expect(header.get('.message-agent-avatar').classes()).toContain('message-agent-avatar--compact')
    expect(wrapper.find('.avatar').exists()).toBe(false)
  })

  it('uses the compact mirrored identity layout for the current user', () => {
    const wrapper = mount(GroupMessageItem, {
      props: {
        message: {
          id: 'group-user-identity',
          roomId: 'room-1',
          senderId: 'user-1',
          senderName: 'Researcher',
          role: 'user',
          content: 'Hello',
          timestamp: Date.now(),
        },
        agents: [],
        members: [{ userId: 'user-1', name: 'Researcher', avatar: '' }],
        currentUserId: 'user-1',
      },
      global: { stubs: { MarkdownRenderer: true, ProfileAvatar: true } },
    })

    const header = wrapper.get('.msg-header')
    expect(header.get('.sender-name').text()).toBe('Researcher')
    const userAvatar = header.get('.profile-avatar-view, profile-avatar-stub')
    expect(`${userAvatar.attributes('style') || ''} ${userAvatar.attributes('size') || ''}`).toContain('22')
    expect(wrapper.get('.group-message').classes()).toContain('self')
  })
})
