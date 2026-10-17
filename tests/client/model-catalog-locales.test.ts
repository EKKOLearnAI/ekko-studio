import { describe, expect, it } from 'vitest'
import { createI18n } from 'vue-i18n'
import { loadLocaleMessages, supportedLocales } from '@/i18n/messages'

describe('model catalog notice translations', () => {
  it.each(supportedLocales)('renders the whole notice and visibility flow in %s without fallback', async locale => {
    const messages = await loadLocaleMessages(locale)
    const i18n = createI18n({ legacy: false, locale, fallbackLocale: false, messages: { [locale]: messages } })
    const keys = ['largeCatalogTitle', 'largeCatalogHint', 'largeCatalogProviderCount', 'largeCatalogLater', 'manageVisibleModels', 'manageVisibleModelsFor', 'visibilityHint', 'visibilitySelectedCount', 'visibilitySelectOne', 'visibilitySaved', 'visibilitySaveFailed', 'showAllModels', 'clearVisibleModels', 'searchPlaceholder', 'noResults']
    for (const key of keys) {
      expect(messages.models[key], `${locale}: ${key}`).toBeTypeOf('string')
      const text = i18n.global.t(`models.${key}`, { name: 'OpenRouter', count: 464, selected: 4, total: 464 })
      expect(text).not.toBe(`models.${key}`)
      expect(text).not.toMatch(/\{\w+\}/)
      expect(text.trim()).not.toBe('')
    }
    expect(i18n.global.t('models.largeCatalogProviderCount', { name: 'OpenRouter', count: 464 })).toContain('OpenRouter')
    expect(i18n.global.t('models.visibilitySelectedCount', { selected: 4, total: 464 })).toContain('464')
  })
})
