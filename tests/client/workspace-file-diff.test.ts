// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent } from 'vue'

const workspaceMocks = vi.hoisted(() => ({
  fetchSessionWorkspaceFileDiff: vi.fn(),
  downloadSessionWorkspaceFile: vi.fn(),
  readSessionWorkspaceFile: vi.fn(),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('naive-ui', () => ({
  NAlert: defineComponent({ template: '<div><slot /></div>' }),
  NButton: defineComponent({
    inheritAttrs: false,
    template: '<button type="button" v-bind="$attrs"><slot name="icon" /><slot /></button>',
  }),
  NSpin: defineComponent({ template: '<div class="spin" />' }),
  NTooltip: defineComponent({ template: '<span><slot name="trigger" /><span class="tooltip"><slot /></span></span>' }),
  useMessage: () => ({ success: vi.fn(), error: vi.fn() }),
}))

vi.mock('@/api/studio/sessions', async importOriginal => {
  const actual = await importOriginal<typeof import('@/api/studio/sessions')>()
  return {
    ...actual,
    fetchSessionWorkspaceFileDiff: workspaceMocks.fetchSessionWorkspaceFileDiff,
    downloadSessionWorkspaceFile: workspaceMocks.downloadSessionWorkspaceFile,
    readSessionWorkspaceFile: workspaceMocks.readSessionWorkspaceFile,
  }
})

import WorkspaceFileDiff from '@/components/hermes/files/WorkspaceFileDiff.vue'

const markdownEntry = {
  name: 'notes.md',
  path: 'notes.md',
  isDir: false,
  size: 64,
  modTime: '2026-09-05T00:00:00.000Z',
}

describe('WorkspaceFileDiff', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    workspaceMocks.fetchSessionWorkspaceFileDiff.mockResolvedValue({
      patch: '',
      additions: 0,
      deletions: 0,
      binary: false,
      truncated: false,
    })
    workspaceMocks.readSessionWorkspaceFile.mockResolvedValue({
      path: markdownEntry.path,
      content: '# Rendered heading\n\nThis is **bold** text.\n',
    })
  })

  it('renders unchanged markdown workspace files instead of showing raw source', async () => {
    const wrapper = mount(WorkspaceFileDiff, {
      props: {
        entry: markdownEntry,
        workspace: '/tmp/workspace',
        workspaceSessionId: 'session-1',
      },
    })

    await flushPromises()
    await vi.waitFor(() => {
      expect(
        wrapper.find('.workspace-markdown-preview .markdown-body h1').exists(),
        wrapper.html(),
      ).toBe(true)
    })

    expect(wrapper.find('.workspace-markdown-preview .markdown-body h1').text()).toBe('Rendered heading')
    expect(wrapper.find('.workspace-markdown-preview strong').text()).toBe('bold')
    expect(wrapper.find('.file-code').exists()).toBe(false)
  })

  it('uses accessible icon-only controls for editing and closing the preview', async () => {
    const wrapper = mount(WorkspaceFileDiff, {
      props: {
        entry: markdownEntry,
        workspace: '/tmp/workspace',
        workspaceSessionId: 'session-1',
      },
    })

    await flushPromises()

    const editButton = wrapper.get('button[aria-label="common.edit"]')
    const closeButton = wrapper.get('button[aria-label="files.closePreview"]')
    expect(editButton.text()).toBe('')
    expect(closeButton.text()).toBe('')
    expect(editButton.find('svg[data-icon="edit"]').exists()).toBe(true)
    expect(closeButton.find('svg[data-icon="close"]').exists()).toBe(true)
  })
  it('offers a scoped download in the HTML Diff toolbar', async () => {
    const wrapper = mount(WorkspaceFileDiff, { props: { entry: { ...markdownEntry, name: 'page.html', path: 'page.html' }, workspaceSessionId: 'session-1' } })
    await flushPromises()
    await wrapper.get('button[aria-label="files.download"]').trigger('click'); await flushPromises()
    expect(workspaceMocks.downloadSessionWorkspaceFile).toHaveBeenCalledWith('session-1', 'page.html', 'page.html')
  })

})
