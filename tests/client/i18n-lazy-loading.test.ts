// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

describe('i18n lazy loading', () => {
  afterEach(() => {
    localStorage.removeItem('hermes_locale')
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('loads only the initial locale and adds another locale on demand', async () => {
    localStorage.setItem('hermes_locale', 'en')
    vi.resetModules()

    const { i18nReady, switchLocale } = await import('@/i18n')
    const i18n = await i18nReady

    expect(i18n.global.availableLocales).toEqual(['en'])

    await switchLocale('zh')

    expect(i18n.global.availableLocales).toEqual(['en', 'zh'])
    expect(i18n.global.locale.value).toBe('zh')
    expect(document.documentElement.lang).toBe('zh')
    expect(localStorage.getItem('hermes_locale')).toBe('zh')
    expect(i18n.global.t('common.cancel')).not.toBe('common.cancel')
    expect(i18n.global.t('usage.pricing.selectionHelp')).toBe('可选择已配置的供应商及其模型，也可输入 ID 后按回车。')
    expect(i18n.global.t('usage.pricing.catalogError')).toBe('无法加载已配置的供应商和模型，仍可手动输入 ID。')
  })

  it('loads Turkish on demand, retains English fallback and restores ltr from Arabic', async () => {
    localStorage.setItem('hermes_locale', 'en')
    vi.resetModules()
    const { i18nReady, switchLocale } = await import('@/i18n')
    const i18n = await i18nReady

    await switchLocale('ar')
    expect(document.documentElement.dir).toBe('rtl')
    await switchLocale('tr')

    expect(i18n.global.availableLocales).toEqual(['ar', 'en', 'tr'])
    expect(i18n.global.locale.value).toBe('tr')
    expect(document.documentElement.lang).toBe('tr')
    expect(document.documentElement.dir).toBe('ltr')
    expect(localStorage.getItem('hermes_locale')).toBe('tr')
    expect(i18n.global.t('common.cancel')).toBe('İptal')
    expect(i18n.global.t('jev.browserAutomation')).toBe('Yerleşik tarayıcı otomasyonu')
    const { default: en } = await import('@/i18n/locales/en')
    expect(i18n.global.t('usage.pricing.selectionHelp')).toBe(en.usage.pricing.selectionHelp)
  })

  it.each(['saved preference', 'browser language'])('starts in Turkish from the %s', async (source) => {
    localStorage.removeItem('hermes_locale')
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(source === 'browser language' ? ['tr-TR', 'en-US'] : ['en-US'])
    if (source === 'saved preference') localStorage.setItem('hermes_locale', 'tr')
    vi.resetModules()
    const { i18nReady } = await import('@/i18n')
    const i18n = await i18nReady

    expect(i18n.global.availableLocales).toEqual(['en', 'tr'])
    expect(i18n.global.locale.value).toBe('tr')
    expect(document.documentElement.lang).toBe('tr')
    expect(document.documentElement.dir).toBe('ltr')
    expect(i18n.global.t('common.cancel')).toBe('İptal')
  })
})
