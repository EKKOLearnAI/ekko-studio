export const DEFAULT_THEME_FONT_SIZE = 14
export const MIN_THEME_FONT_SIZE = 12
export const MAX_THEME_FONT_SIZE = 20

export interface ThemeCustomization {
  fontSize: number
  textColor: string | null
  accentColor: string | null
  appearance?: ThemeAppearance
}

export interface ResolvedThemeCustomization {
  fontSize: number
  textPrimary?: string
  textSecondary?: string
  textMuted?: string
  textPrimaryRgb?: string
  textSecondaryRgb?: string
  textMutedRgb?: string
  accentPrimary?: string
  accentHover?: string
  accentMuted?: string
  accentPrimaryRgb?: string
  accentHoverRgb?: string
  textOnAccent?: string
}

export function normalizeThemeFontSize(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return DEFAULT_THEME_FONT_SIZE
  return Math.min(MAX_THEME_FONT_SIZE, Math.max(MIN_THEME_FONT_SIZE, Math.round(numeric)))
}

export function normalizeHexColor(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  if (/^#[0-9a-f]{6}$/.test(normalized)) return normalized
  if (/^#[0-9a-f]{3}$/.test(normalized)) {
    return `#${normalized.slice(1).split('').map(character => character.repeat(2)).join('')}`
  }
  return null
}

function hexToChannels(hex: string): [number, number, number] {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ]
}

function channelsToHex(channels: [number, number, number]): string {
  return `#${channels
    .map(channel => Math.round(channel).toString(16).padStart(2, '0'))
    .join('')}`
}

export function mixHex(foreground: string, background: string, foregroundWeight: number): string {
  const foregroundChannels = hexToChannels(foreground)
  const backgroundChannels = hexToChannels(background)
  return channelsToHex(foregroundChannels.map((channel, index) =>
    channel * foregroundWeight + backgroundChannels[index] * (1 - foregroundWeight),
  ) as [number, number, number])
}

export function toRgbComponents(hex: string): string {
  return hexToChannels(hex).join(', ')
}

function readableTextColor(background: string): string {
  const [red, green, blue] = hexToChannels(background).map(channel => {
    const value = channel / 255
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue
  return luminance > 0.42 ? '#1a1a1a' : '#ffffff'
}

export function normalizeThemeCustomization(value: unknown): ThemeCustomization {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  return {
    fontSize: normalizeThemeFontSize(record.fontSize),
    textColor: normalizeHexColor(record.textColor),
    accentColor: normalizeHexColor(record.accentColor),
  }
}

export function resolveThemeCustomization(
  customization: ThemeCustomization,
  isDark: boolean,
): ResolvedThemeCustomization {
  const background = customization.appearance?.global.backgroundColor || (isDark ? '#1a1a1a' : '#fafafa')
  const resolved: ResolvedThemeCustomization = {
    fontSize: normalizeThemeFontSize(customization.fontSize),
  }

  const textColor = normalizeHexColor(customization.textColor)
  if (textColor) {
    resolved.textPrimary = textColor
    resolved.textSecondary = mixHex(textColor, background, 0.68)
    resolved.textMuted = mixHex(textColor, background, 0.5)
    resolved.textPrimaryRgb = toRgbComponents(textColor)
    resolved.textSecondaryRgb = toRgbComponents(resolved.textSecondary)
    resolved.textMutedRgb = toRgbComponents(resolved.textMuted)
  }

  const accentColor = normalizeHexColor(customization.accentColor)
  if (accentColor) {
    const hoverTarget = isDark ? '#ffffff' : '#000000'
    resolved.accentPrimary = accentColor
    resolved.accentHover = mixHex(hoverTarget, accentColor, 0.18)
    resolved.accentMuted = mixHex(accentColor, background, 0.55)
    resolved.accentPrimaryRgb = toRgbComponents(accentColor)
    resolved.accentHoverRgb = toRgbComponents(resolved.accentHover)
    resolved.textOnAccent = readableTextColor(accentColor)
  }

  return resolved
}
import type { ThemeAppearance } from '../../../shared/theme-appearance'
