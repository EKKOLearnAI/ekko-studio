import { THEME_REGIONS, normalizeThemeAppearance, type ThemeRegion } from '../../../shared/theme-appearance'
import { mixHex, resolveThemeCustomization, toRgbComponents, type ThemeCustomization } from './theme-customization'

export { THEME_REGIONS, normalizeThemeAppearance }
export type { ThemeRegion, ThemeAppearance, GlobalAppearance, SurfaceAppearance } from '../../../shared/theme-appearance'

export const THEME_FONTS = {
  system: 'Inter, system-ui, -apple-system, sans-serif',
  serif: 'Georgia, "Noto Serif", serif',
  mono: '"JetBrains Mono", "Fira Code", Consolas, monospace',
}

export function resolveAppearance(customization: ThemeCustomization, dark: boolean, comic = false) {
  const appearance = normalizeThemeAppearance(customization.appearance)
  const global = appearance.global
  const custom = resolveThemeCustomization(customization, dark)
  const background = global.backgroundColor || (dark ? '#1a1a1a' : '#fafafa')
  const card = global.backgroundColor || (dark ? '#2a2a2a' : '#ffffff')
  const text = custom.textPrimary || (dark ? '#e0e0e0' : '#1a1a1a')
  const secondary = global.secondaryTextColor || custom.textSecondary || (dark ? '#a0a0a0' : '#666666')
  const muted = global.mutedTextColor || custom.textMuted || (dark ? '#888888' : '#999999')
  const accent = custom.accentPrimary || (dark ? '#e0e0e0' : '#333333')
  const border = global.borderColor || (comic ? dark ? '#666666' : '#1a1a1a' : dark ? '#3a3a3a' : '#e0e0e0')
  const borderLight = global.borderColor ? mixHex(border, background, 0.6) : comic ? '#555555' : dark ? '#333333' : '#ebebeb'
  const variables: Record<string, string> = {}
  // Keep unscaled colors separate: regional opacity replaces global opacity,
  // rather than multiplying an already translucent inherited border again.
  variables['--theme-global-border'] = withOpacity(border, global.opacity)
  variables['--theme-global-border-light'] = withOpacity(borderLight, global.opacity)
  const color = (name: string, value: string) => {
    variables[name] = value
    variables[`${name}-rgb`] = toRgbComponents(value)
  }
  if (global.backgroundColor) {
    for (const name of ['--bg-primary', '--bg-card', '--bg-input', '--bg-sidebar', '--bg-sidebar-surface', '--bg-main-surface']) color(name, background)
    color('--bg-secondary', mixHex(text, background, 0.04))
    color('--bg-card-hover', mixHex(text, background, 0.06))
    color('--code-bg', mixHex(text, background, 0.04))
  }
  if (global.secondaryTextColor) color('--text-secondary', secondary)
  if (global.mutedTextColor) color('--text-muted', muted)
  if (global.borderColor || global.opacity !== undefined) {
    variables['--border-color'] = variables['--theme-global-border']
    variables['--border-light'] = variables['--theme-global-border-light']
    variables['--input-border-color'] = variables['--theme-global-border']
  }
  variables['--link-color'] = global.linkColor || accent
  if (global.fontFamily) variables['--font-ui'] = THEME_FONTS[global.fontFamily]
  if (global.radius !== undefined) {
    variables['--radius-component'] = `${global.radius}px`
    variables['--radius-sm'] = `${global.radius * 0.75}px`
    variables['--radius-md'] = variables['--radius-lg'] = `${global.radius}px`
  }
  if (global.borderWidth !== undefined) variables['--border-width'] = `${global.borderWidth}px`
  if (global.controlHeight !== undefined) variables['--control-height'] = `${global.controlHeight}px`
  if (global.spacing !== undefined) variables['--spacing-scale'] = String(global.spacing)
  if (global.chatWidth !== undefined) variables['--chat-max-width'] = `${global.chatWidth}px`
  if (global.lineHeight !== undefined) variables['--line-height'] = String(global.lineHeight)
  if (global.letterSpacing !== undefined) variables['--letter-spacing'] = `${global.letterSpacing}px`
  if (global.backgroundSize) variables['--app-background-size'] = global.backgroundSize
  if (global.backgroundPosition) variables['--app-background-position'] = global.backgroundPosition
  if (global.overlayOpacity !== undefined) variables['--app-background-overlay'] = `rgba(0, 0, 0, ${global.overlayOpacity})`
  if (global.gradientColor) variables['--app-background-gradient'] = `linear-gradient(${global.gradientAngle ?? 135}deg, ${background}, ${global.gradientColor})`
  if (global.shadow !== undefined) variables['--theme-shadow'] = shadow(global.shadow)

  const regions = Object.fromEntries(THEME_REGIONS.map(region => {
    const local = appearance.regions[region] || {}
    const values = { ...global, ...local }
    const baseColor = region === 'chrome' ? background : region === 'sidebar' ? (dark ? background : card) : card
    const surfaceColor = values.backgroundColor || baseColor
    const prefix = `--theme-${region}`
    if (values.backgroundColor || values.opacity !== undefined) {
      variables[`${prefix}-bg`] = `rgba(${toRgbComponents(surfaceColor)}, ${values.opacity ?? 1})`
    }
    if (values.blur !== undefined) variables[`${prefix}-filter`] = `blur(${values.blur}px) saturate(1.1)`
    if (values.radius !== undefined) variables[`${prefix}-radius`] = `${values.radius}px`
    if (values.borderColor || values.opacity !== undefined) {
      variables[`${prefix}-border`] = withOpacity(values.borderColor || border, values.opacity)
      variables[`${prefix}-border-light`] = withOpacity(values.borderColor ? mixHex(values.borderColor, surfaceColor, 0.6) : borderLight, values.opacity)
    }
    if (values.shadow !== undefined) variables[`${prefix}-shadow`] = shadow(values.shadow)
    return [region, { ...values, backgroundColor: surfaceColor, borderColor: values.borderColor || border }]
  })) as Record<ThemeRegion, typeof global & { backgroundColor: string; borderColor: string }>
  return { appearance, variables, regions, background, card, text, secondary, muted, accent, border }
}

function withOpacity(color: string, opacity?: number): string {
  return opacity === undefined || opacity === 1 ? color : `rgba(${toRgbComponents(color)}, ${opacity})`
}

function shadow(strength: number): string {
  return strength === 0 ? 'none' : `0 8px 24px rgba(0, 0, 0, ${Math.min(0.5, strength * 0.12)})`
}
