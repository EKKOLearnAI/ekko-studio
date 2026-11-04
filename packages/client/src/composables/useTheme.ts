import { normalizeThemeAppearance, resolveAppearance, THEME_REGIONS } from '@/styles/theme-appearance'
import { computed, ref, watch } from 'vue'
import {
  fetchThemePresets, createThemePreset, renameThemePreset, activateThemePreset, deleteThemePreset,
  importThemeArchive, exportThemeArchive,
  type ThemePreset, type ThemeLibrary, type ThemeLibraryChange,
  clearThemeBackgroundCache,
  deleteThemeBackground as deleteThemeBackgroundApi,
  fetchThemeBackgroundBlob,
  fetchThemeSettings,
  updateThemeSettings,
  uploadThemeBackground as uploadThemeBackgroundApi,
  type UserThemeSettings,
} from '@/api/studio/theme'
import {
  DEFAULT_THEME_FONT_SIZE,
  normalizeHexColor,
  normalizeThemeCustomization,
  normalizeThemeFontSize,
  resolveThemeCustomization,
  type ThemeCustomization,
} from '@/styles/theme-customization'

export type BrightnessMode = 'light' | 'dark' | 'system'
export type ThemeStyle = 'ink' | 'comic'

const BRIGHTNESS_KEY = 'hermes_brightness'
const STYLE_KEY = 'hermes_style'
const AUTH_TOKEN_KEY = 'hermes_api_key'
const CUSTOM_THEME_CACHE_PREFIX = 'hermes_theme_customization_v1'

const DEFAULT_SERVER_THEME: UserThemeSettings = {
  fontSize: DEFAULT_THEME_FONT_SIZE,
  textColor: null,
  accentColor: null,
  appearance: normalizeThemeAppearance(null),
  background: null,
  updatedAt: 0,
}

function storedUserId(): number | null {
  const token = localStorage.getItem(AUTH_TOKEN_KEY) || ''
  const payload = token.split('.')[1]
  if (!payload) return null
  try {
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
    const parsed = JSON.parse(atob(padded)) as { sub?: unknown }
    const userId = Number(parsed.sub)
    return Number.isInteger(userId) && userId > 0 ? userId : null
  } catch {
    return null
  }
}

function cacheKey(userId: number): string {
  return `${CUSTOM_THEME_CACHE_PREFIX}:${userId}`
}

function normalizeServerTheme(value: unknown): UserThemeSettings {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const customization = normalizeThemeCustomization(record)
  const rawBackground = record.background && typeof record.background === 'object'
    ? record.background as Record<string, unknown>
    : null
  const backgroundUpdatedAt = Number(rawBackground?.updatedAt)
  const background = rawBackground && Number.isFinite(backgroundUpdatedAt) && backgroundUpdatedAt > 0
    ? {
        name: typeof rawBackground.name === 'string' ? rawBackground.name : 'background',
        mime: typeof rawBackground.mime === 'string' ? rawBackground.mime : null,
        updatedAt: backgroundUpdatedAt,
      }
    : null

  return {
    ...customization,
    ...(typeof record.activePresetId === 'string' ? { activePresetId: record.activePresetId } : {}),
    ...(['system', 'light', 'dark'].includes(String(record.brightness)) ? { brightness: record.brightness as BrightnessMode } : {}),
    ...(['ink', 'comic'].includes(String(record.style)) ? { style: record.style as ThemeStyle } : {}),
    appearance: normalizeThemeAppearance(record.appearance),
    background,
    updatedAt: Number.isFinite(Number(record.updatedAt)) ? Number(record.updatedAt) : 0,
  }
}

function loadCachedTheme(userId: number | null): UserThemeSettings {
  if (!userId) return { ...DEFAULT_SERVER_THEME }
  try {
    const raw = localStorage.getItem(cacheKey(userId))
    return raw ? normalizeServerTheme(JSON.parse(raw)) : { ...DEFAULT_SERVER_THEME }
  } catch {
    return { ...DEFAULT_SERVER_THEME }
  }
}

