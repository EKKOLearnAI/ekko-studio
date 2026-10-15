// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent } from 'vue'

const mockProfilesStore = vi.hoisted(() => ({
  activeProfileName: 'default',
  profiles: [
    { name: 'default', alias: '' },
    { name: 'work', alias: '' },
  ],
  fetchProfiles: vi.fn(),
}))

vi.mock('@/stores/hermes/profiles', () => ({
  useProfilesStore: () => mockProfilesStore,
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('naive-ui', () => ({
  NSelect: defineComponent({
    props: ['value', 'options', 'size', 'status'],
    emits: ['update:value'],
    template: `<select class="n-select-stub" :data-status="status" :value="value" @change="$emit('update:value', $event.target.value)"><option v-for="option in options" :key="option.value" :value="option.value">{{ option.label }}</option></select>`,
  }),
  NTooltip: defineComponent({
    template: '<div class="n-tooltip-stub"><slot name="trigger" /><slot /></div>',
  }),
}))

import ProfileScopeSelect from '@/components/common/ProfileScopeSelect.vue'

describe('ProfileScopeSelect', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockProfilesStore.activeProfileName = 'default'
    mockProfilesStore.profiles = [
      { name: 'default', alias: '' },
      { name: 'work', alias: '' },
    ]
  })

  it('renders profile options and defaults the shown value to the active profile', () => {
    const wrapper = mount(ProfileScopeSelect, { props: { modelValue: null } })
    const select = wrapper.get('.n-select-stub')
    expect((select.element as HTMLSelectElement).value).toBe('default')
    expect(wrapper.findAll('option').map(option => option.text())).toEqual(['default', 'work'])
  })

  it('emits the profile name when picking a non-active profile and null when picking the active one', async () => {
    const wrapper = mount(ProfileScopeSelect, { props: { modelValue: null } })

    await wrapper.get('.n-select-stub').setValue('work')
    expect(wrapper.emitted('update:modelValue')).toEqual([['work']])

    await wrapper.setProps({ modelValue: 'work' })
    await wrapper.get('.n-select-stub').setValue('default')
    expect(wrapper.emitted('update:modelValue')).toEqual([['work'], [null]])
  })

  it('marks the selector as warning while managing a different profile', () => {
    const following = mount(ProfileScopeSelect, { props: { modelValue: null } })
    expect(following.get('.n-select-stub').attributes('data-status')).toBeUndefined()

    const differing = mount(ProfileScopeSelect, { props: { modelValue: 'work' } })
    expect(differing.get('.n-select-stub').attributes('data-status')).toBe('warning')
  })

  it('stays hidden while only one profile exists', () => {
    mockProfilesStore.profiles = [{ name: 'default', alias: '' }]
    const wrapper = mount(ProfileScopeSelect, { props: { modelValue: null } })
    expect(wrapper.find('.n-select-stub').exists()).toBe(false)
  })
})
