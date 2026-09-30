// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent } from 'vue'
import SkillDetail from '@/components/hermes/skills/SkillDetail.vue'

const mockFetchSkillContent = vi.hoisted(() => vi.fn())
const mockFetchSkillFiles = vi.hoisted(() => vi.fn())
const mockSaveSkillContent = vi.hoisted(() => vi.fn())
const mockPinSkillApi = vi.hoisted(() => vi.fn())
const mockMessage = vi.hoisted(() => ({
  success: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
}))

vi.mock('@/api/hermes/skills', () => ({
  fetchSkillContent: mockFetchSkillContent,
  fetchSkillFiles: mockFetchSkillFiles,
  saveSkillContent: mockSaveSkillContent,
  pinSkillApi: mockPinSkillApi,
}))

vi.mock('@/components/hermes/chat/MarkdownRenderer.vue', () => ({
  default: defineComponent({
    props: ['content'],
    template: '<div class="markdown-renderer-stub">{{ content }}</div>',
  }),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('naive-ui', () => ({
  NSpin: defineComponent({ template: '<div><slot name="icon" /></div>' }),
  useMessage: () => mockMessage,
}))

describe('SkillDetail editing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('saves edited skill content for the selected target', async () => {
    mockFetchSkillContent.mockResolvedValue('# Demo Skill\ninitial\n')
    mockFetchSkillFiles.mockResolvedValue([])
    mockSaveSkillContent.mockResolvedValue(undefined)

    const wrapper = mount(SkillDetail, {
      props: {
        category: 'misc',
        skill: 'demo-skill',
        skillName: 'demo-skill',
        target: 'codex',
        readonly: false,
        canPin: false,
      },
    })
    await flushPromises()

    await wrapper.get('.detail-action').trigger('click')
    const editor = wrapper.get('textarea.skill-editor')
    await editor.setValue('# Demo Skill\nupdated\n')
    await wrapper.findAll('.detail-action')[0].trigger('click')
    await flushPromises()

    expect(mockSaveSkillContent).toHaveBeenCalledWith(
      'misc',
      'demo-skill',
      '# Demo Skill\nupdated\n',
      'codex',
    )
    expect(wrapper.find('.markdown-renderer-stub').text()).toContain('updated')
  })

  it('does not show editing controls when readonly', async () => {
    mockFetchSkillContent.mockResolvedValue('# Builtin Skill\n')
    mockFetchSkillFiles.mockResolvedValue([])

    const wrapper = mount(SkillDetail, {
      props: {
        category: 'misc',
        skill: 'builtin-skill',
        skillName: 'builtin-skill',
        target: 'codex',
        readonly: true,
        canPin: false,
      },
    })
    await flushPromises()

    expect(wrapper.find('textarea.skill-editor').exists()).toBe(false)
    expect(wrapper.findAll('.detail-action')).toHaveLength(0)
  })
})
