// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent } from 'vue'
import { createPinia } from 'pinia'
import type { ChatMessage, RoomAgent } from '@/api/studio/group-chat'
import GroupAgentRunCard from '@/components/hermes/group-chat/GroupAgentRunCard.vue'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('naive-ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('naive-ui')>()
  return {
    ...actual,
    useMessage: () => ({
      error: vi.fn(),
      success: vi.fn(),
      warning: vi.fn(),
      info: vi.fn(),
    }),
  }
})

const agent: RoomAgent = {
  id: 'agent-row-1',
  roomId: 'room-1',
  agentId: 'agent-1',
  profile: 'default',
  name: 'Worker',
  description: '',
  invited: 1,
}

function runItem(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: 'message-1',
    roomId: 'room-1',
    senderId: 'agent-1',
    senderName: 'Worker',
    content: '',
    timestamp: 1,
    role: 'assistant',
    run_id: 'run-current',
    ...overrides,
  }
}

function runMessage(items: ChatMessage[], isStreaming: boolean): ChatMessage {
  return {
    ...items[0],
    id: `group-agent-run:${items[0].senderId}:${items[0].run_id}`,
    role: 'agent_run',
    content: '',
    runItems: items,
    isStreaming,
  }
}

const GroupMessageItemStub = defineComponent({
  name: 'GroupMessageItem',
  props: {
    message: { type: Object, required: true },
  },
  template: '<div class="message-stub" :data-message-id="message.id">{{ message.toolName || message.content }}<slot name="before-workspace-changes" /></div>',
})

function mountCard(message: ChatMessage) {
  return mount(GroupAgentRunCard, {
    props: {
      message,
      agents: [agent],
      members: [],
      currentUserId: 'user-1',
    },
    global: {
      plugins: [createPinia()],
      stubs: {
        GroupMessageItem: GroupMessageItemStub,
        GroupAgentMessageAvatar: true,
        GroupAgentRobotIcon: true,
        ProfileAvatar: true,
      },
    },
  })
}

