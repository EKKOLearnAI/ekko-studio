// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createTestingPinia } from '@pinia/testing'
import { nextTick } from 'vue'
import { useChatStore } from '@/stores/hermes/chat'
import { useSettingsStore } from '@/stores/hermes/settings'
import ChatInput from '@/components/hermes/chat/ChatInput.vue'

const fetchSkillsMock = vi.hoisted(() => vi.fn())
const fetchSkillBundlesMock = vi.hoisted(() => vi.fn())
const deleteSkillBundleApiMock = vi.hoisted(() => vi.fn())
const dialogWarningMock = vi.hoisted(() => vi.fn())
const setSessionPushEnabledMock = vi.hoisted(() => vi.fn())
const fetchSocialMessagePlatformsMock = vi.hoisted(() => vi.fn())
const messageWarningMock = vi.hoisted(() => vi.fn())

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('naive-ui', () => ({
  NButton: { template: '<button type="button" v-bind="$attrs"><slot /><slot name="icon" /></button>' },
  NTooltip: { template: '<div><slot name="trigger" /><slot /></div>' },
  NSwitch: { template: '<button type="button"></button>' },
  NDropdown: {
    props: ['options'],
    emits: ['select'],
    template: '<div class="dropdown-stub"><button v-for="option in options" :key="option.key" class="dropdown-option" @click="$emit(\'select\', option.key)">{{ option.label }}</button><slot /></div>',
  },
  NModal: { template: '<div><slot /><slot name="footer" /></div>' },
  NInputNumber: { template: '<input />' },
  NPopover: {
    template: '<div class="n-popover-stub"><slot name="trigger" /><slot /></div>',
  },
  NSlider: {
    props: ['value', 'min', 'max', 'step'],
    emits: ['update:value'],
    template: `
      <input
        class="n-slider-stub"
        type="range"
        :value="value"
        :min="min"
        :max="max"
        :step="step"
        @input="$emit('update:value', Number($event.target.value))"
      />
    `,
  },
  useMessage: () => ({ error: vi.fn(), success: vi.fn(), warning: messageWarningMock }),
  useDialog: () => ({ warning: dialogWarningMock }),
}))

vi.mock('@/api/studio/sessions', () => ({
  fetchContextLength: vi.fn().mockResolvedValue(256000),
  setSessionPushEnabled: setSessionPushEnabledMock,
}))

vi.mock('@/api/hermes/model-context', () => ({
  setModelContext: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/api/studio/social-messages', () => ({
  fetchSocialMessagePlatforms: fetchSocialMessagePlatformsMock,
}))

vi.mock('@/api/hermes/skills', () => ({
  fetchSkills: fetchSkillsMock,
}))

vi.mock('@/api/hermes/skill-bundles', () => ({
  fetchSkillBundles: fetchSkillBundlesMock,
  deleteSkillBundleApi: deleteSkillBundleApiMock,
}))

vi.mock('@/components/hermes/chat/BundleCreateModal.vue', () => ({
  default: {
    name: 'BundleCreateModal',
    props: ['profile'],
    emits: ['close', 'created'],
    template: '<div class="bundle-create-modal">{{ profile }}</div>',
  },
}))

vi.mock('@/composables/useToolTraceVisibility', () => ({
  useToolTraceVisibility: () => ({ toolTraceVisible: { value: true }, toggleToolTraceVisible: vi.fn() }),
}))

function mountForSession(
  sessionId: string,
  sessionOverrides: Partial<ReturnType<typeof useChatStore>['sessions'][number]> = {},
  displayOverrides: Record<string, any> = {},
) {
  const pinia = createTestingPinia({ stubActions: false, createSpy: vi.fn })
  const chatStore = useChatStore()
  const settingsStore = useSettingsStore()
  chatStore.sessions = [
    { id: sessionId, title: sessionId, source: 'cli', messages: [], createdAt: Date.now(), updatedAt: Date.now(), ...sessionOverrides },
  ]
  chatStore.activeSessionId = sessionId
  chatStore.activeSession = chatStore.sessions[0]
  settingsStore.display = displayOverrides
  return mount(ChatInput, { attachTo: document.body, global: { plugins: [pinia] } })
}

/**
 * Switching sessions left the composer unfocused, so the first keystroke after
 * opening a conversation went nowhere (#2249). ChatPanel asks for the focus;
 * the composer decides when taking it is appropriate.
 */
