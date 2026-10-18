import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { naiveLocaleFor } from '@/constants/naiveLocale'
import type { SupportedLocale } from '@/i18n/messages'

describe('naiveLocaleFor', () => {
  it('localizes Naive UI confirmation actions for every supported app locale', () => {
    const expected: Record<SupportedLocale, [string, string]> = {
      en: ['Confirm', 'Cancel'],
      zh: ['确认', '取消'],
      'zh-TW': ['確定', '取消'],
      ja: ['OK', 'キャンセル'],
      ko: ['확인', '취소'],
      de: ['Bestätigen', 'Abbrechen'],
      fr: ['Confirmer', 'Annuler'],
      es: ['Confirmar', 'Cancelar'],
      pt: ['Confirmar', 'Cancelar'],
      ru: ['Подтвердить', 'Отмена'],
      ar: ['تأكيد', 'إلغاء'],
      tr: ['Kabul Et', 'İptal'],
    }

    for (const [locale, [positiveText, negativeText]] of Object.entries(expected)) {
      const config = naiveLocaleFor(locale)
      expect(config.locale.Popconfirm.positiveText, locale).toBe(positiveText)
      expect(config.locale.Popconfirm.negativeText, locale).toBe(negativeText)
    }
  })

  it('normalizes regional locale variants and falls back to English', () => {
    expect(naiveLocaleFor('zh_HK').locale.Popconfirm.positiveText).toBe('確定')
    expect(naiveLocaleFor('fr-CA').locale.Popconfirm.positiveText).toBe('Confirmer')
    expect(naiveLocaleFor('tr_TR').locale.Popconfirm.positiveText).toBe('Kabul Et')
    expect(naiveLocaleFor('unknown').locale.Popconfirm.positiveText).toBe('Confirm')
  })

  it('uses Turkish calendar names for Turkish and regional variants', () => {
    for (const locale of ['tr', 'tr-TR', 'tr_TR']) {
      const config = naiveLocaleFor(locale)
      expect(config.locale.name).toBe('tr-TR')
      expect(config.dateLocale.name).toBe('tr-TR')
      expect(config.dateLocale.locale.localize.month(9)).toBe('Ekim')
    }
  })

  it('passes both component and date locales to the app config provider', () => {
    const source = readFileSync('packages/client/src/App.vue', 'utf8')
    expect(source).toContain(':locale="naiveLocale.locale"')
    expect(source).toContain(':date-locale="naiveLocale.dateLocale"')
  })
})
