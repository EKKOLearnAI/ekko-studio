// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
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
    messageWarningMock.mockReset()
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

  it('keeps voice and tool settings without exposing the per-session push setting', () => {
    const wrapper = mountForSession('session-push-setting', { pushEnabled: true })
    const options = wrapper.findAll('.dropdown-option').map(button => button.text())

    expect(options).toContain('realtimeVoice.mode')
    expect(options).toContain('chat.showToolCalls')
    expect(options).not.toContain('chat.pushEnabled')
    expect(setSessionPushEnabledMock).not.toHaveBeenCalled()
    expect(useChatStore().activeSession?.pushEnabled).toBe(true)
    wrapper.unmount()
  })
})
