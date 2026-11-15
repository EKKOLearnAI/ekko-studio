// Keep the iframe theme public and independent of the host component tree.
export function pluginThemeSnapshot(element: HTMLElement): Record<string, string> {
  const style = getComputedStyle(element)
  const theme: Record<string, string> = {}
  for (const key of [
    '--text-primary', '--text-secondary', '--text-muted', '--bg-card', '--bg-secondary', '--bg-input',
    '--border-color', '--border-light', '--accent-primary', '--accent-primary-rgb', '--success', '--error', '--warning',
    '--radius-component', '--font-size-base', '--spacing-scale', '--line-height', '--letter-spacing',
    '--border-width', '--control-height',
  ]) theme[key] = style.getPropertyValue(key)
  theme['--font-family'] = style.fontFamily
  theme['--studio-color-scheme'] = document.documentElement.classList.contains('dark') ? 'dark' : 'light'
  for (const region of ['card', 'input', 'overlay']) {
    for (const property of ['bg', 'border', 'radius', 'shadow', 'filter']) {
      const key = `--theme-${region}-${property}`
      // Empty values remove an earlier override when the user resets a region.
      theme[key] = style.getPropertyValue(key)
    }
    if (!theme[`--theme-${region}-bg`].trim() && document.documentElement.classList.contains('theme-has-custom-background')) {
      const rgb = style.getPropertyValue(region === 'overlay' ? '--bg-main-surface-rgb' : '--bg-card-rgb').trim()
      if (rgb) theme[`--theme-${region}-bg`] = `rgba(${rgb}, 0.72)`
    }
  }
  return theme
}
