// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import type { UserThemeSettings } from '@/api/studio/theme'

const api = vi.hoisted(() => ({
  fetchThemePresets: vi.fn(), createThemePreset: vi.fn(), renameThemePreset: vi.fn(), activateThemePreset: vi.fn(), deleteThemePreset: vi.fn(),
  updateThemeSettings: vi.fn(), fetchThemeSettings: vi.fn(), fetchThemeBackgroundBlob: vi.fn(),
  clearThemeBackgroundCache: vi.fn(), deleteThemeBackground: vi.fn(), uploadThemeBackground: vi.fn(),
  importThemeArchive: vi.fn(), exportThemeArchive: vi.fn(),
}))
vi.mock('@/api/studio/theme', () => api)
const defaults: UserThemeSettings = { fontSize: 14, textColor: null, accentColor: null, appearance: { global: {}, regions: {} }, background: null, updatedAt: 0 }
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

describe('theme preview and persistence ordering', () => {
  beforeEach(() => {
    vi.resetModules(); vi.clearAllMocks(); localStorage.clear()
    vi.spyOn(window, 'matchMedia').mockImplementation(query => ({ matches: false, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() } as unknown as MediaQueryList))
    document.documentElement.className = ''
    document.documentElement.removeAttribute('style')
  })
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it('serializes saves and never replaces a newer live preview with an older response', async () => {
    const first = deferred<UserThemeSettings>(), second = deferred<UserThemeSettings>()
    api.updateThemeSettings.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const theme = (await import('@/composables/useTheme')).useTheme()
    theme.activateUserTheme(1, defaults)
    const save1 = theme.saveThemeCustomization({ fontSize: 16 })
    const save2 = theme.saveThemeCustomization({ fontSize: 18 })
    await flushPromises()
    expect(api.updateThemeSettings).toHaveBeenCalledTimes(1)
    expect(theme.fontSize.value).toBe(18)
    first.resolve({ ...defaults, fontSize: 16 })
    await save1; await flushPromises()
    expect(api.updateThemeSettings).toHaveBeenCalledTimes(2)
    expect(theme.fontSize.value).toBe(18)
    theme.previewThemeSettings({ fontSize: 20 })
    second.resolve({ ...defaults, fontSize: 18 })
    await save2
    expect(theme.fontSize.value).toBe(20)
    expect(JSON.parse(localStorage.getItem('hermes_theme_customization_v1:1')!).fontSize).toBe(18)
  })

  it('rolls a failed last save back to the last committed appearance and clears stale CSS', async () => {
    api.updateThemeSettings.mockRejectedValueOnce(new Error('offline'))
    const theme = (await import('@/composables/useTheme')).useTheme()
    theme.activateUserTheme(1, defaults)
    const saving = theme.saveThemeCustomization({ appearance: { global: { opacity: 0.2, radius: 22, chatWidth: 600 }, regions: {} } })
    expect(document.documentElement.style.getPropertyValue('--theme-card-radius')).toBe('22px')
    expect(document.documentElement.classList.contains('theme-chat-width')).toBe(true)
    await expect(saving).rejects.toThrow('offline')
    expect(theme.appearance.value).toEqual({ global: {}, regions: {} })
    expect(document.documentElement.style.getPropertyValue('--theme-card-radius')).toBe('')
    expect(document.documentElement.classList.contains('theme-card-bg')).toBe(false)
    expect(document.documentElement.classList.contains('theme-chat-width')).toBe(false)
    expect(document.documentElement.style.getPropertyValue('--chat-max-width')).toBe('')
  })

  it('ignores the previous account response after switching accounts', async () => {
    const request = deferred<UserThemeSettings>()
    api.updateThemeSettings.mockReturnValueOnce(request.promise)
    const theme = (await import('@/composables/useTheme')).useTheme()
    theme.activateUserTheme(1, defaults)
    const saving = theme.saveThemeCustomization({ fontSize: 20 })
    await flushPromises()
    theme.activateUserTheme(2, { ...defaults, fontSize: 12 })
    request.resolve({ ...defaults, fontSize: 20 })
    await saving
    expect(theme.fontSize.value).toBe(12)
    expect(JSON.parse(localStorage.getItem('hermes_theme_customization_v1:2')!).fontSize).toBe(12)
  })

  it('keeps the wallpaper URL stable across appearance saves and preserves a preview during upload', async () => {
    vi.stubGlobal('URL', class extends URL {
      static createObjectURL = vi.fn(() => 'blob:theme-test')
      static revokeObjectURL = vi.fn()
    })
    const background = { name: 'wall.png', mime: 'image/png', updatedAt: 10 }
    api.fetchThemeBackgroundBlob.mockResolvedValue(new Blob(['image'], { type: 'image/png' }))
    api.updateThemeSettings.mockResolvedValue({ ...defaults, fontSize: 16, background })
    const theme = (await import('@/composables/useTheme')).useTheme()
    theme.activateUserTheme(1, { ...defaults, background })
    await flushPromises()
    await theme.saveThemeCustomization({ fontSize: 16 })
    expect(api.fetchThemeBackgroundBlob).toHaveBeenCalledTimes(1)
    const upload = deferred<UserThemeSettings>()
    api.uploadThemeBackground.mockReturnValueOnce(upload.promise)
    const uploading = theme.uploadBackground(new File(['image'], 'new.png'))
    await flushPromises()
    theme.previewThemeSettings({ fontSize: 20 })
    upload.resolve({ ...defaults, fontSize: 16, background: { ...background, updatedAt: 20 } })
    await uploading
    expect(theme.fontSize.value).toBe(20)
    expect(api.fetchThemeBackgroundBlob).toHaveBeenCalledTimes(2)
    expect(JSON.parse(localStorage.getItem('hermes_theme_customization_v1:1')!).fontSize).toBe(16)
  })

  it('waits for saves before switching and restores modes and regional settings together', async () => {
    const pendingSave = deferred<UserThemeSettings>()
    api.updateThemeSettings.mockReturnValueOnce(pendingSave.promise)
    const next = { ...defaults, activePresetId: 'night', brightness: 'dark' as const, style: 'comic' as const, appearance: { global: { radius: 4 }, regions: {} } }
    api.activateThemePreset.mockResolvedValue({ activeId: 'night', themes: [{ ...next, id: 'night', name: 'Night' }], theme: next })
    const theme = (await import('@/composables/useTheme')).useTheme()
    theme.activateUserTheme(1, { ...defaults, activePresetId: 'day' })
    const saving = theme.saveThemeCustomization({ fontSize: 18 })
    const switching = theme.switchPreset('night')
    await flushPromises()
    expect(api.activateThemePreset).not.toHaveBeenCalled()
    expect(theme.presetBusy.value).toBe(true)
    await expect(theme.saveThemeCustomization({ fontSize: 20 })).rejects.toThrow(/in progress/)
    pendingSave.resolve({ ...defaults, activePresetId: 'day', fontSize: 18 })
    await saving; await switching
    expect(api.updateThemeSettings).toHaveBeenCalledWith(expect.objectContaining({ presetId: 'day', fontSize: 18 }))
    expect(theme.activePresetId.value).toBe('night')
    expect(theme.fontSize.value).toBe(14)
    expect(theme.brightness.value).toBe('dark')
    expect(theme.style.value).toBe('comic')
    expect(document.documentElement.style.getPropertyValue('--theme-card-radius')).toBe('4px')
    expect(localStorage.getItem('hermes_brightness')).toBe('dark')
    expect(theme.presetBusy.value).toBe(false)
  })

  it('restores a legacy device brightness preference when its first server save fails', async () => {
    api.updateThemeSettings.mockRejectedValueOnce(new Error('offline'))
    localStorage.setItem('hermes_brightness', 'light')
    const theme = (await import('@/composables/useTheme')).useTheme()
    theme.activateUserTheme(1, defaults)
    const saving = theme.setBrightness('dark')
    expect(theme.isDark.value).toBe(true)
    await expect(saving).rejects.toThrow('offline')
    expect(theme.brightness.value).toBe('light')
    expect(theme.isDark.value).toBe(false)
    expect(localStorage.getItem('hermes_brightness')).toBe('light')
  })

  it('keeps legacy device mode changes authoritative until preferences are saved to a theme', async () => {
    localStorage.setItem('hermes_api_key', `header.${btoa(JSON.stringify({ sub: 1 }))}.signature`)
    localStorage.setItem('hermes_brightness', 'light')
    const theme = (await import('@/composables/useTheme')).useTheme()
    theme.activateUserTheme(1, defaults)
    expect(JSON.parse(localStorage.getItem('hermes_theme_customization_v1:1')!).brightness).toBeUndefined()
    localStorage.setItem('hermes_brightness', 'dark')
    localStorage.setItem('hermes_style', 'comic')
    vi.resetModules()
    const reloaded = (await import('@/composables/useTheme')).useTheme()
    expect(reloaded.isDark.value).toBe(true)
    expect(reloaded.isComic.value).toBe(true)
    reloaded.activateUserTheme(1, { ...defaults, brightness: 'light', style: 'ink' })
    expect(reloaded.isDark.value).toBe(false)
    expect(reloaded.isComic.value).toBe(false)
  })

  it('keeps the current theme if switching fails and ignores a previous account library response', async () => {
    const theme = (await import('@/composables/useTheme')).useTheme()
    theme.activateUserTheme(1, { ...defaults, activePresetId: 'day', fontSize: 16 })
    api.activateThemePreset.mockRejectedValueOnce(new Error('offline'))
    await expect(theme.switchPreset('night')).rejects.toThrow('offline')
    expect(theme.activePresetId.value).toBe('day')
    expect(theme.fontSize.value).toBe(16)
    expect(theme.presetBusy.value).toBe(false)
    const request = deferred<any>()
    api.fetchThemePresets.mockReturnValueOnce(request.promise)
    const loading = theme.loadThemePresets()
    await flushPromises()
    theme.activateUserTheme(2, { ...defaults, activePresetId: 'other' })
    request.resolve({ activeId: 'day', themes: [{ ...defaults, id: 'day', name: 'Old account' }] })
    await loading
    expect(theme.activePresetId.value).toBe('other')
    expect(theme.themePresets.value).toEqual([])
  })

  it('ignores a stale initial fetch after a local preview', async () => {
    const request = deferred<UserThemeSettings>()
    api.fetchThemeSettings.mockReturnValueOnce(request.promise)
    const theme = (await import('@/composables/useTheme')).useTheme()
    theme.activateUserTheme(1, defaults)
    const loading = theme.syncThemeFromServer()
    theme.previewThemeSettings({ fontSize: 20 })
    request.resolve(defaults)
    await loading
    expect(theme.fontSize.value).toBe(20)
  })

  it('waits for pending edits before export and blocks theme changes while creating the ZIP', async () => {
    const pendingSave = deferred<UserThemeSettings>()
    const pendingExport = deferred<Blob>()
    api.updateThemeSettings.mockReturnValueOnce(pendingSave.promise)
    api.exportThemeArchive.mockReturnValueOnce(pendingExport.promise)
    const theme = (await import('@/composables/useTheme')).useTheme()
    theme.activateUserTheme(1, { ...defaults, activePresetId: 'day', brightness: 'dark', style: 'comic' })
    const saving = theme.saveThemeCustomization({ fontSize: 18 })
    const exporting = theme.exportPreset('day')
    await flushPromises()
    expect(api.exportThemeArchive).not.toHaveBeenCalled()
    await expect(theme.switchPreset('night')).rejects.toThrow(/in progress/)
    pendingSave.resolve({ ...defaults, activePresetId: 'day', fontSize: 18, brightness: 'dark', style: 'comic' })
    await saving; await flushPromises()
    expect(api.exportThemeArchive).toHaveBeenCalledWith('day', { brightness: 'dark', style: 'comic' })
    const blob = new Blob(['zip'])
    pendingExport.resolve(blob)
    expect(await exporting).toBe(blob)
    expect(theme.presetBusy.value).toBe(false)
    expect(theme.activePresetId.value).toBe('day')
  })

  it('does not export stale settings after a failed pending save or across account changes', async () => {
    const pendingSave = deferred<UserThemeSettings>()
    api.updateThemeSettings.mockReturnValueOnce(pendingSave.promise)
    const theme = (await import('@/composables/useTheme')).useTheme()
    theme.activateUserTheme(1, { ...defaults, activePresetId: 'day' })
    const saving = theme.saveThemeCustomization({ fontSize: 18 })
    const exporting = theme.exportPreset('day')
    const saveFailure = expect(saving).rejects.toThrow('offline')
    const exportFailure = expect(exporting).rejects.toThrow('offline')
    pendingSave.reject(new Error('offline'))
    await saveFailure; await exportFailure
    expect(api.exportThemeArchive).not.toHaveBeenCalled()
    const request = deferred<Blob>()
    api.exportThemeArchive.mockReturnValueOnce(request.promise)
    const next = theme.exportPreset('day')
    await flushPromises()
    theme.activateUserTheme(2, { ...defaults, activePresetId: 'other' })
    const accountFailure = expect(next).rejects.toThrow('account changed')
    request.resolve(new Blob(['old account ZIP']))
    await accountFailure
    expect(theme.activePresetId.value).toBe('other')
  })

  it('imports through the library queue and retains the current theme on failure', async () => {
    const theme = (await import('@/composables/useTheme')).useTheme()
    theme.activateUserTheme(1, { ...defaults, activePresetId: 'day', brightness: 'light', style: 'ink' })
    const file = new File(['zip'], 'theme.zip')
    api.importThemeArchive.mockRejectedValueOnce(new Error('invalid archive'))
    await expect(theme.importPreset(file)).rejects.toThrow('invalid archive')
    expect(theme.activePresetId.value).toBe('day')
    const blob = new Blob(['zip'])
    api.exportThemeArchive.mockResolvedValueOnce(blob)
    expect(await theme.exportPreset('day')).toBe(blob)
    const imported = { ...defaults, activePresetId: 'imported', brightness: 'dark' as const, style: 'comic' as const, fontSize: 18 }
    api.importThemeArchive.mockResolvedValueOnce({ activeId: 'imported', theme: imported, themes: [{ ...imported, id: 'imported', name: 'Night' }] })
    await theme.importPreset(file)
    expect(api.importThemeArchive).toHaveBeenLastCalledWith(file, { brightness: 'light', style: 'ink' })
    expect(theme.activePresetId.value).toBe('imported')
    expect(theme.isDark.value).toBe(true)
    expect(theme.fontSize.value).toBe(18)
    expect(theme.presetBusy.value).toBe(false)
  })

  it('allows export retries after a failed download', async () => {
    const theme = (await import('@/composables/useTheme')).useTheme()
    theme.activateUserTheme(1, { ...defaults, activePresetId: 'day' })
    api.exportThemeArchive.mockRejectedValueOnce(new Error('offline'))
    await expect(theme.exportPreset('day')).rejects.toThrow('offline')
    expect(theme.presetBusy.value).toBe(false)
    const blob = new Blob(['zip'])
    api.exportThemeArchive.mockResolvedValueOnce(blob)
    expect(await theme.exportPreset('day')).toBe(blob)
    expect(api.exportThemeArchive).toHaveBeenCalledTimes(2)
  })
})
