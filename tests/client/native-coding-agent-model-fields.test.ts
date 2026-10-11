// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, mount } from '@vue/test-utils'
import { afterEach } from 'vitest'
import { shallowRef, ref } from 'vue'
import NativeCodingAgentModelFields from '@/components/hermes/models/NativeCodingAgentModelFields.vue'

enableAutoUnmount(afterEach)
const catalog = shallowRef<any>()
const onChange = vi.fn()
vi.mock('@/composables/useCodingAgentModels', () => ({ useCodingAgentModels: () => ({ catalog, loading: ref(false), refreshFailed: ref(false), reload: vi.fn() }) }))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key, te: () => true }) }))
vi.mock('naive-ui', () => ({
  NButton: { template: '<button><slot /></button>' },
  NSelect: { name: 'NSelect', props: ['value', 'options', 'disabled'], emits: ['update:value'], template: '<button class="effort" :disabled="disabled">{{ value }}</button>' },
}))
vi.mock('@/components/hermes/models/ModelCascader.vue', () => ({ default: {
  name: 'ModelCascader', props: ['model', 'groups', 'displayName'], emits: ['select'],
  template: '<div><slot name="trigger" :show="false" :open="() => {}" :openWithKeyboard="() => {}" /><slot name="footer" /></div>',
} }))
function setup(disabled = false, field: 'model' | 'reasoning-effort' = 'reasoning-effort') {
  return mount(NativeCodingAgentModelFields, { props: { agent: 'cursor', model: 'gemini-high', reasoningEffort: 'high', disabled, field, onChange } })
}
beforeEach(() => {
  onChange.mockClear()
  catalog.value = { name: 'Cursor', status: 'ready', models: ['low', 'high'].map(effort => ({
    id: `gemini-${effort}`, name: `Gemini (${effort})`, modelFamily: 'gemini', modelFamilyName: 'Gemini', reasoningEffort: effort, reasoningEfforts: ['low', 'high'],
  })) }
})
describe('native model fields shared by group chat and workflow', () => {
  it('shows one family and changes strength together with the real native model ID', () => {
    const model = setup(false, 'model')
    const effort = setup()
    expect(model.get('.native-model-trigger').text()).toBe('Gemini')
    expect(model.findComponent({ name: 'ModelCascader' }).props('groups')[0].models).toEqual(['', 'gemini-low'])
    expect(model.findComponent({ name: 'NSelect' }).exists()).toBe(false)
    expect(effort.findComponent({ name: 'ModelCascader' }).exists()).toBe(false)
    effort.findComponent({ name: 'NSelect' }).vm.$emit('update:value', 'low')
    expect(onChange.mock.calls).toEqual([[{ model: 'gemini-low', reasoningEffort: 'low' }]])
  })
  it('retains strength when selecting the same family and clears it for agent defaults', () => {
    const wrapper = setup(false, 'model')
    wrapper.findComponent({ name: 'ModelCascader' }).vm.$emit('select', { model: 'gemini-low' })
    wrapper.findComponent({ name: 'ModelCascader' }).vm.$emit('select', { model: '' })
    expect(onChange.mock.calls).toEqual([[{ model: 'gemini-high', reasoningEffort: 'high' }], [{ model: '', reasoningEffort: '' }]])
  })
  it('preserves saved values when discovery is unavailable', async () => {
    const wrapper = setup()
    catalog.value = undefined
    await wrapper.vm.$nextTick()
    expect(wrapper.get('.effort').text()).toBe('high')
    expect(wrapper.get('.effort').attributes('disabled')).toBeDefined()
    expect(onChange.mock.calls).toEqual([])
  })
  it('keeps a fixed native variant read-only', async () => {
    const wrapper = setup()
    catalog.value = { models: [catalog.value.models[1]], status: 'ready' }
    catalog.value.models[0].reasoningEfforts = ['high']
    await wrapper.vm.$nextTick()
    expect(wrapper.get('.effort').attributes('disabled')).toBeDefined()
  })
  it('blocks edits in a workflow run snapshot', () => {
    const model = setup(true, 'model')
    const effort = setup(true)
    model.findComponent({ name: 'ModelCascader' }).vm.$emit('select', { model: 'gemini-low' })
    effort.findComponent({ name: 'NSelect' }).vm.$emit('update:value', 'low')
    expect(onChange.mock.calls).toEqual([])
  })
})