describe('ChatInput focusComposer', () => {
  beforeEach(() => {
    localStorage.clear()
    window.innerWidth = 1024
    fetchSkillsMock.mockReset()
    fetchSkillsMock.mockResolvedValue({ categories: [], archived: [] })
    fetchSkillBundlesMock.mockReset()
    fetchSkillBundlesMock.mockResolvedValue([])
    deleteSkillBundleApiMock.mockReset()
    dialogWarningMock.mockReset()
    setSessionPushEnabledMock.mockReset()
    setSessionPushEnabledMock.mockResolvedValue(true)
    fetchSocialMessagePlatformsMock.mockReset()
    fetchSocialMessagePlatformsMock.mockResolvedValue([
      { id: 'telegram', configured: true, active: true, pushReady: true },
    ])
    messageWarningMock.mockReset()
  })

  it('hides cumulative Coding Agent usage until native context is known', async () => {
    const wrapper = mountForSession('coding-context-unknown', {
      source: 'coding_agent',
      inputTokens: 115_200_000,
      outputTokens: 42_000,
      contextTokens: undefined,
    })
    await flushPromises()

    expect(wrapper.find('.context-usage-row').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('115.2M')
    wrapper.unmount()
  })

  it('shows authoritative Coding Agent context instead of cumulative usage', async () => {
    const wrapper = mountForSession('coding-context-known', {
      source: 'coding_agent',
      inputTokens: 115_200_000,
      outputTokens: 42_000,
      contextTokens: 26_094,
    })
    await flushPromises()

    expect(wrapper.find('.context-usage-row').exists()).toBe(true)
    expect(wrapper.find('.context-info').text()).toContain('26.1k')
    expect(wrapper.find('.context-info').text()).not.toContain('115.2M')
    wrapper.unmount()
  })

  it('puts the caret in the message box on a desktop viewport', async () => {
    const wrapper = mountForSession('session-focus-desktop')
    const textarea = wrapper.find('textarea').element as HTMLTextAreaElement
    textarea.blur()
    expect(document.activeElement).not.toBe(textarea)

    ;(wrapper.vm as any).focusComposer()
    await nextTick()

    expect(document.activeElement).toBe(textarea)
    wrapper.unmount()
  })

  it('leaves focus alone on a phone, where it would raise the keyboard', async () => {
    window.innerWidth = 390
    const wrapper = mountForSession('session-focus-mobile')
    const textarea = wrapper.find('textarea').element as HTMLTextAreaElement
    textarea.blur()

    ;(wrapper.vm as any).focusComposer()
    await nextTick()

    expect(document.activeElement).not.toBe(textarea)
    wrapper.unmount()
  })

  it('shows and toggles the per-session push setting', async () => {
    const wrapper = mountForSession('session-push-setting')
    const option = wrapper.findAll('.dropdown-option').find(button => button.text() === 'chat.pushEnabled')

    expect(option).toBeTruthy()
    await option!.trigger('click')
    await flushPromises()

    expect(setSessionPushEnabledMock).toHaveBeenCalledWith('session-push-setting', true)
    expect(useChatStore().activeSession?.pushEnabled).toBe(true)
    wrapper.unmount()
  })

  it('does not enable push before an active platform and target are configured', async () => {
    fetchSocialMessagePlatformsMock.mockResolvedValueOnce([
      { id: 'telegram', configured: true, active: true, pushReady: false },
    ])
    const wrapper = mountForSession('session-push-unconfigured')
    const option = wrapper.findAll('.dropdown-option').find(button => button.text() === 'chat.pushEnabled')

    await option!.trigger('click')
    await flushPromises()

    expect(messageWarningMock).toHaveBeenCalledWith('chat.pushNotConfigured')
    expect(setSessionPushEnabledMock).not.toHaveBeenCalled()
    expect(useChatStore().activeSession?.pushEnabled).not.toBe(true)
    wrapper.unmount()
  })

  it('allows push to be disabled without checking platform configuration', async () => {
    const wrapper = mountForSession('session-push-disable', { pushEnabled: true })
    const option = wrapper.findAll('.dropdown-option').find(button => button.text() === 'chat.pushEnabled')

    await option!.trigger('click')
    await flushPromises()

    expect(fetchSocialMessagePlatformsMock).not.toHaveBeenCalled()
    expect(setSessionPushEnabledMock).toHaveBeenCalledWith('session-push-disable', false)
    wrapper.unmount()
  })
})
