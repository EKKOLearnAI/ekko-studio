// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

const routeState = vi.hoisted(() => ({
  query: {
    profile: 'reviewer',
    file: 'config.yaml',
  } as Record<string, unknown>,
}))

const routerPush = vi.hoisted(() => vi.fn())

const mockFilesStore = vi.hoisted(() => ({
  currentPath: '',
  editingFile: null as null | Record<string, unknown>,
  previewFile: null as null | Record<string, unknown>,
  hasUnsavedChanges: false,
  fetchEntries: vi.fn(async () => {}),
  openEditor: vi.fn(async () => {}),
  closeEditor: vi.fn(),
}))

const mockProfilesStore = vi.hoisted(() => ({
  activeProfileName: null as string | null,
  profiles: [] as Array<{ name: string }>,
  fetchProfiles: vi.fn(async () => {}),
}))

vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-router')>()
  return {
    ...actual,
    useRoute: () => routeState,
    useRouter: () => ({ push: routerPush }),
  }
})

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('naive-ui', () => ({
  NSpin: { template: '<div><slot /><slot name="icon" /></div>' },
  useDialog: () => ({ warning: vi.fn() }),
}))

vi.mock('@/stores/hermes/files', () => ({
  useFilesStore: () => mockFilesStore,
}))

vi.mock('@/stores/hermes/profiles', () => ({
  useProfilesStore: () => mockProfilesStore,
}))

vi.mock('@/components/hermes/files/FileTree.vue', () => ({ default: { name: 'FileTreeStub', props: ['profile'], template: '<div class="FileTree-stub" />' } }))
vi.mock('@/components/hermes/files/FileBreadcrumb.vue', () => ({ default: { name: 'FileBreadcrumbStub', template: '<div class="FileBreadcrumb-stub" />' } }))
vi.mock('@/components/hermes/files/FileToolbar.vue', () => ({ default: { name: 'FileToolbarStub', template: '<div class="FileToolbar-stub" />' } }))
vi.mock('@/components/hermes/files/FileList.vue', () => ({ default: { name: 'FileListStub', template: '<div class="FileList-stub" />' } }))
vi.mock('@/components/hermes/files/FileContextMenu.vue', () => ({ default: { name: 'FileContextMenuStub', template: '<div class="FileContextMenu-stub" />' } }))
vi.mock('@/components/hermes/files/FileEditor.vue', () => ({ default: { name: 'FileEditorStub', props: ['customClose'], template: '<button class="FileEditor-stub" type="button" @click="customClose?.()" />' } }))
vi.mock('@/components/hermes/files/FilePreview.vue', () => ({ default: { name: 'FilePreviewStub', template: '<div class="FilePreview-stub" />' } }))
vi.mock('@/components/hermes/files/FileUploadModal.vue', () => ({ default: { name: 'FileUploadModalStub', template: '<div class="FileUploadModal-stub" />' } }))
vi.mock('@/components/hermes/files/FileRenameModal.vue', () => ({ default: { name: 'FileRenameModalStub', template: '<div class="FileRenameModal-stub" />' } }))

import FilesView from '@/views/hermes/FilesView.vue'

describe('FilesView scoped config route handling', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    routeState.query = { profile: 'reviewer', file: 'config.yaml' }
    mockProfilesStore.activeProfileName = null
    mockProfilesStore.profiles = []
    mockFilesStore.currentPath = ''
    mockFilesStore.editingFile = null
    mockFilesStore.previewFile = null
    mockFilesStore.hasUnsavedChanges = false
  })

  it('opens config.yaml in a focused profile config editor', async () => {
    const wrapper = mount(FilesView)
    await flushPromises()

    expect(mockProfilesStore.fetchProfiles).toHaveBeenCalledOnce()
    expect(mockFilesStore.fetchEntries).not.toHaveBeenCalled()
    expect(mockFilesStore.openEditor).toHaveBeenCalledWith('config.yaml', { profile: 'reviewer' })
    expect(wrapper.find('.files-tree-panel').exists()).toBe(false)
    expect(wrapper.find('.FileList-stub').exists()).toBe(false)
    expect(wrapper.find('.profile-config-editor-header').exists()).toBe(true)
    expect(wrapper.find('.profile-config-close').exists()).toBe(false)
  })

  it('wires the editor close action back to profiles', async () => {
    mockFilesStore.editingFile = { path: 'config.yaml' }
    const wrapper = mount(FilesView)
    await flushPromises()

    await wrapper.get('.FileEditor-stub').trigger('click')

    expect(mockFilesStore.closeEditor).toHaveBeenCalledOnce()
    expect(routerPush).toHaveBeenCalledWith({ name: 'hermes.profiles' })
  })
})
