// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent } from 'vue'

const mockFetchSkills = vi.hoisted(() => vi.fn())
const mockFetchPendingWrites = vi.hoisted(() => vi.fn())
const mockProfilesStore = vi.hoisted(() => ({
  activeProfileName: 'default',
  profiles: [{ name: 'default' }],
  fetchProfiles: vi.fn(),
}))

vi.mock('@/api/hermes/skills', () => ({
  fetchSkills: mockFetchSkills,
}))

vi.mock('@/api/hermes/write-gate', () => ({
  fetchPendingWrites: mockFetchPendingWrites,
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
  NBadge: defineComponent({
    props: ['value', 'max', 'show'],
    template: '<span class="n-badge-stub"><slot /></span>',
  }),
  NButton: defineComponent({
    emits: ['click'],
    template: '<button class="n-button-stub" type="button" @click="$emit(\'click\')"><slot name="icon" /><slot /></button>',
  }),
  NDrawer: defineComponent({
    props: ['show'],
    template: '<div v-if="show" class="n-drawer-stub"><slot /></div>',
  }),
  NDrawerContent: defineComponent({
    props: ['title', 'closable'],
    template: '<section class="n-drawer-content-stub"><slot /></section>',
  }),
  NInput: defineComponent({
    props: ['value', 'placeholder', 'size', 'clearable'],
    emits: ['update:value'],
    template: '<input class="n-input-stub" :value="value" @input="$emit(\'update:value\', $event.target.value)" />',
  }),
  NSelect: defineComponent({
    props: ['value', 'options', 'size'],
    emits: ['update:value'],
    template: '<select class="n-select-stub" :value="value" @change="$emit(\'update:value\', $event.target.value)"><option v-for="option in options" :key="option.value" :value="option.value">{{ option.label }}</option></select>',
  }),
}))

import SkillsView from '@/views/hermes/SkillsView.vue'

describe('SkillsView', () => {
  it.each(['codex', 'pi', 'grok', 'opencode', 'dsh', 'claude', 'cursor'] as const)('shows shared skills without edit controls for %s', async target => {
    mockFetchSkills.mockResolvedValue({ categories: [{ name: 'misc', description: '', skills: [
      { name: 'shared', description: 'Shared', source: 'local', readonly: true },
    ] }], archived: [] })
    const wrapper = mount(SkillsView, {
      props: { target },
      global: { stubs: {
        SkillList: true, SkillDetail: defineComponent({ props: ['readonly'], template: '<article class="detail" :data-readonly="readonly" />' }),
        SkillImportModal: true, SkillExternalDirsModal: true, PendingWriteApprovals: true,
      } },
    })
    await flushPromises()
    expect(wrapper.get('.detail').attributes('data-readonly')).toBe('true')
    wrapper.unmount()
  })
  beforeEach(() => {
    vi.clearAllMocks()
    mockProfilesStore.activeProfileName = 'default'
    mockProfilesStore.profiles = [{ name: 'default' }]
    mockFetchPendingWrites.mockResolvedValue({ supported: true, records: [] })
    vi.stubGlobal('fetch', vi.fn())
    window.matchMedia = vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })
  })

  it('defaults to the first skill instead of loading recommendations', async () => {
    mockFetchSkills.mockResolvedValue({
      categories: [
        {
          name: 'alpha',
          description: '',
          skills: [
            { name: 'first-skill', description: 'First skill' },
            { name: 'second-skill', description: 'Second skill' },
          ],
        },
        {
          name: 'beta',
          description: '',
          skills: [{ name: 'third-skill', description: 'Third skill' }],
        },
      ],
      archived: [],
    })

    const wrapper = mount(SkillsView, {
      global: {
        stubs: {
          SkillList: defineComponent({
            props: ['categories', 'selectedSkill'],
            emits: ['select', 'deleted'],
            template: '<aside class="skill-list-stub" :data-selected="selectedSkill"></aside>',
          }),
          SkillDetail: defineComponent({
            props: ['category', 'skill', 'skillName'],
            template: '<article class="skill-detail-stub" :data-category="category" :data-skill="skill">{{ skillName }}</article>',
          }),
          SkillImportModal: true,
          SkillExternalDirsModal: true,
          PendingWriteApprovals: true,
        },
      },
    })

    await flushPromises()

    const detail = wrapper.get('.skill-detail-stub')
    expect(detail.attributes('data-category')).toBe('alpha')
    expect(detail.attributes('data-skill')).toBe('first-skill')
    expect(detail.text()).toBe('first-skill')
    expect(wrapper.get('.skill-list-stub').attributes('data-selected')).toBe('alpha/first-skill')
    expect(wrapper.find('.n-select-stub').exists()).toBe(false)
    expect(mockFetchSkills).toHaveBeenCalledWith(undefined, 'hermes')
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })
})
