import { describe, expect, it } from 'vitest'
import { normalizeThemeAppearance } from '../../packages/shared/theme-appearance'
import { resolveAppearance } from '@/styles/theme-appearance'
import { editorTheme, terminalTheme } from '@/styles/theme-integrations'
import { getThemeOverrides } from '@/styles/theme'

const defaults = { fontSize: 14, textColor: null, accentColor: null }

describe('appearance inheritance and native adapters', () => {
  it('preserves preset surfaces until a property is explicitly configured', () => {
    const theme = resolveAppearance(defaults, false)
    expect(theme.variables['--theme-card-bg']).toBeUndefined()
    expect(theme.variables['--radius-component']).toBeUndefined()
    expect(theme.variables['--border-color']).toBeUndefined()
    expect(theme.variables['--theme-card-border']).toBeUndefined()
  })

  it('resolves border alpha once, using local opacity before global opacity', () => {
    const appearance = normalizeThemeAppearance({
      global: { borderColor: '#6688aa', opacity: 0.2 },
      regions: { card: { opacity: 0.8 }, input: { opacity: 0 }, overlay: { opacity: 1, borderColor: '#112233' } },
    })
    const theme = resolveAppearance({ ...defaults, appearance }, false)
    expect(theme.variables).toMatchObject({
      '--border-color': 'rgba(102, 136, 170, 0.2)',
      '--theme-card-border': 'rgba(102, 136, 170, 0.8)',
      '--theme-input-border': 'rgba(102, 136, 170, 0)',
      '--theme-overlay-border': '#112233',
    })
    delete appearance.regions.card?.opacity
    expect(resolveAppearance({ ...defaults, appearance }, false).variables['--theme-card-border']).toBe('rgba(102, 136, 170, 0.2)')
    delete appearance.global.opacity
    expect(resolveAppearance({ ...defaults, appearance }, false).variables['--theme-card-border']).toBe('#6688aa')
  })

  it.each([
    [false, false, '224, 224, 224'], [true, false, '58, 58, 58'],
    [false, true, '26, 26, 26'], [true, true, '102, 102, 102'],
  ] as const)('keeps preset border hues with dark=%s comic=%s', (dark, comic, rgb) => {
    const theme = resolveAppearance({ ...defaults, appearance: { global: { opacity: 0.4 }, regions: {} } }, dark, comic)
    expect(theme.variables['--border-color']).toBe(`rgba(${rgb}, 0.4)`)
  })

  it('fades component grids and overlay dividers while keeping input focus visible', () => {
    const overrides = getThemeOverrides(false, false, { ...defaults, accentColor: '#ff8833', appearance: {
      global: { opacity: 0.2, borderColor: '#6688aa' },
      regions: { card: { opacity: 0.8 }, input: { opacity: 0 }, overlay: { opacity: 0.4 } },
    } })
    expect(overrides.common?.dividerColor).toBe('rgba(102, 136, 170, 0.2)')
    expect(overrides.DataTable?.borderColor).toBe('rgba(102, 136, 170, 0.8)')
    expect(overrides.Descriptions?.borderColor).toBe('rgba(102, 136, 170, 0.8)')
    expect(overrides.Drawer?.headerBorderBottom).toBe('1px solid rgba(102, 136, 170, 0.4)')
    expect(overrides.Popover?.dividerColor).toBe('rgba(102, 136, 170, 0.4)')
    expect(overrides.Input?.border).toBe('1px solid rgba(102, 136, 170, 0)')
    expect(overrides.Input?.borderFocus).toBe('1px solid #ff8833')
    expect(overrides.Input?.borderError).toBeUndefined()
  })

  it('allows zero opacity, blur, radius and shadow; local values override global values', () => {
    const appearance = normalizeThemeAppearance({ global: { opacity: 0.6, radius: 12, backgroundColor: '#AABBCC' }, regions: { input: { opacity: 0, radius: 0, blur: 0, shadow: 0 } } }, true)
    const theme = resolveAppearance({ ...defaults, appearance }, false)
    expect(theme.variables).toMatchObject({
      '--theme-card-bg': 'rgba(170, 187, 204, 0.6)',
      '--theme-card-radius': '12px',
      '--theme-input-bg': 'rgba(170, 187, 204, 0)',
      '--theme-input-radius': '0px',
      '--theme-input-filter': 'blur(0px) saturate(1.1)',
      '--theme-input-shadow': 'none',
    })
    delete appearance.regions.input
    expect(resolveAppearance({ ...defaults, appearance }, false).variables['--theme-input-radius']).toBe('12px')
  })

  it.each([
    { global: { opacity: -1 } }, { global: { opacity: 1.1 } },
    { global: { radius: '10' } }, { global: { fontFamily: 'url(https://bad.invalid)' } },
    { global: { backgroundColor: 'red; display:none' } },
    { regions: { missing: { opacity: 1 } } }, { regions: { input: { spacing: 1 } } },
    { css: 'body { display:none }' },
  ])('rejects invalid writes and tolerantly reads old settings: %j', value => {
    expect(() => normalizeThemeAppearance(value, true)).toThrow('Invalid theme appearance')
    expect(normalizeThemeAppearance(value)).toEqual({ global: {}, regions: {} })
  })

  it('keeps CSS, Naive UI, terminal and Monaco colors aligned', () => {
    const customization = { ...defaults, fontSize: 18, textColor: '#f0f0f0', accentColor: '#ff8833', appearance: {
      global: { backgroundColor: '#102030', radius: 20 }, regions: { content: { opacity: 0.5 }, input: { backgroundColor: '#203040', radius: 0 } },
    } }
    const overrides = getThemeOverrides(true, false, customization)
    expect(overrides.common).toMatchObject({ bodyColor: '#102030', fontSize: '18px', borderRadius: '20px' })
    expect(overrides.Input).toMatchObject({ color: 'rgba(32, 48, 64, 1)', borderRadius: '0px' })
    expect(terminalTheme(customization, true)).toMatchObject({ background: 'rgba(16, 32, 48, 0.5)', foreground: '#f0f0f0', cursor: '#ff8833' })
    expect(editorTheme(customization, true).colors).toMatchObject({ 'editor.background': '#10203080', 'editor.foreground': '#f0f0f0', 'editorCursor.foreground': '#ff8833' })
  })

  it('applies card overrides to description tables without an opaque header layer', () => {
    const customization = { ...defaults, appearance: {
      global: {}, regions: { card: { backgroundColor: '#336699', opacity: 0.25, radius: 16, borderColor: '#6688aa' } },
    } }
    for (const dark of [false, true]) {
      const overrides = getThemeOverrides(dark, false, customization)
      expect(overrides.Descriptions).toMatchObject({
        tdColor: 'rgba(51, 102, 153, 0.25)', tdColorModal: 'rgba(51, 102, 153, 0.25)', tdColorPopover: 'rgba(51, 102, 153, 0.25)',
        thColor: 'rgba(var(--text-primary-rgb), 0.04)', borderColor: 'rgba(102, 136, 170, 0.25)', borderRadius: '16px',
      })
      expect(getThemeOverrides(dark, false, defaults).Descriptions?.tdColor).toBeUndefined()
    }
  })

  it('keeps table cells translucent in normal, modal and popover contexts, and restores presets', () => {
    for (const dark of [false, true]) {
      for (const wallpaper of [false, true]) {
        const configured = getThemeOverrides(dark, false, { ...defaults, appearance: {
          global: { opacity: 0.6 }, regions: { card: { opacity: 0, borderColor: '#6688aa', radius: 16 } },
        } }, wallpaper)
        const glass = getThemeOverrides(dark, false, defaults, true)
        for (const overrides of [configured, glass]) {
          for (const suffix of ['', 'Modal', 'Popover'] as const) {
            expect(overrides.DataTable?.[`tdColor${suffix}`]).toBe('transparent')
            expect(overrides.Table?.[`tdColor${suffix}`]).toBe('transparent')
            expect(overrides.DataTable?.[`thColor${suffix}`]).toBe('rgba(var(--text-primary-rgb), 0.04)')
            expect(overrides.DataTable?.[`tdColorHover${suffix}`]).toBe('rgba(var(--text-primary-rgb), 0.08)')
            expect(overrides.DataTable?.[`tdColorSorting${suffix}`]).toBe('rgba(var(--text-primary-rgb), 0.04)')
            expect(overrides.DataTable?.[`tdColorStriped${suffix}`]).toBe('rgba(var(--text-primary-rgb), 0.025)')
            expect(overrides.DataTable?.[`thColorSorting${suffix}`]).toBe('rgba(var(--text-primary-rgb), 0.08)')
          }
        }
        expect(configured.DataTable).toMatchObject({ borderRadius: '16px', borderColor: 'rgba(102, 136, 170, 0)' })
        expect(glass.Descriptions?.tdColor).toBe('rgba(var(--bg-card-rgb), 0.72)')
        const reset = getThemeOverrides(dark, false, defaults)
        expect(reset.DataTable?.tdColor).toBeUndefined()
        expect(reset.DataTable?.thColor).toBeUndefined()
        expect(reset.Table?.tdColor).toBeUndefined()
      }
    }
  })
})
