// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent } from 'vue'
import ChatToolsPanel from '@/components/hermes/chat/ChatToolsPanel.vue'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => ({
    'drawer.files': 'Workspace', 'drawer.terminal': 'Terminal', 'browser.title': 'Browser',
  } as Record<string, string>)[key] || key }),
}))
vi.mock('@/components/hermes/chat/FilesPanel.vue', () => ({
  __esModule: true,
  default: defineComponent({
    name: 'FilesPanel',
    props: ['workspaceSessionId', 'workspace'],
    emits: ['attach'],
    template: '<section>Workspace files</section>',
  }),
}))
vi.mock('@/components/hermes/chat/TerminalPanel.vue', () => ({
  __esModule: true,
  default: defineComponent({
    name: 'TerminalPanel', props: ['visible'], template: '<section>Terminal session</section>',
  }),
}))
vi.mock('@/components/hermes/chat/DesktopBrowserPanel.vue', () => ({
  __esModule: true,
  default: defineComponent({
    name: 'DesktopBrowserPanel', props: ['visible', 'submit'], template: '<section>Browser session</section>',
  }),
}))

const wrappers: ReturnType<typeof mount>[] = []
afterEach(() => { for (const wrapper of wrappers.splice(0)) wrapper.unmount() })

async function mountPanel(browserAvailable = false) {
  const submit = vi.fn().mockResolvedValue(true)
  const wrapper = mount(ChatToolsPanel, {
    props: {
      workspaceSessionId: 'person-task-test', workspace: '/tmp/task',
      visible: true, browserVisible: true, browserAvailable, submit,
    },
  })
  wrappers.push(wrapper)
  await flushPromises()
  return { wrapper, submit }
}

describe('shared chat tools panel', () => {
  it('offers workspace and terminal without a browser bridge and forwards workspace attachments', async () => {
    const { wrapper } = await mountPanel()
    expect(wrapper.findAll('[role="tab"]').map(tab => tab.attributes('aria-label'))).toEqual(['Workspace', 'Terminal'])
    expect(wrapper.get('[aria-label="Workspace"]').attributes('aria-selected')).toBe('true')
    expect(wrapper.findComponent({ name: 'DesktopBrowserPanel' }).exists()).toBe(false)
    const files = wrapper.getComponent({ name: 'FilesPanel' })
    expect(files.props()).toMatchObject({ workspaceSessionId: 'person-task-test', workspace: '/tmp/task' })
    const file = new File(['notes'], 'notes.txt', { type: 'text/plain' })
    files.vm.$emit('attach', file)
    expect(wrapper.emitted('attach')).toEqual([[file]])
  })

  it('keeps the terminal mounted while updating its visibility across tab changes', async () => {
    const { wrapper } = await mountPanel()
    const terminal = wrapper.getComponent({ name: 'TerminalPanel' })
    expect(terminal.props('visible')).toBe(false)
    await wrapper.get('[aria-label="Terminal"]').trigger('click')
    expect(wrapper.get('[aria-label="Terminal"]').attributes('aria-selected')).toBe('true')
    expect(terminal.props('visible')).toBe(true)
    await wrapper.get('[aria-label="Workspace"]').trigger('click')
    expect(terminal.props('visible')).toBe(false)
    expect(wrapper.getComponent({ name: 'TerminalPanel' }).vm).toBe(terminal.vm)
    await wrapper.setProps({ activePanel: 'terminal', visible: false })
    expect(terminal.props('visible')).toBe(false)
  })

  it('mounts the browser on selection, forwards submissions and follows viewport readiness', async () => {
    const { wrapper, submit } = await mountPanel(true)
    expect(wrapper.findAll('[role="tab"]').map(tab => tab.attributes('aria-label'))).toEqual(['Workspace', 'Terminal', 'Browser'])
    expect(wrapper.findComponent({ name: 'DesktopBrowserPanel' }).exists()).toBe(false)
    await wrapper.get('[aria-label="Browser"]').trigger('click')
    await flushPromises()
    const browser = wrapper.getComponent({ name: 'DesktopBrowserPanel' })
    expect(wrapper.get('[aria-label="Browser"]').attributes('aria-selected')).toBe('true')
    expect(browser.props('visible')).toBe(true)
    const submission = { file: new File(['image'], 'selection.png', { type: 'image/png' }), context: '{"browser_selection":{}}' }
    await expect(browser.props('submit')(submission)).resolves.toBe(true)
    expect(submit).toHaveBeenCalledWith(submission)
    await wrapper.setProps({ browserVisible: false })
    expect(browser.props('visible')).toBe(false)
    await wrapper.get('[aria-label="Workspace"]').trigger('click')
    expect(wrapper.findComponent({ name: 'DesktopBrowserPanel' }).exists()).toBe(false)
  })
})
