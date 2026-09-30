import { computed, ref, watch } from 'vue'
import {
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
// Start in the default style while the quick style switch is unavailable.
// Keep this in sync with the pre-render theme in index.html.
const style = ref<ThemeStyle>('ink')
const isDark = ref(false)
const isComic = ref(false)
const activeUserId = ref<number | null>(storedUserId())
const serverTheme = ref<UserThemeSettings>(loadCachedTheme(activeUserId.value))
let committedTheme = serverTheme.value
const backgroundImageUrl = ref<string | null>(null)
const backgroundImageName = computed(() => serverTheme.value.background?.name || '')
const hasBackgroundImage = computed(() => !!backgroundImageUrl.value)
let backgroundObjectUrl: string | null = null
let backgroundLoadGeneration = 0

const customization = computed<ThemeCustomization>(() => ({
  fontSize: serverTheme.value.fontSize,
  textColor: serverTheme.value.textColor,
  accentColor: serverTheme.value.accentColor,
}))

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
}

function applyClasses() {
  const dark = resolveDark(brightness.value)
  isDark.value = dark
  isComic.value = style.value === 'comic'
  document.documentElement.classList.toggle('dark', dark)
  document.documentElement.classList.toggle('comic', isComic.value)
  applyCustomization()
}

function persistThemeCache() {
  if (!activeUserId.value) return
  localStorage.setItem(cacheKey(activeUserId.value), JSON.stringify(serverTheme.value))
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
  document.documentElement.style.removeProperty('--app-background-image')
}

async function loadBackground(refresh = false) {
  const userId = activeUserId.value
  const background = serverTheme.value.background
  if (!userId || !background) {
    clearBackgroundVisual()
    return
  }

  const generation = ++backgroundLoadGeneration
  try {
    const blob = await fetchThemeBackgroundBlob(userId, background.updatedAt, refresh)
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
    document.documentElement.style.setProperty('--app-background-image', `url("${url}")`)
  } catch {
    if (generation === backgroundLoadGeneration) clearBackgroundVisual()
  }
}

function applyThemeSettings(settings: UserThemeSettings, userId = activeUserId.value) {
  if (userId) activeUserId.value = userId
  serverTheme.value = normalizeServerTheme(settings)
  committedTheme = serverTheme.value
  persistThemeCache()
  applyCustomization()
  void loadBackground()
}

function previewThemeSettings(
  patch: Partial<Pick<UserThemeSettings, 'fontSize' | 'textColor' | 'accentColor'>>,
) {
  serverTheme.value = normalizeServerTheme({ ...serverTheme.value, ...patch })
  applyCustomization()
}

async function saveThemeCustomization(
  patch: Partial<Pick<UserThemeSettings, 'fontSize' | 'textColor' | 'accentColor'>>,
): Promise<void> {
  previewThemeSettings(patch)
  try {
    applyThemeSettings(await updateThemeSettings(patch))
  } catch (error) {
    serverTheme.value = committedTheme
    persistThemeCache()
    applyCustomization()
    throw error
  }
}

async function syncThemeFromServer(): Promise<void> {
  if (!activeUserId.value) return
  applyThemeSettings(await fetchThemeSettings())
}

function activateUserTheme(userId: number, settings: UserThemeSettings) {
  applyThemeSettings(settings, userId)
}

async function uploadBackground(file: File): Promise<void> {
  const settings = await uploadThemeBackgroundApi(file)
  applyThemeSettings(settings)
  await loadBackground(true)
}

async function removeBackground(): Promise<void> {
  const userId = activeUserId.value
  const settings = await deleteThemeBackgroundApi()
  clearBackgroundVisual()
  if (userId) await clearThemeBackgroundCache(userId)
  applyThemeSettings(settings)
}

function resetCustomization(): Promise<void> {
  return saveThemeCustomization({
    fontSize: DEFAULT_THEME_FONT_SIZE,
    textColor: null,
    accentColor: null,
  })
}

applyClasses()
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

watch(hasBackgroundImage, (active) => {
  document.documentElement.classList.toggle('theme-has-custom-background', active)
}, { immediate: true })

export function useTheme() {
  const themeName = computed(() => {
    const mode = isDark.value ? 'dark' : 'light'
    return isComic.value ? `comic-${mode}` : mode
  })

  function setBrightness(mode: BrightnessMode) {
    brightness.value = mode
  }

  function setStyle(themeStyle: ThemeStyle) {
    style.value = themeStyle
  }

  function toggleBrightness() {
    brightness.value = isDark.value ? 'light' : 'dark'
  }

  function toggleStyle() {
    style.value = isComic.value ? 'ink' : 'comic'
  }

  return {
    brightness,
    style,
    isDark,
    isComic,
    themeName,
    customization,
    fontSize: computed(() => serverTheme.value.fontSize),
    textColor: computed(() => serverTheme.value.textColor),
    accentColor: computed(() => serverTheme.value.accentColor),
    backgroundImageUrl,
    backgroundImageName,
    hasBackgroundImage,
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
