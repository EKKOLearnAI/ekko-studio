// Shared by persistence and the live editor. Missing fields inherit the preset.
export const THEME_REGIONS = ['chrome', 'sidebar', 'content', 'card', 'input', 'overlay', 'userMessage', 'assistantMessage'] as const
export type ThemeRegion = typeof THEME_REGIONS[number]

export interface SurfaceAppearance {
  backgroundColor?: string
  opacity?: number
  blur?: number
  radius?: number
  borderColor?: string
  shadow?: number
}

export interface GlobalAppearance extends SurfaceAppearance {
  secondaryTextColor?: string
  mutedTextColor?: string
  linkColor?: string
  gradientColor?: string
  gradientAngle?: number
  backgroundSize?: 'cover' | 'contain' | 'auto'
  backgroundPosition?: 'center' | 'top' | 'bottom' | 'left' | 'right'
  overlayOpacity?: number
  borderWidth?: number
  controlHeight?: number
  spacing?: number
  chatWidth?: number
  fontFamily?: 'system' | 'serif' | 'mono'
  lineHeight?: number
  letterSpacing?: number
}

export interface ThemeAppearance {
  global: GlobalAppearance
  regions: Partial<Record<ThemeRegion, SurfaceAppearance>>
}

export const SURFACE_RANGES = {
  opacity: [0, 1, 0.01], blur: [0, 30, 1], radius: [0, 32, 1], shadow: [0, 2, 0.05],
} as const
export const GLOBAL_RANGES = {
  ...SURFACE_RANGES,
  gradientAngle: [0, 360, 1], overlayOpacity: [0, 1, 0.01], borderWidth: [0, 4, 0.5],
  controlHeight: [24, 56, 1], spacing: [0.5, 1.5, 0.05], chatWidth: [480, 1800, 20],
  lineHeight: [1, 2.4, 0.05], letterSpacing: [-1, 3, 0.1],
} as const
const COLORS = ['backgroundColor', 'borderColor']
const GLOBAL_COLORS = [...COLORS, 'secondaryTextColor', 'mutedTextColor', 'linkColor', 'gradientColor']
const ENUMS = {
  backgroundSize: ['cover', 'contain', 'auto'],
  backgroundPosition: ['center', 'top', 'bottom', 'left', 'right'],
  fontFamily: ['system', 'serif', 'mono'],
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** Strict mode rejects invalid writes; tolerant mode restores older saved themes. */
export function normalizeThemeAppearance(value: unknown, strict = false): ThemeAppearance {
  function invalid(field: string): void {
    if (strict) throw new Error(`Invalid theme appearance: ${field}`)
  }
  function surface(input: unknown, global = false): GlobalAppearance {
    const result: Record<string, string | number> = {}
    if (input == null) return result
    if (!record(input)) { invalid('surface'); return result }
    const ranges = global ? GLOBAL_RANGES : SURFACE_RANGES
    const colors = global ? GLOBAL_COLORS : COLORS
    for (const [key, raw] of Object.entries(input)) {
      if (raw == null) continue
      if (colors.includes(key)) {
        if (typeof raw === 'string' && /^#[\da-f]{6}$/i.test(raw)) result[key] = raw.toLowerCase()
        else invalid(key)
      } else if (Object.prototype.hasOwnProperty.call(ranges, key)) {
        const [min, max] = ranges[key as keyof typeof ranges]
        if (typeof raw === 'number' && Number.isFinite(raw) && raw >= min && raw <= max) result[key] = raw
        else invalid(key)
      } else if (global && Object.prototype.hasOwnProperty.call(ENUMS, key)) {
        if (typeof raw === 'string' && (ENUMS[key as keyof typeof ENUMS] as string[]).includes(raw)) result[key] = raw
        else invalid(key)
      } else invalid(key)
    }
    return result
  }
  if (value == null) return { global: {}, regions: {} }
  if (!record(value)) { invalid('settings'); return { global: {}, regions: {} } }
  for (const key of Object.keys(value)) {
    if (key !== 'global' && key !== 'regions') invalid(key)
  }
  const regions: ThemeAppearance['regions'] = {}
  if (value.regions != null && !record(value.regions)) invalid('regions')
  if (record(value.regions)) {
    for (const [key, input] of Object.entries(value.regions)) {
      if (!(THEME_REGIONS as readonly string[]).includes(key)) { invalid(key); continue }
      const values = surface(input)
      if (Object.keys(values).length) regions[key as ThemeRegion] = values
    }
  }
  return { global: surface(value.global, true), regions }
}