const brightness = ref<BrightnessMode>(
  (localStorage.getItem(BRIGHTNESS_KEY) as BrightnessMode) || 'system',
)
// Keep this in sync with the pre-render theme in index.html.
const style = ref<ThemeStyle>(localStorage.getItem(STYLE_KEY) === 'comic' ? 'comic' : 'ink')
const isDark = ref(false)
const isComic = ref(false)
const activeUserId = ref<number | null>(storedUserId())
const serverTheme = ref<UserThemeSettings>(loadCachedTheme(activeUserId.value))
const themePresets = ref<ThemePreset[]>([])
const presetBusy = ref(false)
let committedTheme = serverTheme.value
let committedBrightness = serverTheme.value.brightness || brightness.value
let committedStyle = serverTheme.value.style || style.value
const backgroundImageUrl = ref<string | null>(null)
const backgroundImageName = computed(() => serverTheme.value.background?.name || '')
const hasBackgroundImage = computed(() => !!backgroundImageUrl.value)
const hasCustomBackground = computed(() => hasBackgroundImage.value || !!serverTheme.value.appearance?.global.gradientColor)
let backgroundObjectUrl: string | null = null
let backgroundLoadGeneration = 0
let loadedBackgroundKey = ''
let appearanceProperties: string[] = ['--bg-primary', '--text-primary']
let previewRevision = 0
let saveQueue: Promise<void> = Promise.resolve()
let pendingThemeWrite: Promise<void> | null = null

function trackThemeWrite(task: Promise<void>): Promise<void> {
  pendingThemeWrite = task
  const clear = () => { if (pendingThemeWrite === task) pendingThemeWrite = null }
  void task.then(clear, clear)
  return task
}

const customization = computed<ThemeCustomization>(() => ({
  fontSize: serverTheme.value.fontSize,
  textColor: serverTheme.value.textColor,
  accentColor: serverTheme.value.accentColor,
  appearance: serverTheme.value.appearance,
}))
const resolvedAppearance = computed(() => resolveAppearance(customization.value, isDark.value, isComic.value))

function resolveDark(mode: BrightnessMode): boolean {
  if (mode === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  }
  return mode === 'dark'
}

function setOrRemoveStyle(name: string, value: string | undefined) {
  if (value) document.documentElement.style.setProperty(name, value)
  else document.documentElement.style.removeProperty(name)
}

function applyCustomization() {
  for (const name of appearanceProperties) document.documentElement.style.removeProperty(name)
  const resolved = resolveThemeCustomization(customization.value, isDark.value)
  const root = document.documentElement
  root.style.setProperty('--font-size-base', `${resolved.fontSize}px`)
  setOrRemoveStyle('--text-primary', resolved.textPrimary)
  setOrRemoveStyle('--text-secondary', resolved.textSecondary)
  setOrRemoveStyle('--text-muted', resolved.textMuted)
  setOrRemoveStyle('--text-primary-rgb', resolved.textPrimaryRgb)
  setOrRemoveStyle('--text-secondary-rgb', resolved.textSecondaryRgb)
  setOrRemoveStyle('--text-muted-rgb', resolved.textMutedRgb)
  setOrRemoveStyle('--accent-primary', resolved.accentPrimary)
  setOrRemoveStyle('--accent-hover', resolved.accentHover)
  setOrRemoveStyle('--accent-muted', resolved.accentMuted)
  setOrRemoveStyle('--accent-primary-rgb', resolved.accentPrimaryRgb)
  setOrRemoveStyle('--accent-hover-rgb', resolved.accentHoverRgb)
  setOrRemoveStyle('--text-on-accent', resolved.textOnAccent)
  const appearance = resolvedAppearance.value
  appearanceProperties = Object.keys(appearance.variables)
  for (const [name, value] of Object.entries(appearance.variables)) root.style.setProperty(name, value)
  root.classList.toggle('theme-customized', Object.keys(appearance.appearance.global).length > 0 || Object.keys(appearance.appearance.regions).length > 0)
  root.classList.toggle('theme-custom-background-color', !!appearance.appearance.global.backgroundColor)
  root.classList.toggle('theme-chat-width', appearance.appearance.global.chatWidth !== undefined)
  for (const region of THEME_REGIONS) {
    for (const property of ['bg', 'filter', 'radius', 'border', 'shadow']) {
      root.classList.toggle(`theme-${region}-${property}`, appearance.variables[`--theme-${region}-${property}`] !== undefined)
    }
  }
  root.style.setProperty('--font-scale', String(resolved.fontSize / 14))
  document.dispatchEvent(new CustomEvent('studio-theme-change'))
}

