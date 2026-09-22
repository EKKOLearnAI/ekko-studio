// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'

const mockMessage = vi.hoisted(() => ({
  warning: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}))

const mockProfilesStore = vi.hoisted(() => ({
  activeProfileName: 'work',
  profiles: [
    { name: 'default', active: false },
    { name: 'work', active: true },
    { name: 'lab', active: false },
  ],
  createProfile: vi.fn(),
}))

vi.mock('@/stores/hermes/profiles', () => ({
  useProfilesStore: () => mockProfilesStore,
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => (
      params ? `${key}:${JSON.stringify(params)}` : key
    ),
  }),
}))

vi.mock('naive-ui', () => ({
  NModal: defineComponent({
    template: '<div class="n-modal-stub"><slot /><slot name="footer" /></div>',
  }),
  NForm: defineComponent({ template: '<form><slot /></form>' }),
  NFormItem: defineComponent({ template: '<div><slot /></div>' }),
  NText: defineComponent({ template: '<span><slot /></span>' }),
  NSwitch: defineComponent({
    props: { value: { type: Boolean, default: false } },
    emits: ['update:value'],
    template: '<input class="n-switch-stub" type="checkbox" :checked="value" @change="$emit(\'update:value\', $event.target.checked)" />',
  }),
  // naive-ui's NInput emits both `update:value` and `input` with the string value
  NInput: defineComponent({
    props: { value: { type: String, required: false } },
    emits: ['update:value', 'input'],
    template: '<input class="n-input-stub" :value="value" @input="$emit(\'update:value\', $event.target.value); $emit(\'input\', $event.target.value)" />',
  }),
  NSelect: defineComponent({
    props: {
      value: { required: false },
      options: { type: Array, default: () => [] },
    },
    emits: ['update:value'],
    template: '<select class="n-select-stub" @change="$emit(\'update:value\', $event.target.value)"><option v-for="option in options" :key="option.value" :value="option.value">{{ option.label }}</option></select>',
  }),
  NButton: defineComponent({
    emits: ['click'],
    template: '<button class="n-button-stub" @click.prevent="$emit(\'click\')"><slot /></button>',
  }),
  useMessage: () => mockMessage,
}))

import ProfileCreateModal from '@/components/hermes/profiles/ProfileCreateModal.vue'

async function openWithClone() {
  const wrapper = mount(ProfileCreateModal)
  await wrapper.find('.n-input-stub').setValue('cloned')
  await wrapper.find('.n-switch-stub').setValue(true)
  await flushPromises()
  return wrapper
}

describe('ProfileCreateModal clone source', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockProfilesStore.createProfile.mockResolvedValue({ success: true })
  })

  it('offers every profile as a clone source and marks the active one', async () => {
    const wrapper = await openWithClone()

    const options = wrapper.find('.n-select-stub').findAll('option')
    expect(options.map(option => option.attributes('value'))).toEqual(['default', 'work', 'lab'])
    expect(options[1].text()).toContain('cloneSourceCurrent')
  })

  it('defaults to the active profile, matching the old clone-from-current behaviour', async () => {
    const wrapper = await openWithClone()

    await wrapper.findAll('.n-button-stub')[1].trigger('click')
    await flushPromises()

    expect(mockProfilesStore.createProfile).toHaveBeenCalledWith('cloned', 'work')
  })

  it('clones from the profile the user picks', async () => {
    const wrapper = await openWithClone()

    await wrapper.find('.n-select-stub').setValue('lab')
    await wrapper.findAll('.n-button-stub')[1].trigger('click')
    await flushPromises()

    expect(mockProfilesStore.createProfile).toHaveBeenCalledWith('cloned', 'lab')
  })

  it('creates an empty profile when cloning is off', async () => {
    const wrapper = mount(ProfileCreateModal)
    await wrapper.find('.n-input-stub').setValue('fresh')

    expect(wrapper.find('.n-select-stub').exists()).toBe(false)

    await wrapper.findAll('.n-button-stub')[1].trigger('click')
    await flushPromises()

    expect(mockProfilesStore.createProfile).toHaveBeenCalledWith('fresh', null)
  })
})
