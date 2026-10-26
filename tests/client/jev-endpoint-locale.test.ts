import { createI18n } from 'vue-i18n'
import { describe, expect, it } from 'vitest'

const locales = import.meta.glob('../../packages/client/src/i18n/locales/*.ts', { eager: true, import: 'default' }) as Record<string, any>
describe('JEV endpoint error translations', () => {
  it.each(Object.entries(locales))('renders the endpoint error in %s', (path, messages) => {
    const locale = path.split('/').pop()!.replace('.ts', '')
    const i18n = createI18n({ legacy: false, locale, messages: { [locale]: messages } })
    const key = 'jev.errors.endpoint_not_found'
    expect(i18n.global.te(key)).toBe(true)
    const text = i18n.global.t(key)
    expect(text).not.toBe(key)
    expect(text).toContain('404')
  })
})
