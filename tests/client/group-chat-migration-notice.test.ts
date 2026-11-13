// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { ref, type Ref } from 'vue'
import { createI18n } from 'vue-i18n'
import GroupChatMigrationNotice from '../../packages/client/src/components/hermes/group-chat/GroupChatMigrationNotice.vue'
import { pageLoadingKey } from '../../packages/client/src/composables/usePageLoading'
import { loadLocaleMessages, supportedLocales } from '../../packages/client/src/i18n/messages'
import zh from '../../packages/client/src/i18n/locales/zh'

const key = 'hermes.groupChat.botMigrationNotice.v1.acknowledged'
const wrappers: VueWrapper[] = []
vi.mock('naive-ui', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    NModal: defineComponent({
      props: ['show', 'title'],
      setup: (props, { slots }) => () => props.show ? h('section', { role: 'dialog', 'aria-label': props.title }, [slots.default?.(), slots.action?.()]) : null,
    }),
    NButton: defineComponent({ setup: (_, { slots }) => () => h('button', slots.default?.()) }),
    NAlert: defineComponent({ setup: (_, { slots }) => () => h('div', { role: 'alert' }, slots.default?.()) }),
  }
})
function render(loading: Ref<boolean> = ref(false)) {
  const wrapper = mount(GroupChatMigrationNotice, {
    global: {
      plugins: [createI18n({ legacy: false, locale: 'zh', messages: { zh } })],
      provide: { [pageLoadingKey as symbol]: loading },
    },
  })
  wrappers.push(wrapper)
  return wrapper
}

beforeEach(() => localStorage.clear())
afterEach(() => {
  wrappers.forEach(wrapper => wrapper.unmount())
  wrappers.length = 0
  vi.restoreAllMocks()
})

describe('group chat migration notice', () => {
  it('waits for page readiness and does not reuse the old upgrade acknowledgement', async () => {
    localStorage.setItem('hermes.groupChat.refactorNotice.v1.acknowledged', '1')
    const loading = ref(true)
    const wrapper = render(loading)
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
    loading.value = false
    await wrapper.vm.$nextTick()
    expect(wrapper.get('[role="dialog"]').attributes('aria-label')).toBe('群聊即将下架')
    expect(wrapper.text()).toContain('迁移到 Bot')
    expect(localStorage.getItem(key)).toBeNull()
  })

  it('saves only explicit acknowledgement and remains dismissed after remount and focus', async () => {
    const wrapper = render()
    await wrapper.vm.$nextTick()
    await wrapper.get('button').trigger('click')
    expect(localStorage.getItem(key)).toBe('1')
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
    const another = render()
    window.dispatchEvent(new Event('focus'))
    await another.vm.$nextTick()
    expect(another.find('[role="dialog"]').exists()).toBe(false)
  })

  it('keeps an unacknowledged notice eligible when the page is left and revisited', async () => {
    const first = render()
    await first.vm.$nextTick()
    first.unmount()
    wrappers.splice(wrappers.indexOf(first), 1)
    const next = render()
    await next.vm.$nextTick()
    expect(next.find('[role="dialog"]').exists()).toBe(true)
    expect(localStorage.getItem(key)).toBeNull()
  })

  it('keeps the notice open with a retryable error if persistent storage fails', async () => {
    const wrapper = render()
    await wrapper.vm.$nextTick()
    const save = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage blocked') })
    await wrapper.get('button').trigger('click')
    expect(wrapper.get('[role="alert"]').text()).toContain('无法保存确认状态')
    expect(wrapper.find('[role="dialog"]').exists()).toBe(true)
    save.mockRestore()
    await wrapper.get('button').trigger('click')
    expect(localStorage.getItem(key)).toBe('1')
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('transient failure') })
    window.dispatchEvent(new Event('focus'))
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
  })

  it('shows the notice if storage cannot be read and syncs acknowledgements from another tab', async () => {
    const read = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('storage blocked') })
    const wrapper = render()
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[role="dialog"]').exists()).toBe(true)
    read.mockRestore()
    localStorage.setItem(key, '1')
    window.dispatchEvent(new StorageEvent('storage', { key, newValue: '1' }))
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
  })

  it('removes cross-tab and focus listeners on unmount', () => {
    const remove = vi.spyOn(window, 'removeEventListener')
    const wrapper = render()
    wrapper.unmount()
    wrappers.splice(wrappers.indexOf(wrapper), 1)
    expect(remove).toHaveBeenCalledWith('storage', expect.any(Function))
    expect(remove).toHaveBeenCalledWith('focus', expect.any(Function))
  })

  it('provides the notice and acknowledgement action in every supported language', async () => {
    for (const locale of supportedLocales) {
      const messages = await loadLocaleMessages(locale)
      expect(messages.groupChat.migrationNoticeTitle).toBeTruthy()
      expect(messages.groupChat.migrationNoticeMessage).toContain('Bot')
      expect(messages.groupChat.migrationNoticeSaveFailed).toBeTruthy()
      expect(messages.announcements.gotIt).toBeTruthy()
    }
  })
})
