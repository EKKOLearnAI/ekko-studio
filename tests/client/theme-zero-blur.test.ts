import { expect, it } from 'vitest'
import { normalizeThemeAppearance, resolveAppearance, THEME_REGIONS } from '../../packages/client/src/styles/theme-appearance'

function filters(appearance: unknown) {
  return resolveAppearance({ fontSize: 14, textColor: null, accentColor: null,
    appearance: normalizeThemeAppearance(appearance) }, false).variables
}

it('disables the entire backdrop filter in all regions for an explicit global zero blur', () => {
  const variables = filters({ global: { blur: 0 } })
  for (const region of THEME_REGIONS) expect(variables[`--theme-${region}-filter`]).toBe('none')
})

it('lets a regional zero disable inherited blur without changing other regions', () => {
  const variables = filters({ global: { blur: 12 }, regions: { card: { blur: 0 } } })
  expect(variables['--theme-card-filter']).toBe('none')
  expect(variables['--theme-content-filter']).toBe('blur(12px) saturate(1.1)')
})

it('lets a positive regional override opt back into blur over a global zero', () => {
  const variables = filters({ global: { blur: 0 }, regions: { overlay: { blur: 6 } } })
  expect(variables['--theme-overlay-filter']).toBe('blur(6px) saturate(1.1)')
  expect(variables['--theme-chrome-filter']).toBe('none')
})

it('leaves preset filters unset after resetting overrides rather than treating missing blur as zero', () => {
  const variables = filters({ global: { blur: null }, regions: { card: { blur: null } } })
  for (const region of THEME_REGIONS) expect(variables).not.toHaveProperty(`--theme-${region}-filter`)
})