function applyClasses() {
  const dark = resolveDark(brightness.value)
  isDark.value = dark
  isComic.value = style.value === 'comic'
  document.documentElement.classList.toggle('dark', dark)
  document.documentElement.classList.toggle('comic', isComic.value)
  applyCustomization()
}

function persistThemeCache(settings = serverTheme.value) {
  if (!activeUserId.value) return
  localStorage.setItem(cacheKey(activeUserId.value), JSON.stringify(settings))
}

function revokeBackgroundObjectUrl() {
  if (backgroundObjectUrl && typeof URL.revokeObjectURL === 'function') {
    URL.revokeObjectURL(backgroundObjectUrl)
  }
  backgroundObjectUrl = null
}

function clearBackgroundVisual() {
  backgroundLoadGeneration += 1
  revokeBackgroundObjectUrl()
  backgroundImageUrl.value = null
  loadedBackgroundKey = ''
  document.documentElement.style.removeProperty('--app-background-image')
}

async function loadBackground(refresh = false) {
  const userId = activeUserId.value
  const background = serverTheme.value.background
  if (!userId || !background) {
    clearBackgroundVisual()
    return
  }

  const key = `${userId}:${background.updatedAt}`
  if (!refresh && loadedBackgroundKey === key && backgroundImageUrl.value) return
  if (loadedBackgroundKey !== key) clearBackgroundVisual()
  const generation = ++backgroundLoadGeneration
  try {
    const blob = await fetchThemeBackgroundBlob(userId, background.updatedAt, refresh, serverTheme.value.activePresetId)
    if (
      generation !== backgroundLoadGeneration ||
      userId !== activeUserId.value ||
      background.updatedAt !== serverTheme.value.background?.updatedAt ||
      typeof URL.createObjectURL !== 'function'
    ) return
    const url = URL.createObjectURL(blob)
    revokeBackgroundObjectUrl()
    backgroundObjectUrl = url
    backgroundImageUrl.value = url
    loadedBackgroundKey = key
    document.documentElement.style.setProperty('--app-background-image', `url("${url}")`)
  } catch {
    if (generation === backgroundLoadGeneration) clearBackgroundVisual()
  }
}

function updatePresetSummary(settings: UserThemeSettings) {
  const preset = themePresets.value.find(item => item.id === settings.activePresetId)
  if (preset) Object.assign(preset, settings)
}

function applyThemeSettings(settings: UserThemeSettings, userId = activeUserId.value) {
  if (userId) activeUserId.value = userId
  serverTheme.value = normalizeServerTheme(settings)
  committedTheme = serverTheme.value
  committedBrightness = serverTheme.value.brightness || brightness.value
  committedStyle = serverTheme.value.style || style.value
  updatePresetSummary(committedTheme)
  persistThemeCache()
  applyPreferences()
  void loadBackground()
}

function previewThemeSettings(
  patch: Partial<Pick<UserThemeSettings, 'fontSize' | 'textColor' | 'accentColor' | 'appearance' | 'brightness' | 'style'>>,
) {
  previewRevision += 1
  serverTheme.value = normalizeServerTheme({ ...serverTheme.value, ...patch })
  applyPreferences()
}