describe('GroupAgentRunCard tool list', () => {
  it('shows one shared usage card inside the completed reply bubble without a blank transcript row', async () => {
    const usage = { runId: 'run-current', assistantMessageId: 'reply', inputTokens: 1200, outputTokens: 200,
      cacheReadTokens: 300, cacheHitRate: 0.25, costUsd: 0.0123, tokensPerSecond: 50, isEstimated: false }
    const items = [runItem({ id: 'reply', content: 'Done' }), runItem({ id: 'usage', runUsage: usage })]
    const wrapper = mountCard(runMessage(items, true))
    expect(wrapper.find('.run-usage-card').exists()).toBe(false)
    await wrapper.setProps({ message: runMessage(items, false) })
    expect(wrapper.findAll('.run-usage-card')).toHaveLength(1)
    expect(wrapper.findAll('.run-transcript-item')).toHaveLength(1)
    expect(wrapper.find('.run-card .run-transcript-item .run-usage-card').exists()).toBe(true)
    expect(wrapper.get('.run-usage-card').text()).toContain('25.0%')
    expect(wrapper.get('.run-usage-card').text()).toContain('$0.0123')
    expect(wrapper.get('.run-usage-card').text()).toContain('50.0 tok/s')
    await wrapper.setProps({ message: runMessage([items[1]], false) })
    expect(wrapper.findAll('.run-usage-card')).toHaveLength(1)
    expect(wrapper.find('.run-card .run-usage-only .run-usage-card').exists()).toBe(true)
    expect(wrapper.find('.run-transcript').exists()).toBe(false)
  })
  it('places the current Agent/Run tool calls newest-first before its transcript', () => {
    const wrapper = mountCard(runMessage([
      runItem({ id: 'current-tool-1', role: 'tool', toolName: 'read_file', toolStatus: 'done' }),
      runItem({ id: 'current-reasoning', content: 'Checking the result.', isStreaming: true, timestamp: 2 }),
      runItem({ id: 'current-tool-2', role: 'tool', toolName: 'search', toolStatus: 'running', timestamp: 3 }),
    ], true))

    const panel = wrapper.get('.run-tool-list')
    expect(panel.attributes('tabindex')).toBe('0')
    expect(panel.attributes('aria-label')).toBe('chat.showToolCalls')
    expect(panel.attributes('data-agent-id')).toBe('agent-1')
    expect(panel.attributes('data-run-id')).toBe('run-current')
    expect(panel.findAll('.run-tool-item').map(item => item.attributes('data-message-id'))).toEqual([
      'current-tool-2',
      'current-tool-1',
    ])
    expect(wrapper.get('.run-transcript-item').attributes('data-message-id')).toBe('current-reasoning')
    expect(wrapper.get('.run-transcript').find('.tool-name').exists()).toBe(false)
    expect(wrapper.get('.run-column').element.children[0]).toBe(wrapper.get('.run-header').element)
    const runAvatar = wrapper.get('.run-header .message-agent-avatar, .run-header group-agent-message-avatar-stub')
    expect(`${runAvatar.attributes('style') || ''} ${runAvatar.attributes('size') || ''}`).toContain('22')
    expect(wrapper.get('.run-card').element.children[0]).toBe(wrapper.get('.run-tools').element)
    expect(wrapper.get('.run-card').element.children[1]).toBe(wrapper.get('.run-transcript').element)
    expect(wrapper.get('.run-column').element.children[2]).toBe(wrapper.get('.run-time').element)
  })

  it('folds completed historical tools and expands the bounded panel without hiding the transcript', async () => {
    const wrapper = mountCard(runMessage([
      runItem({ id: 'historical-tool-1', role: 'tool', toolName: 'read_file', toolStatus: 'done' }),
      runItem({ id: 'historical-answer', content: 'Finished.', timestamp: 2 }),
      runItem({ id: 'historical-tool-2', role: 'tool', toolName: 'search', toolStatus: 'done', timestamp: 3 }),
    ], false))

    const toggle = wrapper.get('.tool-run-header')
    expect(toggle.attributes('aria-expanded')).toBe('false')
    await vi.waitFor(() => expect(wrapper.find('.run-tool-list').exists()).toBe(false))
    expect(wrapper.get('.run-transcript-item').attributes('data-message-id')).toMatch(/answer$/)
    expect(toggle.text()).toContain('read_file')
    expect(toggle.text()).toContain('search')
    await toggle.trigger('click')
    expect(toggle.attributes('aria-expanded')).toBe('true')

    expect(wrapper.get('.run-tool-list').findAll('.run-tool-item').map(item => item.attributes('data-message-id'))).toEqual([
      'historical-tool-2',
      'historical-tool-1',
    ])
    expect(wrapper.findAll('.run-transcript-item').map(item => item.attributes('data-message-id'))).toEqual([
      'historical-answer',
    ])
    expect(wrapper.get('.run-transcript').text()).not.toContain('read_file')
    expect(wrapper.findAll('.run-tool-item[data-message-id="historical-tool-1"]')).toHaveLength(1)
    expect(wrapper.findAll('.run-tool-item[data-message-id="historical-tool-2"]')).toHaveLength(1)
    expect(wrapper.get('.run-card').element.children[0]).toBe(wrapper.get('.run-tools').element)
    expect(wrapper.get('.run-card').element.children[1]).toBe(wrapper.get('.run-transcript').element)
  })

  it('allows folding during execution and folds automatically when the run finishes', async () => {
    const tool = runItem({ id: 'tool-1', role: 'tool', toolName: 'search', toolStatus: 'running' })
    const wrapper = mountCard(runMessage([tool], true))
    const toggle = wrapper.get('.tool-run-header')
    expect(toggle.attributes('aria-expanded')).toBe('true')
    expect(wrapper.find('.tool-run-success').exists()).toBe(false)

    await toggle.trigger('click')
    await vi.waitFor(() => expect(wrapper.find('.run-tool-list').exists()).toBe(false))
    await wrapper.setProps({ message: runMessage([tool, runItem({ id: 'progress', content: 'Working' })], true) })
    expect(toggle.attributes('aria-expanded')).toBe('false')
    await toggle.trigger('click')

    await wrapper.setProps({ message: runMessage([
      { ...tool, toolStatus: 'done' },
      runItem({ id: 'answer', content: 'Finished.' }),
    ], false) })
    expect(toggle.attributes('aria-expanded')).toBe('false')
    await vi.waitFor(() => expect(wrapper.find('.run-tool-list').exists()).toBe(false))
    expect(wrapper.get('.run-transcript-item').attributes('data-message-id')).toMatch(/answer$/)
    await toggle.trigger('click')
    expect(wrapper.find('.run-tool-item').exists()).toBe(true)
  })

  it.each(['error', 'interrupted'] as const)('keeps %s visible in the collapsed summary', (toolStatus) => {
    const wrapper = mountCard(runMessage([
      runItem({ id: 'failed-tool', role: 'tool', toolName: 'search', toolStatus }),
    ], false))
    expect(wrapper.get('.tool-run-header').attributes('aria-expanded')).toBe('false')
    expect(wrapper.get('.tool-run-error').text()).toBe(toolStatus === 'error' ? 'chat.error' : 'chat.toolResultUnavailable')
    expect(wrapper.find('.tool-run-success').exists()).toBe(false)
  })

})
