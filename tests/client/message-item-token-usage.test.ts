// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string | number>) => {
      if (key === 'chat.tokenUsage') {
        return `${params?.input} in · ${params?.output} out`
      }
      if (key === 'chat.tokenUsageWithCache') {
        return `${params?.input} in · ${params?.cache} cache · ${params?.output} out`
      }
      return key
    },
  }),
}))

vi.mock('naive-ui', () => ({
  NButton: { template: '<button><slot /></button>' },
  NDrawer: { template: '<div><slot /></div>' },
  NDrawerContent: { template: '<div><slot /></div>' },
  NSpin: { template: '<div />' },
  useMessage: () => ({
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  }),
}))

import MessageItem from '@/components/hermes/chat/MessageItem.vue'
import { useChatStore, type Message, type Session } from '@/stores/hermes/chat'
import { useSettingsStore } from '@/stores/hermes/settings'

function makeSession(partial: Partial<Session> & { messages: Message[] }): Session {
  return {
    id: 'session-1',
    title: 'Token usage session',
    createdAt: 1,
    updatedAt: 1,
    inputTokens: 1200,
    outputTokens: 340,
    ...partial,
  }
}

describe('MessageItem token usage', () => {
  beforeEach(() => {
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

  it('hides reply token usage when show_cost is disabled', () => {
    const chatStore = useChatStore()
    const settingsStore = useSettingsStore()
    settingsStore.display.show_cost = false

    const message: Message = {
      id: 'assistant-1',
      role: 'assistant',
      content: 'Done',
      timestamp: Date.now(),
      usage: { input: 100, output: 20 },
    }

    chatStore.activeSessionId = 'session-1'
    chatStore.activeSession = makeSession({ messages: [message] })

    const wrapper = mount(MessageItem, {
      props: { message },
      global: { stubs: { MarkdownRenderer: true } },
    })

    expect(wrapper.find('.message-usage').exists()).toBe(false)
  })

  it('shows provider-recorded run usage on the completed assistant reply', async () => {
    const chatStore = useChatStore()
    const settingsStore = useSettingsStore()
    settingsStore.display.show_cost = true

    const older: Message = {
      id: 'assistant-older',
      role: 'assistant',
      content: 'Earlier answer',
      timestamp: Date.now() - 1000,
      usage: { input: 500, output: 40 },
    }
    const latest: Message = {
      id: 'assistant-latest',
      role: 'assistant',
      content: 'Latest answer',
      timestamp: Date.now(),
      usage: { input: 17247, output: 1014, cacheRead: 122112 },
      runId: 'run-weather-1',
    }

    chatStore.activeSessionId = 'session-1'
    chatStore.activeSession = makeSession({
      messages: [
        { id: 'user-1', role: 'user', content: 'hi', timestamp: Date.now() - 2000 },
        older,
        latest,
      ],
      inputTokens: 91281,
      outputTokens: 1177,
    })

    const olderWrapper = mount(MessageItem, {
      props: { message: older },
      global: { stubs: { MarkdownRenderer: true } },
    })
    const latestWrapper = mount(MessageItem, {
      props: { message: latest },
      global: { stubs: { MarkdownRenderer: true } },
    })

    expect(olderWrapper.find('.message-usage').exists()).toBe(true)
    expect(olderWrapper.find('.message-usage').text()).toBe('500 in · 40 out')
    expect(latestWrapper.find('.message-usage').exists()).toBe(true)
    expect(latestWrapper.find('.message-usage').text()).toBe('17.2K in · 122.1K cache · 1.0K out')
  })

  it('does not show session cumulative tokens as reply usage', () => {
    const chatStore = useChatStore()
    const settingsStore = useSettingsStore()
    settingsStore.display.show_cost = true

    const message: Message = {
      id: 'assistant-no-run-usage',
      role: 'assistant',
      content: 'Done',
      timestamp: Date.now(),
    }

    chatStore.activeSessionId = 'session-1'
    chatStore.activeSession = makeSession({
      messages: [message],
      inputTokens: 91281,
      outputTokens: 1177,
    })

    const wrapper = mount(MessageItem, {
      props: { message },
      global: { stubs: { MarkdownRenderer: true } },
    })

    expect(wrapper.find('.message-usage').exists()).toBe(false)
  })

  it('does not show token usage while the assistant reply is still streaming', async () => {
    const chatStore = useChatStore()
    const settingsStore = useSettingsStore()
    settingsStore.display.show_cost = true

    const message: Message = {
      id: 'assistant-streaming',
      role: 'assistant',
      content: 'partial',
      timestamp: Date.now(),
      isStreaming: true,
      usage: { input: 100, output: 20 },
    }

    chatStore.activeSessionId = 'session-1'
    chatStore.activeSession = makeSession({ messages: [message] })

    const wrapper = mount(MessageItem, {
      props: { message },
      global: { stubs: { MarkdownRenderer: true } },
    })

    expect(wrapper.find('.message-usage').exists()).toBe(false)

    message.isStreaming = false
    chatStore.activeSession = makeSession({
      messages: [{ ...message, isStreaming: false }],
    })
    await wrapper.setProps({ message: { ...message, isStreaming: false } })
    await nextTick()

    expect(wrapper.find('.message-usage').exists()).toBe(true)
    expect(wrapper.find('.message-usage').text()).toBe('100 in · 20 out')
  })
})
