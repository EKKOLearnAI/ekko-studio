// Read appearance and the selected app language only. The remote document never receives a privileged bridge
// and cannot supply scripts, resource URLs or arbitrary CSS to the local views.
export function readNativeDeviceAppearance() {
  const root = document.documentElement
  const locale = root.lang.trim().slice(0, 64)
  const ready = !!document.querySelector('#app .studio-page-header')
  if (!ready) return { ready, locale, scheme: 'dark', values: {} }
  if (!getComputedStyle(root).getPropertyValue('--text-primary').trim()) return { ready, locale, scheme: 'dark', values: {} }
  const wallpaper = root.classList.contains('theme-has-custom-background')
  const properties: Record<string, [string, string]> = {
    text: ['color', 'var(--text-primary)'], secondary: ['color', 'var(--text-secondary)'],
    accent: ['color', 'var(--accent-primary)'], onAccent: ['color', 'var(--text-on-accent)'], error: ['color', 'var(--error)'],
    background: ['background-color', 'var(--bg-primary)'],
    overlay: ['background-color', wallpaper ? 'var(--theme-overlay-bg,rgba(var(--bg-main-surface-rgb),.72))' : 'var(--theme-overlay-bg,var(--bg-card))'],
    card: ['background-color', 'var(--theme-card-bg,var(--bg-card))'],
    input: ['background-color', wallpaper ? 'var(--theme-input-bg,rgba(var(--bg-card-rgb),.72))' : 'var(--theme-input-bg,var(--bg-input))'],
    border: ['border-top-color', 'var(--theme-chrome-border,var(--border-color))'],
    overlayBorder: ['border-top-color', 'var(--theme-overlay-border,var(--border-color))'],
    cardBorder: ['border-top-color', 'var(--theme-card-border,var(--border-color))'],
    inputBorder: ['border-top-color', 'var(--theme-input-border,var(--border-color))'],
    radius: ['border-radius', 'var(--theme-chrome-radius,var(--radius-component,6px))'],
    overlayRadius: ['border-radius', 'var(--theme-overlay-radius,var(--radius-component,8px))'],
    cardRadius: ['border-radius', 'var(--theme-card-radius,var(--radius-component,8px))'],
    inputRadius: ['border-radius', 'var(--theme-input-radius,var(--radius-component,6px))'],
    overlayFilter: ['backdrop-filter', wallpaper ? 'var(--theme-overlay-filter,blur(8px) saturate(1.1))' : 'var(--theme-overlay-filter,none)'],
    cardFilter: ['backdrop-filter', 'var(--theme-card-filter,none)'], inputFilter: ['backdrop-filter', 'var(--theme-input-filter,none)'],
    overlayShadow: ['box-shadow', 'var(--theme-overlay-shadow,var(--theme-shadow,none))'],
    cardShadow: ['box-shadow', 'var(--theme-card-shadow,var(--theme-shadow,none))'],
    borderWidth: ['border-top-width', 'var(--border-width,1px)'],
    font: ['font-family', 'var(--font-ui,system-ui,sans-serif)'], fontSize: ['font-size', 'var(--font-size-base,14px)'],
  }
  const probe = document.createElement('span')
  probe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;contain:strict;border-style:solid'
  root.append(probe)
  try {
    const values: Record<string, string> = {}
    for (const [key, [property, value]] of Object.entries(properties)) {
      probe.style.setProperty(property, value)
      values[key] = getComputedStyle(probe).getPropertyValue(property).trim()
    }
    return { ready, locale, scheme: root.classList.contains('dark') ? 'dark' : 'light', values }
  } finally { probe.remove() }
}
