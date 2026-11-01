// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent } from 'vue'
import SessionListItem from '@/components/hermes/chat/SessionListItem.vue'

vi.mock('@/stores/hermes/app', () => ({
  useAppStore: () => ({
    profileModelGroups: [],
  }),
}))

vi.mock('@/stores/hermes/profiles', () => ({
  useProfilesStore: () => ({ profiles: [] }),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('@/shared/session-display', () => ({
  formatTimestampMs: () => 'now',
}))

vi.mock('naive-ui', () => ({
  NPopconfirm: defineComponent({
    name: 'NPopconfirm',
    emits: ['positive-click'],
    template: '<span><slot name="trigger" /><slot /></span>',
  }),
  NCheckbox: defineComponent({
    name: 'NCheckbox',
    props: ['checked'],
    emits: ['click'],
    template: '<input type="checkbox" :checked="checked" @click="$emit(\'click\')" />',
  }),
  NTooltip: defineComponent({
    name: 'NTooltip',
    template: '<span><slot name="trigger" /><slot /></span>',
  }),
}))

const session = {
  id: 's1',
  title: 'Session One',
  model: 'gpt-test',
  provider: 'openai',
  createdAt: Date.now(),
  profile: 'kira',
}

describe('SessionListItem', () => {
  describe('touch actions', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    function mountRow() {
      return mount(SessionListItem, {
        props: { session, active: false, pinned: false, canDelete: false, to: '/session/s1' },
        global: { stubs: { ProfileAvatar: true } },
      })
    }

    it('opens actions after a long press and suppresses the resulting click', async () => {
      const wrapper = mountRow()
      const row = wrapper.get('a.session-item')
      await row.trigger('touchstart', { touches: [{ clientX: 120, clientY: 180 }] })
      vi.advanceTimersByTime(499)
      expect(wrapper.emitted('contextmenu')).toBeUndefined()
      vi.advanceTimersByTime(1)
      expect(wrapper.emitted('contextmenu')).toHaveLength(1)
      expect(wrapper.emitted('contextmenu')![0][0]).toMatchObject({ clientX: 120, clientY: 180 })
      const release = new Event('touchend', { cancelable: true })
      row.element.dispatchEvent(release)
      expect(release.defaultPrevented).toBe(true)
      await row.trigger('click')
      expect(wrapper.emitted('select')).toBeUndefined()
      wrapper.unmount()
    })

    it.each(['touchend', 'touchmove', 'touchcancel'])('cancels pending actions on %s', async event => {
      const wrapper = mountRow()
      const row = wrapper.get('a.session-item')
      await row.trigger('touchstart', { touches: [{ clientX: 120, clientY: 180 }] })
      vi.advanceTimersByTime(200)
      await row.trigger(event)
      vi.advanceTimersByTime(500)
      expect(wrapper.emitted('contextmenu')).toBeUndefined()
      if (event === 'touchend') {
        await row.trigger('click')
        expect(wrapper.emitted('select')).toHaveLength(1)
      }
      wrapper.unmount()
    })
  })

  it('renders normal mode as a link and allows hiding its timestamp', async () => {
    const wrapper = mount(SessionListItem, {
      props: {
        session,
        active: false,
        pinned: false,
        canDelete: true,
        to: '/session/s1',
      },
      global: {
        stubs: {
          ProfileAvatar: true,
        },
      },
    })

    const link = wrapper.get('a.session-item')
    expect(link.attributes('href')).toBe('/session/s1')
    expect(wrapper.find('button.session-item').exists()).toBe(false)
    expect(wrapper.get('.session-item-delete').attributes('aria-label')).toBe('common.delete Session One')
    expect(wrapper.get('.session-item-time').text()).toBe('now')

    await wrapper.setProps({ showTime: false })
    expect(wrapper.find('.session-item-time').exists()).toBe(false)
    expect(wrapper.get('.session-item-title').text()).toBe(session.title)
    expect(link.attributes('href')).toBe('/session/s1')

    await wrapper.setProps({ showTime: true })
    expect(wrapper.get('.session-item-time').text()).toBe('now')
  })

  it('renders selectable mode as a button and does not expose row href', () => {
    const wrapper = mount(SessionListItem, {
      props: {
        session,
        active: false,
        pinned: false,
        canDelete: true,
        selectable: true,
        selected: false,
        to: '/session/s1',
      },
      global: {
        stubs: {
          ProfileAvatar: true,
        },
      },
    })

    expect(wrapper.find('button.session-item').exists()).toBe(true)
    expect(wrapper.find('a.session-item').exists()).toBe(false)
  })

  it('renders a plain text category tag only when a category label is provided', async () => {
    const wrapper = mount(SessionListItem, {
      props: {
        session,
        active: false,
        pinned: false,
        canDelete: true,
        categoryLabel: 'Work - Mobile',
      },
      global: {
        stubs: {
          ProfileAvatar: true,
        },
      },
    })

    const tag = wrapper.get('.session-item-category-tag')
    expect(tag.text()).toBe('Work - Mobile')
    expect(tag.attributes('title')).toBe('Work - Mobile')
    expect(tag.element.tagName).toBe('SPAN')

    await wrapper.setProps({ categoryLabel: undefined })
    expect(wrapper.find('.session-item-category-tag').exists()).toBe(false)
  })

  it('does not select the row when clicking nested action controls', async () => {
    const wrapper = mount(SessionListItem, {
      props: {
        session,
        active: false,
        pinned: false,
        canDelete: true,
        to: '/session/s1',
      },
      global: {
        stubs: {
          ProfileAvatar: true,
        },
      },
    })

    await wrapper.get('button.session-item-delete').trigger('click')
    expect(wrapper.emitted('select')).toBeUndefined()
  })

  it('does not hijack modified clicks on normal links', async () => {
    const wrapper = mount(SessionListItem, {
      props: {
        session,
        active: false,
        pinned: false,
        canDelete: true,
        to: '/session/s1',
      },
      global: {
        stubs: {
          ProfileAvatar: true,
        },
      },
    })

    const link = wrapper.get('a.session-item')
    link.element.addEventListener('click', event => event.preventDefault())
    await link.trigger('click', { ctrlKey: true })
    expect(wrapper.emitted('select')).toBeUndefined()
    expect(wrapper.emitted('open-new')).toBeUndefined()
  })

  it('renders the Hermes logo for Hermes sessions', () => {
    const wrapper = mount(SessionListItem, {
      props: {
        session: { ...session, source: 'cli', agent: 'hermes' },
        active: false,
        pinned: false,
        canDelete: true,
      },
      global: {
        stubs: {
          ProfileAvatar: true,
        },
      },
    })

    const logo = wrapper.get('.session-item-agent-logo')
    expect(logo.attributes('src')).toBe('/coding-agents/hermes.png')
    expect(logo.attributes('alt')).toBe('Hermes')
    expect(wrapper.find('.session-item-agent-name').exists()).toBe(false)
  })

  it('renders the Hermes logo for Hermes Global Agent sessions', () => {
    const wrapper = mount(SessionListItem, {
      props: {
        session: { ...session, source: 'global_agent', agent: 'hermes' },
        active: false,
        pinned: false,
        canDelete: true,
      },
      global: {
        stubs: {
          ProfileAvatar: true,
        },
      },
    })

    const logo = wrapper.get('.session-item-agent-logo')
    expect(logo.attributes('src')).toBe('/coding-agents/hermes.png')
    expect(logo.attributes('alt')).toBe('Hermes')
  })

  it('renders the Ekko logo for Ekko Global Agent sessions', () => {
    const wrapper = mount(SessionListItem, {
      props: {
        session: {
          ...session,
          source: 'global_agent',
          agent: 'ekko-agent',
          codingAgentId: 'ekko-agent',
        },
        active: false,
        pinned: false,
        canDelete: true,
      },
      global: {
        stubs: {
          ProfileAvatar: true,
        },
      },
    })

    const logo = wrapper.get('.session-item-agent-logo')
    expect(logo.attributes('src')).toBe('/coding-agents/ekko-agent.png')
    expect(logo.attributes('alt')).toBe('Ekko')
  })

  it('defaults old sessions without agent metadata to the Hermes logo', () => {
    const wrapper = mount(SessionListItem, {
      props: {
        session: { ...session, source: undefined, agent: undefined, codingAgentId: undefined },
        active: false,
        pinned: false,
        canDelete: true,
      },
      global: {
        stubs: {
          ProfileAvatar: true,
        },
      },
    })

    const logo = wrapper.get('.session-item-agent-logo')
    expect(logo.attributes('src')).toBe('/coding-agents/hermes.png')
    expect(logo.attributes('alt')).toBe('Hermes')
    expect(wrapper.find('.session-item-agent-name').exists()).toBe(false)
  })

  it('renders the Claude logo for Claude coding agent sessions', () => {
    const wrapper = mount(SessionListItem, {
      props: {
        session: { ...session, source: 'coding_agent', agent: 'claude', codingAgentId: 'claude-code' },
        active: false,
        pinned: false,
        canDelete: true,
      },
      global: {
        stubs: {
          ProfileAvatar: true,
        },
      },
    })

    const logo = wrapper.get('.session-item-agent-logo')
    expect(logo.attributes('src')).toBe('/coding-agents/claude-code.svg')
    expect(logo.attributes('alt')).toBe('Claude')
    expect(wrapper.find('.session-item-agent-name').exists()).toBe(false)
  })

  it('renders the Codex logo for Codex coding agent sessions', () => {
    const wrapper = mount(SessionListItem, {
      props: {
        session: { ...session, source: 'coding_agent', agent: 'codex', codingAgentId: 'codex' },
        active: false,
        pinned: false,
        canDelete: true,
      },
      global: {
        stubs: {
          ProfileAvatar: true,
        },
      },
    })

    const logo = wrapper.get('.session-item-agent-logo')
    expect(logo.attributes('src')).toBe('/coding-agents/codex-openai.png')
    expect(logo.attributes('alt')).toBe('Codex')
    expect(wrapper.find('.session-item-agent-name').exists()).toBe(false)
  })
})
