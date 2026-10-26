// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { ref, nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import type { ThemeCustomization } from '@/styles/theme-customization'

const mocks = vi.hoisted(() => ({
  theme: vi.fn(), updateOptions: vi.fn(), defineTheme: vi.fn(), setTheme: vi.fn(), create: vi.fn(), dispose: vi.fn(),
}))
vi.mock('@/composables/useTheme', () => ({ useTheme: mocks.theme }))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('naive-ui', () => ({
  NButton: { template: '<button><slot /></button>' }, NSpace: { template: '<div><slot /></div>' },
  useMessage: () => ({ success: vi.fn(), error: vi.fn() }), useDialog: () => ({ warning: vi.fn() }),
}))
vi.mock('@/stores/hermes/files', () => ({ useFilesStore: () => ({ editingFile: { content: 'const draft = 1', language: 'typescript', path: 'draft.ts' } }) }))
vi.mock('monaco-editor', () => ({ editor: { create: mocks.create, defineTheme: mocks.defineTheme, setTheme: mocks.setTheme }, KeyMod: { CtrlCmd: 1 }, KeyCode: { KeyS: 2 } }))
import FileEditor from '@/components/hermes/files/FileEditor.vue'

describe('Monaco live Studio theme', () => {
  it('updates the existing editor without replacing its model or text', async () => {
    const isDark = ref(false)
    const customization = ref<ThemeCustomization>({ fontSize: 14, textColor: null, accentColor: null })
    mocks.theme.mockReturnValue({ isDark, customization })
    mocks.create.mockReturnValue({ updateOptions: mocks.updateOptions, onDidChangeModelContent: vi.fn(), addCommand: vi.fn(), dispose: mocks.dispose })
    const wrapper = mount(FileEditor)
    expect(mocks.create).toHaveBeenCalledWith(expect.any(HTMLElement), expect.objectContaining({ value: 'const draft = 1' }))
    isDark.value = true
    customization.value = { fontSize: 20, textColor: '#abcdef', accentColor: '#ff6600', appearance: { global: { backgroundColor: '#102030' }, regions: { content: { opacity: 0.5 } } } }
    await nextTick()
    expect(mocks.defineTheme).toHaveBeenLastCalledWith('studio', expect.objectContaining({ base: 'vs-dark', colors: expect.objectContaining({ 'editor.background': '#10203080', 'editor.foreground': '#abcdef' }) }))
    expect(mocks.updateOptions).toHaveBeenLastCalledWith(expect.objectContaining({ fontSize: 20 * 13 / 14 }))
    expect(mocks.create).toHaveBeenCalledTimes(1)
    wrapper.unmount()
    expect(mocks.dispose).toHaveBeenCalledTimes(1)
  })
})
