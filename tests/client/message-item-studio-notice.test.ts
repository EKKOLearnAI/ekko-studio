// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Vite defines this at build time; the chat store's app-store import reads it on load.
vi.hoisted(() => { (globalThis as any).__APP_VERSION__ = 'test' })
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string, values?: Record<string, unknown>) => values?.name ? `${key}:${values.name}` : key }),
}))

vi.mock('naive-ui', () => ({
  NButton: { template: '<button><slot /></button>' },
  NDrawer: { template: '<div><slot /></div>' },
  NDrawerContent: { template: '<div><slot /></div>' },
  NSpin: { template: '<div />' },
  useMessage: () => ({ error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() }),
}))

import MessageItem from '@/components/hermes/chat/MessageItem.vue'
import type { Message } from '@/stores/hermes/chat'

function cron(content: string, notice: Record<string, unknown> = {}): Message {
  return {
    id: 'studio-notice-9', role: 'system', content, timestamp: Date.now(),
    studioNotice: {
      kind: 'cron', notification_id: 9, disposition: 'notified', job_id: 'job-9', job_name: 'Agent digest',
      execution_id: 'exec-9', status: 'completed', success: true, reason: null, error: null, truncated: false, finished_at: null,
      ...notice,
    } as any,
  }
}

const render = (message: Message) => mount(MessageItem, { props: { message } })

describe('MessageItem Cron notices', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      value: { addEventListener: vi.fn(), removeEventListener: vi.fn(), getVoices: vi.fn(() => []), speak: vi.fn(), cancel: vi.fn(), pause: vi.fn(), resume: vi.fn() },
    })
  })

  it('attributes an exact result to its job and shows it as plain text', () => {
    const wrapper = render(cron('**Done** <b>raw</b>'))
    expect(wrapper.find('.studio-notice-title').text()).toBe('chat.sessionNotice.cronTitle:Agent digest')
    expect(wrapper.find('.studio-notice-detail').exists()).toBe(false)
    expect(wrapper.find('.studio-notice-text').text()).toBe('**Done** <b>raw</b>')
    expect(wrapper.find('.markdown-body strong').exists()).toBe(false)
  })

  it('shows a known failure without result text with its native error', () => {
    const wrapper = render(cron('', { status: 'failed', success: false, error: 'provider unavailable' }))
    expect(wrapper.find('.studio-notice-title').text()).toBe('chat.sessionNotice.cronFailedTitle:Agent digest')
    expect(wrapper.find('.studio-notice-detail').text()).toBe('provider unavailable')
  })

  it.each([
    [{ disposition: 'unknown', success: null }, 'chat.sessionNotice.unknown'],
    [{ disposition: 'status_only', success: null, reason: 'output_unavailable_for_runtime' }, 'chat.sessionNotice.outputUnavailable'],
    [{ disposition: 'status_only', success: null, reason: 'receipt_unavailable' }, 'chat.sessionNotice.receiptUnavailable'],
    [{ truncated: true }, 'chat.sessionNotice.truncated'],
  ])('explains a %o notice', (notice, detail) => {
    expect(render(cron('', notice)).find('.studio-notice-detail').text()).toBe(detail)
  })
})
