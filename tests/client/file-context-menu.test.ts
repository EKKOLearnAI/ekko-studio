// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { FileEntry } from '@/api/studio/files'

const mockMessage = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
}))

const mockDialog = vi.hoisted(() => ({
  warning: vi.fn(),
}))

const downloadSessionMock = vi.hoisted(() => vi.fn())
const downloadGroupMock = vi.hoisted(() => vi.fn())
vi.mock('@/api/studio/sessions', () => ({ downloadSessionWorkspaceFile: downloadSessionMock }))
vi.mock('@/api/studio/group-chat', () => ({ downloadGroupWorkspaceFile: downloadGroupMock }))
const downloadFileMock = vi.hoisted(() => vi.fn())
const copyToClipboardMock = vi.hoisted(() => vi.fn())

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('naive-ui', async () => {
  const { defineComponent, h } = await import('vue')

  return {
    NDropdown: defineComponent({
      name: 'NDropdown',
      props: {
        show: { type: Boolean, default: false },
        options: { type: Array, default: () => [] },
      },
      emits: ['select', 'clickoutside'],
      setup(props, { emit }) {
        return () => h('div', { 'data-show': props.show ? 'true' : 'false' },
          (props.options as Array<any>).map(option => h(
            'button',
            {
              type: 'button',
              'data-key': option.key,
              onClick: () => emit('select', option.key),
            },
            option.label ?? option.type ?? option.key,
          )),
        )
      },
    }),
    useMessage: () => mockMessage,
    useDialog: () => mockDialog,
  }
})

vi.mock('@/api/studio/download', () => ({
  downloadFile: downloadFileMock,
}))

vi.mock('@/utils/clipboard', () => ({
  copyToClipboard: copyToClipboardMock,
}))

vi.mock('@/utils/file-path', () => ({
  getClipboardPathForEntry: (entry: FileEntry) => entry.path,
}))

import FileContextMenu from '@/components/hermes/files/FileContextMenu.vue'
import { useFilesStore } from '@/stores/hermes/files'

describe('FileContextMenu', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  async function showMenu(wrapper: ReturnType<typeof mount>, entry: FileEntry) {
    ;(wrapper.vm as any).show(new MouseEvent('contextmenu', { clientX: 12, clientY: 34 }), entry)
    await flushPromises()
  }

  it('offers both edit and preview for previewable text files', async () => {
    const wrapper = mount(FileContextMenu)
    const entry: FileEntry = {
      name: 'Dockerfile',
      path: 'Dockerfile',
      isDir: false,
      size: 42,
      modTime: '2026-06-02T00:00:00.000Z',
    }

    await showMenu(wrapper, entry)

    const keys = wrapper.findAll('[data-key]').map(node => node.attributes('data-key'))
    expect(keys).toContain('edit')
    expect(keys).toContain('preview')
    expect(keys).toContain('download')
  })

  it('invokes the store preview action from the preview menu item', async () => {
    const store = useFilesStore()
    const openPreviewSpy = vi.spyOn(store, 'openPreview').mockResolvedValue(undefined)
    const wrapper = mount(FileContextMenu)
    const entry: FileEntry = {
      name: 'README',
      path: 'README',
      isDir: false,
      size: 12,
      modTime: '2026-06-02T00:00:00.000Z',
    }

    await showMenu(wrapper, entry)
    await wrapper.get('[data-key="preview"]').trigger('click')
    await flushPromises()

    expect(openPreviewSpy).toHaveBeenCalledWith(entry)
    expect(mockMessage.error).not.toHaveBeenCalled()
  })

  it('does not offer preview for non-previewable binary files', async () => {
    const wrapper = mount(FileContextMenu)
    const entry: FileEntry = {
      name: 'archive.zip',
      path: 'archive.zip',
      isDir: false,
      size: 128,
      modTime: '2026-06-02T00:00:00.000Z',
    }

    await showMenu(wrapper, entry)

    const keys = wrapper.findAll('[data-key]').map(node => node.attributes('data-key'))
    expect(keys).not.toContain('preview')
    expect(keys).not.toContain('edit')
    expect(keys).toContain('download')
  })

  it('offers workspace files as chat attachments only when enabled', async () => {
    const entry: FileEntry = {
      name: 'report.pdf',
      path: 'reports/report.pdf',
      isDir: false,
      size: 128,
      modTime: '2026-06-02T00:00:00.000Z',
    }
    const regularWrapper = mount(FileContextMenu)
    await showMenu(regularWrapper, entry)
    expect(regularWrapper.find('[data-key="attach"]').exists()).toBe(false)

    const workspaceWrapper = mount(FileContextMenu, { props: { allowAttach: true } })
    await showMenu(workspaceWrapper, entry)
    await workspaceWrapper.get('[data-key="attach"]').trigger('click')

    expect(workspaceWrapper.emitted('attach')).toEqual([[entry]])
  })
  it.each(['session', 'group'] as const)('downloads %s workspace files with the authorized scoped API', async scope => {
    const store = useFilesStore()
    if (scope === 'group') store.currentWorkspaceRoomId = 'room-1'
    else store.currentWorkspaceSessionId = 'session-1'
    const wrapper = mount(FileContextMenu)
    const entry = { name: 'page.html', path: 'tools/page.html', isDir: false, size: 10, modTime: '' }
    await showMenu(wrapper, entry)
    await wrapper.get('[data-key="download"]').trigger('click'); await flushPromises()
    expect(scope === 'group' ? downloadGroupMock : downloadSessionMock).toHaveBeenCalledWith(scope === 'group' ? 'room-1' : 'session-1', entry.path, entry.name)
    expect(downloadFileMock).not.toHaveBeenCalled()
  })

})
