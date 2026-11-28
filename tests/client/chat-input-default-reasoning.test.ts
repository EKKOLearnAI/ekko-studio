// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { shallowMount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'
import { createI18n } from 'vue-i18n'
import { NSlider } from 'naive-ui'
import zh from '../../packages/client/src/i18n/locales/zh'
import ChatInput from '../../packages/client/src/components/hermes/chat/ChatInput.vue'

const state = vi.hoisted(() => ({
  chat: { activeSession: null, activeSessionId: '', cancelledAttachmentDrafts: new Map(), activeMessageReference: null, isStreaming: false, isAborting: false, runtimeMode: 'scoped', setSessionReasoningEffort: vi.fn() },
  app: { selectedProvider: 'fixture', selectedModel: 'toggle', profileModelGroups: [], modelGroups: [{ provider: 'fixture', model_meta: { toggle: { reasoning: true, reasoning_efforts: ['none'] } } }] },
}))
vi.mock('@/stores/hermes/chat', () => ({ useChatStore: () => state.chat }))
vi.mock('@/stores/hermes/app', () => ({ useAppStore: () => state.app }))
vi.mock('@/stores/hermes/profiles', () => ({ useProfilesStore: () => ({ activeProfileName: 'default' }) }))
vi.mock('@/stores/hermes/settings', () => ({ useSettingsStore: () => ({ display: {} }) }))
vi.mock('@/api/studio/sessions', () => ({ fetchContextLength: vi.fn().mockResolvedValue({}) }))
vi.mock('@/api/hermes/model-context', () => ({ setModelContext: vi.fn().mockResolvedValue({}) }))
vi.mock('@/api/hermes/skills', () => ({ fetchSkills: vi.fn().mockResolvedValue([]) }))
vi.mock('@/api/hermes/skill-bundles', () => ({ fetchSkillBundles: vi.fn().mockResolvedValue([]), deleteSkillBundleApi: vi.fn() }))
vi.mock('@/composables/useComposerVoiceInput', () => ({ useComposerVoiceInput: () => ({ dialogue: { status: ref('idle'), events: ref([]) }, transcript: ref(''), error: ref(null), start: vi.fn(), stop: vi.fn(), cancel: vi.fn() }) }))
vi.mock('naive-ui', async (original) => ({ ...await original<typeof import('naive-ui')>(), useMessage: () => ({}), useDialog: () => ({}) }))

// Render the real trigger and content slots without testing popup positioning.
const slots = defineComponent({ setup(_, { slots }) { return () => h('div', Object.values(slots).flatMap(slot => slot?.() || [])) } })
let wrapper: VueWrapper | undefined
async function render(agent = 'hermes', disabled = false, efforts = ['none']) {
  state.app.modelGroups[0].model_meta.toggle.reasoning_efforts = efforts
  wrapper = shallowMount(ChatInput, {
    props: { draft: true, persistDraft: false, draftConfig: { agent, profile: 'default', provider: 'fixture', model: 'toggle' }, reasoningEffort: '', reasoningEffortDisabled: disabled },
    global: { plugins: [createI18n({ legacy: false, locale: 'zh', messages: { zh } })], stubs: { Popover: slots, Tooltip: slots }, renderStubDefaultSlot: true },
  })
  await flushPromises()
  return wrapper
}
afterEach(() => { wrapper?.unmount(); wrapper = undefined; vi.clearAllMocks() })

it('distinguishes inherited Hermes reasoning from explicit off without changing values', async () => {
  const view = await render()
  expect(view.findAll('.reasoning-effort-slider-range span').map(node => node.text())).toEqual(['默认 (config.yaml)', '无'])
  const slider = view.findComponent(NSlider)
  expect(slider.props()).toMatchObject({ value: 0, min: 0, max: 1, disabled: false })
  expect(view.emitted('update:reasoningEffort')).toBeUndefined()
  slider.vm.$emit('update:value', 1)
  expect(view.emitted('update:reasoningEffort')).toEqual([['none']])
  await view.setProps({ reasoningEffort: 'none' })
  expect(view.find('.reasoning-effort-button').attributes('aria-label')).toContain('无')
  slider.vm.$emit('update:value', 0)
  expect(view.emitted('update:reasoningEffort')).toEqual([['none'], ['']])
  expect(state.chat.setSessionReasoningEffort).not.toHaveBeenCalled()
})

it('keeps the disabled Hermes default and rejects changes', async () => {
  const view = await render('hermes', true)
  expect(view.find('.reasoning-effort-button').attributes('aria-label')).toContain('默认 (config.yaml)')
  const slider = view.findComponent(NSlider)
  expect(slider.props('disabled')).toBe(true)
  slider.vm.$emit('update:value', 1)
  expect(view.emitted('update:reasoningEffort')).toBeUndefined()
})

it('preserves the existing Ekko label policy', async () => {
  const view = await render('ekko')
  expect(view.find('.reasoning-effort-button').attributes('aria-label')).toContain('无')
})

it('keeps active effort levels and their implicit lowest selection unchanged', async () => {
  const view = await render('hermes', false, ['low', 'medium', 'high'])
  const slider = view.findComponent(NSlider)
  expect(slider.props()).toMatchObject({ value: 0, max: 2 })
  expect(view.findAll('.reasoning-effort-slider-range span').map(node => node.text())).toEqual(['低', '高'])
  expect(view.emitted('update:reasoningEffort')).toEqual([['low']])
})
