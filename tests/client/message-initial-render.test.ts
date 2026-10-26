// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('naive-ui', () => ({
  useMessage: () => ({ error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() }),
  NPopover: { template: '<div><slot name="trigger" /><slot /></div>' },
}))

import MessageItem from '@/components/hermes/chat/MessageItem.vue'
import GroupMessageItem from '@/components/hermes/group-chat/GroupMessageItem.vue'

describe('initial message rendering', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
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

  describe.each(['single', 'group'] as const)('%s chat', (kind) => {
    it.each(['user', 'assistant'] as const)('renders %s Markdown with the bubble on the first render', (role) => {
      const message = {
        id: `initial-${role}`,
        role,
        content: 'Already loaded **message text**',
        timestamp: Date.now(),
      }
      const wrapper = kind === 'single'
        ? mount(MessageItem, { props: { message } })
        : mount(GroupMessageItem, {
            props: {
              message: {
                ...message,
                roomId: 'room-1',
                senderId: role === 'user' ? 'user-1' : 'agent-1',
                senderName: role === 'user' ? 'Reader' : 'Worker',
              },
              agents: [{ id: 'agent-row', roomId: 'room-1', agentId: 'agent-1', profile: 'worker', name: 'Worker', description: '', invited: 1 }],
              currentUserId: 'user-1',
            },
          })

      try {
        // No promise/timer flush: loaded text must be present when its bubble mounts.
        const bubble = wrapper.get(kind === 'single' ? '.message-bubble' : '.msg-content')
        expect(bubble.get('.markdown-body strong').text()).toBe('message text')
      } finally {
        wrapper.unmount()
      }
    })
  })
})