function saveThemeCustomization(
  patch: Partial<Pick<UserThemeSettings, 'fontSize' | 'textColor' | 'accentColor' | 'appearance' | 'brightness' | 'style'>>,
): Promise<void> {
  if (presetBusy.value) return Promise.reject(new Error('Theme switch in progress'))
  patch = { brightness: brightness.value, style: style.value, ...patch }
  previewThemeSettings(patch)
  const revision = previewRevision
  const userId = activeUserId.value
  const snapshot = JSON.parse(JSON.stringify({ ...patch, ...(serverTheme.value.activePresetId ? { presetId: serverTheme.value.activePresetId } : {}) })) as typeof patch
  const save = saveQueue.catch(() => undefined).then(async () => {
    if (userId !== activeUserId.value) return
    try {
      const saved = normalizeServerTheme(await updateThemeSettings(snapshot))
      if (userId !== activeUserId.value) return
      committedTheme = saved
      committedBrightness = saved.brightness || snapshot.brightness || brightness.value
      committedStyle = saved.style || snapshot.style || style.value
      updatePresetSummary(saved)
      persistThemeCache(saved)
      // A completed request must not replace a newer slider/color preview.
      if (revision === previewRevision) {
        serverTheme.value = saved
        applyPreferences()
        void loadBackground()
      }
    } catch (error) {
      if (userId === activeUserId.value && revision === previewRevision) {
        restoreCommittedTheme()
      }
      throw error
    }
  })
  saveQueue = save
  return trackThemeWrite(save)
}

async function syncThemeFromServer(): Promise<void> {
  const userId = activeUserId.value
  const revision = previewRevision
  if (!userId) return
  const settings = await fetchThemeSettings()
  if (userId === activeUserId.value && revision === previewRevision) applyThemeSettings(settings)
}

function activateUserTheme(userId: number, settings: UserThemeSettings) {
  if (userId !== activeUserId.value) themePresets.value = []
  previewRevision += 1
  applyThemeSettings(settings, userId)
}

function changeBackground(request: () => Promise<UserThemeSettings>, remove = false): Promise<void> {
  if (presetBusy.value) return Promise.reject(new Error('Theme switch in progress'))
  const userId = activeUserId.value
  const change = saveQueue.catch(() => undefined).then(async () => {
    if (userId !== activeUserId.value) return
    const settings = normalizeServerTheme(await request())
    if (userId !== activeUserId.value) return
    // Upload responses include the whole theme; only their background metadata
    // belongs to this operation. A newer slider preview must remain visible.
    committedTheme = { ...committedTheme, background: settings.background, updatedAt: settings.updatedAt }
    serverTheme.value = { ...serverTheme.value, background: settings.background, updatedAt: settings.updatedAt }
    updatePresetSummary(committedTheme)
    persistThemeCache(committedTheme)
    if (remove) {
      clearBackgroundVisual()
      if (userId) await clearThemeBackgroundCache(userId)
    } else await loadBackground(true)
  })
  saveQueue = change
  return trackThemeWrite(change)
}

function uploadBackground(file: File): Promise<void> {
  const presetId = serverTheme.value.activePresetId
  return changeBackground(() => uploadThemeBackgroundApi(file, presetId))
}

function removeBackground(): Promise<void> {
  const presetId = serverTheme.value.activePresetId
  return changeBackground(() => deleteThemeBackgroundApi(presetId), true)
}

function resetCustomization(): Promise<void> {
  return saveThemeCustomization({
    fontSize: DEFAULT_THEME_FONT_SIZE,
    textColor: null,
    accentColor: null,
    appearance: normalizeThemeAppearance(null),
  })
}

function applyPreferences() {
  if (serverTheme.value.brightness) brightness.value = serverTheme.value.brightness
  if (serverTheme.value.style) style.value = serverTheme.value.style
  localStorage.setItem(BRIGHTNESS_KEY, brightness.value)
  localStorage.setItem(STYLE_KEY, style.value)
  applyClasses()
}

function restoreCommittedTheme() {
  serverTheme.value = committedTheme
  brightness.value = committedBrightness
  style.value = committedStyle
  persistThemeCache()
  applyPreferences()
  void loadBackground()
}

function runLibraryTask(operation: () => Promise<ThemeLibrary | ThemeLibraryChange>): Promise<void> {
  if (presetBusy.value) return Promise.reject(new Error('Theme switch in progress'))
  const userId = activeUserId.value
  presetBusy.value = true
  previewRevision += 1
  const task = saveQueue.catch(() => undefined).then(async () => {
    if (userId !== activeUserId.value) return
    const result = await operation()
    if (userId !== activeUserId.value) return
    themePresets.value = result.themes
    const active = 'theme' in result ? result.theme : result.themes.find(item => item.id === result.activeId)
    if (active) applyThemeSettings({ ...active, activePresetId: result.activeId })
  }).catch(error => {
    if (userId === activeUserId.value) restoreCommittedTheme()
    throw error
  }).finally(() => { presetBusy.value = false })
  saveQueue = task
  return task
}

