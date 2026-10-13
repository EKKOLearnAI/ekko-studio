// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { applyDocumentDirection, isRtlLocale, localeDirection } from '@/i18n/direction'
import { supportedLocales } from '@/i18n/messages'

afterEach(() => {
  document.documentElement.removeAttribute('dir')
})

describe('isRtlLocale', () => {
  it('detects right-to-left languages', () => {
    for (const locale of ['ar', 'fa', 'he', 'iw', 'ur', 'ps', 'sd', 'ug', 'yi']) {
      expect(isRtlLocale(locale), locale).toBe(true)
    }
  })

  it('treats left-to-right locales as ltr', () => {
    for (const locale of ['en', 'zh', 'zh-TW', 'ja', 'ko', 'fr', 'es', 'de', 'pt', 'ru', 'tr', 'tr-TR']) {
      expect(isRtlLocale(locale), locale).toBe(false)
    }
  })

  it('resolves regional and underscore tags by primary subtag', () => {
    expect(isRtlLocale('ar-SA')).toBe(true)
    expect(isRtlLocale('ar_EG')).toBe(true)
    expect(isRtlLocale('AR-sa')).toBe(true)
    expect(isRtlLocale('en-GB')).toBe(false)
  })

  it('does not treat an unknown or empty tag as rtl', () => {
    expect(isRtlLocale('')).toBe(false)
    expect(isRtlLocale('xx')).toBe(false)
    expect(isRtlLocale('arabic')).toBe(false)
  })
})

describe('localeDirection', () => {
  it('maps locales to a writing direction', () => {
    expect(localeDirection('ar')).toBe('rtl')
    expect(localeDirection('en')).toBe('ltr')
  })

  it('returns a direction for every supported locale', () => {
    for (const locale of supportedLocales) {
      expect(['rtl', 'ltr']).toContain(localeDirection(locale))
    }
  })
})

describe('applyDocumentDirection', () => {
  it('mirrors the document for an rtl locale', () => {
    applyDocumentDirection('ar')
    expect(document.documentElement.dir).toBe('rtl')
  })

  it('restores ltr when switching back', () => {
    applyDocumentDirection('ar')
    applyDocumentDirection('en')
    expect(document.documentElement.dir).toBe('ltr')
  })
})
