// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('naive-ui', async importOriginal => ({
  ...await importOriginal<typeof import('naive-ui')>(),
  useMessage: () => ({ success: vi.fn(), error: vi.fn() }),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('@/composables/useTheme', () => ({
  useTheme: () => ({ isDark: false }),
}))

import MessageList from '@/components/hermes/chat/MessageList.vue'
import HistoryMessageList from '@/components/hermes/chat/HistoryMessageList.vue'
import { useChatStore, type Message, type Session } from '@/stores/hermes/chat'
import { useToolTraceVisibility } from '@/composables/useToolTraceVisibility'

vi.mock('@/components/hermes/chat/MessageItem.vue', async () => {
  const { defineComponent } = await import('vue')
  return {
    default: defineComponent({
      name: 'MessageItem',
      props: {
        message: { type: Object, required: true },
        highlight: { type: Boolean, default: false },
      },
      template: '<div class="stub-message" :data-role="message.role" :data-id="message.id">{{ message.toolName || message.content }}</div>',
    }),
  }
})

function makeSession(messages: Message[]): Session {
  return {
    id: 'session-1',
    title: 'Tool trace visibility',
    messages,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

const sampleMessages: Message[] = [
  { id: 'user-1', role: 'user', content: 'inspect repo', timestamp: 1 },
  { id: 'tool-named', role: 'tool', content: '', timestamp: 2, toolName: 'read_file', toolResult: 'ok', toolStatus: 'done' },
  { id: 'tool-internal', role: 'tool', content: '', timestamp: 3, toolResult: 'internal', toolStatus: 'done' },
  { id: 'assistant-1', role: 'assistant', content: 'done', timestamp: 4 },
]

describe('tool trace visibility', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.removeItem('hermes_show_tool_calls')
    useToolTraceVisibility().setToolTraceVisible(true)
  })

  function mountLiveList() {
    const chatStore = useChatStore()
    chatStore.activeSessionId = 'session-1'
    chatStore.activeSession = makeSession([
      ...sampleMessages,
      { id: 'tool-running', role: 'tool', content: '', timestamp: 5, toolName: 'search', toolStatus: 'running' },
    ])
    chatStore.abortState = { aborting: true, synced: false }

    return mount(MessageList)
  }

  it('shows named transcript and live tool traces by default while keeping unnamed internal tools hidden', () => {
    const wrapper = mountLiveList()

    expect(wrapper.findAll('.stub-message').map(node => node.attributes('data-id'))).toEqual([
      'user-1',
      'tool-named',
      'assistant-1',
    ])
    expect(wrapper.findAll('.tool-call-name').map(node => node.text())).toContain('search')
  })

  it('applies the same default-visible rule to history sessions', () => {
    const wrapper = mount(HistoryMessageList, {
      props: { session: makeSession(sampleMessages) },
    })

    expect(wrapper.findAll('.stub-message').map(node => node.attributes('data-id'))).toEqual([
      'user-1',
      'tool-named',
      'assistant-1',
    ])
  })

  it('lets an assistant host hide all tools without changing the ordinary chat preference', async () => {
    const wrapper = mountLiveList()
    useChatStore().focusMessageId = 'tool-named'
    await wrapper.setProps({ hideToolCalls: true })

    expect(wrapper.findAll('.stub-message').map(node => node.attributes('data-id'))).toEqual([
      'user-1',
      'assistant-1',
    ])
    expect(wrapper.findAll('.tool-call-name').map(node => node.text())).not.toContain('search')
    expect(wrapper.find('.tool-run-card').exists()).toBe(false)
    expect(wrapper.find('.compression-item').exists()).toBe(true)
    expect(useToolTraceVisibility().toolTraceVisible.value).toBe(true)

    await wrapper.setProps({ hideToolCalls: false })
    expect(wrapper.find('[data-id="tool-named"]').exists()).toBe(true)
    expect(wrapper.findAll('.tool-call-name').map(node => node.text())).toContain('search')
    wrapper.unmount()
  })

  it('groups and folds completed history tools from the same run', async () => {
    const wrapper = mount(HistoryMessageList, {
      props: {
        session: makeSession([
          { id: 'user-1', role: 'user', content: 'inspect repo', timestamp: 1 },
          { id: 'tool-1', role: 'tool', content: '', timestamp: 2, toolName: 'read_file', toolResult: 'one', toolStatus: 'done', runMarker: 'history-run' },
          { id: 'tool-2', role: 'tool', content: '', timestamp: 3, toolName: 'search', toolResult: 'two', toolStatus: 'done', runMarker: 'history-run' },
          { id: 'assistant-1', role: 'assistant', content: 'done', timestamp: 4 },
        ]),
      },
    })

    const card = wrapper.get('.tool-run-card')
    const toggle = card.get('.tool-run-header')
    expect(toggle.attributes('aria-expanded')).toBe('false')
    expect(wrapper.find('[data-id="tool-1"]').exists()).toBe(false)
    expect(wrapper.find('[data-id="tool-2"]').exists()).toBe(false)

    await toggle.trigger('click')
    expect(toggle.attributes('aria-expanded')).toBe('true')
    expect(wrapper.find('[data-id="tool-1"]').exists()).toBe(true)
    expect(wrapper.find('[data-id="tool-2"]').exists()).toBe(true)

    await toggle.trigger('click')
    expect(toggle.attributes('aria-expanded')).toBe('false')
    await vi.waitFor(() => {
      expect(wrapper.find('[data-id="tool-1"]').exists()).toBe(false)
      expect(wrapper.find('[data-id="tool-2"]').exists()).toBe(false)
    })
  })

  it('does not fall back to the live chat session while history session data is loading', () => {
    const chatStore = useChatStore()
    chatStore.activeSessionId = 'session-1'
    chatStore.activeSession = makeSession(sampleMessages)

    const wrapper = mount(HistoryMessageList, {
    })

    expect(wrapper.findAll('.stub-message')).toHaveLength(0)
  })

  it('hides named transcript traces when the toggle is off while keeping live tool stream visible', () => {
    useToolTraceVisibility().setToolTraceVisible(false)

    const liveWrapper = mountLiveList()
    expect(liveWrapper.findAll('.stub-message').map(node => node.attributes('data-id'))).toEqual([
      'user-1',
      'assistant-1',
    ])
    expect(liveWrapper.findAll('.tool-call-name').map(node => node.text())).toContain('search')

    const historyWrapper = mount(HistoryMessageList, {
      props: { session: makeSession(sampleMessages) },
    })
    expect(historyWrapper.findAll('.stub-message').map(node => node.attributes('data-id'))).toEqual([
      'user-1',
      'assistant-1',
    ])
  })

  it('does not treat tool traces before a slash command as current tool calls', () => {
    const chatStore = useChatStore()
    chatStore.activeSessionId = 'session-1'
    chatStore.activeSession = makeSession([
      { id: 'user-1', role: 'user', content: 'check weather', timestamp: 1 },
      { id: 'tool-weather', role: 'tool', content: '', timestamp: 2, toolName: 'weather', toolResult: 'ok', toolStatus: 'done' },
      { id: 'command-1', role: 'command', content: '/moa where next', timestamp: 3 },
    ])
    chatStore.abortState = { aborting: true, synced: false }

    const wrapper = mount(MessageList)

    expect(wrapper.findAll('.stub-message').map(node => node.attributes('data-id'))).toContain('tool-weather')
    expect(wrapper.findAll('.tool-call-name').map(node => node.text())).not.toContain('weather')
  })

})