function loadThemePresets() { return runLibraryTask(fetchThemePresets) }
function createPreset(name: string, sourceId?: string) {
  const preferences = { brightness: brightness.value, style: style.value }
  return runLibraryTask(() => createThemePreset({ name, sourceId, ...preferences }))
}
function renamePreset(id: string, name: string) { return runLibraryTask(() => renameThemePreset(id, name)) }
function switchPreset(id: string) { return runLibraryTask(() => activateThemePreset(id)) }
function removePreset(id: string) { return runLibraryTask(() => deleteThemePreset(id)) }
function importPreset(file: File) {
  const preferences = { brightness: brightness.value, style: style.value }
  return runLibraryTask(() => importThemeArchive(file, preferences))
}
function exportPreset(id: string): Promise<Blob> {
  if (presetBusy.value) return Promise.reject(new Error('Theme operation in progress'))
  const userId = activeUserId.value
  const preferences = { brightness: brightness.value, style: style.value }
  const pendingWrite = pendingThemeWrite
  presetBusy.value = true
  // A failed pending save must not silently produce an archive of older settings.
  const task = saveQueue.catch(() => undefined).then(async () => {
    await pendingWrite
    if (userId !== activeUserId.value) throw new Error('Theme account changed')
    const blob = await exportThemeArchive(id, preferences)
    if (userId !== activeUserId.value) throw new Error('Theme account changed')
    return blob
  }).finally(() => { presetBusy.value = false })
  // Failed downloads must not prevent a later retry.
  saveQueue = task.then(() => undefined, () => undefined)
  return task
}

applyPreferences()
void loadBackground()

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (brightness.value === 'system') applyClasses()
})

watch(brightness, (mode) => {
  localStorage.setItem(BRIGHTNESS_KEY, mode)
  applyClasses()
})

watch(style, (themeStyle) => {
  localStorage.setItem(STYLE_KEY, themeStyle)
  applyClasses()
})

watch(hasCustomBackground, (active) => {
  document.documentElement.classList.toggle('theme-has-custom-background', active)
}, { immediate: true })

export function useTheme() {
  const themeName = computed(() => {
    const mode = isDark.value ? 'dark' : 'light'
    return isComic.value ? `comic-${mode}` : mode
  })

  function setBrightness(mode: BrightnessMode) {
    if (!activeUserId.value) { brightness.value = mode; return Promise.resolve() }
    return saveThemeCustomization({ brightness: mode })
  }

  function setStyle(themeStyle: ThemeStyle) {
    if (!activeUserId.value) { style.value = themeStyle; return Promise.resolve() }
    return saveThemeCustomization({ style: themeStyle })
  }

  function toggleBrightness() {
    const next: Record<BrightnessMode, BrightnessMode> = { system: 'light', light: 'dark', dark: 'system' }
    return setBrightness(next[brightness.value])
  }

  function toggleStyle() {
    return setStyle(isComic.value ? 'ink' : 'comic')
  }

  return {
    themePresets, presetBusy,
    activePresetId: computed(() => serverTheme.value.activePresetId),
    loadThemePresets, createPreset, renamePreset, switchPreset, removePreset, importPreset, exportPreset,
    brightness,
    style,
    isDark,
    isComic,
    themeName,
    customization,
    appearance: computed(() => normalizeThemeAppearance(serverTheme.value.appearance)),
    resolvedAppearance,
    fontSize: computed(() => serverTheme.value.fontSize),
    textColor: computed(() => serverTheme.value.textColor),
    accentColor: computed(() => serverTheme.value.accentColor),
    backgroundImageUrl,
    backgroundImageName,
    hasBackgroundImage,
    hasCustomBackground,
    setBrightness,
    setStyle,
    toggleBrightness,
    toggleStyle,
    previewThemeSettings,
    saveThemeCustomization,
    resetCustomization,
    syncThemeFromServer,
    activateUserTheme,
    uploadBackground,
    removeBackground,
    normalizeThemeFontSize,
    normalizeHexColor,
  }
}
